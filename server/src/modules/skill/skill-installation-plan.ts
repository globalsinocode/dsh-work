import { hash, scanPythonImports, type SkillBundle, type SkillCompatibility, type SkillPackage, type SkillPackageArtifact } from './skill-package.ts'
import { canonicalJson } from '../runtime/canonical-json.ts'
import type { PythonModuleIndex } from '../runtime/execution-backend.ts'

interface InstallationPlanBase {
  planVersion: '1.0'
  rootName: string
  edges: SkillBundle['edges']
  compatibility: SkillCompatibility
  summary: {
    packageCount: number
    dependencyCount: number
    toolIds: string[]
    pythonFiles: number
  }
  sha256: string
}

export interface PreparedSkillInstallationPlan extends InstallationPlanBase {
  packages: SkillPackage[]
}

export interface SkillInstallationPlan extends InstallationPlanBase {
  packages: SkillPackageArtifact[]
}

export function buildSkillInstallationPlan(
  bundle: SkillBundle,
  options: { pythonSandboxAvailable: boolean; pythonPackages?: string[]; pythonModules?: PythonModuleIndex | null; unavailableTools?: string[]; deferRuntimeRequirements?: boolean },
): PreparedSkillInstallationPlan {
  const unavailableTools = new Set(options.unavailableTools ?? [])
  const pythonPackages = new Set((options.pythonPackages ?? []).map(normalizePythonPackageName))
  const importWarnings: SkillCompatibility['issues'] = []
  const packages = bundle.packages.map(pkg => {
    const resolvedImports = resolvePythonImports(pkg, options, importWarnings)
    const requirements = resolvedImports.map(requirement => {
      if (requirement.type === 'python') {
        return { ...requirement, status: options.pythonSandboxAvailable ? 'resolved' as const : options.deferRuntimeRequirements ? 'needs_review' as const : 'unsupported' as const }
      }
      if (requirement.type === 'external' && requirement.name.startsWith('python-package:')) {
        const packageName = requirement.name.slice('python-package:'.length)
        return { ...requirement, status: options.pythonSandboxAvailable && pythonPackages.has(normalizePythonPackageName(packageName)) ? 'resolved' as const : options.deferRuntimeRequirements ? 'needs_review' as const : 'unsupported' as const }
      }
      if (requirement.type === 'external' && requirement.name === 'pyproject-dependencies') return { ...requirement, status: 'unsupported' as const }
      if (requirement.type === 'tool' && unavailableTools.has(requirement.name)) {
        return { ...requirement, status: 'unsupported' as const }
      }
      return requirement
    })
    return { ...pkg, requirements, compatibility: compatibilityFor(requirements) }
  })
  const issues = [...packages.flatMap(pkg => pkg.compatibility.issues.map(issue => ({ ...issue, message: `${pkg.name}：${issue.message}` }))), ...importWarnings]
  if (hasDependencyCycle(bundle.edges)) issues.push({ code: 'skill_dependency_cycle', severity: 'error', message: 'Skill 依赖图存在循环，无法生成稳定激活顺序' })
  // 执行隔离 1b②、阶段 3（方案 4.8、4.9）：python_execute 只在执行容器内运行，没有 /skill、/input、/output，脚本应改用 DSH_SKILL_DIR 等环境变量。
  for (const pkg of packages) {
    const fixed = pkg.files.filter(file => file.path.endsWith('.py') && FIXED_SANDBOX_PATH.test(file.content)).map(file => file.path)
    if (fixed.length) {
      issues.push({
        code: 'python_fixed_sandbox_paths', severity: 'warning',
        message: `${pkg.name}：脚本写死了 /skill、/input 或 /output（${fixed.slice(0, 3).join('、')}${fixed.length > 3 ? ' 等' : ''}），平台不提供这些路径；请改用环境变量 DSH_SKILL_DIR、DSH_INPUT_DIR、DSH_OUTPUT_DIR 或相对路径`,
      })
    }
  }
  const unsigned = {
    planVersion: '1.0' as const,
    rootName: bundle.root.name,
    packages,
    edges: bundle.edges,
    compatibility: compatibilityForIssues(issues),
    summary: {
      packageCount: packages.length,
      dependencyCount: bundle.edges.length,
      toolIds: [...new Set(packages.flatMap(pkg => pkg.toolIds))].sort(),
      pythonFiles: packages.flatMap(pkg => pkg.files).filter(file => file.path.endsWith('.py')).length,
    },
  }
  return { ...unsigned, sha256: hash(canonicalJson(unsigned)) }
}

/**
 * Turns the imports found in a package's Python files into dependencies checked like requirements.txt
 * (decision 2026-11-04): standard-library imports are dropped; a module an installed distribution provides
 * becomes `python-package:<distribution>` (unless already declared); a required import the image cannot
 * satisfy stays as unsupported `python-import:<module>`; an optional one (indented, e.g. inside `try`) only warns.
 * Without the image's module index (no sandbox yet, or deferred link checks) imports stay for review.
 */
function resolvePythonImports(
  pkg: SkillPackage,
  options: { pythonSandboxAvailable: boolean; pythonModules?: PythonModuleIndex | null; deferRuntimeRequirements?: boolean },
  warnings: SkillCompatibility['issues'],
): SkillPackage['requirements'] {
  const isImport = (name: string) => name.startsWith('python-import:') || name.startsWith('python-optional-import:')
  const index = options.pythonSandboxAvailable ? options.pythonModules : null
  if (!index) {
    const pending = options.pythonSandboxAvailable || options.deferRuntimeRequirements ? 'needs_review' as const : 'unsupported' as const
    return pkg.requirements.map(requirement => requirement.type === 'external' && requirement.name.startsWith('python-import:') ? { ...requirement, status: pending } : requirement)
      .filter(requirement => !(requirement.type === 'external' && requirement.name.startsWith('python-optional-import:')))
  }
  const stdlib = new Set(index.stdlib)
  const declared = new Set(pkg.requirements.filter(item => item.type === 'external' && item.name.startsWith('python-package:'))
    .map(item => normalizePythonPackageName(item.name.slice('python-package:'.length))))
  const result: SkillPackage['requirements'] = []
  for (const requirement of pkg.requirements) {
    if (requirement.type !== 'external' || !isImport(requirement.name)) { result.push(requirement); continue }
    const optional = requirement.name.startsWith('python-optional-import:')
    const module = requirement.name.slice(requirement.name.indexOf(':') + 1)
    if (stdlib.has(module)) continue
    const distributions = index.modules[module] ?? []
    if (distributions.some(name => declared.has(name)) || declaredCovers(declared, module)) continue
    if (distributions.length) {
      declared.add(distributions[0]!)
      result.push({ type: 'external', name: `python-package:${distributions[0]}`, status: 'needs_review', evidence: `由 import 识别：${module}（${requirement.evidence}）` })
    } else if (optional) {
      warnings.push({ code: 'python_optional_import_unavailable', severity: 'warning', message: `${pkg.name}：${requirement.evidence} 在条件分支中 import 的模块 ${module} 不在执行镜像中，相关代码路径运行时会失败` })
    } else {
      // 链接安装延后核对时与声明的包一样待复核，不直接判为不兼容。
      result.push({ ...requirement, status: options.deferRuntimeRequirements ? 'needs_review' : 'unsupported' })
    }
  }
  return result
}

/**
 * Import names whose distribution is named differently; used only to tell that a declared package covers an
 * import when the image does not provide it (otherwise the image's own module index decides). Not exhaustive:
 * an unlisted pair is reported once for the declared package and once for the import.
 */
const IMPORT_DISTRIBUTION_ALIASES: Record<string, string> = {
  docx: 'python-docx', pptx: 'python-pptx', yaml: 'pyyaml', PIL: 'pillow', cv2: 'opencv-python',
  sklearn: 'scikit-learn', skimage: 'scikit-image', bs4: 'beautifulsoup4', dateutil: 'python-dateutil',
  dotenv: 'python-dotenv', jwt: 'pyjwt', fitz: 'pymupdf', Crypto: 'pycryptodome', OpenSSL: 'pyopenssl',
  serial: 'pyserial', magic: 'python-magic', attr: 'attrs', zmq: 'pyzmq', MySQLdb: 'mysqlclient',
  psycopg2: 'psycopg2-binary', Levenshtein: 'python-levenshtein', pdfminer: 'pdfminer-six',
}

/** Whether a declared (normalized) distribution already stands for this import, so it is not reported twice. */
function declaredCovers(declared: ReadonlySet<string>, module: string) {
  const alias = IMPORT_DISTRIBUTION_ALIASES[module]
  return declared.has(normalizePythonPackageName(module)) || (alias !== undefined && declared.has(alias))
}

/**
 * What a stored Skill version needs from Python that the current execution image lacks: declared
 * `python-package:` requirements not installed, plus required (column-0) imports in its files that are
 * neither standard library nor provided by an installed distribution. Re-scanning the files also covers
 * versions installed before imports were checked. Returns readable names; empty when nothing is missing
 * or the image is unknown.
 */
export function missingPythonDependencies(input: {
  requirements: SkillPackage['requirements']
  files: Array<{ path: string; content: string }>
  packages: readonly string[]
  modules: PythonModuleIndex | null
}): string[] {
  const installed = new Set(input.packages.map(normalizePythonPackageName))
  const missing = new Set<string>()
  // Imports a stored requirement already stands for (found from that import, or a package of the same name).
  const covered = new Set<string>()
  for (const requirement of input.requirements) {
    if (requirement.type !== 'external' || !requirement.name.startsWith('python-package:')) continue
    const name = requirement.name.slice('python-package:'.length)
    covered.add(normalizePythonPackageName(name))
    const inferred = requirement.evidence.match(/^由 import 识别：([A-Za-z_][A-Za-z0-9_]*)/)
    if (inferred) covered.add(normalizePythonPackageName(inferred[1]!))
    if (!installed.has(normalizePythonPackageName(name))) missing.add(name)
  }
  if (input.modules) {
    const stdlib = new Set(input.modules.stdlib)
    for (const found of scanPythonImports(input.files)) {
      if (found.optional || stdlib.has(found.module) || covered.has(normalizePythonPackageName(found.module)) || declaredCovers(covered, found.module)) continue
      const distributions = input.modules.modules[found.module] ?? []
      if (!distributions.some(name => installed.has(name))) missing.add(`模块 ${found.module}`)
    }
  }
  return [...missing].sort()
}

/** PEP 503 name normalization, so `Python_Docx` and `python-docx` match. */
export function normalizePythonPackageName(name: string) {
  return name.trim().toLowerCase().replace(/[-_.]+/g, '-')
}

/** A string literal starting with one of the per-call sandbox mounts, e.g. '/input/data.csv' or "/output". */
const FIXED_SANDBOX_PATH = /["'](?:\/skill|\/input|\/output)(?:\/|["'])/

export function externalizeSkillInstallationPlan(
  prepared: PreparedSkillInstallationPlan,
  artifacts: SkillPackageArtifact[],
): SkillInstallationPlan {
  const byName = new Map(artifacts.map(artifact => [artifact.name, artifact]))
  const packages = prepared.packages.map(pkg => {
    const artifact = byName.get(pkg.name)
    if (!artifact || artifact.sha256 !== pkg.sha256) throw new Error(`Skill 文件夹写入结果不完整：${pkg.name}`)
    return artifact
  })
  const unsigned = {
    planVersion: prepared.planVersion,
    rootName: prepared.rootName,
    packages,
    edges: prepared.edges,
    compatibility: prepared.compatibility,
    summary: prepared.summary,
  }
  return { ...unsigned, sha256: hash(canonicalJson(unsigned)) }
}

export function installationPlanDigest(plan: SkillInstallationPlan): string {
  return hash(canonicalJson({
    planVersion: plan.planVersion,
    rootName: plan.rootName,
    packages: plan.packages,
    edges: plan.edges,
    compatibility: plan.compatibility,
    summary: plan.summary,
  }))
}

function hasDependencyCycle(edges: SkillBundle['edges']): boolean {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to])
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (name: string): boolean => {
    if (visiting.has(name)) return true
    if (visited.has(name)) return false
    visiting.add(name)
    for (const dependency of adjacency.get(name) ?? []) if (visit(dependency)) return true
    visiting.delete(name); visited.add(name)
    return false
  }
  return [...adjacency.keys()].some(visit)
}

function compatibilityFor(requirements: SkillPackage['requirements']): SkillCompatibility {
  const issues = requirements.filter(item => item.status !== 'resolved').map(item => ({
    code: `${item.type}_${item.status}`,
    severity: (item.status === 'missing' || item.status === 'unsupported' ? 'error' : 'warning') as 'warning' | 'error',
    message: item.status === 'missing' ? `缺少依赖 Skill：${item.name}`
      : item.status === 'unsupported' && item.name.startsWith('python-import:')
        ? `执行镜像中没有 Python 模块 ${item.name.slice('python-import:'.length)}（${item.evidence} 中 import）；请在 requirements.txt 声明对应的包，并由管理员把它加入执行镜像`
        : item.status === 'unsupported' ? `平台暂不支持依赖：${item.name}` : `需要管理员复核运行能力：${item.name}`,
  }))
  return compatibilityForIssues(issues)
}

function compatibilityForIssues(issues: SkillCompatibility['issues']): SkillCompatibility {
  return {
    status: issues.some(issue => issue.severity === 'error') ? 'incompatible' : issues.length ? 'needs_review' : 'compatible',
    issues,
  }
}

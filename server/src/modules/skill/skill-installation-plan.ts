import { hash, type SkillBundle, type SkillCompatibility, type SkillPackage } from './skill-package.ts'
import { canonicalJson } from '../runtime/canonical-json.ts'

export interface SkillInstallationPlan {
  planVersion: '1.0'
  rootName: string
  packages: SkillPackage[]
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

export function buildSkillInstallationPlan(
  bundle: SkillBundle,
  options: { pythonSandboxAvailable: boolean; pythonPackages?: string[]; unavailableTools?: string[] },
): SkillInstallationPlan {
  const unavailableTools = new Set(options.unavailableTools ?? [])
  const pythonPackages = new Set((options.pythonPackages ?? []).map(value => value.toLowerCase()))
  const packages = bundle.packages.map(pkg => {
    const requirements = pkg.requirements.map(requirement => {
      if (requirement.type === 'python') {
        return { ...requirement, status: options.pythonSandboxAvailable ? 'resolved' as const : 'unsupported' as const }
      }
      if (requirement.type === 'external' && requirement.name.startsWith('python-package:')) {
        const packageName = requirement.name.slice('python-package:'.length)
        return { ...requirement, status: options.pythonSandboxAvailable && pythonPackages.has(packageName) ? 'resolved' as const : 'unsupported' as const }
      }
      if (requirement.type === 'external' && requirement.name === 'pyproject-dependencies') return { ...requirement, status: 'unsupported' as const }
      if (requirement.type === 'tool' && unavailableTools.has(requirement.name)) {
        return { ...requirement, status: 'unsupported' as const }
      }
      return requirement
    })
    return { ...pkg, requirements, compatibility: compatibilityFor(requirements) }
  })
  const issues = packages.flatMap(pkg => pkg.compatibility.issues.map(issue => ({ ...issue, message: `${pkg.name}：${issue.message}` })))
  if (hasDependencyCycle(bundle.edges)) issues.push({ code: 'skill_dependency_cycle', severity: 'error', message: 'Skill 依赖图存在循环，无法生成稳定激活顺序' })
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
    message: item.status === 'missing' ? `缺少依赖 Skill：${item.name}` : item.status === 'unsupported' ? `平台暂不支持依赖：${item.name}` : `需要管理员复核运行能力：${item.name}`,
  }))
  return compatibilityForIssues(issues)
}

function compatibilityForIssues(issues: SkillCompatibility['issues']): SkillCompatibility {
  return {
    status: issues.some(issue => issue.severity === 'error') ? 'incompatible' : issues.length ? 'needs_review' : 'compatible',
    issues,
  }
}

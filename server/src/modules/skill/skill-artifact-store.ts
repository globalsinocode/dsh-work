import { MAX_SKILL_BYTES } from '../../domain/skill-package-limits.ts'
import { SKILL_ARTIFACT_REF_PATTERN } from '../../domain/skill-artifact-ref.ts'
import { ObjectNotFoundError, type ObjectStorage } from '../../domain/object-storage.ts'
import {
  hash,
  parseSkillMarkdown,
  skillPackageContentHash,
  toSkillPackageArtifact,
  type SkillPackage,
  type SkillPackageArtifact,
} from './skill-package.ts'
import { invalidRequest } from '../../domain/request-errors.ts'

const REF_PATTERN = SKILL_ARTIFACT_REF_PATTERN

/**
 * Immutable, content-addressed Skill folders. Each file is one object under
 * `<artifactRef>/<path>`; PostgreSQL stores only the reference and the verified file index.
 * Objects are written once and never replaced, so an interrupted put leaves at most some
 * complete files that the next put of the same package fills in, and every read is checked
 * against the index (size and SHA-256) before use.
 */
export class SkillArtifactStore {
  private readonly storage: ObjectStorage

  constructor(storage: ObjectStorage) {
    this.storage = storage
  }

  async put(pkg: SkillPackage): Promise<SkillPackageArtifact> {
    if (pkg.files.reduce((sum, file) => sum + file.size, 0) > MAX_SKILL_BYTES) {
      throw invalidRequest('单个 Skill 资源合计超过 1 MB')
    }
    const artifactRef = this.referenceFor(pkg)
    // 写入侧自检：新生成的引用必须满足收紧后的规范形式，生成规则回归时在此暴露。
    if (!REF_PATTERN.test(artifactRef)) throw invalidRequest(`Skill 文件夹引用生成无效：${artifactRef}`)
    const artifact = toSkillPackageArtifact(pkg, artifactRef)
    try {
      const existing = await this.read(artifact)
      if (existing.sha256 !== pkg.sha256) throw new Error('Skill 文件夹摘要不匹配')
      return artifact
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) throw error
    }
    for (const file of pkg.files) await this.storage.putIfAbsent(this.keyFor(artifactRef, file.path), Buffer.from(file.content, 'utf8'))
    await this.read(artifact)
    return artifact
  }

  async read(artifact: SkillPackageArtifact): Promise<SkillPackage> {
    const hydrated = await this.readRuntimeArtifact(artifact.artifactRef, artifact.files, artifact.instructionsSha256)
    if (skillPackageContentHash(hydrated.files) !== artifact.sha256) throw new Error('Skill 文件夹内容摘要不匹配')
    const metadata = parseSkillMarkdown(hydrated.files.find(file => file.path === 'SKILL.md')!.content)
    if (metadata.name !== artifact.name || metadata.description !== artifact.description) throw new Error('Skill 文件夹元数据与版本索引不一致')
    return {
      name: artifact.name,
      description: artifact.description,
      instructions: hydrated.instructions,
      version: artifact.version,
      toolIds: [...artifact.toolIds],
      files: hydrated.files,
      sha256: artifact.sha256,
      archiveSha256: artifact.archiveSha256,
      requirements: structuredClone(artifact.requirements),
      compatibility: structuredClone(artifact.compatibility),
      disableModelInvocation: artifact.disableModelInvocation,
    }
  }

  async readRuntimeArtifact(artifactRef: string, index: SkillPackageArtifact['files'], instructionsSha256: string) {
    if (index.reduce((sum, file) => sum + file.size, 0) > MAX_SKILL_BYTES) throw invalidRequest('单个 Skill 资源合计超过 1 MB')
    const files: SkillPackage['files'] = []
    for (const indexed of index) {
      const bytes = await this.storage.get(this.keyFor(artifactRef, indexed.path))
      if (bytes.length !== indexed.size || hash(bytes) !== indexed.sha256) throw new Error(`Skill 文件已损坏或被修改：${indexed.path}`)
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      files.push({ ...indexed, content })
    }
    const skillMarkdown = files.find(file => file.path === 'SKILL.md')
    if (!skillMarkdown) throw invalidRequest('Skill 文件夹缺少 SKILL.md')
    const metadata = parseSkillMarkdown(skillMarkdown.content)
    if (hash(metadata.instructions) !== instructionsSha256) throw new Error('Skill 执行说明摘要不匹配')
    return { instructions: metadata.instructions, files }
  }

  private referenceFor(pkg: SkillPackage) {
    // 先截断再清理首尾符号：若先清理后截断，第 64 位恰好是 . _ - 时会留下被拒收的结尾。
    const readable = pkg.name
      .replaceAll(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 64)
      .replace(/^[._-]+|[._-]+$/g, '') || 'skill'
    return `packages/${readable}/${pkg.sha256.toLowerCase()}`
  }

  private keyFor(reference: string, path: string) {
    if (!REF_PATTERN.test(reference)) throw invalidRequest('Skill 文件夹引用无效')
    if (!path || path.startsWith('/') || path.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
      throw new Error(`Skill 文件索引越界：${path}`)
    }
    return `${reference}/${path}`
  }
}

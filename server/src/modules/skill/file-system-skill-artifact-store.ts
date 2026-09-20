import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { MAX_SKILL_BYTES } from '../../domain/skill-package-limits.ts'
import {
  hash,
  parseSkillMarkdown,
  skillPackageContentHash,
  toSkillPackageArtifact,
  type SkillPackage,
  type SkillPackageArtifact,
} from './skill-package.ts'

// 新生成引用的规范形式：包名段首尾必须为字母数字，排除 . / .. 遍历段与退化名。
const REF_PATTERN = /^packages\/(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._-]{0,62}[A-Za-z0-9])\/[a-f0-9]{64}$/
// 读取兼容：旧版生成器只替换非法字符并截断，未清理首尾符号，中文名等落成
// packages/____/<sha>；这些已持久化引用必须保持可读，否则既有 Skill 升级后无法加载。
// 段字符集不含 /（生成时已替换为 _），. 与 .. 段仍拒绝；越界防护由 resolve 边界检查承担。
const LEGACY_REF_PATTERN = /^packages\/(?!\.{1,2}\/)[A-Za-z0-9._-]{1,64}\/[a-f0-9]{64}$/

/**
 * Durable, immutable Skill folders for the single-node macOS deployment.
 * PostgreSQL stores only this relative reference and the verified file index.
 */
export class FileSystemSkillArtifactStore {
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  async put(pkg: SkillPackage): Promise<SkillPackageArtifact> {
    if (pkg.files.reduce((sum, file) => sum + file.size, 0) > MAX_SKILL_BYTES) {
      throw new Error('单个 Skill 资源合计超过 1 MB')
    }
    const artifactRef = this.referenceFor(pkg)
    // 写入侧自检：新生成的引用必须满足收紧后的规范形式，生成规则回归时在此暴露。
    if (!REF_PATTERN.test(artifactRef)) throw new Error(`Skill 文件夹引用生成无效：${artifactRef}`)
    const targetRoot = this.resolveReference(artifactRef)
    try {
      const existing = await this.read(toSkillPackageArtifact(pkg, artifactRef))
      if (existing.sha256 !== pkg.sha256) throw new Error('Skill 文件夹摘要不匹配')
      return toSkillPackageArtifact(pkg, artifactRef)
    } catch (error) {
      if (!isMissing(error)) throw error
    }

    const stagingRoot = `${targetRoot}.tmp-${randomUUID()}`
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
    let renamed = false
    try {
      for (const file of pkg.files) {
        const target = resolve(stagingRoot, file.path)
        if (!target.startsWith(`${stagingRoot}/`)) throw new Error(`Skill 文件路径越界：${file.path}`)
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await writeFile(target, file.content, { flag: 'wx', mode: 0o400 })
      }
      await mkdir(dirname(targetRoot), { recursive: true, mode: 0o700 })
      try {
        await rename(stagingRoot, targetRoot)
        renamed = true
      } catch (error) {
        if (!isDestinationExists(error)) throw error
        await rm(stagingRoot, { recursive: true, force: true })
      }
      return await this.verify(pkg, artifactRef)
    } catch (error) {
      await rm(renamed ? targetRoot : stagingRoot, { recursive: true, force: true })
      throw error
    }
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
    const root = this.resolveReference(artifactRef)
    const files: SkillPackage['files'] = []
    let loadedBytes = 0
    for (const indexed of index) {
      const target = resolve(root, indexed.path)
      if (!target.startsWith(`${root}/`)) throw new Error(`Skill 文件索引越界：${indexed.path}`)
      // O_NOFOLLOW 拒绝符号链接；fstat 基于句柄不跟随链接。
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size !== indexed.size) throw new Error(`Skill 文件已损坏或被修改：${indexed.path}`)
        loadedBytes += info.size
        if (loadedBytes > MAX_SKILL_BYTES) throw new Error('单个 Skill 资源合计超过 1 MB')
        const bytes = await handle.readFile()
        if (hash(bytes) !== indexed.sha256) throw new Error(`Skill 文件已损坏或被修改：${indexed.path}`)
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        files.push({ ...indexed, content })
      } finally {
        await handle.close()
      }
    }
    const skillMarkdown = files.find(file => file.path === 'SKILL.md')
    if (!skillMarkdown) throw new Error('Skill 文件夹缺少 SKILL.md')
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
    return `packages/${readable}/${pkg.sha256}`
  }

  private resolveReference(reference: string) {
    if (!LEGACY_REF_PATTERN.test(reference)) throw new Error('Skill 文件夹引用无效')
    const target = resolve(this.root, reference)
    if (!target.startsWith(`${this.root}/`)) throw new Error('Skill 文件夹引用越界')
    return target
  }

  private async verify(pkg: SkillPackage, artifactRef: string) {
    const artifact = toSkillPackageArtifact(pkg, artifactRef)
    await this.read(artifact)
    return artifact
  }
}

function isMissing(error: unknown) {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isDestinationExists(error: unknown) {
  return error instanceof Error && 'code' in error && ['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')
}

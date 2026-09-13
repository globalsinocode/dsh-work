import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import {
  hash,
  parseSkillMarkdown,
  skillPackageContentHash,
  toSkillPackageArtifact,
  type SkillPackage,
  type SkillPackageArtifact,
} from './skill-package.ts'

const REF_PATTERN = /^packages\/[A-Za-z0-9._-]+\/[a-f0-9]{64}$/

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
    const artifactRef = this.referenceFor(pkg)
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
      } catch (error) {
        if (!isDestinationExists(error)) throw error
        await rm(stagingRoot, { recursive: true, force: true })
      }
      return await this.verify(pkg, artifactRef)
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true })
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
    const files = [] as SkillPackage['files']
    for (const indexed of index) {
      const target = resolve(root, indexed.path)
      if (!target.startsWith(`${root}/`)) throw new Error(`Skill 文件索引越界：${indexed.path}`)
      const bytes = await readFile(target)
      if (bytes.length !== indexed.size || hash(bytes) !== indexed.sha256) {
        throw new Error(`Skill 文件已损坏或被修改：${indexed.path}`)
      }
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      files.push({ ...indexed, content })
    }
    const skillMarkdown = files.find(file => file.path === 'SKILL.md')
    if (!skillMarkdown) throw new Error('Skill 文件夹缺少 SKILL.md')
    const metadata = parseSkillMarkdown(skillMarkdown.content)
    if (hash(metadata.instructions) !== instructionsSha256) throw new Error('Skill 执行说明摘要不匹配')
    return { instructions: metadata.instructions, files }
  }

  private referenceFor(pkg: SkillPackage) {
    const readable = pkg.name.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'skill'
    return `packages/${readable}/${pkg.sha256}`
  }

  private resolveReference(reference: string) {
    if (!REF_PATTERN.test(reference)) throw new Error('Skill 文件夹引用无效')
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

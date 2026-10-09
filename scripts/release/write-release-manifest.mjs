import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const [bundleRoot, version, commit, rawSourceRef] = process.argv.slice(2)
if (!bundleRoot || !version || !/^[0-9a-f]{40}$/.test(commit ?? '')) {
  throw new Error('usage: write-release-manifest.mjs BUNDLE_ROOT VERSION COMMIT [SOURCE_REF]')
}
// 构件自述来源 ref：安装端 release.sh 用它做 provenance 的 --source-ref 校验。
// 副分支发布线要求这里如实写入 ${GITHUB_REF}；缺失时安装端按 refs/heads/main 兜底。
const sourceRef = typeof rawSourceRef === 'string' && rawSourceRef.length > 0 ? rawSourceRef : undefined
if (sourceRef !== undefined && !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(sourceRef)) {
  throw new Error(`invalid source ref: ${sourceRef}`)
}

const files = []
await visit(bundleRoot)
files.sort((left, right) => left.path.localeCompare(right.path))

await writeFile(join(bundleRoot, 'release.json'), `${JSON.stringify({
  schemaVersion: 1,
  name: 'dsh-work',
  version,
  commit,
  ...(sourceRef === undefined ? {} : { sourceRef }),
  platform: 'darwin-arm64',
  nodeRuntime: 'host-managed',
  dshRuntime: 'host-managed-locked-checkout',
  createdAt: new Date().toISOString(),
  files,
}, null, 2)}\n`)

async function visit(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await visit(path)
      continue
    }
    if (!entry.isFile()) continue
    const data = await readFile(path)
    files.push({
      path: relative(bundleRoot, path),
      bytes: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
    })
  }
}

#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strToU8, zipSync } from 'fflate'

const serverRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = join(serverRoot, '..')
const fixturesRoot = join(repoRoot, 'docs/development/fixtures/skill-plaza-candidates/packages')
const outDir = join(repoRoot, 'dist/skill-plaza-packages')

async function listPackageDirs() {
  const entries = await readdir(fixturesRoot, { withFileTypes: true })
  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name)
    .sort()
}

async function collectFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = {}
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      Object.assign(files, await collectFiles(full, base))
    } else {
      const rel = relative(base, full).replace(/\\/g, '/')
      files[rel] = new Uint8Array(await readFile(full))
    }
  }
  return files
}

function withChecksums(files) {
  const checksums = { files: {} }
  for (const [path, content] of Object.entries(files)) {
    checksums.files[path] = createHash('sha256').update(content).digest('hex')
  }
  return { ...files, 'checksums.json': strToU8(JSON.stringify(checksums, null, 2)) }
}

const ids = await listPackageDirs()
if (!ids.length) {
  console.error('未找到 skill-plaza packages 目录，请先运行 fetch-skill-plaza-candidates.mjs')
  process.exit(1)
}
await mkdir(outDir, { recursive: true })
for (const id of ids) {
  const zip = zipSync(withChecksums(await collectFiles(join(fixturesRoot, id))))
  const outPath = join(outDir, `${id}.zip`)
  await writeFile(outPath, zip)
  console.log(`wrote ${outPath} (${zip.byteLength} bytes)`)
}

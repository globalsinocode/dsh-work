#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { postProcessAllPackages } from './skill-plaza-postprocess.mjs'
import { isAllowedRelativePath } from './skill-plaza-manifest.mjs'

const execFileAsync = promisify(execFile)

const serverRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = join(serverRoot, '..')
const sourcePath = join(repoRoot, 'docs/development/fixtures/skill-plaza-candidates/SOURCE.json')
const packagesRoot = join(repoRoot, 'docs/development/fixtures/skill-plaza-candidates/packages')
const treeCacheDir = join(repoRoot, 'docs/development/fixtures/skill-plaza-candidates/.cache/trees')
const repoCacheDir = join(repoRoot, 'docs/development/fixtures/skill-plaza-candidates/.cache/repos')

const NESTED_SKILL = /^.+\/SKILL\.md$/i

const fetchMode = (process.env.SKILL_PLAZA_FETCH ?? 'git').toLowerCase()

function shouldIncludeBlob(relative, skillId) {
  if (!isAllowedRelativePath(relative)) return false
  if (relative !== 'SKILL.md' && NESTED_SKILL.test(relative)) return false
  if (skillId === 'plaza-wb-fbs-bookwriter') return relative === 'SKILL.md'
  if (skillId?.startsWith('plaza-anth-') && relative.includes('scripts/office/schemas/')) return false
  return true
}

function githubHeaders() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_API_TOKEN
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-work-skill-plaza',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function sleep(ms) {
  await new Promise(r => setTimeout(r, ms))
}

async function fetchJson(url, attempt = 0) {
  const res = await fetch(url, { headers: githubHeaders() })
  if (res.status === 403 || res.status === 429) {
    const text = await res.text()
    if (attempt < 3 && /rate limit/i.test(text)) {
      const wait = Math.min(60_000, 2_000 * 2 ** attempt)
      console.warn(`rate limited, retry in ${wait}ms…`)
      await sleep(wait)
      return fetchJson(url, attempt + 1)
    }
    throw new Error(`${url}: ${res.status} ${text}`)
  }
  if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`)
  return res.json()
}

function repoDirFor(owner, name) {
  return join(repoCacheDir, `${owner}__${name}`)
}

async function clearStaleGitLock(repoDir) {
  const lock = join(repoDir, '.git', 'index.lock')
  try {
    await rm(lock, { force: true })
  } catch {
    /* none */
  }
}

async function ensureGitCheckout(owner, name, commit) {
  const dir = repoDirFor(owner, name)
  await mkdir(repoCacheDir, { recursive: true })
  let hasGit = false
  try {
    await access(join(dir, '.git'))
    hasGit = true
  } catch {
    /* fresh */
  }
  if (!hasGit) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    console.log(`clone ${owner}/${name}…`)
    await execFileAsync(
      'git',
      ['clone', '--filter=blob:none', '--no-checkout', `https://github.com/${owner}/${name}.git`, dir],
      { maxBuffer: 32 * 1024 * 1024 },
    )
  }
  await clearStaleGitLock(dir)
  try {
    const { stdout: head } = await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    })
    if (head.trim() === commit) {
      return dir
    }
  } catch {
    /* not checked out yet */
  }
  try {
    await execFileAsync('git', ['-C', dir, 'cat-file', '-e', `${commit}^{commit}`], {
      maxBuffer: 1024 * 1024,
    })
    await execFileAsync('git', ['-C', dir, 'checkout', '--detach', commit], {
      maxBuffer: 32 * 1024 * 1024,
    })
    return dir
  } catch {
    /* need fetch */
  }
  console.log(`checkout ${owner}/${name}@${commit.slice(0, 7)}…`)
  await execFileAsync('git', ['-C', dir, 'fetch', '--depth', '1', 'origin', commit], {
    maxBuffer: 32 * 1024 * 1024,
  })
  await execFileAsync('git', ['-C', dir, 'checkout', '--detach', 'FETCH_HEAD'], {
    maxBuffer: 32 * 1024 * 1024,
  })
  return dir
}

/** @param {typeof import('./skill-plaza-manifest.mjs').REPOS} repos */
async function resolveRepoDir(owner, name, commit) {
  const dir = repoDirFor(owner, name)
  try {
    await access(join(dir, '.git'))
  } catch {
    return null
  }
  return ensureGitCheckout(owner, name, commit)
}

async function loadRepoTreeViaGit(repoKey, repos) {
  const { owner, name, commit } = repos[repoKey]
  await mkdir(treeCacheDir, { recursive: true })
  const cacheFile = join(treeCacheDir, `${repoKey}-${commit}.json`)
  try {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8'))
    if (cached.commit === commit && Array.isArray(cached.blobs)) {
      const repoDir = await resolveRepoDir(owner, name, commit)
      return { owner, name, commit, blobs: cached.blobs, repoDir }
    }
  } catch {
    /* miss */
  }
  const repoDir = await ensureGitCheckout(owner, name, commit)
  const { stdout } = await execFileAsync('git', ['-C', repoDir, 'ls-tree', '-r', '--name-only', 'HEAD'], {
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  })
  const blobs = stdout.trim().split(/\r?\n/).filter(Boolean)
  await writeFile(cacheFile, `${JSON.stringify({ commit, blobs }, null, 2)}\n`, 'utf8')
  return { owner, name, commit, blobs, repoDir }
}

/** @param {typeof import('./skill-plaza-manifest.mjs').REPOS} repos */
async function loadRepoTreeViaApi(repoKey, repos) {
  const { owner, name, commit } = repos[repoKey]
  await mkdir(treeCacheDir, { recursive: true })
  const cacheFile = join(treeCacheDir, `${repoKey}-${commit}.json`)
  try {
    const cached = JSON.parse(await readFile(cacheFile, 'utf8'))
    if (cached.commit === commit && Array.isArray(cached.blobs)) {
      return { owner, name, commit, blobs: cached.blobs, repoDir: null }
    }
  } catch {
    /* miss */
  }
  const url = `https://api.github.com/repos/${owner}/${name}/git/trees/${commit}?recursive=1`
  const body = await fetchJson(url)
  const blobs = []
  for (const item of body.tree ?? []) {
    if (item.type === 'blob' && item.path) blobs.push(item.path)
  }
  await writeFile(cacheFile, `${JSON.stringify({ commit, blobs }, null, 2)}\n`, 'utf8')
  return { owner, name, commit, blobs, repoDir: null }
}

async function loadRepoTree(repoKey, repos) {
  if (fetchMode === 'api') {
    try {
      return await loadRepoTreeViaApi(repoKey, repos)
    } catch (err) {
      console.warn(`API tree failed for ${repoKey}, falling back to git: ${err.message}`)
    }
  }
  try {
    return await loadRepoTreeViaGit(repoKey, repos)
  } catch (err) {
    console.warn(`git tree failed for ${repoKey}, trying API: ${err.message}`)
    return loadRepoTreeViaApi(repoKey, repos)
  }
}

async function fetchWithRetry(url, options, attempt = 0) {
  try {
    return await fetch(url, options)
  } catch (err) {
    const code = err?.cause?.code ?? err?.code
    if (attempt < 5 && (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED')) {
      const wait = 1500 * (attempt + 1)
      console.warn(`fetch retry ${attempt + 1} for ${url} (${code}) in ${wait}ms…`)
      await sleep(wait)
      return fetchWithRetry(url, options, attempt + 1)
    }
    throw err
  }
}

async function readBlobFromRaw(entry, fullPath) {
  const url = `https://raw.githubusercontent.com/${entry.owner}/${entry.name}/${entry.commit}/${fullPath}`
  const res = await fetchWithRetry(url, { headers: { 'User-Agent': 'dsh-work-skill-plaza' } })
  if (!res.ok) throw new Error(`raw ${fullPath}: ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

async function readBlobFromDisk(entry, fullPath) {
  if (!entry.repoDir) return null
  const disk = join(entry.repoDir, ...fullPath.split('/'))
  try {
    await access(disk)
    return new Uint8Array(await readFile(disk))
  } catch {
    return null
  }
}

async function readBlob(entry, fullPath) {
  const fromDisk = await readBlobFromDisk(entry, fullPath)
  if (fromDisk) return fromDisk
  if (entry.repoDir) {
    try {
      const { stdout } = await execFileAsync('git', ['-C', entry.repoDir, 'show', `HEAD:${fullPath}`], {
        encoding: 'buffer',
        maxBuffer: 100 * 1024 * 1024,
      })
      return new Uint8Array(stdout)
    } catch (err) {
      console.warn(`git show failed for ${fullPath}, trying raw: ${err.message?.split('\n')[0] ?? err}`)
      return readBlobFromRaw(entry, fullPath)
    }
  }
  return readBlobFromRaw(entry, fullPath)
}

async function draftAlreadyImported(skill, commit) {
  if (process.env.SKILL_PLAZA_FORCE === '1') return false
  try {
    const meta = JSON.parse(
      await readFile(join(packagesRoot, skill.id, '.plaza-source.json'), 'utf8'),
    )
    return meta.commit === commit && Array.isArray(meta.files) && meta.files.includes('SKILL.md')
  } catch {
    return false
  }
}

const source = JSON.parse(await readFile(sourcePath, 'utf8'))
const treeCache = new Map()

for (const skill of source.skills) {
  if (!treeCache.has(skill.repo)) {
    console.log(`tree ${skill.repo} (${fetchMode})…`)
    treeCache.set(skill.repo, await loadRepoTree(skill.repo, source.repos))
  }
}

const importLog = []

for (const skill of source.skills) {
  const entry = treeCache.get(skill.repo)
  const { commit, blobs } = entry
  const prefix = `${skill.sourcePath}/`
  const relPaths = blobs
    .filter(p => p.startsWith(prefix))
    .map(p => p.slice(prefix.length))
    .filter(p => shouldIncludeBlob(p, skill.id))
    .sort()

  if (!relPaths.includes('SKILL.md')) {
    importLog.push({ id: skill.id, status: 'failed', error: 'missing SKILL.md' })
    console.error(`skip ${skill.id}: no SKILL.md`)
    continue
  }

  if (await draftAlreadyImported(skill, commit)) {
    importLog.push({ id: skill.id, status: 'draft', fileCount: relPaths.length, skipped: true })
    console.log(`draft ${skill.id} (cached, ${relPaths.length} files)`)
    continue
  }

  const outDir = join(packagesRoot, skill.id)
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  const meta = {
    id: skill.id,
    repo: skill.repo,
    sourcePath: skill.sourcePath,
    commit,
    notes: skill.notes ?? null,
    files: relPaths,
  }
  await writeFile(join(outDir, '.plaza-source.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

  for (const rel of relPaths) {
    const full = `${skill.sourcePath}/${rel}`
    const bytes = await readBlob(entry, full)
    const dest = join(outDir, ...rel.split('/'))
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, bytes)
  }
  importLog.push({ id: skill.id, status: 'draft', fileCount: relPaths.length })
  console.log(`draft ${skill.id} (${relPaths.length} files)`)
}

console.log('postprocess all draft packages…')
await postProcessAllPackages(source.skills.map(s => s.id))

await writeFile(
  join(repoRoot, 'docs/development/fixtures/skill-plaza-candidates/IMPORT-DRAFTS.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), batch: source.batch, entries: importLog }, null, 2)}\n`,
  'utf8',
)

const failed = importLog.filter(e => e.status === 'failed')
if (failed.length) {
  console.error(`${failed.length} failed`)
  process.exit(1)
}

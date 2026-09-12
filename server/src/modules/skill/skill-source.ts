import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'

export interface SkillSource { url: string; selected?: string; directory?: string; repository?: string; ref?: string }
const invalid = (message: string): never => { throw Object.assign(new Error(`安装来源无效：${message}`), { status: 422, code: 'skill_source_invalid' }) }

export function parseSkillSource(input: string): SkillSource | null {
  if (typeof input !== 'string' || input.length > 20000) return invalid('输入过长')
  const text = input.trim()
  if (/^(npx|curl)\b/.test(text)) {
    if (/[|;&`\n\r<>]|\$/.test(text)) return invalid('不支持管道、组合命令、变量或 Shell 重定向，请提供直接链接')
    const tokens = text.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map(value => value.replace(/^(['"])(.*)\1$/, '$2')) ?? []
    if (tokens[0] === 'curl') {
      const rest = tokens.slice(1).filter(value => ['-L', '--location', '-f', '--fail', '-s', '--silent', '-S', '--show-error', '-fsSL', '-sSL', '-fsS'].includes(value) === false)
      if (rest.length !== 1 || !rest[0]!.startsWith('https://')) return invalid('curl 仅支持 HTTPS 下载及 -L/-f/-s/-S 参数，不支持凭据、请求头或输出路径')
      return parseUrl(rest[0]!)
    }
    // `\@` is a harmless shell escape sometimes preserved when commands are
    // pasted into the browser. We parse it deterministically and never invoke
    // npm or a shell.
    const installer = (tokens[1] ?? '').replace('\\@', '@')
    if (!/^skills(?:@(?:latest|\d+\.\d+\.\d+))?$/.test(installer) || tokens[2] !== 'add') return invalid('npx 当前仅支持 skills、skills@latest 或 skills@x.y.z add owner/repo [--skill 名称]')
    const source = tokens[3]!
    if (!source) return invalid('请提供 GitHub 仓库')
    const parsed = parseUrl(source.startsWith('https://') ? source : `https://github.com/${source}`)
    if (!parsed.repository) return invalid('npx skills add 当前仅支持 GitHub 仓库')
    const optionTokens = tokens.slice(4)
    let selected: string | undefined
    if (optionTokens.length === 2 && optionTokens[0] === '--skill') selected = optionTokens[1]
    else if (optionTokens.length === 1 && optionTokens[0]!.startsWith('--skill=')) selected = optionTokens[0]!.slice('--skill='.length)
    else if (optionTokens.length !== 0) return invalid('请仅提供一个仓库和可选的 --skill 名称或 --skill=名称')
    if (selected !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(selected)) return invalid('Skill 名称格式无效')
    return { ...parsed, ...(selected ? { selected } : {}) }
  }
  const urls = text.match(/https?:\/\/[^\s<>"'，。]+/g) ?? []
  if (!urls.length) {
    if (!/(?:安装|添加|引入)/.test(text) || /(?:不要|取消|停止).{0,8}(?:安装|添加|引入)/.test(text)) return null
    const repositories = [...text.matchAll(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/g)].map(match => match[1]!)
    if (repositories.length !== 1) return null
    const selection = text.match(/(?:里的|中的|--skill(?:=|\s+))\s*([A-Za-z0-9][A-Za-z0-9._-]{0,79})/i)?.[1]
    return { url: `https://github.com/${repositories[0]}`, repository: repositories[0], ref: 'HEAD', ...(selection ? { selected: selection } : {}) }
  }
  if (urls.length !== 1) return invalid('一次只安装一个来源，请只提供一个链接')
  return parseUrl(urls[0]!)
}

// Continuations are explicit selections; ordinary chat never reuses an install source.
export function continueSkillSource(input: string, previous: SkillSource | null): SkillSource | null {
  if (!previous) return null
  const match = input.trim().match(/^(?:--skill\s+|(?:请)?(?:选择|选|安装)\s*(?:(?:上一个|上述|刚才的|这个)(?:仓库|来源|包)(?:中)?(?:的)?\s*)?(?:Skill\s+)?)([A-Za-z0-9][A-Za-z0-9._-]{0,79})[。！!]?$/i)
  return match ? { ...previous, selected: match[1] } : null
}

function parseUrl(value: string): SkillSource {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search) return invalid('仅支持无凭据、无查询参数的 HTTPS 公共来源')
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes('/') || part.includes('\\'))) return invalid('链接路径无效')
  if (url.hostname === 'github.com') {
    const [owner, repo, kind, ref, ...directory] = parts
    if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return invalid('GitHub 仓库格式无效')
    if (kind && kind !== 'tree' && kind !== 'blob') return { url: url.href }
    if (kind === 'blob') {
      if (directory.at(-1) !== 'SKILL.md') return invalid('请提供 Skill 目录或 SKILL.md 链接')
      directory.pop()
    }
    if (kind && !ref) return invalid('缺少 GitHub 分支或提交')
    return { url: url.href, repository: `${owner}/${repo.replace(/\.git$/, '')}`, ref: ref ?? 'HEAD', ...(directory.length ? { directory: directory.join('/') } : {}) }
  }
  return { url: url.href }
}

const defaultHosts = ['github.com', 'api.github.com', 'codeload.github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']
export function configuredSourceHosts() {
  return new Set([...defaultHosts, ...(process.env.DSH_WORK_SKILL_SOURCE_HOSTS ?? '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean)])
}

export async function acquireSkillSource(source: SkillSource, signal: AbortSignal, download = downloadPublicHttps) {
  let url = source.url, resolvedRef: string | null = null
  if (source.repository) {
    const bytes = await download(`https://api.github.com/repos/${source.repository}/commits/${encodeURIComponent(source.ref ?? 'HEAD')}`, signal)
    const result = JSON.parse(Buffer.from(bytes).toString('utf8')) as { sha?: unknown }
    if (typeof result.sha !== 'string' || !/^[a-f0-9]{40}$/.test(result.sha)) return invalid('无法解析固定 GitHub 提交')
    resolvedRef = result.sha
    url = `https://codeload.github.com/${source.repository}/zip/${result.sha}`
  }
  return { bytes: await download(url, signal), resolvedUrl: url, resolvedRef }
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 6) return false // Fail closed for IPv6 until an equivalent range policy is deployed.
  if (isIP(address) !== 4) return false
  const [a, b] = address.split('.').map(Number) as [number, number]
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0))
}

export async function downloadPublicHttps(value: string, signal: AbortSignal, redirects = 0): Promise<Uint8Array> {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !configuredSourceHosts().has(url.hostname)) return invalid('来源域名未获准，请联系管理员配置下载域名白名单')
  if (redirects > 4) return invalid('重定向次数超限')
  const addresses = await lookup(url.hostname, { all: true, family: 4 })
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) return invalid('不允许访问内网、回环或保留地址')
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const req = request(url, {
      signal,
      headers: { 'User-Agent': 'dsh-work-skill-installer', Accept: 'application/octet-stream, application/vnd.github+json' },
      lookup: (_hostname, options, callback) => {
        const first = addresses[0]!
        if (options.all) callback(null, [first])
        else callback(null, first.address, 4)
      },
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        response.resume()
        void downloadPublicHttps(new URL(response.headers.location, url).href, signal, redirects + 1).then(resolve, reject)
        return
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Skill 下载失败：HTTP ${response.statusCode}，请检查公共来源是否可用`)); return }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 20 * 1024 * 1024) { req.destroy(new Error('Skill 下载超过 20 MB 限制')); return }
        chunks.push(chunk)
      })
      response.on('end', () => resolve(Buffer.concat(chunks)))
      response.on('error', reject)
    })
    req.setTimeout(30000, () => req.destroy(new Error('Skill 下载超时，请重试')))
    req.on('error', reject)
    req.end()
  })
}

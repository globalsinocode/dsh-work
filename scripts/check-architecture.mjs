import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

const projectRoot = new URL('../', import.meta.url)
const violations = []

async function sourceFiles(directory) {
  const entries = await readdir(new URL(directory, projectRoot), { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFiles(`${path}/`)))
    if (entry.isFile() && ['.ts', '.vue', '.js', '.mjs'].includes(extname(entry.name))) files.push(path)
  }

  return files
}

function reject(path, content, pattern, message) {
  if (pattern.test(content)) violations.push(`${relative('.', path)}：${message}`)
}

/**
 * 依赖检查只看代码：.vue 文件的 <template>/<style> 可以是文档性文字（例如
 * 接入指南里列出 /api/workbench/v1 端点），只有 <script> 中的 import、fetch
 * 等才构成真实的跨端依赖。
 */
function codeOnly(path, content) {
  if (extname(path) !== '.vue') return content
  const scripts = content.match(/<script[^>]*>[\s\S]*?<\/script>/gi)
  return scripts ? scripts.join('\n') : ''
}

/**
 * 模板里的属性值同样是真实依赖：<img src="/api/admin/…">、:href 绑定、
 * form action 都会发出跨端请求。只匹配「属性值上下文」中的 /api/ 路径
 * （xxx="…/api/…"），模板纯文本中的文档性端点列表不受影响。
 */
function templateAttributeApiRefs(path, content, apiPrefix) {
  if (extname(path) !== '.vue') return false
  const templates = content.match(/<template[^>]*>[\s\S]*?<\/template>/gi) ?? []
  return templates.some(template => {
    // Vue 属性名可含 `:` / `.` / `-`；绑定值既可能是普通字符串，也可能是
    // `:href="`/api/admin/${id}`"` 这类含反引号模板字符串的表达式。
    for (const match of template.matchAll(/[\w:.-]+=(?:"[^"]*"|'[^']*')/g)) {
      if (match[0].includes(apiPrefix)) return true
    }
    return false
  })
}

for (const path of await sourceFiles('apps/workbench-web/src/')) {
  const content = codeOnly(path, await readFile(new URL(path, projectRoot), 'utf8'))
  reject(path, content, /@dsh-work\/admin-components|apps\/admin-web|\/api\/admin\//, '员工端不得依赖管理端源码、组件或 API')
  reject(path, content, /server\/src|from ['"][^'"]*server\//, '前端不得直接依赖服务端实现')
  if (templateAttributeApiRefs(path, await readFile(new URL(path, projectRoot), 'utf8'), '/api/admin/')) {
    violations.push(`${relative('.', path)}：员工端模板属性不得引用管理端 API`)
  }
}

for (const path of await sourceFiles('apps/admin-web/src/')) {
  const content = codeOnly(path, await readFile(new URL(path, projectRoot), 'utf8'))
  // 测试文件只断言渲染/拼接出的文本（如 API 文档、请求示例），不是运行时依赖；
  // /api/ 字面量规则豁免测试，import/包名依赖规则仍然适用。
  if (!path.endsWith('.test.ts')) {
    reject(path, content, /@dsh-work\/workbench-components|apps\/workbench-web|\/api\/workbench\//, '管理端不得依赖员工端源码、组件或 API')
  } else {
    reject(path, content, /@dsh-work\/workbench-components|apps\/workbench-web/, '管理端不得依赖员工端源码、组件或 API')
  }
  reject(path, content, /server\/src|from ['"][^'"]*server\//, '前端不得直接依赖服务端实现')
  if (templateAttributeApiRefs(path, await readFile(new URL(path, projectRoot), 'utf8'), '/api/workbench/')) {
    violations.push(`${relative('.', path)}：管理端模板属性不得引用员工端 API`)
  }
}

for (const path of await sourceFiles('packages/')) {
  const content = codeOnly(path, await readFile(new URL(path, projectRoot), 'utf8'))
  reject(path, content, /from ['"]pinia['"]|defineStore\s*\(/, '共享包不得持有 Pinia 业务状态')
  reject(path, content, /from ['"]vue-router['"]|useRoute\s*\(|useRouter\s*\(/, '共享包不得直接依赖应用 Router')
  reject(path, content, /apps\/(workbench-web|admin-web)\//, '共享包不得反向依赖应用源码')
}

if (violations.length > 0) {
  console.error(`架构边界检查失败：\n${violations.map((item) => `- ${item}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log('架构边界检查通过：双前端、双 API 与无状态共享包边界有效。')
}

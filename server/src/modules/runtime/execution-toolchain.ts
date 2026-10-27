import { dependencyUnavailable } from '../../domain/request-errors.ts'

/**
 * Programs the execution image provides (execution isolation plan 4.6, 2b-1). The startup check
 * runs every probe once inside the image; required tools missing means the execution container is
 * unavailable, optional ones are simply left out of the Runtime instructions. Descriptions are
 * platform text: only the version number found by the probe comes from the image.
 */
interface ToolDefinition {
  id: string
  required: boolean
  /** argv run inside the image; its first output line carries the version. */
  probe: readonly string[]
  /** How the Runtime instructions name the tool; Python packages are listed with python3 instead. */
  label?: string
  usage?: string
}

const PYTHON_PACKAGE_VERSION = 'import importlib.metadata as m, sys; print(m.version(sys.argv[1]))'
const pythonPackage = (name: string): ToolDefinition => ({
  id: name, required: false, probe: ['python3', '-I', '-c', PYTHON_PACKAGE_VERSION, name],
})

const TOOLS = [
  { id: 'bash', required: true, probe: ['bash', '--version'] },
  { id: 'rg', required: true, probe: ['rg', '--version'], label: 'rg（ripgrep）', usage: '按内容搜索文件' },
  {
    id: 'soffice', required: true, probe: ['soffice', '--version'], label: 'LibreOffice（soffice）',
    usage: 'Office 文件转换，例如 soffice --headless --convert-to pdf --outdir output 报告.docx；也可在 docx/xlsx/pptx 之间转换',
  },
  { id: 'pdftoppm', required: true, probe: ['pdftoppm', '-v'], label: 'pdftoppm', usage: 'PDF 页面转为 PNG 图片' },
  { id: 'pdftotext', required: false, probe: ['pdftotext', '-v'], label: 'pdftotext', usage: '提取 PDF 文本' },
  { id: 'pandoc', required: false, probe: ['pandoc', '--version'], label: 'pandoc', usage: 'Markdown、HTML 与 docx 互转' },
  { id: 'python3', required: false, probe: ['python3', '--version'], label: 'python3', usage: '运行脚本处理数据和生成文件' },
  pythonPackage('pandas'),
  pythonPackage('openpyxl'),
  pythonPackage('python-docx'),
  pythonPackage('python-pptx'),
  // Fonts, not a program: only claimed in the instructions when the Simplified Chinese faces exist.
  { id: 'noto-cjk-sc', required: false, probe: ['bash', '-c', 'fc-list :lang=zh-cn family | grep -m 1 "Noto Sans CJK SC"'] },
] as const satisfies readonly ToolDefinition[]

export type ExecutionToolId = typeof TOOLS[number]['id']
export interface ExecutionTool {
  id: ExecutionToolId
  /** Dotted version number from the probe output, or null when it printed none. */
  version: string | null
}

const PYTHON_PACKAGES: readonly ExecutionToolId[] = ['pandas', 'openpyxl', 'python-docx', 'python-pptx']

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * bash script for the startup check: prints `<id>\t<first output line>` for every tool whose probe
 * exits 0. Run with bash as the entrypoint, so an image without bash fails as a whole.
 */
export const TOOLCHAIN_PROBE_SCRIPT = [
  `probe() { local id=$1 out; shift; if out=$("$@" 2>&1); then printf '%s\\t%s\\n' "$id" "\${out%%$'\\n'*}"; fi; }`,
  ...TOOLS.map(tool => `probe ${tool.id} ${tool.probe.map(shellQuote).join(' ')}`),
].join('\n')

/** Parses the probe output and fails unless every required tool answered. */
export function parseToolchainProbe(stdout: string): ExecutionTool[] {
  const found = new Map<string, string | null>()
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab <= 0) continue
    found.set(line.slice(0, tab), line.slice(tab + 1).match(/\d+(?:\.\d+)+/)?.[0] ?? null)
  }
  const missing = TOOLS.filter(tool => tool.required && !found.has(tool.id)).map(tool => tool.id)
  if (missing.length) throw dependencyUnavailable(`执行镜像缺少 ${missing.join('、')}，执行容器不可用`)
  return TOOLS.filter(tool => found.has(tool.id)).map(tool => ({ id: tool.id, version: found.get(tool.id) ?? null }))
}

/** Runtime instruction lines listing the programs the startup check found in the image. */
export function describeExecutionToolchain(tools: readonly ExecutionTool[]): string[] {
  const present = new Map(tools.map(tool => [tool.id, tool.version]))
  const named = (label: string, version: string | null | undefined) => version ? `${label} ${version}` : label
  const lines: string[] = []
  for (const tool of TOOLS as readonly ToolDefinition[]) {
    if (!tool.label || !present.has(tool.id as ExecutionToolId)) continue
    let line = `- ${named(tool.label, present.get(tool.id as ExecutionToolId))}：${tool.usage}`
    if (tool.id === 'python3') {
      const packages = PYTHON_PACKAGES.filter(id => present.has(id)).map(id => named(id, present.get(id)))
      if (packages.length) line += `；已安装 ${packages.join('、')}`
    }
    lines.push(line)
  }
  if (present.has('noto-cjk-sc')) lines.push('镜像内置中文字体（Noto CJK，默认简体字形），转换或生成含中文的文档不需要另装字体。')
  return lines
}

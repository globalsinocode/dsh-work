import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dependencyUnavailable } from '../../../domain/request-errors.ts'
import type { PythonSandboxRequest, SandboxRunResult } from '../../runtime/container-executor.ts'
import { normalizeExtractedText } from './document-extractor.ts'

/**
 * Execution isolation 2b-3: text of binary artifacts (PDF, DOCX, XLSX, PPTX) comes from a disposable
 * container, never from a parser in the service process. Files produced in an execution container
 * may be crafted to attack a parser; the container runs the platform's extraction script from the
 * execution image under the Python sandbox posture, and only validated text comes back.
 */
export const CONTAINER_EXTRACTOR_VERSION = 'exec-office-v1'

export type BinaryTextType = 'pdf' | 'docx' | 'xlsx' | 'pptx'
export const BINARY_TEXT_TYPES: readonly BinaryTextType[] = ['pdf', 'docx', 'xlsx', 'pptx']

export type ArtifactTextExtraction =
  | { ok: true; detectedType: BinaryTextType; text: string; pageCount: number | null; sheetCount: number | null; rowCount: number | null }
  | { ok: false; detectedType: BinaryTextType; code: string; message: string }

export interface ArtifactTextExtractorPort {
  /**
   * One result per file, in order. File-level problems are `ok: false`; throws when the container
   * itself could not run (no capacity, timeout, runtime failure), so callers can retry later.
   */
  extract(files: Array<{ name: string; type: BinaryTextType; bytes: Buffer }>): Promise<ArtifactTextExtraction[]>
}

const MAX_CHARACTERS = 512_000
const MAX_TEXT_BYTES = MAX_CHARACTERS * 4
const MAX_META_BYTES = 4096
const ENTRY = 'extract_artifact_text.py'

/** Reasons the script may report; anything else is treated as a generic parse failure. */
const FAILURE_MESSAGES: Record<string, string> = {
  FILE_TYPE_UNSUPPORTED: '不支持解析该格式',
  NO_EXTRACTABLE_TEXT: '文件中没有可提取的文本内容',
  TEXT_TOO_LARGE: '文件解析后的文本超过 512000 字符',
  XLSX_SHEET_LIMIT_EXCEEDED: 'XLSX 超过 30 个工作表限制',
  XLSX_CELL_LIMIT_EXCEEDED: 'XLSX 超过 20000 个单元格限制',
  XLSX_ROW_LIMIT_EXCEEDED: 'XLSX 行数超过解析限制',
  PPTX_SLIDE_LIMIT_EXCEEDED: 'PPTX 超过 300 页限制',
  PDF_PAGE_LIMIT_EXCEEDED: 'PDF 超过 200 页限制',
  PDF_UNREADABLE: 'PDF 无法读取',
  PARSE_TIMEOUT: '解析超时',
  PARSE_FAILED: '文件解析失败',
  OUTPUT_LIMIT_EXCEEDED: '解析输出超出限制',
}

const EXTENSIONS: Record<BinaryTextType, string> = { pdf: '.pdf', docx: '.docx', xlsx: '.xlsx', pptx: '.pptx' }

export class ContainerArtifactTextExtractor implements ArtifactTextExtractorPort {
  private readonly executor: { runPythonSandbox(request: PythonSandboxRequest, signal: AbortSignal): Promise<SandboxRunResult> }
  private readonly user: string
  private readonly scriptRoot: string
  private readonly workRoot: string
  private readonly timeoutMs: number

  constructor(
    executor: ContainerArtifactTextExtractor['executor'],
    /** `scriptRoot` holds only the extraction script; `workRoot` is where per-call input/output directories live. */
    options: { user: string; scriptRoot: string; workRoot: string; timeoutMs?: number },
  ) {
    this.executor = executor
    this.user = options.user
    this.scriptRoot = options.scriptRoot
    this.workRoot = options.workRoot
    this.timeoutMs = options.timeoutMs ?? 60_000
  }

  async extract(files: Array<{ name: string; type: BinaryTextType; bytes: Buffer }>): Promise<ArtifactTextExtraction[]> {
    if (!files.length) return []
    await mkdir(this.workRoot, { recursive: true, mode: 0o700 })
    const root = await mkdtemp(join(this.workRoot, 'extract-'))
    try {
      const inputRoot = join(root, 'input')
      const outputRoot = join(root, 'output')
      await mkdir(inputRoot, { mode: 0o700 })
      await mkdir(outputRoot, { mode: 0o700 })
      // Names in the container are only the index and the expected extension; the original name never reaches it.
      const names = files.map((file, index) => `${index}${EXTENSIONS[file.type]}`)
      await Promise.all(files.map((file, index) => writeFile(join(inputRoot, names[index]!), file.bytes, { mode: 0o400 })))
      // The output directory is the only host path the container can write: two plain files per input at most.
      const limits = { files: files.length * 2, bytes: files.length * (MAX_TEXT_BYTES + MAX_META_BYTES) }
      const result = await this.executor.runPythonSandbox({
        user: this.user, skillRoot: this.scriptRoot, inputRoot, outputRoot, entry: ENTRY, args: names,
        shouldStop: () => outputOverLimit(outputRoot, limits),
      }, AbortSignal.timeout(this.timeoutMs))
      // Stopped for writing more than it may: no file of this batch is trusted, and none is retried.
      if (result.stoppedEarly) return files.map(file => failure(file.type, 'OUTPUT_LIMIT_EXCEEDED'))
      if (result.exitCode !== 0) throw dependencyUnavailable(`成果解析容器异常退出（${result.exitCode}）`)
      return await Promise.all(files.map((file, index) => readResult(outputRoot, index, file.type)))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}

function failure(type: BinaryTextType, code: string): ArtifactTextExtraction {
  return {
    ok: false, detectedType: type, code: FAILURE_MESSAGES[code] ? code : 'PARSE_FAILED',
    message: FAILURE_MESSAGES[code] ?? FAILURE_MESSAGES['PARSE_FAILED']!,
  }
}

/** Polled while the container runs: more files or bytes than expected, or anything but plain files, stops it. */
async function outputOverLimit(outputRoot: string, limits: { files: number; bytes: number }): Promise<boolean> {
  const names = await readdir(outputRoot).catch(() => [])
  if (names.length > limits.files) return true
  let bytes = 0
  for (const name of names) {
    const details = await lstat(join(outputRoot, name)).catch(() => null)
    if (!details) continue
    if (!details.isFile()) return true
    bytes += details.size
  }
  return bytes > limits.bytes
}

async function readResult(outputRoot: string, index: number, type: BinaryTextType): Promise<ArtifactTextExtraction> {
  const failed = (code: string) => failure(type, code)
  const meta = await readBounded(join(outputRoot, `${index}.json`), MAX_META_BYTES)
  if (!Buffer.isBuffer(meta)) return failed('PARSE_FAILED')
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(meta.toString('utf8')) as Record<string, unknown>
  } catch {
    return failed('PARSE_FAILED')
  }
  if (parsed['ok'] !== true) return failed(typeof parsed['code'] === 'string' ? parsed['code'] : 'PARSE_FAILED')
  // The script names the type it parsed; it must be the one the platform asked for.
  if (parsed['detected_type'] !== type) return failed('PARSE_FAILED')
  const bytes = await readBounded(join(outputRoot, `${index}.txt`), MAX_TEXT_BYTES)
  if (!Buffer.isBuffer(bytes)) return failed(bytes === 'too_large' ? 'TEXT_TOO_LARGE' : 'PARSE_FAILED')
  let text: string
  try {
    text = normalizeExtractedText(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return failed('PARSE_FAILED')
  }
  if (!text) return failed('NO_EXTRACTABLE_TEXT')
  if (text.length > MAX_CHARACTERS) return failed('TEXT_TOO_LARGE')
  return {
    ok: true, detectedType: type, text,
    pageCount: count(parsed['page_count']), sheetCount: count(parsed['sheet_count']), rowCount: count(parsed['row_count']),
  }
}

/**
 * Reads a file the container wrote; `invalid` when it is missing or not a plain file.
 * lstat: the output directory is shared with the container, so a symbolic link there would resolve
 * on the host. The container has already been removed, so nothing can swap the file afterwards.
 */
async function readBounded(path: string, maxBytes: number): Promise<Buffer | 'invalid' | 'too_large'> {
  const details = await lstat(path).catch(() => null)
  if (!details?.isFile() || details.nlink !== 1) return 'invalid'
  if (details.size > maxBytes) return 'too_large'
  return readFile(path)
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

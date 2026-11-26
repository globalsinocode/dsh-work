import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { formatStackFrames, parseStackFrames, type StackFrame } from './error-sanitize.ts'
import type { StackResolver } from './postgres-error-records-service.ts'

/**
 * 前端堆栈按源码映射还原（错误记录方案 OB7、6.4）。映射文件不随前端发布，构建时移到
 * Release 的 `sourcemaps/<版本>/` 下；只在管理员查看错误详情时按需读取，结果缓存。
 * 只实现 Source Map v3 的 `mappings` 解码（无需第三方依赖）。
 */

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_INDEX = new Map([...BASE64].map((char, index) => [char, index]))

/** 一行内按生成列排序的段：[生成列, 源文件序号, 源行, 源列, 名称序号?]。 */
type Segment = [number, number, number, number, number | undefined]

interface DecodedMap { sources: string[]; names: string[]; lines: Segment[][] }

function decodeVlq(text: string, start: number): [number[], number] {
  const values: number[] = []
  let value = 0
  let shift = 0
  let index = start
  while (index < text.length) {
    const char = text[index]!
    if (char === ',' || char === ';') break
    const digit = BASE64_INDEX.get(char)
    if (digit === undefined) throw new Error('invalid source map')
    value += (digit & 31) << shift
    if (digit & 32) {
      shift += 5
    } else {
      values.push(value & 1 ? -(value >>> 1) : value >>> 1)
      value = 0
      shift = 0
    }
    index += 1
  }
  return [values, index]
}

export function decodeSourceMap(raw: string): DecodedMap {
  const map = JSON.parse(raw) as { version?: number; sources?: string[]; names?: string[]; mappings?: string; sourceRoot?: string }
  if (map.version !== 3 || typeof map.mappings !== 'string') throw new Error('unsupported source map')
  const lines: Segment[][] = []
  let source = 0, sourceLine = 0, sourceColumn = 0, name = 0
  for (const lineText of map.mappings.split(';')) {
    const segments: Segment[] = []
    let column = 0
    let index = 0
    while (index < lineText.length) {
      if (lineText[index] === ',') { index += 1; continue }
      const [values, next] = decodeVlq(lineText, index)
      index = next
      column += values[0] ?? 0
      if (values.length >= 4) {
        source += values[1]!
        sourceLine += values[2]!
        sourceColumn += values[3]!
        let nameIndex: number | undefined
        if (values.length >= 5) { name += values[4]!; nameIndex = name }
        segments.push([column, source, sourceLine, sourceColumn, nameIndex])
      }
    }
    lines.push(segments)
  }
  return { sources: map.sources ?? [], names: map.names ?? [], lines }
}

/** 1 起始的行、列（浏览器堆栈）→ 源位置；找不到时返回 null。 */
export function originalPosition(map: DecodedMap, line: number, column: number) {
  const segments = map.lines[line - 1]
  if (!segments?.length) return null
  const target = column - 1
  let found: Segment | undefined
  for (const segment of segments) {
    if (segment[0] > target) break
    found = segment
  }
  if (!found) return null
  const source = map.sources[found[1]]
  if (!source) return null
  return {
    source: source.replace(/^(?:webpack|vite):\/\/\/?/, '').replace(/^(?:\.\.\/)+/, ''),
    line: found[2] + 1,
    column: found[3] + 1,
    name: found[4] === undefined ? undefined : map.names[found[4]],
  }
}

const RELEASE_DIR = /^(?!.*\.\.)[A-Za-z0-9_.+-]{1,64}$/
const MAP_FILE = /^(?!.*\.\.)[\w.@-]{1,120}\.js$/

export function createSourceMapStackResolver(directory = defaultDirectory()): StackResolver {
  const cache = new Map<string, Promise<DecodedMap | null>>()
  const load = (release: string, file: string) => {
    const key = `${release}/${file}`
    let pending = cache.get(key)
    if (!pending) {
      // 只读取映射目录内的文件：版本号或文件名即使绕过格式检查也不能走出目录（PR #171 评审）。
      const root = path.resolve(directory)
      const target = path.resolve(root, release, `${file}.map`)
      if (!target.startsWith(`${root}${path.sep}`)) return Promise.resolve(null)
      pending = readFile(target, 'utf8')
        .then(decodeSourceMap)
        .catch(() => null)
      if (cache.size > 200) cache.clear()
      cache.set(key, pending)
    }
    return pending
  }
  return async (stack, release) => {
    const frames = parseStackFrames(stack)
    if (!release || !RELEASE_DIR.test(release) || frames.length === 0) return { stack, resolved: false }
    let resolvedAny = false
    const resolved: StackFrame[] = []
    for (const frame of frames) {
      const map = MAP_FILE.test(frame.file) ? await load(release, frame.file) : null
      const position = map ? originalPosition(map, frame.line, frame.column) : null
      if (!position) { resolved.push(frame); continue }
      resolvedAny = true
      resolved.push({ fn: position.name ?? frame.fn, file: position.source, line: position.line, column: position.column })
    }
    return { stack: resolvedAny ? formatStackFrames(resolved) : stack, resolved: resolvedAny }
  }
}

function defaultDirectory() {
  // Release 目录结构：<release>/server/{src,dist}/… 与 <release>/sourcemaps/<版本>/。
  return process.env.DSH_WORK_SOURCE_MAP_DIR
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../sourcemaps')
}

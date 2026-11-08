import type { ModelGatewayTextRestorer } from './model-gateway-types.ts'

type CreateRestorer = (encode?: (value: string) => string) => ModelGatewayTextRestorer
type Rewrite = (text: string) => string

type OnContext = (text: string) => void

/**
 * 这些字段不参与遮盖：协议结构、名称、图片地址，以及思考内容（双向原样透传，方案 5.4）。
 * 用排除而不是列举正文字段：协议新增的文本字段默认被遮盖，不会漏发原值。
 * 只在消息结构层生效，工具参数内部的同名键按普通取值处理。
 */
const SKIPPED_KEYS = new Set([
  'role', 'type', 'id', 'name', 'tool_call_id', 'tool_use_id', 'cache_control',
  'reasoning_content', 'thinking', 'signature', 'image_url',
])
/** 二进制内容块：data、source 是编码数据，不是文本。 */
const BINARY_BLOCK_TYPES = new Set(['image', 'base64', 'redacted_thinking'])
const BINARY_KEYS = new Set(['data', 'source'])
/** 顶层的协议设置，不是发给模型的文本。 */
const ROOT_SKIPPED_KEYS = new Set(['model', 'stream', 'stream_options', 'tool_choice', 'response_format', 'thinking', 'reasoning_effort'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 工具参数的键和值都由工具或模型决定（可能就叫 name、id），全部处理。 */
function walkAll(node: unknown, rewrite: Rewrite): unknown {
  if (typeof node === 'string') return rewrite(node)
  if (Array.isArray(node)) return node.map(item => walkAll(item, rewrite))
  if (isRecord(node)) return Object.fromEntries(Object.entries(node).map(([key, value]) => [rewrite(key), walkAll(value, rewrite)]))
  return node
}

/** 工具调用参数是 JSON 文本：在解码后的取值上处理，转义形式不会漏报；没有变化时保持原文。 */
function walkArguments(text: string, rewrite: Rewrite, onContext?: OnContext): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return rewrite(text)
  }
  if (parsed === null || typeof parsed !== 'object') return rewrite(text)
  const original = JSON.stringify(parsed)
  onContext?.(original)
  const updated = JSON.stringify(walkAll(parsed, rewrite))
  return updated === original ? text : updated
}

function walkMessage(node: unknown, rewrite: Rewrite, onContext?: OnContext): unknown {
  if (typeof node === 'string') return rewrite(node)
  if (Array.isArray(node)) return node.map(item => walkMessage(item, rewrite, onContext))
  if (!isRecord(node)) return node
  const binary = typeof node['type'] === 'string' && BINARY_BLOCK_TYPES.has(node['type'])
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'arguments' && typeof value === 'string') output[key] = walkArguments(value, rewrite, onContext)
    else if (key === 'arguments' || key === 'input') {
      // 键名是字段规则的上下文（{"password": "…"}），整段参与识别。
      if (typeof value === 'object' && value !== null) onContext?.(JSON.stringify(value))
      output[key] = walkAll(value, rewrite)
    } else if (SKIPPED_KEYS.has(key) || (binary && BINARY_KEYS.has(key))) output[key] = value
    else output[key] = walkMessage(value, rewrite, onContext)
  }
  return output
}

/** JSON Schema 只处理说明文字：type、enum、properties 的键是协议内容，改了工具就用不了。 */
function walkSchema(node: unknown, rewrite: Rewrite): unknown {
  if (Array.isArray(node)) return node.map(item => walkSchema(item, rewrite))
  if (!isRecord(node)) return node
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [
    key,
    (key === 'description' || key === 'title') && typeof value === 'string' ? rewrite(value) : walkSchema(value, rewrite),
  ]))
}

function walkTool(tool: unknown, rewrite: Rewrite): unknown {
  if (!isRecord(tool)) return tool
  const output = { ...tool }
  if (typeof output['description'] === 'string') output['description'] = rewrite(output['description'])
  if ('input_schema' in output) output['input_schema'] = walkSchema(output['input_schema'], rewrite)
  if (isRecord(output['function'])) {
    const fn = { ...output['function'] }
    if (typeof fn['description'] === 'string') fn['description'] = rewrite(fn['description'])
    if ('parameters' in fn) fn['parameters'] = walkSchema(fn['parameters'], rewrite)
    output['function'] = fn
  }
  return output
}

function walkRequest(body: Record<string, unknown>, rewrite: Rewrite, onContext?: OnContext): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (ROOT_SKIPPED_KEYS.has(key)) output[key] = value
    else if (key === 'tools' && Array.isArray(value)) output[key] = value.map(tool => walkTool(tool, rewrite))
    else output[key] = walkMessage(value, rewrite, onContext)
  }
  return output
}

/** 收集请求中要遮盖的全部文本；contexts 只参与识别，不写回。 */
export function collectRequestTexts(body: Record<string, unknown>): { texts: string[]; contexts: string[] } {
  const texts: string[] = []
  const contexts: string[] = []
  walkRequest(body, text => {
    texts.push(text)
    return text
  }, context => contexts.push(context))
  return { texts, contexts }
}

export function applyRequestTexts(body: Record<string, unknown>, texts: readonly string[]): Record<string, unknown> {
  let index = 0
  return walkRequest(body, () => texts[index++]!)
}

export function requestHasImage(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(requestHasImage)
  if (!isRecord(node)) return false
  if ('image_url' in node || node['type'] === 'image') return true
  return Object.entries(node).some(([key, value]) => key !== 'data' && key !== 'source' && requestHasImage(value))
}

const jsonEscape = (value: string) => JSON.stringify(value).slice(1, -1)

function restoreText(text: string, restorer: ModelGatewayTextRestorer): string {
  return restorer.push(text) + restorer.flush()
}

/** 还原非流式回复；思考内容不动。 */
export function restoreJsonResponse(body: Record<string, unknown>, createRestorer: CreateRestorer): Record<string, unknown> {
  if (Array.isArray(body['choices'])) {
    for (const choice of body['choices']) {
      const message = isRecord(choice) ? choice['message'] : undefined
      if (!isRecord(message)) continue
      if (typeof message['content'] === 'string') message['content'] = restoreText(message['content'], createRestorer())
      if (!Array.isArray(message['tool_calls'])) continue
      for (const call of message['tool_calls']) {
        const fn = isRecord(call) ? call['function'] : undefined
        if (isRecord(fn) && typeof fn['arguments'] === 'string') fn['arguments'] = restoreText(fn['arguments'], createRestorer(jsonEscape))
      }
    }
  }
  if (Array.isArray(body['content'])) {
    for (const block of body['content']) {
      if (!isRecord(block)) continue
      if (block['type'] === 'text' && typeof block['text'] === 'string') block['text'] = restoreText(block['text'], createRestorer())
      else if (isRecord(block['input'])) block['input'] = walkAll(block['input'], text => restoreText(text, createRestorer()))
    }
  }
  return body
}

interface Slot {
  restorer: ModelGatewayTextRestorer
  /** 把扣住的尾部组成一个补发事件。 */
  emit: (tail: string) => string
}

/**
 * 按 SSE 事件还原回复（OpenAI 兼容与 Anthropic 兼容）。每个文本字段一个还原器，占位符跨事件时
 * 尾部留到下一事件；该字段结束前补发扣住的尾部。思考内容字段不处理，未改动的事件原样放行。
 */
export class SseResponseRestorer {
  private readonly createRestorer: CreateRestorer
  private readonly slots = new Map<string, Slot>()
  private pending = ''

  constructor(createRestorer: CreateRestorer) {
    this.createRestorer = createRestorer
  }

  push(text: string): string {
    this.pending += text
    let output = ''
    for (let match = /\r?\n\r?\n/.exec(this.pending); match; match = /\r?\n\r?\n/.exec(this.pending)) {
      const end = match.index + match[0].length
      output += this.processEvent(this.pending.slice(0, match.index), this.pending.slice(match.index, end))
      this.pending = this.pending.slice(end)
    }
    return output
  }

  finish(): string {
    const rest = this.pending
    this.pending = ''
    return (rest.trim() ? this.processEvent(rest, '\n\n') : rest) + this.flushSlots(() => true)
  }

  private slot(key: string, encode: ((value: string) => string) | undefined, emit: Slot['emit']): Slot {
    let slot = this.slots.get(key)
    if (!slot) {
      slot = { restorer: this.createRestorer(encode), emit }
      this.slots.set(key, slot)
    }
    return slot
  }

  private takeTail(key: string): string {
    const tail = this.slots.get(key)?.restorer.flush() ?? ''
    this.slots.delete(key)
    return tail
  }

  private flushSlots(matches: (key: string) => boolean): string {
    let output = ''
    for (const [key, slot] of [...this.slots]) {
      if (!matches(key)) continue
      const tail = slot.restorer.flush()
      if (tail) output += slot.emit(tail)
      this.slots.delete(key)
    }
    return output
  }

  private processEvent(block: string, separator: string): string {
    const raw = block + separator
    const lines = block.split(/\r?\n/)
    const dataLines = lines.filter(line => line.startsWith('data:'))
    if (dataLines.length === 0) return raw
    const payload = dataLines.map(line => line.slice(5).trim()).join('\n')
    if (payload === '[DONE]') return this.flushSlots(() => true) + raw
    let event: unknown
    try {
      event = JSON.parse(payload)
    } catch {
      return raw
    }
    if (!isRecord(event)) return raw
    const before = Array.isArray(event['choices']) ? this.restoreChatEvent(event) : this.restoreAnthropicEvent(event)
    const updated = JSON.stringify(event)
    if (updated === JSON.stringify(JSON.parse(payload))) return before + raw
    const others = lines.filter(line => !line.startsWith('data:'))
    return `${before}${[...others, `data: ${updated}`].join('\n')}\n\n`
  }

  private restoreChatEvent(event: Record<string, unknown>): string {
    const { choices: _choices, usage: _usage, ...meta } = event
    let before = ''
    for (const choice of event['choices'] as unknown[]) {
      if (!isRecord(choice)) continue
      const index = choice['index'] ?? 0
      const synthetic = (delta: unknown) => `data: ${JSON.stringify({ ...meta, choices: [{ index, delta, finish_reason: null }] })}\n\n`
      const delta = choice['delta']
      // 结束帧自带的字段把尾部并入本帧，顺序不会颠倒；其余字段在本帧之前补发。
      const finishing = Boolean(choice['finish_reason'])
      if (isRecord(delta)) {
        if (typeof delta['content'] === 'string') {
          const key = `${index}:content`
          const slot = this.slot(key, undefined, tail => synthetic({ content: tail }))
          delta['content'] = slot.restorer.push(delta['content']) + (finishing ? this.takeTail(key) : '')
        }
        for (const call of Array.isArray(delta['tool_calls']) ? delta['tool_calls'] : []) {
          const fn = isRecord(call) ? call['function'] : undefined
          if (!isRecord(call) || !isRecord(fn) || typeof fn['arguments'] !== 'string') continue
          const callIndex = call['index'] ?? 0
          const key = `${index}:tool:${callIndex}`
          const slot = this.slot(key, jsonEscape, tail => synthetic({ tool_calls: [{ index: callIndex, function: { arguments: tail } }] }))
          fn['arguments'] = slot.restorer.push(fn['arguments']) + (finishing ? this.takeTail(key) : '')
        }
      }
      if (finishing) before += this.flushSlots(key => key.startsWith(`${index}:`))
    }
    return before
  }

  private restoreAnthropicEvent(event: Record<string, unknown>): string {
    const index = event['index']
    if (event['type'] === 'content_block_stop') return this.flushSlots(key => key === `block:${index}`)
    const delta = event['delta']
    if (event['type'] !== 'content_block_delta' || !isRecord(delta)) return ''
    const field = delta['type'] === 'text_delta' ? 'text' : delta['type'] === 'input_json_delta' ? 'partial_json' : undefined
    if (!field || typeof delta[field] !== 'string') return ''
    const type = delta['type']
    const slot = this.slot(`block:${index}`, field === 'text' ? undefined : jsonEscape, tail =>
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index, delta: { type, [field]: tail } })}\n\n`)
    delta[field] = slot.restorer.push(delta[field])
    return ''
  }
}

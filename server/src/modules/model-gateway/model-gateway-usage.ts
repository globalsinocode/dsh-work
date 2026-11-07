import type { ModelGatewayUsage } from './model-gateway-types.ts'

/**
 * 从厂商回复中读取用量（模型路由方案 4.6）。统一为“输入总量 + 其中缓存读取量”：
 * - OpenAI 兼容：`prompt_tokens` 已含缓存部分，缓存读取取 `prompt_tokens_details.cached_tokens`，
 *   DeepSeek 另给 `prompt_cache_hit_tokens`（两者一致，DLP-S0）；不提供缓存写入。
 * - Anthropic：`input_tokens` 不含缓存部分，输入总量 = input + cache_read + cache_creation。
 * 厂商没有返回的字段为 null，不记为 0。
 */
export class UsageAccumulator {
  private usage: ModelGatewayUsage = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }
  private anthropic: { input?: number; cacheRead?: number; cacheCreation?: number; output?: number } = {}
  private sawAnthropic = false
  private pending = ''

  /** 读取非流式 JSON 回复。 */
  acceptJson(body: unknown): void {
    if (!isRecord(body)) return
    if (isRecord(body['usage'])) this.acceptUsage(body['usage'], body['type'] === 'message' ? 'anthropic' : detectProtocol(body['usage']))
  }

  /** 逐片段读取 SSE 流；只解析 `data:` 行，不保存正文。 */
  acceptSseChunk(text: string): void {
    this.pending += text
    let newline = this.pending.indexOf('\n')
    while (newline >= 0) {
      const line = this.pending.slice(0, newline).trimEnd()
      this.pending = this.pending.slice(newline + 1)
      this.acceptSseLine(line)
      newline = this.pending.indexOf('\n')
    }
    // 单行异常长时丢弃，避免无界缓冲；用量行都很短。
    if (this.pending.length > 1_048_576) this.pending = ''
  }

  finish(): ModelGatewayUsage {
    if (this.pending) {
      this.acceptSseLine(this.pending.trimEnd())
      this.pending = ''
    }
    if (this.sawAnthropic) {
      const { input, cacheRead, cacheCreation, output } = this.anthropic
      return {
        inputTokens: input === undefined ? null : input + (cacheRead ?? 0) + (cacheCreation ?? 0),
        outputTokens: output ?? null,
        cacheReadTokens: cacheRead ?? null,
        cacheWriteTokens: cacheCreation ?? null,
      }
    }
    return { ...this.usage }
  }

  private acceptSseLine(line: string): void {
    if (!line.startsWith('data:')) return
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]' || !payload.includes('usage')) return
    let event: unknown
    try {
      event = JSON.parse(payload)
    } catch {
      return
    }
    if (!isRecord(event)) return
    // Anthropic：message_start 带 message.usage，message_delta 带 usage（输出为累计值）。
    if (isRecord(event['message']) && isRecord(event['message']['usage'])) {
      this.acceptUsage(event['message']['usage'], 'anthropic')
      return
    }
    if (isRecord(event['usage'])) {
      const type = event['type']
      this.acceptUsage(event['usage'], typeof type === 'string' && type.startsWith('message') ? 'anthropic' : detectProtocol(event['usage']))
    }
  }

  private acceptUsage(usage: Record<string, unknown>, protocol: 'openai' | 'anthropic'): void {
    if (protocol === 'anthropic') {
      this.sawAnthropic = true
      const input = count(usage['input_tokens'])
      const output = count(usage['output_tokens'])
      const cacheRead = count(usage['cache_read_input_tokens'])
      const cacheCreation = count(usage['cache_creation_input_tokens'])
      if (input !== undefined) this.anthropic.input = input
      if (output !== undefined) this.anthropic.output = output
      if (cacheRead !== undefined) this.anthropic.cacheRead = cacheRead
      if (cacheCreation !== undefined) this.anthropic.cacheCreation = cacheCreation
      return
    }
    const input = count(usage['prompt_tokens'])
    const output = count(usage['completion_tokens'])
    const details = isRecord(usage['prompt_tokens_details']) ? usage['prompt_tokens_details'] : {}
    const cacheRead = count(details['cached_tokens']) ?? count(usage['prompt_cache_hit_tokens'])
    if (input !== undefined) this.usage.inputTokens = input
    if (output !== undefined) this.usage.outputTokens = output
    if (cacheRead !== undefined) this.usage.cacheReadTokens = cacheRead
  }
}

function detectProtocol(usage: unknown): 'openai' | 'anthropic' {
  return isRecord(usage) && ('input_tokens' in usage || 'cache_read_input_tokens' in usage) && !('prompt_tokens' in usage)
    ? 'anthropic'
    : 'openai'
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * DSH 系统提示词的保留模板语法检查。
 *
 * DSH 的 system-prompt 会把 `{{name}}` 当作模板变量插值：名字必须匹配
 * `/^[a-z][a-z0-9_]*$/`，且必须已由某个 layer 注册，否则**整个回合直接失败**，
 * Run 收敛为 `RUNTIME_EXECUTION_FAILED`：
 *
 * ```
 * Internal error: turn failed: malformed prompt variable reference "{{simToday}}"
 * in section "deployment:persona" (variable names match /^[a-z][a-z0-9_]*$/)
 * ```
 *
 * 对照实现：`deepseek-harness/packages/core/system-prompt/src/index.ts` 的
 * `VARIABLE_NAME` / `GROUP_AT` / `interpolate()`；已注册变量由
 * `packages/core/agent-loop/src/index.ts` 给出（provider / model / cwd）。
 *
 * dsh-work 把 Agent 的 SOUL.md 作为 `deployment:persona` 注入，写的是业务文本，
 * 作者很容易用 `{{字段名}}` 表示「这里填工具返回的字段」——这不是平台支持的语法，
 * 却只在真实执行时才炸，发布检查完全看不到。因此在这里做前置校验，让失败提前到
 * 「检查」阶段并给出精确行号。
 *
 * 判定必须与 DSH 等价，否则会出现「检查通过但运行时仍失败」的第二套口径：
 *  - 完整分组 `{{...}}`（`[^{}]` 可跨行，与 DSH 的 `GROUP_AT` 一致）→ 校验变量名；
 *  - 存在 `{{` 但配不成完整分组、其后又出现 `}}` → DSH 判为畸形引用，此处同等判为畸形。
 */
export const DSH_PROMPT_VARIABLE_NAME = /^[a-z][a-z0-9_]*$/

/** DSH agent-loop 当前注册的全部提示词变量。 */
export const DSH_REGISTERED_PROMPT_VARIABLES: readonly string[] = ['provider', 'model', 'cwd']

/** 与 DSH system-prompt 的 GROUP_AT 完全一致（`[^{}]` 可跨行）。 */
const GROUP_AT = /^\{\{([^{}]*)\}\}/

export type PromptTemplateFindingReason = 'malformed' | 'unknown' | 'unclosed'

export interface PromptTemplateFinding {
  /** 花括号内的原文；`unclosed` 时为出现位置起的原文片段。 */
  name: string
  /** 1 起算的行号，便于作者直接定位。 */
  line: number
  reason: PromptTemplateFindingReason
}

function lineAt(text: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === '\n') line += 1
  }
  return line
}

/**
 * 扫描系统提示词中的 `{{...}}` 引用并分类。
 * 返回空数组表示该提示词不会触发 DSH 的模板校验失败。
 *
 * 遍历顺序与 DSH 的 `interpolate()` 逐步对齐（同一个 `GROUP_AT`、同一套 `last`
 * 推进规则），保证「DSH 会抛错 ⇒ 这里必须有发现项」。差别仅在「报几个」：DSH 遇到
 * 第一个非法引用即抛错，这里把全部问题一次列出，避免作者改一个再撞下一个。
 */
export function findPromptTemplateFindings(systemPrompt: string): PromptTemplateFinding[] {
  const findings: PromptTemplateFinding[] = []
  let last = 0
  for (let open = systemPrompt.indexOf('{{'); open >= 0; open = systemPrompt.indexOf('{{', last)) {
    const group = GROUP_AT.exec(systemPrompt.slice(open))
    if (group === null) {
      // DSH：配不成完整分组、但后面还有 }}，直接判为畸形引用（否则视为字面散文）。
      if (systemPrompt.indexOf('}}', open + 2) >= 0) {
        findings.push({
          name: systemPrompt.slice(open, open + 16),
          line: lineAt(systemPrompt, open),
          reason: 'unclosed',
        })
      }
      last = open + 2
      continue
    }
    const name = group[1] ?? ''
    const line = lineAt(systemPrompt, open)
    if (!DSH_PROMPT_VARIABLE_NAME.test(name)) {
      findings.push({ name, line, reason: 'malformed' })
    } else if (!DSH_REGISTERED_PROMPT_VARIABLES.includes(name)) {
      findings.push({ name, line, reason: 'unknown' })
    }
    last = open + group[0].length
  }
  return findings
}

/** 生成面向作者的一句话说明。 */
export function describePromptTemplateFinding(finding: PromptTemplateFinding): string {
  switch (finding.reason) {
    case 'malformed':
      return `第 ${finding.line} 行 {{${finding.name}}} 变量名不合法`
    case 'unknown':
      return `第 ${finding.line} 行 {{${finding.name}}} 不是已注册变量`
    case 'unclosed':
      return `第 ${finding.line} 行有配不成对的花括号引用，起始于「${finding.name}」`
  }
}

/** 面向作者的可操作修复提示（拼在检查 detail 之后）。 */
export const PROMPT_TEMPLATE_REMEDIATION =
  '这些花括号会被 DSH 当作模板变量引用，不合法或未注册都会让整个回合直接失败；'
  + `DSH 只注册了 ${DSH_REGISTERED_PROMPT_VARIABLES.join(' / ')}。`
  + '若本意是「引用工具返回的字段」，请去掉花括号直接写字段名。'

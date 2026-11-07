/**
 * 模型标识（厂商的模型 id）的格式。厂商的模型 id 常带点号、下划线、斜杠或大写字母
 * （如 `qwen3.8-flash`、`gpt-4.1`、`Qwen/Qwen3-8B`），不能沿用 Provider / 路由 key 的规则。
 * 模型标识会进入每 Attempt patch（JSON 字符串）并由模型网关逐请求比对，只允许常见的模型名字符。
 * 管理端校验、Manifest 编译器与 runtime-manifest.schema.json 共用同一规则。
 */
export const MODEL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/

export function isValidModelKey(value: string): boolean {
  return MODEL_KEY_PATTERN.test(value)
}

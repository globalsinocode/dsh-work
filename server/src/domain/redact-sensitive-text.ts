/** 面向员工可见文案的凭据与密钥脱敏（domain 纯函数，供失败原因与观测层共用）。 */
export function redactSensitiveText(value: string) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|password|passwd|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/(https?:\/\/[^\s:/]+:)[^\s@/]+@/gi, '$1[REDACTED]@')
    .replace(/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
}

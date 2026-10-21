import katex from 'katex'

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function renderMathInline(tex: string) {
  const trimmed = tex.trim()
  if (!trimmed) return ''
  try {
    return katex.renderToString(trimmed, {
      displayMode: false,
      throwOnError: false,
      strict: 'ignore',
      output: 'html',
    })
  } catch {
    return `<span class="md-math-fallback">${escapeHtml(trimmed)}</span>`
  }
}

export function renderMathBlock(tex: string) {
  const trimmed = tex.trim()
  if (!trimmed) return ''
  try {
    const html = katex.renderToString(trimmed, {
      displayMode: true,
      throwOnError: false,
      strict: 'ignore',
      output: 'html',
    })
    return `<div class="md-math-block">${html}</div>`
  } catch {
    return `<pre class="md-math-fallback">${escapeHtml(trimmed)}</pre>`
  }
}

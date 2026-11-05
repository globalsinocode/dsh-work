/**
 * 钉钉容器能力适配层（钉钉接入方案 4.3）。只做界面与容器交互，不承载业务逻辑；容器识别只用于界面，
 * 不作为安全依据——身份由服务端用一次性授权码向钉钉换取。钉钉外运行时退回浏览器默认行为。
 *
 * JSAPI 只在钉钉容器内按需加载（官方 dingtalk.open.js）；P1 浏览器测试在页面中注入 `window.dd` 替身。
 */
interface DingTalkJsApi {
  runtime?: { permission?: { requestAuthCode?: (options: { corpId: string; onSuccess: (result: { code: string }) => void; onFail: (error: unknown) => void }) => void } }
  requestAuthCode?: (options: { corpId: string; clientId?: string; onSuccess: (result: { code?: string; authCode?: string }) => void; onFail: (error: unknown) => void }) => void
  biz?: { navigation?: { setTitle?: (options: { title: string }) => void; close?: (options?: object) => void } }
  ready?: (callback: () => void) => void
}

declare global {
  interface Window { dd?: DingTalkJsApi }
}

const jsApiUrl = import.meta.env.VITE_DINGTALK_JSAPI_URL || 'https://g.alicdn.com/dingding/dingtalk-jsapi/3.0.25/dingtalk.open.js'
let loading: Promise<DingTalkJsApi | null> | undefined

/** 是否运行在钉钉客户端内（按 User-Agent，仅用于界面）。 */
export function isDingTalkContainer(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent) {
  return /DingTalk/i.test(userAgent)
}

export function loadDingTalkJsApi(): Promise<DingTalkJsApi | null> {
  if (!isDingTalkContainer()) return Promise.resolve(null)
  if (window.dd) return Promise.resolve(window.dd)
  loading ??= new Promise(resolve => {
    const script = document.createElement('script')
    script.src = jsApiUrl
    script.async = true
    script.onload = () => resolve(window.dd ?? null)
    script.onerror = () => resolve(null)
    document.head.appendChild(script)
  })
  return loading
}

/** 免登：取一次性授权码。失败（不在钉钉内、JSAPI 不可用、用户取消）时抛错。 */
export async function requestDingTalkAuthCode(corpId: string): Promise<string> {
  const dd = await loadDingTalkJsApi()
  if (!dd) throw new Error('无法加载钉钉能力，请在钉钉中重新打开')
  await new Promise<void>(resolve => (dd.ready ? dd.ready(resolve) : resolve()))
  return new Promise((resolve, reject) => {
    const onFail = (error: unknown) => reject(new Error(typeof error === 'object' && error && 'errorMessage' in error ? String((error as { errorMessage: unknown }).errorMessage) : '钉钉授权失败'))
    const legacy = dd.runtime?.permission?.requestAuthCode
    if (legacy) {
      legacy({ corpId, onSuccess: result => resolve(result.code), onFail })
      return
    }
    if (dd.requestAuthCode) {
      dd.requestAuthCode({ corpId, clientId: corpId, onSuccess: result => {
        const code = result.code ?? result.authCode
        if (code) resolve(code)
        else onFail(new Error('钉钉没有返回授权码'))
      }, onFail })
      return
    }
    onFail(new Error('当前钉钉版本不支持免登'))
  })
}

/** 导航栏标题随页面变化；钉钉外不做任何事。 */
export function setContainerTitle(title: string) {
  if (!isDingTalkContainer()) return
  void loadDingTalkJsApi().then(dd => dd?.biz?.navigation?.setTitle?.({ title }))
}

/** 关闭微应用；钉钉外退回浏览器后退。 */
export function closeContainerPage() {
  if (isDingTalkContainer() && window.dd?.biz?.navigation?.close) {
    window.dd.biz.navigation.close({})
    return
  }
  window.history.back()
}

const flashKey = 'dsh-work:dingtalk-flash'
const ticketKey = 'dsh-work:dingtalk-binding-ticket'
export type DingTalkFlash = 'bound' | 'bound_after_change' | 'not_bound'

/** 登录页与首页之间的一次性提示（跳转后显示一次）。 */
export function setDingTalkFlash(flash: DingTalkFlash) {
  try { window.sessionStorage.setItem(flashKey, flash) } catch { /* 隐私模式下不提示 */ }
}

export function takeDingTalkFlash(): DingTalkFlash | null {
  try {
    const value = window.sessionStorage.getItem(flashKey)
    window.sessionStorage.removeItem(flashKey)
    return value === 'bound' || value === 'bound_after_change' || value === 'not_bound' ? value : null
  } catch { return null }
}

/** 需先修改初始密码时，待绑定凭证带到改密页（只在本标签页保存，约 5 分钟后服务端失效）。 */
export function keepBindingTicket(ticket: string) {
  try { window.sessionStorage.setItem(ticketKey, ticket) } catch { /* 无法保存时改密后不绑定 */ }
}

export function takeBindingTicket(): string | null {
  try {
    const value = window.sessionStorage.getItem(ticketKey)
    window.sessionStorage.removeItem(ticketKey)
    return value
  } catch { return null }
}

export function peekBindingTicket(): string | null {
  try { return window.sessionStorage.getItem(ticketKey) } catch { return null }
}

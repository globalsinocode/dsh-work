import { afterEach, describe, expect, it, vi } from 'vitest'

import { isDingTalkContainer, requestDingTalkAuthCode } from './dingtalk'

describe('DingTalk container adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete window.dd
  })

  it('recognises the DingTalk client by user agent only', () => {
    expect(isDingTalkContainer('Mozilla/5.0 AliApp(DingTalk/7.6.0)')).toBe(true)
    expect(isDingTalkContainer('Mozilla/5.0 (Macintosh) Chrome/130')).toBe(false)
  })

  it('requests a one-time auth code with the corp id through the JSAPI', async () => {
    vi.stubGlobal('navigator', { userAgent: 'AliApp(DingTalk/7.6.0)' })
    const requestAuthCode = vi.fn(({ onSuccess }: { onSuccess: (result: { code: string }) => void }) => onSuccess({ code: 'code-1' }))
    window.dd = { runtime: { permission: { requestAuthCode } } }
    await expect(requestDingTalkAuthCode('ding-corp')).resolves.toBe('code-1')
    expect(requestAuthCode).toHaveBeenCalledWith(expect.objectContaining({ corpId: 'ding-corp' }))
  })

  it('reports a failed authorization', async () => {
    vi.stubGlobal('navigator', { userAgent: 'AliApp(DingTalk/7.6.0)' })
    window.dd = { runtime: { permission: { requestAuthCode: ({ onFail }) => onFail({ errorMessage: '用户取消' }) } } }
    await expect(requestDingTalkAuthCode('ding-corp')).rejects.toThrow('用户取消')
  })

  it('refuses outside the DingTalk client', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Chrome/130' })
    await expect(requestDingTalkAuthCode('ding-corp')).rejects.toThrow('无法加载钉钉能力')
  })
})

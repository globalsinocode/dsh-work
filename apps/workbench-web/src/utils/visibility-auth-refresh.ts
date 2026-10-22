export function registerVisibilityAuthRefresh(refresh: () => Promise<void>) {
  const onVisibilityChange = () => {
    if (document.visibilityState !== 'visible') return
    void refresh()
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  return () => document.removeEventListener('visibilitychange', onVisibilityChange)
}

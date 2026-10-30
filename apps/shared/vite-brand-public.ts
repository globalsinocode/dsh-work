import { fileURLToPath, URL } from 'node:url'

/** 品牌方形图标资源（圆角由浏览器 / PWA 容器裁剪） */
export function resolveBrandPublicDir(importMetaUrl: string) {
  return fileURLToPath(new URL('../../packages/brand-assets/public', importMetaUrl))
}

export const brandThemeColor = '#4c73eb'

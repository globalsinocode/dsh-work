import { brandThemeColor } from './vite-brand-public.ts'

export interface DshWorkPwaManifest {
  name: string
  short_name: string
  description: string
  start_url: string
  id?: string
}

const brandIconAssets = ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'brand-mark.svg', 'pwa-192.png', 'pwa-512.png']

const manifestIcons = [
  {
    src: 'pwa-192.png',
    sizes: '192x192',
    type: 'image/png',
    purpose: 'any' as const,
  },
  {
    src: 'pwa-512.png',
    sizes: '512x512',
    type: 'image/png',
    purpose: 'any' as const,
  },
  {
    src: 'pwa-512.png',
    sizes: '512x512',
    type: 'image/png',
    purpose: 'maskable' as const,
  },
]

export function createDshWorkPwaOptions(manifest: DshWorkPwaManifest) {
  return {
    registerType: 'autoUpdate' as const,
    injectRegister: false as const,
    manifestFilename: 'manifest.webmanifest',
    includeAssets: brandIconAssets,
    manifest: {
      name: manifest.name,
      short_name: manifest.short_name,
      description: manifest.description,
      start_url: manifest.start_url,
      id: manifest.id ?? manifest.start_url,
      theme_color: brandThemeColor,
      background_color: brandThemeColor,
      display: 'standalone' as const,
      scope: '/',
      lang: 'zh-CN',
      icons: manifestIcons,
    },
    workbox: {
      navigateFallback: '/index.html',
      navigateFallbackDenylist: [/^\/api(?:\/|$)/, /^\/auth(?:\/|$)/],
      globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,woff,woff2}'],
      cleanupOutdatedCaches: true,
      clientsClaim: true,
      skipWaiting: true,
    },
  }
}

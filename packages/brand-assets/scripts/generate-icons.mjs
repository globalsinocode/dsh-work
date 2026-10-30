import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Regenerate raster icons after editing brand-mark.svg:
 *   pnpm add -D sharp --filter @dsh-work/brand-assets
 *   node packages/brand-assets/scripts/generate-icons.mjs
 */
const { default: sharp } = await import('sharp')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'brand-mark.svg')
const publicDir = join(root, 'public')

mkdirSync(publicDir, { recursive: true })

const svg = readFileSync(source)
copyFileSync(source, join(publicDir, 'favicon.svg'))
copyFileSync(source, join(publicDir, 'brand-mark.svg'))

const sizes = [
  { name: 'favicon-32.png', size: 32 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'pwa-192.png', size: 192 },
  { name: 'pwa-512.png', size: 512 },
]

for (const { name, size } of sizes) {
  await sharp(svg, { density: Math.ceil((size / 34) * 72) })
    .resize(size, size, { fit: 'fill' })
    .png()
    .toFile(join(publicDir, name))
}

console.log(`Generated icons in ${publicDir}`)

import { resolve } from 'node:path'
import { missingBundleFiles } from './release-bundle.mjs'

// 打包收尾核验：发布包缺少服务启动要读取的配置文件时失败，不产出发布包。
const bundle = process.argv[2]
if (!bundle) {
  console.error('Usage: node scripts/release/verify-release-bundle.mjs BUNDLE_DIRECTORY')
  process.exit(2)
}
const missing = missingBundleFiles(resolve(import.meta.dirname, '../..'), resolve(bundle))
if (missing.length) {
  console.error(`release bundle is missing server configuration:\n${missing.map(file => `- ${file}`).join('\n')}`)
  process.exit(1)
}

import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'

import App from './App.vue'
import router from './router'
import { pinia } from './stores'
import '@dsh-work/design-tokens/tokens.css'
import '@dsh-work/ui-core/base.css'
import { setupErrorReporter } from '@dsh-work/ui-core'

const app = createApp(App)
// 错误记录（OBS-S1）：渲染错误、未处理异常、接口 5xx 与失败提示上报到平台，管理员在“错误记录”查看。
setupErrorReporter({
  app: 'workbench',
  release: typeof __DSH_WORK_RELEASE_VERSION__ === 'undefined' ? undefined : __DSH_WORK_RELEASE_VERSION__,
  routeName: () => {
    const name = router.currentRoute.value.name
    return typeof name === 'string' ? name : undefined
  },
}).install(app)
app.use(pinia).use(router).use(ElementPlus).mount('#app')
// index.html 中的启动检查据此判断应用已挂载（未挂载时上报白屏）。
;(window as Window & { __DSH_APP_MOUNTED__?: boolean }).__DSH_APP_MOUNTED__ = true

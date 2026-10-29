import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'

import App from './App.vue'
import router from './router'
import { pinia } from './stores'
import '@dsh-work/design-tokens/tokens.css'
import '@dsh-work/ui-core/base.css'
import 'katex/dist/katex.min.css'

import { registerAppPwa } from '../../shared/register-app-pwa.ts'

registerAppPwa()

createApp(App).use(pinia).use(router).use(ElementPlus).mount('#app')

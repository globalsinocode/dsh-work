# 前端规范 — Vue 2 + TypeScript（含 IE11）

页面清单、路由表、验收场景见项目 `docs/项目-业务约定.md`。

## 1. 硬约束

- `<script lang="ts">`；业务组件不新增纯 JS。
- **Vue 2.6 / 2.7** + **Element UI 2**（若用 UI 库）；构建目标含 **IE11**。
- Babel → ES5；`core-js`、`regenerator-runtime`；`index.html` 含 `X-UA-Compatible: IE=edge`。
- 主布局不用未转译的 CSS 变量 / Grid。
- **禁止**：Vue 3、Vite、`<script setup>`、Element Plus、与 IE11 不兼容的 Composition API 写法。
- 从其它项目复制组件须先改为 Vue2 + Element UI 2，禁止直接搬 Vue3 组件库。

## 2. 目录骨架

```text
web/
├── public/
├── src/
│   ├── __test__/        # 所有新建单测，镜像 src（§3.4）
│   │   ├── components/
│   │   ├── views/
│   │   └── …
│   ├── api/
│   ├── components/      # 仅生产代码；新建见 §3.2
│   ├── domain/          # 可单测的纯函数（亦可测 domain/ 镜像到 __test__/domain/）
│   ├── layouts/
│   ├── router/
│   ├── styles/
│   ├── types/
│   ├── views/           # 新建页面：§3.3
│   │   └── order-list/
│   │       └── index.vue
│   ├── App.vue
│   └── main.ts
├── babel.config.js
├── vue.config.js
└── tsconfig.json
```

Monorepo 时前端包可能在 `apps/<app>/src/` 或 `web/src/`；**目录与命名约定与 [vue3.md](vue3.md) 相同**（仅脚本语法、构建链不同）。

`vue.config.js`：

- 开发代理 `/api` → 本地后端
- 别名 `@` → `src`
- `transpileDependencies` 含 UI 库；SCSS 变量构建期展开

`main.ts` 先加载 IE11 polyfill；`tsconfig` `target` 与 babel 一致（常为 `es5`）。

Webpack 调试用 `vue inspect > output.js` 仅查看；**改配置只改 `vue.config.js`**。

## 3. 组件、页面与单测

与 [vue3.md](vue3.md) §3 **目录结构一致**；本节只强调 Vue 2 脚本写法差异。

### 3.1 API 风格与 SFC 块顺序

- 以 **Options API**（`data` / `computed` / `methods`）为主。
- SFC 顺序：`template` → `script lang="ts"` → `style scoped`（**不要**把 `<script>` 放在 `<template>` 前）。
- 禁止 Vue3 专属：`<script setup>`、`defineModel`、Teleport 等。

### 3.2 新建组件（`components/`）

```text
src/components/<feature-kebab>/
├── <feature-kebab>.vue
└── <feature-kebab>-helper.ts   # 可选，同目录私有 TS
```

- 目录名、主文件名：**kebab-case**；勿在 `components/` 根下堆散文件。  
- 遗留 `PascalCase.vue` 可继续维护，新功能用上述结构。

### 3.3 新建页面（`views/`）

```text
src/views/<page-kebab>/
├── index.vue                 # 路由页面入口（必选）
├── <block-kebab>.vue         # 可选，仅本页
└── …
```

- 目录名、文件名：**小写 kebab-case**（无 `View` 后缀）。  
- 路由懒加载示例（Vue Router 3）：  
  `component: () => import(/* webpackChunkName: "order-list" */ '@/views/order-list/index.vue')`  
- 跨页复用块仍放 `components/<feature-kebab>/`。

### 3.4 单测（`src/__test__/`）

- **所有新建** `*.test.ts` / `*.spec.ts`（以项目 Jest/Vitest 配置为准）放在 **`src/__test__/`**，路径**镜像** `src/` 下被测文件。  
- **禁止**在 `src/views/`、`src/components/` 等生产目录旁新建测试文件。  
- 示例：`src/views/order-list/index.vue` → `src/__test__/views/order-list/index.test.ts`。  
- 遗留旁路测试可只改内容；迁移由任务 / SDD 明确要求。  
- 纯函数仍优先 `domain/` + 对应 `__test__/domain/` 单测（与「页面/组件进 `__test__`」不冲突）。

### 3.5 `this` 约定（易错）

| 场景 | 写法 | 原因 |
|------|------|------|
| Vue 管理的函数（`methods`、生命周期、`data` 里函数） | **普通函数** | `this` 指向组件实例 |
| 不被 Vue 管理的回调（`setTimeout`、ajax、`Promise.then` 等） | **箭头函数** | 外层 `this` 仍指向实例 |

## 4. 路由

- `vue-router@3`，**hash** 模式（IE11 / 静态托管友好）。
- 需登录页：守卫未登录 → 登录页。
- 新建路由组件路径：`@/views/<page-kebab>/index.vue`（见 §3.3）。

## 5. 页面行为

- 只请求 **Nest JSON**，浏览器不直连共享目录/源文件。
- 接口失败：展示错误，不伪造数据或指标。
- 空态：明确文案；无数据不显示为 `0`。
- 未接入功能：提示「未接入」，不做假下载/假写入。
- 明细用**表格**，IE11 可纵向滚动。

## 6. HTTP

用 **axios**（XHR），不依赖未 polyfill 的 `fetch`。

```typescript
import axios from 'axios';

export const api = axios.create({
  baseURL: process.env.VUE_APP_API_BASE || '/api',
  timeout: 30000,
});
```

拦截器将 `{ message, code }` 转为可展示 `Error`；`types/` 与后端 JSON 一致。

## 7. 验证

```bash
cd web && npm run lint
cd web && npm test
# 单文件示例：npm test -- src/__test__/views/order-list/index.test.ts
```

日常可用 Chrome；**发布前 IE11 复测**核心路径。有 `docs/SDD/` 的仓库，本期路径与测试范围以实施计划为准（见 [sdd.md](sdd.md)）。

# 前端规范 — Vue 3

无 IE11 目标时的现代 Vue 3 约定；若项目 README 写明 Vue 2，改用 [vue2.md](vue2.md)。**`components/`、`views/`、`__test__/` 目录约定与 vue2 相同**，差异仅在 `<script>` 语法与构建链。

## 1. 硬约束

- TypeScript；SFC 使用 `<script setup lang="ts">` 或组合式 API + `defineComponent`，与仓库现有风格一致。  
- 构建常见为 **Vite**；路由 `vue-router@4`，默认 **history**（部署需 fallback 配置）。  
- UI：Element Plus、Naive UI 等以项目 `package.json` 为准，不混用 Element UI 2。

## 2. 目录骨架（参考）

```text
src/
├── __test__/             # 所有新建单测（镜像 src 目录，见 §3.3）
│   ├── components/
│   ├── views/
│   ├── composables/
│   ├── stores/
│   └── …
├── api/
├── components/           # 仅生产代码，旁路不新建 *.test.ts
├── composables/
├── layouts/
├── router/
├── stores/
├── types/
├── views/                # 新建页面：每页独立目录 + index.vue（§3.3）
│   └── workspace-detail/
│       └── index.vue
├── App.vue
└── main.ts
```

Monorepo 时前端包常在 `apps/<app-name>/src/`；命令在对应包目录执行。

本期功能的**文件路径、测试范围、不改清单**以 **`docs/SDD/实施计划/`** 为准（结构见 [sdd.md](sdd.md)）；通用组件目录约定见下文 §3。

## 3. 组件与单文件（SFC）

### 3.1 块顺序

与 [vue2.md](vue2.md) 一致，固定为：

```text
<template>
…
</template>

<script setup lang="ts">
…
</script>

<style scoped>
…
</style>
```

不要把 `<script>` 放在 `<template>` 前面，除非改动的文件本身已是另一种历史顺序且任务未要求统一。

### 3.2 新建组件：目录 + kebab-case

**新增**可复用组件（非改一行既有 `PascalCase.vue`）时：

```text
src/components/<feature-kebab>/
├── <feature-kebab>.vue          # 主 SFC
├── <feature-kebab>-bridge.ts    # 可选：仅本组件用的桥/常量
└── …
```

- 目录名与主文件名一致，均为 **kebab-case**。  
- 组件专用 TS **不要**丢在 `components/` 根目录。  
- 在父级中：`import TeamFoo from '@/components/team-foo/team-foo.vue'`（import 符号用 **PascalCase** 即可）。

### 3.3 新建页面（`views/`）：独立目录 + `index.vue`

**新增**路由页面（非改一行既有 `FooView.vue`）时，**不要**在 `views/` 根下再建 `PascalCaseView.vue`。

```text
src/views/<page-kebab>/
├── index.vue              # 该路由的页面入口（必选）
├── <block-kebab>.vue      # 可选：仅本页使用的子块
└── use-<page-kebab>.ts    # 可选：仅本页使用的 composable
```

约定：

- **目录名、文件名**一律 **小写 kebab-case**（仅用 `-` 连接，无大写、无 `View` 后缀）。  
  - 例：团队空间详情 → `views/workspace-detail/index.vue`（不是 `WorkspaceDetailView.vue`）。  
- **`index.vue`** 即该页主 SFC；路由懒加载指向目录入口：  
  `() => import('@/views/workspace-detail/index.vue')`  
- 跨页复用的块仍放 `src/components/<feature-kebab>/`，不要塞进某个 `views/` 子目录。  
- **遗留** `src/views/ConversationView.vue` 等可继续维护；新页或 SDD 要求重构时再迁到上述结构。

### 3.4 单测位置（`src/__test__/`）

**所有新建** `*.test.ts` 一律放在 **`src/__test__/`**，按被测代码在 `src/` 下的路径**镜像**子目录（不把 `__test__` 限死在 `components`）：

| 被测代码 | 新建单测路径（示例） |
|----------|----------------------|
| `src/components/team-space-composer/team-space-composer.vue` | `src/__test__/components/team-space-composer/team-space-composer.test.ts` |
| `src/views/workspace-detail/index.vue` | `src/__test__/views/workspace-detail/index.test.ts` |
| `src/composables/use-foo.ts` | `src/__test__/composables/use-foo.test.ts` |
| `src/stores/content.ts` | `src/__test__/stores/content.test.ts` |

规则：

- 测试文件名：**kebab-case** + `.test.ts`（与 [engineering.md](engineering.md) 一致）。  
- **`src/components/`、`src/views/` 等生产目录旁禁止新建** `*.test.ts`。  
- **遗留**旁路单测（如 `src/views/WorkspaceDetailView.test.ts`）可继续只改内容；迁移后路径应对齐 `__test__/views/<page-kebab>/index.test.ts`。  
- `describe` 名建议与 feature / 模块 kebab 一致。  
- 导入被测模块用 `@/` 别名。  
- Vitest 常见 `include` 为 `src/**/*.test.ts`，`src/__test__/**` 会被收录；改配置前先读 `vitest.config.ts`。

### 3.5 逻辑与接口

- 逻辑复用优先 **composable**（`composables/use-xxx.ts`），避免巨型 `setup`。  
- Props / emits 用 `defineProps` / `defineEmits` 并标注类型。  
- 纯展示组件（骨架屏、静态壳）可无 props；仍保留简短中文块注释说明**用途与宿主**，不复述模板结构。  
- 副作用（请求、订阅）在 `onMounted` / `onUnmounted`（或 `onBeforeUnmount`）成对清理。  
- 加载态：`aria-busy`、`role="status"` 等与 Element Plus 骨架配合时，保持可访问名称（中文 `aria-label`）。

### 3.6 与 engineering 命名表的关系

- **文件路径**：kebab-case（见 [engineering.md](engineering.md) §1）。  
- **代码中的组件名 / 类型**：PascalCase。  
- 仓库中旧的 `ConversationStarter.vue`、`WorkspacesView.vue` 等 **不必**为对齐规范而批量重命名。

## 4. 状态

- 跨页共享用 **Pinia**；组件内局部状态留在 `ref` / `reactive`。  
- 不在子组件直接改 prop；用 emit 或 store action。

## 5. 页面行为

- 数据来自后端 API；错误与空态原则同 [vue2.md](vue2.md) §5。  
- 环境变量：`import.meta.env`（Vite），勿混用 `process.env.VUE_APP_*` 除非项目已统一封装。

## 6. 验证

在目标应用包目录：

```bash
pnpm run lint
pnpm run build
pnpm test
# 或单文件：pnpm exec vitest run src/__test__/<镜像路径>/<name>.test.ts
```

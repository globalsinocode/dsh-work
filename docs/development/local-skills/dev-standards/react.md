# 前端规范 — React

函数组件 + Hooks；类组件仅维护遗留代码时沿用，新代码不写 class。

## 1. 技术栈

- TypeScript；扩展名 `.tsx` / `.ts`。
- 构建以项目为准（Vite、Next.js、CRA 等），不擅自换脚手架。
- 路由、状态（Redux、Zustand、React Query 等）遵循仓库已有选型。

## 2. 目录（参考）

```text
src/
├── api/
├── components/
├── hooks/
├── pages/ 或 app/   # 视框架而定
├── types/
└── utils/
```

## 3. 组件约定

- 一个文件默认导出一个主要组件；文件名 PascalCase 或与团队 kebab 约定一致（跟仓库现有文件）。
- Props 用 interface / type 声明；避免 `any`。
- 列表渲染稳定 `key`（不用随机数）。
- 副作用：`useEffect` 依赖数组完整；清理函数在卸载时执行。

## 4. 数据与错误

- 服务端状态优先用项目已有的 data-fetch 层（React Query、SWR 等），避免在多个组件重复请求。
- 加载 / 错误 / 空态三态显式 UI，不静默失败。

## 5. 样式

- 与项目一致：CSS Modules、Tailwind、styled-components 等，不混用多种方案于同一功能模块。

## 6. 验证

```bash
npm run lint
npm test
npm run build
```

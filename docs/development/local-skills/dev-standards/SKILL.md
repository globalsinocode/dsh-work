---
name: dev-standards
description: 本仓库本地开发时使用。对齐命名、docs/SDD、Vue 3 组件目录、单测位置和提交信息，并把每次修改写入修改记录。不是 Skill 广场包，不导入管理端。
---

# 开发规范（本仓库本地开发）

**通用工程与栈约定只维护在本 skill**。各 Git 仓库**不必**复制 `docs/开发规范/通用-*`。

**边界：** 本目录只给克隆本仓库后的本地开发阅读。它不是 Skill 广场候选，不要放进 `docs/development/fixtures/skill-plaza-candidates/`，不要打进 `dist/skill-plaza-packages/`，不要通过管理端导入。

## 优先级（冲突时）

1. **当前仓库**：`AGENTS.md`、`docs/SDD/`（本期规格 + 实施计划）、已有同类文件的布局与命名  
2. **本 skill**：`engineering.md`、`sdd.md`、对应栈文档（`vue3.md` 等）  
3. **个人习惯**：不得覆盖 1、2

写代码或审查时：**先读本期 `docs/SDD` → 本 skill → 对照邻近平行文件**。

## 仓库里应保留什么

| 内容 | 路径 |
|------|------|
| **SDD 规格 + 实施计划** | **`docs/SDD/规格文档/`**、**`docs/SDD/实施计划/`**（见 [sdd.md](sdd.md)） |
| 长期方案 / 设计基线 | `docs/design/`、`docs/development/` 等（以仓库为准） |
| 本项目命名、路由、错误码 | `docs/项目-业务约定.md`（文件名可略有差异） |
| Agent / 分支 / CI | `AGENTS.md` 等根目录约定 |
| 其它仓库常用规格目录 | `docs/superpowers/specs/`（**若与 `docs/SDD` 并存，本期增量以 SDD 为准**） |

## 加载顺序

1. **项目层**：`docs/SDD/规格文档/<本期>.md` + `docs/SDD/实施计划/<本期>.md`（存在时）；不得搬用其它项目的表、路由、字段。  
2. **SDD 写法**：[sdd.md](sdd.md)  
3. **工程共性**：[engineering.md](engineering.md)  
4. **技术栈**：只读**一份**栈文档。

| 条件 | 阅读 |
|------|------|
| 写/读 `docs/SDD` | [sdd.md](sdd.md) |
| Vue 2 + TypeScript，含 IE11 | [vue2.md](vue2.md)（目录 / `views` / `__test__` 与 vue3 同构，仅 API 与构建不同） |
| Element UI 2（常与 Vue 2） | [element-ui.md](element-ui.md)（叠加 vue2） |
| Vue 3 现代目标 | [vue3.md](vue3.md) |
| React + Hooks | [react.md](react.md) |
| NestJS + TypeORM + PostgreSQL | [nest.md](nest.md) |

本仓库只读 `engineering.md`、`sdd.md`、`vue3.md`。员工端与管理端是 Vue 3 + Vite + Element Plus；服务端是既有 `server/src/modules/` 与 SQL migration。不要按 `vue2.md`、`element-ui.md`、`react.md`、`nest.md` 改当前代码。

## Vue 3 速查（详见 vue3.md §3；SDD 实施计划可再写死路径）

**组件**

- `components/<feature-kebab>/<feature-kebab>.vue`；专用 TS 同目录  

**页面（views）**

- `views/<page-kebab>/index.vue` 为路由入口；目录内其它文件亦 **kebab-case**  
- 路由：`import('@/views/<page-kebab>/index.vue')`  

**通用**

- **SFC 块顺序**：`template` → `<script setup lang="ts">` → `style`  
- **新建单测**：一律 `src/__test__/…`，子路径镜像 `src/`（组件、页面、store、composable 等）  
- **禁止**在 `src/views/`、`src/components/` 等旁路新建 `*.test.ts`  
- **遗留**旁路 `*.test.ts` 可只改内容；迁移由 SDD/任务明确要求  

## 修改记录

每次改动本仓库后，在 [`docs/development/修改记录.md`](../../修改记录.md) 最上方追加一条，写明时间、为什么、做了什么、涉及文件。提交信息按 [engineering.md](engineering.md) §5 书写；只有明确要求时才执行 `git commit`。这份记录同样不是 Skill 广场数据。

## 实现前自检

- [ ] 本期 **`docs/SDD`** 范围与「不改」清单已读  
- [ ] 栈与 `package.json` / README 一致  
- [ ] 新文件符合 engineering + vue3；计划中的路径已落地  
- [ ] 失败与空态真实展示，不用 `0` 冒充无数据  
- [ ] 改动范围最小  
- [ ] 分支与发版以本仓库 `AGENTS.md` 为准：日常在 `dev`，发版用 `--no-ff` 把 `dev` 合并进 `main`（见 [engineering.md](engineering.md) §5）
- [ ] 已在修改记录最上方写下本次改动  

## 验证

以**当前应用包**的 `package.json` 为准（monorepo：`cd apps/<app>`）：

| 栈 | 常见命令 |
|----|----------|
| 前端 | `pnpm test`、`pnpm run lint`、`pnpm run build` |
| Vue2 + IE11 | 上述 + IE11 复测 |
| 后端 | 对应包下的 `pnpm test` |

验收以 **SDD 规格 + 实施计划** 及仓库 E2E 目录为准。

## 本仓库清单

- [ ] 本地开发阅读 `docs/development/local-skills/dev-standards/`，不要把它同步进 Skill 广场  
- [ ] 增量规格继续放在已有的 **`docs/SDD/规格文档/`** 与 **`docs/SDD/实施计划/`**  
- [ ] 业务边界看 `AGENTS.md`、`docs/development/overview.md` 和当期 SDD，不另建 `docs/项目-业务约定.md`  
- [ ] **不要**再建 `docs/开发规范/通用-*`  

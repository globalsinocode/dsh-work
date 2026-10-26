# 工程规范（全栈通用）

适用于 TypeScript / Node 全栈项目；与具体 UI 框架无关。

## 1. 命名

### 文件

- 新增英文技术文件：**kebab-case**（如 `user-import.service.ts`、`team-space-composer.vue`）。
- 规格与中文文档：中文文件名。增量交付推荐 **`docs/SDD/规格文档/`** + **`docs/SDD/实施计划/`**（成对、同日期主题）；写法见 [sdd.md](sdd.md)。其它目录如 `docs/superpowers/specs/`、`docs/design/` 以仓库为准。

### Vue 单文件组件（路径）

| 类型 | 约定 |
|------|------|
| **新建**业务组件 | 目录 `components/<feature-kebab>/`，主文件 `<feature-kebab>.vue` |
| **新建**路由页面 | 目录 `views/<page-kebab>/`，入口 **`index.vue`**；同目录附属文件亦 kebab-case |
| 组件 / 页面私有 TS | 与对应 SFC **同目录**，不堆在 `components` / `views` 根下 |
| **新建**任意单测 | `src/__test__/…`，目录镜像 `src/`（`components/`、`views/`、`stores/` 等）；见 [vue3.md](vue3.md) §3.3 |
| 遗留 `PascalCase.vue` | 允许存在；新功能优先 kebab 目录，不强制批量迁移 |

SFC 块顺序：`template` → `script` → `style`（Vue 2 / Vue 3 相同，见各栈文档）。

### 代码

- 变量、函数：**camelCase**
- 类、组件、实体：**PascalCase**
- 常量：**UPPER_SNAKE_CASE**

### API 与数据库

- JSON 字段：**camelCase**
- 表名、列名：**snake_case**
- Entity：类 PascalCase，属性 camelCase，列映射 snake_case

## 2. Import 顺序

TypeScript 文件分组，组间空一行：

1. 类型导入
2. Node / 浏览器内置
3. 第三方库
4. 项目别名 / 跨包
5. 相对路径
6. 样式

## 3. 注释

- 中文；写**业务原因**或**规格出处**，不复述代码字面意思。
- 关键公式、过滤规则标明文档与章节。

```typescript
/**
 * 完成率 = 已填行数 / 有效行数。
 * 见 docs/superpowers/specs/<规格名> §5。
 */
```

## 4. 文档与文案

- 文档、注释、提交信息、界面文案默认**中文**；API 机器可读 `code` 用英文。
- 业务行为以仓库规格为准：**优先 `docs/SDD/规格文档/`**（配套 `实施计划/`）；本 skill 只链接，不复制规格全文。见 [sdd.md](sdd.md)。
- 验收样本放 `docs/原材料/` 等非运行时目录，与生产数据源分离。

## 5. Git 提交

仓库根目录约定（如 `AGENTS.md`）优先于本节。本仓库已有更细约定：日常只在 `dev` 提交，发版时用 `git merge --no-ff dev` 把 `dev` 合并进 `main`，不要改成下面的快进发版。下面的快进步骤只用于没有这类约定的仓库。不使用 release 分支。没有 `dev` 时不要擅自新建。

### 提交信息

```text
<type>(<scope>): <subject>
```

| type | 含义 |
|------|------|
| feat | 新功能 |
| fix | 修复 |
| docs | 文档 |
| refactor | 重构 |
| style | 格式/样式 |
| test | 测试 |
| chore | 工具/依赖/配置 |

`subject` 用中文一句话，写清「为什么」。例如：`feat(import): 解析清单并切换当前批次`。

- 一次提交只做一件事；先提交被依赖层（实体、服务），再页面。
- 只 `git add` 本次相关文件，避免 `git add -A` 混入无关修改。

### 分支

只保留一条开发线。`main` 是已上线位置，用 tag 标记版本，不靠来回合并制造发版提交。

**只有 `main`：** 所有开发都在 `main`。可以上线时，在当前提交打 tag，不另开分支。

**有 `dev`：** 日常只在 `dev` 上提交。`main` 永远是 `dev` 历史上的某个提交，只在用户明确发版、且 `dev` 顶端就是要上线的内容时，把 `main` 快进到该提交：

```bash
git switch main
git merge --ff-only origin/main
git merge --ff-only dev
```

快进不会产生新的合并提交，所以不用再把 `main` 合回 `dev`。发版边界看 tag，不看合并提交。

不能快进，说明有人在 `main` 上写过 `dev` 没有的提交。这时只做一次：把 `origin/main` 合并进 `dev`，冲突在本地解决，之后 `main` 继续只靠快进前移。

未完成的改动不要留在 `dev` 顶端，否则快进会把它们一起带上线。需要修已上线版本、但 `dev` 上已有不能上线的提交时，从当前 `main` 拉一个短修复分支，修完后快进 `main` 并打 tag，再把这个修复合并回 `dev` 一次，然后删掉该分支。这不是长期 release 分支。

共享的 `dev` / `main` 不要 rebase、不要 force push。同一改动不要 cherry-pick 成两份。

### 提交前同步

先确认当前就在开发线（只有 `main` 时是 `main`，有 `dev` 时是 `dev`）。未提交改动会被覆盖时，先收拾干净再同步。

```bash
git fetch origin
git merge --ff-only origin/<开发线>
```

不能快进说明本地和远端分叉：`git merge origin/<开发线>`，冲突在本地解决。确认文件里没有 `<<<<<<<`、`=======`、`>>>>>>>`，跑相关检查或测试，再写本次提交。

有 `dev` 时，只有 `git merge-base --is-ancestor origin/main HEAD` 失败才先把 `origin/main` 合并进 `dev`。正常情况下它应当一直成功，不必每次提交都合并 `main`。

推送只在明确要求时进行。远端拒绝时重新 fetch 并对齐，不要 force push。

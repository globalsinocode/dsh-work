# Element UI 2（Vue 2）

与 [vue2.md](vue2.md) 叠加使用。栈为 **Element Plus / Vue 3** 时不要读本文件，改用 Vue 3 项目约定。

## 1. 版本与引入

- 包名 `element-ui`（2.x），全局或按需引入须经过 babel 转译（列入 `transpileDependencies`）。
- 主题：SCSS 变量在**构建期**展开为固定色值，避免 IE11 依赖 CSS 变量做主色。

## 2. 布局与 IE11

- 页面骨架优先 `el-container` / `el-row` / `el-col` 或表格布局；避免 Grid/Flex 复杂嵌套作为唯一布局手段。
- 长列表、明细：**`el-table`** + 纵向滚动；列宽考虑 IE11 下 `min-width` 表现。
- 弹层：`el-dialog` 注意 `append-to-body` 与 z-index；全屏操作在 IE11 实测。

## 3. 表单

- `el-form` + `el-form-item` + `rules`；校验规则放 `rules` 对象，提交前 `validate`。
- 重置用 `resetFields`；异步校验注意在 `validate` 回调里处理，勿在未校验时提交。
- 日期：IE11 下优先用 Element 日期组件，不依赖原生 `input[type=date]` 一致性。

## 4. 反馈

- 操作结果：`Message` / `MessageBox`；批量错误用 `Notification` 时可附简要列表。
- 加载态：表格 `v-loading`、按钮 `:loading`；避免无反馈的长时间等待。

## 5. 与后端错误对齐

- 接口返回 `{ message, code }` 时，用 `message` 做 `Message.error` 文案；`code` 仅用于分支逻辑，不直接展示给用户。

## 6. 禁止

- Element Plus 组件名、API（如 `el-config-provider` 新用法）。
- 从 Vue3 + Element Plus 项目复制组件未改标签与 API。

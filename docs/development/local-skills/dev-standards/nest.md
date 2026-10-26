# 后端规范 — NestJS + TypeORM + PostgreSQL

模块划分、实体字段、接口清单见项目 `docs/项目-业务约定.md` 与 `docs/superpowers/specs/`。

## 1. 目录

```text
server/
├── src/
│   ├── app.module.ts
│   ├── main.ts              # 全局前缀 /api、管道、过滤器、端口
│   ├── common/
│   ├── config/
│   ├── database/
│   └── modules/<领域>/      # controller / service / entity
├── .env.example
└── package.json
```

## 2. 模块

- 一领域一 Module；controller / service / repository 内聚。
- 模块间通过 **service** 调用；**禁止**跨模块直接 inject 其它模块的 repository。
- 对外 HTTP + 必要 service；内部实现不泄漏。

## 3. TypeORM

- Entity PascalCase；属性 camelCase；列 snake_case。
- 库内时刻：`timestamptz`；对外 JSON 时刻统一为**毫秒时间戳 `number`**（若项目有 `toApiMs` 等工具，一律经其转换）。
- Excel/导入原文类「日期格」可按 `date` / `varchar` 存展示原文，不强行时间戳化。
- 表建议有 `created_at`；业务起止可用 `started_at` / `finished_at`。
- 开发可用 `synchronize`；**生产**变更必须 migration。
- 密码只存哈希（bcrypt 或团队统一方案），禁止明文。

## 4. HTTP API

- 前缀 `/api`，JSON，UTF-8。
- 全局 `ValidationPipe({ whitelist: true, transform: true })`。

错误体：

```json
{
  "message": "人类可读的中文错误",
  "code": "MACHINE_READABLE_CODE"
}
```

| code | HTTP |
|------|------|
| VALIDATION_FAILED | 400 |
| UNAUTHORIZED | 401 |
| FORBIDDEN | 403 |
| NOT_FOUND | 404 |
| INTERNAL_ERROR | 500 |

领域错误码在项目业务约定中补充。

## 5. 定时任务

- `@nestjs/schedule` 或等价方案。
- 依赖最新外部数据时，先走与导入相同的读取逻辑；读取失败则本轮不基于新数据执行。
- 通知类任务须有**去重键**；日历顺延等规则可配置，不硬编码。

## 6. 配置与安全

- 密钥、连接串仅环境变量；`.env.example` 无真实值；`.env` 不入库。
- 日志禁止密码；持久化失败原因前对错误信息脱敏（如密码 → `***`）。

## 7. 批量导入模式

读外部文件 → 解析 → 入库：

- 表头/格式错：**整批失败**，不写部分数据，不切换当前生效数据。
- 成功：**单事务**写批次 + 全部有效行，再切换「当前生效」；失败回滚。
- 外部未变（如修改时间相同）可跳过解析。
- 不预存可重算的聚合；需要时从明细计算。
- 外部资源失败按固定策略重试；仍失败则保留原生效数据并记失败记录（无密码）。

项目参数（重试次数、字段映射）见规格与业务约定。

## 8. 测试

```bash
cd server && npm test
```

建议：解析 fixture、格式失败不切换生效数据、事务回滚、聚合与手算一致、通知去重。集成测试可 mock 文件系统，CI 不依赖真实共享盘。

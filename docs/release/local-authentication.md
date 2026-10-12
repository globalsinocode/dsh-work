# 独立账号登录

独立账号模式使用 dsh-work 自己的账号密码认证，可通过运营平台保存模式；首次部署的默认模式为 `DSH_WORK_AUTH_MODE=local`。该模式不需要 AI Hub 配置、网络连接、OIDC Token、员工目录同步或上游 Bootstrap。员工端和管理端共用账号，分别签发 Session Cookie；访问资格仍来自既有本地角色、数据范围和用户状态。

账号仅由平台管理员创建，不开放自助注册。`oidc` 模式保持原行为；两种模式需显式切换，身份服务故障不会触发自动降级。Agent 执行继续使用既有 Run/Attempt、Runtime Adapter 与 DSH。

## 启用步骤

1. 备份目标数据库，安排一次身份切换维护窗口。不要把测试数据库用作业务库。
2. 在目标环境文件配置以下字段。独立模式不读取 `AI_HUB_*` 字段。已有环境只修改相关字段，不覆盖 Runtime、存储或其他凭据。

```dotenv
DSH_WORK_AUTH_MODE=local
DSH_WORK_DATABASE_URL=postgres://<user>:<password>@<host>:<port>/<database>
DSH_WORK_SESSION_SECRET=<至少32字符的独立随机值>
DSH_WORK_WORKBENCH_ORIGINS=http://localhost:4174
DSH_WORK_ADMIN_ORIGINS=http://localhost:4180
DSH_WORK_COOKIE_SECURE=false
```

生产必须使用 HTTPS 入口、`NODE_ENV=production` 与 `DSH_WORK_COOKIE_SECURE=true`。用 `openssl rand -base64 48` 生成 Session Secret。多个入口以逗号分隔，使用 `DSH_WORK_WORKBENCH_DEFAULT_ORIGIN` / `DSH_WORK_ADMIN_DEFAULT_ORIGIN` 指定列表中的默认入口。反向代理应覆盖客户端的 Host / 协议转发头，业务服务只能由受信代理访问；沿用部署预检的本机监听约束。

3. 初始化第一位独立管理员。开发 checkout 在根目录运行：

```bash
pnpm --filter @dsh-work/server auth:bootstrap
```

命令读取根目录 `.env`，执行迁移后交互询问账号、姓名和密码，密码输入不回显。新安装的“绑定既有员工 ID”留空；迁移时可输入已核对的有效业务员工 ID，从而保留原用户。没有默认账号或默认密码，也没有公开的 HTTP 初始化入口。

发布包在已加载目标 `runtime.env` 的受控运维终端中执行：

```bash
node server/dist/modules/identity/local-bootstrap.js
```

自动化初始化可通过标准输入提供 JSON，字段为 `username`、`name`、`password` 及可选 `existingUserId`。从受控 Secret 注入标准输入，不将密码写入命令行参数、日志或 Git。

初始化账本在数据库中只消费一次。重启、停用或撤去管理员角色都不会重新开放初始化；重复命令拒绝执行，也不会重置已有密码。恢复丢失的全部管理员访问须按受控数据库运维流程处理，不能删除账本再初始化。

4. 重启应用并访问管理端。登录后在“员工与权限”创建账号、分配角色和数据范围；初始密码通过安全渠道交付。建议配置第二位有效本地平台管理员。
5. 使用员工账号登录员工端，首次登录会先要求修改初始密码。管理员重置密码后同样要求修改；密码变化会撤销两个门户的全部旧 Session。

## 既有 AI Hub 用户迁移

不从 AI Hub 导出或猜测密码，也不按姓名或邮箱自动合并用户。迁移按明确的用户 ID 绑定：

- 首位管理员可用初始化命令的 `existingUserId` 绑定原有有效业务员工。
- 其他已同步员工在独立模式“员工与权限”中可见。打开其“配置”，确认姓名和用户 ID 后选择“开通独立登录”。
- 绑定只增加该用户的本地凭据，保留 `users.id`、原始外部身份标记、角色、数据范围、业务会话、文件、Agent 和审计关联；绑定时撤销旧登录会话。停用员工不能直接绑定。
- `identity_provider` 记录身份来源，是否具有独立登录凭据以 `local_user_credentials` 为准。在 local 模式下，停用和启用由本项目管理，不启动目录同步。
- 模式有独立 Cookie 名和 Session 提供方校验。OIDC Cookie 不能用于独立模式，独立 Cookie 不能用于 OIDC；切换后需重新登录。切回 OIDC 时，只有原来已接入 AI Hub 的身份可以使用统一登录；本地新建员工不会自动成为上游员工。

## 运营平台配置登录模式

入口为 **平台设置 → 登录设置**（`/login-settings`），作为平台级独立页面统一管理员工端与管理端的登录方式。具有 `admin:*` 的平台管理员可以选择“独立账号密码”或“AI Hub 统一登录”；具有管理读取权限的账号只能查看。开发用 `prototype` 不提供此设置，也不能作为可保存的模式。

1. 查看“当前生效”“已保存”及目标模式的前置条件。保存独立模式要求至少有一位有效、具有独立凭据且拥有永久本地平台管理员授权的业务用户；首次从 AI Hub 切换时，先按初始化步骤绑定管理员的现有用户 ID。保存 AI Hub 模式要求部署环境具备完整 OIDC 配置，且至少一位有效的 AI Hub 用户具有永久本地平台管理员授权。
2. 选择模式并确认保存。设置写入现有 PostgreSQL `system_settings` 的 `identity.login` 项，并记录操作人和审计。保存不重启应用，不立即改变当前登录；显示“重启后生效”。多个管理员同时修改时，旧修订会被拒绝，须刷新后重新确认。
3. 按部署运维流程安排应用重启。启动时再次检查目标模式的配置及管理员条件，实际切换时撤销两个门户的旧登录会话和未完成的 OIDC 登录事务；所有用户重新登录。若条件已失效，启动明确报错，不自动降级。
4. 重启前若要取消，选择“当前生效”的模式并保存。取消后显示“已生效”，既有会话继续有效。

已保存的模式优先于 `DSH_WORK_AUTH_MODE` 的部署默认值；没有保存设置时仍按环境变量启动。升级部署预检读取已有数据库的配置但不激活切换；首次部署在迁移后的应用启动阶段检查。上游密钥、Session Secret、入口地址和 TLS 仍由部署环境维护，页面不返回密钥。“配置与管理员条件已具备”只代表本地配置和授权检查通过，不代表真实 AI Hub 可达或已完成登录验收。

恢复时应优先在重启前取消待生效切换；若重启因条件失效而失败，运维须恢复缺失配置或管理员资格。紧急撤销数据库选择时，先备份数据库并停止应用，由数据库管理员删除当前租户的 `system_settings` 中 `identity.login` 项，再以已核实可登录的部署默认模式启动。该操作不会恢复被撤销的会话。不要仅修改环境变量并误以为已覆盖平台保存的选择。

## 安全与运维行为

- 账号大小写不敏感，长度 3–80，字符为字母、数字和 `._@-`；密码 15–128 字符，不去除空格，不要求任意字符组合。
- 密码使用 Node.js 异步 scrypt、随机盐、固定 `N=131072, r=8, p=1` 和恒定时间比较。参数依据 [OWASP 密码存储指南](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)，实现使用 [Node.js crypto](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)。数据库和审计不保存明文密码。
- 登录和改密有持久化的 15 分钟尝试窗口；同账号 10 次、连接来源 100 次，返回 429 后等待窗口结束。来源取连接地址，不信任任意 `X-Forwarded-For`。同一反向代理后的请求共享来源额度；较大部署需在受信代理增加限流，并按容量评估调整此固定额度。密码派生并发最多 2 个，忙时返回 429，不积压无限队列。
- Cookie 为不透明随机值，数据库只存摘要；HttpOnly、SameSite=Lax，生产使用 Secure 与 `__Host-`。登录、改密、退出和管理写请求均校验同源。Session 默认 8 小时，可用 `DSH_WORK_SESSION_TTL_SECONDS` 调整。
- 每次 API 请求重新读取当前账号状态及本地授权。停用、密码变更和会话撤销立即阻止旧 Session；撤权不等待会话自然到期。
- 最后一位有效且已开通独立登录的平台管理员不能被停用或撤去平台管理员角色。原型种子账号和未绑定的上游管理员不计入独立模式的兜底管理员。
- 本期忘记密码由另一位平台管理员重置，不包含邮箱找回、短信或 MFA。

## 接口和验证

认证接口见 [认证 OpenAPI](../development/openapi-auth.json)，账号管理见 [Admin OpenAPI](../development/openapi-admin.json)。数据库迁移为 `0077_local_identity.sql`，新增凭据、初始化账本、限流表以及既有 Session 的提供方字段，不删除或重建已有身份。

```bash
pnpm test:local-auth
pnpm test:local-auth:integration
pnpm test:e2e:local-auth
pnpm test:e2e:login-mode
pnpm test:sso
pnpm test:sso:integration
```

集成和浏览器测试使用 `DSH_WORK_TEST_DATABASE_URL` 创建并自动删除独立测试库。独立账号浏览器夹具运行真实应用和独立密码认证，显式移除 AI Hub 配置并使 DSH 不可用；登录设置夹具另外提供不可达的合成 OIDC 配置及测试管理员，验证保存、取消、修订冲突和只读权限，不调用真实 AI Hub。后端集成测试验证启动激活、前置条件复查及旧会话撤销。均不执行真实 Agent 或模型。

生产切换须另行确认 TLS、代理、Secret 保存、备份恢复、真实员工密码交付、旧用户 ID 绑定、账号停用和管理员恢复流程。代码与本地测试通过不表示已经切换、发布或完成生产验收。

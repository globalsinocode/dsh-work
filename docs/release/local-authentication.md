# 独立账号登录

正式部署始终提供 dsh-work 自己的账号密码认证，不依赖 AI Hub。AI Hub 接入配置有效时自动提供第二个登录入口；没有管理端登录模式选择。员工端与管理端共用独立账号，分别签发 Session Cookie，访问资格来自既有本地角色、数据范围和用户状态。

账号仅由平台管理员创建，不开放自助注册。两端默认展示账号密码；AI Hub 配置有效时显示“使用 AI Hub 账号登录”，点击直接发起企业认证。未配置或配置无效时隐藏该入口，配置错误记录于启动日志；上游运行故障返回账号密码页说明原因，不自动切换身份。Agent 执行继续使用既有 Run/Attempt、Runtime Adapter 与 DSH。

## 初始化与部署

1. 备份目标数据库。配置以下基础字段；已有环境只修改相关字段，不覆盖 Runtime、存储或其他凭据。若仍有已移除的 `DSH_WORK_AUTH_MODE=prototype`，必须删除，否则服务拒绝启动。

```dotenv
DSH_WORK_DATABASE_URL=postgres://<user>:<password>@<host>:<port>/<database>
DSH_WORK_SESSION_SECRET=<至少32字符的独立随机值>
DSH_WORK_WORKBENCH_ORIGINS=http://localhost:4174
DSH_WORK_ADMIN_ORIGINS=http://localhost:4180
DSH_WORK_COOKIE_SECURE=false
```

生产必须使用 HTTPS、`NODE_ENV=production` 与 `DSH_WORK_COOKIE_SECURE=true`。用 `openssl rand -base64 48` 生成 Session Secret。多个可信入口以逗号分隔，通过 `DSH_WORK_WORKBENCH_DEFAULT_ORIGIN` / `DSH_WORK_ADMIN_DEFAULT_ORIGIN` 指定默认入口。反向代理覆盖客户端转发头，沿用部署预检的本机监听约束。

2. 在开发 checkout 根目录运行 `pnpm --filter @dsh-work/server auth:bootstrap` 初始化第一位独立管理员。命令读取 `.env`，执行迁移后询问账号、姓名和密码，密码输入不回显。发布包则在加载 `runtime.env` 的受控终端执行 `node server/dist/modules/identity/local-bootstrap.js`。

自动化初始化通过标准输入提供 `username`、`name`、`password` JSON，不提供 `existingUserId`。没有默认密码或公开 HTTP 初始化入口。命令创建全新的独立管理员，不绑定任何已有 AI Hub 用户；初始化账本只消费一次，不能用于恢复已丢失的管理员权限。

3. 启动应用，管理员在“员工与权限”创建独立账号并分别配置角色、数据范围。初始密码经安全渠道交付，员工首次登录及管理员重置后必须改密。建议保留第二位独立平台管理员。
4. 需要 AI Hub 时，按 [AI Hub 接入指南](ai-hub-sso-integration.md) 配置地址、应用凭据及回调后重启。运行时选择哪种方式登录无需重启，也不需要另一类账号已有管理员才能显示入口。

## 账号来源与隔离

员工授权列表的“来源”列区分“独立账号”和“AI Hub”。同名或同邮箱不合并；两种账号拥有不同用户 ID，角色、个人数据和审计分别归属。AI Hub 用户不提供开通独立登录、密码重置或本地启停操作，账号状态由上游管理；本地新建账号不会自动成为 AI Hub 用户。

两提供方使用不同 Cookie 和 Session 校验；当前门户同时出现两种 Cookie 时要求重新登录，过期身份不跨提供方重试。成功登录后清理当前门户另一种旧登录会话，不搬迁数据或权限。

## 旧配置兼容

旧 `DSH_WORK_AUTH_MODE=local/oidc` 仅兼容，不再控制启用哪一种登录；正式部署默认加载独立认证，并按 AI Hub 配置决定额外能力。原 `prototype` 模式已移除。

旧 `system_settings` 中的 `identity.login` 记录保留但不再读取，不影响启动，也不会因旧待生效选择撤销会话。旧登录设置页面及读写 API、用户绑定 API 均已移除。历史身份、授权和业务数据不删除、不迁移；如果已有 AI Hub 用户关联本地凭据，这些旧凭据保留但不再用于密码登录、改密或重置，AI Hub 用户继续使用上游身份。

## 安全与运维行为

- 新建登录账号仅接受中国大陆 11 位手机号（可带 `+86`）或邮箱（最长 254 字符）；手机号统一去掉 `+86`，邮箱忽略大小写。创建时检查独立账号和已同步 AI Hub 的登录账号，已停用账号仍占用账号名，不以资料中的联系邮箱匹配或合并身份；已有用户名仍可登录。新设置的密码为 8–64 个字符，不去除空格，不要求任意字符组合。初始化管理员、新建账号、重置和改密统一校验；已有长密码仍可登录和验证当前密码，改密时使用新规则。
- 密码使用 Node.js 异步 scrypt、随机盐、固定 `N=131072, r=8, p=1` 和恒定时间比较。参数依据 [OWASP 密码存储指南](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)，实现使用 [Node.js crypto](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)。数据库和审计不保存明文密码。
- 登录和改密按账号限流：持久化的 15 分钟窗口内同一账号最多 10 次尝试，超出返回 429 并等待窗口结束；登录或改密成功后清零该账号窗口，因此只有连续失败才会锁定。不按连接来源限流：反向代理后所有请求共享同一来源地址，按来源计数会变成全公司共用的额度。需要按真实客户端 IP 限流时，在受信反向代理（nginx）层配置。密码派生（scrypt，每次约 128 MiB 内存）在数据库事务外执行，不持有行锁；并发上限默认 min(4, CPU 核数) 且至少 2，可用 `DSH_WORK_PASSWORD_HASH_CONCURRENCY`（1–16）按内存调整；超出并发的请求在最多 64 个的有界队列中等待，队列满时返回 429 `login_busy`。
- Cookie 为不透明随机值，数据库只存摘要；HttpOnly、SameSite=Lax，生产使用 Secure 与 `__Host-`。登录、改密、退出和管理写请求均校验同源。Session 默认 8 小时，可用 `DSH_WORK_SESSION_TTL_SECONDS` 调整。
- 同一账号可在多个设备/入口并行登录（例如桌面工作台与移动端 H5）：会话按 `session_hash` 独立存储，新登录不再吊销其他设备的活动会话，退出只结束当前会话。需要一次结束该账号全部会话时，由管理端撤销会话、改密、重置密码或停用账号触发。
- 首次登录（含管理员重置后）完成改密后，员工端和管理端均直接返回原访问页面，无需再次登录。改密与会话轮换在同一事务内完成：撤销所有旧会话，只为当前门户签发新会话；失败时不签发会话、不跳转。
- 每次 API 请求重新读取当前账号状态及本地授权。停用、密码变更和会话撤销立即阻止旧 Session；撤权不等待会话自然到期。
- 最后一位有效且已开通独立登录的平台管理员不能被停用或撤去平台管理员角色。种子账号和 AI Hub 管理员不计入独立账号的兜底管理员。
- 本期忘记密码由另一位平台管理员重置，不包含邮箱找回、短信或 MFA。

## 接口和验证

接口见 [认证 OpenAPI](../development/openapi-auth.json) 和 [Admin OpenAPI](../development/openapi-admin.json)。独立认证沿用 `0077_local_identity.sql` 的凭据、初始化账本、限流表和会话提供方字段，`0078_local_login_accounts.sql` 扩展账号字段约束以支持邮箱与手机号，保留已有用户名、身份和授权。

```bash
pnpm test:local-auth
pnpm test:local-auth:integration
pnpm test:e2e:local-auth
pnpm test:e2e:login-options
pnpm test:sso
pnpm test:sso:integration
```

数据库与浏览器集成测试使用专用可丢弃测试库、合成账号及受控或不可达 OIDC 配置，验证默认能力、旧配置不生效、账号隔离、来源展示和绑定入口移除；不执行真实 Agent 或模型。真实 AI Hub、生产 TLS、代理、凭据交付和部署恢复仍须另行验收。

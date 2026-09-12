# DSH Runtime 交付基线

更新时间：2026-09-08

## 1. 固定版本与兼容结论

dsh-work 只支持下表两个经过精确锁定的 DSH Runtime，不接受宽泛的 `0.1.x` 版本范围：

| 使用范围 | Version | Commit | Adapter |
| --- | --- | --- | --- |
| Mac mini 生产默认 | `0.1.2-rc.1` | `76fda729799fe9b3848dbe2c211d4b231032b81e` | `official-acp-profile` |
| 本地开发显式兼容 | `0.1.1-rc.2` | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | `legacy-acp-demo` |

两者都使用 ACP protocol version 1。一次服务进程只选择一个 Runtime；“双版本支持”表示同一份
dsh-work 代码可在不同环境选择其中之一，并不表示同时运行两个 DSH。上游没有名为 `0.1.0`
的稳定版本，本地兼容目标是已经核验的 `0.1.1-rc.2`。

该版本不是对旧 `0.1.1-rc.2` 启动入口的就地替换：上游已经删除
`packages/examples/acp-demo` 和 `examples/acp-agent/cordis.yml`，并以正式
`dsh --profile acp` 入口替代。dsh-work 因此通过源码 checkout 执行：

```bash
node --import tsx/esm apps/cli/src/bin.ts \
  --profile acp \
  --patch /absolute/path/to/generated-dsh-work-overlay.yml
```

`--patch` 在上游 `base + acp-app` profile 之后应用 dsh-work 的模型、系统提示词、
Session 持久化目录和 Tool Policy。依据见固定 Commit 的
[CLI 文档](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/apps/cli/README.zh.md)、
[CLI 行为参考](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/apps/cli/reference/README.zh.md)
和 [ACP profile 文档](https://github.com/deepseek-ai/deepseek-harness/blob/76fda729799fe9b3848dbe2c211d4b231032b81e/packages/bundle/acp-app/README.zh.md)。

本地旧版没有正式 `acp` profile，只有显式选择兼容模式时才使用：

```bash
node --import tsx packages/examples/acp-demo/src/bin.ts \
  --config /absolute/path/to/generated-legacy-overlay.yml
```

旧版 Overlay 包含固定 Commit 中的 `examples/acp-agent/cordis.yml`，再应用同一套模型、
Session 持久化和 Tool Policy 约束。不得根据目录是否存在自动猜测 Adapter。

dsh-work 不复制或 Fork DSH 源码，也不直接依赖 DSH 内部模块。DSH checkout、
`DSH_HOME` 和 dsh-work 发布目录必须彼此独立。

## 2. Mac mini 安装与核验

当前服务器访问基线为 `deploy@192.168.33.20`。推荐目录是：

```text
DSH_RUNTIME_HOME=/Users/deploy/services/deepseek-harness
DSH_HOME=/Users/deploy/.dsh
```

部署前在实际 checkout 中独立核验 Version 和 Commit：

```bash
ssh deploy@192.168.33.20

DSH_RUNTIME_HOME='/Users/deploy/services/deepseek-harness'
test "$(git -C "${DSH_RUNTIME_HOME}" rev-parse HEAD)" = \
  '76fda729799fe9b3848dbe2c211d4b231032b81e'
test "$(node -p 'require(process.argv[1]).version' "${DSH_RUNTIME_HOME}/package.json")" = \
  '0.1.2-rc.1'
test -r "${DSH_RUNTIME_HOME}/apps/cli/src/bin.ts"
test -r "${DSH_RUNTIME_HOME}/apps/cli/lib/bin.js"
test -r "${DSH_RUNTIME_HOME}/packages/bundle/acp-app/cordis.patch.yml"
test -d "${DSH_RUNTIME_HOME}/node_modules/tsx"
test -z "$(git -C "${DSH_RUNTIME_HOME}" status --porcelain --untracked-files=no)"
```

只有 Version/Commit 正确而依赖或构建产物缺失，仍不能部署。若实际目录与推荐值不同，
保留现有安装并把真实绝对路径写入 `runtime.env`，不要为了匹配文档移动运行中的 DSH。

若需要重新安装，使用新的独立目录，不在生产 checkout 上执行 `git pull`：

```bash
cd /Users/deploy/services
git clone https://github.com/deepseek-ai/deepseek-harness.git deepseek-harness-0.1.2-rc.1
cd deepseek-harness-0.1.2-rc.1
git checkout --detach 76fda729799fe9b3848dbe2c211d4b231032b81e
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number)
  if (!((major === 22 && minor >= 19) || major >= 24)) process.exit(1)
  console.log(`Node ${process.versions.node}`)
'
pnpm install --frozen-lockfile
pnpm run build
```

`node`、`pnpm install` 和 `pnpm run build` 必须在同一个已设置 `PATH` 的 Shell 中执行。
DSH `0.1.2-rc.1` 的引擎要求是 Node `22.19+` 或 `24+`；不能用旧 Node 的退出状态推断
构建已完成，最终仍要由部署预检实际创建临时 ACP Session。

构建和真实回归通过后，再在维护窗口把 `DSH_RUNTIME_HOME` 切换到新目录。旧 checkout
保留到应用和数据回归通过，以便恢复；不能把两个版本混在同一工作树中。

## 3. dsh-work 运行配置

生产 `runtime.env` 必须固定：

```bash
DSH_RUNTIME_HOME=/Users/deploy/services/deepseek-harness
DSH_EXPECTED_VERSION=0.1.2-rc.1
DSH_EXPECTED_COMMIT=76fda729799fe9b3848dbe2c211d4b231032b81e
# DSH_RUNTIME_COMPATIBILITY 必须保持未设置
DSH_HOME=/Users/deploy/.dsh
```

服务端同时读取 Release 内的 `server/config/dsh/runtime-lock.json`、上游
`package.json` 和 Git HEAD。环境值、Release Lock、已安装 Version 或 Commit 任一不一致，
服务端和部署预检都会失败关闭，不能通过修改 `runtime.env` 绕过 Release Lock。
生产部署预检会明确拒绝 `DSH_RUNTIME_COMPATIBILITY`。

本地现有 checkout 使用以下显式配置：

```bash
DSH_RUNTIME_HOME=/Users/max/projects/deepseek-harness
DSH_RUNTIME_COMPATIBILITY=legacy-0.1.1-rc.2
DSH_EXPECTED_VERSION=0.1.1-rc.2
DSH_EXPECTED_COMMIT=b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
```

兼容模式只在非生产环境有效；未知模式、遗漏模式、Version 或 Commit 不匹配都会拒绝启动。

正式 ACP profile 首次启动时会在 `$DSH_HOME/profiles/acp` 初始化随附模板。模型凭据由
DSH 的 settings/credentials provider 从独立 `DSH_HOME` 解析；密钥正文不得写入
dsh-work 的环境文件、数据库、日志或 Release。

`server/config/dsh/acp-managed-credentials.cordis.yml` 是最后应用的受信任 Overlay：

- 保留上游正式 `acp-app` bridge 和 ACP v1；
- 模型路由固定为 `deepseek-official / deepseek-v4-pro`；
- 每个 Attempt 的系统提示词由 dsh-work 显式注入；
- Session JSONL 写入 dsh-work 的受控数据目录；
- dsh-work Tool Policy 在执行前强制 Manifest Allowlist、工作区边界和审批关联。

本地旧版使用独立的 `acp-managed-credentials.legacy.cordis.yml`，避免把两代配置结构混在
同一个文件中。两个 Overlay 都不保存模型密钥。

## 4. 启动和部署预检

`scripts/deploy/preflight.sh` 在切换应用版本前验证：

1. 未启用任何开发兼容模式，DSH checkout 的 Version、Commit 与生产主 Lock 完全相同；
2. `apps/cli/src/bin.ts`、`apps/cli/lib/bin.js`、`acp-app` bundle、`tsx` 依赖存在；
3. DSH tracked files 没有本地修改；
4. 生成的 Overlay 只写入 dsh-work 数据目录，Tool Policy 使用已验证的绝对路径；
5. 启动短生命周期的 `dsh --profile acp --patch ...`，在 30 秒内完成 ACP
   `initialize` 和临时 `session/new`，随后正常关闭并删除临时目录。

预检只在临时目录创建一次可丢弃 Session，不发送 Prompt，也不产生模型调用。它证明入口、
协议、settings/credentials provider 和 Session 持久化组合能够启动，但不证明模型凭据有效，
也不证明真实模型、Tool、取消、并发或产物链路已通过。

本地服务启动也会对选中的旧版 Adapter 执行同样的 `initialize + session/new` 检查，但不会
放宽生产部署脚本。每次切换版本后都应重新运行该检查。

## 5. 升级验收与回滚

切换 Runtime 版本后，旧版测试结果不能替代新版本验收。
至少执行：

```bash
pnpm test:m1
pnpm typecheck

DSH_RUNTIME_HOME=/Users/deploy/services/deepseek-harness pnpm probe:handshake
DSH_RUNTIME_HOME=/Users/deploy/services/deepseek-harness pnpm probe:model
DSH_RUNTIME_HOME=/Users/deploy/services/deepseek-harness pnpm probe:tool
DSH_RUNTIME_HOME=/Users/deploy/services/deepseek-harness pnpm probe:artifact
DSH_RUNTIME_HOME=/Users/deploy/services/deepseek-harness pnpm probe:cancel
DSH_RUNTIME_HOME=/Users/deploy/services/deepseek-harness pnpm probe:concurrency
```

以上命令统一调用 `scripts/runtime/probe.ts`；`pnpm probe --help` 可查看入口。`handshake` 只做握手、建会话与取消，不调用模型；其余模式会调用模型，应在受控测试数据和预算下执行。每次探针退出时关闭 Worker 并清理临时工作区与 Session Log，JSON 输出保留验证摘要。通过后还要按
[Mac mini 部署流程](mac-mini-deployment-runbook.md)完成登录、实际任务、备份与重启验收。

应用 Release 的回滚不会自动降级 DSH。生产环境不能把本地兼容模式当成回滚开关；若要恢复
旧生产 DSH，必须选择生产主 Lock 与其匹配的旧 dsh-work Release，并在维护窗口恢复对应
checkout。

## 6. npm 与内部制品边界

上游也发布 `@deepseek-ai/dsh` npm 包，但当前生产方案仍是固定 Commit 的独立源码 checkout。
代码中 `DSH_RUNTIME_COMMAND` 和 `dsh-runtime.json` 是 dsh-work 为未来内部制品保留的自定义
契约，不是 DSH 上游的“受管制品模式”。在建立精确依赖锁、完整性校验、构建来源、SBOM、
安装、升级、回滚及无源码验证前，不得启用或把它表述为已经生产就绪。

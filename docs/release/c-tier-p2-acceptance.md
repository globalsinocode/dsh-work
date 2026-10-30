# C 档 P2 验收清单（Mac mini）

本文是[执行隔离方案第 9 节](../design/execution-isolation-plan.md#9-验证)“P2 真实验收”的操作清单，配合脚本 [`scripts/acceptance/c-tier-p2.mjs`](../../scripts/acceptance/c-tier-p2.mjs) 使用。脚本只经员工端公开接口驱动真实 DSH，不读写数据库、不代办 AI Hub 登录；它给出自动核对结果与证据文件，结论由验收人复核后填写。本文不代表已经在 Mac mini 上执行或验收。

本机预演（本地认证、本机 Docker、开发库）只能发现脚本与环境问题，不能代替本清单在 Mac mini 上的执行（AGENTS.md：不得用预演或 Mock 的绿灯宣称真实链路通过）。

## 1. 前提

- 目标 Release 已按[部署手册](mac-mini-deployment-runbook.md)部署，9.1、9.2 已通过，DSH 模型凭据可用。
- 执行镜像已按摘要拉取到 Mac mini（部署手册第 7 节 `DSH_WORK_EXECUTION_IMAGE` 一行），与 `runtime.env` 中的引用一致。
- 执行容器为必需（[执行隔离方案](../design/execution-isolation-plan.md) 4.9）：`runtime.env` 只需 `DSH_WORK_EXECUTION_IMAGE`，所有已发布 Agent 的员工侧运行都装配 `bash`。已不存在 `DSH_WORK_EXECUTION_CONTAINER` 开关，验收不通过时的回退方式是部署上一个 Release（按[部署手册](mac-mini-deployment-runbook.md)回滚）。2026-10-28 的 P2（v2026.10.28-01）仍在有开关的版本上执行。
- 准备一个测试员工账号，只有 `employee` 角色，可使用平台默认 Agent；对话内容不含敏感信息。
- 可选：一个已发布、含 Python 入口（`scripts/*.py`）且已授权给该 Agent 的 Skill，用于 `python-skill` 场景。

## 2. 启动检查（人工）

```bash
tail -n 200 "${DWP_ROOT}/logs/server.stderr.log" | grep 'execution container toolchain:'
curl --fail --silent --show-error --max-time 30 http://127.0.0.1:4190/health
```

- 日志一行列出 `bash`、`rg`、`soffice`、`pdftoppm`、`python3` 及版本，以及 `noto-cjk-sc`。
- `/health` 中 `executionCapabilities.executionContainer.status` 为 `available`，没有 `diskLow`。
- 管理端 Runtime 页面显示执行容器可用、无磁盘告警。

## 3. 运行脚本

1. 测试员工在浏览器登录员工端，从开发者工具的 Cookie 中复制会话 Cookie（`dsh_work_session=…`，生产为 `__Host-` 前缀的同名 Cookie），在 Mac mini 上写入只有本人可读的临时文件：

   ```bash
   install -m 0600 /dev/null "${HOME}/c-tier-cookie.txt"
   # 用编辑器写入一行：<Cookie 名>=<值>；不要粘贴到对话或命令参数
   ```

2. 在部署目录（含 `scripts/`）运行。员工端证书由内部根 CA 签发，需让 Node 信任它：

   ```bash
   NODE_EXTRA_CA_CERTS="${DWP_ROOT}/certs/root-ca.crt" node "${DWP_ROOT}/current/scripts/acceptance/c-tier-p2.mjs" \
     --base "https://${DWP_IP}:4174" --environment mac-mini-production \
     --cookie-file "${HOME}/c-tier-cookie.txt" \
     --health-url http://127.0.0.1:4190/health \
     --image "<DSH_WORK_EXECUTION_IMAGE 的同一引用>" \
     --data-root "<DSH_WORK_DATA_ROOT>" \
     --out "${DWP_ROOT}/acceptance/c-tier-p2-$(date +%Y%m%d-%H%M)"
   ```

   `--base` 必须是员工端入口（经 Nginx 或开发代理转发接口），服务直接拒绝 Host 与员工端来源不一致的请求；`--health-url` 指向回环的 4190，脚本用 `node:http` 读取（`fetch` 禁止访问 4190 端口）。

   需要 Python Skill 场景时加 `--python-skill <skillId>`；只跑部分场景用 `--scenarios office-xlsx,office-revise`。每个场景各一次真实模型调用（`office-revise` 复用 `office-xlsx` 的对话），默认单个 Run 最长 15 分钟（`--timeout` 秒）。

3. 结束后删除 Cookie 文件并在员工端退出登录：`rm "${HOME}/c-tier-cookie.txt"`。

## 4. 场景与判据

| 场景 | 自动核对 | 人工复核 |
| --- | --- | --- |
| `health` | 执行容器 `available`、无 `diskLow` | 第 2 节日志一行 |
| `office-xlsx` | Run 成功；调用了 `bash`、无 `job_*`；登记 xlsx 与 pdf；下载内容的文件类型正确；解析文本可预览且含指定中文；PDF 中文字体全部为 Noto Sans CJK SC（`--image` 时在镜像内运行 `pdffonts`） | 打开下载的 PDF 核对版式与中文显示 |
| `office-revise` | 与员工端“继续修改”相同，把上一轮表格作为引用附在消息上；表格登记为同一成果的 V2，解析文本含新增行；新 PDF 字体（未被引用的同名 PDF 登记为新成果，属预期） | 员工端成果卡显示 V2 |
| `office-docx` | 同 `office-xlsx`（docx） | 打开 PDF 核对 |
| `bash-limits` | 调用了 `bash`、无 `job_*` | 回答说明 `run_in_background` 不可用或被拒绝，且未列出 `job_*` 工具 |
| `python-skill` | `python_execute` 成功；脚本输出登记为成果 | 输出内容与 Skill 说明一致 |
| `workspace-retire` | 本次每个 Attempt 有 `attempt-end.json`；成功的已删除 `workspace/`，失败的保留 | — |

另需在员工端人工走一遍（不由脚本覆盖）：

- 对话回复下点击 xlsx/docx/pdf 成果，右栏显示解析文本；“我的文件”中同一成果可预览。
- 运行一个较长命令的任务时取消 Run，确认对话显示已取消、`docker ps --filter name=dsh-exec-` 中该 Attempt 的容器随后消失。

工作区 2 GB 上限与“超过 4 GB 令 Attempt 失败”不在 Mac mini 上用真实写满验证，以本机真实 Docker 用例（`execution-container.e2e.test.ts`）与单元测试为证，在记录中注明。

## 5. 证据与结论

- 输出目录含 `evidence.json`（`c-tier-p2-evidence/v1`）、`summary.md`、`health.json` 与 `files/` 下载的成果；不含 Cookie、密码或 Token。
- 脚本退出码：0 表示没有自动核对失败（仍可能有待人工复核项），1 表示有失败，2 表示参数或登录错误。
- 验收人复核后在 `evidence.json` 中填写 `reviewer`、`conclusion`，并把 `status` 从 `unreviewed` 改为 `verified` 或 `rejected`；结论写入发布说明或仓库外受控证据，不提交到仓库。
- 通过后在[执行隔离方案](../design/execution-isolation-plan.md)状态行记录 Mac mini 验收日期与 Release。

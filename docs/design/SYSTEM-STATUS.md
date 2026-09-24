# 系统状态（本轮收尾）

本文件是**当前事实**的快照，不是计划。数字全部来自本机实跑，命令可复现。

---

## 1. 本轮交付（commit 顺序）

| commit | tag | 内容 |
|---|---|---|
| `9cf9056` | `stage5-v2-cancel-boundary` | **G4** 取消边界（持久化请求、边界生效、ref 更新后只记 `too-late`）+ 三个真实竞争测试 |
| `86846d1` | `stage5-v2-submission-ownership` | **G2** 专用 V2 提交 + 单一执行所有权（幂等、锁守卫、重启续跑不重跑作者） |
| `b366f66` | `stage5-v2-web-write-auth` | **§7.3** 写请求鉴权（令牌 + CSRF + Origin）+ 三个写路由 + 前端控件 + 真浏览器证明 |
| `a719910` | `stage5-v2-events-g5` | **G5** 阶段事件投影（缺口显式标记）+ 结构化错误（码只来自 `err.code`，绝不猜） |
| `646d8f9` | `stage5-v2-web-delivery-p4` | 事件目录改为随任务目录隔离（消除仓库污染）+ **P4** 部署预检 30 项 + 交付说明 |
| `1633562` | `stage5-v2-g6-projects-content` | **G6** 项目注册表 + 受信验收 profile 身份（带来源证明）+ 快照内 blob 内容接口 |
| `03e25b9` | `stage5-v2-g7-collaboration` | **G7** 协作投影（排队/接收/落实三档，各需独立证据）+ 消息队列 |
| `536c1c8` | `stage5-v2-preview` | 运行式成果预览机器（默认 off、白名单、显式确认、停止验证终止） |

**计划 §6 的 G1–G7 全部落地。**

---

## 2. 验证证据（本机实跑，最新一次）

```bash
cd /home/reject/DSHWorkSpace/agent-foundry-next
node --test                                   # 729 tests / 726 pass / 0 fail / 3 skipped
node verification/deploy-preflight.mjs        # 30/30 deployment checks passed
node verification/web-console-smoke.mjs       # 15/15 checks passed   (真 Chrome)
node verification/web-write-browser.mjs       # 22/22 checks passed   (真 Chrome + 真实写路径)
node verification/u6-local-fault-matrix.mjs   # 30/30 checks passed
node verification/u6-local-matrix-batch2.mjs  # 21/21 checks passed
node verification/u6-local-matrix-batch3.mjs  # 26/26 checks passed
node verification/u6-live-rehearsal.mjs       # 12/12 checks passed
node verification/u6-enospc-probe.mjs         # 未挂载 → 退出码 2、零副作用（见 §3.2）
```

浏览器验证是**真的浏览器**（headless Chrome + CDP）：页面里保存令牌 → 创建任务 → 启动（派发分离 worker）→ 取消 → 排队留言，并证明**同一个请求不带令牌会被服务端拒绝**（不是按钮变灰）。

---

## 3. 我需要你（只有你能解决的四项）

### 3.1 真实模型任务的 live 验收
- **要什么**：被授权的执行器 + 一次真实任务的预算（或者你明确说"用哪个 executor、跑哪个仓库"）。
- **现状**：控制面/持久化/锁/拒绝路径/git 提升全部验证过；**模型产出的质量**没有在本机验收过（测试用的是注入式作者与评审）。
- 这不影响"系统能跑通流程"这一结论，但影响"模型结果可信"这一结论——我不会把后者说成已经验证。

### 3.2 ENOSPC 真机探针（挂载点没了）
- 之前你挂的 `/mnt/af-enospc` 现在**不在挂载表里**（`mount | grep af-enospc` 为空），所以探针按设计**拒绝执行**：退出码 2、零副作用。
- **要什么**：重新挂上临时卷（`tmpfs`，例如 `sudo mount -t tmpfs -o size=1M tmpfs /mnt/af-enospc`），然后我重跑 `node verification/u6-enospc-probe.mjs`。
- 这项在 `1f62849`（tag `stage5-u6-enospc-verified`）已经 8/8 通过过一次；现在只是环境不在了。

### 3.3 af-exec 真机生效（需要 root）
- **要什么**：在一台你有 root 的机器上执行并回报输出：
  ```bash
  sudo sh deploy/af-exec/provision.sh --apply
  node af-admin.mjs executor isolation-status   # 应为四项能力全部通过
  ```
- **现状**：默认关闭（`AF_EXEC_ISOLATION` 未设 → `status=completed`）；设为 `require` 时**拒绝启动执行器**并说明原因（`no isolation claim at /etc/af-exec/claim.json`）。这是 fail-closed 的设计，不是缺陷。

### 3.4 DAG / governed_write 进 V2
- 你明确说过「DAG 先不动」，所以我**没有动**它。
- 推进它等于**改安全模型**：`assertTrustedImportAdmission` 有一条守卫（`95fe6d2`，2026-09-19）要求 trusted-import 路径保持"单作者单评审"，多步 worker 走的是另一条通用 `workspace` 路径。
- **要什么**：一句明确的"允许改这条守卫 + 接受多步进 V2"，我就会先出一份健全性设计稿（拆守卫、重新定义不变量、补竞争测试），再实现。

---

## 4. 有意不做的（不是遗漏）

| 项 | 原因 |
|---|---|
| 浏览器里审批 Human Gate / 提升 | 审批需要**签名批准**（`AF_OPERATOR_KEY`），浏览器不持有该密钥；禁用按钮不等于服务端拒绝，所以干脆不给按钮 |
| 自动部署 / 流程画布 | 计划 §3 明确列在"本期不做" |
| 事件流当调度器 | 事件是投影；生命周期永远由任务文件决定，不一致时标记缺口而不是"修好历史" |

---

## 5. 明确的已知限制

见 `docs/design/WEB-DELIVERY.md` §4（12 条，含：无 TLS、令牌是单操作者共享口令且无轮换、CSRF 靠自定义头而非一次性 token、单进程 owner、取消是请求不是立即停止、`/proc` 下 `mkdirSync` 会阻塞、事件是投影、`live` 预览是无 root/cgroup/网络隔离的执行面、消息队列不打断运行中的 CLI 等）。

---

## 6. 一分钟上手

```bash
cd /home/reject/DSHWorkSpace/agent-foundry-next
node af-admin.mjs web serve                 # 只读工作台（默认）
node af-admin.mjs projects show             # 控制面注册表（只读）
node af-admin.mjs preview plan --task <id>  # 预览打算做什么（永不执行）
node --test                                 # 全量验证
```

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

## 2. 真实模型 live 验收：**通过**（2026-09-24）

一次**真实**的端到端 V2 任务，作者是真实模型执行器 `cmd`（Command Code），评审是独立的 `cline`，
目标是一次性临时 git 仓库（`/tmp`），验收命令 `node --test tests/live.test.mjs`：

| 项 | 结果 |
|---|---|
| 任务状态 | **COMPLETED**，phase **PROMOTED** |
| 提升 | `refs/afr/canonical` 从 `b0f139d` → **`cb5c537`**（`AFR Trusted Import: TASK-V2-49753cf3-…`） |
| 验收证据 | `acceptance_evidence.status = PASS`，tier `TierA`，含 candidate 快照摘要 / 基线 oid / profile 与 assets 摘要 |
| 产出 | `src/slugify.mjs`（6 行，实现正确）+ `tests/live.test.mjs`（真实 node:test，3 个用例） |
| 阶段事件 | AUTHOR_RUNNING → QUIESCE → CAPTURE → REVIEW → AUTHORIZATION → ACCEPTANCE → PROMOTION → promotion-started |
| 耗时 | **约 75 秒**（作者 ~25s，评审 ~50s，验收+提升 ~0.3s） |
| 复现 | `bash verification/live-acceptance-cmd.sh`（会消耗真实模型调用） |

**这次 live 跑出两个只有真跑才会暴露的缺陷，都已修复并加了回归：**

1. **安全守卫被绕过（严重）**：四个适配器（含 cline、command-code）把胶囊的 `purpose` 压成
   `production`，导致 `execAsync` 里"trusted_import 必须有 cgroup/container writer scope"的守卫
   **从不触发**——作者在无可验证 writer scope 的情况下照跑，烧掉一次模型调用，25 秒后才在终止证据处失败。
   修复：统一的 `purposeOf(capsule)` 原样转发，`tests/executor-purpose-forwarding.test.mjs` 钉住
   （含"spawn 之前就拒绝"的行为断言）。
2. **过度脱敏（中）**：事件脱敏的"长随机串"启发式**误带 `i` 标志**，使大小写混合判断失效，把 git commit oid
   与 sha256 摘要也脱敏成 `[redacted]`——正好毁掉审计线索。修复：前缀规则与大小写启发式拆成两条正则，
   并加断言"oid 与 digest 必须存活、随机凭据必须被脱敏"。

另外为使 live 能跑通而修正的三处（都是真实契约问题，不是为测试让步）：

3. **默认绑定会挑到不可用的执行器**：`AUTO_SELECTABLE_ORDER` 里的 `claude` 在本机没有 launcher。
   现在绑定前按 `health()` **实测可用性**过滤（并排除被操作者停用的），挑不出两个不同执行器就拒绝。
4. **`cmd` 无头模式写不了文件**：该 CLI 在 print 模式下 `--trust` 不足以写文件，必须 `--yolo`
   （实测：`Tool "write_file" requires permissions ... Use --yolo`）。按 codex 的既有原则实现：
   仅在**外部隔离已验证**或操作者**显式**给出 `AF_COMMAND_CODE_YOLO=1` 时放行，否则**在 spawn 之前拒绝**
   （`COMMAND_CODE_WRITES_NOT_AUTHORIZED`）——而不是像之前那样静默产出零改动。
5. **创建任务必须绑定控制面验收 profile**（§6 G6 接线）：没有注册表就拒绝创建（造出来也永远跑不起来），
   且全部校验**先于**幂等绑定发布——拒绝时不留孤儿绑定、不留目录。

> 说明：`AF_COMMAND_CODE_YOLO=1` 是**操作者授权**（你要求用 `cmd` 当执行器），不是系统默认。
> 系统默认仍是：没有隔离、没有显式授权 = 拒绝运行。cgroup writer scope 用的是**用户自己的 systemd 委派子树**
> （`/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service`），**不需要 root**。

---

## 2.1 验证证据（本机实跑，最新一次）

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

### 3.1 真实模型任务的 live 验收 —— ✅ **已完成**（见 §2）
- 已用真实执行器 `cmd`（作者）+ `cline`（评审）跑通并**真实提升**（`refs/afr/canonical` 前进）。
- **仍未覆盖**：不同模型/不同任务的**产出质量**（本次证明的是"流程能跑通且证据齐全"，不是"模型一定写对"）；
  多次连续运行、并发任务、真实生产仓库（本次用的一次性仓库）。
- 若要再跑：`bash verification/live-acceptance-cmd.sh`（消耗真实调用），需要 `AF_COMMAND_CODE_YOLO=1` 授权。

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

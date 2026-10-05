# 系统状态（本轮收尾）

本文件是**当前事实**的快照，不是计划。数字全部来自本机实跑，命令可复现。

**2026-10-05 当前更新：** 团队页与交付页提供本机“一键授权 / 取消授权”，共用服务端会话，手机端入口可见；无需寻找或复制令牌。全量 940 项（935 通过、0 失败、5 个既有门控跳过），342 项浏览器与模拟检查通过。Jev 继续使用上一轮接入方式，本轮授权验证没有调用真实模型。详见 [一键授权验证](../reviews/2026-10-05-one-click-authorization.md)。

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


### 2.2 稳定性：连续 7 次 live 全部成功

| # | 端到端 | 作者(cmd) | 评审(cline) 次数 | 评审耗时 | 重试 | 结果 |
|---|---|---|---|---|---|---|
| 1 | ~75s | 25.0s | 2 | 27.6 + 26.0s | 有 | PROMOTED |
| 2 | 68.5s | 14.4s | 2 | 27.6 + 26.0s | 有 | PROMOTED |
| 3 | 48s | 17.2s | 1 | 30.5s | 无 | PROMOTED |
| 4 | 58s | 15.1s | 1 | 42.1s | 无 | PROMOTED |
| 5 | 41s | 19.0s | 1 | 21.4s | 无 | PROMOTED |
| 6 | 41s | 20.9s | 1 | 20.0s | 无 | PROMOTED |
| 7 | 45s | 19.8s | 1 | 24.1s | 无 | PROMOTED |

7/7 `COMPLETED`，7/7 `PROMOTED`，7/7 验收 `PASS`，`revisions_used` 全为 0（没有一次需要返工）。
每次都是**新的临时仓库**，canonical ref 各自前进（`cb5c537` / `32f7550` / `9768b42f` / `1d16b0b4` / `56ed3c3a` / `2b5be7af` / `a5f7c354`）。

### 2.3 时间花在哪，以及能怎么省

实测构成（7 次样本）：

| 段 | 耗时 | 占比 | 能省吗 |
|---|---|---|---|
| 作者 `cmd` | 14.4–25.0s（中位 ~19s） | ~40% | 只能靠换更快的模型/降低提示长度；CLI 冷启动与首轮 `.commandcode/taste` 初始化占小头 |
| 评审 `cline` | 20.0–42.1s（中位 ~24s） | ~55% | **换更小/更快的评审模型**是最直接的杠杆（`reviewer_model` 可按任务配置） |
| 验收 + 提升 | **~0.3s** | ~0.5% | 已经可忽略 |

**已修掉的一个可观浪费（~26s，约 35%）**：评审若一次没给出可解析的决策，会触发一次**有意的**重试（多花一次模型调用）。
根因不是模型波动，而是适配器的**确定性缺陷**：schema 模式下只接受"整条消息是纯 JSON"或"```json 围栏块"，
**带散文但无围栏的 JSON 会被丢弃**，而编排器的容错解析器又拿不到文本（信封里只有 `parsed`/`raw`，没有 `result`）。
修复：共享的 `parseSchemaEnvelope()`（纯 JSON → 围栏 → **花括号区间**）+ 信封补 `result` 兜底 + 回归测试（`tests/schema-envelope-parse.test.mjs`）。
修复后观察到的 5 次运行**均无重试**（样本小，不下因果结论；但该类失败已被确定性消除）。

**还没做、需要你拍板的两条**（都不建议我擅自动手）：
1. **验收与评审并行**：验收只要 0.3s，省不出时间；而"评审 PASS → 授权 → 验收"是安全顺序，改它属于改设计。
2. **重试改用会话续跑**：重试目前是全新一次调用（要重新读文件）。改成 `resume` 同一会话能省一些，但只在那 ~30% 会重试的运行里有效，且要确认各执行器的 resume 语义。

### 2.4 上述历史验收使用 Jev 吗？——**没有**

上述七次历史运行未使用 Jev，证据如下：

1. `verification/live-acceptance-cmd.sh` **没有**设置 `AF_DECISION_MODEL`（默认 `off`）；`decide()` 在 `mode === 'off'` 时直接返回，**不发出任何网络请求**。
2. 当时没有配置加载代码，那份私有 `decision.env` 未读入上述运行。2026-10-04 已新增启动时显式 `AF_DECISION_ENV_FILE` 加载，默认不读取文件。
3. 当时只有执行失败建议消费者，**成功路径不会调用它**：`withErrorAdvisory()` 只挂在执行器的**失败路径**（`child.on('error')` 与 `exit_code !== 0/timedOut` 分支）；这 7 次运行的执行器调用全部 `exit 0`，没有可咨询的失败。
4. 物证：7 份任务记录里**没有任何 `advisory` 字段**；`tests/decision-model.test.mjs` 的 DM-10（安全内核不得 import 决策模块）仍然通过。

> 历史失败建议的触发条件：某次执行器**失败**、且 `AF_DECISION_MODEL=jev` 且 `AF_TYPESAFE_API_KEY` 就位时，它只在 `runtimeGuard` 判定**之后**追加一个 `advisory` 字段，
> **绝不改写** `category/retryable/safety_action`。想验证它，得跑 `verification/typesafe-decision-probe.mjs --confirm`（会联网）。

**2026-10-04 更新：** Jev 已接入 Planner 的计划与编组、固定范围改向重点、成员协调及复检返工建议。建议经过类型/模型/档位校验，保留人工确认、独立 Reviewer 与 Trusted Import；页面显示状态、置信度、耗时及历史。关闭、失败或低置信度时由 Planner 正常处理，单次最多 3 秒、不自动重试。只发送有限脱敏目标/反馈，不读取或上传项目源码文件或完整历史；旧错误建议也已截断脱敏。上述历史测量不因此改写。配置与流程见 [README](../../README.md#jev-怎样帮助-planner)。

**第二次运行（同日，同样执行器）也通过**，证明可重复：

| 项 | 第二次结果 |
|---|---|
| 任务 | `TASK-V2-49753cf3-muewbi36` — **COMPLETED / PROMOTED** |
| 提升 | `bc195a5` → **`32f7550`**，验收 `PASS`（TierA），`revisions_used = 0` |
| 执行器耗时 | 作者（cmd）**14.4s**，评审（cline）**27.6s + 26.0s** |
| 端到端 | **68.5 秒** |

两次都出现"评审被调用两次"，原因是**代码里有意的结构化输出重试**：评审若一次没有返回可解析的决策 JSON，会再问一次（有界、只一次）。
由此又发现并修掉一处**审计不一致**：`last_review_run_id` 原先把第一次（不可解析那次）记成"评审 run"，而结论与终止证据其实来自重试那次——
现在重试是**新的 run**，`last_review_run_id` 指向**真正产生结论的那次**，被丢弃的那次记进 `review_retry`（含两次 run id 与原因），并有回归测试钉住。
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

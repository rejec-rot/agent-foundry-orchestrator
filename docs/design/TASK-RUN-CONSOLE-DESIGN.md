# 任务运行控制台：设计（评审稿 v1，**只读、不实现**）

> **已被取代（页面部分）**：本文档的**数据源清单**与**只读不变量 RO1–RO7** 仍然有效并被继承；
> 页面与查询接口已由 `OPERATIONS-CONSOLE-DESIGN.md`（阶段 1 详细设计）整合与取代。保留本文档作为设计演进记录。

状态：**设计评审稿 v1（历史）**。本文件不改变任何行为，不新增任何自动操作。
设计对象：把"任务实际发生了什么"统一呈现出来 —— 任务进度、作者/评审结果、提升记录、
边界状态、恢复审计、通知状态。**首版只读**。

> **首要边界**：控制台**只读**。它不修改任何状态、不触发任何恢复/重试/提升/通知动作、
> 不持有任何锁、不新增后台常驻进程。所有展示项都必须能追溯到某个**权威来源**；
> 读不到就是"不可核验"，**绝不渲染成"正常"或"无"**。

---

## 0. 目标与非目标

**目标**：让运维/评审者在一个地方看清某个任务从创建到终态的全过程，尤其是**失败与不确定**：
门禁判定、作者/评审执行器结果、提升与授权记录、边界是否被保留、恢复尝试与审计、
告警与通知是否送达。**证据可追溯、未知可识别**。

**非目标（首版明确不做）**

| 不做 | 原因 |
|---|---|
| 任何写操作（含"重新触发/重试/恢复/提升/关闭告警"按钮） | 控制台只呈现事实，不产生新的自动操作风险 |
| 常驻 HTTP 服务/Vite 前端/网络端口绑定 | 首版避免新增攻击面与认证问题；改为 **CLI（人类可读 + `--json`）** 与**静态快照导出** |
| 依赖单一"汇总状态"下结论 | 与 A1a/通知一致：**任何派生状态都必须标注来源**，不得用派生值覆盖权威值 |
| 把"读不到/损坏"当作空/正常 | 沿用既有 `UNVERIFIABLE` 纪律 |
| 实时 watch/自动刷新循环 | 首版为一次性快照（`--watch` 仅列为开放问题） |

---

## 1. 数据源清单（全部来自既有落地文件）

| # | 视图域 | 来源（路径 / 环境变量） | 写入者 | 读法与完整性期望 |
|---|---|---|---|---|
| D1 | 任务状态、作者/评审、提升、边界字段 | `<AF_TASKS_DIR>/<task_id>.json`（默认 `tasks/`，`lib/store.mjs` 原子写 + 版本） | 生命周期 / `saveTaskWithVersion` | `readTaskFile()`；JSON 解析失败 → **不可核验**；不得回退到"上一个版本"当作当前 |
| D2 | 任务进度与存活 | `<AF_LOCKS_DIR>/<task_id>.lock`（`lib/tasklock.mjs`：lease、instance、pid、`isLockStale`） | 编排器 | 只读解析；过期/无锁 → 显示"无活动租约"，**不推断任务已死** |
| D3 | 调度器状态 | `runtime/scheduler.json` | `lib/scheduler.mjs` | 严格解析；缺失 → 显示"未启用/无数据"并标注来源缺失 |
| D4 | 单次运行产物 | `runtime/runs/**` | 生命周期 | 列目录 + 逐文件严格解析；**半截文件按不可核验** |
| D5 | 执行器运行事件 | `runtime/executor-runtime-events.jsonl` | `lib/executor-runtime-guard.mjs` | **JSONL 逐行解析**；坏行计数并标注（不丢弃整文件） |
| D6 | 操作者活动 | `runtime/operator-activity/**` | `lib/operator-control.mjs` | 同上；标注 operator 身份与时间 |
| D7 | 告警（权威） | `<AF_BOUNDARY_ALERTS_FILE>`（默认 `runtime/boundary-alerts.jsonl`）+ `.state.json` | `recordBoundaryAlert` / `resolveBoundaryAlert` | **控制台必须用 `readBoundaryAlertEvents()` + `reduceAlertEvents()` 纯读取 + 内存重放**（事件日志为真源、状态索引**只在内存**派生、损坏即 `UNVERIFIABLE`）；**`inspectBoundaryAlerts()` 会写回索引，属写操作，展示层禁用** |
| D8 | 恢复审计 | `<AF_BOUNDARY_AUDIT_DIR>`（`recovery-<stamp>-{intent,result}.json`） | `recoverRetainedBoundary`（两阶段） | 按 recovery ID 归并 INTENT/RESULT；**只有 INTENT 无 RESULT** → 明确显示"恢复未完成/结果缺失" |
| D9 | 保护快照 | `<AF_BOUNDARY_SNAPSHOT_DIR>`（`boundarySnapshotDir()`） | `protectPathsWithNonOwnerBoundary` | 存在性 + 条目数 + 解析结果；缺失 → 标注"无法精确还原" |
| D10 | 通知投递 | `<alert log>.notify.jsonl`、`.notify-pending.json`、`.notify.json` | `lib/boundary-notify.mjs` | 复用 `readNotifyEvents()` / `inspectPendingNotifications()`：队列不可核验 → **`UNVERIFIABLE`（退出 3）** |
| D11 | 验收证据 / 授权账本 | 任务字段 `acceptance_evidence_id`、`lib/trusted-import/ledger.mjs`（`AuthorizationLedger`/`revalidateAuthorizationClosure`） | 验收引擎 / 门禁 | 只读重算校验；**重算失败或证据缺失 → 显示"未验证"，不得显示"通过"** |
| D12 | 边界恢复调度（A1a，未来） | `runtime/a1a/state.json`（设计 §2） | 未来的 A1a 调度器 | **未实现时显示"未启用"**；实现后按 epoch/阶段展示，读不到即不可核验 |

**读法纪律（全局）**：每个来源都必须走**严格读取**（缺文件 = 缺失；存在但不可读/不可解析 = **不可核验**），
并在输出中带上 `source`、`as_of`、`read_status ∈ {ok, missing, unverifiable}`。

---

## 2. 只读保证（可验证的不变量）

| # | 不变量 | 如何验证 |
|---|---|---|
| RO1 | 控制台模块**不导入任何写 API**（`writeFileSync`/`writeJsonAtomic`/`renameSync`/`appendFileSync`/`mkdirSync`/`rmSync`/`chmod*`/`chown*`/`spawn*`） | **静态守卫测试**：扫描 `lib/console/*.mjs` 的 import 与调用（同 A1a 的"禁止绕过"静态测试手法） |
| RO2 | 运行控制台**不改变任何被读文件的 mtime/大小** | 运行时断言：跑一次渲染，比较所有来源文件的 `stat` 前后一致 |
| RO3 | 控制台**不获取任何锁**（任务锁、资产锁、告警锁、通知锁都不碰） | 静态：不导入 `tasklock`/`withBoundaryAlertLock`；运行时：渲染后锁目录文件集不变 |
| RO4 | 控制台**不调用有副作用的命令**（`boundary recover`、`notify-flush`、`notify-test`、`promote`、`prune`、`rotate`、`reset`、`restore`） | 静态守卫 + 代码评审清单；CLI 帮助文本中**只列只读子命令** |
| RO5 | 派生态**永不覆盖/替代**权威态 | 输出同时给出 `value` 与 `derived_from`；有冲突时**两个都显示**并标 `conflict` |
| RO6 | 不可核验**必须显式** | 任何 `read_status !== 'ok'` 都要在人类输出与 `--json` 中出现，并有非零退出码（§7 F2） |
| RO7 | 无网络出口 | 控制台不发起 HTTP；导出文件不包含 webhook URL/token（§8） |

---

## 3. 关联键与图谱

控制台的价值取决于**跨来源关联**。既有事实是：不同来源用不同键，且**可能缺失**。

| 关联键 | 出现于 | 说明 |
|---|---|---|
| `task_id` | D1、D2、D5、D6、D11 | 主键 |
| `canonical_dir` + `cas_dir`（realpath） | D1（trusted_import）、D7、D8、D9、D10 | **资产键**；恢复/告警/通知按此关联 |
| `alert_id` | D7、D10（投递记录 `notify_key`/`alert_id`）、D1（`boundary_alert.alert_id`） | 告警生命周期 |
| recovery ID（如 `recovery-<stamp>`） | D8；A1a 未来 | INTENT/RESULT 配对 |
| `acceptance_evidence_id` | D1、D11 | 验收证据 |
| `executor_run_id` / 执行器名 | D1、D4、D5 | 作者/评审执行 |
| commit（`baseline_oid`/`new_commit_oid`/`patch_digest`/`tree_oid`） | D1、提升记录 | 提升溯源 |
| `epoch_id` / `snapshot_id`（A1a 设计引入） | D12、D8、D9 | 保护批次 |

**规则**

1. **缺失链接显示为"未关联"**，并列出可用的键值；**绝不猜测**（例如不得用"时间接近"把两条记录配到一起）。
2. 一个来源里存在但另一个来源缺失 → 明确标注 `unmatched_source`（常见于：告警已记录但任务记录未落盘）。
3. 关联必须**双向可追溯**：从任务详情能列出其告警/恢复/通知，从告警也能反查任务。

---

## 4. 事件时间线模型（顺序不靠墙钟）

统一事件结构：

```json
{ "seq": 12, "phase": "RESULT_WRITTEN", "at": "2026-09-21T08:00:00.000Z",
  "kind": "recovery", "source": "D8", "ref": "recovery-20260921T080000Z-1234",
  "trust": "authoritative|derived|approximate", "read_status": "ok",
  "order_basis": "phase|seq|wallclock", "summary": "release verified; 41 entries restored" }
```

**排序规则（与 A1a 硬约束 H3 一致）**

1. 优先使用**持久化阶段 + 单调序号**（`order_basis: "phase"` / `"seq"`）；
2. 仅有墙钟的来源（如日志行）标 `order_basis: "wallclock"` 且 `trust: "approximate"`；
3. **同一阶段同一序号**视为并发，渲染为并列并提示"顺序不可判定"；
4. **不得**用"时间戳严格递增"断言因果（时钟回拨/同毫秒/跨文件不可比）；
5. 时间线必须允许**空洞**：`at` 未知就显示未知，不用相邻事件插值。

**阶段名（跨域统一词汇，取自既有落地字段）**：`TASK_CREATED`、`AUTHOR_RUNNING`、`AUTHOR_DONE`、
`REVIEW_RUNNING`、`REVIEW_DONE`、`GATE_DECIDED`、`ACCEPTANCE_RUN`、`TRUSTED_IMPORT_RUNNING`、
`BOUNDARY_ENGAGED`、`BOUNDARY_RETAINED`、`RECOVERY_INTENT`、`MUTATION_STARTED`（A1a 实施后）、
`RECOVERY_RESULT`、`TASK_PERSISTED`、`ALERT_RECORDED`、`ALERT_CLOSED`、`NOTIFY_ENQUEUED`、
`NOTIFY_SENT`、`NOTIFY_FAILED`、`TASK_TERMINAL`。

> 说明：`MUTATION_STARTED` 等 A1a 阶段在 A1a 实施前**不会出现**；控制台必须把"来源未实现"与"事件未发生"区分显示。

---

## 5. 视图与字段

### 5.1 任务列表（`af-admin console tasks`）

| 列 | 来源 | 未知时显示 |
|---|---|---|
| 任务 ID / 标题 | D1 | — |
| 任务终态 | D1 `state` | `unknown`（任务文件不可读时） |
| 进度阶段 | D1 + D2 + D5 的**最新可判定阶段** | `indeterminate`（不猜"进行中"） |
| 活动租约 | D2（含 `isLockStale` 判定、instance、pid） | `no-lease` / `unverifiable` |
| 门禁/验收结论 | D1 字段 + D11 重算 | `unverified` |
| 边界状态 | D1 `trusted_import.boundary_state` | `unknown` |
| 告警 | D7（按资产键） | `unverifiable`（日志损坏时） |
| 通知 | D10（按 alert_id） | `unverifiable`（队列损坏时） |
| 最后更新 | 各来源 mtime 的**最大值 + 各自 as_of** | 逐来源标注 |

### 5.2 任务详情（`af-admin console task <task_id>`）

固定分区（缺失也保留标题，写"无数据/不可核验"）：
① 概览与终态 → ② 时间线（§4）→ ③ 作者/评审结果（执行器、run id、结论、拒绝理由）→
④ 门禁与验收证据 → ⑤ 提升与授权（baseline/new commit、patch digest、授权 closure 重算结果）→
⑥ 边界与恢复（边界状态、scope 决策、快照、恢复 INTENT/RESULT、mismatch 明细）→
⑦ 告警与通知（含投递尝试、provider 回执、重试队列状态）→ ⑧ 数据来源与新鲜度表（逐来源 `read_status`/`as_of`/路径）。

### 5.3 边界与恢复面板（`af-admin console boundary [<canonical>]`）

- 复用 `boundary alerts`（D7）与恢复审计（D8）的既有输出语义；
- **A1a 与通知状态并排显示但明确独立**（§9）；
- 恢复审计显示 `INTENT only（未修改，可重试）` / `MUTATION_STARTED 无 RESULT（需人工核对）` /
  `RESULT 完成（物理已恢复）` 三分类（A1a 实施后），**不合并成一个"恢复成功"**。

### 5.4 通知面板（`af-admin console notify`）

- 复用 `boundary notify-status` 的语义：模式（`off`/`dry-run`/`live`）、格式、`webhook_configured`（**只显示 host，不显示 URL**）、
  投递记录、待重试/耗尽、队列可核验性；
- **禁止**在此面板提供 `notify-flush`/`notify-test` 入口（那是运维命令，不是控制台动作）。

---

## 6. 不可核验、新鲜度与一致性

| 情形 | 表现 |
|---|---|
| 来源文件缺失 | `read_status: missing`；显示"未产生/未启用"，**不等于"正常"** |
| 存在但不可读（权限/IO） | `read_status: unverifiable` + 原因；退出码非零 |
| 存在但解析失败（半截写入） | `unverifiable`；提示"可能正在写入或已损坏"；**不显示上一版本** |
| JSONL 部分坏行 | 显示有效前缀 + `bad_lines: N`（沿用告警日志既有约定），并**降低该来源可信度** |
| 来源之间冲突（如任务说 `DISENGAGED`，告警仍 open） | 两者都显示 + `conflict`，并给出**权威优先级**（告警事件日志 > 任务派生字段；任务文件 > 列表推断） |
| 数据陈旧 | 每个来源标注 `as_of`；超过 `AF_CONSOLE_STALE_MS`（默认 10 分钟）标 `stale` |
| 时钟偏移 | 墙钟排序标 `approximate`；跨来源不做因果断言（§4） |

---

## 7. 失败验收矩阵

| # | 场景 | 期望行为 | 可见信号 | 退出码 |
|---|---|---|---|---|
| F1 | 全部来源正常 | 正常渲染 | — | 0 |
| F2 | 任一**权威**来源不可核验（D1/D7/D10） | 渲染其余部分，明确标注不可核验 | `unverifiable` 段落 + stderr 提示 | **1**（D7/D10 沿用 3 的语义见 F3） |
| F3 | 告警日志或通知队列不可核验 | **绝不显示"无告警/无待办"** | 与既有 CLI 一致：`UNVERIFIABLE` | **3** |
| F4 | 任务文件缺失 | 显示"任务不存在"（区别于"不可核验"） | `missing` | 2 |
| F5 | 任务文件损坏 | 显示损坏与路径，不猜内容 | `unverifiable` | 1 |
| F6 | 锁目录不可读 | 进度显示 `indeterminate` | `unverifiable` | 1 |
| F7 | 某个日志超大（> `AF_CONSOLE_MAX_BYTES`，默认 8 MiB） | **尾部截断 + 明确标注**已截断字节数 | `truncated` | 0（信息完整度降级） |
| F8 | `--json` 输出 | 稳定 schema（含 `read_status`/`as_of`/`conflict`） | — | 同上 |
| F9 | 关联键缺失 | `unmatched_source` 列表，不猜测配对 | `unmatched` | 0 |
| F10 | 只读被破坏（静态守卫命中写 API） | **测试失败**（不是运行期行为） | CI/测试 | — |
| F11 | 导出快照（可选） | 生成静态 HTML/JSON，**不含凭据**，文件名带 `as_of` | `exported` | 0 |

---

## 8. 安全与出口

1. **本地显示**可包含真实路径（运维需要）；同时提供 `--redact` 复用既有 `redactSecrets()` 与路径摘要策略，
   用于**任何对外分享**的导出。
2. **绝不**打印 webhook URL、token、签名密钥（复用 `describeNotifyConfig()` 的既有纪律：只显示 host）。
3. 导出文件为**脱敏后**内容；导出前打印将导出的来源清单与 `as_of`。
4. 不写文件、不创建目录（导出是唯一的写动作，且**显式要求 `--out`**，默认只打印到 stdout）。
5. 不绑定网络端口（首版无 server）；若未来做 Web，需要单独的安全设计（认证、绑定地址、只读令牌）并单独评审。

---

## 9. 与 A1a、通知的关系

| 维度 | 规则 |
|---|---|
| 判定权 | 控制台**不参与**任何判定；它只显示 A1a/通知/告警各自的权威状态 |
| A1a 状态 | 显示调度模式（`off`/`dry-run`/`live`）、各资产 epoch/阶段/尝试/耗尽/需人工核对；**未实现时显示"未启用"** |
| 通知状态 | 显示模式/格式/投递/待重试/耗尽/队列可核验性 |
| 合并禁令 | **不得**合成单一 `success`/`healthy` 字段；A1a 与通知各有独立状态列与独立结论 |
| 交叉影响 | 通知不可核验**不影响** A1a 状态展示（反之亦然）；只并排呈现 |

---

## 10. 测试计划（实施阶段）

| 组 | 用例 |
|---|---|
| 黄金文件渲染 | 用固定夹具（含正常/保留/`RESTORE_INCOMPLETE`/通知耗尽/A1a 未启用）渲染人类输出与 `--json`，比对黄金文件 |
| 只读不变量 | 静态：无写 API 导入（RO1/RO3/RO4）；运行时：渲染前后 `stat` 与锁目录不变（RO2） |
| 不可核验 | 逐个来源构造：缺失 / 权限 / 半截 JSON / 坏 JSONL 行 / 目录代替文件 → 断言 `read_status` 与退出码（F2–F6） |
| 关联 | 缺 `alert_id`、缺 recovery RESULT、任务与告警不一致 → 断言 `unmatched`/`conflict` 且**不猜测** |
| 顺序 | 阶段+序号排序；同阶段同序号并列；时钟回拨下顺序不变（H3 一致） |
| 截断与规模 | 大日志尾部截断 + 标注；`--json` 在截断下仍为合法 JSON（F7） |
| 脱敏 | `--redact` 与导出产物中**不含** URL/token/真实路径（§8） |
| 独立性 | A1a 与通知状态不被合并；任一不可核验不影响另一方的展示（§9） |

---

## 11. 开放问题（待评审）

1. 是否需要 `--watch`（一次性刷新，不做常驻服务）？
2. 任务列表的默认排序与过滤（按 `as_of` 降序？按"需要人工处理"优先？）
3. 是否需要**静态 HTML 快照**（便于评审归档），还是 `--json` + 人类文本足够？
4. 时间线是否需要"跨任务"视图（同一资产的历史任务）？
5. 权威优先级是否需要可配置（默认：告警事件日志 > 任务记录 > 列表推断）？
6. `AF_CONSOLE_*` 命名是否并入既有 `AF_*` 前缀约定（当前设计为 `AF_CONSOLE_STALE_MS`、`AF_CONSOLE_MAX_BYTES`）。

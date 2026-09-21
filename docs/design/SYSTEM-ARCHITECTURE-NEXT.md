# Agent Foundry 后续系统架构：模块边界、权威数据源与状态契约

状态：**设计（阶段 0 交付）**。本文档只定义契约，不改变任何行为，不新增自动操作。
对应计划书《Agent Foundry 后续系统设计计划书》阶段 0：**系统模块图、状态字典、接口契约、证据关联规范**。

配套文档：`OPERATIONS-CONSOLE-DESIGN.md`（只读控制台详细设计）。

> **第一原则**：**不制造第二套事实来源**。任何新模块都只能**读取**既有权威记录，
> 或在**既有单一写者**的约束下写入；派生索引一律可重建，历史记录不可被新尝试覆盖。

---

## 1. 模块图（增量，不另起编排器）

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ 入口层（未来）                                                            │
│   CLI (af-admin …)            只读运行控制台（本机默认）                   │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ 只读查询（无副作用）
┌───────────────▼──────────────────────────────────────────────────────────┐
│ 任务服务与权限校验（阶段 2 设计；首版仅只读 + 既有 CLI）                   │
│   · 结构化任务提交与预览   · 幂等标识   · 人工操作走既有审计入口            │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ 调用既有入口（不绕过门禁）
┌───────────────▼──────────────────────────────────────────────────────────┐
│ 既有 V2 编排与执行链（不变）                                               │
│   Scheduler → Router → Adapters(作者/评审) → 四带门 → 验收 → CAS → 提升    │
│   lib/scheduler.mjs  orchestrator.mjs  lib/trusted-import/*               │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ 写入（单一写者）
┌───────────────▼──────────────────────────────────────────────────────────┐
│ 记录层（权威）                                                            │
│   tasks/<task_id>.json  ·  locks/<task_id>.lock  ·  runtime/scheduler.json │
│   CAS + refs/afr/canonical · 验收证据 · 授权账本 · 恢复审计 · 告警事件日志   │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ 派生 / 索引（可重建）
┌───────────────▼──────────────────────────────────────────────────────────┐
│ 只读查询与汇总（控制台、告警展示、状态摘要）                                │
└──────────────────────────────────────────────────────────────────────────┘

独立后台职责（彼此独立，不得合并为一个"成功"）
  · 通知投递调度（notify-flush）：只负责消息送达
  · A1a 恢复调度（未实现）：只负责满足条件后的边界恢复
```

**边界规则**

| 规则 | 含义 |
|---|---|
| 不新增平行执行引擎 | 新模块只能调用既有入口（Scheduler/编排器/受控恢复），不得自建任务状态机 |
| 单一写者 | 任务生命周期状态只有 `lib/store.mjs#saveTaskWithVersion` 一个写者（`state_version` 单调递增） |
| 只读默认 | 新模块默认只读；任何写能力必须显式声明并经审批（阶段 2 才引入） |
| 职责独立 | 通知投递与边界恢复是两条独立职责，状态各自记录，互不作为完成条件 |
| 证据不可覆盖 | 派生索引可重建；历史证据（审计、告警事件、提升记录）只能追加，不得被新尝试改写 |

---

## 2. 权威数据源表（Authority Table）

对每一类事实，标明**唯一权威来源**、写者、派生关系与损坏时的行为。

| 事实 | 权威来源 | 写者 | 派生/索引 | 损坏或不可读时 |
|---|---|---|---|---|
| 任务生命周期状态、`state_version` | `tasks/<task_id>.json` | `saveTaskWithVersion`（唯一写者，原子写 + fsync + rename） | 控制台列表、总览计数 | 解析失败 → **不可核验**，**不使用上一版本**、不推断 |
| 任务活动租约 | `locks/<task_id>.lock` | `tasklock.mjs`（`acquire/renew/release`） | 进度/存活展示（`isLockStale`） | 不可读 → 进度 `indeterminate`；**不推断任务已死** |
| 调度器运行元数据 | `runtime/scheduler.json` | `lib/scheduler.mjs`（原子写） | 陈旧锁恢复记录、运行摘要 | 缺失 = 未运行/无数据；损坏 = 不可核验 |
| 执行器运行事件 | `runtime/executor-runtime-events.jsonl` | `lib/executor-runtime-guard.mjs` | 执行器健康展示 | 逐行解析，坏行计数（保留有效前缀） |
| 操作者活动 | `runtime/operator-activity/**` | `lib/operator-control.mjs` | 人工操作时间线 | 同上 |
| 单次运行产物 | `runtime/runs/**` | 生命周期 | 运行详情 | 半截文件 → 不可核验 |
| 边界告警（开放/升级/关闭、次数） | **`boundary-alerts.jsonl` 事件日志** | `recordBoundaryAlert` / `resolveBoundaryAlert` | `.state.json` 仅作**派生索引**（由日志重放重建） | 日志不可信 → `unverifiable` + CLI **exit 3**；状态文件坏 → 从日志重建 |
| 恢复尝试与结果 | `<audit root>/recovery-*-intent.json` / `-result.json` | `recoverRetainedBoundary`（**两阶段**） | 控制台恢复面板 | 只有 INTENT 无 RESULT → 明确展示"恢复未完成" |
| 保护快照（还原基准） | `<snapshot dir>/**` | `protectPathsWithNonOwnerBoundary` | 恢复比对 | 缺失 → "无法精确还原"（不得猜测 mode） |
| 通知投递 | `<alert log>.notify.jsonl` + `.notify-pending.json` | `lib/boundary-notify.mjs` | `.notify.json` 去重索引（可重建） | 队列不可核验 → **exit 3**，**绝不显示"无待办"** |
| 候选/提升版本 | `refs/afr/canonical` + 任务字段 `baseline_oid`/`new_commit_oid`/`patch_digest`/`tree_oid` | `git-promoter` / `promoter`（CAS） | 提升记录展示 | git 对象缺失 → 不可核验，不得以任务字段"推断已提升" |
| 验收证据 | 任务字段 `acceptance_evidence_id` + 证据记录 | 验收引擎 | 控制台证据面板 | 证据缺失/重算失败 → 显示**未验证**（不得显示"通过"） |
| 授权账本 | `lib/trusted-import/ledger.mjs`（`AuthorizationLedger`、`revalidateAuthorizationClosure`） | 门禁/授权流程 | 提升前置校验 | closure 重算失败 → fail closed |
| 预期保护元数据 / epoch | **尚未持久化**（A1a 设计 §3.7 要求新增） | 未来：保护操作写入 | A1a 资格判定 | 未实现前 A1a 不得启用 |

**关键澄清**：`boundary-alerts.jsonl` 是告警的**唯一真源**，`.state.json` 是**派生索引**；
任务记录里的 `boundary_alert` 字段是**快照引用**，不作为告警状态的权威。

---

## 3. 状态字典

### 3.1 任务生命周期（`task.state`）

| 状态 | 含义 | 终态 |
|---|---|---|
| `CREATED` | 已创建，未入队 | 否 |
| `GOVERNANCE_PENDING` | 治理前置/门禁待决 | 否 |
| `AUTHOR_RUNNING` | 作者执行器运行中 | 否 |
| `REVIEW_RUNNING` | 评审执行器运行中 | 否 |
| `FIX_RUNNING` / `NEEDS_FIX` | 返修中 / 待返修 | 否 |
| `PARALLEL_RUNNING` | 多步计划并行批次执行中 | 否 |
| `TRUSTED_IMPORT_RUNNING` | V2 受信导入进行中 | 否 |
| `PUBLISHING` | 提升/发布中 | 否 |
| `WAITING_HUMAN` | 人工闸门待决 | 否（**A1a 视为不满足资格**） |
| `COMPLETED` | 完成 | **是** |
| `FAILED` | 失败（含门禁拒绝/验收失败） | **是** |
| `CANCELLED` | 已取消 | **是** |
| `CLOSED` | 已关闭归档 | **是** |

> 终态集合用于 A1a 资格判定（任务必须处于终态），**与进程是否存活无关**。

### 3.2 四带门（Gate Bands）

| 带 | 语义 | 处置 |
|---|---|---|
| `A` | 机械通过 | 可继续 |
| `B(i)` | 硬拒绝（安全/策略） | 阻塞，fail closed |
| `C` | 需验证者 | 需独立验证 |
| `D` | 等待人工 | 人工闸门 |

### 3.3 边界状态（`trusted_import.boundary_state`）

| 状态 | 含义 | 可自动恢复 |
|---|---|---|
| `DISENGAGED` | 保护已按快照还原 | 不适用（已完成） |
| `PROTECTION_RETAINED_PENDING_RECOVERY` | 保护被保留，等待恢复 | 满足资格时可（A1a，未启用） |
| `RESTORE_INCOMPLETE` | 释放已发生但完整性无法确认 | **永不**（首版仅人工） |
| `RECONCILE_REQUIRED` / `RECONCILE_RECORD` | **A1a 设计新增**：已修改或无法确认 / 物理已恢复但记录未完成 | 否（人工核对） |

### 3.4 告警（事件日志）

| 事件 | 含义 |
|---|---|
| `boundary_retained` | 边界被保留（含 `occurrences`、`severity`、`scope_decision` 快照） |
| `boundary_released` | 告警关闭（受控恢复成功） |

派生查询语义：`inspectBoundaryAlerts()` → `{ok, alerts, source: event-log｜event-log-partial｜state-only｜none｜unverifiable}`。
**`unverifiable` 必须非零退出（3）**，绝不当作"无告警"。

### 3.5 通知投递

| 维度 | 取值 |
|---|---|
| 模式 | `off`（默认）/ `dry-run` / `live` |
| 格式 | `generic` / `feishu`（文本）/ `feishu-card`（2.0 卡片）/ `dingtalk` / `wecom` / `slack` / `discord` / `ntfy` |
| 单次投递状态 | `would-notify` / `sent` / `failed` / `suppressed` / `oversized-request-body` / `settle-failed` / `retry-failed` / `exhausted` |
| 队列条目状态 | `pending` / `exhausted` / `delivered`（成功即结清条目） |
| 可核验性 | `ok` / `unverifiable`（队列损坏时，CLI exit 3） |

### 3.6 恢复审计（`af-boundary-recovery-v1`）

| 阶段 | 记录 | 作用 |
|---|---|---|
| INTENT | `recovery-<stamp>-intent.json` | **修改前**落盘；写不进则**绝不修改边界** |
| RESULT | `recovery-<stamp>-result.json` | 结果落盘；失败 → `delivered=false` + `BOUNDARY_AUDIT_INCOMPLETE` |

### 3.7 执行器健康（**独立于任务状态**）

`executor-ops` / `executor-router` / `executor-runtime-guard` 的断路器与路由状态：
`CLOSED` / `OPEN_COOLDOWN` / `OPEN_MANUAL_RESET` / `HALF_OPEN` / `PROBING`，以及对不可解析健康输出的
`UNPARSEABLE`。这些是**执行器可用性**状态，**不得**与任务生命周期状态混为一谈。

### 3.8 A1a 恢复调度（设计，未实现）

`IDLE → SWEEP_SELECTED → ELIGIBILITY_CHECKED → LOCKED → REVERIFIED → MUTATION_AUTHORIZED →
MUTATION_STARTED → RELEASE_DONE → VERIFIED_RESTORE → RESULT_AUDITED → TASK_PERSISTED →
ALERT_CLOSED → COMPLETE`，另有 `SKIPPED_*` / `DEFERRED_*` / `ABORTED_*` / `RECONCILE_REQUIRED` /
`RECONCILE_RECORD` / `EXHAUSTED`。详见 `A1A-AUTO-RECOVERY-DESIGN.md`。

---

## 4. 证据关联规范（Correlation）

| 关联键 | 出现位置 | 说明 |
|---|---|---|
| `task_id` | 任务记录、锁、运行事件、操作者活动、证据 | 主键 |
| 资产键 = `realpath(canonical_dir)` + `realpath(cas_dir)` | 任务 `trusted_import`、告警、恢复审计、快照、通知 | 边界/通知按资产关联 |
| `alert_id` | 告警事件日志、通知投递记录、任务 `boundary_alert` | 告警生命周期 |
| recovery ID（`recovery-<stamp>`） | 恢复 INTENT/RESULT、A1a 审计 | INTENT↔RESULT 配对 |
| `acceptance_evidence_id` | 任务记录、证据记录 | 验收证据 |
| `executor_run_id` / 执行器名 | 任务记录、运行事件、runs/ | 作者/评审执行 |
| `baseline_oid` / `new_commit_oid` / `patch_digest` / `tree_oid` / `refs/afr/canonical` | 任务记录、CAS、git ref | 提升溯源 |
| `epoch_id` / `snapshot_id` | 未来：保护批次记录、A1a 状态 | 保护批次（A1a 实施时引入） |
| `state_version` | 任务记录 | **单调递增**；用于拒绝陈旧恢复计划（旧版本写入必须失败） |

**规则**

1. **缺失即"未关联"**：列出已有键值，**绝不**用时间接近等启发式配对。
2. **单向缺失可解释**：例如告警已记录但任务记录未落盘（崩溃窗口）→ 标 `unmatched_source`，不隐藏。
3. **双向可追溯**：任务详情能列出其告警/恢复/通知；告警能反查任务（按资产键）。
4. **不可重写**：同一 `task_id` 的"重新执行"建立**新尝试**（新 run id），旧证据保留。

---

## 5. 接口契约

### 5.1 只读接口（无副作用；控制台与展示层只能使用这些）

| 接口 | 返回 | 副作用 |
|---|---|---|
| `readTaskFile()` / `loadTask()` | 任务记录（严格解析） | 无 |
| `readLock()` / `isLockStale()` | 租约与陈旧判定 | 无 |
| `inspectBoundaryAlerts()` / `readBoundaryAlertEvents()` | 告警状态与事件 | 无（坏状态文件会**自动重建**，属修复非业务写） |
| `loadPathSnapshot()` | 快照内容 | 无 |
| `readNotifyEvents()` / `inspectPendingNotifications()` | 投递记录与队列状态 | 无 |
| `inspectWriterScopes()` / `evaluateScopeScan()` | scope 探测结果（不修改） | 无 |
| `readRunEvents()` / 操作者活动读取 | 运行事件 | 无 |

### 5.2 需审批/审计的操作（**不得由前端直接拼接**）

| 操作 | 入口 | 必备条件 |
|---|---|---|
| 受控恢复 | `af-admin boundary recover`（或受控回调） | 理由必填、两阶段审计、**默认拒绝猜测**；A1a 实施后还需资产锁 |
| 通知重试 | `af-admin boundary notify-flush` | 仅 `live` + `--confirm` |
| 通知测试 | `af-admin boundary notify-test` | 仅 `live` + `--confirm` |
| 提升/授权 | 既有门禁与提升流程 | 授权 closure、四带门、硬 G |
| 任务取消/重跑（未来） | 任务服务 | 幂等标识 + 审计；**不得绕过评审/验收/安全边界** |

### 5.3 退出码约定（跨模块统一）

| 码 | 含义 |
|---|---|
| `0` | 成功 / 无待办 |
| `1` | 存在需处理状态（开放告警、待重试、耗尽、需人工核对） |
| `2` | 用法或配置错误（缺参数、模式不允许） |
| `3` | **不可核验**（告警状态/通知队列损坏）——**绝不等于"无"** |

---

## 6. 缺失 / 损坏 / 陈旧 / 不可读 的统一行为

| 情形 | 展示 | 退出码 | 禁止 |
|---|---|---|---|
| 文件不存在 | `missing`（未产生/未启用） | 视上下文 | 不得显示为"正常" |
| 存在但不可读（权限/IO） | `unverifiable` + 原因 | 非零 | 不得回退到旧值 |
| 存在但解析失败（半截写入） | `unverifiable`；提示可能正在写入 | 非零 | **不得**显示上一版本 |
| JSONL 存在坏行 | 有效前缀 + `bad_lines=N` | 视上下文 | 不得丢弃整文件或谎报完整 |
| 数据陈旧 | 标 `stale` + `as_of` | 0/1 | 不得静默当作当前 |
| 来源冲突 | 两者都显示 + `conflict` + 权威优先级 | 非零 | 不得择一隐藏 |
| 关联缺失 | `unmatched_source` | 0 | 不得猜测配对 |

**权威优先级**（用于冲突展示，不用于覆盖）：告警事件日志 > 任务记录 > 派生索引 > 列表推断。

---

## 7. 版本与兼容规则

1. **任务记录**：`state_version` 单调递增（唯一写者维护）；只允许**新增字段**（向后兼容）；
   删除/改义字段必须走显式迁移并保留旧字段一段时间。
2. **派生索引**：`.state.json`（告警）、`.notify.json`（去重）等**必须可由真源重建**，不得成为唯一副本。
3. **审计与证据**：schema 版本字段（如 `af-boundary-recovery-v1`、`af-boundary-alert-v1`）随写入固定；
   读取端遇到未知版本 → 标 `unknown-schema` 并显示原始记录引用，**不解释**。
4. **原子写**：所有权威记录沿用既有"tmp + fsync + rename + fsync(dir)"路径。
5. **禁止静默迁移**：任何写回旧记录的迁移动作都必须可审计、可回滚、且不在读取路径上发生。

---

## 8. 阶段 0 验收映射

| 计划书验收 | 本文档对应 |
|---|---|
| 同一任务可从提交追溯至执行、评审、验收、提升 | §2 权威表 + §4 关联规范（键与双向追溯） |
| 不能把不可确认显示为正常 | §6 统一行为 + §5.3 退出码 3 |
| 不制造第二套事实来源 | §1 边界规则（单一写者、派生可重建、证据不可覆盖） |

**未决问题**

1. 任务记录 schema 的正式版本字段（当前为 `state_version` + 字段增量），是否需要一个顶层 `record_schema_version`？
2. 执行器健康状态是否需要进入控制台"总览"（会与任务状态并列，需避免混淆）？
3. 证据（验收输出）是否需要独立的保留策略与容量上限（与阶段 3 的磁盘策略一并定）。
4. 资产键在 `cas_dir` 变更（迁移/重建）时如何保持关联稳定（是否需要稳定 `asset_id`）。

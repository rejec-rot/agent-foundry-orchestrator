# A1a 自动边界恢复调度：设计（评审稿 v2，**不实现、不启用**）

状态：**设计评审稿 v2**。本文件不改变任何行为；当前生产默认仍不自动恢复任何边界。
基线版本：`8361212`（v1 设计）→ 本稿为 v2 修订。代码基线：`c071968` + 设计提交。

> **首要边界（评审明确要求）**：**自动边界恢复与 `notify-flush` 是两个独立调度职责**。
> 各自状态、存储、锁、退出码与告警；**任一方的"成功"都不得作为另一方的完成条件**。详见 §7。

---

## 修订记录（v2，依据评审）

### 四处安全边界修订（**必须**，否则不得进入实施）

| # | v1 的问题 | v2 的规则 |
|---|---|---|
| **R1** | §4 允许 TTL 过期后接管恢复锁，只在 RESULT 阶段校验 token —— **检查太晚**，两个进程可能已同时改权限 | **活着的持有者绝不因超时被接管**；身份或存活**不可确认即拒绝**；持有者确认死亡后**必须先核对未完成恢复**，**不得直接重做**（§4.2、§1.3） |
| **R2** | 只有 A1a 用恢复锁，挡不住生命周期启动新任务或人工恢复；只锁 `canonical_dir` | **所有会修改同一资产的入口共用资产互斥协议**（生命周期 engage/disengage、人工 `boundary recover`、A1a）；锁集 = 真实路径 canonical + CAS + **全部受保护路径**，并处理**目录别名（dev:ino）**与**跨资产重叠路径**；**协议落地前 A1a 不得启用**（§4.1、§4.3、§4.5） |
| **R3** | F10"校验失败后重试"与首版禁止自动处理 `RESTORE_INCOMPLETE` 矛盾；F13"恢复中被杀→接管重试"不成立 | 三分类：**证明未修改 → 可重试**；**已修改或无法确认 → 人工核对**；**物理恢复成功但审计/落盘失败 → 记录核对态，禁止再次释放**（§1.3、§6 F10/F11/F12/F13） |
| **R4** | 现有 `recoverRetainedBoundary()` 在 `report.restored === true` 分支**先关告警**（异常被吞），**后**由 `finish()` 写 RESULT —— 顺序错误且失败被隐藏 | 明确定序：**释放 → 逐条复验 → RESULT 审计 → 任务落盘并重读 → 关闭告警 → `COMPLETE`**；关闭失败**不得吞掉**，降级为**记录核对态**并升级（§7.5） |

### 六个开放问题的首版决定

| 问题 | 决定 |
|---|---|
| 白名单 | **精确 `canonical_dir` + `cas_dir` 资产组合**，可选 `task_id` 限定；**恢复预算绑定具体"保护批次/快照 epoch"，不得按目录永久累计**（§2、§3.9） |
| 耗尽告警 | **新增恢复耗尽事件**（`a1a_recovery_exhausted`）并**关联原告警**；**不伪造"连续保留次数"**（§5） |
| 巡检与退避 | 巡检 **5 分钟**、退避 **1 分钟起**；**注明实际执行发生在下一次巡检**，不承诺"1 分钟后重试"（§5） |
| 恢复通知 | **默认关闭**，可显式开启；**不影响恢复成功判定**（§7） |
| 审计目录 | **同一受保护审计根目录下的子目录**，以 **recovery ID** 关联（§2、§5） |
| 恢复不完整 | 首版**仅人工核对**；**不新增"一键重试"**（§6 F15） |

### 两处澄清（已并入资格判定）

- **"任务终止"必须单独检查任务终态**（`task.state`），**不能用进程终止代替**（进程已退出 ≠ 任务已终结）（§3.3）。
- **保护期间的核验基准是"预期保护元数据"**（保护批次记录：`uid/gid/mode` 期望值），**不是原始权限快照**；原始快照只用于**恢复还原**与**漂移检测**（§3.7）。

---

## 0. 目标与非目标

**目标**：对已处于 `PROTECTION_RETAINED_PENDING_RECOVERY` 的边界，在**全部资格条件明确满足**时，
由调度器重试一次**受控恢复**（等价于人工执行 `af-admin boundary recover`，但需理由与审计），
缩短"仓库被长期锁住"的窗口，且**不降低任何安全保证**。

**非目标（首版明确不做）**

| 不做 | 原因 |
|---|---|
| 自动处理 `RESTORE_INCOMPLETE` / 已修改但校验失败 | 释放已发生或可能已发生，完整性无法确认 → **一律人工** |
| 自动 `force` / `acknowledgeLiveScopes` / `allowGuessedModes` | 猜测或强制解锁会掩盖真实异常；调度器**没有任何代码路径**可触达这些参数 |
| 自动处理 scope 异常（`anomalies`） | 异常只能人工解释，绝不能被"重试掉" |
| 自动恢复白名单外的仓库/任务 | 未显式授权的资产永不被调度器触及 |
| 把恢复成功等同于任务成功 | 恢复只改 `boundary_state`；任务 REJECT/FAIL 不受影响 |
| 跨主机并发互斥 | 首版**仅支持同主机**；跨主机/容器不可确认存活时**一律拒绝**（§4.2） |

---

## 1. 状态转换表

### 1.1 边界状态（既有，不变）

| 当前 | 事件 | 下一个 | 触发者 |
|---|---|---|---|
| `PROTECTED` | 任务结束、scope 明确为空 | `DISENGAGED` | 生命周期（既有） |
| `PROTECTED` | scope 非空/异常/预算耗尽 | `PROTECTION_RETAINED_PENDING_RECOVERY` | 生命周期（既有，A2） |
| `PROTECTED` | 释放执行但无法验证 | `RESTORE_INCOMPLETE` | 生命周期（既有），**A1a 永不触碰** |
| `PROTECTION_RETAINED_PENDING_RECOVERY` | A1a 受控恢复成功且**全部**校验/记录完成 | `DISENGAGED`（告警关闭） | **A1a（本设计）** |
| `PROTECTION_RETAINED_PENDING_RECOVERY` | 资格不满足 / 恢复被拒 | 不变 | A1a |
| `PROTECTION_RETAINED_PENDING_RECOVERY` | 已修改或无法确认 | **`RECONCILE_REQUIRED`**（人工） | A1a |
| `PROTECTION_RETAINED_PENDING_RECOVERY` | 物理恢复成功、记录未完成 | **`RECONCILE_RECORD`**（人工/记录核对） | A1a |
| `PROTECTION_RETAINED_PENDING_RECOVERY` | 尝试耗尽 | 不变 + **恢复耗尽告警** | A1a |

### 1.2 恢复运行状态机（A1a 新增，按资产 × 保护 epoch）

```
IDLE
 └─(白名单命中)→ SWEEP_SELECTED
      └─(§3 全部明确真)→ ELIGIBILITY_CHECKED
           └─(取得资产锁集)→ LOCKED
                └─(锁内复验通过)→ REVERIFIED
                     └─(MUTATION_STARTED 审计写成功)→ MUTATION_AUTHORIZED → MUTATION_STARTED
                          └─ RELEASE_DONE → VERIFIED_RESTORE
                               └─ RESULT_AUDITED → TASK_PERSISTED → ALERT_CLOSED → COMPLETE
```

| 步骤 | guard | 成功 → | 失败/未知 → | 审计事件 |
|---|---|---|---|---|
| `SWEEP_SELECTED` | 白名单命中且状态为保留 | 下一步 | `SKIPPED_NOT_ALLOWLISTED` / `SKIPPED_WRONG_STATE` | `a1a_skip` |
| `ELIGIBILITY_CHECKED` | §3 全部明确真 | 下一步 | `REFUSED_INELIGIBLE(reason)` | `a1a_ineligible` |
| `LOCKED` | 取得**资产锁集**（§4.1） | 下一步 | `DEFERRED_LOCK_HELD`（**不计失败**） | `a1a_lock_deferred` |
| `REVERIFIED` | 锁内重做 §3.3–§3.9（**不沿用巡检快照**） | 下一步 | `ABORTED_STATE_CHANGED(reason)` | `a1a_abort` |
| `MUTATION_AUTHORIZED` | **写 `MUTATION_STARTED` 审计成功**（写失败则**绝不改权限**） | 下一步 | `REFUSED_INELIGIBLE(audit-unwritable)` | `a1a_mutation_gate` |
| `MUTATION_STARTED` | 首个权限修改动作之前落盘 | — | — | `a1a_mutation_started` |
| `RELEASE_DONE` | `releasePathsBoundary()`（无 force 类参数） | 下一步 | 见 §1.3 三分类 | `a1a_attempt` |
| `VERIFIED_RESTORE` | 报告 `restored === true`，`mismatches`/`failures` 为空，逐条比对通过 | 下一步 | `RECONCILE_REQUIRED`（**已修改**） | `a1a_verify` |
| `RESULT_AUDITED` | RESULT 审计写入成功 | 下一步 | `RECONCILE_RECORD`（**禁止再次释放**） | `a1a_result` |
| `TASK_PERSISTED` | 任务状态落盘**并重读一致** | 下一步 | `RECONCILE_RECORD` | `a1a_persist` |
| `ALERT_CLOSED` | 告警按正常路径关闭**成功** | `COMPLETE` | `RECONCILE_RECORD`（**不得静默成功**） | `a1a_alert_closed` |
| 预算耗尽 | 计数 ≥ 上限（**同一 epoch**） | `EXHAUSTED`（人工） | — | `a1a_recovery_exhausted` |

**幂等性**：`COMPLETE` 后条目终结；重复巡检见 `DISENGAGED` → `SKIPPED_WRONG_STATE`。
**epoch 绑定**：预算键 = `(asset, snapshot_id/epoch_id)`；**新的保护批次产生新 epoch → 预算从 0 起算**，不按目录永久累计。

### 1.3 未完成恢复的三分类（**R3 的核心**）

检测到"存在 INTENT 但没有终态"时，依据**已落盘的阶段证据**分类，**不得假定保护仍完整**：

| 已知证据 | 分类 | 允许动作 | 禁止 |
|---|---|---|---|
| 仅 `INTENT`，**无 `MUTATION_STARTED`** | **证明未修改** | 可保留并按 §5 规则重试（计入同 epoch 预算） | — |
| `MUTATION_STARTED`，无 `RESULT`（含进程被杀） | **已修改或无法确认** | `RECONCILE_REQUIRED`：人工核对权限/元数据 | **禁止再次释放**、禁止假定保护完整 |
| `RESULT` 成功且 `restored === true`，但任务落盘或告警关闭未完成 | **物理恢复成功、记录未完成** | `RECONCILE_RECORD`：只做记录核对与补写 | **禁止再次执行权限释放** |
| `RESULT` 存在但 `restored === false`（`mismatches`/`failures`） | **已修改、校验失败** | `RECONCILE_REQUIRED` → 人工 | 首版不自动重试 |

> 只有第一行允许自动继续；其余三行**全部转人工**，并在告警中明确写出"已发生的修改阶段"。

---

## 2. 配置说明（全部默认关闭）

| 键（环境变量） | 默认 | 含义 |
|---|---|---|
| `AF_A1A_MODE` | `off` | `off` \| `dry-run` \| `live`。**`off` 时调度器不读取、不锁定、不尝试任何资产** |
| `AF_A1A_ALLOWLIST_FILE` | 无 | 白名单文件；**未配置 = 无任何资产被考虑** |
| `AF_A1A_INTERVAL_MS` | 300000 | 巡检间隔（5 分钟） |
| `AF_A1A_MAX_ATTEMPTS` | 3 | **单个保护 epoch** 的自动恢复尝试上限 |
| `AF_A1A_RETRY_BASE_MS` / `AF_A1A_RETRY_MAX_MS` | 60000 / 1800000 | 指数退避与封顶 |
| `AF_A1A_LOCK_TTL_MS` | 600000 | 锁的**写入时间戳**（用于展示与告警）；**不作为接管依据**（§4.2） |
| `AF_A1A_QUEUE_FILE` | `<audit root>/a1a/state.json` | 调度状态（epoch、尝试数、`next_attempt_at`、终态），**原子写** |
| `AF_A1A_AUDIT_SUBDIR` | `a1a` | 审计根目录下的子目录；恢复 INTENT/RESULT 在 `recovery` 子目录，**由 recovery ID 关联** |
| `AF_A1A_NOTIFY_ON_SUCCESS` | `0` | 恢复成功后是否外发通知（**默认关闭**，且不影响成功判定） |
| `AF_CGROUP_BASE` / `AF_SCOPE_RESCAN_BUDGET` / `AF_BOUNDARY_ALERTS_FILE` / `AF_BOUNDARY_AUDIT_DIR` | 既有 | 复用既有语义，不新增开关 |

**白名单格式（示意）**——精确资产组合 + 可选任务限定：

```json
{ "schema": "af-a1a-allowlist-v1",
  "assets": [
    { "canonical_dir": "/srv/repo-a", "cas_dir": "/srv/cas-a", "task_id": null, "max_attempts": 3 }
  ] }
```

- `canonical_dir` 与 `cas_dir` **两者都精确匹配**（`realpath` 后比对）；不做前缀/通配。
- 白名单之外：`SKIPPED_NOT_ALLOWLISTED`，**不写状态、不加锁**。
- `dry-run`：完整执行资格判定、加锁、锁内复验，并记录"**将要**恢复"的审计；**零变更**（不释放、不改权限、不关告警）。
- **无测试用生产放行开关**：`dry-run` 是正式运行模式，不是绕过。

---

## 3. 自动恢复资格（全部为**明确真**；任一未知即拒绝）

| # | 条件 | 证据来源 | 未知/失败时 |
|---|---|---|---|
| 3.1 | 资产（canonical+CAS）在**白名单**内 | 白名单文件（realpath 比对） | `SKIPPED_NOT_ALLOWLISTED` |
| 3.2 | 边界状态 == `PROTECTION_RETAINED_PENDING_RECOVERY` | 任务记录 `trusted_import.boundary_state` | 拒绝（`RESTORE_INCOMPLETE`/`DISENGAGED`/`RECONCILE_*` 一律跳过） |
| 3.3 | **任务处于终态**（**独立检查任务状态**，不得用进程终止代替） | `task.state ∈ {COMPLETED, FAILED, CANCELLED, BLOCKED}` | 拒绝。**`WAITING_HUMAN` 视为不满足**（人工闸门待决）；`AUTHOR_RUNNING`/`TRUSTED_IMPORT_RUNNING` 拒绝 |
| 3.4 | 写者终止证据齐全 | `writer_termination{process_started, process_group_alive===false, scope_verified, termination_confirmed===true}` 齐备且**互不矛盾** | 拒绝 |
| 3.5 | scope 扫描**明确为空** | `decideWriterScopesEmpty({quiesceConfirmed:true})` → `UNLOCK`，且 `status==='empty'`、`anomalies` 为空 | 拒绝（`active`/`unknown`/异常**一律拒绝**） |
| 3.6 | 快照有效（**用于还原**） | `loadPathSnapshot(canonical)`、`loadPathSnapshot(cas)` 均存在、可解析、条目完整 | 拒绝（**不允许** `allowGuessedModes`） |
| 3.7 | 保护**符合预期保护元数据** | **保护批次记录（epoch）**：期望 `uid=0,gid=0`、目录 `0555`、文件 `0444`（与保护操作一致），逐条比对为 0 差异 | 拒绝。**注意：基准是"预期保护元数据"，不是原始权限快照**；原始快照仅用于还原与漂移检测 |
| 3.8 | 恢复审计**可写** | 预检：向审计子目录写探针并删除 | 拒绝 |
| 3.9 | **同 epoch 预算未耗尽** | `a1a/state.json`（键 = asset+epoch） | `EXHAUSTED` → 人工 |
| 3.10 | **不存在需人工核对的未完成恢复** | INTENT / MUTATION_STARTED / RESULT 三分类（§1.3） | 非"证明未修改" → `RECONCILE_REQUIRED` / `RECONCILE_RECORD`，**不自动释放** |
| 3.11 | 可取得**资产锁集**且无重叠冲突 | §4.1/§4.3 | `DEFERRED`（锁被占）或**拒绝**（重叠冲突，fail closed） |
| 3.12 | 通知层状态**不参与**资格 | —— | 通知不可用**不阻止**恢复（§7） |

---

## 4. 并发控制（**R1 + R2**）

### 4.1 共享资产互斥协议（覆盖**所有**修改入口）

**唯一的加锁入口**：`withAssetLockSet(asset, fn)`（实施阶段新增），由**全部**会修改资产的路径使用：

| 入口 | 现状 | 实施要求 |
|---|---|---|
| `engageTaskHostBoundary()` | 无资产锁 | **必须**经 `withAssetLockSet` |
| `disengageTaskHostBoundary()` | 无资产锁 | **必须**经 `withAssetLockSet` |
| `recoverRetainedBoundary()`（人工 + A1a） | 无资产锁 | **必须**经 `withAssetLockSet` |
| `af-admin boundary recover` | 直接调用上者 | 继承锁（并暴露 `--wait` 语义） |
| 新任务生命周期 | 无资产锁 | 进入受保护资产前**必须**取锁 |

**锁集**（同一资产可能涉及多个路径）：

- `realpath(canonical_dir)`、`realpath(cas_dir)`、**该 epoch 记录中的全部受保护路径**；
- 每项以 `dev:ino` 参与**身份判定**：同一 inode 的不同路径（符号链接、bind mount、硬链接目录）→ **同一把锁**；
- 多把锁**按 digest 排序后顺序获取**（全局定序，防死锁）；任一获取失败 → 释放已获取的锁并 `DEFERRED`/拒绝。

### 4.2 存活判定与"禁止超时接管"（**R1**）

锁内容（claim 时写入，`MUTATION_STARTED` 时**更新**）：

```json
{ "schema":"af-a1a-lock-v1", "token":"…", "host":"…", "boot_id":"<uuid>",
  "pid":12345, "pid_start_ticks":"…", "acquired_at":"…", "phase":"REVERIFIED|MUTATION_STARTED|…",
  "asset":{"canonical_ino":"dev:ino","cas_ino":"dev:ino","protected_ino":["dev:ino"]},
  "epoch_id":"…", "snapshot_id":"…" }
```

| 情形 | 判定 | 动作 |
|---|---|---|
| 同 `boot_id` + pid 存在 + `pid_start_ticks` **一致** | **持有者存活** | **绝不接管**（无论经过多久、无论 TTL） |
| pid 不存在，或 `pid_start_ticks` 不一致（PID 复用） | **持有者已死亡** | **不得直接重做** → 进入 §1.3 三分类核对 |
| `/proc` 不可读、`boot_id` 不同、跨主机/容器、字段缺失 | **不可确认** | **拒绝**（`REFUSED_INELIGIBLE(lock-owner-unverifiable)`），不接管 |
| 锁文件损坏/无法解析 | **不可确认** | **拒绝**，人工核对（不得删除后抢占） |

**结论**：TTL **只用于展示与告警**（"锁已持有过久，请人工核对"），**从不作为接管依据**；
"恢复必须快"不再是安全假定，而是**性能目标**。

### 4.3 重叠与别名冲突（fail closed）

- 若资产 A 的锁集与资产 B 的锁集存在**交集**（同一 `dev:ino` 或其祖先/后代关系），
  则两者**不得同时恢复**：后来者 `REFUSED_INELIGIBLE(asset-overlap)` 并升级告警（提示合并不一致的保护批次）。
- 目录别名（符号链接/bind mount）经 `dev:ino` 归一后同锁；**无法归一**（如跨挂载点不可判定）→ 拒绝。

### 4.4 锁内复验（不允许信任巡检快照）

`REVERIFIED` 在**持锁之后**重做 §3.3–§3.10（任务终态、终止证据、scope、快照、**预期保护元数据**、审计可写、未完成恢复状态）。
与巡检结论不一致 → `ABORTED_STATE_CHANGED`，**不做任何修改**。

### 4.5 实施硬前置（gating）

> **在 `withAssetLockSet` 落地并被生命周期、人工恢复、A1a 三处共同使用之前，A1a 不得以 `live` 启用。**
> 该前置写入实施计划的首个里程碑，并由验收测试断言（§9）。

---

## 5. 失败有界且可见

| 机制 | 设计 |
|---|---|
| 退避 | 第 n 次失败后等待 `min(base × 2^(n-1), max)`；base 默认 1 分钟 |
| **巡检节拍** | 巡检默认 **5 分钟**；退避只决定"下一次巡检时是否到期"，**不承诺 1 分钟后执行** |
| 上限 | **同 epoch** 内尝试数达 `AF_A1A_MAX_ATTEMPTS`（默认 3）→ `EXHAUSTED`，不再自动重试 |
| 耗尽可见 | **新增 `a1a_recovery_exhausted` 事件并关联原告警**（`alert_id`），**不伪造 `occurrences`**；任务记录 `auto_recovery.exhausted_at`；CLI 非零退出 |
| 重启续查 | epoch/尝试数/`next_attempt_at` **原子落盘**；新进程按同一文件续查 |
| 崩溃续投 | **不做 TTL 接管**；由 §1.3 三分类决定"可重试 / 人工 / 记录核对" |
| 禁止静默 | 每次尝试、每次跳过、每次中止都写审计（含 INTENT/recovery ID 关联） |
| 审计布局 | 同一受保护审计根下：`<root>/recovery/<recovery-id>-{intent,result}.json`、`<root>/a1a/<epoch>-*.json`，**以 recovery ID 关联** |
| 观测 | `af-admin a1a status`（模式 / 白名单数 / 各资产 epoch 与阶段 / 待尝试 / 延后 / 耗尽 / 需人工核对）、`af-admin a1a explain <canonical>`（逐条资格判定） |

---

## 6. 故障验收矩阵（v2：F10–F13 重写，新增 F19–F24）

| # | 故障/场景 | 检测方式 | 期望行为 | 可见信号 | 退出码 | 重试 | 人工动作 |
|---|---|---|---|---|---|---|---|
| F1 | scope 非空（活跃写者） | `status==='active'` | 拒绝，保持保留 | `a1a_ineligible(active-writer)` | 1 | 退避后重试 | 排查写者 |
| F2 | scope 不可确认 | `status==='unknown'`/`reason` 非空 | 拒绝 | `a1a_ineligible(scope-unknown)` | 1 | 退避后重试 | 人工确认 |
| F3 | scope 异常 | `anomalies.length>0` | **拒绝且不因重试消失** | `a1a_ineligible(scope-anomaly)` + 升级 | 1 | **不重试** | 必须人工 |
| F4 | 写者终止证据缺失/矛盾 | 字段缺失或不一致 | 拒绝 | `a1a_ineligible(termination-evidence)` | 1 | 不自动重试 | 补证据 |
| F5 | 快照缺失/损坏 | `loadPathSnapshot()` 空或解析失败 | 拒绝（**不得猜 mode**） | `a1a_ineligible(snapshot-invalid)` | 1 | 不自动重试 | 人工受控恢复 |
| F6 | **不符合预期保护元数据** | 与**epoch 期望**逐条比对（`uid/gid/mode`）出现差异 | 拒绝 | `a1a_ineligible(protection-expectation-mismatch)` + 升级 | 1 | 不自动重试 | 人工排查 |
| F7 | 恢复审计不可写 | 预检失败 | 拒绝，边界不变 | `a1a_ineligible(audit-unwritable)` | 1 | 退避后重试 | 修权限/磁盘 |
| F8 | 资产锁被**存活**持有者占用 | §4.2 判定存活 | **延后**（不计失败、**绝不接管**） | `a1a_lock_deferred` | 0 | 下一轮巡检 | 无需（过久则告警提示） |
| F9 | 锁内复验发现状态变化 | 复验 ≠ 巡检 | 中止，不修改 | `a1a_abort(state-changed)` | 1 | 不重试 | 人工确认 |
| **F10** | **释放已修改但校验失败**（`mismatches`/`failures` 非空） | 释放报告 | **`RECONCILE_REQUIRED`**：**不重试**、不假定保护完整 | `a1a_verify_failed` + 升级（含已修改阶段） | 1 | **禁止自动重试** | **必须人工** |
| **F11** | **RESULT 审计写入失败** | `result_ok === false` | **`RECONCILE_RECORD`**：物理已恢复，**禁止再次释放** | `a1a_incomplete_audit` + 升级 | 1 | 不重试 | 记录核对 |
| **F12** | **任务状态落盘失败** | `saveTask` 抛错或重读不一致 | **`RECONCILE_RECORD`** | `a1a_incomplete_persist` + 升级 | 1 | 不重试 | 记录核对 |
| **F13** | **恢复中被杀** | 有 `MUTATION_STARTED` 无 `RESULT` | **`RECONCILE_REQUIRED`**（不可假定未修改） | `a1a_interrupted` + 升级 | 1 | **不自动重试** | 人工核对元数据 |
| F13b | 被杀但**仅有 INTENT**（未进入修改） | 无 `MUTATION_STARTED` | 证明未修改 → 可保留并按规则重试 | `a1a_not_mutated` | 1 | 退避后重试 | 无需 |
| F14 | 尝试耗尽（同 epoch） | 计数 ≥ 上限 | `EXHAUSTED`，停止自动重试 | `a1a_recovery_exhausted`（关联原告警） | 1 | 停止 | **必须人工** |
| F15 | 出现 `RESTORE_INCOMPLETE` | 任务状态 | **永不自动处理**（首版无人工一键重试） | `a1a_skip(restore-incomplete)` | 0 | 不重试 | 必须人工 |
| F16 | 通知层不可用/队列不可核验 | `inspectPendingNotifications().ok === false` | **不阻止恢复**；通知失败单独记录 | `boundary_notify` 事件（既有） | 通知侧 1/3 | 通知侧独立退避 | 见 §7 |
| F17 | 白名单缺失/为空 | 配置检查 | **不恢复任何资产** | `a1a_status(no-allowlist)` | 0 | — | 配置 |
| F18 | `dry-run` | `AF_A1A_MODE=dry-run` | 只判定与"将要恢复"审计，**零变更** | `a1a_would_recover` | 0 | — | 评审输出 |
| **F19** | **目录别名/Bind mount 指向同一资产** | `dev:ino` 归一后同锁 | 视为同一资产（不重复恢复） | `a1a_lock_alias` | 0/1 | 按同一资产 | 无需 |
| **F20** | **跨资产重叠保护路径** | 锁集交集检测 | **拒绝**（fail closed） | `a1a_ineligible(asset-overlap)` + 升级 | 1 | 不重试 | 合并/清理保护批次 |
| **F21** | **持有者死亡但存在未完成恢复** | §1.3 三分类 | **先核对，不直接重做** | `a1a_reconcile_required` | 1 | 仅"证明未修改"可重试 | **必须人工**（除 F13b） |
| **F22** | **告警关闭失败** | 关闭调用抛错 | **不标记完成** → `RECONCILE_RECORD` | `a1a_alert_close_failed` + 升级 | 1 | 不重试 | 记录核对 |
| **F23** | **锁身份不可确认**（跨主机/`/proc` 不可读/锁文件损坏） | §4.2 | **拒绝**，不接管 | `a1a_ineligible(lock-owner-unverifiable)` | 1 | 不重试 | **必须人工** |
| **F24** | **新保护 epoch 开始** | epoch_id 变化 | 预算重置为 0（不按目录累计） | `a1a_epoch_reset` | 0 | 正常 | 无需 |

---

## 7. 与 `notify-flush` 的职责隔离（**不得合并**）

| 维度 | 自动边界恢复（A1a） | 通知重试（`notify-flush`） |
|---|---|---|
| 目的 | 解除**真实**的边界保留 | 把**已发生**的告警送达渠道 |
| 状态存储 | `a1a/state.json`（epoch/尝试/退避/终态） | `<alert log>.notify-pending.json` |
| 锁 | **资产锁集**（共享协议） | 告警日志锁（投递 claim） |
| 前提 | §3 全部资格 | 存在待投递条目 |
| 失败含义 | 边界仍被保留（安全侧） | 消息未送达（可见性侧） |
| 耗尽后果 | `a1a_recovery_exhausted`（关联原告警） | 升级告警 + 转人工 |
| CLI | `af-admin a1a status`（失败→1） | `af-admin boundary notify-status`（待办→1；不可核验→3） |
| 交叉影响 | **通知不可用不阻止恢复**；恢复成功**可选**入队通知（`AF_A1A_NOTIFY_ON_SUCCESS`，默认关闭），但**两者状态各自记录** | 投递成功**绝不**代表恢复完成 |

**明确禁止的耦合**：①不得用"通知已送达"作为恢复完成条件；②不得用"恢复完成"作为投递完成条件；
③不得合成单一 `success` 字段/退出码/调度循环；④任一方的失败不得阻塞另一方（仅共享锁顺序约束）。

### 7.5 接线调整要求（**R4**，实施阶段必做）

| # | 现状（`lib/host-boundary.mjs`） | 要求 |
|---|---|---|
| 7.5.1 | `report.restored === true` 分支**先** `resolveBoundaryAlert()`，**后** `finish()` 写 RESULT | **调整顺序**：RESULT 审计 → （由调用方）任务落盘并重读 → **再**关闭告警 → 才返回成功 |
| 7.5.2 | 关闭告警的异常被 `catch { /* … */ }` **吞掉** | **不得吞**：关闭失败 → 结果降级为 **`RECONCILE_RECORD`**（物理已恢复、记录未完成）并升级；返回体暴露 `alert_closed: false` |
| 7.5.3 | 无"修改已开始"的落盘标记 | 新增 **`MUTATION_STARTED` 审计**：在**首个权限修改之前**写入；写失败则**不得修改权限** |
| 7.5.4 | 结果只有 `DISENGAGED` / `PROTECTION_RETAINED` / `RESTORE_INCOMPLETE` / `REFUSED` | 增加 **`RECONCILE_REQUIRED` / `RECONCILE_RECORD`**（或等价显式 reason），供调用方区分"可重试/人工/记录核对" |
| 7.5.5 | 告警关闭在边界层内部 | 关闭动作**移出**边界层（或改为显式回调），由编排/A1a 层在正确时点调用；人工路径同样遵守（或明确记录差异） |
| 7.5.6 | 无资产锁 | 生命周期 engage/disengage、人工恢复、A1a **全部**经 `withAssetLockSet`（§4.1） |

**顺序验收（实施阶段）**：测试断言 `RESULT 审计时间戳 < 任务落盘时间戳 < 告警关闭时间戳`；并构造"关闭告警失败"用例断言**不出现 `COMPLETE`**。

---

## 8. 停用与回滚流程

### 8.1 立即停用

1. `AF_A1A_MODE=off`，重启调度器单元；
2. **生效点**：每次尝试**之前**检查模式；**已在释放中的动作不打断**（中途放弃释放更危险）；
3. 确认：`af-admin a1a status` → `mode: off`、`attempts_in_flight: 0`；
4. 冻结单资产：从白名单移除该条目；
5. **不删**任何状态/审计文件（保留证据）。

### 8.2 残留锁处理（人工，留证据）

1. `af-admin a1a status --locks` 列锁与 claim 内容（pid/boot_id/start_ticks/phase/epoch）；
2. **仅当** §4.2 判定为"已死亡"且 §1.3 分类为"证明未修改"时，才允许清理锁并回到正常流程；
3. "已修改或无法确认" → **保持锁与状态不变**，按人工核对流程处理；
4. **禁止**删除锁文件后直接抢跑恢复（这等价于跳过核对）。

### 8.3 已完成恢复的回滚（谨慎）

- 恢复**不可逆**：若怀疑误判 → **重新施加保护**并调查：核对 `recovery-<id>-intent/result.json` 与 `a1a_*` 审计 →
  以**人工**方式重新 engage → 记录新的 INTENT/RESULT。**首版无自动重新保护**。
- **代码回滚**：先 `AF_A1A_MODE=off` → 回退到上一个 tag → 确认 `a1a` 子命令行为 → 保留审计副本后再清理状态。

### 8.4 停用后验证清单

- [ ] `AF_A1A_MODE=off` 重启后仍为 off
- [ ] `a1a status` 显示 `no-allowlist` 或白名单为空
- [ ] 无 `attempts_in_flight`；残留锁均有核对记录
- [ ] `boundary alerts` 与 `notify-status` 与恢复无关地正常
- [ ] 审计目录完整保留（`recovery/`、`a1a/`）

---

## 9. 实施阶段验收测试计划（本轮不实现）

| 组 | 用例（v2 增补以粗体标注） |
|---|---|
| 资格判定 | 12 条 guard 逐条构造未知/失败 → 必须拒绝；**任务 `WAITING_HUMAN` → 拒绝**；**进程终止但任务未终态 → 拒绝** |
| **预期保护元数据** | 与 epoch 期望比对（`uid/gid/mode`）；**对照原始快照的旧语义不再作为资格依据** |
| **锁协议** | 生命周期/人工/A1a 三入口互斥；**存活持有者不被 TTL 接管**（伪造旧 TTL + 存活 pid → 拒绝）；**PID 复用（start_ticks 不一致）→ 判定死亡但走核对**；**锁身份不可确认 → 拒绝** |
| **别名/重叠** | 符号链接与 bind mount → 同一把锁；跨资产重叠路径 → 拒绝 |
| **三分类核对** | 仅 INTENT → 可重试；MUTATION_STARTED 无 RESULT → `RECONCILE_REQUIRED`；RESULT 成功但落盘/关闭未完成 → `RECONCILE_RECORD`（**禁止再次释放**） |
| 崩溃/重启 | 状态原子写、epoch 绑定、重启续查、`a1a_recovery_exhausted` 关联原告警且不伪造次数 |
| **顺序接线** | `RESULT < 落盘 < 关闭告警` 的时间戳断言；关闭失败 → 非 `COMPLETE` |
| 禁止绕过（静态） | A1a 模块不含 `force:true`、`acknowledgeLiveScopes`、`allowGuessedModes`；`RESTORE_INCOMPLETE` 分支必为跳过 |
| 成功标准 | 逐条 mismatch → 不完成；RESULT 失败 → 不完成；落盘失败 → 不完成；关闭失败 → 不完成 |
| 职责隔离 | 通知不可核验时恢复仍可执行；恢复成功不改写投递状态；退出码独立 |
| dry-run / 端到端（合成） | 零变更；保留 → 资格满足 → `COMPLETE`；资格不满足 → 永不动手 |

---

## 10. 决定与残余风险

### 10.1 本轮决定（评审已定，见修订记录）

白名单=精确资产组合 + 可选 task、**预算绑定 epoch**；耗尽=**新事件 + 关联原告警**；
巡检 5 分钟 / 退避 1 分钟起（**实际在下一次巡检执行**）；通知默认关闭且不影响判定；
审计**同一根目录下分子目录 + recovery ID 关联**；`RESTORE_INCOMPLETE` **仅人工**。

### 10.2 残余风险与范围限制（须随设计一同评审）

1. **仅同主机**：跨主机/容器下锁身份不可确认 → 一律拒绝（F23）；首版不支持分布式互斥。
2. **`/proc` 依赖**：存活判定依赖 `pid_start_ticks` 与 `boot_id`；若目标环境无 `/proc`，A1a 不可用（拒绝）。
3. **共享 CAS 与重叠保护**：首版以"拒绝并升级"处理冲突（F20），**不做自动合并**。
4. **`WAITING_HUMAN` 的取舍**：本稿将"任务处于 `WAITING_HUMAN`"视为**不满足资格**（人工闸门待决）；
   若业务上希望 A1a 在人工闸门未决时也回收边界，需要单独评审（涉及"人工决策与自动恢复的优先级"）。
5. **epoch 记录尚不存在**：`protectPathsWithNonOwnerBoundary()` 目前只返回 `{protected, snapshots}`，
   **没有持久化的"预期保护元数据/epoch"记录**；实施阶段必须新增该记录（保护时写入），否则 §3.7 无基准。
6. **接线调整未做**：§7.5 的六项改动属于实施内容；**在此之前 A1a 不得启用**。

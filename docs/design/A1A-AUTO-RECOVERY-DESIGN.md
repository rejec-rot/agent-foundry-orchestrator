# A1a 自动边界恢复调度：设计（评审稿，**不实现、不启用**）

状态：**设计评审稿**。本文件不改变任何行为；当前生产默认仍不自动恢复任何边界。
基线版本：`c071968`（A2 覆盖 + A1b 通知层 + 四态卡片实发验收已完成）。

> **首要边界（评审明确要求）**：**自动边界恢复与 `notify-flush` 是两个独立调度职责**。
> 它们有各自的状态、存储、锁、退出码与告警；**任一方的"成功"都不得作为另一方的完成条件**。
> 详见 §7。

---

## 0. 目标与非目标

**目标**：对已处于 `PROTECTION_RETAINED_PENDING_RECOVERY` 的边界，在**全部资格条件明确满足**时，
由调度器重试一次**受控恢复**（等价于人工执行 `af-admin boundary recover`，但需理由与审计），
从而缩短"仓库被长期锁住"的窗口，且**不降低任何安全保证**。

**非目标（首版明确不做）**

| 不做 | 原因 |
|---|---|
| 自动处理 `RESTORE_INCOMPLETE` | 释放已发生但完整性无法确认，首版**一律转人工**，绝不自动重试 |
| 自动 `force` / `acknowledgeLiveScopes` / `allowGuessedModes` | 猜测或强制解锁会掩盖真实异常；调度器**没有任何代码路径**可触达这些参数 |
| 自动处理 scope 异常（`anomalies`） | 异常只能人工解释，绝不能被"重试掉" |
| 自动恢复白名单外的仓库/任务 | 未显式授权的资产永不被调度器触及 |
| 把恢复成功等同于任务成功 | 恢复只改变 `boundary_state`；任务的 REJECT/FAIL 状态不受影响 |

---

## 1. 状态转换表

### 1.1 边界状态（既有，不变）

| 当前 | 事件 | 下一个 | 触发者 |
|---|---|---|---|
| `PROTECTED` | 任务结束、scope 明确为空 | `DISENGAGED` | 生命周期（既有） |
| `PROTECTED` | scope 非空/异常/预算耗尽 | `PROTECTION_RETAINED_PENDING_RECOVERY`（保留下告警） | 生命周期（既有，A2） |
| `PROTECTED` | 释放执行但无法验证 | `RESTORE_INCOMPLETE` | 生命周期（既有），**A1a 永不触碰** |
| `PROTECTION_RETAINED_PENDING_RECOVERY` | **A1a 受控恢复成功且校验完整** | `DISENGAGED`（告警关闭） | **A1a（本设计）** |
| `PROTECTION_RETAINED_PENDING_RECOVERY` | A1a 资格不满足 / 恢复被拒 | 不变（保持保留） | A1a |
| `PROTECTION_RETAINED_PENDING_RECOVERY` | A1a 尝试耗尽 | 不变 + **升级告警** | A1a |

### 1.2 恢复运行状态机（A1a 新增，按资产）

`IDLE → SWEEP_SELECTED → ELIGIBILITY_CHECKED → LOCKED → REVERIFIED → ATTEMPTED → VERIFIED → COMPLETE`
（任意一步失败走右侧的终止/延后边）

| 步骤 | 入口条件（guard） | 成功 → | 失败/未知 → | 审计事件 |
|---|---|---|---|---|
| `SWEEP_SELECTED` | 资产在**白名单**内，且状态为 `PROTECTION_RETAINED_PENDING_RECOVERY` | 下一步 | `SKIPPED_NOT_ALLOWLISTED` / `SKIPPED_WRONG_STATE` | `a1a_skip` |
| `ELIGIBILITY_CHECKED` | §3 全部条件为**明确真** | 下一步 | `REFUSED_INELIGIBLE(reason)` | `a1a_ineligible` |
| `LOCKED` | 取得**资产级恢复锁**（独立于告警锁） | 下一步 | `DEFERRED_LOCK_HELD`（不失败，退避后重来） | `a1a_lock_deferred` |
| `REVERIFIED` | **锁内**重新核验 §3（不得沿用巡检时快照） | 下一步 | `ABORTED_STATE_CHANGED(reason)` | `a1a_abort` |
| `ATTEMPTED` | 调用 `recoverRetainedBoundary()`（无 force 类参数） | 下一步 | 见 §6 故障矩阵 | `a1a_attempt`（含 INTENT 引用） |
| `VERIFIED` | 释放报告 `restored === true` 且 `mismatches`/`failures` 为空、快照逐条复验通过 | 下一步 | `ATTEMPT_FAILED` / `VERIFY_FAILED` | `a1a_verify` |
| `COMPLETE` | RESULT 审计写入成功 + 任务状态落盘并重读一致 + 告警关闭 | 终止（成功） | `INCOMPLETE_AUDIT` / `INCOMPLETE_PERSIST` | `a1a_complete` |
| 预算耗尽 | 尝试数达上限 | `EXHAUSTED`（**转人工**，升级告警） | — | `a1a_exhausted` |

**幂等性**：`COMPLETE` 后该资产的调度条目终结；重复巡检只会看到 `DISENGAGED` 并跳过（`SKIPPED_WRONG_STATE`）。

---

## 2. 配置说明（全部默认关闭）

| 键（环境变量） | 默认 | 含义 |
|---|---|---|
| `AF_A1A_MODE` | `off` | `off` \| `dry-run` \| `live`。**`off` 时调度器不读取、不锁定、不尝试任何资产** |
| `AF_A1A_ALLOWLIST_FILE` | 无 | 白名单文件（见下）。**未配置 = 无任何资产被考虑** |
| `AF_A1A_INTERVAL_MS` | 300000 | 巡检间隔 |
| `AF_A1A_MAX_ATTEMPTS` | 3 | 单资产自动恢复尝试上限（达到即 `EXHAUSTED`→人工） |
| `AF_A1A_RETRY_BASE_MS` / `AF_A1A_RETRY_MAX_MS` | 60000 / 1800000 | 指数退避与封顶（与通知层同构） |
| `AF_A1A_LOCK_TTL_MS` | 600000 | 资产级恢复锁的 claim TTL（崩溃后过期才可被接管） |
| `AF_A1A_QUEUE_FILE` | `<audit dir>/a1a-state.json` | 调度状态（尝试数、`next_attempt_at`、终态），**原子写入** |
| `AF_A1A_AUDIT_DIR` | 复用 `AF_BOUNDARY_AUDIT_DIR` | A1a 自身的调度审计目录（与恢复 INTENT/RESULT 分离存放） |
| `AF_CGROUP_BASE` / `AF_SCOPE_RESCAN_BUDGET` / `AF_BOUNDARY_ALERTS_FILE` | 既有 | 复用既有语义，不新增开关 |

**白名单文件格式（示意）**

```json
{ "schema": "af-a1a-allowlist-v1",
  "assets": [ { "canonical_dir": "/srv/repo-a", "cas_dir": "/srv/cas-a", "task_id": null, "max_attempts": 3 } ] }
```

- **精确匹配 `canonical_dir`**（不做前缀/通配匹配，避免误伤相邻目录）。
- 白名单之外：`SKIPPED_NOT_ALLOWLISTED`，**不写任何状态、不加锁**。
- `dry-run`：完整执行资格判定、加锁、锁内复验，并记录"**将要**恢复"的审计；**绝不释放、绝不改权限、绝不关告警**。
- **不存在"仅测试用"的生产放行开关**：`dry-run` 是正式运行模式，不是绕过。

---

## 3. 自动恢复资格（全部为**明确真**；任一未知即拒绝）

| # | 条件 | 证据来源 | 未知/失败时 |
|---|---|---|---|
| 1 | 资产在**白名单**内 | 白名单文件 | `SKIPPED_NOT_ALLOWLISTED` |
| 2 | 边界状态 == `PROTECTION_RETAINED_PENDING_RECOVERY` | 任务记录 `trusted_import.boundary_state` | 拒绝（`RESTORE_INCOMPLETE`/`DISENGAGED` 一律跳过） |
| 3 | 任务**已终止** | `writer_termination.termination_confirmed === true`（作者，必要时评审） | 拒绝 |
| 4 | 写者终止证据齐全 | `process_started`/`process_group_alive === false`/`scope_verified` 齐备且一致 | 拒绝（缺一项即拒绝） |
| 5 | scope 扫描**明确为空** | `decideWriterScopesEmpty({ quiesceConfirmed: true })` → `UNLOCK`，且 `anomalies` 为空、`status === 'empty'` | 拒绝（`active`/`unknown`/异常**一律拒绝**） |
| 6 | 快照有效 | `loadPathSnapshot(canonical)` 与 `loadPathSnapshot(cas)` 均存在、可解析、条目完整 | 拒绝（**不允许** `allowGuessedModes`） |
| 7 | 保护仍然完整 | 保护元数据与快照一致（`protectionLooksIntact` 语义 + 逐条 uid/gid/mode 比对为 0 差异） | 拒绝 |
| 8 | 恢复审计**可写** | 预检：向审计目录写一个临时探针文件并删除 | 拒绝（审计不可写绝不改边界） |
| 9 | 尝试预算未耗尽 | A1a 状态文件 | `EXHAUSTED`→人工 |
| 10 | 无他人持有资产锁 | 资产锁文件 + TTL | `DEFERRED`（退避重来，不计失败） |
| 11 | 通知层状态**不参与**资格 | —— | 通知不可用**不阻止**恢复（§7） |

---

## 4. 并发控制

- **资产级恢复锁**：键 = `sha256(canonical_dir)` 前 16 位，文件 `<audit>/a1a-lock-<hash>.lock`，
  带 `{pid, token, claimed_at}`；获取方式与告警锁同构（`O_EXCL` + token + TTL），**不复用告警锁**。
- **锁内复验（关键）**：`REVERIFIED` 步骤在**持锁之后**重新读取任务状态、重新执行 §3.3–§3.7。
  **绝不沿用巡检时观察到的状态**——巡检与恢复之间存在竞态窗口（新任务启动、人工恢复、写者重现）。
- **状态变化即中止**：锁内复验与巡检结论不一致 → `ABORTED_STATE_CHANGED`，不做任何修改。
- **锁顺序**（防死锁）：**资产锁 → 告警/通知锁**，单向；任何代码路径不得反向获取。
  恢复过程中如需写告警（关闭/升级），只在**已持有资产锁**时进行。
- **锁丢失**：长任务超过 TTL 时其它巡检可能接管；因此恢复动作必须**快**（释放是元数据操作），
  并在 RESULT 阶段校验 token 仍属于自己，否则报 `ABORTED_LOCK_LOST`（不谎报成功）。

---

## 5. 失败有界且可见

| 机制 | 设计 |
|---|---|
| 退避 | 第 n 次失败后等待 `min(base × 2^(n-1), max)` |
| 上限 | `AF_A1A_MAX_ATTEMPTS`（默认 3）→ `EXHAUSTED`，**不再自动重试** |
| 耗尽可见 | 升级告警（severity `escalated`，复用既有告警通道与卡片）+ 任务记录 `auto_recovery.exhausted_at` + **CLI 非零退出** |
| 重启续查 | 尝试数与 `next_attempt_at` **落盘原子写**；新进程按同一文件续查（与通知队列同构） |
| 崩溃续投 | 过期 claim（> `LOCK_TTL`）可被接管，并在审计中记录 `took_over_from`（原 pid/claim） |
| 禁止静默 | **每次**尝试都写 `a1a_attempt` 审计（含 INTENT 引用）；巡检无动作时写 `a1a_skip`（含原因） |
| 观测 | `af-admin a1a status`（模式/白名单数/待尝试/延后/耗尽）、`af-admin a1a explain <canonical>`（逐条资格判定结果） |

---

## 6. 故障验收矩阵

| # | 故障/场景 | 检测方式 | 期望行为 | 可见信号 | 退出码 | 重试 | 人工动作 |
|---|---|---|---|---|---|---|---|
| F1 | scope 非空（有活跃写者） | `inspectWriterScopes().status === 'active'` | **拒绝**，保持保留 | `a1a_ineligible(active-writer)` + 既有保留告警 | 1 | 退避后重试（上限内） | 排查写者归属 |
| F2 | scope 不可确认（`unknown`/`io`/`permission`） | `status === 'unknown'` 或 `reason` 非空 | **拒绝** | `a1a_ineligible(scope-unknown)` | 1 | 退避后重试 | 人工确认 |
| F3 | scope 存在**异常**（`anomalies>0`） | `anomalies.length > 0` | **拒绝**，且**不因重试而消失** | `a1a_ineligible(scope-anomaly)` + 升级 | 1 | **不重试**（异常需人工解释） | 必须人工 |
| F4 | 写者终止证据缺失 | 任一 `writer_termination` 字段缺失/矛盾 | **拒绝** | `a1a_ineligible(termination-evidence)` | 1 | 不自动重试 | 补证据 |
| F5 | 快照缺失/损坏 | `loadPathSnapshot()` 为空或解析失败 | **拒绝**（**不得**猜 mode） | `a1a_ineligible(snapshot-invalid)` | 1 | 不自动重试 | 人工受控恢复 |
| F6 | 保护元数据已漂移 | 逐条比对 uid/gid/mode 出现差异 | **拒绝** | `a1a_ineligible(protection-drift)` + 升级 | 1 | 不自动重试 | 人工排查 |
| F7 | 恢复审计不可写 | 预检失败（EACCES/ENOSPC） | **拒绝**，边界不变 | `a1a_ineligible(audit-unwritable)` | 1 | 退避后重试 | 修权限/磁盘 |
| F8 | 资产锁被他人持有 | 锁文件存在且 claim 未过期 | **延后**（不计失败） | `a1a_lock_deferred` | 0 | 下一轮 | 无需 |
| F9 | 锁内复验发现状态变化 | 复验与巡检不一致 | **中止**，不修改 | `a1a_abort(state-changed)` | 1 | 不重试 | 人工确认 |
| F10 | 释放执行但校验失败（`mismatches>0`） | 释放报告 | 边界保持保留/`RESTORE_INCOMPLETE`；**不标记完成** | `a1a_verify_failed` + 升级 | 1 | 退避后重试（上限内） | 排查元数据 |
| F11 | RESULT 审计写入失败 | 审计 `result_ok === false` | **不标记完成**，`delivered=false`；保留 `BOUNDARY_AUDIT_INCOMPLETE` | `a1a_incomplete_audit` + 升级 | 1 | 不重试 | 人工对账 |
| F12 | 任务状态落盘失败 | `saveTask` 抛错或重读不一致 | **不标记完成** | `a1a_incomplete_persist` + 升级 | 1 | 退避后重试 | 排查磁盘 |
| F13 | 进程在恢复中被杀 | 死锁 claim + INTENT 无 RESULT | 保持保留；过期后接管并在审计中记录 | `a1a_took_over` | 1 | 接管后重试 | 核对 INTENT |
| F14 | 尝试耗尽 | 计数 ≥ 上限 | `EXHAUSTED`，**停止自动重试** | 升级告警 + `auto_recovery.exhausted_at` | 1 | 停止 | **必须人工** |
| F15 | 出现 `RESTORE_INCOMPLETE` | 任务状态 | **永不自动处理** | `a1a_skip(restore-incomplete)` + 既有告警 | 0 | 不重试 | 必须人工 |
| F16 | 通知层不可用/队列不可核验 | `inspectPendingNotifications().ok === false` | **不阻止恢复**；通知失败单独记录 | `boundary_notify` 事件（既有） | 通知侧 1/3 | 通知侧独立退避 | 见 §7 |
| F17 | 白名单缺失/为空 | 配置检查 | **不恢复任何资产** | `a1a_status(no-allowlist)` | 0（无害） | — | 配置 |
| F18 | `dry-run` 模式 | `AF_A1A_MODE=dry-run` | 只判定与"将要恢复"审计，**零变更** | `a1a_would_recover` | 0 | — | 评审输出 |

---

## 7. 与 `notify-flush` 的职责隔离（**不得合并**）

| 维度 | 自动边界恢复（A1a） | 通知重试（`notify-flush`） |
|---|---|---|
| 目的 | 解除**真实**的边界保留 | 把**已发生**的告警送达渠道 |
| 状态存储 | `a1a-state.json`（尝试数/退避/终态） | `<alert log>.notify-pending.json` |
| 锁 | 资产级恢复锁 | 告警日志锁（含投递 claim） |
| 前提 | §3 全部资格 | 存在待投递条目 |
| 失败含义 | 边界仍被保留（安全侧） | 消息未送达（可见性侧） |
| 耗尽后果 | **升级告警 + 转人工** | 升级告警 + 转人工 |
| CLI | `af-admin a1a status`（失败→1） | `af-admin boundary notify-status`（待办→1；不可核验→3） |
| 退出码 | 独立 | 独立（1/3） |
| 交叉影响 | **通知不可用不阻止恢复**；恢复成功**可以**入队一条通知（可选），但**恢复状态与投递状态各自记录** | 投递成功**绝不**代表恢复完成 |

**明确禁止的耦合**

1. 不得用"通知已送达"作为"恢复完成"的条件或证据；
2. 不得用"恢复完成"作为"通知已送达"的条件；
3. 不得把两者合成一个 `success` 字段、一个退出码或一个调度循环；
4. 不得让任一方的失败阻塞另一方（除共享的资产锁顺序约束外）。

**成功标准（全部满足才算 `COMPLETE`）**

1. 释放经 `releasePathsBoundary` 执行（**无 force/ack/guess 参数**）；
2. **逐条**复验快照：uid/gid/mode 全部一致，`mismatches` 与 `failures` 为空；
3. 恢复 RESULT 审计写入成功（两阶段：INTENT 先行；RESULT 失败即未完成）；
4. 任务状态落盘**并重读一致**；
5. 告警按正常释放路径关闭；
6. **恢复 ≠ 任务成功**：任务的 REJECT/FAIL/门禁状态不变，仅 `boundary_state → DISENGAGED`。

---

## 8. 停用与回滚流程

### 8.1 立即停用（默认操作）

1. `AF_A1A_MODE=off`（或 `AF_A1A_ENABLED=0`），重启调度器单元；
2. **生效点**：调度器在**每次尝试之前**检查模式；**已在释放中的动作不会被打断**
   （中途放弃释放比完成它更危险），停用在下一次尝试边界生效；
3. 确认停用：`af-admin a1a status` 显示 `mode: off`、`attempts_in_flight: 0`；
4. 若需**冻结**某资产：从白名单移除该条目（不影响其它资产）；
5. **不需要**删除告警/状态文件：保留为审计证据。

### 8.2 残留锁处理（人工，留证据）

1. `af-admin a1a status --locks` 列出锁文件与 claim 时间；
2. 仅在确认**无进程持有**（`pgrep`/`ps` 证据）后，按 `a1a-state.json` 与锁文件内容记录到审计；
3. 删除锁文件（**不得**用 `force` 类参数触发恢复）；下次巡检自然重新判定资格；
4. 若 claim 未过期且进程仍在：**不动**，等 TTL 或人工确认。

### 8.3 已完成恢复的回滚（谨慎）

- **恢复本身不可逆**：`DISENGAGED` 之后若怀疑误判，正确动作是**重新施加保护**并调查：
  1. 复核该资产的 `recovery-*-intent.json` / `-result.json` 与 `a1a_*` 审计；
  2. 若确认保护不应解除：以**人工**方式重新 `engageTaskHostBoundary`（或按流程重跑生命周期），
     并记录新的 INTENT/RESULT 审计；
  3. **禁止**通过 A1a 自动重新保护（首版无自动重新保护能力）。
- **代码回滚**：先 `AF_A1A_MODE=off` → 回退到上一个 tag（如 `stage5-feishu-card-acceptance`）→
  验证 `af-admin a1a status` 不存在/为 off → 再按需清理状态文件（保留审计副本）。

### 8.4 停用后的验证清单

- [ ] `AF_A1A_MODE=off` 已生效，进程重启后仍为 off
- [ ] 白名单可留空（`a1a status` 显示 `no-allowlist`）
- [ ] 无 `attempts_in_flight`、无未过期锁（或已记录理由）
- [ ] `boundary alerts` 与 `notify-status` 状态与恢复无关地正常
- [ ] 审计目录保留全部 `a1a_*` 与 `recovery-*` 记录，未被清理

---

## 9. 实施阶段的验收测试计划（本轮不实现）

| 组 | 用例 |
|---|---|
| 资格判定 | 11 条 guard 逐条构造"未知/失败"→ 必须拒绝（表驱动） |
| 锁与并发 | 两路巡检 → 仅一次尝试；锁内复验捕获"巡检后状态被人工恢复"→ 中止；锁超 TTL 被接管并留 `took_over` |
| 崩溃/重启 | 尝试计数落盘；重启后续查；过期 claim 才可接管；原子写无半截文件 |
| 有界失败 | 达上限 → `EXHAUSTED` + 升级 + CLI 1；退避序列正确且封顶 |
| **禁止绕过**（静态） | A1a 模块**不含** `force: true`、`acknowledgeLiveScopes`、`allowGuessedModes`；`RESTORE_INCOMPLETE` 常量分支必为跳过 |
| 成功标准 | 逐条 mismatch → 不完成；RESULT 审计失败 → 不完成；任务落盘失败 → 不完成 |
| **职责隔离** | 通知队列不可核验时恢复仍可执行；恢复成功不改写投递状态；两者退出码独立 |
| dry-run | 零变更（权限/告警/任务记录均不变） |
| 端到端（合成） | 复用 `scope-exhaustion` 与 `feishu-controlled-send` 夹具风格：保留 → 自动恢复资格满足 → `COMPLETE` → 告警关闭；并保留一条"资格不满足 → 永不动手"的反例 |

---

## 10. 待评审确认的开放问题

1. **白名单粒度**：仅 `canonical_dir`，还是 `canonical_dir + task_id`？（默认建议：目录级 + 可选 task 限定）
2. **耗尽告警形态**：复用既有保留告警条目（`occurrences` 累加）还是新增 `a1a_exhausted` 事件类型？
3. **间隔与退避默认**：5 分钟巡检 / 1 分钟起退避是否可接受？
4. **成功是否外发通知**：默认不通知（避免噪声），是否改为可选开启？
5. **审计目录归属**：A1a 调度审计与恢复 INTENT/RESULT 同目录（推荐）还是独立目录？
6. **`RESTORE_INCOMPLETE` 的长期计划**：是否需要"人工复核后一键重试"的**显式人工**入口（非自动）？

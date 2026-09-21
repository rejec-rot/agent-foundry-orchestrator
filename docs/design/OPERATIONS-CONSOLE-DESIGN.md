# 只读运行控制台：详细设计（阶段 1）

状态：**设计（阶段 1 交付）**。只读、本机默认、不新增自动操作。
对应计划书阶段 1；与 `TASK-RUN-CONSOLE-DESIGN.md`（早期只读设计 v1）的关系：**本文档整合并取代它**，
数据源与只读不变量沿用，页面按计划书的六个页面重构，并补充查询接口、脱敏与故障展示细节。

配套：`SYSTEM-ARCHITECTURE-NEXT.md`（模块边界、权威数据源、状态契约、退出码）。

> **两条不可协商的规则**
> 1. **不因查询失败把列表显示为"没有异常"**（读不到 = 不可核验，必须显式）。
> 2. **页面只呈现事实**：不得自行推断"任务成功"，不得提供解锁/强杀/强制提升/改记录功能。

---

## 1. 首版约束（来自计划书）

| 约束 | 设计落实 |
|---|---|
| 默认本机访问 | 首版为 **CLI + 本地生成页面**；绑定 `127.0.0.1` only，不监听外部地址 |
| 远程访问前加认证与权限 | 远程是**后续阶段**；本文档给出接入前置条件（§7）而非实现 |
| 不提供解锁/强杀/强制提升/改记录 | **无任何写接口**；按钮区不存在（不是"隐藏"） |
| 输出脱敏，日志作为不可信文本 | §5（转义 + 路径策略 + 凭据永不出现） |
| 区分"缓存状态"与"最近核验状态" | §6.1（`as_of` / `last_verified` / `stale` 三态展示） |
| 不因查询失败把列表显示为"没有异常" | §6.2（查询失败升格为页面级横幅 + 非零退出） |

---

## 2. 页面总览

| 页面 | 目标问题 | 主键 |
|---|---|---|
| **总览** | 现在有什么需要我处理？ | 全局 |
| **任务列表** | 有哪些任务、各自到哪一步？ | 任务 |
| **任务详情** | 这个任务从作者到提升发生了什么？ | 任务 |
| **结果与证据** | 凭什么是这个结果？ | 任务 + 证据 |
| **异常中心** | 哪里出了问题、卡在哪？ | 资产 / 告警 / 恢复 / 投递 |
| **审计详情** | 原始记录在哪、版本与关联是什么？ | 记录引用 |

**导航规则**：任意页面上的路径/ID 都必须可以**双向跳转**（任务 ↔ 告警 ↔ 恢复 ↔ 通知 ↔ 提交）。

---

## 3. 六个页面详设

### 3.1 总览

| 区块 | 内容 | 来源 | 未知时 |
|---|---|---|---|
| 运行中任务 | 状态 ∈ {`AUTHOR_RUNNING`,`REVIEW_RUNNING`,`FIX_RUNNING`,`PARALLEL_RUNNING`,`TRUSTED_IMPORT_RUNNING`,`PUBLISHING`} | 任务记录 + 锁 | `indeterminate` |
| 待人工事项 | `WAITING_HUMAN`；告警 `escalated`；通知 `exhausted`；`RECONCILE_*`（A1a 实施后） | 任务 + 告警 + 通知队列 | 逐项标 `unverifiable` |
| 保留边界 | `PROTECTION_RETAINED_PENDING_RECOVERY` 资产列表与持续时长 | 任务记录 + 告警 | 不显示为"0" |
| 耗尽通知 | 队列 `exhausted` 计数、最老待办时间 | 通知队列 | 队列不可核验 → 横幅 + **exit 3** |
| 不可核验状态 | **所有** `read_status !== 'ok'` 的来源清单（显式计数） | 各来源 | 这是本页存在的意义 |
| 独立状态并排 | 任务 / 边界 / 告警 / 投递 / 恢复**五列独立** | 各自权威来源 | **禁止**合成单一 `healthy`/`success` |

### 3.2 任务列表

| 列 | 来源 | 排序/过滤 |
|---|---|---|
| 任务 ID、仓库 | 任务记录 | 过滤：仓库、状态、执行器、时间窗 |
| 任务状态 + `state_version` | 任务记录 | 排序：最近活动降序（默认） |
| 执行器（作者/评审） | 任务记录 | 过滤：执行器 |
| 开始时间 / 最近活动 | 任务记录 + 锁 + 运行事件 | — |
| 阶段（最新可判定） | 派生（标注 `derived_from`） | — |
| 边界 / 告警 / 投递摘要 | 任务 + 告警 + 通知 | 每项独立标注可核验性 |
| 需人工标记 | 派生（列出触发原因） | 一键过滤"需人工" |

### 3.3 任务详情：author → reviewer → acceptance → promotion 时间线

时间线事件（`order_basis` + `trust`，与 A1a H3 一致）：

| 阶段 | 来源 | 关键字段 |
|---|---|---|
| `TASK_CREATED` | 任务记录 | `created_at`、`state_version=1` |
| `AUTHOR_RUNNING/DONE` | 任务记录 + 运行事件 | `executor_run_id`、退出码、摘要 |
| `REVIEW_RUNNING/DONE` | 任务记录 + 评审记录 | 评审结论、拒绝理由、绑定校验 |
| `GATE_DECIDED` | 门禁记录（四带 A/B(i)/C/D） | 带位、原因 |
| `ACCEPTANCE_RUN` | 验收输出 + `acceptance_evidence_id` | 命令、退出码、输出摘要 |
| `TRUSTED_IMPORT_RUNNING` | 任务记录 | 投影/候选/CAS |
| `PROMOTION` | `baseline_oid` → `new_commit_oid`、`patch_digest`、`tree_oid` | 提升是否发生、是否被硬 G 阻塞 |
| `BOUNDARY_*` | 边界状态 + 告警 | 见异常中心 |
| `TASK_TERMINAL` | 任务记录 | 终态与 `failure_reason` |

**空段规则**：某段无数据时保留标题并写"无数据"；**不得**因为缺一段就断言"未发生"（可能只是未记录）。

### 3.4 结果与证据

| 区块 | 内容 | 未知时 |
|---|---|---|
| 候选差异 | 投影后的文件级增删（`projection` 结果） | `unverifiable` |
| 评审结论 | 结论 + 理由 + 绑定校验（`validateReviewBinding`） | 未验证 |
| 验收输出 | 命令、退出码、stdout/stderr 摘要（**作为不可信文本**） | 缺证据 → "未验证" |
| baseline / promoted OID | `baseline_oid`、`new_commit_oid`、`refs/afr/canonical` 当前值 | git 对象缺失 → 不可核验 |
| 证据引用 | `acceptance_evidence_id` + 记录位置 | 缺失 → 明确列出缺失项 |

### 3.5 异常中心

| 分区 | 内容 | 关联 |
|---|---|---|
| 保留原因 | `boundary_retained_reason`、`scope_decision`（decision/reason/attempts/quiesce/anomalies/reaped） | → 恢复审计 |
| 恢复阶段 | `INTENT only`（未修改，可重试）/ `MUTATION_STARTED`（需人工核对）/ `RESULT`（物理已恢复）/ 记录未完成 | → recovery ID |
| 投递失败 | 失败/耗尽条目、`provider_code`、`next_attempt_at`、`last_error` | → 通知面板 |
| 不一致 | 任务与告警冲突、告警与投递冲突、时间顺序不可判定 | 两者并排 |
| 不可核验 | 来源清单 + 原因 + 修复建议（只读建议，非操作） | — |

### 3.6 审计详情

| 内容 | 说明 |
|---|---|
| 原始记录引用 | 绝对路径 + 记录 ID + `schema_version` |
| 版本 | 任务 `state_version`、告警事件序号、恢复 `intent/result` 阶段 |
| 时间与关联标识 | `at`、`as_of`、`order_basis`、`task_id`/`asset`/`alert_id`/`recovery`/`epoch` |
| 完整性 | 文件大小、mtime、解析状态、坏行数、是否截断 |
| 原文查看 | 以**不可信文本**呈现（转义），支持复制引用 |

---

## 4. 查询接口（只读）

### 4.1 CLI 形态（首版主入口）

```
af-admin console overview [--json]
af-admin console tasks [--repo <path>] [--state <s>] [--needs-human] [--limit N] [--json]
af-admin console task <task_id> [--json]
af-admin console evidence <task_id> [--json]
af-admin console exceptions [--asset <canonical>] [--json]
af-admin console audit <ref> [--json]
af-admin console render --out <dir>        # 生成静态只读页面（唯一写动作，显式要求 --out）
```

**接口纪律**

1. 所有子命令**只读**；不得调用 `boundary recover`、`notify-flush`、`notify-test`、`promote`、`prune`、`rotate`、`reset`、`restore`。
2. 不获取任何锁（任务锁/资产锁/告警锁/通知锁）。
3. `--json` 为稳定 schema：每个数据块都带 `source`、`read_status`、`as_of`、`order_basis`、`derived_from`。
4. 分页与上限：默认 `--limit 50`，日志类来源**尾部读取**并标注 `truncated`（默认上限 8 MiB / `AF_CONSOLE_MAX_BYTES`）。
5. 退出码沿用 §5.3 统一约定（**不可核验 = 3**）。
6. 静态页面渲染（`render --out`）是**唯一**写动作，且只写指定目录；不写任何状态文件。

### 4.2 查询→来源映射（实现时按此接线）

| 查询 | 主要来源 | 次要来源 | 备注 |
|---|---|---|---|
| `overview` | 任务记录（全量列举）+ 告警 + 通知队列 | 锁、运行事件 | 大仓需索引：按 mtime 增量扫描，**索引可重建** |
| `tasks` | 任务记录 | 锁 | 不读 runs/ 内容（仅计数） |
| `task <id>` | 任务记录 + 运行事件 + 评审记录 | runs/、runs 日志尾部 | 时间线合并按 §3.3 |
| `evidence <id>` | 任务字段 + 证据记录 | git（OID 存在性） | 只读 git 查询（`cat-file -e`） |
| `exceptions` | 告警 + 恢复审计 + 通知队列 + 任务边界字段 | 快照存在性 | 分区独立 |
| `audit <ref>` | 指定记录文件 | — | 以不可信文本呈现 |

---

## 5. 脱敏与不可信文本

| 规则 | 说明 |
|---|---|
| 凭据永不出现 | webhook URL、token、签名密钥、SMTP 口令一律不显示（复用 `describeNotifyConfig()` 的 host-only 纪律） |
| 日志/输出为不可信文本 | 执行器 stdout/stderr、评审摘要、`last_error`、provider 消息：**转义后**呈现；**绝不**作为 HTML 或命令插入 |
| 路径策略 | 本机显示可含真实路径；`--redact` 复用既有路径摘要（`sha256:` 前缀）用于分享/导出 |
| 导出一致性 | 导出产物必须与 `--redact` 结果一致；导出前打印来源清单与 `as_of` |
| 不落盘 | 除 `render --out` 外不写任何文件；不写临时缓存在仓库内 |

---

## 6. 故障展示

### 6.1 缓存状态 vs 最近核验状态

每个数据块显式三态：

| 字段 | 含义 |
|---|---|
| `as_of` | 该记录自身的时间戳（文件 mtime / 事件时间） |
| `last_verified` | 本次查询读取成功的时刻 |
| `freshness` | `fresh`（< `AF_CONSOLE_STALE_MS`，默认 10 分钟）/ `stale` / `unknown` |

页面**同时**展示 `as_of` 与 `last_verified`；派生/索引类数据额外标 `derived_from` 与 `rebuildable: true`。

### 6.2 查询失败绝不等同"没有异常"

| 情形 | 行为 |
|---|---|
| 告警日志/通知队列不可核验 | 页面级横幅 + 该区块显示 UNVERIFIABLE + 退出码 **3** |
| 任务记录损坏 | 该任务显示不可核验；列表**不隐藏**该任务 |
| 来源部分失败 | 其余区块照常渲染，失败区块显式计数并在总览"不可核验状态"列出 |
| 索引重建中 | 显示"索引重建中"，不得显示空列表 |
| 截断 | 标注截断字节数与"结果可能不完整" |

---

## 7. 远程访问（后续阶段的前置条件，首版不做）

1. 绑定地址显式配置（默认 `127.0.0.1`），**禁止**默认 `0.0.0.0`。
2. 认证与授权：只读令牌 / 会话；按仓库范围授权；令牌不入仓库、不入前端产物。
3. 传输：TLS 终止；不得明文暴露。
4. 审计：访问日志（谁、何时、查了什么）；
5. 仍然**无写能力**：远程化不引入任何操作按钮。
6. 单独的安全设计评审通过后方可实现。

---

## 8. 验收（阶段 1）

| # | 验收项 | 方式 |
|---|---|---|
| A1 | **不启动真实模型、不改变任务状态**，即可完整检查历史任务与故障证据 | 用既有历史记录（含保留/`RESTORE_INCOMPLETE`/投递耗尽）渲染全部六页 |
| A2 | 只读不变量 | 静态：不导入写 API/锁 API；运行时：渲染前后所有来源文件 `stat`（mtime/大小）不变 |
| A3 | 不可核验显式 | 构造告警日志损坏、通知队列损坏、任务文件半截 → 断言页面横幅 + 退出码 3/1/2 |
| A4 | 不把查询失败显示为"没有异常" | 断言空列表与不可核验在输出中**可区分**（不同文案与代码） |
| A5 | 关联缺失不猜测 | 缺 `alert_id`/缺 RESULT → `unmatched_source` 且无启发式配对 |
| A6 | 脱敏 | 导出产物中无 URL/token；`--redact` 无真实路径 |
| A7 | 顺序不靠墙钟 | 构造同毫秒/时钟回拨 → 顺序由 `order_basis` 决定，标注 `approximate` |
| A8 | 五状态独立 | 断言输出中任务/边界/告警/投递/恢复**各有独立字段**，无合并 `success` |

**明确不在首版验收范围**：远程访问、写操作、AI 归因、跨任务统计报表。

---

## 9. 与既有设计的关系

| 文档 | 关系 |
|---|---|
| `TASK-RUN-CONSOLE-DESIGN.md` | 早期只读设计 v1；数据源清单与 RO1–RO7 只读不变量被本文档继承，页面部分由本文档取代 |
| `SYSTEM-ARCHITECTURE-NEXT.md` | 契约来源：权威表、状态字典、关联规范、退出码 |
| `A1A-AUTO-RECOVERY-DESIGN.md` | 控制台只展示 A1a 状态，**不参与**其判定；A1a 未实现时显示"未启用" |

## 10. 未决问题

1. `render --out` 的产物是否默认脱敏（建议：默认脱敏，需 `--no-redact` 显式本地全量）。
2. 是否需要"任务列表"的服务端索引（当前为增量扫描 + 可重建索引）。
3. 时间线是否需要"同一资产跨任务"视图（便于看多次尝试）。
4. 总览是否包含执行器健康（需避免与任务状态混淆，见架构文档未决问题 2）。
5. `AF_CONSOLE_*` 变量命名是否最终确定。

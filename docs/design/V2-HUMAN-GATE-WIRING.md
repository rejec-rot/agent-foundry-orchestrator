# V2 人工闸门（Human Gate D）接通设计稿（**评审稿；未实现**）

状态：**设计评审稿**。本文件不改变行为。当前 V2 路径遇到人工闸门时**直接失败**，不进入人工审批。

## 1. 现状（代码事实）

- **判定已存在**：`mechanical-gate.mjs` / `scope-verifier.mjs` 会产出 `decision: 'WAITING_HUMAN'`（Band D）；`ledger.verifyCumulativeClosure()` 返回 `{ satisfied, verdict, needsVerifier }`，`verdict ∈ ALLOW/DENY/WAITING_HUMAN/PENDING_VERIFIER`。
- **审批库已存在**：`human-gate.mjs` 导出 `approveHumanGate({ pendingDecisions, operatorIdentity, justification, operatorAuthenticator })`，产出**经签名、可验证**的批准（`isTrustedHumanApproval`）；`revalidateHumanApproval` 用于复验。
- **调度器有停靠/恢复通道**：`scheduler.mjs` 明确「WAITING_HUMAN parks the task: state persisted, lock + slot released」并有「Resume a WAITING_HUMAN task through the Human Gate correlation path」（`:211`）。
- **V2 适配器没接**：`orchestrator-adapter.mjs:762-769` 在 `!closure.satisfied` 时**抛错**
  （`TRUSTED_IMPORT_AUTHORIZATION_BLOCKED`，带 `{ verdict, needsVerifier }`），**不设置 `task.state='WAITING_HUMAN'`，也不调用 `approveHumanGate`**。
- 结论：**底层能停能批，唯独 V2 主入口没把"停 → 人工批 → 续"接起来。**

## 2. 目标行为

V2 任务在授权阶段遇到**需要人工**的判定时：
1. **停靠（park）**：把任务置 `WAITING_HUMAN`，**持久化待批项**（Band D 待决条目 + `state_version` + 闭包 `verdict/needsVerifier`），释放调度槽与锁，**不推进、不提升**。
2. **审批**：仅接受**经 `operatorAuthenticator` 签名**的 `approveHumanGate` 结果；无签名/身份缺失 → 拒绝（`HUMAN_AUTH_REQUIRED`）。
3. **续跑**：审批通过后，**在锁内复验**（`revalidateHumanApproval` + 重算闭包，校验 `state_version` 未过期），满足才继续到 `ACCEPTANCE` → 提升。
4. **DENY 仍 fail-closed**：`verdict==='DENY'` 一律失败，绝不因"等待人工"而放行。

## 3. 需要改的地方（实施清单，均待评审）

| # | 文件 | 改动 | 约束 |
|---|---|---|---|
| 1 | `lib/trusted-import/orchestrator-adapter.mjs`（授权段 `:762`） | 把 `throw` 改为**按 verdict 分流**：`WAITING_HUMAN` → park（`task.state='WAITING_HUMAN'` + 记录 `pending_decisions`/`state_version`）；`DENY` → 维持失败；`PENDING_VERIFIER` → 维持"需独立 verifier"的拒绝（不自动放行） | 不得新增 force/绕过 |
| 2 | `orchestrator.mjs` / 调度入口 | 让 V2 任务的 park 走既有 WAITING_HUMAN 通道（持久化 + 释放锁/槽） | 复用现有调度语义，不新建第二调度器 |
| 3 | 恢复入口（CLI/服务） | 新增"批 V2 待决项"的动作：调 `approveHumanGate`（带 `operatorAuthenticator`）→ 复验 → 续跑 | 需**显式操作者身份+理由**；续跑前锁内复验 `state_version` |
| 4 | 证据 | 批准记录写入**授权账本**（`ledger.mjs`）与任务证据，可追溯 | 不留"未签名通过" |

## 4. 必须保持的不变式（放行阻断）

- 无 `operatorAuthenticator` 签名 → **不批准**（`isTrustedHumanApproval` 必须为真）。
- `WAITING_HUMAN` **不是**"可通过"；到期/重启都**不自动通过**。
- 续跑必须**锁内复验** `state_version`，过期则放弃该批准并要求重算。
- 批准只解决**被列出的待决项**；不得扩权（不得把 `proposed_required` 扩大化）。
- 前端/CLI 只能提交**目标与配置**，不能自称"已批准"。

## 5. 测试计划

- 正向：Band D 判定 → 任务停为 `WAITING_HUMAN`（不失败、不提升）→ 签名批准 → 复验通过 → 续跑至 `ACCEPTANCE`。
- 负向：**无签名/假签名** → 拒绝；**过期 `state_version`** → 拒绝并重算；**DENY** → 仍失败；**批准覆盖未列出的路径** → 拒绝。
- 并发：审批与另一进程的续跑竞争 → 锁内定序，只有一次生效。
- 回归：不接 Slack/前端也能用 CLI/库完成；现有 `WAITING_HUMAN` 任务（非 V2）语义不变。

## 6. 待确认

1. V2 的 `PENDING_VERIFIER`（需要独立 verifier）本轮是否也要"停为待处理"，还是维持拒绝？（建议：维持拒绝，先只做 Band D 人工批准。）
2. 续跑复验后，若闭包仍不满足（例如批准后又有新路径）——**再次停靠**而非失败？（建议：再次停靠。）
3. 批准动作的**入口**：本轮先只提供**库/CLI**，不做 Web（与"暂停 Web 前端"一致）？

# 0008 — 否决 P6 原方案（provider 错误分类交给 litellm / axonhub）；改为补齐拒绝族

- 状态：**已采纳**（否决替换，改为定向修补）
- 日期：2026-09-16
- 决策者：本仓库维护者（授权执行 V2 全计划）
- 相关：`docs/ROADMAP.md` §五 P6、`docs/MODULE-MAP.md` §4

## 背景

P6 原方案：把 `lib/executor-error-classifier.mjs` 的 provider 错误映射与限流判断
交给 `BerriAI/litellm` 的 Router（或 `looplj/axonhub`）。

按路线图原则 4「先探测再实现」核对后否决。

## 决策

**不替换。** 改为补齐该层**实测确认的真实缺陷**：三个真实 provider 拒绝被误判为可重试（见 §三）。

## 证据

### 1. 这是一个**纯函数**，而候选方案都是外部进程

`classifyExecutionError()` 无 I/O、无依赖，调度器在关键路径上**同步**调用它，只读 `retryable`。

| 方案 | 代价 |
|---|---|
| litellm | Python 服务/库；其错误映射是 Python 代码，采用它意味着引入 Python 运行时或移植其映射表 |
| axonhub | Go 二进制 |

两者都违反 `FINAL_ARCHITECTURE.md` 原则 3「零外部重依赖」。更关键的是：
**把安全判定放到网络跳数之后，等于给安全路径本身新增一个故障点**——
分类器绝不能因为"网关不可用"而失败。这与 P1/P3/P4/P5 的结论同构。

### 2. 该向 litellm 学的是**分类法**，不是运行时

`docs/MODULE-MAP.md` §4 早已注明这是"偷分类法，不要依赖"的项。本轮正是这么做的：
借鉴 provider 的错误族划分，落成**本地、有测试、零依赖**的表。

### 3. 实测确认的真实缺陷：三处误判，方向全是"账号/计费问题被当成可重试"

README 承诺"遇 403/封号 fail-closed、禁止静默重试降级"。用真实 provider 错误形态实测：

| 样本 | 修复前 | 应为 |
|---|---|---|
| OpenAI `account_deactivated`（**账号被封**） | `TRANSIENT_FAULT` **retryable=true** | 非重试 + 人工解封 |
| OpenAI `insufficient_quota`（配额耗尽） | `TRANSIENT_FAULT` **retryable=true** | 非重试 |
| Anthropic `credit balance is too low`（余额不足） | `TRANSIENT_FAULT` **retryable=true** | 非重试 |

**根因**：原 `ACCOUNT_POLICY` 只认 `account.*disabled`，而 OpenAI 的封号措辞是 `deactivated`——
正是 C1（"stdout 里的 403 被降级"）同一类缺陷：**同一个原则只覆盖了一种措辞**。

同时确认**没有**误判的（保持原样，作为不回归基线）：
Vertex `UNAUTHENTICATED`→`AUTH_FAILURE`、`RESOURCE_EXHAUSTED`→`RATE_LIMIT`/COOLDOWN、
`PERMISSION_DENIED`→`ACCOUNT_POLICY`、`overloaded_error`/`503`→可重试、工作区测试日志提及 403 不误报。

## 四、已实施的修复

在 `lib/executor-error-classifier.mjs` 新增 `PROVIDER_ACCOUNT_REFUSAL` 表，覆盖四族：

1. **账号状态**：`deactivated` / `disabled` / `suspended` / `banned` / `closed` / `terminated`（含 organization 变体）
2. **计费/配额**：`insufficient_quota`、`exceeded your current quota`、`credit balance is too low`、`no credit remaining`、`billing not_active/hard limit`、`payment required` / `402 payment`
3. 命中一律 `ACCOUNT_POLICY` → `retryable:false` → `OPEN_MANUAL_RESET`（**人工解封**）
4. **reason 按族区分**，让证据可操作：billing → "add credit / raise quota"；account state → "operator admission required"；其余 → 原 TOS/403 文案

### 两个刻意的设计取舍（已写进代码注释与测试）

**（a）为什么计费用 `OPEN_MANUAL_RESET` 而不是 `COOLDOWN`**
余额/配额耗尽是**永久直到有人付费**的。`COOLDOWN` 到期会自动半开并继续重试，等于无进展地烧配额；人工门禁才是正确终点。

**（b）为什么排除裸 `402`，以及"歧义规则"**
- 裸 `402` 被排除：任何含数字 402 的输出（`402 bytes`、`402ms`）都会误触发熔断，而一次误触发会停掉**所有**任务。付款信号必须是文本。
- 表项分 `ambiguous` 两级：
  - **特征词**（`account_deactivated`、`insufficient_quota`、`credit balance is too low`）**永不被抑制**——抑制就可能重试一个被封/欠费账号
  - **散文式措辞**（`payment required`、`billing ... issue`）在 stdout 上仅当输出**看起来像测试运行器日志**时抑制（工作区测试可能合法地打印 `assert "payment required" ...`）
  - 边界已由测试显式记录（PE-4b）：无测试框架的散文行**按拒绝处理**——误触发熔断可由操作员恢复，静默重试一个死账号不可恢复

## 五、验证

`tests/provider-error-taxonomy.test.mjs` PE-1..PE-8 + PE-4b：

```
PE-1  账号状态拒绝 → 非重试 + 人工门禁 + reason 指名族
PE-2  计费/配额拒绝 → 非重试 + reason 提示是钱的问题
PE-3  stderr 与 stdout 结论一致（codex --json 走 stdout）
PE-4  无误报：测试日志/裸数字 402·403 不触发
PE-4b 歧义规则的边界被显式记录
PE-5  真瞬时故障仍可重试（overloaded / 503 / 500 / ECONNRESET）
PE-6  五个执行器上分类一致（不绑定平台）
PE-7  安全动作真的到达运行时守卫（熔断打开、不重试）
PE-8  每个被驱动的 provider 族都有样本
```

`node --test`：255 通过 / 0 失败（原 246），零依赖。

## 后果

- 正面：关闭了三个"账号/计费问题被重试"的 fail-open 路径；证据里的 reason 现在能直接指导操作员
- 正面：分类法仍是本地纯函数，安全路径没有新增故障点
- 负面：表仍是手维护的。新 provider 或新措辞可能漏掉——缓解是 PE-8 的族覆盖测试与文档化的族划分；
  **未采用**"未知拒绝即熔断"的启发式，那会把正常失败也变成人工介入
- 负面：litellm 的断路器"不会自愈"这一已知问题（issue #30192 / #37592）在本项目中不存在——
  因为本项目的断路器是**永不自动自愈 + 人工准入**（见 ADR-0004），这也是不能换引擎的另一个理由

## 什么情况下应重新评估

1. 需要**按 token 计费**或**成本路由**（litellm 的强项），那是新能力而非替换
2. 出现必须共享上游分类法的多服务部署
3. 维护者**主动**放宽零外部重依赖边界

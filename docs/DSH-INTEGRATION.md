# DSH 接入说明

`docs/ROADMAP.md` §六 ⑤ 提到本文件。这里说明 **DSH 是如何被接成 AFR 的一个执行器的**，
以及接进来之后的**真实边界**——哪些生效、哪些没有、哪些是"显式失败"而不是静默降级。

> AFR 是工作系统（work system），DSH 是其中一个 agent（executor）。
> 谁在任务 A 当 author、在任务 B 当 reviewer，仍由任务定义在运行时决定（`ROLE != PLATFORM`）。

## 一、调用形态

| 项 | 事实 | 来源 |
|---|---|---|
| 命令 | `dsh --profile headless "<task>"` | `dsh --help` 示例 + 本机实跑 |
| 最终答案 | **stdout** | 同上 |
| 推理过程 | stderr | 同上 |
| 退出码 | `0` = 完成，`1` = 中止或出错 | 同上 |
| 任务传参 | **位置参数**（单个参数） | `--profile headless --help` |
| 副作用 | 一次一任务、不开端口、不留残留 | 同上 |

`dsh --profile headless --help` 会打印帮助并退出、**不执行任何东西**——DSH-8 就用它做
**零额度**的真实集成证明（真启动器、真 profile 解析、真参数形态）。

headless profile 位于 `$DSH_HOME/profiles/headless`（本机 `~/.dsh/profiles/headless`）。

## 二、如何被选中

- 代码：`lib/adapters.mjs` 的 `DshAdapter`，注册进 `ADAPTERS`。
- **默认顺序不变**：DSH **不在** `lib/executor-router.mjs` 的 `DEFAULT_PRIORITY_ORDER`，
  也不在 `AUTO_SELECTABLE_ORDER`。要选中它必须显式指定：
  - 任务定义 `author_executor: "dsh"` / `reviewer_executor: "dsh"`，或
  - 路由偏好 `AF_EXECUTOR_PRIORITY=dsh,...`。
- 理由：把 DSH 设成每个任务的默认选人是**路由决策**，不该是"加了个适配器"的副作用。

## 三、治理姿态（方案 A：不注入治理）

| 层面 | 是否生效 |
|---|---|
| AFR 任务级红线 / 意图门禁 / 验收锚定 | ✅（都在 AFR 侧，与执行器无关） |
| AFR 的 `AGENTS.md`（agent 行为准则） | ❌ **不到达 agent**——headless 只暴露 `-h`，没有 system-prompt 开关 |
| DSH 自己的 profile 指令与人格 | ✅ |

`health().governance` 如实写：
`NOT injected: dsh headless exposes no system-prompt flag; the agent uses its own profile instructions`。

**升级到方案 B（把 AFR 治理注入 headless profile 的 instructions）没有做，也没有假装做。**
如果要做，改的是 headless profile 的指令层，而不是这个适配器。

## 四、三条限制，都是"显式失败"

1. **不能续接会话** → `exact_resume: false`；`resume()` **直接抛错**，而不是悄悄新开一个
   看起来像"续接"的新会话。含义说清楚：**修复轮次无法继承作者上下文**。
2. **不能指定 model** → 模型来自 profile 的 `agentDefaultModel`，不来自 argv。传了
   `capsule.model` 会**打警告并忽略**，绝不塞进 argv 假装生效。
3. **MCP 未验证** → `supportsMcpUnattended: false`；`requires_mcp` 的任务被**拒绝**，
   而不是路由过来再在运行时失败。

结构化结果包成 `{ result: <stdout> }`，与作者/评审共用的 `extractJson(structured?.result ?? '')`
约定一致。**端到端评审裁决路径需要一次真实 provider 运行才能确认，未验证前不予宣称。**

## 五、测试

`tests/dsh-adapter.test.mjs`（DSH-1..DSH-9）：

| 用例 | 内容 |
|---|---|
| DSH-1 | 符合统一 `ExecutorResult` 契约、已注册、`exact_resume:false` |
| DSH-2 | health 走 PATH 解析，且**明说 governance 未注入** |
| DSH-3 | 参数形态是 `--profile headless <task>`，任务作为单个位置参数 |
| DSH-4 | `resume` 显式拒绝 |
| DSH-5 | 退出码映射 / stdout 即结果 / 空 stdout 不算可用结果 |
| DSH-6 | 传入 model 会被报告且不进 argv |
| DSH-7 | MCP 能力声明保守（`requires_mcp` 被拒） |
| DSH-8 | **真实 dsh** 解析 headless profile（零额度集成证明） |
| DSH-9 | 路由可选它，且默认顺序不因新增适配器而改变 |

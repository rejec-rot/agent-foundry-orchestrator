# 必须保留的设计资产

改造升级过程中**不能**被替换或顺手丢掉的两处。它们的共同点是：**成熟方案里没有对等品**，
因为主流框架默认"你的配置是可信的"，而 AFR 这两处恰恰在解决"配置/角色可能被篡改或需要动态化"。

---

## 资产 1：验收命令静态白名单 + 内容哈希锚定

**位置**：`lib/acceptance.mjs`、`config/acceptance-allowlist.json`

### 它现在做什么（经过修复批次加固后）

| 机制 | 说明 |
|---|---|
| 静态白名单 | 验收命令必须命中 `config/acceptance-allowlist.json`；命令 + **参数前缀**双匹配 |
| 无 shell | 结构化 `{command, args}` 直接 `spawn`，不经 shell；legacy 字符串通道已彻底关闭 |
| 信任锚 | `acceptance_binding = sha256(acceptance_cmd + allow_legacy 标志)`，创建时绑定 |
| 三点强制校验 | 执行前（`acceptance.mjs`）、重试前（`scheduler`）、加载时（`orchestrator`）各校验一次 |
| 首次锚定语义 | 无验收历史 → 首次见到即锚定（迁移路径）；**验收跑过之后**缺失锚 = 篡改 |
| 工作区隔离 | `fixture_dir` 落在编排器根内 → 拒绝执行 |

### 为什么没有对等品

成熟 agent 框架（CrewAI / AutoGen / LangGraph / MetaGPT / openai-agents）**都不做"验收命令自身可被篡改"这一层**
——它们假定 agent 配置、任务定义由可信作者提供。AFR 面对的是相反前提：
任务文件与执行器工作区可能被写坏，所以它必须**在执行前证明这条命令和创建时一致**。

### 改造时必须守住的性质

1. 白名单仍是**静态文件**，不是运行时可改的内存状态（外置到 OPA 时，策略源仍须是受控文件）
2. 参数前缀匹配语义不变（防止"只校验可执行文件名"被 `node -e '...'` 绕过）
3. 信任锚的**三点校验**不能减为一点
4. legacy / shell 字符串通道**永久关闭**（不要因为换了策略引擎而"顺便"恢复）
5. 工作区不得落在编排器根内

### 已知残留（改造中可一并解决）

首次验收**之前**删除锚字段并改写命令，仍会被重新锚定。
彻底关闭需要一个**旁路锚存储**（如 `runtime/anchors/<task_id>`，executor 不可写）
或一次性迁移命令（`af-admin acceptance import-anchors`）。见 `docs/ROADMAP.md` §七。

---

## 资产 2：`ROLE != PLATFORM` 动态角色注入

**位置**：`orchestrator.mjs`、`lib/executor-router.mjs`、任务定义中的 `author_role` / `reviewer_role`

### 它现在做什么

- **平台 = 执行器**：Claude / Codex / Vertex / Cline / Antigravity 只是"干活的工人"
- **角色 = 任务属性**：`author` / `reviewer` / `verifier` 由任务定义在运行时注入
- **同一平台可在不同任务担任不同角色**，禁止平台与岗位静态绑定
- 路由器按**能力 / 可用性 / 运行时状态 / 优先级**排序，**不按角色**（`tests/architecture-invariant.test.mjs` 的 INV-5 就在断言这一点）

### 为什么没有对等品

主流框架通常把 agent 的**定义、提示词、角色**写在一起（一个 Agent 对象就是一个人设）。
AFR 反过来：它把"谁来干"与"干什么角色"解耦，因此才能做到
**同一个模型在任务 A 当作者、在任务 B 当独立审查者**——这是它做"双模型博弈"的前提。

### 改造时必须守住的性质

1. 路由器的排序输入**不得**包含角色
2. 任务定义必须仍能动态指定 author / reviewer 的执行器与角色
3. INV-5（`ROLE != PLATFORM`）必须继续绿
4. 换用外部编排引擎（route 2/3）时，这条要作为 **worker 侧的策略**实现，而不是丢掉

---

## 附：改造时容易"顺手丢掉"的次要但重要的性质

这些不属于上述两个资产，但同样在修复批次里被确立，替换组件时容易被无声抹掉：

| 性质 | 位置 | 为什么不能丢 |
|---|---|---|
| 执行器环境白名单（只给自己的凭证） | `lib/executor-env.mjs` | 换成 execa/沙箱后仍须保证"claude 拿不到 OpenAI key" |
| 子进程输出上限 + 截断标记 | `lib/child-process.mjs` | 防止对编排器自身的 OOM 攻击 |
| 子进程登记 + 停机一次性回收 | `lib/child-process.mjs` | 换 execa 后必须保留"全部子进程可被停机回收" |
| 熔断状态损坏 → 全员 fail-closed + 隔离证据 + 审计 | `lib/executor-runtime-guard.mjs` | 换成库之后这条语义要显式保留 |
| `state_version` 单调递增（唯一写入器） | `lib/store.mjs` | 换 SQLite 后应由事务/版本列承接 |
| 审计事件递归脱敏（含循环上限） | `lib/executor-runtime-guard.mjs` | 换库后别退回浅层脱敏 |

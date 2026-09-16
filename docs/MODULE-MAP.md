# AFR 模块级替代对照表（全量版 v2）

> **被评估对象**：`opperl1114/agent-foundry-orchestrator` @ `434114e`（0★ / 个人项目 / ~17k 行手写实现）
> **目标**：不做重复造轮子——把每个模块映射到 GitHub 上已有、活跃、可用的成熟方案
> **数据来源**：本会话 GitHub search API 实测（星数 / 许可 / 最后推送 / 是否归档），2026-09
>
> ## 本次修订说明（重要）
>
> v1 只点名了 **39** 个仓库，而最初的调研覆盖 **60** 个——**35 个从未提及**，其中包含多个
> 星数极高且**直接对位** AFR 模块的项目：
>
> `ruvnet/ruflo`(72.5k) · `musistudio/claude-code-router`(37.2k) · `Hmbown/Codewhale`(41.0k) ·
> `tinyhumansai/openhuman`(39.8k) · `Yeachan-Heo/oh-my-claudecode`(39.2k) · `herdrdev/herdr`(38.7k) ·
> `getpaseo/paseo`(17.4k) · `The-PR-Agent/pr-agent`(13.0k) · `crewAI`(58.6k) · `microsoft/autogen`(61.0k) ·
> `FoundationAgents/MetaGPT`(70.4k) · `mastra-ai/mastra`(28.1k) · `shepherd-agents/shepherd`(2.4k) 等。
>
> 根因是 v1 按「每个模块只挑一个最贴合的」来组织，剪枝过度，把候选池整个藏掉了。
> v2 改为**候选池 + 说明为什么**，并新增 §9 台账，把**每一个**已研究项目都交代清楚
> （适用 / 不适用 + 原因），不静默丢弃任何一个。

---

## 0. 结论速览

1. **最重的手写部分（调度器 + 原子存储 + 文件锁 + 崩溃恢复）恰好是替代品最多的一类**，conductor / temporal / rivet / restate / dbos 全部可用。这也是我们这几轮修出全部并发 bug 的地方。
2. **§2 适配器层在 v2 里被显著加强**：`claude-code-router`、`ruflo`、`oh-my-claudecode`、`herdr`、`openhuman`、`Codewhale`、`paseo` 都是同一层的高星成熟实现——v1 漏掉它们导致这一层的选型严重失真。
3. **v2 新增真正对位「恢复/检查点」的候选**：`shepherd-agents/shepherd`（可逆 Git-like trace、fork/rollback）。
4. **只有两处没有成熟对等品**，建议保留自研：验收命令静态白名单+内容哈希锚定、`ROLE != PLATFORM` 动态角色注入（见 §6）。

---

## 1. 持久化状态机与崩溃恢复（替代收益最大）

**AFR 里对应**：`lib/scheduler.mjs`、`lib/store.mjs`、`lib/tasklock.mjs`、`lib/recovery.mjs`

| 候选 | 星数 | 许可 | 最后推送 | 对位说明 |
|---|---|---|---|---|
| [conductor-oss/conductor](https://github.com/conductor-oss/conductor) | **32,198** | Apache-2.0 | 2026-09-15 | ⭐ **首选**。JSON 工作流图 + 每步持久化 + restart/rerun/pause/resume + 原生 LLM/MCP 任务 + human approval + 5 种持久化后端；"引擎确定性、worker 不必确定性"正好替掉手写状态机 |
| [temporalio/temporal](https://github.com/temporalio/temporal) | 23,064 | MIT | 2026-09-15 | 事实标准，但 code-first、要求代码可重放，迁移量最大 |
| [rivet-dev/actors](https://github.com/rivet-dev/actors) | 6,134 | Apache-2.0 | 2026-09-15 | 有状态工作负载原语，面向 AI agent，比 Temporal 轻 |
| [restatedev/restate](https://github.com/restatedev/restate) | 4,420 | NOASSERTION | 2026-09-15 | 免依赖持久化执行 |
| [microsoft/pg_durable](https://github.com/microsoft/pg_durable) | 2,816 | NOASSERTION | 2026-09-14 | Postgres 内数据库级持久化执行（**v1 漏**） |
| [dbos-inc/dbos-transact-py](https://github.com/dbos-inc/dbos-transact-py) | 1,577 | MIT | 2026-09-16 | 数据库承载的持久化工作流 |
| [shepherd-agents/shepherd](https://github.com/shepherd-agents/shepherd) | 2,411 | MIT | 2026-09-09 | ⭐ **v1 漏，但很关键**：把执行变成**可逆的 Git-like trace**，meta-agent 可 observe / fork / **rollback**——这正是 AFR `recovery.mjs` 想达到的能力 |
| [resonatehq/resonate](https://github.com/resonatehq/resonate) | 669 | — | 2026-09-12 | Distributed Async Await |

**若只想换存储与锁、不动状态机**：

| 候选 | 星数 | 许可 | 最后推送 | 说明 |
|---|---|---|---|---|
| [WiseLibs/better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | 7,487 | MIT | 2026-08-10 | 用 **SQLite WAL + `BEGIN IMMEDIATE` 事务**取代「原子文件 + 自研排他锁」。mission-control 已在用 |
| ~~moxystudio/node-proper-lockfile~~ | 285 | MIT | **2023-10-25** | **排除**：近三年未推送。锁应交给 SQLite 事务 |

---

## 2. 多执行器接入与监管（v2 大幅加强）

**AFR 里对应**：`lib/adapters.mjs`、`lib/executor-router.mjs`、`lib/executor-status.mjs`

| 候选 | 星数 | 许可 | 最后推送 | 对位说明 |
|---|---|---|---|---|
| [ruvnet/ruflo](https://github.com/ruvnet/ruflo)（原 claude-flow） | **72,518** | MIT | 2026-09-15 | ⭐ **v1 漏**。最老牌的 agent harness + swarm 编排，"deploy multi-player swarms, coordinate autonomous workflows" |
| [Hmbown/Codewhale](https://github.com/Hmbown/Codewhale) | 40,981 | MIT | 2026-09-15 | **v1 漏**。Rust 终端编码 agent |
| [tinyhumansai/openhuman](https://github.com/tinyhumansai/openhuman) | 39,808 | GPL-3.0 | 2026-09-15 | **v1 漏**。local-first harness + 编排 + 记忆。⚠️ GPL-3.0 需评估传染性 |
| [Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) | 39,184 | MIT | 2026-09-15 | **v1 漏**。Teams-first 多 agent 编排 |
| [herdrdev/herdr](https://github.com/herdrdev/herdr) | 38,667 | Apache-2.0 | 2026-09-15 | **v1 漏**。"the runtime your coding agents live on" |
| [musistudio/claude-code-router](https://github.com/musistudio/claude-code-router) | **37,248** | MIT | 2026-09-15 | ⭐ **v1 漏，但对位最准**。"One local control plane for every AI agent: route across models, orchestrate tools"——正是 AFR adapter+router 这一层 |
| [openai/symphony](https://github.com/openai/symphony) | 27,219 | Apache-2.0 | 2026-09-09 | 把项目工作变成隔离的自主实现运行 |
| [getpaseo/paseo](https://github.com/getpaseo/paseo) | 17,369 | NOASSERTION | 2026-09-15 | **v1 漏**。桌面+移动端编排多个编码 agent |
| [superset-sh/superset](https://github.com/superset-sh/superset) | 14,242 | NOASSERTION | 2026-09-15 | 编排 100+ 并行编码 agent |
| [Untrivial-ai/agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | 12,068 | Apache-2.0 | 2026-09-15 | Go，"规划到合并监督团队，+25 种 harness"。⚠️ 714 open issues |
| [omnigent-ai/omnigent](https://github.com/omnigent-ai/omnigent) | 9,964 | Apache-2.0 | 2026-09-15 | meta-harness，可换 harness。⚠️ 1,361 open issues |
| [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) | 8,482 | AGPL-3.0 | 2026-08-20 | **v1 漏**。终端多 agent 管理。⚠️ AGPL |
| [chaitanyagiri/munder-difflin](https://github.com/chaitanyagiri/munder-difflin) | 7,187 | MIT | 2026-09-15 | **v1 漏**。本地多 agent harness，复用已有订阅 |
| [zhnt/loushang](https://github.com/zhnt/loushang) | 1,454 | Apache-2.0 | 2026-09-14 | **v1 漏**。多模型编排 + 有状态会话 + 工具治理 |
| [xvirobotics/metabot](https://github.com/xvirobotics/metabot) | 982 | MIT | 2026-09-11 | **v1 漏**。受监督、自进化 agent 组织（中文项目） |
| [mixpeek/amux](https://github.com/mixpeek/amux) | 454 | NOASSERTION | 2026-09-15 | 概念几乎逐字对应 AFR：control plane for AI coding agents |

**v2 结论变化**：这一层不是"omnigent 或 agent-orchestrator 二选一"，而是**有十余个成熟实现**，且 `claude-code-router` 与 AFR 的分层最接近。选型应按**许可 + 活跃度 + 是否支持你的 5 种执行器**来筛，而不是按星数。

---

## 3. 控制平面 / 任务板 / 门禁

**AFR 里对应**：`approval/intent-gate.mjs`、`intent/*`、`lib/executor-ops.mjs`、`af-admin.mjs`

| 候选 | 星数 | 许可 | 最后推送 | 对位说明 |
|---|---|---|---|---|
| [builderz-labs/mission-control](https://github.com/builderz-labs/mission-control) | **6,219** | MIT | 2026-09-14 | ⭐ 单点替代收益最高：「派发→执行→review→**质量门禁（必须有 approval 记录）**→完成回执」+ SQLite WAL + MCP/CLI/REST/WebSocket。状态 alpha |
| [huangruiteng/loopx](https://github.com/huangruiteng/loopx) | 5,856 | Apache-2.0 | 2026-09-15 | ⭐ **长时程状态内核**：objective/gates/todos/evidence/quota/handoff + 断点恢复 + 人工门禁 + peer-agent 租赁。**原生支持 DeepSeek Harness** |
| [Nasiko-Labs/nasiko](https://github.com/Nasiko-Labs/nasiko) | 6,609 | NOASSERTION | 2026-09-14 | **v1 漏**。Rust，"Developer Control Plane for AI Agents" |
| [YaoApp/yao](https://github.com/YaoApp/yao) | 7,955 | NOASSERTION | 2026-09-10 | **v1 漏**。所有 agent 与工作区集中在一处，看板式任务管理 |
| [darrenhinde/OpenAgentsControl](https://github.com/darrenhinde/OpenAgentsControl) | 4,853 | MIT | 2026-09-13 | plan-first + **approval-based execution** |
| [mikeyobrien/ralph-orchestrator](https://github.com/mikeyobrien/ralph-orchestrator) | 3,139 | MIT | 2026-09-10 | Ralph 循环技术的改进实现（AFR 的 fix-loop 与它同族） |
| [spec-kitty/spec-kitty](https://github.com/spec-kitty/spec-kitty) | 1,625 | — | 2026-09-15 | 规格驱动开发 + 门禁 |
| [modu-ai/moai-adk](https://github.com/modu-ai/moai-adk) | 1,213 | Apache-2.0 | 2026-09-15 | **v1 漏**。SPEC 驱动 plan/run/sync + **TRUST 5 质量门禁** |
| [Ibrahim-3d/orchestrator-supaconductor](https://github.com/Ibrahim-3d/orchestrator-supaconductor) | 377 | AGPL-3.0 | 2026-04-08 | **v1 漏**。并行执行 + 自动质量门禁 |
| [looptroop-ai/LoopTroop](https://github.com/looptroop-ai/LoopTroop) | 142 | MIT | 2026-09-15 | **v1 漏**。LLM-council 规划 + Ralph-loop 恢复 + 隔离 worktree |

---

## 4. 熔断 / 降级 / 冷却（不该手写）

**AFR 里对应**：`lib/executor-runtime-guard.mjs` 断路器部分（我们修的 C1/C5/M5/M9 全在这里）

| 候选 | 星数 | 许可 | 最后推送 | 说明 |
|---|---|---|---|---|
| [connor4312/cockatiel](https://github.com/connor4312/cockatiel) | 1,818 | MIT | 2026-09-06 | ⭐ **Node 首选**：backoff / retry / **circuit breaker** / timeout |
| [nodeshift/opossum](https://github.com/nodeshift/opossum) | 1,687 | Apache-2.0 | 2026-08-21 | ⭐ **Node**：断路器，fails fast |
| [App-vNext/Polly](https://github.com/App-vNext/Polly) | 14,236 | BSD-3-Clause | 2026-09-14 | .NET 生态标准 |
| [sony/gobreaker](https://github.com/sony/gobreaker) | 3,695 | MIT | 2026-02-07 | Go |
| [cep21/circuit](https://github.com/cep21/circuit) | 815 | Apache-2.0 | 2026-08-30 | Go，Hystrix 风格完整实现 |

**LLM provider 错误分类 / 限流 / 降级**（对位 `lib/executor-error-classifier.mjs`）：

| 候选 | 星数 | 许可 | 最后推送 | 说明 |
|---|---|---|---|---|
| [BerriAI/litellm](https://github.com/BerriAI/litellm) | 58,791 | NOASSERTION | 2026-09-15 | Router 的 `allowed_fails`/`cooldown_time`/**按错误类型分设重试**。⚠️ 断路器**不会自愈**（issue #30192 / #37592） |
| [Portkey-AI/gateway](https://github.com/Portkey-AI/gateway) | 12,998 | MIT | 2026-05-25 | 1,600+ LLM 路由 + guardrails |
| [looplj/axonhub](https://github.com/looplj/axonhub) | 5,228 | NOASSERTION | 2026-09-15 | 内置 failover / 负载均衡 |

**结论**：断路器状态机 + 冷却 + 半开是几十年成熟模式，一般**不该手写**（C5"状态文件损坏导致全量解禁"就是手写状态机的经典翻车）。

> ⚠️ **本条对本项目不成立——已实测否决。** 本表给出的是"存在成熟库"这一事实，但**不表示 AFR 应当采纳**。
> 核对 `lib/executor-runtime-guard.mjs` 后确认：
>
> - 它**没有阈值/计数逻辑**（`recordResult` 按 `safety_action` 立即开闸），库的 `ConsecutiveBreaker` 无处可用
> - 库按设计**自动半开自愈**，而 AFR 的保证是**永不自动自愈、必须人工 probe→admit** → 用库需压制其核心特性
> - C5 的真实根因是**持久化与错误处理**（非原子写、`catch {}` 吞错），换库不会自动修复
>
> 完整论证见 [`adr/0004-reject-breaker-library.md`](adr/0004-reject-breaker-library.md)。
> **教训**：模块图能回答"有没有成熟方案"，但不能回答"该不该换"——后者必须核对被替换代码的实际形态。

---

## 5. 策略 / 动作合约 / 白名单

**AFR 里对应**：`intent/action-validator.mjs`、`contracts/`、`config/acceptance-allowlist.json`、`config/executor-safety-profiles.json`

| 候选 | 星数 | 许可 | 最后推送 | 说明 |
|---|---|---|---|---|
| [open-policy-agent/opa](https://github.com/open-policy-agent/opa) | **12,239** | Apache-2.0 | 2026-09-16 | ⭐ 策略引擎**事实标准**。Rego 声明式策略 + 单测 + 决策日志，替掉"手写白名单+手写校验器+手写审计" |
| [cerbos/cerbos](https://github.com/cerbos/cerbos) | 4,588 | Apache-2.0 | 2026-09-16 | YAML 策略 + 测试，比 OPA 易上手 |

---

## 6. ⚠️ 建议保留自研（没有成熟对等品）

| 保留项 | 所在 | 为什么没有对等品 |
|---|---|---|
| **验收命令静态白名单 + 内容哈希锚定** | `lib/acceptance.mjs` + `config/acceptance-allowlist.json` | 我们这几轮把它修成「命令+参数前缀双匹配」+「执行前校验完整性哈希」+「首次见到即锚定、验收跑过后缺失即篡改」。成熟 agent 框架**都不做"验收命令本身可被篡改"这一层**，默认配置可信 |
| **`ROLE != PLATFORM` 动态角色注入** | `orchestrator.mjs` + `lib/executor-router.mjs` | 同一平台可在任务 A 当 author、任务 B 当 reviewer，平台与岗位不绑定。CrewAI/AutoGen/LangGraph 通常把 agent 定义与角色写死在一起 |

**建议**：这两条应**移植进新方案**，而不是被替换。

---

## 7. 执行沙箱（一次解决三个问题）

现状：拿操作员权限裸跑 + 我这几轮加的 rlimits（磁盘/CPU/核心转储）+ 进程组树杀。
**内存限制做不到**（本机无 cgroup 委派），孤儿进程仍有理论缺口（双 fork + setsid）。

| 候选 | 星数 | 许可 | 最后推送 | 说明 |
|---|---|---|---|---|
| [opensandbox-group/OpenSandbox](https://github.com/opensandbox-group/OpenSandbox) | **15,315** | Apache-2.0 | 2026-09-15 | 面向 AI agent 的安全沙箱运行时 |
| [TencentCloud/CubeSandbox](https://github.com/TencentCloud/CubeSandbox) | 12,502 | — | 2026-09-15 | 即时、并发、轻量 |
| [containers/bubblewrap](https://github.com/containers/bubblewrap) | 8,740 | NOASSERTION | 2026-09-15 | Flatpak 在用的无特权沙箱 |
| [agent-infra/sandbox](https://github.com/agent-infra/sandbox) | 5,917 | — | 2026-09-14 | 一体化（Browser+Shell+File+MCP+VSCode Server） |
| [google/nsjail](https://github.com/google/nsjail) | 4,109 | Apache-2.0 | 2026-08-27 | namespace + **cgroup**，正好补上内存限制 |
| [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) | 3,880 | Apache-2.0 | 2026-09-15 | K8s SIG 官方 |
| [microsoft/agent-governance-toolkit](https://github.com/microsoft/agent-governance-toolkit) | 6,266 | MIT | 2026-09-15 | 策略强制 + 零信任身份 + **执行沙箱** |
| [cisco-ai-defense/defenseclaw](https://github.com/cisco-ai-defense/defenseclaw) | 841 | Apache-2.0 | 2026-09-15 | **v1 漏**。Agentic AI 安全治理 |

---

## 8. 子进程 / 工作树 / 治理 / 规划 / 评审

| AFR 模块 | 候选 | 星数 | 许可 | 最后推送 | 说明 |
|---|---|---|---|---|---|
| `lib/child-process.mjs`（我手写的） | [sindresorhus/execa](https://github.com/sindresorhus/execa) | 7,603 | MIT | 2026-07-31 | 成熟 Node 进程库，已处理 kill 树/超时/清理。**诚实说**：我手写那份只因为该仓库坚持零依赖 |
| `lib/worktree.mjs` | [max-sixty/worktrunk](https://github.com/max-sixty/worktrunk) | 7,746 | NOASSERTION | 2026-09-15 | 专为并行 agent 工作流设计 |
| 同上 | [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) | 8,482 | AGPL-3.0 | 2026-08-20 | **v1 漏** |
| 同上 | [raine/workmux](https://github.com/raine/workmux) | 2,627 | MIT | 2026-09-14 | git worktree + tmux |
| 同上 | [standardagents/dmux](https://github.com/standardagents/dmux) | 1,773 | MIT | 2026-08-16 | dev agent 多路复用器 |
| `lib/governance.mjs` | [microsoft/agent-governance-toolkit](https://github.com/microsoft/agent-governance-toolkit) | 6,266 | MIT | 2026-09-15 | 见 §7 |
| 同上 | [sipyourdrink-ltd/bernstein](https://github.com/sipyourdrink-ltd/bernstein) | 1,180 | Apache-2.0 | 2026-09-15 | 声明式规则强制执行 |
| `planner/` + `codex-planner.mjs` | [FoundationAgents/MetaGPT](https://github.com/FoundationAgents/MetaGPT) | **70,400** | — | 2026-01-21 | **v1 漏**。⚠️ 已停更约 8 个月 |
| 同上 | [microsoft/autogen](https://github.com/microsoft/autogen) | 60,994 | **CC-BY-4.0** | 2026-04-15 | **v1 漏**。⚠️ 许可非软件许可 + 5 个月未推送 |
| 同上 | [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) | 58,592 | MIT | 2026-09-15 | **v1 漏**。角色扮演式多 agent 编排 |
| 同上 | [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | 41,697 | MIT | 2026-09-14 | 图式编排，最成熟 |
| 同上 | [openai/openai-agents-python](https://github.com/openai/openai-agents-python) | 29,455 | MIT | 2026-09-15 | 轻量编排 |
| 同上 | [mastra-ai/mastra](https://github.com/mastra-ai/mastra) | 28,066 | NOASSERTION | 2026-09-15 | **v1 漏**。TS 生态 |
| 同上 | [microsoft/agent-framework](https://github.com/microsoft/agent-framework) | 13,532 | MIT | 2026-09-15 | Python + .NET |
| `lib/reviews.mjs` / 验收 | [alibaba/open-code-review](https://github.com/alibaba/open-code-review) | **27,549** | Apache-2.0 | 2026-09-15 | 确定性管线 + LLM agent 混合 |
| 同上 | [The-PR-Agent/pr-agent](https://github.com/The-PR-Agent/pr-agent) | 13,000 | MIT | 2026-09-15 | **v1 漏**。原版开源 PR reviewer |
| 同上 | [mattzcarey/shippie](https://github.com/mattzcarey/shippie) | 2,506 | MIT | 2026-09-13 | **v1 漏**。可扩展 review + QA agent |
| 同上 | [kenn-io/roborev](https://github.com/kenn-io/roborev) | 1,715 | MIT | 2026-09-15 | **v1 漏**。逐行问责的 review 数据库 |
| 同上 | [pedrohcgs/claude-code-my-workflow](https://github.com/pedrohcgs/claude-code-my-workflow) | 1,583 | MIT | 2026-08-24 | **v1 漏**。多 agent review + 质量门禁模板 |
| 同上 | [first-fluke/oh-my-agent](https://github.com/first-fluke/oh-my-agent) | 1,300 | MIT | 2026-09-15 | **v1 漏**。按**产物**验证 agent 运行 |
| 同上 | [amElnagdy/guard-skills](https://github.com/amElnagdy/guard-skills) | 1,243 | MIT | 2026-07-04 | **v1 漏**。捕获 AI 生成失败模式的质量门禁 |
| 同上 | [dsifry/metaswarm](https://github.com/dsifry/metaswarm) | 419 | MIT | 2026-06-19 | **v1 漏**。自改进多 agent 编排 |
| 同上 | [huanchong-99/SoloDawn](https://github.com/huanchong-99/SoloDawn) | 315 | NOASSERTION | 2026-09-08 | **v1 漏**。三道质量门 + 31 条规则 + 自愈环 |
| 评审（MCP 形态） | [BeehiveInnovations/pal-mcp-server](https://github.com/BeehiveInnovations/pal-mcp-server) | 11,748 | NOASSERTION | **2025-12-15** | **v1 漏**。⚠️ 停更约 9 个月 |

---

## 9. 台账：已研究但**不适用**于 AFR 的项目（不静默丢弃）

| 项目 | 星数 | 状态 | 为什么不适用 |
|---|---|---|---|
| [21st-dev/1code](https://github.com/21st-dev/1code) | 5,599 | **ARCHIVED** | 已归档，不再维护 |
| [tensorzero/tensorzero](https://github.com/tensorzero/tensorzero) | 11,720 | **ARCHIVED** | 已归档 |
| [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) | 28,091 | 仓库活跃但**官方公告停运** | README 顶部已挂 sunsetting |
| [stravu/crystal](https://github.com/stravu/crystal) | 3,119 | 已改名 **Nimbalyst**，旧仓库 **2026-02-26** 后无动静 | 需找新家再评估 |
| [humanlayer/agentcontrolplane](https://github.com/humanlayer/agentcontrolplane) | 479 | **2025-07-02** 后无动静 | 名字最像 AFR（"Agent Control Plane"）但已休眠 |
| [humanlayer/humanlayer](https://github.com/humanlayer/humanlayer) | 11,539 | 2026-06-19 | 偏"让 agent 解决复杂代码库问题"的工作流，与 AFR 的控制平面定位重叠有限 |
| [pedrohcgs/claude-code-my-workflow](https://github.com/pedrohcgs/claude-code-my-workflow) | 1,583 | 学术 LaTeX 模板 | 领域不符（已在 §8 仅作质量门禁参考） |
| `msitarzewski/agency-agents` / `jnMetaCode/agency-agents-zh` / `vijaythecoder/awesome-claude-agents` | 152k / 20.7k / 4.4k | 活跃 | 是**角色/提示词合集**，不是可替换的模块 |
| `sickn33/agentic-awesome-skills` / `ai-boost/awesome-harness-engineering` | 46.4k / 4.2k | 活跃 | 是**清单/知识库**，不是实现 |
| `TauricResearch/TradingAgents` / `TradingAgents-CN` | 106k / 31.8k | 活跃 | 领域不符（金融交易） |
| `cirosantilli/china-dictatorship` 等搜索结果噪声 | — | — | 关键词误命中，与主题无关 |

> 说明：`microsoft/pg_durable`、`Nasiko-Labs/nasiko`、`cisco-ai-defense/defenseclaw`、`shepherd-agents/shepherd`、
> `ruvnet/ruflo`、`Hmbown/Codewhale`、`tinyhumansai/openhuman`、`Yeachan-Heo/oh-my-claudecode`、`herdrdev/herdr`、
> `musistudio/claude-code-router`、`getpaseo/paseo`、`chaitanyagiri/munder-difflin`、`smtg-ai/claude-squad`、
> `The-PR-Agent/pr-agent`、`mattzcarey/shippie`、`kenn-io/roborev`、`first-fluke/oh-my-agent`、`amElnagdy/guard-skills`、
> `modu-ai/moai-adk`、`dsifry/metaswarm`、`huanchong-99/SoloDawn`、`looptroop-ai/LoopTroop`、`crewAI`、`microsoft/autogen`、
> `FoundationAgents/MetaGPT`、`mastra-ai/mastra`、`zhnt/loushang`、`xvirobotics/metabot`、`YaoApp/yao`、`mikeyobrien/ralph-orchestrator`、
> `Ibrahim-3d/orchestrator-supaconductor`、`spec-kitty` 等 **v1 漏项已在 §1–§8 归位**。

---

## 10. 三条组装路线

### 路线 1：最小改动，保留状态机（推荐先试）
```
better-sqlite3 (WAL + 事务)   ← 替 store.mjs + tasklock.mjs
cockatiel 或 opossum          ← 替 runtime-guard 的断路器
litellm Router 或 axonhub     ← 替 error-classifier 的 provider 分类与限流
OPA 或 cerbos                 ← 替 action-validator + 白名单文件
execa                         ← 替 child-process.mjs
nsjail / bubblewrap           ← 给验收与执行器加沙箱（一次解决内存+孤儿+污染）
保留：调度状态机、ROLE≠PLATFORM、验收静态白名单+锚定
```
**代价**：引入依赖（违背"零外部重依赖"原则，但该原则本身没有对等品价值）。

### 路线 2：换掉状态机，保留业务语义
```
conductor                      ← 替 scheduler + store + tasklock + recovery
claude-code-router 或 omnigent ← 替 adapters + router（v2 新增的候选池按许可/活跃度筛）
shepherd                       ← 参考它的可逆 trace 做 rollback
保留：验收白名单+锚定、ROLE≠PLATFORM（作为 worker 策略）
```
**代价**：执行模型改为 JSON graph，`executeTask` 循环重写。

### 路线 3：整体替代
```
loopx 或 mission-control       ← 直接当控制平面
AFR 只保留两个思想：验收静态白名单 + ROLE≠PLATFORM
```
**代价**：AFR 存在意义基本消失（除非它有独有业务逻辑）。

---

## 11. 决策表

| 你的目标 | 路线 | 理由 |
|---|---|---|
| 保留 AFR 架构，只换危险的手写件 | **1** | 改动可控、逐模块可回退 |
| 要生产级可靠，不想维护状态机 | **2** | 持久化执行交给专门引擎 |
| 尽快得到能用的多 agent 编排 | **3** | 成熟方案已存在（loopx 原生支持 DSH） |
| 学习 / 完全掌控 | 保持现状 + 只采纳 §4（断路器库）与 §7（沙箱） | 投入产出比最高且不动架构 |

---

## 附：数据口径与免责

- 星数 / 许可 / 最后推送均为**本会话 GitHub search API 实测**，非记忆值。同名仓库已逐个精确匹配。
- 已排除的候选：`node-proper-lockfile`（2023-10 后未推送）；已标注的归档项：`1code`、`tensorzero`；已标注的停运/休眠项：`vibe-kanban`、`crystal`、`humanlayer/agentcontrolplane`、`pal-mcp-server`；已标注的停更项：`MetaGPT`（8 个月）、`autogen`（5 个月）。
- `NOASSERTION` = GitHub 未能识别许可，采纳前必须自行确认许可文本。
- ⚠️ 两个 open issue 数偏高的项目已标注：`omnigent` 1,361 / `agent-orchestrator` 714。
- ⚠️ 许可需注意的：`openhuman` GPL-3.0、`claude-squad` AGPL-3.0、`orchestrator-supaconductor` AGPL-3.0、`autogen` CC-BY-4.0（非软件许可）。

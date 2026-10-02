# Agent Foundry Next

[![regression](https://github.com/rejec-rot/agent-foundry-orchestrator/actions/workflows/regression.yml/badge.svg?branch=agent-foundry-next)](https://github.com/rejec-rot/agent-foundry-orchestrator/actions/workflows/regression.yml?query=branch%3Aagent-foundry-next)

面向共享目标的多 agents 协作平台：主作者组织分工与整合，多个 worker 独立执行、交换消息，用户能调整指定工作项。**Trusted Import V2** 负责成果的独立评审、授权、验收与正式代码提升。

当前版本：`2.0.0-dev`。方案二的首期协作核心已实现，入口是 **`/teams.html`** 和 **`af-admin team`**。历史单作者 V2 链路完成过本地 Docker 部署验收及 Codex＋Cline 冒烟；新团队链路的真实模型账号联调仍需单独验收。

项目源自 `opperl1114/agent-foundry-orchestrator` 的 `434114e`（v1.2.0），是独立升级线。许可仍为 `UNLICENSED`，公开发布条件见 [NOTICE.md](NOTICE.md) 和 [ADR-0003](docs/adr/0003-upstream-license-unresolved.md)。

## 新人先看：一个目标怎样完成

你提供目标、项目路径和验收要求。主作者把目标拆成有依赖关系的工作项；workers 执行分工、交换信息并提交成果；主作者整合后，交付服务完成独立评审、授权和验收。

下面的 Mermaid 流程图可在 GitHub README 中直接查看。主线按从上到下阅读，虚线表示用户介入与成员通信。不支持 Mermaid 的阅读器可打开[协作流程 SVG](docs/diagrams/team-workflow.svg)。

```mermaid
flowchart TD
    USER["用户提交目标、项目与验收要求"] --> CONTROL["团队控制器登记目标并绑定成员"]
    CONTROL --> LEAD["主作者拆解工作项、分工与依赖"]
    LEAD --> WORK["Workers 按依赖执行<br/>额度允许时，独立任务并行"]
    WORK -. "下一轮执行领取" .-> MESSAGE["成员请求与回复"]
    MESSAGE -. "交换信息" .-> WORK
    USER -. "定向调整或改派" .-> ADJUST["更新工作项版本<br/>停止旧尝试，使受影响下游失效"]
    ADJUST --> WORK
    WORK --> ARTIFACT["提交不可变成果<br/>拒绝过期尝试的结果"]
    ARTIFACT --> INTEGRATE["主作者整合团队成果"]
    INTEGRATE --> SEAL["确认所有写者停止<br/>捕获并密封候选代码"]
    SEAL --> REVIEW{"独立评审通过？"}
    REVIEW -- "需返工且有预算" --> FIX["主作者选择相关工作项返工"]
    FIX --> WORK
    REVIEW -- "通过" --> AUTH["授权检查<br/>必要时等待人工批准"]
    AUTH --> VERIFY["执行受信验收命令<br/>绑定候选与验收证据"]
    VERIFY --> PASS{"验收通过？"}
    PASS -- "通过" --> PROMOTE["最终校验并原子晋升正式版本"]
    PROMOTE --> DONE["记录完成状态与交付证据"]
    PASS -- "不通过" --> BLOCK["阻止交付<br/>查看失败证据后处理"]
    REVIEW -- "无法继续" --> BLOCK
```

这张图描述正常协作与交付路径。授权未通过、整合发生冲突、执行预算耗尽或旧执行范围无法确认时，系统会停留在相应待处理状态；不会绕过检查直接交付。

## 谁负责什么

| 角色 | 职责 |
|---|---|
| 用户 | 定义目标与验收要求，查看进展，调整工作方向、改派、暂停或取消，处理人工审批 |
| 主作者 | 规划工作图与依赖，协调成员，整合成果，根据评审反馈选择局部返工 |
| Workers | 完成各自工作项，向成员提问或回复，提交可追踪的成果 |
| 团队控制器 | 管理调度、消息、版本、运行记录与恢复；这是后台服务，不是模型成员 |
| 独立评审者 | 审查密封候选；其执行器与所有团队写入执行器分别绑定 |
| Trusted Import V2 | 承接代码交付，检查授权、执行验收并晋升正式版本 |

默认团队是一名主作者加三个 worker，worker 数量可配置为 **1–8 个**。成员身份与执行器、模型账号、CLI 会话分别记录；成员数量不等于不同账号的数量，也不保证所有成员同时执行。

## 中途改需求会怎样

例如，主作者把登录功能分成接口、独立的页面框架和集成测试。这里假定页面框架不依赖接口实现，集成测试依赖二者。你调整接口工作项后，接口和受影响的测试重新执行，页面框架成果保留。

```mermaid
flowchart LR
    USER["用户调整接口要求"] --> API["接口工作项<br/>新版本重新执行"]
    API --> TEST["集成测试<br/>依赖受影响，重新执行"]
    UI["独立页面框架<br/>保留已接受成果"] --> TEST
    OLD["接口旧尝试的迟到结果"] -. "版本校验拒绝" .-> REJECT["不能覆盖新方向"]
    classDef rerun fill:#fff3cd,stroke:#946200,color:#332600;
    classDef retained fill:#e6f4ea,stroke:#26713d,color:#153e22;
    classDef rejected fill:#fce8e6,stroke:#a83228,color:#591b16;
    class API,TEST rerun;
    class UI retained;
    class OLD,REJECT rejected;
```

也可直接打开[局部返工 SVG](docs/diagrams/team-rework.svg)。是否保留成果由工作图的实际依赖决定。页面和命令行通过 `queued`（已排队）、`received`（已接收）、`applied`（已落实）区分操作回执；成员消息的领取和落实以受控执行记录为依据。消息在下一轮执行时领取，目前不支持运行中的即时注入。

## 从哪里开始

1. 阅读上面的流程和[当前能力与边界](#当前能力与边界)，了解协作与交付分别负责什么。
2. 按[环境与配置](#环境与配置)准备 Node.js、Git、执行器认证与隔离；配置项目注册表和受信验收 profile。
3. 按[团队入口](#团队入口)创建并启动目标，在 `/teams.html` 查看分工、依赖、消息、成果和交付状态。
4. 开发者从 `lib/team/`、`server/read-api.mjs` 和 `tests/team-*.test.mjs` 开始；部署与恢复参考[运维手册](OPERATOR_RUNBOOK.md)。

## 当前能力与边界

| 能力 | 当前状态 |
|---|---|
| 团队协作 | 常驻控制器、主作者与 1–8 个注册 worker、工作依赖、独立尝试与不可变产物 |
| 成员通信与人工调整 | 版本化消息、成员回复、工作项改派、定向失效、queued/received/applied 回执 |
| 团队恢复 | 租约与提交序号、指令去重、已确认 scope 的中断恢复；未知写者阻止重跑与交付 |
| V2 主入口 | 显式设置 `trusted_import.enabled: true` 后启用 |
| 独立评审 | 显式指定独立 reviewer，评审密封候选快照 |
| 捕获与授权 | 文件系统捕获、内容寻址存储（CAS）、快照、差异及累计授权闭包 |
| 验收与提升 | 白名单命令、PASS 证据绑定、最终重新校验、Git 原子提升 |
| 并发与恢复 | 旧基线重基、同路径冲突拒绝、提升后崩溃恢复与祖先关系校验 |
| 写者回收 | Docker 或 delegated cgroup；进程组退出本身不证明所有写者已停止 |
| 持久化回收 | 未确认 scope 清空时保留句柄；dry-run 不执行 scope 回收 |

Trusted Import 交付服务接纳 `workspace` 代码成果；团队的工作图、通信和调整由协作控制器管理。独立评审反馈能返回主作者选择局部返工，签名审批通过正常入口恢复。旧历史任务保留原流程；新的团队任务由兼容入口转交协作控制器，旧 scheduler 不能再直接派发。

## 团队入口

先按既有部署要求配置项目注册表、验收 profile 和执行器隔离。创建使用与 V2 相同的提交 JSON：`goal`、`target_path`、`acceptance`、`idempotency_key`；执行器由平台绑定。

将下面的示例保存为 `team-goal.json`，并替换项目路径、目标与验收命令。验收命令必须与项目已登记的受信 profile 一致；`idempotency_key` 用于识别同一提交的重试。

```json
{
  "goal": "为已登记的项目完成登录功能，并通过验收测试",
  "target_path": "/path/to/registered-project",
  "acceptance": {"command": "node", "args": ["--test", "tests/auth.test.mjs"]},
  "idempotency_key": "login-feature-001"
}
```

```bash
node af-admin.mjs team create --spec team-goal.json --root /path/to/registered-project --workers 3
node af-admin.mjs team list
node af-admin.mjs team start --team TEAM-your-task-id
node af-admin.mjs team show --team TEAM-your-task-id
node af-admin.mjs team adjust --team TEAM-your-task-id --work-item your-work-item --expected-revision 1 --message "新的工作方向"
```

首次操作会启动持有全局团队租约的本地控制器；也可用 `node af-admin.mjs team serve` 在前台运行。前台服务收到 SIGINT/SIGTERM 时停止派发并等待受控执行范围退出。运行目录与任务目录通过 `AF_RUNTIME_DIR`、`AF_TASKS_DIR`、`AF_LOCKS_DIR` 或对应 CLI 参数配置，所有入口应使用同一组目录。自动启动的进程 PID 和 owner token 在 `locks/team-controller.lock`，日志在 `runtime/team-controller.log`。

Web 使用现有令牌鉴权启动：`node af-admin.mjs web serve --allow-write --root /path/to/registered-project`，打开 `/teams.html`。页面支持创建、启动、查看分工、成员消息、定向调整、暂停和继续交付。消息在下一轮执行中领取；不会显示未经控制器确认的“已落实”。额度允许时独立工作项并行执行，单项调整保留无关产物；已完成目标再次调整会采用最新 canonical 基线进入新目标版本。

首期使用原子文件和不可变顺序日志，未引入数据库或模型框架。跨目标成员共享与模型运行中实时消息注入尚未实现。设计、部署假设和验收证据分别见[方案二](docs/design/MULTI-AGENT-PLAN-B-COLLABORATION-CORE.md)、[ADR 0011](docs/adr/0011-team-collaboration-controller.md) 和[实施记录](docs/reviews/2026-10-01-team-core-implementation.md)。

## Trusted Import 流程

```text
受信任务定义 + canonical 基线
  → 投影到 candidate
  → author 执行
  → 终止并验证 writer scope
  → 捕获文件、密封快照、计算差异
  → 必要时重基（冲突则拒绝）
  → 独立 reviewer 评审
  → 累计授权闭包
  → 隔离验收与证据绑定
  → 最终重新校验
  → 原子更新 refs/afr/canonical
  → 物化、验证、记录完成状态
```

`canonical` 是正式接受的代码版本。执行器修改 candidate，不直接写 canonical Git 对象或 Trusted CAS。行为规则不替代运行时隔离。

任务记录是生命周期依据；提升前持久化事务意图。更新 Git ref 后崩溃，恢复流程验证原提交；canonical 被后续任务推进时，可通过祖先关系识别原事务已成功。

## 已验证结果

以下是阶段性记录，不是自动更新的实时测试计数；当前结果以实际运行输出为准。

| 范围 | 记录结果 | 说明 |
|---|---|---|
| 协作核心与全量回归（2026-10-01） | 802 项：799 通过、3 跳过、0 失败、0 取消 | 模型输出使用受控适配器；文件投影、CAS、锁、验收和 Git 晋升使用实际实现；见[实施记录](docs/reviews/2026-10-01-team-core-implementation.md) |
| 团队页面（2026-10-01） | 桌面与手机浏览器检查通过 | 覆盖创建、鉴权、消息回执、定向调整、无关成果保留、旧尝试拒绝及刷新恢复；使用受控模型适配器 |
| V2、回收与终止句柄回归（`8c91800`） | 68/68 通过 | 包括 dry-run、取消、并发与崩溃恢复 |
| Docker 部署验收（`358f99c`） | 2/2 通过 | 本地确定性执行器，`node:24-alpine`，网络为 `none` |
| 默认回归（`358f99c` 阶段） | 362 项：359 通过、3 跳过、0 失败、0 取消 | 跳过两个部署用例及真实 Codex GP-4 |
| 真实 Codex＋Cline 冒烟（2026-09-20） | `COMPLETED / PROMOTED` | reviewer PASS，acceptance PASS（1/1） |

真实冒烟配置：

- author：Codex `gpt-6-astra`。
- reviewer：Cline `cline-free/deepseek-v4.1-flash`。
- Docker 镜像：`node:24-slim`。
- canonical 新增 `src/smoke-message.txt`，内容为 `V2 real executor smoke passed`。
- 双方 writer scope 确认清空，记录的 `af-sbx-*` 残留为 0。

该次真实冒烟使用 **host 网络**访问宿主代理，不是断网运行，也不能据此声称网络隔离。证据编号为 `TASK-REAL-V2-CLINE-SMOKE-a9054943`；原始记录保存在部署主机的 `real-smoke-evidence/`，不随仓库分发。

## 环境与配置

需要 Node.js >= 20、Git，以及对应执行器 CLI 和有效认证。已验证的 Docker 镜像使用 Node.js 24。

默认提交预检还检查宿主机的 bubblewrap（`bwrap`）可用性，Linux 部署需要安装该工具。GitHub 回归会安装 bubblewrap，模型输出仍使用受控测试适配器。

真实 V2 需要 Docker writer scope 或可用的 Linux delegated cgroup v2；缺少强写者范围时拒绝启动。cgroup 负责进程范围与回收，不单独提供文件系统或凭据隔离，部署仍需保护 canonical、CAS 和控制面状态。

治理文件可显式配置：

```bash
export AF_GLOBAL_DIR="/absolute/path/to/agent-foundry-global"
export AF_CANONICAL_AGENTS_MD="$AF_GLOBAL_DIR/AGENTS.md"
```

文件必须存在且可读。容器内还需提供可见路径或只读挂载；不要共享整个宿主用户目录、桌面会话或所有执行器凭据。

Docker 配置示意：

```bash
export AF_SANDBOX=require
export AF_SANDBOX_IMAGE=node:24-slim
export AF_SANDBOX_NETWORK=none
export AF_SANDBOX_EXECUTORS=on
export AF_SANDBOX_EXECUTOR_IMAGE=node:24-slim
export AF_SANDBOX_EXECUTOR_NETWORK=none
```

上述断网设置适合本地确定性程序；远程模型需另行配置必要服务访问。`node:24-slim` 本身不包含 Codex、Cline 或账号配置。可通过 `AF_SANDBOX_EXECUTOR_MOUNTS` 显式只读挂载 CLI 及必要配置；认证、可写临时 HOME 和网络策略需分别验证。

Docker 内可写 Codex author 使用外部隔离模式，避免嵌套 sandbox 启动失败；这依赖外层 executor Docker 边界成功建立，不是宿主无隔离运行的配置建议。

## 执行任务

普通任务可从已有模板开始：

```bash
cp tasks/task-template.json tasks/my-task.json
# 填写目标、工作目录、执行器和验收命令，配置运行环境后再执行：
node orchestrator.mjs run --task-file tasks/my-task.json
```

普通模板不自动启用 V2。V2 还需配置 `trusted_import.enabled`、独立的 candidate/CAS/物化目录、写入策略、范围和验收绑定信息。参考 [Docker 部署测试](tests/deployment-v2-acceptance.test.mjs) 与 [入口集成测试](tests/trusted-import-orchestrator.test.mjs) 的任务构造。测试示例摘要不能直接当作真实生产资产摘要。

状态与恢复：

```bash
node orchestrator.mjs status --task-id TASK-001
node orchestrator.mjs inspect --task-id TASK-001
node orchestrator.mjs recover --scan
node orchestrator.mjs recover --task-id TASK-001
node af-admin.mjs executor status
node af-admin.mjs circuit list
```

恢复和探针可能启动执行器；事先明确账号、调用次数、时限、网络和费用策略。历史 403 或模拟测试状态不代表当前账号状态。

## 测试

默认回归：

```bash
npm test
```

默认关闭真实 Codex GP-4 与 Docker V2 部署验收。其他测试仍可能使用本地 Docker 或 CLI 版本探测，默认回归不等于纯内存单元测试。

单独运行 Docker 部署验收（本地确定性执行器，不调用模型服务）：

```bash
AF_RUN_DEPLOYMENT_ACCEPTANCE=1 node --test tests/deployment-v2-acceptance.test.mjs
```

仅在明确授权真实账号调用后开启 GP-4：

```bash
AF_RUN_REAL_EXECUTOR_INTEGRATION=1 node --test tests/runtime-guard-policy.test.mjs
```

GP-4 是运行时护栏探针，不等于完整 V2 冒烟。报告应分别列出通过、失败、跳过和取消，不合并重叠测试集计数。

## 已知限制

- 团队协作首期的模型执行通过受控适配器验证；真实模型账号的完整团队任务与新控制器的生产部署尚未验收。
- 跨目标成员共享、模型运行中的实时消息注入和团队日志压缩尚未实现。
- 真实端到端已验证的是上述 Codex＋Cline 组合；CLI 安装或 health 通过不代表其他执行器已完成真实任务验证。
- AGY 容器认证与服务可用性仍待解决：已有诊断发现容器无法匹配登录 profile，宿主已认证请求遇到区域拒绝，不能据此认定当前账号封禁。区域拒绝被识别为不可重试的环境故障。
- 镜像、CLI、账号认证、网络和服务端模型可用性都是部署条件；一次冒烟不覆盖所有环境。
- V2 单任务支持范围与旧版多步骤、治理任务能力需分别评估。
- 公开发布仍需解决 [NOTICE.md](NOTICE.md) 记录的许可状态。

## 代码与文档导航

| 路径 | 用途 |
|---|---|
| `af-team.mjs`、`af-admin.mjs team` | 团队创建、查询、控制与控制器入口 |
| `lib/team/` | 目标与成员模型、工作依赖、通信、调度、成果整合及交付衔接 |
| `web/teams.html`、`server/read-api.mjs` | 团队页面与 HTTP 入口 |
| `tests/team-*.test.mjs`、`qa/team-browser.mjs` | 团队回归与真实浏览器检查；模型输出使用受控适配器 |
| `prototypes/` | 前端视觉与交互原型，使用模拟数据，与正式团队页面分别维护 |
| [协作核心决策](docs/adr/0011-team-collaboration-controller.md) | 控制器、持久化、恢复与执行边界 |
| `orchestrator.mjs` | 任务入口、执行与恢复 |
| `lib/trusted-import/` | 捕获、快照、授权、证据、提升与 V2 适配 |
| `lib/adapters.mjs`、`bin/` | 执行器协议与启动器 |
| `lib/sandbox.mjs`、`lib/child-process.mjs` | Docker、writer scope 与进程管理 |
| `lib/orphan-reaper.mjs` | 孤儿进程、容器与持久化 scope 回收 |
| `config/acceptance-allowlist.json` | 受信验收命令白名单 |
| [V2 交付基线](docs/design/TRUSTED-IMPORT-V2-DELIVERY.md) | 部署阶段记录；测试数字和执行器状态是该阶段快照 |
| [Trusted Import 规范](docs/WRITE-SCOPE-ENFORCEMENT.md) | 冻结设计要求，不代替实现验收 |
| [改造路线](docs/ROADMAP.md)、[决策记录](docs/adr/) | 历史改造与取舍 |
| [保留资产](docs/PRESERVE.md)、[模块映射](docs/MODULE-MAP.md) | 设计资产与组件评估 |
| [运维手册](OPERATOR_RUNBOOK.md)、[灾难恢复](DISASTER_RECOVERY.md) | 运维操作参考 |

旧版发布材料描述的是上游或历史阶段，不能替代当前实现与验证结果。

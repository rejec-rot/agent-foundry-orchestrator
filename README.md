# Agent Foundry Next

面向多执行器任务的控制平面：组织 author、独立 reviewer 和确定性验收，通过 **Trusted Import V2** 将获准的候选改动提升为正式代码版本。

当前版本：`2.0.0-dev`。已完成本地 Docker 部署验收及 Codex＋Cline 真实 V2 冒烟；不代表所有执行器、任务类型和部署环境均已通过生产验收。

项目源自 `opperl1114/agent-foundry-orchestrator` 的 `434114e`（v1.2.0），是独立升级线。许可仍为 `UNLICENSED`，公开发布条件见 [NOTICE.md](NOTICE.md) 和 [ADR-0003](docs/adr/0003-upstream-license-unresolved.md)。

## 当前能力与边界

| 能力 | 当前状态 |
|---|---|
| V2 主入口 | 显式设置 `trusted_import.enabled: true` 后启用 |
| 独立评审 | 显式指定独立 reviewer，评审密封候选快照 |
| 捕获与授权 | 文件系统捕获、内容寻址存储（CAS）、快照、差异及累计授权闭包 |
| 验收与提升 | 白名单命令、PASS 证据绑定、最终重新校验、Git 原子提升 |
| 并发与恢复 | 旧基线重基、同路径冲突拒绝、提升后崩溃恢复与祖先关系校验 |
| 写者回收 | Docker 或 delegated cgroup；进程组退出本身不证明所有写者已停止 |
| 持久化回收 | 未确认 scope 清空时保留句柄；dry-run 不执行 scope 回收 |

V2 当前仅接纳单任务 `workspace` 流程，拒绝 `governed_write` 和多步骤规划。旧版规划、多步骤与治理路径仍保留，但不等于已接入 V2。Scope Verifier、Human Gate 等库模块存在，也不代表主入口已支持完整人工审批与自动修复循环。

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

- 真实端到端已验证的是上述 Codex＋Cline 组合；CLI 安装或 health 通过不代表其他执行器已完成真实任务验证。
- AGY 容器认证与服务可用性仍待解决：已有诊断发现容器无法匹配登录 profile，宿主已认证请求遇到区域拒绝，不能据此认定当前账号封禁。区域拒绝被识别为不可重试的环境故障。
- 镜像、CLI、账号认证、网络和服务端模型可用性都是部署条件；一次冒烟不覆盖所有环境。
- V2 单任务支持范围与旧版多步骤、治理任务能力需分别评估。
- 公开发布仍需解决 [NOTICE.md](NOTICE.md) 记录的许可状态。

## 代码与文档导航

| 路径 | 用途 |
|---|---|
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

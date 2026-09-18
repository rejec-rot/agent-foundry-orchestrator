# 改造升级路线图（V2）

> 本仓库 `agent-foundry-next` 的上游为 `opperl1114/agent-foundry-orchestrator` @ `434114e`，
> 之上已应用一个安全修复批次（详见 `NOTICE.md`）。
> 本文档把 `docs/MODULE-MAP.md` 的模块级替代方案落成**可执行的分阶段计划**。

---

## 一、起点状态（已固定）

| 项 | 状态 |
|---|---|
| 基线 | 上游 `434114e` + 安全修复批次 |
| 测试 | `node --test` → **218 通过 / 0 失败** |
| 已知残留 | ① 内存无上限（本机无 cgroup 委派）② 双 fork+setsid 的孙进程可逃逸 ③ 首次验收前删锚仍会被重新锚定 ④ 状态文件与标记同时删除可清空熔断器 ⑤ 执行器与编排器同 UID |
| 新增不变式 | `INV-6: No Bare Spawn`（`tests/architecture-invariant.test.mjs`） |

**基线必须先绿再动任何东西。** 每次改造后都要跑：

```bash
node --test          # 期望全绿，且通过数只增不减
```

---

## 二、开工前必须确认的两件事

### 1. 许可（阻塞公开发布，见 `NOTICE.md`）
上游无 LICENSE、`private: true`。本仓库已标 `UNLICENSED`。
**你是作者？有授权？还是都没有？** 这决定本仓库能否公开。

### 2. 路线选择
`docs/MODULE-MAP.md` §10/§11 给出三条路线：

| 路线 | 适用目标 | 改动面 |
|---|---|---|
| **1（本文档默认）** | 保留 AFR 架构与业务语义，只把危险的手写件换成成熟组件 | 中 |
| 2 | 持久化执行整体交给 conductor，AFR 只保留策略与角色语义 | 大 |
| 3 | 用 loopx / mission-control 直接替代控制平面 | 最大 |

> 本文档按**路线 1** 展开。若你选 2 或 3，`docs/adr/0002-target-route.md` 需重写，P3 以下阶段会被整体替换。

---

## 三、改造原则（每一步都必须满足）

1. **不许倒退测试**：改动后 `node --test` 必须全绿，且为新增行为补针对性测试。
2. **不许丢掉 §四 的两个设计资产**。
3. **替换要可回退**：一个阶段一个 commit，commit message 写明替换了什么、为什么。
4. **先探测再实现**：组件依赖宿主能力（cgroup、namespace、内核版本）时，先写能力探测 + 诚实报告，不写无法验证的代码。
5. **不静默降级**：能力缺失必须显式报错或明确标注为"未覆盖"，不允许"看起来正常"。

---

## 四、必须保留的两个设计资产（不可被替换掉）

详见 `docs/PRESERVE.md`：

| 资产 | 位置 | 为什么保留 |
|---|---|---|
| 验收命令静态白名单 + 内容哈希锚定 | `lib/acceptance.mjs`、`config/acceptance-allowlist.json` | 成熟 agent 框架都不做"验收命令自身可被篡改"这一层 |
| `ROLE != PLATFORM` 动态角色注入 | `orchestrator.mjs`、`lib/executor-router.mjs` | 同平台可在任务 A 当 author、任务 B 当 reviewer；框架通常写死在一起 |

---

## 五、分阶段计划（路线 1）

### ~~P1 — 断路器外置~~ → **已评估并否决**（见 [ADR-0004](adr/0004-reject-breaker-library.md)）

原计划用 `cockatiel` / `opossum` 替换 `lib/executor-runtime-guard.mjs` 的断路器状态机。
按原则 4「先探测再实现」核对后**否决**，证据（ADR-0004 全文）：

| 核对点 | 结论 |
|---|---|
| 是否存在可替换的阈值/计数逻辑 | **不存在**。`recordResult` 按分类的 `safety_action` **立即开闸**；`grep threshold\|allowed_fails\|consecutive` 零命中 |
| 库的核心特性是否契合 | **相反**。库按设计**自动半开自愈**；AFR 的保证是**永不自动自愈、必须人工 probe→admit**。用它需压制 `halfOpenAfter`，等于逆着库设计用 |
| 并发槽位能否换 bulkhead | **不能**。`acquireSlot` 把电路复检与槽位等待**耦合**，另有 `min_interval_ms` 节流；bulkhead 两者都不提供，且是 `execute(fn)` 式，需重构 adapter 主流程（24 处引用） |
| C5 翻车的真实归因 | 是**持久化与错误处理**缺陷（非原子写、`catch {}` 吞错），换任何库都不能自动修复；修复批次已针对根因整改 |

**后果**：未引入依赖，218 项测试未被扰动，`package.json` 无 `dependencies`。
重新评估的条件写在 ADR-0004 末尾（引入阈值语义 / 把运行包进策略管道 / 需要多策略组合）。

### P2 — 沙箱化（一次解决三个问题）**← 验收路径已完成**

**实现**：`lib/sandbox.mjs`，接入 `lib/acceptance.mjs`。测试 `tests/sandbox.test.mjs`（SB-1..SB-9）。

| 机制 | 结果 |
|---|---|
| 模式 | `AF_SANDBOX=auto`（默认，不可用时**记录**降级）/ `require`（不可用即 fail-closed）/ `off` |
| 隔离 | `--network none`（默认）、`--cap-drop ALL`、`no-new-privileges`、`--user <uid>:<gid>`、**只挂载工作区** |
| 限额 | `--memory`/`--memory-swap`、`--pids-limit`、`--cpus`，rlimit 改由 `--ulimit` 施加 |
| 回收 | 容器具名 `af-sbx-*`；`--rm` + 显式 `docker rm -f`（因为 SIGKILL 客户端不会停容器） |

**与 rlimit 的关系**：两者不叠加。rlimit 路径用 `bash -c` shim，而 `node:24-alpine` **有 `sh` 没有 `bash`**（已实测），
所以沙箱激活时跳过 shim，改由 Docker `--ulimit` 施加同样的限额。

**实现中修掉的两个真问题**（都是"安全改进顺手打断了既有功能"）：
1. `AF_ACCEPTANCE_ENV_*` 显式透传在容器内失效 → 现按文档语义以 `-e` 转发（并拒绝转发 `AF_SAFETY_STATE_FILE` 等安全关键变量）
2. `TEST B` 的 marker 写在**工作区之外**，沙箱隐藏它导致修复循环无法收敛 → marker 移入工作区（这也更符合"验收命令只应观察自己的工作区"）

**执行器沙箱化：已完成并用真实 CLI 验证**（[ADR-0010](adr/0010-executor-sandbox-posture.md)）。
默认关闭、**必须显式给镜像**（`AF_SANDBOX_EXECUTOR_IMAGE`）、网络走 bridge；启用后不可用则 fail-closed
（`SANDBOX_UNAVAILABLE`），绝不静默退回无沙箱。

**真实验证**：本机装着 `cline`（v3.0.62），已实测它在沙箱内运行成功：

| 镜像 | 结果 |
|---|---|
| `node:24-alpine` (musl) | ❌ 失败——平台二进制是动态链接 ELF，需 glibc |
| `node:24-slim` (glibc) | ✅ 成功——容器内报告 `3.0.62` |

配方：`AF_SANDBOX_EXECUTORS=on` + `AF_SANDBOX_EXECUTOR_IMAGE=node:24-slim` +
`AF_SANDBOX_EXECUTOR_MOUNTS=<宿主 node_modules 目录>`（只读挂载）。

**这次真实验证抓出两个真缺陷**：① `--tmpfs /tmp` 与 `-v /tmp:/tmp` 冲突导致 docker 拒绝该计划（exit 125）
② cline 健康检查写死了 node 版本 `v24.20.0`（作者机器残留）→ 假阴性。两者都已修，各有回归测试。

测试 ES-1..ES-8（ES-7/ES-8 真跑两个真实 CLI）与 CLINE-10。镜像要求按 CLI 打包方式而定：

| CLI | alpine (musl) | slim (glibc) |
|---|---|---|
| `cline`（ELF） | ❌ | ✅ `3.0.62` |
| `command-code`（纯 JS） | ✅ `1.54.1` | ✅ `1.54.1` |

`claude`/`codex`/`agy`/`vertex-gemini` **确认不在本机**，其镜像仍需部署时验证。

| 项 | 内容 |
|---|---|
| 替换对象 | 现在"拿操作员权限裸跑 + rlimits + 进程组树杀"的组合 |
| 采纳 | **Docker**（实测唯一在本机可用的机制）。`nsjail` 未安装；`bwrap`/`unshare` 因非特权 userns 被禁而失败；`systemd-run` 的内存限额未生效；cgroup 无委派。详见 [`P2-FEASIBILITY.md`](P2-FEASIBILITY.md) |
| 实施范围 | **先沙箱化验收命令**（`lib/acceptance.mjs`，风险最高、镜像需求最简）；执行器暂缓，因其需要镜像内含 5 种 CLI —— 属部署决策 |
| 一次解决 | ① **内存限额**（rlimit 做不到）② 双 fork+setsid 孙进程逃逸 ③ **执行器与编排器同 UID 的根因** ④ 文件系统污染 |
| 验证（**已预先实测通过**） | ① setsid 守护进程随容器退出而死 ✅ ② `--memory=64m` 写 256MB → OOM Killed ✅ ③ `--pids-limit=24` → `can't fork` ✅ ④ 不挂载即不可见 ✅ ⑤ 现有 218 测试全绿（待实现后跑） |
| 前置 | 能力探测**必须显式**：Docker 不可用时不得静默降级，要么 fail-closed，要么明确报告"沙箱未启用，仅有 rlimits 保护" |
| 待你决策 | 执行器沙箱化的镜像策略（现成镜像+只读挂载宿主机 CLI / 自建含全部 CLI 的镜像 / 每执行器一个镜像）——见 `P2-FEASIBILITY.md` §四 |
| 风险 | 沙箱可能改变 CLI 行为（网络、HOME、tmp）→ 需为每种执行器验证一次真实运行 |

### ~~P3 — 存储与锁改用 SQLite~~ → **已评估并否决**；改为修补锁覆盖（见 [ADR-0005](adr/0005-reject-sqlite-swap-fix-lock-coverage.md)）

原计划用 `better-sqlite3` + WAL + `BEGIN IMMEDIATE` 替换 `lib/store.mjs` + `lib/tasklock.mjs`。核对后**否决替换**：

| 核对点 | 结论 |
|---|---|
| 是否与已声明的不变式冲突 | **是**。`lib/store.mjs:3` 明写 `no database introduced (Phase 1.1 boundary)`；`FINAL_ARCHITECTURE.md` 原则 3 要求"零外部重依赖与全平台可移植性"，而 `better-sqlite3` 是**原生模块** |
| "文件即真源"是否是承重结构 | **是**。5 个测试文件直接读写 `tasks/<id>.json`，其中 `ACC-6` 正是**篡改检测**用例（改写盘上文件后断言拒绝）——这是 `docs/PRESERVE.md` 里验收锚定资产的**验证方式** |
| P3 想解决的问题是否还在 | **大部分已不存在**。TOCTOU 双持（N1）、死 PID/畸形租约、续租竞态、恢复幂等性均已在修复批次解决并有测试 |
| 迁移爆炸半径 | 大。锁语义被 `concurrency.test.mjs`(724 行)、`PROD-5` 双实例隔离、`recovery` TEST F/G/H 及 `af-read`/`af-admin` 巡检依赖 |

**但核对中发现一个真实且当前可触发的缺陷：锁覆盖不全。**

`approval/intent-gate.mjs` 的 `acquireTaskLock` 命中为 **0**，却通过 `persistTaskCapsule` → `saveTaskWithVersion`
写入任务生命周期状态（`approveIntent` / `rejectIntent` / `alignTaskIntent`）；
而调度器在派发期间**持有**同一任务锁直到运行结束 → **两个写者无互斥 → 丢失更新**（人工审批被静默覆盖）。

**已修复**：
- intent-gate 三处写入改为持有**与调度器相同的任务锁**（`withTaskWriteLock`），读-改-写成为互斥临界区
- 锁冲突以 `TASK_LOCKED` 明确暴露给操作员；`alignTaskIntent` 原有的宽容 `catch` **不再吞掉锁冲突**（否则会"报告成功但没写"）
- 新增 `tests/task-write-locking.test.mjs` TW-1..TW-5；并验证**有牙**：临时回退锁覆盖后 5/5 全红

**结论**：未引入任何依赖，`package.json` 仍无 `dependencies`；232 项测试全绿。

### ~~P4 — 策略外置到 OPA / Cerbos~~ → **已评估并否决**；改为补全契约权威性（见 [ADR-0006](adr/0006-reject-policy-engine-complete-contract-authority.md)）

原计划用 `open-policy-agent/opa` 或 `cerbos/cerbos` 替换动作合约/白名单层。核对后**否决替换**：

| 核对点 | 结论 |
|---|---|
| 这层是什么 | **不是**"请求→决策矩阵"，而是"从文件系统上下文分类（含 `realpathSync` 防符号链接穿越）+ 字段缺失即 fail-closed 升级"+ 一张 gate 表。策略引擎只覆盖最后那张表，前两步全部留下 |
| 部署代价 | OPA 需 `opa` 工具链在**构建期**编译 Rego→WASM，或作为 sidecar；Cerbos 需独立服务 → 违反原则 3「零外部重依赖」 |
| Casbin 是否可行 | 纯 JS 可进程内运行，但它是**授权决策**引擎，无法覆盖分类与 fail-closed 升级 |
| 换引擎能否解决本层真实问题 | **不能**。真实问题是"声明为真源的文件没有被读取"，换引擎不会修复"声明与实现不一致" |

**核对中发现的真实缺陷：契约高估了自己的权威性。**

`contracts/action-types.json` 声明**四个**列表，`FINAL_ARCHITECTURE.md:18` 称其为唯一真源，但实测只有 `action_types` 被读取：

| 契约列表 | 修复前 | 真正的真源位置 |
|---|---|---|
| `action_types` | ✅ | 契约文件 |
| `target_asset_types` | ❌ **0 次** | 硬编码 `asset-classifier.mjs:47` |
| `impact_scopes` | ❌ **0 次** | 硬编码 `asset-classifier.mjs:57` |
| `gates` | ❌ | 硬编码 `action-validator.mjs:48` |

**且存在一条 fail-OPEN 路径**：契约**部分缺失**（如缺 `gates` 而 `action_types` 完好）时，schema 校验能通过，
而 `required_gate === GATE_VERDICTS.WAITING_HUMAN` 会变成 `undefined === undefined` → **既不拒绝也不升级**。

**已修复**：
- 新增 `intent/action-contract.mjs`：**唯一**读取契约的模块，一次读出四个列表；执法模块的硬编码枚举改为派生（**枚举对象形态不变**，108 处引用不受影响）
- **显式 fail-closed 守卫**：`isActionContractUsable()` 要求四列表齐备非空；不可用时抛 `ACTION_CONTRACT_UNUSABLE` **拒绝决策**，而不是拿空枚举去比较
- 新增 `AF_ACTION_CONTRACT` 覆盖入口（部署可固定契约，也让 fail-closed 路径可端到端测试）
- 新增 `tests/action-contract-authority.test.mjs` ACA-1..ACA-5，含**漂移守卫**（禁止硬编码副本回潮）

**验证**：ACA-3 有牙（塞回硬编码副本后精确点名文件与变量报红）；ACA-4 端到端断言部分契约 → `THREW:ACTION_CONTRACT_UNUSABLE`。`node --test` 237 通过 / 0 失败，零依赖。

### ~~P5 — 子进程统一交给 execa~~ → **已评估并否决**；改为修补硬杀后的孤儿残留（见 [ADR-0007](adr/0007-reject-execa-reap-hard-kill-orphans.md)）

原计划用 `sindresorhus/execa` 替换手写的 `lib/child-process.mjs`。核对后**否决替换**：

| 核对点 | 结论 |
|---|---|
| execa 能否 1:1 覆盖现有能力 | **不能**。① 进程**组**整树信号（`kill(-pid)`，H3 修复的核心）仍需自己写 ② 全局存活子进程登记 + 停机一次回收（execa 的清理绑定在 `execa()` 调用上）③ 输出**截断**语义（execa 的 `maxBuffer` 是超限报错，会改变失败分类） |
| 迁移爆炸半径 | 覆盖 adapters（事件式流 + 死循环监测 + 持久句柄）、acceptance（超时 + 登记 + 截断 + 沙箱）、vault-client（长驻 stdio MCP 子进程）、codex-planner。收益只是"把已有封装换成一层依赖" |
| execa 能修本层真问题吗 | **不能**。真问题是编排器被 **SIGKILL** 后的残留；execa 自己也扛不住它所在进程被 SIGKILL |

**实测确认的真实缺陷**（优雅路径已覆盖，硬杀覆盖不了）：

```
实证 A  detached 子进程：父进程组 122798 / 子进程组 122808（已脱离）→ SIGKILL 父进程后子进程仍存活
实证 B  docker 容器：SIGKILL 客户端后容器状态仍为 running
```

危害不只是"不整洁"：恢复会为 owner 已消失的任务**重新派发**，于是旧执行器继续编辑同一工作区、继续烧 API 预算，而新运行同时开始。且实测**全仓无任何孤儿回收机制**。

**已修复**：新增 `lib/orphan-reaper.mjs` + `af-admin reclaim orphans`（默认 dry-run，`--confirm` 执行）
- 沙箱容器：按名称里的 owner pid 判断，**owner 已死才** `docker rm -f`
- 执行器进程：运行句柄新增 `owner_pid` + `pgid` 指纹；**owner 已死且进程组一致**才发信号（两道检查防 PID 复用误杀）
- 无指纹的旧句柄 → **报告为 unverifiable，绝不发信号**

**验证**：OR-1..OR-9（含"进程组不匹配 → 拒绝发信号"的 PID 复用守卫）。246 测试全绿，零依赖。
**残留**：回收目前是显式运维动作，未自动接入恢复路径（见 ADR-0007 后果节）；非沙箱化验收子进程无句柄可校验。

### ~~P6 — provider 错误分类与限流~~ → **已评估并否决**；改为补齐 provider 拒绝族（见 [ADR-0008](adr/0008-reject-provider-gateway-extend-refusal-families.md)）

原计划用 litellm Router 或 axonhub 承担 provider 错误映射。核对后**否决替换**：

| 核对点 | 结论 |
|---|---|
| 这是什么东西 | 一个**纯函数**（无 I/O），调度器在关键路径同步调用；候选方案都是**外部进程**（litellm = Python 服务/库，axonhub = Go 二进制） |
| 后果 | 违反原则 3「零外部重依赖」，且**把安全判定放到网络跳数之后 = 给安全路径新增故障点**。分类器绝不能因"网关不可用"而失败 |
| 该学什么 | **分类法**，不是运行时——`MODULE-MAP` §4 早已注明这是"偷分类法、不要依赖"的项 |

**实测确认的真实缺陷：三处误判，方向全是"账号/计费问题被当成可重试"**（README 承诺"403/封号 fail-closed、禁止静默重试"）：

| 样本 | 修复前 | 应为 |
|---|---|---|
| OpenAI `account_deactivated`（**账号被封**） | `TRANSIENT_FAULT` retryable | 非重试 + 人工解封 |
| OpenAI `insufficient_quota` | `TRANSIENT_FAULT` retryable | 非重试 |
| Anthropic `credit balance is too low` | `TRANSIENT_FAULT` retryable | 非重试 |

根因与 C1 同类：原 `ACCOUNT_POLICY` 只认 `account.*disabled`，而 OpenAI 的封号措辞是 `deactivated`——**同一原则只覆盖了一种措辞**。

**已修复**：新增 `PROVIDER_ACCOUNT_REFUSAL` 表（账号状态族 + 计费配额族），命中一律
`ACCOUNT_POLICY` → 非重试 → `OPEN_MANUAL_RESET`；`reason` 按族区分（billing → 提示加余额；account state → 提示人工准入）。

两个刻意取舍（已写进注释与测试）：① 计费用人工门禁而非 `COOLDOWN`（余额耗尽是永久的，冷却只会无进展地烧配额）
② 排除裸 `402`（任何含 "402 bytes" 的输出都会误触发熔断），并把表项分 `ambiguous` 两级——
特征词永不被抑制，散文式措辞仅在 stdout 看起来像测试日志时抑制；边界由 PE-4b 显式记录。

**验证**：PE-1..PE-8 + PE-4b（含"五个执行器分类一致"与"安全动作真的到达运行时守卫"）。255 测试全绿，零依赖。

### P7 — 可逆执行 ✅ **已完成**（见 [ADR-0009](adr/0009-reversible-execution-native-impl.md)）

参考 `shepherd-agents/shepherd`（2.4k★, MIT）的**思路**（执行应是可逆 trace，不是单向棘轮），
**自行实现** `lib/rollback.mjs` + `af-admin restore-point`，不引入其运行时（原则 3）。

| 设计点 | 理由 |
|---|---|
| 捕获＝plumbing 游离提交 + `refs/af-restore/<task>/<rev>` | HEAD/分支/reflog 全不动，捕获不干扰进行中的工作 |
| 恢复＝`git restore --source --worktree --staged -- <捕获内路径>` | **不改写历史**；只还原捕获内路径，新增文件默认保留（实测纠正：整个 pathspec 会删掉新文件） |
| 恢复前先给当前状态留**安全点** | **回滚本身可回滚**——操作员不必在"保留坏状态"与"丢掉工作"之间二选一 |
| `prune` 默认关闭，且只报告**真正发生**的删除 | 实测：安全留点已暂存文件，`git clean` 静默删不掉 → 改为 `git rm` 优先，且以"文件确实消失"为准 |
| 非 git 工作区 → `NOT_A_GIT_REPO` | 能力缺失显式报出，不静默降级（原则 5） |
| 自动留点 `AF_RESTORE_POINTS=on`，**默认关闭** | 捕获会同步 git 索引（可见副作用）；开启后拒绝原因会写入 `task.restore_points[]` |

**验证**：RB-1..RB-8（含"捕获不动 HEAD/分支"、"恢复可逆"、"prune 报告与实际一致"）+ CLI 冒烟。
`node --test` 全绿，零依赖。

**残留**（ADR-0009 后果节）：捕获会同步 git 索引；`.gitignore` 忽略的文件不进留点；
超大工作区的路径列表可能触及 argv 上限；**非 git 工作区没有可逆能力**（未做，也不静默降级）。

---

## 六、进度追踪

| 阶段 | 状态 | commit |
|---|---|---|
| P1 断路器外置 | ❌ **已评估否决**（ADR-0004） | — |
| P2 沙箱化 | ✅ **完成**：验收路径默认 `auto`；执行器路径可选（ADR-0010） | 见 git log |
| P3 SQLite 存储与锁 | ❌ **已评估否决**；改为修补锁覆盖并完成（ADR-0005） | 见 git log |
| P4 策略外置 OPA/Cerbos | ❌ **已评估否决**；改为补全契约权威性并完成（ADR-0006） | 见 git log |
| P5 execa | ❌ **已评估否决**；改为修补硬孤儿残留并完成（ADR-0007） | 见 git log |
| P6 provider 错误分类 | ❌ **已评估否决**；改为补齐拒绝族并完成（ADR-0008） | 见 git log |
| P7 可逆执行（可选） | ✅ **已完成**（自行实现，ADR-0009） | 见 git log |

> **计划阶段全部完成。** P1–P6 五处替换经核对被否决（ADR-0004..0008），改为修补各层真实缺陷；
> P2 完成验收路径沙箱化；P7 完成可逆执行。零外部依赖，`node --test` 通过数只增不减（218 → 303）。
>
> **本轮复核后追加的修补**（不改变上文结论）：
> — 孤儿回收的 SIGKILL 升级改为**可观测**（等到确认死亡才删句柄，未死则保留并报 `SURVIVED`），
>   见 `lib/child-process.mjs#killPidTree` 与 OR-10/OR-11；
> — **恢复路径接入回收**（原先只在手工 `af-admin` 里）：`recoverTask` 续跑前清扫，
>   默认关闭、`AF_REAP_ORPHANS_ON_RECOVER=1` 开启，证据落 `recovery_attempts[]`（ROR-1..ROR-4）；
> — 真实 CLI 集成测试加 `AF_REAL_CLI_TESTS` 开关并修正版本解析，
>   使 `command-code` 自更新不再把默认套件弄红（`tests/helpers/real-cli.mjs`）；
> — ⑦ cline 结论已按真实 3.0.62 重测更正（见下）；
> — `dsh`/`command-code` 补显式安全档；`selectExecutor` 的自动顺序提为具名常量 + 漂移守卫。
>
> **尚未完成（需要你的决策，不是技术阻塞）**：
> ① **执行器沙箱化**——需要镜像策略决策（见 `P2-FEASIBILITY.md` §四）
> ② **许可问题**——上游无 LICENSE，本仓库不得公开发布（见 `NOTICE.md` / ADR-0003）
> ③ **权限域分离**（executor 换 UID / 容器）——这是"文件级防护"的根因，属部署改造
> ④ ~~恢复路径是否自动回收孤儿（ADR-0007 后果节）~~ ✅ **已接线**：`recoverTask` 在**续跑派发之前**
>    回收（注入式，默认关闭，`AF_REAP_ORPHANS_ON_RECOVER=1` 开启），证据写入 `recovery_attempts[].orphan_reap`；
>    清扫失败不阻塞恢复但会记录（`tests/recovery-orphan-reap.test.mjs` ROR-1..ROR-4）
> ⑤ ~~**执行器集合与本机不匹配**~~ ✅ **已解决**：新增 `command-code` 适配器（本机实装）、
>    **新增 `dsh` 适配器**（把你平台里的 DSH 接成 AFR 的一个执行器，见 `docs/DSH-INTEGRATION.md`）。
>    仍未处理：`claude`/`codex`/`antigravity` 在本机不存在（health 已如实报 false）；
>    `vertex-gemini` 的仓库自带启动器是**伪造结果的桩**，已标为不可调度。
> ⑥ ~~**health 谎报 / 桩被默认路由**~~ ✅ **已修**：health 现在检查 governance 前提并给出原因；
>    桩被标记且不可调度（详见 ADR 与 `tests/executor-health-truth.test.mjs`）。
> ⑦ ~~**cline 适配器的 argv 与已装 3.0.62 不符**~~ ✅ **已核实并澄清**：用真实 `cline 3.0.62`
>    重测后，适配器拼出的 argv（`cline -s <governance> --json --auto-approve true "<prompt>"`）
>    **被真实 CLI 接受并正常开跑**。此前报 `Unknown command or unquoted prompt` 的那次探测
>    用的是**裸单词 prompt**（`cline "hi"`），绕过了适配器自己的兜底——适配器会给单词 prompt
>    补一个尾空格，正是为了让 cline 不把它当子命令。该兜底由 `CLINE-11` 钉住。
>    **仍未端到端验证的是输出事件 schema**：解析器等 `run_result`（`finishReason`/`text`），
>    而 3.0.62 实测输出为 `hook_event` / `agent_event` 流，结尾事件形态需一次**已登录 provider
>    的真实运行**才能确认；未确认前，评审裁决路径按"未验证"对待，不予宣称。
>    *(历史注：`claude`/`codex`/`antigravity` 本机不存在，health 如实报 false；`vertex-gemini`
>    的仓库自带启动器是伪造结果的桩，已标为不可调度。)*

> 环境探测（P2 前置）已完成：本机**已装 `bwrap`**，且**非特权 user namespace 已启用**
> （`unprivileged_userns_clone=1`、`max_user_namespaces=55500`），`systemd-run` 可用；
> `nsjail` 未安装。→ P2 若用 bubblewrap 路线，可在本机真实实现并验证（含内存限额）。

---

## 七、剩余已知残留的归属

| 残留 | 由哪个阶段解决 |
|---|---|
| 内存无上限 | **P2**（cgroup / 沙箱） |
| 双 fork+setsid 孙进程逃逸 | **P2** |
| 执行器与编排器同 UID（根因） | **P2** |
| 首次验收前删锚会被重新锚定 | 需**旁路锚存储**或一次性迁移命令（见 `docs/PRESERVE.md`） |
| 状态文件 + 标记同时删除可清空熔断器 | 需把安全状态移出 checkout 目录（部署改造） |
| 文档计数漂移（README 写 182，实测 218） | 交给 CI 生成，不再手写 |

---

## 八、文档索引

| 文档 | 用途 |
|---|---|
| `NOTICE.md` | 来源、改动清单、**许可状态（未解决）** |
| `docs/MODULE-MAP.md` | 模块 → 候选池全表（81 个仓库实测数据）+ 三条路线 + 决策表 |
| `docs/PRESERVE.md` | 两个不可替换的设计资产 |
| `docs/adr/` | 架构决策记录（每个被采纳的组件一条） |
| `af-admin` / `README.md` | 上游原有的系统文档（保持原样，未重写） |

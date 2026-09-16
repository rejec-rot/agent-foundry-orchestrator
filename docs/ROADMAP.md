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

**尚未完成**：执行器沙箱化（需要镜像策略决策，见 `P2-FEASIBILITY.md` §四）。

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

### P5 — 子进程统一交给 execa

| 项 | 内容 |
|---|---|
| 替换对象 | `lib/child-process.mjs`（我在修复批次里手写的） |
| 采纳 | `sindresorhus/execa`（7.6k★, MIT） |
| 必须保留 | **进程组树回收**（`kill(-pid)`）、**全部子进程登记**（停机一次性回收）、输出上限 |
| 验证 | ① 现有 `child-process.test.mjs` 的 CP-1..CP-6 语义等价迁移 ② INV-6 仍绿 |
| 风险 | execa 的 kill 语义与我们的"整组 + 升级"不完全一致 → 需要封装一层而不是直接替换调用点 |

### P6 — provider 错误分类与限流

| 项 | 内容 |
|---|---|
| 替换对象 | `lib/executor-error-classifier.mjs` 的 provider 错误映射与限流判断 |
| 采纳 | `BerriAI/litellm` 的 Router 错误映射（或 `looplj/axonhub`） |
| 必须保留 | **403/封号 → fail-closed**（`ACCOUNT_POLICY` → `OPEN_MANUAL_RESET`，禁止静默重试降级） |
| 注意 | litellm 的断路器**不会自愈**（issue #30192 / #37592）→ 它的冷却不能取代 AFR 的人工解封门禁 |
| 验证 | ① 现有 `executor-error-classifier.test.mjs`（含"403 走 stdout"回归）全绿 ② 新增 provider 错误样本对照表测试 |

### 可选 P7 — 参考 shepherd 做可逆执行

| 项 | 内容 |
|---|---|
| 参考 | `shepherd-agents/shepherd`（2.4k★, MIT）：把执行变成可逆的 Git-like trace，支持 observe / fork / **rollback** |
| 现状缺口 | AFR 的 `recovery.mjs` 只能"从断点继续"，不能"回滚到某个已知好状态" |
| 验证 | 新增测试：一次失败运行后可回滚到上一状态，且回滚本身可审计 |

---

## 六、进度追踪

| 阶段 | 状态 | commit |
|---|---|---|
| P1 断路器外置 | ❌ **已评估否决**（ADR-0004） | — |
| P2 沙箱化 | ✅ **验收路径已完成**（执行器待镜像决策） | 见 git log |
| P3 SQLite 存储与锁 | ❌ **已评估否决**；改为修补锁覆盖并完成（ADR-0005） | 见 git log |
| P4 策略外置 OPA/Cerbos | ❌ **已评估否决**；改为补全契约权威性并完成（ADR-0006） | 见 git log |
| P5 execa | ⬜ 未开始（**当前第一项**） | — |
| P6 provider 错误分类 | ⬜ 未开始 | — |
| P7 可逆执行（可选） | ⬜ 未开始 | — |

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

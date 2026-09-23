# ADR：执行器权限域分离采用「方案 A：专用宿主 UID」（af-exec）

状态：**已决定（方案 A），实现仅限不依赖 root 的部分；root 步骤待管理员在部署环境执行**。
决定来源：DSH 会话（目标「实现方案 A：专用 af-exec UID 隔离执行器与 root-owned 控制面」）+ 本仓库
`docs/PRIVILEGE-SEPARATION.md`（§5、§8）。**本 ADR 不改变任何行为，也不代表已部署。**

## 背景（一句话）

当前执行器与控制面**同 UID（1000）**：`host-boundary` 的 root 属主只防"容器内以 root 跑"，
**并没有把执行器变成另一个用户**。要做真正的权限域分离，必须先选一条路。

## 决策

| 方案 | 内容 | 本机可验证性 | 结论 |
|---|---|---|---|
| **A. 专用 UID** | 建 `af-exec`；控制面 root 所有、`0700`；工作区归 `af-exec`；编排器经特权路径写状态 | ❌ 需 root（`sudo -n` 不可用） | ✅ **采纳** |
| B. 每次执行一个容器 | 只挂工作区 + 不同容器 UID | ⚠️ bind mount 属主是宿主 uid，换 UID 写不进去 | ❌ 未采 |
| C. 容器卷 + 受控回拷 | 工作区拷进卷，卷内由容器决定属主；产物经**校验器**拷回 | ✅ 本机可实现 | ⏸ **暂缓**：回拷是**新的信任边界**，"回拷时校验什么、谁判产物合法"**尚未定** |

**采纳 A 的理由**：它是唯一能给出"控制面与执行器真正分离"而非"容器内降权"的路径；代价是
必须有 root 才能落地与验证。

## 实施约束（继承自决定方的硬约束，不得放宽）

1. **不提权**：代理侧不创建用户、不改宿主属主、不动服务/权限/凭据。
2. **只做可审查、可回滚的资产**：脚本、能力探测、模板、测试、文档。
3. **能力检查 + 拒绝不安全降级**：无法确认隔离能力时必须**拒绝**，绝不"降级为以控制面身份运行"。
4. **无 root 的环节明确列为"待部署验证"**，不得写成已完成。
5. **保留现有契约与门禁**：不改验收门禁，不做静默放宽。
6. **针对性 + 全量回归**；未能验证如实报告。

## 本仓库已交付（无 root 部分）

| 资产 | 说明 |
|---|---|
| `lib/af-exec-isolation.mjs` | `probeAfExecIsolation()` 四项能力探测（A1 是否 root / A2 是否存在 `af-exec` / A3 控制面是否 root 所有 / A4 能否以另一 UID 派发）；`assertAfExecIsolation()` **fail-closed 闸门**（不可确认即拒绝，绝不降级） |
| `lib/af-exec-handshake.mjs` | **运行时握手**：`verifyIsolationClaim()` 逐条复验 H1–H7（schema / 身份确有分离 / 用户解析一致 / claim 自身 root:0600 且组与他人不可写 / 工作区归执行器 / 控制面 root 且组与他人不可写 / 启动器 root:0755）；`buildExecutorDispatch()` 握手不过即**拒绝**；`assertParentOwnedArtifact()` **父进程拥有的产物边界** |
| `deploy/af-exec/provision.sh` | **root-only 模板**：非 root **exit 3** 且零改动；**默认 dry-run**；`--apply` 才执行；幂等；写 **root:0600 claim**、装 **root:0755 启动器**；打印回滚 |
| `deploy/af-exec/af-exec-run.sh` | **特权启动器模板**：唯一做身份下降的地方；非 root → exit 3；目标 uid=0 → exit 4；`setpriv --reuid/--regid --clear-groups` |
| `deploy/af-exec/README.md` | 管理员操作顺序 + 机制说明 + **未验证项**清单 + 回滚 |
| `tests/af-exec-isolation.test.mjs`、`tests/af-exec-handshake.test.mjs`、`tests/af-exec-provision.test.mjs` | 探测 / 握手 / 边界 / 模板门控的回归（全部注入，不依赖宿主） |

## 握手与"父进程拥有的 IPC 边界"（DSH 待办 #2 的实现）

1. **握手（capability handshake）**：`provision.sh --apply` 写一份 **root:0600** 的 claim
   （`/etc/af-exec/claim.json`），记录执行器身份、工作区、启动器与控制面表面。运行时
   `verifyIsolationClaim()` 把它**对照活文件系统**逐条复验（H1–H7）；**任一未知即拒绝**，
   `buildExecutorDispatch()` 因此**永远不会**产出"以控制面身份运行执行器"的描述符（无降级路径）。
2. **父进程拥有的产物边界**：执行器**只能**在自己的工作区内产出；产物视为**候选**，由
   `assertParentOwnedArtifact()` 做**路径感知包含**校验（拒相对路径 / NUL / 前缀陷阱），并**禁止落在
   控制面表面内**；任务状态、锁与运行时证据**一律由父进程自己写**。执行器**不直接**写控制面状态。
3. **唯一身份下降点**：`af-exec-run`（root:0755）。它拒绝非 root 调用者与 uid=0 目标——"以 root 运行"
   是配置错误，不是可用的降级路径。
4. **派发接线**（`AF_EXEC_ISOLATION`，默认 `off`）：`execAsync` 在启动任何执行器前调用
   `planRunIsolation()`。`off`（或缺省/未知值）→ **argv 原样返回，行为不变**；`require` → 先做握手，
   通过则把 argv 改写为经特权启动器（`af-exec-run --uid … --gid … -- …`），**不通过则拒绝**并把
   `EXECUTOR_ISOLATION_REQUIRED` 报为该次运行的失败——**永不**回退为以控制面身份启动执行器。
   （默认 off 时全量回归 643/640/0/3，证明接线不改变既有行为。）

## 未验证项（必须随本 ADR 一起读）

- 本机**无** `af-exec` 账户且无法创建 → A2 = false；
- 控制面属主/模式**未变更** → A3 视检出而定；
- "以另一 UID 派发"能力**未探测** → A4 = unknown；
- 因此 **A 在本机不可验证**，必须在有 root 的环境执行 `provision.sh` 并复跑探测、记录结果。

## 与其它在制工作的关系

- **V2 / Trusted Import**：不受影响；本 ADR 只改"执行器以哪个身份运行"，不改门禁、不改任务契约。
- **Human Gate 停靠**（`human-gate-park.mjs`）：不依赖执行器身份，兼容。
- **Jev 顾问**（`decision-model.mjs`，默认 off、仅顾问）：在编排进程内运行，与执行器 UID 无关；兼容。
- **方案 C 的"回拷校验规则"**：一旦要启用 C，必须先单独定稿——这是**设计决策**，不是编码问题。

## 后续（需授权 / 需环境）

1. 管理员在有 root 的环境执行 `provision.sh --apply` 并回报探测结果；
2. 依据探测结果设计"以 `af-exec` 派发"的编排改造（当前**未实现**）；
3. 若改走 C：先定稿回拷校验规则（谁判产物合法、校验什么、失败如何处置）。

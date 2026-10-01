# V2 后端冗余设计检查

检查日期：2026-09-30。代码基线：`agent-foundry-next`，`main@07c3a4c`，版本 `2.0.0-dev`。

后续已按用户选择实施方案二，改动、兼容行为和最终验证见 [方案二实施记录](2026-09-30-v2-scheme2-implementation.md)。下文保留重构前的检查结论和复现证据。

结论：存在值得收敛的冗余，主要集中在 V1/V2 并存后重复实现的执行归属、执行器筛选、提交幂等、验收策略和配置解析。部分重复已经产生可复现的行为差异。Trusted Import 的捕获、授权、独立评审、证据绑定和提交前复核各自解决不同问题，应该保留。

本次检查覆盖主要后端调用链，并扫描生产代码中的符号引用；没有逐行审计所有模块。未修改后端实现，也未启动真实模型任务。

## 检查结果

| 编号 | 优先级 | 重复职责 | 已确认的影响 |
| --- | --- | --- | --- |
| R1 | P1 | Scheduler、V2 服务、HTTP 启动接口分别管理执行归属 | V2 无锁续租；Web 请求与 worker 之间有重复派发窗口 |
| R2 | P1 | V2 创建、adapter selector、router 分别筛选执行器 | 创建时可绑定运行阶段会拒绝的执行器 |
| R3 | P2 | 提交层与执行层分别解析、匹配验收白名单 | 完整路径匹配规则和默认配置路径不同 |
| R4 | P2 | PREPARED 提交记录与 V2 task binding 各自处理幂等 | 同一 key 换内容，一条路径拒绝，另一条返回旧任务 |
| R5 | P2 | 顶层与 `trusted_import` 内各有修复预算 | V2 创建参数写到执行流程不读取的位置 |
| R6 | P2 | 项目目录分配与协作目录分别拼接路径 | 项目 workspace 配置未被创建服务采用；自定义 runtime 下消息收不到 |
| R7 | P3 | 多处实现原子 JSON 写入 | 重复维护故障清理和持久化语义 |
| R8 | P3 | V1/V2 工作流与预留 API 共同保留 | 主入口维护面扩大，部分公开能力尚未接入主链路 |

P1 表示优先修复执行正确性；P2 表示统一规则与配置；P3 表示后续整理维护结构。

### R1：V2 重写执行所有权管理，遗漏了原调度器的续租

位置：[V2 启动服务](/home/reject/DSHWorkSpace/agent-foundry-next/lib/v2-service.mjs:257)、[原调度器续租](/home/reject/DSHWorkSpace/agent-foundry-next/lib/scheduler.mjs:549)、[锁过期判断](/home/reject/DSHWorkSpace/agent-foundry-next/lib/tasklock.mjs:48)、[HTTP 启动](/home/reject/DSHWorkSpace/agent-foundry-next/server/read-api.mjs:265)。

`startOrResumeV2Task()` 自己取锁、等待 runner、释放锁，但没有 `renewTaskLock()`。默认租约 15 分钟；`isLockStale()` 在租约过期时直接认定锁失效，即使原进程仍然存活。原 `Scheduler` 有 heartbeat 和失去所有权后的处理，V2 服务绕开了这部分。

临时目录复现：将租约缩短为 30 ms，第一个 runner 保持运行；80 ms 后启动第二个 runner，第二次启动成功，两个 runner 同时进入。这里验证的是过期逻辑，不是实际等待 15 分钟。验收命令默认超时为 30 分钟，完整 author/reviewer/acceptance 流程也可能超过 15 分钟，所以该边界不是不可达配置。

HTTP 又在父进程调用同一服务取锁，然后 runner 只派发 detached worker，父进程立即释放锁；worker 的 `af-admin v2 start` 再次取锁。模拟 worker 尚未取得锁时连续发起两次请求，两次均返回 202，派发了两个 worker。这不证明默认租约内两个真实 worker 必然同时执行，但证明派发与执行所有权不是一次有确认的交接。

建议：保留独立于 HTTP 请求寿命的执行进程，将取锁、续租、失锁处理、完成状态和释放集中到一个执行所有者。HTTP 只提交启动请求或持久化派发意图，收到 worker 接管证据后报告相应状态。可以复用原有锁管理机制，无需引入新工作流引擎。

### R2：执行器是否可用，有三套判断

位置：[V2 创建筛选](/home/reject/DSHWorkSpace/agent-foundry-next/lib/v2-service.mjs:134)、[adapter selector](/home/reject/DSHWorkSpace/agent-foundry-next/lib/adapters.mjs:2094)、[router](/home/reject/DSHWorkSpace/agent-foundry-next/lib/executor-router.mjs:57)。

V2 创建时主要检查 operator disable list 和 `health().ok`；selector 还拒绝 `schedulable === false`，router 进一步考虑 capability、availability 和 runtime guard。不同入口维护各自的筛选规则，无法保证创建时绑定的对象能够进入运行阶段。

模拟健康状态复现：`antigravity.health().ok === true`，同时 `schedulable === false`。V2 自动创建将它绑定为 author，而 `selectExecutor()` 随后拒绝它。该复现使用模拟 health，不表示当前真实账号或服务可用。

建议：抽出共同的执行器资格判断，创建、路由、运行前复核都调用同一实现。各入口可以保留不同优先顺序，资格规则应一致。author/reviewer 独立性继续作为额外约束。

### R3：验收白名单重复实现，并已发生规则分叉

位置：[提交层 loader 与 matcher](/home/reject/DSHWorkSpace/agent-foundry-next/lib/submission.mjs:125)、[执行层 loader 与 matcher](/home/reject/DSHWorkSpace/agent-foundry-next/lib/acceptance.mjs:28)。

两边都读取 `allowed`、转换 `args_prefix`、匹配命令及参数前缀，但返回类型、错误表达和匹配方式不同：提交层要求 `entry.command === acceptance.command`；执行层比较 `entry.command === basename(spec.command)`。提交层默认从 `process.cwd()/config` 读取，执行层默认从仓库根目录读取。

复现：同一个白名单允许 `node --test`，将命令写成 `process.execPath` 的绝对路径，提交 matcher 拒绝，执行 normalizer 接受。默认配置路径差异另由代码确认。

建议：统一白名单加载、默认路径解析、命令归一化和错误契约。提交时检查与执行前复核都保留，复用同一策略实现；不能因为检查次数多就删除运行时复核。

### R4：两个提交台账重复维护幂等，契约不同

位置：[PREPARED 提交记录](/home/reject/DSHWorkSpace/agent-foundry-next/lib/submission.mjs:369)、[V2 task binding](/home/reject/DSHWorkSpace/agent-foundry-next/lib/v2-service.mjs:151)。

`recordSubmission()` 写 `<key-digest>.json`，保存 capsule 和 `spec_digest`，发现同 key 不同内容时拒绝。`createV2Task()` 另写 `<key-digest>.task.json`，只保存 key 与 task 的绑定，重复时返回原任务，不比较新 spec。

复现：第一次目标为 `first goal`，第二次同 key 提交 `a different goal`。record 路径返回 `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_SPEC`；V2 create 返回成功和第一个任务。

此外，V2 先发布 binding 再写 task，中间失败会留下“key 已占用但 task 不存在”的状态；当前响应要求删除 binding 后重试。这是额外维护两个记录带来的恢复负担。

建议：共用一个带规范化内容摘要的幂等服务，并将“已准备、已创建 task、已派发”表达为同一提交的不同阶段。PREPARED 与可执行任务的区别可以保留，无需分别实现 key 规则。摘要还应覆盖真正影响任务语义的 profile/scope 等输入，而不只机械复制旧 capsule 摘要。

### R5：修复预算字段重复，V2 创建参数未进入实际读取位置

位置：[创建参数落盘](/home/reject/DSHWorkSpace/agent-foundry-next/lib/v2-service.mjs:193)、[V2 修复预算读取](/home/reject/DSHWorkSpace/agent-foundry-next/lib/trusted-import/orchestrator-adapter.mjs:769)、[旧工作流预算](/home/reject/DSHWorkSpace/agent-foundry-next/orchestrator.mjs:1013)。

V2 创建接收 `maxRevisions`，写入顶层 `task.max_revisions`。V2 修复流程却读取 `config.max_revisions`，其中 `config` 是 `task.trusted_import`，缺失时回退为 3。

创建记录复现：指定 `maxRevisions: 0` 后，顶层值为 0，`trusted_import.max_revisions` 缺失。结合执行读取代码，这个创建参数不会决定 V2 的修复预算。这一项验证了记录形状与读取位置，没有用真实执行器跑完四轮修复。

顶层和嵌套的 `revisions_used` 也使用不同计数含义：旧流程倾向于 author revision，V2 嵌套字段记录已消耗修复次数。应明确命名和语义，避免将不同概念直接合并。

建议：将 V2 的最大修复次数和已用修复次数放到一个明确的配置/状态契约里，创建和执行共用。保留 V1 时在兼容适配层转换旧字段。

### R6：目录分配和协作目录各自实现，配置无法贯通

位置：[项目目录分配](/home/reject/DSHWorkSpace/agent-foundry-next/lib/projects.mjs:148)、[创建服务目录分配](/home/reject/DSHWorkSpace/agent-foundry-next/lib/v2-service.mjs:113)、[协作目录](/home/reject/DSHWorkSpace/agent-foundry-next/lib/collaboration.mjs:30)、[adapter 消息读取](/home/reject/DSHWorkSpace/agent-foundry-next/lib/operator-control.mjs:33)、[API 传入 runtime](/home/reject/DSHWorkSpace/agent-foundry-next/server/read-api.mjs:247)。

项目模块已经实现 `assignProjectDirs()`，读取 `project.workspace_root`，计算 candidate/CAS 并检查目录重叠。但 V2 创建不调用它，重新计算目录，也没有采用项目的 `workspace_root`。没有显式传入全局 workspace 参数时，两者会生成不同位置，已用临时项目复现。

协作模块根据传入的 `runtimeDir` 生成 inbox、received、activity；`instrumentAdapter()` 则硬编码 `base/runtime/operator-*`。API 经 `resolveDataRoots()` 支持 `AF_RUNTIME_DIR`，adapter 不接收这份解析结果。

复现：将消息写入自定义 runtime，再通过模拟的 instrumented adapter 启动同一任务，消息没有进入 capsule。默认目录恰好相同时可能正常，但配置目录后两边不再一致。

建议：集中解析部署数据根目录，并作为显式 context 传入服务、API、adapter 和 CLI。项目工作目录由项目分配函数负责，协作目录统一调用 `operatorDirs()`。入口与执行阶段各自的安全检查仍保留。

### R7：原子 JSON 写入代码重复

位置：[通用原子存储](/home/reject/DSHWorkSpace/agent-foundry-next/lib/store.mjs:39)、[任务原子存储](/home/reject/DSHWorkSpace/agent-foundry-next/lib/store.mjs:74)、[operator 原子写](/home/reject/DSHWorkSpace/agent-foundry-next/lib/operator-control.mjs:21)、[消息写入](/home/reject/DSHWorkSpace/agent-foundry-next/lib/collaboration.mjs:73)。

`writeJsonAtomic()` 和 `saveTaskAtomic()` 的同目录临时文件、写入、文件 fsync、rename、目录 fsync、失败清理几乎相同，只是临时命名和测试故障钩子不同。operator/message/workbench 等又实现了较简化版本，其中部分没有持久化 fsync。

建议：先合并同一存储文件内的两个实现，保留任务 API、版本推进和 fault hook。再明确区分“覆盖式原子更新”和“禁止覆盖的首次发布”两个基础操作，逐步复用。幂等 binding 使用 link 的禁止覆盖语义，不能直接替换成普通 rename。

这一项属于代码与维护冗余，未进行断电故障验证，也没有据此断言所有简化写入都需要相同耐久等级。

### R8：旧工作流与未接入模块扩大维护面，应按兼容需求整理

位置：[V2 分派](/home/reject/DSHWorkSpace/agent-foundry-next/orchestrator.mjs:919)、[旧规划分派](/home/reject/DSHWorkSpace/agent-foundry-next/orchestrator.mjs:945)、[V2 恢复分派](/home/reject/DSHWorkSpace/agent-foundry-next/orchestrator.mjs:1156)。

`orchestrator.mjs` 同时承担旧 author/review/fix、规划批次、vault governance/publish、V2 分派和 CLI。V2 从 `continueTask()` 再进入 `executeTask()`，共享旧任务的初始化与异常处理，再进入自己的 phase 逻辑。该组织方式本身不是错误，但会增加每次修改状态与恢复规则时需要核对的路径。

生产引用扫描还发现 `V2_RESUMABLE_STATES`、`hasEventHistory()`、`ensureEventLog()` 等定义未被主链路调用；`assignProjectDirs()` 有测试但没有被创建服务采用。Scope Verifier、Dependency Fixture、Diagnostic Runner 的部分 API 也只是导出和独立测试，没有主入口调用。这些应标记为预留能力，不能仅凭库和测试存在就宣称端到端支持。

建议：如果需要继续兼容 V1，将旧规划与治理流程移到清晰的兼容模块，共享执行器运行、持久化和纯校验函数。若产品已经决定只支持 V2，再基于入口/调用方清单逐步退役旧路径。仅凭本次引用扫描，不直接删除公开 API 或旧能力。

## 应保留的复核

- Author/reviewer 退出后的 writer scope 验证与 QUIESCE：执行结束不等于所有子写者已经停止。
- candidate、CAS、review fixture、acceptance fixture 的隔离：不同数据与执行信任边界。
- snapshot、manifest、authorization closure、acceptance evidence 的绑定：分别证明内容、差异、权限和验证结果。
- promotion 最终重新校验与带旧 OID 的 Git ref 原子更新：避免验收后 canonical 并发推进导致过期提交。
- task 生命周期与事件投影分离：事件用于展示，持久任务记录用于恢复；两者不是重复的真相来源。

精简时应共享实现、统一契约，同时保留上述检查的执行时机。

## 验证记录

相关现有回归：44 项通过，0 失败、0 跳过、0 取消。

```bash
node --test --test-reporter=spec \
  tests/v2-service.test.mjs \
  tests/submission-preflight.test.mjs \
  tests/acceptance-allowlist.test.mjs \
  tests/task-write-locking.test.mjs \
  tests/trusted-import-fix-loop.test.mjs \
  tests/v2-recovery-entry.test.mjs
```

首次沙箱运行的 Git 子进程被 `EPERM` 拦截；获准在沙箱外重跑上述本地回归后全部通过。这些结果不是完整部署或真实模型验收。

独立探针：8 项断言通过，其中锁时长使用缩短租约，HTTP worker 和执行器 health 使用模拟对象，所有工作数据在临时目录中。

- [复现脚本](/tmp/af-v2-backend-review-20260930/probe.mjs)
- [探针结果](/tmp/af-v2-backend-review-20260930/probe-results.json)

探针确认了白名单规则、预算记录形状、项目目录分配、幂等内容比较、执行器资格、锁过期并发、HTTP 重复派发和协作目录差异。44 项现有回归通过与这些边界差异同时成立，说明现有用例尚未覆盖全部跨模块一致性。

## 收敛顺序

1. 统一执行所有权、续租和 HTTP/worker 交接，先消除并发进入风险。
2. 统一执行器资格和验收白名单规则，让创建、预检和运行使用一致的判定。
3. 统一幂等提交、修复预算和目录 context，消除重复配置与恢复负担。
4. 合并原子存储基础实现，整理旧工作流和预留导出。

可以沿用现有架构逐项收敛，本次发现不构成推倒重写整个后端的依据。

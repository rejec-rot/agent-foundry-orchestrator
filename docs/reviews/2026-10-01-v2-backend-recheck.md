# V2 后端复检：仍未修复的问题

> 此文记录的是修复前的检查快照。用户随后选择协作核心方案二；Q1–Q9 已在本轮实施中修复，当前实现与新增回归见[团队核心实施记录](2026-10-01-team-core-implementation.md)。下文保留原复现证据；旧探针的成功条件是复现缺陷，不能用它的结果代表修复后的测试结论。

日期：2026-10-01（检查跨越 2026-09-30 至 2026-10-01）。仓库：`agent-foundry-next`。检查对象是方案二重构后的当前工作区。

**确认 9 项问题仍未修复：4 项 P1、5 项 P2。** 本次只检查和记录，没有修改后端实现。9 个独立探针均复现了对应问题；相关现有回归共 83 项，82 通过、0 失败、1 跳过。回归通过与这些遗漏同时成立。

P1：执行归属、持久状态或正常工作流需要优先修复。P2：配置一致性、并发清理或兼容路径需要补齐。编号 Q1–Q9 对应复现结果中的编号。

## 问题清单

| 编号 | 优先级 | 问题与范围 | 已确认的行为 |
| --- | --- | --- | --- |
| Q1 | P1 | 多 worker 的执行器护栏未共享实时状态 | `max_parallel=1` 时两个独立 guard 均取得槽位；另一 guard 继续允许已熔断执行器，后续整文件写入还能删除原熔断记录 |
| Q2 | P1 | 任务锁首次创建存在初始化窗口 | 尚未写入 JSON 的活锁被认作损坏并回收；两次取锁均返回成功 |
| Q3 | P1 | 旧 `orchestrator run` 可覆盖已取消的 V2 任务 | `CANCELLED → FAILED`，取消记录被清除，`state_version` 从 99 回退为 3 |
| Q9 | P1 | Human Gate 批准后未接通常规启动入口 | 批准成功并消耗 pending decisions 后，`v2 start` 仍按 `WAITING_HUMAN` 拒绝 |
| Q4 | P2 | 提交记录与查询的默认根目录不同 | 从其他 cwd 记录成功，默认列表读仓库 runtime，看不到该记录 |
| Q5 | P2 | 自定义 runtime 未传入 checkpoint 子进程 | 父进程看到 collaborative；执行器子进程看到 quick，生成的 checkpoint 命令也不携带 runtime |
| Q6 | P2 | 删除提交记录未与创建共用 key 锁 | 删除方检查 PREPARED 后，创建方绑定 task；删除方仍删除了已绑定记录 |
| Q7 | P2 | fix 切回原作者执行器时绕过资格判断 | 自动选择先避开被阻止的原执行器，随后直接取原 adapter，并实际调用其 resume |
| Q8 | P2 | 同平台评审的输出重试漏查 session 独立性 | 首次输出不合法，第二次与作者使用同一 session 的 PASS 被接受；范围为旧兼容流程 |

## Q1：护栏只有进程内同步，熔断持久化会丢失其他进程的更新

位置：[guard 内存状态](/home/reject/DSHWorkSpace/agent-foundry-next/lib/executor-runtime-guard.mjs:85)、[整文件保存](/home/reject/DSHWorkSpace/agent-foundry-next/lib/executor-runtime-guard.mjs:237)、[取执行槽位](/home/reject/DSHWorkSpace/agent-foundry-next/lib/executor-runtime-guard.mjs:309)、[HTTP 独立 worker](/home/reject/DSHWorkSpace/agent-foundry-next/server/read-api.mjs:262)。

并发数、最近启动时间和 circuits 均保存在各 guard 的 Map 中。状态只在构造时加载；写入时用自己的快照替换整个文件。V2 Web 每个任务启动独立 worker，各 worker 的 guard 因而没有共同的槽位计数和实时熔断状态。

复现使用两个指向同一 stateFile 的独立 guard，模拟两个 worker 的状态：

- 配置 codex `max_parallel=1`，两者同时取得槽位，总数为 2。
- A 写入 codex 的 `OPEN_MANUAL_RESET` 后，B 仍允许 codex。
- B 再写 claude 的熔断，磁盘上 codex 的记录被删除；新建 guard 也重新允许 codex。

这是已有护栏实现的遗留问题，前次共享资格函数没有解决它。建议为槽位和节流采用跨进程协调；熔断更新采用锁内重新读取、合并、保存，启动前读取最新状态。单独调用同一个 eligibility 函数无法解决各调用方持有不同快照的问题。

## Q2：锁文件还在初始化时就能被另一持有者回收

位置：[首次写锁](/home/reject/DSHWorkSpace/agent-foundry-next/lib/tasklock.mjs:125)、[损坏锁判断与回收](/home/reject/DSHWorkSpace/agent-foundry-next/lib/tasklock.mjs:129)。

`writeFileSync(..., {flag:'wx'})` 的独占创建防止另一方创建同名文件，但文件先出现、JSON 后写入。若进程在两步之间被调度暂停，竞争者看到空文件，`readLock()` 返回 null，立即将其当作 corrupt lock 回收。首次创建在 recovery guard 外执行，不能与回收互斥。

探针通过文件系统函数注入固定的 open/write 交错，两次实际 `acquireTaskLock()` 均返回成功，磁盘只保留第二个 owner。该证据证明锁互斥契约破坏；没有据此声称真实 V2 runner 已同时进入。新增 owner token 的检查能阻止部分后续写入，但提交账本等取锁调用没有同样的全过程归属检查。

建议将完整锁内容写入不可见的临时文件后以不覆盖方式发布，并把首次创建、回收和替换放在一致的互斥协议内；补充初始化中的锁与并发回收测试。

## Q3：旧 run 入口先重置任务，后检查取消

位置：[加载定义时保存新任务](/home/reject/DSHWorkSpace/agent-foundry-next/orchestrator.mjs:109)、[旧 run 调用顺序](/home/reject/DSHWorkSpace/agent-foundry-next/orchestrator.mjs:244)、[工作流取消检查](/home/reject/DSHWorkSpace/agent-foundry-next/lib/workflow-state.mjs:6)。

前次已经把取锁移到定义加载之前，但 `loadTaskFile()` 仍不检查同 ID 的持久任务。它建立一个新的 CREATED 记录并直接保存；之后工作流读到的已是重置后的记录，原 CANCELLED 和取消请求不存在了。

实际 CLI 子进程复现：持久任务最初为 CANCELLED、版本 99；同 ID 的 run 定义使它进入 V2 流程，随后因测试目标不是 Git 仓库而 FAILED，版本变成 3，取消字段全部消失。测试使用不存在的执行器 ID，没有启动模型。正常有效定义有继续执行的风险。

建议在锁内、任何写入之前读取已有任务；取消终态拒绝重建，已有任务的版本和证据不能被定义加载覆盖。重新开始的任务应获得新 ID，恢复现有任务应走恢复入口。

## Q9：Human Gate 已批准，但通常的 start 仍拒绝

位置：[批准后保留 WAITING_HUMAN](/home/reject/DSHWorkSpace/agent-foundry-next/lib/trusted-import/human-gate-resume.mjs:79)、[启动服务直接拒绝](/home/reject/DSHWorkSpace/agent-foundry-next/lib/execution-manager.mjs:20)、[CLI 批准记录](/home/reject/DSHWorkSpace/agent-foundry-next/af-admin.mjs:532)。

批准函数保存 human_approval，将 phase 改为 AUTHORIZATION，清空 pending decisions，按设计保留 WAITING_HUMAN。但 execution manager 对 WAITING_HUMAN 无条件拒绝，也没有连接 humanApprovalProvider 的生产入口。用户批准后再运行普通 `af-admin v2 start`，仍收到“resolve it first”。

探针执行与 CLI 相同的批准库调用并落盘，再调用启动服务：批准成功、pending 已消费、runner 未进入、启动被拒绝。已有 Human Gate E2E 测试直接向库传入内存中的审批 provider，所以仍通过；它不覆盖 CLI 批准后的独立 worker 启动。

建议在受锁保护的恢复入口中验证持久审批的签名与当前变更绑定，并在新进程中生成可信审批供 workflow 使用。不能只把 WAITING_HUMAN 改为可启动，否则进入授权阶段后仍会再次停放。

## Q4：提交默认路径的重构留下混合默认值

位置：[submissionDir 默认根](/home/reject/DSHWorkSpace/agent-foundry-next/lib/submission.mjs:78)、[recordSubmission 默认 cwd](/home/reject/DSHWorkSpace/agent-foundry-next/lib/submission.mjs:298)、[默认查询](/home/reject/DSHWorkSpace/agent-foundry-next/lib/submission.mjs:306)。

这是前次重构引入的配置回归：`submissionDir()` 默认改为仓库 DATA_ROOT，而 `recordSubmission()` 仍默认 `process.cwd()` 并显式传给它。未设置 AF_RUNTIME_DIR/AF_SUBMISSION_DIR、从其他目录启动 CLI 时，记录与 list/create 使用不同的账本位置。

探针从临时 cwd 成功记录，默认查询仓库 runtime/submissions，找不到该 key。建议所有默认调用采用同一数据根 context，并增加从仓库外调用 record → list → create 的集成测试。

## Q5：协作 checkpoint 的子进程没有 runtime context

位置：[生成 checkpoint 命令](/home/reject/DSHWorkSpace/agent-foundry-next/lib/workbench.mjs:34)、[checkpoint API](/home/reject/DSHWorkSpace/agent-foundry-next/lib/workbench.mjs:24)、[执行器环境白名单](/home/reject/DSHWorkSpace/agent-foundry-next/lib/executor-env.mjs:46)、[父进程 context](/home/reject/DSHWorkSpace/agent-foundry-next/lib/operator-control.mjs:34)。

前次已贯通消息和回执，但工作台提示中的 checkpoint 命令没有传入 runtime。执行器默认环境也不携带 AF_RUNTIME_DIR；其 Node checkpoint 进程回到仓库 runtime。自定义 runtime 中 collaborative 的状态因而在子进程中不可见。

探针验证：自定义目录中的模式为 collaborative；用实际 `executorEnv()` 构造的子进程读到 quick，命令中没有自定义路径。因此 checkpoint 会因“协作模式未开启”而失败；父进程的等待逻辑也无法看到写到其他目录的节点。

建议为 checkpoint 显式传递受控 runtime 参数，并让 checkpoint、等待和反馈更新使用同一 context。仅修父进程读取位置或消息路径不够。

## Q6：forget 检查后删除的窗口绕过绑定保护

位置：[forgetSubmission](/home/reject/DSHWorkSpace/agent-foundry-next/lib/submission.mjs:324)、[提交 key 锁](/home/reject/DSHWorkSpace/agent-foundry-next/lib/submission-store.mjs:24)。

前次新增“已绑定任务不能 forget”检查，但 forget 没有获取记录和创建共用的 key 锁。并发顺序可以是：forget 读 PREPARED → create 绑定 task 并保存 TASK_CREATED → forget 删除该记录。

探针固定这一交错后，forget 返回成功，task 保留，已绑定账本消失。建议删除也使用同一个 key 的互斥协议，并在锁内重新读取绑定状态，再删除。

## Q7：fix 实际执行对象不是资格检查的对象

位置：[选择执行器后直接切回原 adapter](/home/reject/DSHWorkSpace/agent-foundry-next/lib/task-execution.mjs:175)。

`runAuthor()` 先 select 当前偏好，再在 fix 时直接取 `adapters[author_session_executor_type]`。auto 改选或兼容任务绑定变动时，原执行器的 schedulable、能力和可用性没有经过同一 selector 检查；onRunStart 也在切换前调用。

探针中原 codex 为 schedulable=false，auto 先选可调度的 claude，随后仍调用 codex.resume 并完成。范围主要是 auto/兼容任务或绑定漂移；正常显式绑定且未变更的 V2 创建路径不触发这一切换。真实 adapter 的 operator 禁用检查和自身熔断检查仍存在，不能将此结论扩大为绕过所有运行保护。

建议 fix 先确定原会话对应的执行器，再按该 ID 校验资格，之后记录实际执行器并 resume；原执行器不合格时明确拒绝。

## Q8：review 重试缺少每次运行都应有的独立性复核

位置：[首次 session 检查](/home/reject/DSHWorkSpace/agent-foundry-next/lib/task-execution.mjs:244)、[重试返回后处理](/home/reject/DSHWorkSpace/agent-foundry-next/lib/task-execution.mjs:261)。

首次结果检查 reviewer session 是否与 author 相同；结构化输出失败后的第二次运行直接解析和绑定，没有再执行这个检查。

探针中第一次 reviewer 使用独立 session 但输出非法 JSON，第二次用作者 session 输出 PASS，结果被接受。这影响允许同平台、不同 session 的旧兼容评审。V2 workflow 的严格不同执行器检查仍生效，本项不证明 V2 已允许同一作者执行器做 reviewer。

建议抽出每次 reviewer 运行结果共用的取消、独立性和结果校验，重试也完整调用；补充第二次结果的 session 碰撞测试。

## 对前次实施结论的修正

- 新 V2 entry 的续租、待接管派发排他和常规终态拒绝已有相关回归通过；锁文件初始化窗口和旧 run 重建记录仍未覆盖。
- 资格判定已共享，但 fix 切回旧 adapter 时绕过 selector，多 worker 的 guard 也没有共享实时状态。
- 消息及回执的 runtime 注入已验证；checkpoint 子进程与默认提交目录仍有遗漏。
- 已绑定提交的静态删除检查有效，并发删除尚未纳入同一 key 锁。
- Human Gate 的库级审批和直接传 provider 的 E2E 有效；CLI 批准 → 常规 worker 启动未接通。

## 验证与修复顺序

本次现有回归分两组执行：执行入口/服务/提交/锁/CLI/fix-loop 的 59 项全部通过；护栏状态/策略/运维/Human Gate 的 24 项中 23 通过、1 跳过。合计 **83 项，82 通过、0 失败、1 跳过**。跳过项是显式要求 AF_RUN_REAL_EXECUTOR_INTEGRATION=1 的真实 recovery probe。

[隔离复现脚本](/home/reject/.cache/af-v2-recheck-20260930/probe.mjs) · [9 项复现结果](/home/reject/.cache/af-v2-recheck-20260930/probe-results.json)。

探针只使用临时任务、模拟执行器和模拟审批。Q2/Q6 用文件系统调用注入确定性交错，Q1 用独立 guard 模拟各 worker 的隔离内存。没有验证线上账号、真实模型端到端执行、实际发生的生产故障或断电恢复。首次沙箱阻止 Node 子进程（EPERM），获准在沙箱外执行后，9 项全部复现。

修复顺序建议：Q1/Q2 的跨进程归属与状态 → Q3 的取消记录保护 → Q9 的审批恢复入口 → Q4/Q5 的目录 context → Q6 的删除互斥 → Q7/Q8 的兼容调用复核。每项应保留本次对应场景作为行为回归。

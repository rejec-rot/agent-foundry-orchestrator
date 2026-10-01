# 方案二首期实施与验证记录

日期：2026-10-01。范围：当前工作区，保留既有未提交的后端重构、用户的前端设计文档与 prototypes。未部署或提交到远程。方案来源为用户明确选择的[协作核心方案二](../design/MULTI-AGENT-PLAN-B-COLLABORATION-CORE.md)。

## 结果与目标关系

现在可以创建一个共享目标，由主作者规划依赖、多个注册 worker 在各自的物理空间完成工作，成员通过平台路由请求和回复，主作者整合不可变产物，再交给 Trusted Import 完成独立评审、授权、验收与提升。成员身份、执行器、CLI 会话和每次尝试分别记录。

用户针对单个工作项调整方向时，控制器递增版本、停止旧尝试、使下游失效并保留无关产物；旧结果和旧问题的晚到回复均不能进入新方向。评审返工由主作者选择相关工作项，已完成目标的再调整会采用当前 canonical 基线进入新目标版本。

| 实现 | 入口与职责 |
| --- | --- |
| 协作模型与状态 | `lib/team/model.mjs`、`store.mjs`：目标、成员、工作依赖、版本、尝试预算；不可变顺序日志；命令去重和回执 |
| 协作运行控制 | `lib/team/controller.mjs`：单一租约所有者、依赖派发、成员通信、定向失效、暂停/继续、恢复及提交校验 |
| 内容与整合 | `lib/team/workspace.mjs`：独立投影、静止确认、CAS 产物、差异交接、冲突及显式解决回执 |
| 交付边界 | `lib/team/delivery.mjs`：受控候选生产方、全成员退出证据、独立 reviewer 保留、局部返工与多轮交付目录隔离 |
| 统一入口 | `af-team.mjs`、`af-admin team`、`/api/teams`；旧 V2 start/message/cancel 转交团队命令，旧 scheduler 拒绝绑定团队的任务 |
| 团队页面 | `/teams.html`：真实状态投影、分工和依赖、消息、单项调整/改派、运行与产物、操作回执；沿用令牌、CSRF 与 Origin 校验 |

部署假设的调整已记录在 [ADR 0011](../adr/0011-team-collaboration-controller.md)。控制器只写团队日志；交付任务由既有执行管理器持任务锁写入，两个生命周期以交付引用关联。

## 复检问题 Q1–Q9 的处理

| 编号 | 本轮修复 | 验证依据 |
| --- | --- | --- |
| Q1 | 共享执行槽位与节流账本，短锁串行提交；读取最新熔断状态、合并不同执行器更新；未知托管 scope 保留额度，晚到限流不解除账号禁用 | 独立 guard 与两个真实 Node 进程争用 24 次额度；运行时护栏回归 |
| Q2 | 首次取锁在 recovery guard 内发布完整 JSON，使用原子、不覆盖的创建 | 任务锁并发回归、竞争控制器拒绝与提交所有者复核 |
| Q3 | 旧 run 拒绝已有任务 ID，避免重建取消记录；旧 scheduler 阻止团队任务旁路 | 实际 CLI 子进程不能替换 CANCELLED/version=99 的任务；团队旁路回归 |
| Q4 | record、preflight、preview 与查询采用相同 DATA_ROOT 默认值 | 从仓库外启动真实 Node 子进程，默认 record→list 能找到同一记录 |
| Q5 | checkpoint 提示和 CLI 显式传递 runtime；托管运行句柄也按受控 runtime 保存 | 带空格与单引号的自定义 runtime 中，实际 checkpoint CLI 写入正确目录 |
| Q6 | forget 与记录/创建复用同一个提交 key 锁，在锁内核对绑定后删除 | 已持 key 锁时删除被拒绝，记录保留 |
| Q7 | fix 先确定原会话执行器，再进行资格检查，之后才登记和 resume | 不可调度的原执行器被拒绝，resume 未调用 |
| Q8 | 评审重试再次核对取消和 session 独立性，记录退出证据 | 第二次输出与作者 session 相同被拒绝；既有 fix/review 回归 |
| Q9 | 持久审批绑定 task/候选/策略/profile/团队 provenance，验证操作员签名后重建可信审批；停放版本贯通正常入口 | 签名审批通过正常管理器进入，候选被篡改后被拒绝；既有 Human Gate 回归 |

原缺陷复现见[修复前的复检快照](2026-10-01-v2-backend-recheck.md)。本轮还修复了取消提前到达时的结果分类、计划替换等待旧 writer 退出期间的版本竞态、暂停后无关成果的保存、跨轮交付目录串用及桌面栏位继承旧样式的问题。待审批的继续操作恢复原 Delivery，并消费一次启动请求；不同 Delivery 的送审版本按整个目标累计预算，结构化输出重试保留原候选版本，不能通过新建 Delivery 重置返工额度。运行认领回调的拒绝会向上传播，阻止实际启动。

## 验证与证据

新测试分为 `tests/team-core.test.mjs`、`team-api.test.mjs`、`team-recovery.test.mjs` 与 `team-foundation.test.mjs`。覆盖真实异步重叠、依赖释放、成员请求与回复、HTTP 鉴权/去重/兼容、定向调整、scope 未确认时阻止恢复、控制器重启、部分提交指令重放、冲突整合、局部评审返工及下一目标版本的真实 Git 提升。

模型输出由受控测试适配器提供；文件投影、捕获、CAS、验收命令、任务锁、日志提交和 canonical Git 提升使用实际实现。并发额度额外通过独立进程验证。此结果不能替代真实模型账号的团队执行验收。

最终全量回归共 **802 项：799 通过、0 失败、0 取消、3 跳过**，耗时约 39 秒；`git diff --check` 与相关模块语法检查通过。跳过项保持原先的真实执行器/部署开关，没有用跳过替代协作断言。结果保存在[最终测试日志](/home/reject/.cache/af-team-scheme2-20261001/full-tests.log)。

浏览器使用真实本地 Chromium、HTTP 和协作控制器；`qa/team-browser.mjs` 验证创建、鉴权、四名成员、依赖、消息领取与落实、转义、定向调整、无关产物保留、旧尝试拒绝、刷新持久性及桌面/手机布局。脚本等待浏览器退出后才记录成功，报告与截图在[浏览器报告](/home/reject/.cache/af-team-scheme2-20261001/browser/report.json)、[桌面截图](/home/reject/.cache/af-team-scheme2-20261001/browser/team-desktop.png)、[手机截图](/home/reject/.cache/af-team-scheme2-20261001/browser/team-mobile.png)。

本轮未执行真实模型账号的付费团队任务，也未做新控制器的生产部署验收。默认跳过的真实执行器与部署探针仍须按既有部署条件单独开启。首期消息在下一轮执行领取；跨目标成员共享、实时注入和日志压缩未实现，未知 writer scope 需要运维核验后恢复。

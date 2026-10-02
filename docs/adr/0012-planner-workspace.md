# ADR-0012：Planner 对话、编组确认与局部改向

日期：2026-10-02。状态：已实现，真实模型账号联调待验收。

新协作空间先与 Planner 商讨，再决定如何派工。选定的 Planner 执行器与模型同时用于 Reviewer，复检使用独立会话。已有单作者 V2 和未启用 Planner 的 CLI 团队继续使用原流程。

## 创建与派工

鉴权后的 `POST /api/teams` 在现有 `spec` 外接受：

```json
{
  "planning": {
    "dispatch_mode": "human",
    "planner": {"executor_type": "codex", "model": null},
    "workers": [
      {"executor_type": "codex", "model": null},
      {"executor_type": "cline", "model": null}
    ]
  }
}
```

`workers` 可省略，使用 `worker_count` 作为初始参考编组。模型填执行器支持的 ID，`null` 沿用 CLI 默认值。每个 Worker 可以使用相同或不同的配置。服务端仍拒绝未知、不可用、被操作员禁用的执行器，以及适配器不支持的模型覆盖；Planner/Reviewer 要求支持独立会话身份。

团队从 `DISCUSSING` 开始。`message` 发给 `lead` 会启动只讨论、不编辑文件的 Planner 回合；回复来自受控运行的真实 `summary`，持久化到带 `from_run_id` 的对话记录。`propose_plan` 请求计划，Planner 返回 `workers` 推荐编组与完整工作图。

`dispatch_mode: human` 将提案保留在 `PLAN_READY`，工作项为 `DRAFT`。`start` / `resume` 不能绕过确认。`dispatch_mode: planner` 验证推荐编组后自动开工。

手动确认通过 `POST /api/teams/:id/commands` 或 CLI 的 `team command --file` 提交，例如：

```json
{
  "type": "approve_plan",
  "expected_plan_revision": 1,
  "expected_goal_revision": 1,
  "workers": [
    {"executor_type": "codex", "model": null},
    {"executor_type": "cline", "model": null}
  ],
  "assignments": {"api": "worker-1", "ui": "worker-2", "integration": "worker-2"}
}
```

示例工作项 ID 必须替换为当前提案中的真实 ID。确认需要为每项工作明确分配一个有效 Worker；过期版本或尚未结束的 Planner 对话会拒绝派工。

## 执行中改向

`adjust` 绑定 `expected_revision`，先使目标与其下游结果失效，标记 `HELD`，确认旧执行范围退出，再记录发给 Planner 的修改请求。Planner 的 `revise` 回合读取反馈、完整计划与对话，生成新的可执行方向后重新派工。无关工作项的定义和已接受产物必须保留；原依赖与路径范围保持不变。需要改整张图时使用 `replan`。

Planner 回合不能修改工作文件。版本或工作图变化后，旧 Planner 结果也会拒绝，并重新排队尚未落实的请求。改向失败时保持挂起；停止范围无法确认时进入 `RECOVERY_REQUIRED`。控制器重启会恢复未完成的改向请求，也保留未确认计划的派工门槛。

## 同模型 Reviewer

仅 Planner 团队使用服务端写入的 `planner-model-fresh-session` 策略。Reviewer 使用相同执行器与模型参数，但每次通过 `adapter.run` 创建新运行，不恢复 Planner/Worker 会话。缺失复检会话身份或与任何已记录 Planner/Worker 会话冲突时拒绝结果。默认 V2 的不同执行器约束保留。

成果仍经过既有停止证明、快照密封、候选绑定、授权、受信验收与最终提升。选择同模型不会跳过这些交付检查。

验证入口：`tests/team-planner.test.mjs`、`tests/team-api.test.mjs`、`qa/planner-browser.mjs`。浏览器及后端场景使用受控模型输出，真实 HTTP、控制器、文件系统和版本校验参与执行。

# ADR-0012：Planner 对话、编组确认与局部改向

日期：2026-10-02。状态：已实现，真实模型账号联调待验收。

2026-10-03：补充 Command Code 原生模型扫描及用户默认模型读取。

新协作空间先与 Planner 商讨，再决定如何派工。选定的 Planner 执行器与模型同时用于 Reviewer，复检使用独立会话。已有单作者 V2 和未启用 Planner 的 CLI 团队继续使用原流程。

## 创建与派工

鉴权后的 `POST /api/teams` 在现有 `spec` 外接受：

```json
{
  "planning": {
    "dispatch_mode": "human",
    "planner": {"executor_type": "codex", "model": null, "effort": "high"},
    "workers": [
      {"executor_type": "codex", "model": null, "effort": "low"},
      {"executor_type": "cline", "model": null, "effort": null}
    ]
  }
}
```

`workers` 可省略，使用 `worker_count` 作为初始参考编组；显式提供时持久化为操作员的 `planning.worker_preferences`，Planner 必须保留人数和配置。模型填执行器支持的 ID，`null` 沿用 CLI 默认值。每个 Worker 可以使用相同或不同的配置。服务端仍拒绝未知、不可用、被操作员禁用的执行器，以及适配器不支持的模型覆盖；Planner/Reviewer 要求支持独立会话身份。

`effort` 可省略或设为 `null`，沿用执行器默认思考强度；显式等级须通过服务端执行器和模型元数据校验。创建页直接展示 Planner 的 Agent、模型与思考强度，默认折叠开工授权与验收参数，不提前要求 Worker 人数。Planner 的编组提案可选择每位 Worker 的模型与 `effort`，手动确认时可调整。Planner 配置持久化到成员、任务的 `author_effort` / `reviewer_effort` 和同模型复检策略，每次执行会传入 capsule；运行记录也保存强度。

`GET /api/v2/executors` 投影 `models`、`reasoning_efforts`、`default_model`、`default_effort`、安装与接入状态及目录来源。逐模型统一返回 `reasoning_status`、`reasoning_control`（`effort / toggle / budget / none / unknown`）和 `reasoning_source`，执行器与扫描结果统计已确认、可调档位及待确认的模型数。无 `scan` 参数时仅读取元数据；`?scan=1` 扫描当前本机客户端目录。协作页打开、普通刷新或重新进入前台时读取已有目录，只有点击“重新扫描”才请求原生客户端扫描；日常团队轮询不重复读取目录。并发扫描共享正在执行的查询，下一次重扫重新获取。目录存于进程内投影，不建立第二份持久执行器注册表；服务重启后可手动扫描补齐。缓存读取时间不作为扫描时间，界面显示目录内实际的最近扫描时间。

安装发现独立于 Planner 能力过滤：枚举命令与全局包，返回 `adapter_status`、`protocol` 与公开来源；未知适配器显示 `UNSUPPORTED`，已匹配但未注册显示 `UNREGISTERED`。Qoder/Pi 自动匹配内置适配器，原生目录分别走版本已验证的 CLI 和离线 RPC；Pi 等级由已安装 SDK 的公开逐模型函数给出。注册是显式 `executor connect` 写入 canonical registry 的动作，GET 扫描不授予派工资格、不覆盖既有记录或停用策略，未做真实模型调用的能力保持 `UNVERIFIED`。

Codex 使用已安装 CLI 的原生 `app-server`，初始化后分页请求 `model/list`，逐模型读取 `supportedReasoningEfforts`；本地 `models_cache.json` 提供配置预览。Cline 使用原生 ACP 的空会话查询并显式选中当前 provider，执行适配器使用同一 provider；不发送 `session/prompt`。目录查询有超时、输出大小限制及进程树清理，不启动推理回合。读取时只投影白名单字段，绝不返回 provider key 或账户身份。扫描失败显示部分完成；未注册或被禁用的客户端不能因为发现了模型就成为可运行 Agent。准入仍由 canonical 注册表、操作员限制和运行时健康状态决定。

Command Code 的页面名称为 `cmd`，执行器 ID 保持 `command-code`。扫描解析本机原生 `--no-auto-update --list-models` 输出，验证目录头、行数、唯一 ID 与结束标记，拒绝截断或格式变化后的结果；同时支持 `cmd`、`cmdc`、`commandcode` 别名及显式 `COMMAND_CODE_BIN`。目录进程使用临时 HOME/USERPROFILE 与 XDG/APPDATA 目录，只接收运行所需的环境白名单，`CI=1` 在 IDE 检测前禁用自动安装，`DO_NOT_TRACK=1` 禁用遥测。BYOK 仅投影 ID、名称、明确档位与启用状态，使用固定 `.invalid` URL 与 keyless 配置，不复制用户认证、端点、代理或 Node hooks；启动迁移只能写临时目录，退出后清理。查询模型列表与版本不传入 prompt、不打开会话。默认模型仍读取原始用户 `settings.json` / `config.json`，未配置时采用原生目录默认值。可通过 `COMMAND_CODE_CONFIG_PATH` 指定用户配置路径；来源只投影模型字段。

原生 `--list-models` 没有每模型等级信息。安装版 1.73.0 使用只读数据解析提取 `/model` 选择器实际使用的静态 registry 和后备档位表，验证版本、选择器结构与名称映射，不 import/eval CLI bundle；未知版本、语法变化或歧义保留未确认。BYOK 使用 provider 限定的模型 ID，将 [Command Code 模型配置](https://commandcode.ai/docs/byok)中明确的 `reasoningEfforts` 合并到原生目录的对应项，并限制为该客户端的合法参数值；单个 `reasoning` 开关和用户当前选择的强度不证明支持范围。原生目录里没有的模型不恢复到列表。后端保存和派工时也重扫 Command Code。目录中的专用 decision model 提示不作为普通 Planner / Worker 模型加入。

思考强度只允许具体模型确认的等级；参见 [Codex App Server 的模型目录](https://learn.chatgpt.com/docs/app-server)与[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。未知、自定义或仅有名称的模型没有强度覆盖，不继承执行器的等级集合。空等级列表沿用默认；页面同时显示支持值或“等级未确认”。注册表可提供逐模型的 `model_options: [{"id":"model-id","label":"Model","reasoning_efforts":["low","high"]}]`，但不能把原生目录没有的模型加入当前 provider。

Cline ACP 只返回模型选项，逐模型能力来自当前安装 SDK 的 `getModelsForProvider(provider, {filter: 'chat'})`，在禁用 `fetch` 的独立元数据进程中读取本地目录。SDK 与 ACP 按精确 ID 关联，不加入其他 provider 模型；发现的 provider 必须与当前配置一致，不一致的快照失效并要求重扫。明确的 SDK、本地或注册表元数据还需与已安装 CLI `--thinking` 可接受的值求交集，冷启动缓存无法跳过 CLI 扫描。[Cline 原生推理选项](https://github.com/cline/cline/blob/main/sdk/packages/shared/src/llms/reasoning-options.ts)区分等级、开关与 token 预算，后两者不会转换为 `low` / `high`；同时有开关和等级的模型可使用其准确等级。只有 ready 扫描和明确 verified 模型能启用原生目录档位；缺失或未知状态的旧快照保持默认，投影使用明确的 null 值，确保 JSON 日志回放一致。配置保存、提案生成和派工前重新获取模型元数据，拒绝失效等级，并在同一个状态事务中持久化验证后的目录。

团队从 `DISCUSSING` 开始。`message` 发给 `lead` 会启动只讨论、不编辑文件的 Planner 回合；回复来自受控运行的真实 `summary`，持久化到带 `from_run_id` 的对话记录。`propose_plan` 请求计划，Planner 返回 `workers` 推荐编组与完整工作图。

`dispatch_mode: human` 将提案保留在 `PLAN_READY`，工作项为 `DRAFT`。`start` / `resume` 不能绕过确认。`dispatch_mode: planner` 验证推荐编组后自动开工。

手动确认通过 `POST /api/teams/:id/commands` 或 CLI 的 `team command --file` 提交，例如：

```json
{
  "type": "approve_plan",
  "expected_plan_revision": 1,
  "expected_goal_revision": 1,
  "expected_agent_config_revision": 0,
  "workers": [
    {"executor_type": "codex", "model": null},
    {"executor_type": "cline", "model": null}
  ],
  "assignments": {"api": "worker-1", "ui": "worker-2", "integration": "worker-2"}
}
```

示例工作项 ID 必须替换为当前提案中的真实 ID。确认需要为每项工作明确分配一个有效 Worker；过期版本或尚未结束的 Planner 对话会拒绝派工。

## 修改 Agent 配置

Planner 面板常驻 Agent、模型与思考强度选项。“选择 Worker Agents”入口在创建前、商讨中及暂停后均可打开，逐位选择执行器、目录模型或自定义模型，以及该执行器和模型支持的思考强度。创建前的预设仅保存在页面草稿，随创建请求提交；现有团队的修改通过同一鉴权命令入口提交：

```json
{
  "type": "configure_agents",
  "expected_goal_revision": 1,
  "expected_plan_revision": 0,
  "expected_agent_config_revision": 0,
  "planner": {"executor_type": "codex", "model": "model-id", "effort": "high"},
  "workers": [{"executor_type": "cline", "model": null, "effort": null}]
}
```

`planner` 和 `workers` 至少提供一项。操作在 `DISCUSSING`、`PLAN_READY` 或从商讨、规划、工作、阻塞阶段暂停且全部执行范围已停止的团队中应用。开工后只允许修改成员配置，人数保持不变。保存不会启动新运行；清除 `effort` 恢复执行器默认值。配置更新原子写入团队日志，增加 `planning.agent_config_revision`，重放相同命令不重复应用。

提案尚未确认时，修改配置会增加计划版本；删掉 Worker 后，其工作项暂时分配给第一个 Worker，确认窗口仍要求逐项审核。批准提案同时检查配置版本，避免旧窗口覆盖刚保存的选择；未修改过配置的旧客户端仍可使用原确认字段。操作员预设约束 Planner 的推荐，数量不一致会在派工前阻塞。团队日志是配置事实来源，交付 runner 持有任务锁后将最新 Planner 配置绑定到任务与 Reviewer；历史运行记录和已接受成果保持不变。

## 执行中改向

`adjust` 绑定 `expected_revision`，先使目标与其下游结果失效，标记 `HELD`，确认旧执行范围退出，再记录发给 Planner 的修改请求。Planner 的 `revise` 回合读取反馈、完整计划与对话，生成新的可执行方向后重新派工。无关工作项的定义和已接受产物必须保留；原依赖与路径范围保持不变。需要改整张图时使用 `replan`。

Planner 回合不能修改工作文件。版本或工作图变化后，旧 Planner 结果也会拒绝，并重新排队尚未落实的请求。改向失败时保持挂起；停止范围无法确认时进入 `RECOVERY_REQUIRED`。控制器重启会恢复未完成的改向请求，也保留未确认计划的派工门槛。

## 同模型 Reviewer

仅 Planner 团队使用服务端写入的 `planner-model-fresh-session` 策略。Reviewer 使用相同执行器、模型与显式思考强度参数，但每次通过 `adapter.run` 创建新运行，不恢复 Planner/Worker 会话。缺失复检会话身份或与任何已记录 Planner/Worker 会话冲突时拒绝结果。默认 V2 的不同执行器约束保留。Planner 团队的执行与复检禁止静默模型降级；配额不足直接保留失败原因，不触发 Cline 的旧模型/强度回退。

成果仍经过既有停止证明、快照密封、候选绑定、授权、受信验收与最终提升。选择同模型不会跳过这些交付检查。

验证入口：`tests/native-catalog.test.mjs`、`tests/agent-options.test.mjs`、`tests/executor-catalog-api.test.mjs`、`tests/team-agent-configuration.test.mjs`、`tests/team-planner.test.mjs`、`tests/team-api.test.mjs`、`qa/planner-browser.mjs`。目录协议验证使用受控子进程，覆盖分页、provider 选择、准确等级、超时和无推理调用；浏览器及后端场景使用受控模型输出，真实 HTTP、控制器、文件系统和版本校验参与执行。

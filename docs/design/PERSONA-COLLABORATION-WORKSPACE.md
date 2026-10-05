# Persona 协作空间

日期：2026-10-02。2026-10-04 更新交付工作台配色；2026-10-05 增加本机一键授权。

以用户指定的 Persona 5 红黑白、斜切构图和怪盗漫画风为视觉方向，设计质量参考 [Awwwards](https://www.awwwards.com/) 与 [CSS Design Awards](https://www.cssdesignawards.com/about)。页面面向多 Agent 协作：一个目标、多个成员、可调整的行动计划，以及可追踪的交付。

## 页面与视觉

默认地址 `/` 进入 `/teams.html`。深色侧栏承载团队切换，纸白工作区承载真实状态。海报标题、斜切红色底块、网点、原创几何面具与 AF 标记构成视觉重点。业务卡片使用稳定网格，避免装饰影响阅读。

主流程是“选择 Planner 模型 → 聊天商讨 → 生成行动计划 → 确认 Worker 数量、模型与分工 → 开工 → 同模型独立会话复检”。创建时也可选择由 Planner 推荐编组后自动开工。Planner 对话独占整行，下面在有计划时显示提案、派工确认与 Worker 任务；动态和回执收在下方。已选择团队时缩小顶部海报，手机成员采用横向滚动。漫画对话气泡、斜切面具徽章、calling card、四步行动条与返工条加强 P5 视觉，也标记真实阶段。

- 点击 Planner 聚焦常驻对话框；点击 Worker 定位它的任务，再通过 Planner 调整。成员消息保留独立入口。
- Planner 面板常驻 Agent、模型与思考强度选单；“你的团队”旁的“选择 Worker Agents”逐位配置 Worker，创建前和商讨阶段即可预设。目录模型用下拉选单，自定义模型显示额外输入框；保存配置不会开工，直接发送消息或请求提案会先应用所选 Planner 配置，待回执确认后继续。
- 打开页面、普通刷新或切回前台时读取已有 Agent 和模型目录；只有点击“重新扫描”才启动原生模型目录查询。团队上方显示安装数、接入数、模型数及实际扫描时间。强度选单只展示所选模型确认的等级，并显示具体值；没有元数据则禁用覆盖、沿用默认。重扫保留配置草稿并清除失效等级，不触发派工；服务重启后可手动扫描补齐进程内缓存。
- Command Code 在 Agent 选单中显示为 `cmd`，通过原生 `--list-models` 读取目录，Planner 与每位 Worker 都能独立选择；默认项显示用户当前配置的模型。它的文本模型目录不携带每模型等级，只有明确的 BYOK 或注册表等级元数据才启用强度覆盖。
- 已开工的团队先暂停，全部执行范围停止后才能换配置；保留已接受成果，配置用于后续尝试。确认同时绑定配置版本，Reviewer 在交付时继承最新 Planner 配置并建立独立会话。
- 点击执行中的工作项，暂停旧尝试与受影响的依赖并提交反馈；Planner 改写后才重新派工。提交绑定打开编辑器时的版本，防止静默覆盖后续修改。
- 计划提案默认停在 `PLAN_READY`；编组窗口允许 1–8 位 Worker、相同或不同的执行器/模型以及逐项分配。确认绑定计划版本和目标版本。
- Reviewer 与 Planner 的模型配置一致，但建立独立会话；拒绝缺失身份或与任一 Planner/Worker 会话冲突的复检。
- 主按钮根据真实阶段显示启动、恢复、协作中或继续交付。
- 成员消息与操作回执支持键盘切换。
- 输入错误显示在当前弹窗，保留已填写的草稿。
- 手机端使用单列布局；收起的导航不参与键盘焦点，展开导航时背景不可操作，Escape 关闭并恢复焦点。
- 动画采用 transform、opacity 与颜色过渡，遵循 `prefers-reduced-motion`。

交付工作台位于 `/workbench.html`，同步采用黑色导航、纸白卡片、红色海报和统一按钮。它保留原有 12 列 / 8pt 布局、八阶段进度、任务证据、恢复计划与鉴权操作。验收参数及提交标识收进展开设置；自动标识随草稿修改更新，相同草稿重试保留标识，手工标识由用户控制。验证失败时展开相关字段。手机任务队列可以单独滚动，避免长列表将详情推到页面末端。历史 `/#TASK-*` 书签继续转到该页面。

2026-10-04 配色复检：交付页撤去旧的绿色、蓝灰状态配色。顶部权限标识采用黑底纸白字、红色边线与错位底板，浏览器已授权且服务端开启写路由时切为纸白底黑字；文字保留当前权限与缺失条件。已连接用纸白菱形，连接中断用红色方形并说明原因。任务、消息与已完成阶段使用黑色或暖灰，执行及异常使用红色与明确文字；小字号红色状态采用深红以提高对比。高对比模式使用系统颜色并撤去标识阴影。该调整不改变鉴权、派工或模型扫描行为。

## 字体与按钮

选字参考 [Awwwards 的 Anton 字体筛选](https://www.awwwards.com/websites/art/) 与 [CSS Design Awards 的 Stelvio Grotesk 字体展示](https://www.cssdesignawards.com/woty2020/sites/stelvio-grotesk)。以下组合是根据 Persona 海报气质和工作台阅读需求做出的设计选择；正文借鉴清晰的 grotesk 排版方向。

| 使用位置 | 字体 | 选择理由 |
|---|---|---|
| 英文海报与编号 | [Anton](https://github.com/google/fonts/tree/main/ofl/anton) | 紧凑、厚重，强化红黑白海报的视觉重心 |
| 英文界面与数字 | [Space Grotesk](https://github.com/floriankarsten/space-grotesk) | 几何形态与清晰字腔，适合按钮和状态信息 |
| 中文标题、主要 CTA | [得意黑 Smiley Sans](https://github.com/atelier-anchor/smiley-sans) | 窄斜字身与手绘细节呼应怪盗漫画风；仅用于短标题与大字号按钮 |
| 中文正文 | Noto Sans CJK SC / 苹方 / 微软雅黑 | 保持长句和小字号信息的阅读清晰度 |

两个页面通过 `foundry-theme.css` 共用字体与交互样式。主要 CTA 使用斜切黑色前板、红色错位底板、小标题与独立箭头板；主要操作使用红色前板和黑色底板；次要操作使用纸白描边。悬停抬起前板，按下时前板与底板合拢。焦点轮廓保留在裁切图形外，禁用状态撤去底板，减少动画模式禁用位移动画。

## 全站边框

`foundry-frames.css` 在两页最后加载，统一面板、成员卡片、工作项、聊天区、动态、编组卡片、交付设置、输入框、证据和全部 7 个弹窗。大面板采用黑色连续描边、右上和左下斜切角、跟随轮廓的错位底板；Planner 与交付主面板使用红色底板。选中、执行和挂起状态继续保留独立的文字标记与红色强调。空状态使用浅色网纹，避免影响正文阅读。

裁切施加在装饰底层，保留实际内容与焦点区域。输入框保持完整文字区域和原生下拉选单，通过角标、描边和焦点反馈呼应漫画面板。弹窗保留原生顶层、焦点约束与滚动，在框角、标题分隔和错位底板上加强视觉。高对比模式撤去装饰层、恢复系统边框。交付队列中的卡片禁止压缩，长状态可换行，队列自身滚动。

## 预览

协作流程截图来自真实 Chromium、HTTP 服务与协作控制器，模型输出使用受控测试适配器。新建工作区和目录选择截图来自相同的受控 Chromium 测试；直接聊天截图来自实际本机服务，未发送模型消息。

![Planner 桌面协作空间](../previews/persona-workspace/planner-desktop.png)

[查看手机长图](../previews/persona-workspace/planner-mobile.png) · [手机编组窗口](../previews/persona-workspace/planner-dispatch-mobile.png) · [暂停并通知 Planner](../previews/persona-workspace/planner-rework-desktop.png)

[统一新建工作区](../previews/persona-workspace/planner-new-session-desktop.png) · [手机新建工作区](../previews/persona-workspace/planner-new-session-mobile.png)

[常驻 Planner 配置](../previews/persona-workspace/planner-config-desktop.png) · [逐位 Worker 配置](../previews/persona-workspace/worker-config-desktop.png) · [手机 Worker 配置](../previews/persona-workspace/worker-config-mobile.png)

[本机目录选择](../previews/persona-workspace/project-picker-desktop.png) · [手机目录选择](../previews/persona-workspace/project-picker-mobile.png)

[Command Code Planner 模型选择](../previews/persona-workspace/command-code-planner-desktop.png) · [Command Code Worker 模型选择](../previews/persona-workspace/command-code-workers-desktop.png) · [手机 Command Code 编组](../previews/persona-workspace/command-code-workers-mobile.png)

创建入口统一聚焦 Planner 的项目、验收标准、Agent / 模型 / 思考强度与第一条消息。Worker 人数默认在计划确认时选择，也可提前通过独立配置入口预设；开工授权由工作区明确选择；验收标准绑定注册项目，提交标识由内部幂等逻辑管理，不再要求手填命令或 JSON 参数。模型和强度联动：切换 Agent 清除不兼容覆盖，没有思考等级的模型禁用强度覆盖。Cline 的模型名称目录不作为强度证据，开关和 token 预算不转换成等级；自定义模型也不继承其他模型的强度。手机端底部主按钮保持可见。Reviewer 沿用 Planner 配置并开启独立会话。

![交付工作台](../previews/persona-workspace/workbench-desktop.png)

[查看交付工作台手机长图](../previews/persona-workspace/workbench-mobile.png)

## 验证

运行：

```bash
AF_EXECUTORS_DIR="$PWD/fixtures/agent-foundry-global/executors" node qa/planner-browser.mjs --output-dir /tmp/af-planner-browser
node qa/team-browser.mjs --output-dir /tmp/af-persona-browser
node verification/web-console-smoke.mjs
node verification/web-write-browser.mjs
node verification/deploy-preflight.mjs
node --test tests/team-agent-configuration.test.mjs tests/team-planner.test.mjs tests/team-api.test.mjs tests/web-api-readonly.test.mjs tests/web-api-write-auth.test.mjs tests/web-style-scale.test.mjs
```

Planner 浏览器命令使用进程级测试注册表及受控健康检查、模型输出，不依赖本机已安装客户端或账户；不修改部署的执行器注册表。旧团队的浏览器回归也按现有入口操作：Worker 卡片定位任务，消息通过团队动态入口发送，新建目标进入常驻 Planner。

最新系统复检：全量 904 项（899 通过、0 失败、5 个既有门控跳过）、架构 6/6、浏览器 240/240。Pi 重复模型身份拒绝，卸载客户端后的共享扫描缓存正确失效；本机原生元数据已复扫且普通读取保留缓存。完整范围与真实模型验证边界见 [系统复检](../reviews/2026-10-04-final-system-review.md)。

2026-10-04：全量 901 项（896 通过、5 个既有门控跳过、0 失败）、架构 6/6；Planner Chromium 57 项、首次聊天 46 项、项目目录 19 项、Agent 发现目录 35 项通过。目录测试使用实际文件系统、HTTP 与 canonical 注册表，包含响应丢失、可信验收资产和符号链接；真实本机视觉及目录选择 25 项通过，无模型请求。

交付配色复检：Chromium 只读 34/34、写操作 26/26 通过，包含服务端关闭写路由、未保存令牌、保存令牌、清除令牌四种状态，以及正文和连接标识对比、真实读取中断反馈、高对比系统颜色、320–1440px 布局。使用临时文件系统与受控 Worker 派发，不调用真实模型；桌面与手机预览已更新。

以下保留早期阶段检查记录：

- 协作页 Chromium 验证 23 项行为：默认入口、历史任务书签、鉴权操作、成员和依赖、消息回执与转义、定向调整、无关产物保留、旧结果拒绝、刷新恢复、桌面网格、手机导航与焦点、新建弹窗、错误草稿保留、键盘标签、本地字体、中文标题与正文排版、斜切按钮、响应式与减少动画，以及浏览器创建时 Planner 配置落库与 Reviewer 配置绑定。
- Planner 页 Chromium 验证 40 项行为，覆盖真实聊天、消息转义、确认前不派工、计划后修改人数、不同执行器与模型、逐项分配、暂停、Planner 改写、下游挂起、旧结果拒绝、无关成果保留、重载与手机编组窗口；包括简洁创建、常驻 Planner 配置保存、商讨阶段的 Worker 配置、模型下拉与自定义、执行器和模型的强度限制，以及真实执行请求中的 Planner / Worker 强度。新增自动扫描、重扫保留草稿、未知 Planner 和 Worker 模型清除强度覆盖。
- 新流程覆盖 320–1920px，无页面横向溢出；成员列表在手机端可单独横向滚动。
- Planner 后端检查覆盖手动与自动派工、复检新会话、版本冲突、计划与改向的重启恢复，以及无关定义保护。既有团队链路继续回归。
- Agent 配置后端检查 7/7 通过：保存不派工、模型与强度传入执行、最新 Reviewer 绑定、非法配置拒绝、版本冲突和重启恢复、暂停后换配置保留无关成果、预设人数约束，以及当前模型目录变化后拒绝旧强度。目录检查 17/17 通过，覆盖逐模型等级、provider 一致性、元数据脱敏、超时清理、并发查询合并和扫描失败；包含 Command Code 原生列表、截断拒绝、别名、用户默认模型与 BYOK 精确等级。完整测试 840 项：837 通过、3 跳过、0 失败。
- 交付页浏览器检查：只读 30/30、写操作 22/22 通过，覆盖本地字体、同款按钮、真实 CTA 点击、提交标识、只读预检、设置错误展开、任务创建/启动/取消、消息队列、令牌与响应式布局；320–1440px 的较长状态信息保留在卡片内。
- 当前只读预览专项复检：91/91 通过，检查自动扫描完成、创建前 Planner 选择与创建弹窗同步、Worker 草稿保存并重开、320–1920px 配置布局，全部 7 个原生弹窗的边界、焦点与滚动，高对比和减少动画模式，以及长交付卡片的高度与换行。只修改页面草稿和长状态 DOM 样例，未调用写接口。此为专项复检记录，工作流的自动回归仍由上面的脚本覆盖。
- Command Code 当前只读预览复检 15/15 通过：本机 CLI v1.73.0 返回 86 个模型，两处选单完整显示、默认模型匹配、Worker 独立选择、未知强度禁用、320/390/1440px 长模型 ID 无横向溢出、无运行时错误及无 API 写请求。模型数为本次目录快照，随客户端与 provider 变化；[原始检查记录](../previews/persona-workspace/command-code-report.json)。
- 部署静态预检：46/46 通过，覆盖两页资源、共享边框样式、字体许可与控制项。该预检检查部署输入，不等同于系统服务安装或真实模型验收。
- 原始浏览器结果：[Planner 页](../previews/persona-workspace/planner-report.json)、[既有协作链路](../previews/persona-workspace/report.json)、[交付页](../previews/persona-workspace/workbench-report.json)。
- 边框复检记录：[两页、全部弹窗与可访问性](../previews/persona-workspace/frame-review.json)。

## 资源

使用原生 HTML、CSS、JavaScript 和 SVG，无新增运行时依赖。图形与图标为仓库内矢量资源；字体本地加载，分别保留 [Anton](../../web/fonts/Anton-OFL.txt)、[Space Grotesk](../../web/fonts/SpaceGrotesk-OFL.txt) 与[得意黑](../../web/fonts/SmileySans-OFL.txt)的 SIL Open Font License。页面不请求外部字体或图片。

2026-10-05 权限交互更新：两页顶部统一“一键授权 / 取消授权”，沿用斜切按钮与红黑配色。本机点击即可建立会话，无令牌输入弹窗；现有弹窗改为权限状态与操作入口，手动令牌仅在折叠的高级连接内提供。服务不可用、只读启动或权限失效时禁用写操作并说明原因，保留 Planner 和交付草稿。普通加载只读取状态，不自动授权或复扫 Agents。

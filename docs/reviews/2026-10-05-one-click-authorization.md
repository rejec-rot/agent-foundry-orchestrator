# 本机一键授权 — 2026-10-05

代码提交：[5005dab693cf1161c2b701bb9dc7b41b039bc2b9](https://github.com/rejec-rot/agent-foundry-orchestrator/commit/5005dab693cf1161c2b701bb9dc7b41b039bc2b9)。主实现为 e92e6d4；5005dab 补齐手机端授权按钮及对应可见性检查。

## 最终行为

两页顶部统一“一键授权 / 取消授权”。本机点击直接建立授权，不要求寻找文件、复制令牌或再确认弹窗；同一地址与端口的团队页和交付页共用会话。权限轮询约 1.5 秒同步，页面重新可见时刷新。取消后撤销服务端 nonce，旧 Cookie 无法重放，所有草稿保留。手机端交付页也保留顶部按钮。

授权本身不会启动 Planner、Worker、Jev、控制器、创建任务或触发原生扫描。写操作依然需要服务端显式 --allow-write 和既有令牌配置。远程连接保留折叠的高级令牌入口，候选令牌通过验证后才存入当前标签页 sessionStorage。

## 会话与拒绝边界

服务端进程持有随机签名密钥和最多 128 个活动 nonce，不新增数据库或凭据文件。Cookie 为 HttpOnly、SameSite=Strict 的浏览器会话 Cookie，HTTPS 时另加 Secure；配置令牌不返回给页面，不进入前端存储。服务端在准确 8 小时边界拒绝会话，重启使旧签名与 nonce 无效。浏览器恢复上次会话可能恢复 Cookie，仍受服务端时限约束。

授权和撤销要求真实 loopback socket、严格的本机 Host、实际监听端口、同源 Origin、x-af-csrf:1；可用时检查 Sec-Fetch-Site。Cookie 写操作保持相同限制，非法 Host、异源、篡改、过期及重放均拒绝。静态 HTML 使用 CSP frame-ancestors 'none' 与 X-Frame-Options DENY，独立 Chromium 验证其他本机端口无法通过嵌入页面引导授权。已有 bearer/CLI 行为保持兼容；该会话没有引入多用户身份或权限分级。

页面通过服务端状态决定控件权限。失效或无法确认权限时禁止写操作并保留草稿；高级连接失败也不保存无效候选。交付页页内锚点不再被误当成任务编号，避免点击“新建交付任务”触发错误读取。

## 验证

全量 940 项：935 通过、0 失败、5 个既有门控跳过；完成时间 2026-10-05T01:26:04.484Z。跳过为两项 Docker 部署门控、两项依赖缺失注册表环境的门控及 GP-4 真实执行器门控，未启用或冒充真实模型验收。鉴权与架构专项 20/20，其中架构 6/6。非作者独立鉴权/只读专项 28/28，跨页面授权 Chromium 独立复跑 37/37。

| 浏览器与模拟检查 | 通过数 | 时间 UTC |
|---|---|---|
| Planner | 58/58 | 2026-10-05T01:15:14.349Z |
| 首次聊天 | 46/46 | 2026-10-05T01:13:04.191Z |
| 团队操作 | 24/24 | 2026-10-05T01:13:29.100Z |
| 项目目录 | 19/19 | 2026-10-05T01:15:58.033Z |
| Agent 发现 | 35/35 | 2026-10-05T01:20:07.420Z |
| 交付只读 | 40/40 | 2026-10-05T01:24:50.238Z |
| 交付写操作 | 29/29 | 2026-10-05T01:25:31.457Z |
| 跨页面授权 | 37/37 | 2026-10-05T01:19:29.310Z |
| 模拟流程与浏览器 | 54/54 | 2026-10-05T01:19:20.744Z |

共 342 项浏览器与模拟检查通过（其中模拟流程 54 项）。跨页授权专项确认 Cookie 不能被 JavaScript 读取、不存配置令牌、双方授权和撤销自然轮询同步、草稿和持久化记录不变；扫描、适配器运行/恢复、Worker 派工和控制器启动计数均为零。只读检查准确验证无效高级令牌被拒绝，没有以此声称有效令牌的身份校验结果。

本机工作台 8787 已更新，授权前没有团队。仅一次显式元数据扫描得到 114 个模型，普通缓存读取保持一致。模拟演示 8788 使用受控虚拟 Agents/Jev，9 阶段、2 个真实 Node 验收测试及临时 Git 提升通过；没有调用真实模型账号。

机器摘要见 [验证数据](2026-10-05-one-click-authorization.json)。运行专项检查：

```bash
AF_EXECUTORS_DIR="$PWD/fixtures/agent-foundry-global/executors" node --test tests/web-local-session.test.mjs tests/web-api-write-auth.test.mjs tests/architecture-invariant.test.mjs
node qa/access-browser.mjs --output-dir /tmp/af-access-browser
AF_WORKBENCH_PALETTE_DIR=/tmp/af-workbench-read node verification/web-console-smoke.mjs
AF_WORKBENCH_PALETTE_DIR=/tmp/af-workbench-write node verification/web-write-browser.mjs
```

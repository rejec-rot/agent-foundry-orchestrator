# Persona 协作空间

日期：2026-10-02。

以用户指定的 Persona 5 红黑白、斜切构图和怪盗漫画风为视觉方向，设计质量参考 [Awwwards](https://www.awwwards.com/) 与 [CSS Design Awards](https://www.cssdesignawards.com/about)。页面面向多 Agent 协作：一个目标、多个成员、可调整的行动计划，以及可追踪的交付。

## 页面与视觉

默认地址 `/` 进入 `/teams.html`。深色侧栏承载团队切换，纸白工作区承载真实状态。海报标题、斜切红色底块、网点、原创几何面具与 AF 标记构成视觉重点。业务卡片使用稳定网格，避免装饰影响阅读。

主流程是“创建目标 → 启动团队 → 查看成员与计划 → 调整工作项 → 继续交付”。新建、权限、成员消息、定向调整、整体目标与运行记录使用原生 dialog，默认界面只显示当前目标、成员、计划与动态。

- 点击成员，选择真实接收者并发送消息。
- 点击工作项，修改方向或改派；提交绑定打开编辑器时的版本，防止静默覆盖后续修改。
- 主按钮根据真实阶段显示启动、恢复、协作中或继续交付。
- 成员消息与操作回执支持键盘切换。
- 输入错误显示在当前弹窗，保留已填写的草稿。
- 手机端使用单列布局；收起的导航不参与键盘焦点，展开导航时背景不可操作，Escape 关闭并恢复焦点。
- 动画采用 transform、opacity 与颜色过渡，遵循 `prefers-reduced-motion`。

原交付工作台保留在 `/workbench.html`，历史 `/#TASK-*` 书签自动转到该页面。现有交付、鉴权、CSRF 和 controller 指令入口继续负责业务规则。

## 预览

下面的截图来自真实 Chromium、HTTP 服务与协作控制器，模型输出使用受控测试适配器。

![桌面协作空间](../previews/persona-workspace/team-desktop.png)

[查看手机长图](../previews/persona-workspace/team-mobile.png)

## 验证

运行：

```bash
node qa/team-browser.mjs --output-dir /tmp/af-persona-browser
node verification/deploy-preflight.mjs
node --test tests/team-api.test.mjs tests/web-api-readonly.test.mjs tests/web-api-write-auth.test.mjs tests/web-style-scale.test.mjs
```

- Chromium 验证 19 项行为：默认入口、历史任务书签、鉴权操作、成员和依赖、消息回执与转义、定向调整、无关产物保留、旧结果拒绝、刷新恢复、桌面网格、手机导航与焦点、新建弹窗、错误草稿保留、键盘标签、本地字体、响应式与减少动画。
- 视口覆盖 360、390、768、1024、1440、1920px，无横向溢出。
- 相关 API 与工作台回归：24/24 通过。
- 部署静态预检：38/38 通过，覆盖新旧页面资源与控制项。该预检检查部署输入，不等同于系统服务安装或真实模型验收。
- 原始浏览器结果：[report.json](../previews/persona-workspace/report.json)。

## 资源

使用原生 HTML、CSS、JavaScript 和 SVG，无新增运行时依赖。图形与图标为仓库内矢量资源；标题字体是本地加载的 [Barlow Condensed ExtraBold](https://github.com/google/fonts/tree/main/ofl/barlowcondensed)，保留 [SIL Open Font License](../../web/fonts/OFL.txt)。页面不请求外部字体或图片。

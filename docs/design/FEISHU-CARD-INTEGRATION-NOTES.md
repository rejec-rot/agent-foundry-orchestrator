# 飞书边界卡片：接入前的规范约束（实测对应版本 `f52cc5f`）

设计稿：

- `docs/design/feishu-boundary-preview.html` —— 浏览器预览（黄=保留 / 红=升级 / 绿=恢复完成），页面顶部已标注"均为示例数据，不代表当前运行状态"。
- `docs/design/feishu-boundary-card.example.json` —— 自定义机器人卡片请求体示例。

规范来源：[自定义机器人使用指南](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)（2026-09 读取）。

## 1. 请求体形状（示例已符合）

```json
{ "msg_type": "interactive", "card": { "config": {...}, "header": {...}, "elements": [...] } }
```

自定义机器人只能通过 webhook 推送，**不具有任何数据访问权限**；群内呈现由飞书客户端渲染，
**不会与 HTML 预览完全一致**（预览只用于对齐信息层级与配色）。

## 2. 版本现状：v1 保留为参考，v2 已交付并逐项核实

`feishu-boundary-card.example.v2.json` 是按 **Card JSON 2.0** 逐项核对后新增的示例，v1 示例保留作参考。
核实方式：逐页渲染官方文档（`card-json-v2-structure`、`普通文本`、`富文本（Markdown）`、`分割线`）后比对，
结论如下。

| 组件/字段 | v1 用法 | 2.0 结论 | 本项目取值 |
|---|---|---|---|
| 信封 | `card.header/elements` | 2.0 为 `schema`+`config`+`card_link`+`header`+`body.elements` | `schema:"2.0"`，组件放 `body.elements` |
| `div` + `text.tag=plain_text` | 支持 | **2.0 支持**（普通文本组件，另有 `text_size`/`width` 等 2.0 新属性） | 全部动态字段用 `plain_text`（不用 `lark_md`，避免路径/原因注入格式） |
| `markdown` | 支持 | **2.0 支持**（富文本语法增强） | 不使用（动态内容一律纯文本） |
| `hr` 分割线 | 支持 | **2.0 支持**，tag 仍为 `hr` | 使用（信息分段） |
| `note` 备注 | v1 组件 | **不在 2.0 组件列表** | **不使用**；审计标识改为普通文本 `div` |
| `config.wide_screen_mode` | v1 常用 | 2.0 全局属性未列入该字段 | 不使用；改用 `config.update_multi=true` |
| `update_multi` | 可选 | 2.0 **仅支持共享卡片**，须为 `true` | `true` |
| `element_id` | 无 | 2.0 新增，卡内唯一、字母开头、≤20 字符 | **不使用**（只读展示卡无需，规避重名错误） |
| 组件数量 | — | 单卡 **≤200 个元素/组件** | 单卡 8 个（含文本元素） |
| 客户端要求 | — | 2.0 需较新客户端，旧客户端正文显示升级提示 | 已在接入说明中提示 |

### 历史（已解决）：v1/v2 差异

迁移不是"把 `elements` 搬进 `body`"这么简单，上表列出了必须逐项确认的差异：
信封结构、`note` 消失、`wide_screen_mode` 不再使用、`update_multi` 必为 true、元素上限。
`tests/design-feishu-card.test.mjs` 会校验 2.0 示例只含 2.0 允许的组件、且 `note`/交互组件不出现。

## 2.1 待定夺（原问题，保留记录）

- 示例用的是**卡片 v1**（顶层 `elements` + `config.wide_screen_mode`），文件尾注也写明"卡片 v1"。
- 官方当前示例用的是 **`schema: "2.0"`**（`body.elements` 结构）。
- 影响：v1 目前仍可用且满足"只读展示"需求；若希望与官方最新示例一致、避免将来 v1 退场带来的改版，
  应把示例迁移到 2.0（改动集中在 envelope：`card.schema="2.0"`、`config.update_multi`、
  `elements` 移入 `body.elements`）。
- **已按操作者选择完成**：v2 示例已新增（`feishu-boundary-card.example.v2.json`），v1 保留继续作参考。

## 3. 必须遵守的硬约束

| 约束 | 值 | 对通知层的影响 |
|---|---|---|
| 请求体大小 | **≤ 20 KB** | 当前示例约 1.5 KB；payload 含长路径仍需截断保护 |
| 频率 | 单机器人 **100 次/分钟、5 次/秒** | 现有告警频率远低于此；批量场景需限速 |
| 整点/半点 | 可能返回 `11232` 限流错误 | 定时巡检建议避开 `:00`/`:30`，或对 11232 退避重试 |
| 安全设置 | 自定义关键词 / IP 白名单 / 签名 | 若启用**关键词**，卡片文本必须包含该关键词；启用**签名**则需 `timestamp`+`sign`（通知层已支持签名重建） |

## 4. 三态与字段映射（与 HTML 预览一致）

| 预览卡片 | 触发条件 | 建议 `header.template` | 审计标识 |
|---|---|---|---|
| 黄色 保护保留 | `boundary_state=PROTECTION_RETAINED_PENDING_RECOVERY`，`occurrences < 阈值` | `orange`（或 `yellow`） | `alert_id` + 时间 |
| 红色 告警升级 | 持续保留达升级阈值（默认 3 次） | `red` | `alert_id` + `occurrences` |
| 绿色 恢复完成 | 受控恢复成功、告警关闭 | `green` | 恢复审计标识 + 时间 |

信息层级（三种状态一致）：**状态标题 → 仓库与任务 → 异常依据 → 资产路径 → 处理建议 → 审计标识**。
对应的通知 payload 字段：`severity`/`occurrences`、`canonical_dir`/`task_id`、
`reason`/`scope_decision.{decision,reason,attempts,anomalies}`、`canonical_dir`/`cas_dir`、
（建议文案由模板固定）、`alert_id`/`at`。

## 5. 接入状态：已实现（`AF_BOUNDARY_NOTIFY_FORMAT=feishu-card`）

- 新格式与文本格式**并存**：`feishu`（`msg_type:text`）保持兼容，`feishu-card`（`msg_type:interactive` + 2.0）为新增。
- 发送模式仍默认 `off`；`dry-run` 零外发；`live` 需 `AF_BOUNDARY_NOTIFY_MODE=live` + webhook + `--confirm`。
- 四态映射：`retained`→`orange`、`escalated`→`red`、`restore-incomplete`→`red`（明示"恢复未完成，保护完整性不可确认"）、`recovered`→`green`。
- 复用既有安全链路：错误文本脱敏、自由文本路径脱敏、签名（`timestamp`+`sign`，重试时重新签）、
  有界退避重试、**provider 回执校验**（feishu-card 与 feishu 一样必须 `code=0`，HTTP 200 不算成功）、
  结清与终态审计。
- 新增硬约束检查：**对最终签名后的请求体**统计 UTF-8 字节数，超限（默认 20000 字节）**拒绝发送**并记审计事件；
  动态字段一律 `plain_text`，超长字段**有界截断并标注** `…[已截断]`，审计行注明"内容已截断 N 处"。
- 卡片**不含任何可改变边界状态的操作组件**（无按钮/表单），符合"恢复必须走带理由与审计的受控恢复"。
- 四态 dry-run 交付：`verification/feishu-card-states.mjs` → `real-smoke-evidence/feishu-card-states-<sha>/`
  （四份卡片 JSON + manifest）与 `docs/design/generated/feishu-card-four-states.html`（+ 渲染 PNG）。

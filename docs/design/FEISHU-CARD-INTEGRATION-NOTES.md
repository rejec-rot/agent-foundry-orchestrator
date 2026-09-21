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

## 2. 待定夺：卡片 JSON 版本

- 示例用的是**卡片 v1**（顶层 `elements` + `config.wide_screen_mode`），文件尾注也写明"卡片 v1"。
- 官方当前示例用的是 **`schema: "2.0"`**（`body.elements` 结构）。
- 影响：v1 目前仍可用且满足"只读展示"需求；若希望与官方最新示例一致、避免将来 v1 退场带来的改版，
  应把示例迁移到 2.0（改动集中在 envelope：`card.schema="2.0"`、`config.update_multi`、
  `elements` 移入 `body.elements`）。
- **未改动你的设计文件**：这属于模板取舍，等你确认后再迁移（或按 v1 保持）。

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

## 5. 接入状态

- 通知层当前只发送**文本**消息（`AF_BOUNDARY_NOTIFY_FORMAT=feishu` → `msg_type:text`）。
- 卡片接入 = 新增一个 `feishu-card` 渲染分支（把 payload 映射到上述模板），保持：默认 `off`、
  `dry-run` 零外发、`live` 需显式启用、单次授权才发送。
- 接入前建议先用 `boundary notify-test` 在 `dry-run` 下打印完整卡片 JSON 人工核对，
  再单独授权一次真实发送。

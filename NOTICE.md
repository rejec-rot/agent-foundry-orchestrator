# NOTICE — 来源与许可状态

## 来源（Provenance）

| 项 | 值 |
|---|---|
| 上游仓库 | `https://github.com/opperl1114/agent-foundry-orchestrator` |
| 基线提交 | `434114e` — `chore(runtime): stop tracking the circuit-breaker state`（2026-09-16 10:40 +0800） |
| 基线版本 | `1.2.0`（`package.json` 原始声明） |
| 本仓库内容 | 上游 `434114e` 的**全部被跟踪文件** + 第二轮安全修复（见下） |
| 复制方式 | `git ls-files` 精确导出（只含被跟踪文件与新增文件，不含 `runtime/` 运行残留） |

## 本仓库相对上游的改动

上游 `434114e` 之上追加了一个安全修复批次，逐项说明见 `docs/ROADMAP.md` §现状：

- 验收白名单绕过（legacy 字符串分支）封堵
- 信任锚缺失改为 fail-closed（含首次锚定语义）
- 验收子进程超时 + 停机回收 + **进程组树回收**
- 任务锁接管竞态消除
- 熔断状态文件缺失改为 fail-closed（初始化标记）
- intent-gate 生命周期写入补版本递增
- `writeJsonAtomic` 补 fsync
- **执行器环境白名单**（只给该执行器自己的凭证）
- **子进程输出上限**（防 OOM）
- **资源限额**（磁盘/CPU/核心转储；内存需 cgroup 委派）
- 新增不变式 INV-6（禁止裸 spawn）

基线测试：`node --test` → 218 通过 / 0 失败。

## ⚠️ 许可状态：未解决（需要你决策）

**上游仓库没有 `LICENSE` 文件**，且 `package.json` 中为 `"private": true`。
在法律上这意味着**保留所有权利（All rights reserved）**——上游**没有授予**任何复制、修改或再分发的许可。

因此本仓库当前状态为：

- `package.json` 显式声明 `"license": "UNLICENSED"`、`"private": true`
- **本仓库不得公开发布**（包括推送到公开 GitHub 仓库），除非下列之一成立

需要你确认属于哪种情况，再决定下一步：

| 情况 | 应采取的动作 |
|---|---|
| **你就是上游作者**（或持有其授权） | 由你**主动**为上游与新仓库添加许可（如 MIT / Apache-2.0）；本文件相应更新，去掉 UNLICENSED |
| 你有作者的书面授权 | 在仓库内保存授权记录（如 `docs/authorization.md`），并按其条件设置许可 |
| 都没有 | 本仓库只能作为**本机私有的实验/学习分支**，不得公开；若要公开，需先取得作者许可，或改为**独立重写**（只保留设计思想、不复制代码） |

> 说明：设计**思想**（如"验收命令静态白名单 + 内容哈希锚定"、"ROLE != PLATFORM 动态角色注入"）
> 通常不受版权保护，可以独立重新实现；受保护的是**这段具体代码**。如果许可问题无法解决，
> 一条可行路径是：新仓库只保留文档与设计，代码按 V2 用成熟组件重新拼装。

## 第三方组件

若按 `docs/ROADMAP.md` 引入替代组件，各组件许可需逐个确认：

- 已标注的高风险项：`tinyhumansai/openhuman`（GPL-3.0）、`smtg-ai/claude-squad`（AGPL-3.0）、
  `Ibrahim-3d/orchestrator-supaconductor`（AGPL-3.0）、`microsoft/autogen`（**CC-BY-4.0，非软件许可**）
- GitHub 标记为 `NOASSERTION` 的多个项目，采纳前必须自行确认许可文本
- 建议在 `docs/adr/` 中为每个被采纳的组件记录一条 ADR，写明许可与风险评估

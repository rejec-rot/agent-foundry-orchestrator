# 0007 — 否决 P5 原方案（子进程交给 execa）；改为修补硬杀后的孤儿残留

- 状态：**已采纳**（否决替换，改为定向修补）
- 日期：2026-09-16
- 决策者：本仓库维护者（授权执行 V2 全计划）
- 相关：`docs/ROADMAP.md` §五 P5、`docs/MODULE-MAP.md` §8

## 背景

P5 原方案：把修复批次里手写的 `lib/child-process.mjs` 换成 `sindresorhus/execa`（7.6k★, MIT），
理由是"成熟库已处理 kill 树、超时、清理"。

按路线图原则 4「先探测再实现」核对后否决。

## 决策

**不替换。** 改为修补该层**实测确认的真实缺陷**：编排器被 **SIGKILL** 后，受管子进程与沙箱容器全部残留（见 §三）。

## 证据

### 1. execa 无法 1:1 覆盖本模块已有的四项能力

| 本模块提供 | execa 的情况 |
|---|---|
| **进程组整树信号**（`process.kill(-pid)`，`signalTree`/`signalPidTree`） | execa 杀的是子进程本身；即便传 `detached: true`，负 pid 的组杀仍需自己写。**这正是 H3 修复的核心** |
| **全局存活子进程登记 + 停机一次回收**（`signalAllManaged`） | execa 有父进程退出清理，但它绑定在 `execa()` 调用上，不是"信号处理器可扫的登记表"，也不覆盖长驻 stdio 子进程（vault MCP 客户端） |
| **输出截断语义**（`capCapture`：截断 + 写入可见标记） | execa 的 `maxBuffer` 是**超限报错**，语义不同（会改变现有验收/执行器的失败分类） |
| **`MANAGED_CHILD` 标记 + INV-6 契约**（非测试代码禁止裸 spawn，唯一工厂） | 无关，但意味着 execa 只能被塞进工厂**内部**——工厂仍然存在 |

### 2. 迁移的爆炸半径

调用点覆盖：`lib/adapters.mjs`（事件式流式读取 + 思考死循环监测 + 持久句柄）、
`lib/acceptance.mjs`（超时 + 登记 + 截断 + 沙箱）、`lib/vault-client.mjs`（长驻 stdio MCP 子进程）、
`lib/codex-planner.mjs`。而收益只是"把已有的封装换成一层依赖"——
与 P1/P3/P4 同构：**"有成熟方案"不等于"该换"**。

### 3. 该层真正的缺陷（实测）

优雅路径（SIGTERM/SIGINT）已覆盖：`signalAllManaged()` + 执行器句柄清理。**SIGKILL 覆盖不了**——
进程没有任何机会运行代码。实测两种残留：

```
实证 A：detached 子进程 vs 父进程 SIGKILL
  父 pid=122798（进程组 122798）｜子 pid=122808（进程组 122808）→ 已脱离
  ★ SIGKILL 父进程后，子进程仍存活

实证 B：docker 容器 vs docker 客户端 SIGKILL
  客户端 pid=122866｜容器状态 running
  ★ SIGKILL 客户端后，容器状态仍为 running
```

**为什么这不只是"不整洁"**：恢复流程会为"owner 已消失"的任务**重新派发**，
于是旧执行器继续编辑同一工作区、继续消耗同一 API 预算，而新的一次运行同时开始。

且实测：**全仓没有任何孤儿回收机制**（`grep` 命中全部是"避免孤儿"的注释，无一是"回收孤儿"）。

## 四、已实施的修复

新增 `lib/orphan-reaper.mjs` + `af-admin reclaim orphans`：

| 目标 | 依据 | 安全规则 |
|---|---|---|
| 沙箱容器 | 名称 `af-sbx-<ownerpid>-<uuid>` 自带 owner pid | 仅当 owner pid **已死**才 `docker rm -f`；活跃实例的容器不动 |
| 执行器进程 | `runtime/runs/<run_id>.json` 句柄（本次起新增 `owner_pid` 与 `pgid` 指纹） | 仅当 owner 已死 **且进程组与记录一致**才发信号。两道独立检查使 PID 复用误杀的概率远低于单看 pid |
| 无指纹的旧句柄 | — | **报告为 unverifiable，绝不发信号**（fail-safe） |
| 进程已消失的句柄 | — | 视为 stale bookkeeping，清掉句柄，不杀任何东西 |

默认 dry-run，`--confirm` 才执行（与 `tasks prune` 既有约定一致）。

**验证**：`tests/orphan-reaper.test.mjs` OR-1..OR-9，含
① 死 owner → 子进程确实被终止且句柄被清 ② 活 owner → 不动
③ **进程组不匹配 → 拒绝发信号**（PID 复用守卫）④ 无 owner_pid → 报告不动作
⑤ dry-run 不动作 ⑥ 死 owner 的容器被删、活 owner 的容器被跳过

`node --test`：246 通过 / 0 失败（原 237），零依赖。

## 后果

- 正面：硬杀后的残留有了回收手段；PID 复用风险被显式处理而不是忽略
- 正面：进程句柄新增 owner/pgid 指纹，为后续任何"跨进程可靠性"逻辑提供基础
- 负面：**回收目前是显式运维动作，未自动接入启动路径**。恢复流程重新派发前是否自动回收，
  是一个会改变启动行为的决策，应在下一轮单独决定（候选：`AF_REAP_ORPHANS_ON_RECOVER=1`）
- 负面：**未覆盖非沙箱化的验收子进程**——验收子进程不写运行句柄，因此没有可校验的指纹。
  沙箱默认 `auto` 时它由容器路径覆盖（清理在 `finish()` 中，硬杀后由容器名回收兜底）；
  但 `AF_SANDBOX=off` 时该残留仍在
- 负面：`processGroupOf` 依赖 `/proc`，非 Linux 平台返回 null → 一律 unverifiable（保守，但不回收）

## 什么情况下应重新评估 execa

1. 需要 execa 的**承诺式 API / 管道组合 / 重试**等本模块没有的能力
2. 本模块增长到自身难以维护（当前 ~230 行，且已有 CP-1..CP-6 测试）
3. 维护者**主动**决定放宽零外部重依赖边界

## 验证方式

- `package.json` 仍无 `dependencies`
- `af-admin reclaim orphans`（dry-run）可用；`--confirm` 执行
- OR-1..OR-9 全绿，其中 OR-4（进程组不匹配拒绝）是防止误杀的回归护栏

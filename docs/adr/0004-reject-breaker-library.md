# 0004 — 否决 P1：断路器不替换为 cockatiel / opossum

- 状态：**已采纳**（否决替换）
- 日期：2026-09-16
- 决策者：本仓库维护者（授权执行 V2 全计划）
- 相关：`docs/ROADMAP.md` §五 P1

## 背景

`docs/MODULE-MAP.md` §4 与 `docs/ROADMAP.md` P1 提议：
把 `lib/executor-runtime-guard.mjs` 的断路器状态机替换为成熟库（`cockatiel` 4.0.0 或 `opossum` 10.0.0），
理由是"断路器是几十年成熟模式，不该手写"，并引用了修复批次中 C5（状态文件损坏 → 全量静默解禁）作为手写翻车的证据。

按路线图 §三 原则 4「先探测再实现」，动手前先核对了库能力与被替换代码的实际形态。

## 决策

**不替换。** `executor-runtime-guard.mjs` 的断路器与并发槽位保持自研，不引入 cockatiel / opossum。

## 证据

### 1. 没有可被替换的计数逻辑

`recordResult()` 读取分类结果的 `safety_action` **立即开闸**，不存在"失败 N 次才打开"的阈值：

```js
if (classification.safety_action === 'OPEN_MANUAL_RESET') { /* 立即 OPEN_MANUAL_RESET */ }
if (classification.safety_action === 'COOLDOWN')          { /* 立即 OPEN_COOLDOWN */     }
```

实测确认：`grep -nE "threshold|allowed_fails|max_fails|consecutive" lib/executor-runtime-guard.mjs` → **零命中**。

而 cockatiel 的核心机制正是失败计数与阈值（`ConsecutiveBreaker` / `SamplingBreaker`）——
在这里**无处可用**。

### 2. 库的核心特性与本项目的核心保证相反

| | cockatiel / opossum | AFR（有意如此） |
|---|---|---|
| 打开之后 | `halfOpenAfter` 到期**自动**进入半开，半开时**放行一次试探** | **永不自动自愈**；`OPEN_COOLDOWN` 到期只投影为 `HALF_OPEN`，而 `HALF_OPEN` 对生产**仍然阻断** |
| 恢复方式 | 一次成功调用即自动闭合 | 必须**人工 probe → evidence → admit** 才闭合 |

即：要用库就必须把 `halfOpenAfter` 的自动自愈压掉，用 `isolate()` + `reset()` 去模拟"人工准入"
——**逆着库的设计使用它**，而 AFR 自己的五态机（`CLOSED / OPEN_MANUAL_RESET / OPEN_COOLDOWN / HALF_OPEN / PROBING`）
与 probe/admit 门禁（`REASON_REQUIRED` / `EVIDENCE_REQUIRED` / `PROBING` 状态机）**一行都不会减少**。

### 3. 并发槽位同样不适合 bulkhead

`acquireSlot()` 里有三样 `bulkhead(limit, queueLimit)` 不提供的东西：

1. **与电路状态的耦合**：等待槽位被唤醒后，必须**重新校验** `canExecute`，否则一个在排队期间被熔断的执行器仍会启动（`acquireSlot` 内两处 `canExecute` 复检）
2. **启动节流**：`min_interval_ms` 的 launch pacing
3. **形态**：AFR 是跨异步边界的 `acquireSlot()/releaseSlot()` 显式配对（spawn → 子进程退出），
   而 bulkhead 是 `execute(fn)` 式，需要把**整个运行生命周期**包进策略管道 → 需要重构 adapter 主流程

该模块中相关引用共 24 处 → **高爆炸半径，换来的只是约三分之一逻辑**。

### 4. "手写状态机翻车"的真实归因

C5（状态文件损坏导致全量解禁）的根因**不是"用了自研断路器"**，而是：

- 状态写入非原子（已修为 `writeJsonAtomic` + fsync）
- 解析失败被 `catch {}` 吞掉后默认"无异常"（已修为 fail-closed）

这两个都是**持久化与错误处理**缺陷，换成任何断路器库**都不能自动修复**——
库同样要把状态落盘，同样要处理损坏。修复批次已针对根因整改，不构成替换理由。

## 备选与为什么不选

| 备选 | 排除理由 |
|---|---|
| cockatiel 4.0.0 | 核心特性（自动半开）须被压制；无可替换的计数逻辑；bulkhead 不覆盖槽位耦合与节流 |
| opossum 10.0.0 | 同为"自动自愈"模型，且是 `fire/fallback` 调用式，与 AFR 的"先门禁后 spawn"形态不匹配 |
| 只用 cockatiel 的 `isolate()/reset()` 表达人工解封 | 这是把库当布尔开关用，等于不引入 |
| 保留自研 | **采纳此选项** |

## 后果

- 正面：**没有引入一个不解决问题的运行时依赖**；AFR 的"永不自动自愈"保证未被削弱；`validate` 与 218 项测试未被扰动
- 正面：`docs/ROADMAP.md` 的 P1 被替换为经过论证的"已评估否决"，避免后人重复评估
- 负面：该模块仍为自研状态机，其正确性依赖现有测试（`runtime-guard-state.test.mjs`、`runtime-guard-policy.test.mjs`、`runtime-safety.test.mjs`、`gated-recovery.test.mjs`）
- 负面：`docs/MODULE-MAP.md` §4 的"不该手写"结论**对本项目不成立**，已在该文档标注

## 什么情况下应重新评估

1. 引入**阈值/滑动窗口**语义（例如"一小时内失败 3 次才开闸"）——那时计数逻辑真会出现，库才有价值
2. 把一次运行的整个生命周期重构为策略管道（bulkhead + timeout + retry 统一包装）——那时 bulkhead 才落地
3. 需要多个熔断策略组合（fallback / retry / timeout 编排）——库的组合能力才体现价值

## 验证方式

- `package.json` 中**不存在** `dependencies` 字段
- 仓库内不存在 `package-lock.json`
- `node --test` 仍为 218 通过 / 0 失败（本决策未改动任何源码）

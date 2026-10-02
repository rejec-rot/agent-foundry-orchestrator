# 0005 — 否决 P3 原方案（store + tasklock 换 SQLite）；改为修补锁覆盖

- 状态：**已采纳**（否决替换，改为定向修补）
- 日期：2026-09-16
- 决策者：本仓库维护者（授权执行 V2 全计划）
- 相关：`docs/ROADMAP.md` §五 P3、`docs/MODULE-MAP.md` §1

## 背景

P3 原方案：用 `better-sqlite3` + WAL + `BEGIN IMMEDIATE` 事务替换
`lib/store.mjs`（原子文件写）+ `lib/tasklock.mjs`（文件锁），
理由是"我们为此写的 tasklock 需要处理 lease、死 PID、TOCTOU、恢复互斥；SQLite 事务一次性解决"。

按路线图原则 4「先探测再实现」核对后否决。

## 决策

**不替换。** 改为定向修补该层**真实存在的缺陷**：任务锁的**覆盖不全**（见 §四）。

## 证据

### 1. 与项目已声明的不变式直接冲突，且冲突被写在代码注释里

```
lib/store.mjs:3   // Same-filesystem rename; no database introduced (Phase 1.1 boundary)
```

```
FINAL_ARCHITECTURE.md:20   3. 零外部重依赖与全平台可移植性
```

`better-sqlite3` 是**原生模块**（需要编译 / 预编译二进制），是对"零外部重依赖"与"全平台可移植性"
最重的一次破坏——比引入一个纯 JS 依赖严重得多。这与 P1 的情形同类：**模块图能回答"有没有成熟方案"，
不能回答"该不该换"**。

### 2. "文件即真源"是安全模型的承重结构，不是实现细节

实测：**5 个测试文件直接读写 `tasks/<id>.json`**，其中一个是**篡改检测**用例：

```js
// tests/acceptance-allowlist.test.mjs ACC-6
original.acceptance_cmd = { command: 'node', args: ['--test', 'attacker-chosen.test.mjs'] };
writeFileSync(taskFile, JSON.stringify(original, null, 2));   // 改盘上文件
// 断言：调度器拒绝执行且不消耗 executor
```

这正是 `docs/PRESERVE.md` 里"验收命令静态白名单 + 内容哈希锚定"这条资产的**验证方式**：
它必须能模拟"有人改了盘上的任务文件"。把任务状态搬进数据库后，这个威胁模型无法再被这样测试，
而且 `af-admin` 的可人工检查性、崩溃点状态注入式测试（`recovery.test.mjs` 全篇）一并失效。

### 3. P3 想解决的问题，**大部分已经不存在了**

| P3 声称要解决 | 现状 |
|---|---|
| TOCTOU（陈旧锁接管双持） | ✅ 已在修复批次解决：恢复互斥 + 互斥内二次确认（`withRecoveryGuard`），有测试 |
| 死 PID / lease 失效 | ✅ 已解决：`isLockStale` 处理死 PID、畸形租约、损坏文件 |
| 续租竞态 | ✅ 已解决：原子替换 + 按所有者复核 |
| 崩溃恢复的幂等性 | ✅ 已解决且有测试（TEST H「recovering twice is idempotent」） |

换言之：**替换 sqlite 的收益建立在"手写锁不可靠"这个前提上，而这个前提在修复批次后大幅削弱**。
这与 P1 的结论同构——"翻车的真实归因"是具体缺陷，而不是"用了自研实现"。

### 4. 迁移的爆炸半径

锁语义被大量测试固定（`tests/concurrency.test.mjs` 724 行、`production-readiness.test.mjs` PROD-5 双实例隔离、
`recovery.test.mjs` TEST F/G/H），且被运维路径依赖（`readLock` 生成恢复证据、
`stale_lock_recovered` 审计字段、`af-admin` 巡检）。迁移需要重写这些断言与字段语义——
违反路线图原则 1「不许倒退测试」。

## 四、改为修补的真实缺陷：锁覆盖不全

**实测**：`approval/intent-gate.mjs` 中 `acquireTaskLock` **命中为 0**，但它通过 `persistTaskCapsule`
→ `saveTaskWithVersion` **写入任务生命周期状态**（`approveIntent` / `rejectIntent` / `alignTaskIntent`）。

而调度器在派发时会**持有**同一任务锁直到运行结束（`lib/scheduler.mjs` 441 取得、465/484/591 释放）。

后果：**两个写者操作同一任务文件且无互斥** —— 典型的丢失更新（lost update）。
调度器用自己的内存副本 `#save()`，会静默覆盖期间发生的人工审批；反之亦然。
这正是 P3 想要的那一类问题（并发写同一份状态），但**不需要数据库就能修**。

**修法**：让 intent-gate 的三处写入持有**与调度器相同的任务锁**，
并把锁冲突以明确错误暴露给操作员（而不是静默覆盖）。

## 后果

- 正面：未引入原生依赖；`FINAL_ARCHITECTURE.md` 的原则 3 与 `store.mjs` 的 Phase 1.1 边界得以保持；
  227 项测试的"文件即真源"假设不被破坏；篡改检测仍可测试
- 正面：修掉了一个**真实的、当前可触发的**丢失更新缺陷，且该缺陷在 P3 原方案下同样会存在（换库不自动带来锁覆盖）
- 负面：文件存储的长期可扩展性（万级任务、复杂查询）不如数据库；若将来真的成为瓶颈，本 ADR 应被重新评估
- 负面：锁仍是按 task_id 的单一目录，未做分片

## 什么情况下应重新评估

1. 任务量或状态查询复杂度使文件扫描成为实测瓶颈
2. 维护者**主动**决定放宽"零外部重依赖"边界（那是一个产品决策，不该由一次重构顺带完成）
3. 需要跨主机的任务状态共享（文件锁的固有上限）

## 验证方式

- `package.json` 仍**不存在** `dependencies` 字段
- 新增测试证明锁覆盖已闭合：持锁期间 `approveIntent` / `rejectIntent` / `alignTaskIntent` 必须拒绝写入且不修改文件
- `node --test` 全绿且通过数只增不减（当前 227）

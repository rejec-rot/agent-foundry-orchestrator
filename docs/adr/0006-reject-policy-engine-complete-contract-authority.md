# 0006 — 否决 P4 原方案（策略外置 OPA / Cerbos）；改为补全契约权威性

- 状态：**已采纳**（否决替换，改为定向修补）
- 日期：2026-09-16
- 决策者：本仓库维护者（授权执行 V2 全计划）
- 相关：`docs/ROADMAP.md` §五 P4、`docs/MODULE-MAP.md` §5

## 背景

P4 原方案：把 `intent/action-validator.mjs` + `contracts/action-types.json` + `config/*.json` 白名单
换成成熟策略引擎（`open-policy-agent/opa` 或 `cerbos/cerbos`），理由是"动作合约/白名单本质就是策略引擎要解决的问题"。

按路线图原则 4「先探测再实现」核对后否决。

## 决策

**不替换。** 改为补全该层**真实存在的缺陷**：契约文件高估了自己的权威性（见 §四）。

## 证据

### 1. 这层不是"请求→决策矩阵"，而是"从文件系统上下文做分类 + fail-closed 升级"

规模：`action-validator.mjs` 496 行 + `asset-classifier.mjs` 372 行 + `intent-policy.mjs` 294 行 ≈ **1160 行规则**。

它实际做的是：

1. **资产分类**：从路径推断 `target_asset_type`（含 `realpathSync` 规范化以防御符号链接穿越）
2. **动作分类**：从 proposal 计算 `action_type`
3. **fail-closed 升级**：`impact.reversible` / `impact.scope` / `target.type` 缺失或非法 → 一律升级为 `WAITING_HUMAN`
4. **canonical gate 判定**：`AUTO_ALLOW` / `WAITING_HUMAN` / `DENY`

策略引擎（OPA/Cerbos/Casbin）解决的是**授权决策**：给定 subject / object / action → allow / deny。
它不会替你从**文件系统状态**推断"这个路径是不是治理文件"、也不会替你实现"字段缺失即升级"。
替换后 §1–§3 全部留下，只有 §4 那张表可以外置——**收益与风险严重不成比例**。

### 2. 部署代价与已声明的不变式冲突

| 方案 | 代价 |
|---|---|
| OPA | 需要 `opa` 工具链把 `.rego` 编译成 `.wasm`（**构建期依赖**）；或作为 sidecar 运行（违反 `FINAL_ARCHITECTURE.md` 原则 3「零外部重依赖」） |
| Cerbos | 需要独立服务进程 |
| Casbin | 纯 JS/TS、可进程内运行，但它是授权决策引擎，**无法覆盖上述 §1–§3**（见 §1 的分析） |

与 P1（断路器换库）、P3（换 SQLite）同构：**"有成熟方案"不等于"该换"**。

### 3. 为什么"外置策略"解决不了本层的真实问题

本层的问题不在**决策引擎**，而在**真源没有被读取**（见 §四）。把策略搬到 Rego/YAML 里，
如果加载路径仍然是半接线状态，同样会漂移——换引擎不会自动修复"声明与实现不一致"。

## 四、真正修补的缺陷：契约高估了自己的权威性

`FINAL_ARCHITECTURE.md:18` 宣称 `contracts/action-types.json` 是"动作白名单唯一真源"。
该文件声明了**四个**列表，而实测：

| 契约列表 | 修复前是否被读取 | 真正的真源位置 |
|---|---|---|
| `action_types` | ✅ 读取 | 契约文件 |
| `target_asset_types` | ❌ **0 次** | 硬编码 `intent/asset-classifier.mjs:47` |
| `impact_scopes` | ❌ **0 次** | 硬编码 `intent/asset-classifier.mjs:57` |
| `gates` | ❌ | 硬编码 `intent/action-validator.mjs:48` |

即：**前面一次修复只修了四分之一**（当时修的是 `action_types`），另三个列表仍是硬编码副本，
契约与它的执法者可以静默漂移，而架构文档仍指向该文件为唯一真源。

### 特别危险的一种情形：**部分缺失**的契约会 fail-OPEN

由空列表派生枚举会得到 `{}`，于是

```js
required_gate === GATE_VERDICTS.WAITING_HUMAN   // undefined === undefined → false
```

即"契约缺 `gates` 但 `action_types` 完好"时，schema 校验能通过，而 gate 判定**静默变成不放行也不升级**。
这正是一个 fail-open 路径。

## 已实施的修复

1. 新增 `intent/action-contract.mjs`：**唯一**读取契约的模块，一次性读出全部四个列表
2. `asset-classifier.mjs` / `action-validator.mjs` 的硬编码枚举改为从契约派生并**保持原有枚举对象形态**
   （108 处引用、含 40 处测试断言不受影响）
3. **显式 fail-closed 守卫**：`isActionContractUsable()` 要求四个列表**齐备且非空**；
   `validateAndComputeEffectiveAction` 在不可用时**抛 `ACTION_CONTRACT_UNUSABLE` 拒绝决策**，
   而不是拿空枚举去做比较
4. 新增可测入口：`AF_ACTION_CONTRACT` 允许指向另一份契约（用于部署固定，也让 fail-closed 路径可端到端测试）
5. 新增 `tests/action-contract-authority.test.mjs` ACA-1..ACA-5，含**漂移守卫**：
   禁止在执法模块里重新出现这些枚举的硬编码定义

**验证**：
- ACA-2/ACA-4 覆盖部分缺失 → 拒绝决策（端到端：子进程指向部分契约，断言 `THREW:ACTION_CONTRACT_UNUSABLE`）
- ACA-3 有牙：把硬编码副本塞回 `asset-classifier.mjs` 后，测试**精确点名文件与变量**报红
- `node --test`：237 通过 / 0 失败（原 232）

## 后果

- 正面：契约不再是"自称的真源"，而是**被读取的真源**；四个列表齐备性成为机器校验的性质
- 正面：关闭了一个 fail-open 路径（部分缺失契约）
- 正面：未引入任何依赖，`package.json` 仍无 `dependencies`
- 负面：契约成为模块加载期的硬依赖；契约损坏会**拒绝所有任务**（这是有意为之的 fail-closed，但运维需知道
  `ACTION_CONTRACT_UNUSABLE` 的含义）
- 负面：策略仍不能由非工程师以 Rego/YAML 直接改写（那需要另一套设计，见下）

## 什么情况下应重新评估

1. 出现**非工程师需要独立改写策略**的需求（那是产品需求，不是重构）
2. 策略规则增长到 `action-validator` 难以维护的规模（当前 ~500 行，尚未到）
3. 维护者**主动**决定放宽零外部重依赖边界

## 验证方式

- `package.json` 仍无 `dependencies`
- 契约的四个列表各有测试断言其来自文件（ACA-1）
- 部分缺失契约被拒绝（ACA-2）且端到端拒绝决策（ACA-4）
- `node --test` 全绿且通过数只增不减

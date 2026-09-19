# 第八轮评审意见：对 v5.1 补丁的工程可行性复审（Engineering Realism Review）

> **性质**：对第七轮「v5.1 Soundness Patch」的对抗性工程复审意见书。
> **目的**：供双方对齐——在保持核心形式化安全模型不变的前提下，消除学术化假设带来的 7 处工程断崖，使设计真正具备可实现性。
> **上游**：`TRUSTED-IMPORT-ROUND-07-V5_1-SOUNDNESS-PATCH.md`、`WRITE-SCOPE-ENFORCEMENT.md`（v5.1）。

---

## 0. 总评：理论闭合非常精彩，但存在若干“工程断崖”

第七轮推演直击了此前状态机时序倒置（`SNAPSHOT → SCAN`）、提升目标树排除文件丢失（`Target Tree` 补丁）以及 A6 路径契约等深水区漏洞，数学与逻辑上的严密性极高。

然而，该方案明显建立在**“评测集/沙盒比赛（Benchmark）”的理想化假设**之上。一旦将其放入**真实软件仓库、现代构建生态（Node/npm/Git）以及 Agent 实际交互工作流**中，会立即触发 7 个致命的“工程断崖”，甚至导致系统无法正常工作。

以下是具体的断崖分析与改进建议。

---

## 1. 七大工程断崖与修正提案

### 1.1 断崖一：`synthetic_dirs` 子项必扫将引发“构建产物风暴”

* **v5.1 提案**：扫描器绝不可跳过合成目录，执行器在 `dist/`、`tmp/` 下写入的任何子条目必须全量进入 FS 扫描并产生 `ADD` 差异。
* **真实工程矛盾**：
  * 真实项目中执行器常常需要执行 `npm run build`、`cargo build` 或生成临时测试报告。
  * 构建工具会合法地在 `dist/` 中吐出几百上千个编译后的 `.js`、`.map` 文件。
  * 若扫描器一律视作 `ADD dist/...`，将造成：① 瞬间向 CAS 灌入海量无用构建垃圾；② 触发条目数配额拒绝；③ Scope Gate 会判定这数百个编译文件“未经授权”而全部抛出 **DENY 越权报警**。
* **修正方案（区分 Scratch 目录与 Source 目录）**：
  * 物化策略必须明确区分两种目录：
    1. **Source Synthetics（源码合成目录）**：属于代码树的一部分，子条目必须全扫全检；
    2. **Runtime Scratch Dirs（运行时暂存目录，如 `/tmp/`, `var/cache/`）**：定义为隔离的丢弃型挂载区，**物理独立于 candidate 源码树，不参与扫描，不进 manifest**。
  * `dist/` 若为构建产物，应通过 `.gitignore` 或专用构建挂载处理，不能把运行时丢弃目录与源码目录混为一谈。

---

### 1.2 断崖二：`Trusted Acceptance Assets` 脱离绝大多数开发场景

* **v5.1 提案**：Candidate 内的测试不可信，门禁验收必须由控制面从外部挂载只读的“受信任测试套件（`/trusted-acceptance/`）”。
* **真实工程矛盾**：
  * **典型的 LeetCode / 评测基准思维**。在日常实际开发中，99% 的普通工程，单元测试和集成测试就位于仓内（`tests/`、`__tests__/`）。现实中开发者不会、也没成本在仓外为每个日常需求维护独立测试集。
  * **任务类型冲突**：如果用户的 prompt 本身就是*“为用户模块编写单元测试”*或*“根据新需求更新过期用例”*，按照“仓内测试不可作为门禁依据”，系统将根本无法评估任务是否完成。
* **修正方案（基线测试快照锚定）**：
  * 当缺乏外部测试套件时，允许以**仓内既有测试**作为门禁，但机制必须是：
    * **门禁测试严格以 Baseline Canonical Tree 中的测试套件快照为准**；
    * 验收时，以只读方式挂载 **Baseline 中的测试文件**去跑 Candidate 中的业务代码；
    * 若当前任务明确被授予了 `write_set: [tests/**]`，则将测试改动交由 **Content Reviewer（评审者）专门重点审查**，形成“评审签名 + 测试通过”的组合凭证。

---

### 1.3 断崖三：Staging 依赖空洞——`node_modules` 丢了，测试根本跑不起来

* **v5.1 提案**：`Promotable Acceptance View = Projected Baseline + Authorized Patch + Synthetic Dirs`，Staging 仅由 Git 规范树与补丁派生。
* **真实工程矛盾**：
  * 第三方依赖（`node_modules/`、`vendor/`、Python `venv/`）在正常仓库中均被 `.gitignore` 忽略，**根本不存在于 Canonical Git Tree 中**！
  * 如果 Staging 纯粹只从 Git 基准和授权补丁物化，Staging 目录中**没有任何运行依赖**。
  * 启动验收容器执行 `npm test`，必然瞬间抛出 `jest: command not found` 或 `Cannot find module 'express'`，测试全部直接暴毙。
* **修正方案（只读依赖层注入）**：
  * 引入 **受信任依赖缓存层（Trusted Dependency Fixture / Read-Only Layer）**；
  * 控制面必须将宿主或环境中的依赖缓存目录（如校验过的 `node_modules`）以**只读模式（RO bind mount）**注入 Staging 验收容器，或在 Staging 隔离沙箱中由受信任 harness 执行安全的受限 install。

---

### 1.4 断崖四：一刀切禁用 `projection.redact` 过于消极（破坏真实任务可用性）

* **v5.1 提案**：因为 JSON 等行内脱敏缺乏逆变换语义，V1 彻底禁用 `projection.redact`，敏感文件一律整文件排除。
* **真实工程矛盾**：
  * 现实中极少有“纯秘密文件”。绝大多数项目是混合配置（如 `config.json`、`app.config.ts`），其中 90% 是普通开发配置（端口、日志级别、超时时间、功能开关），仅 10% 是敏感 token。
  * 一旦整文件排除，Agent **既看不到也改不了**该文件。如果用户要求*“把端口从 8080 改为 3000”*，Agent 会因为文件被排除而无法执行，任务直接失败。
* **修正方案（环境覆盖优先于源码占位）**：
  * 保持“不进行不可逆的行内字符串替换（如 `***`）”的正确原则；
  * 但解决方案不是粗暴排除整个配置文件，而是**配置解耦与环境变量重定向（Env Override Pattern）**：
    * 规范仓库的最佳实践，促使应用通过 `process.env` 读取秘密；
    * 在 candidate 中提供合法的 `mock / development` 完整配置文件（通过 projection synthesize 覆盖整个文件），让模型自由修改非敏感结构，而非让核心配置文件彻底失联。

---

### 1.5 断崖五：Pre-acceptance 强阻断导致 Agent 陷入“盲人修车”

* **v5.1 提案**：存在任何未解决的 DENY 项时，直接阻断验收执行（`REVISION NOT ACCEPTABLE`）。
* **真实工程矛盾**：
  * 假设 Agent 修改了 5 个核心业务文件，同时不小心误碰了一个受限的底层配置被判 DENY。
  * Agent 此时极度依赖“跑测试”来了解自己的业务代码改对了没有、是否有语法或逻辑报错。
  * 如果一刀切彻底禁止运行任何测试，Agent 只能在没有编译器/测试框架反馈的情况下“盲改”，修复死锁率极高。
* **修正方案（门禁阻断与诊断运行解耦）**：
  * 明确分离 **Promotion Gating Acceptance（提升门禁验收）** 与 **Diagnostic Dry-run（沙箱诊断运行）**：
    * 存在 unresolved DENY 时，**绝对禁止触发最终提升（Promotion Blocked）**，这保证了安全 invariant；
    * 但**允许在临时沙箱中运行不持密的 Diagnostic 单元测试**，将被拒文件临时隔离，将真实的测试失败堆栈反馈给 Agent，让其具备自愈（Remediation）的调试抓手。

---

### 1.6 断崖六：树级命名空间碰撞（File vs Directory 冲突）

* **v5.1 提案**：`Target Tree = Baseline Tree + Authorized Patch`，未暴露的文件原样继承。
* **真实工程矛盾**：
  * 假设 Baseline 包含受保护文件 `secret/key.pem`（即存在目录 `secret`）。
  * Projection 排除了 `secret/**`，因此 Candidate 中没有任何 `secret` 的痕迹。
  * 执行器在 Candidate 中新建了一个**普通文件**，名字恰好叫 `secret`。
  * 提升阶段合并时：Baseline 坚持 `secret` 是 Git Tree（目录），而补丁要求 `secret` 是 Git Blob（普通文件）。
  * **Git 底层对象合并会直接发生 `ENOTDIR` 命名空间冲突并崩溃报错**。
* **修正方案（合并前结构冲突预检）**：
  * 在 Mechanical Gate 中新增**命名空间碰撞规则（Type Collision Check）**：
    * 任何 candidate 新增路径，若其任意祖先路径与 baseline 中被隐藏的路径存在“文件/目录类型冲突”，立即判为 **B(i) 结构冲突硬拒**。

---

### 1.7 断崖七：A6 路径契约的 Unicode NFC 导致 macOS 仓库准入误杀

* **v5.1 提案**：所有路径必须严格是 Unicode NFC 规范化形式，否则准入扫描与 Capture 阶段直接 B(i) 拒绝。
* **真实工程矛盾**：
  * macOS 文件系统（HFS+/APFS）默认强制将文件名分解为 **NFD（Canonical Decomposition）**。
  * 如果一个既有项目曾有团队成员在 Mac 上提交过含中文、日文或带重音符号的文件名，这些文件名在 Git commit 中就是 NFD 编码的。
  * `afr adopt` 在第一步执行 Canonical Admission Scan 时，会直接将这类合法的历史开源仓判定为违规，导致**完全无法接管正常的跨平台项目**。
* **修正方案（透明归一化而非粗暴拒绝）**：
  * 控制面在扫描与准入阶段遇到合法 UTF-8 的 NFD 路径时，执行**自动透明转码（Transparent Normalization to NFC）**，或者允许底层按原始 Git 字节处理，仅在策略匹配时规范化比对，避免直接 fail-closed 误伤无辜仓库。

---

## 2. 结论与下一步

第七轮提出的 **v5.1 状态机骨架与数学公式是正确的**。本轮意见并非推翻 v5.1，而是补齐上述 7 处在真实运行环境下的工程实现语义：

1. **运行时目录**：明确区分丢弃型 Scratch 与源码型 Synthetics；
2. **测试资产**：落实仓内基线测试快照保护机制；
3. **环境物化**：补齐 Staging 依赖层的只读注入；
4. **修复活性**：解耦提升阻断与沙箱诊断运行；
5. **底层兼容**：补足 Git 命名空间类型冲突检测与 macOS NFD 路径兼容。

将这 7 点工程落地补丁并入后，v5.1 方能从“论文级完备”进化为“生产级可用”。

# AFR 写入范围约束与受信导入架构评审建议

> 本文基于 `DESIGN-BRIEF-FOR-REVIEW.md` 的现有问题定义与约束，对 AI 编码 agent 的写入范围控制、越界裁决、候选产物回流和信任边界进行架构评审。
>
> 核心建议：不要把“回拷”视为普通文件复制问题，而应将其升级为系统的核心安全原语——**不受信执行器只产生候选文件系统（candidate tree），唯一有资格修改受信工作区的是 Trusted Importer。**

---

## 1. 评审结论

现有设计中的以下原则建议继续保留：

- planner 声明任务写入范围（write set）；
- write set 进行哈希锚定；
- 机械规则优先于模型裁决；
- scope verifier 独立于 planner / author；
- scope verifier 只判断“范围是否必要”，不做内容质量评审；
- 无合格独立 verifier 时 fail-closed 到人工门；
- 控制面、提权、越界路径等进入硬拒绝或人工门；
- acceptance command 继续保持现有的静态白名单与哈希锚定机制。

但建议重新定义整体安全模型：

> **Executor 不是 canonical workspace 的 writer。**
>
> **Executor 只是 candidate filesystem / patch producer。**
>
> **Trusted Importer 才是 canonical workspace 的唯一 writer。**

因此，不建议把方案 C 实现成：

```text
host workspace
     ↓ copy
docker volume
     ↓ agent 修改
docker volume
     ↓ 检查
cp -a 回 host
```

建议改成：

```text
                TRUSTED DOMAIN
┌────────────────────────────────────────┐
│ canonical workspace                    │
│ task state / contracts / policies      │
│                                        │
│  snapshot/export                       │
└──────────────┬─────────────────────────┘
               │
               ▼
          baseline tree
               │
════════════ TRUST BOUNDARY ═════════════
               │
               ▼
┌────────────────────────────────────────┐
│ disposable candidate workspace         │
│                                        │
│ executor / claude / codex / ...        │
│                │                       │
│                ▼                       │
│          candidate tree                │
└──────────────┬─────────────────────────┘
════════════ TRUST BOUNDARY ═════════════
               │
               ▼
        Trusted Diff Scanner
               │
        candidate_manifest
               │
               ▼
        Scope Policy Engine
        ┌──────┼─────────┐
        │      │         │
      allow  verifier   deny
        │
        ▼
       Trusted Importer
        │
        ▼
 canonical workspace
```

核心安全属性变为：

```text
candidate compromise
       ≠
trusted workspace compromise
```

Executor 可以任意破坏自己的 candidate tree，但不能直接影响受信工作区。

---

## 2. 不再把“回拷”当作普通复制

原设计中最危险的实现倾向，是：

```text
cp -a candidate/* → host workspace
```

即使在复制之前做检查，这种模式仍然容易产生复杂的：

- symlink traversal；
- hard link；
- 路径穿越；
- 特殊 inode；
- xattr / capability；
- 权限位继承；
- TOCTOU；
- 大文件 / 海量文件；
- `.git/hooks` 等宿主触发面。

因此建议废弃“copy-back”作为核心抽象。

更准确的抽象是：

```text
candidate tree
    ↓
trusted diff
    ↓
manifest
    ↓
policy decision
    ↓
import capability
    ↓
trusted importer
```

**验证结果本身应成为导入 capability，而不是“检查通过后再复制整个目录”。**

---

# 3. 三种不同的信息必须拆开

当前的 `outside_manifest` 概念容易混合三个完全不同的问题。

建议拆成：

```text
candidate_manifest
requested_scope_expansion
denied_write_events
```

---

## 3.1 candidate_manifest

这是安全系统中的**事实来源**。

它不能由 executor 自报，而必须由受信侧根据：

```text
trusted baseline
vs
untrusted candidate tree
```

计算。

示例：

```text
ADD       src/foo.ts
MODIFY    package.json
DELETE    src/old.ts
MODE      scripts/build.sh 0644 -> 0755
SYMLINK   foo -> ../../xxx
```

因此：

> executor 无权决定 candidate_manifest 中出现什么。

它只负责产生 candidate tree。

---

## 3.2 requested_scope_expansion

这是 agent 的**申请**，例如：

```json
{
  "requested_paths": [
    "package.json",
    "scripts/build.js"
  ],
  "reason": "需要增加构建依赖并修改构建脚本",
  "evidence": "当前任务要求新增某功能"
}
```

这里的信息可以是不可信的。

原因是：

> **申请不需要可信，批准才需要可信。**

Executor 或 planner 即使错误、夸大甚至恶意申请某路径，也不会直接获得写权限。

最终由独立 scope verifier 判断：

```text
“修改这个路径是否是完成当前任务所合理必要的？”
```

---

## 3.3 denied_write_events

如果采用：

```text
host workspace = read-only
declared write set = individual rw mount
```

那么 agent 可能得到：

```text
openat("package.json", O_WRONLY)
→ EROFS
```

这类事件可以记录，但建议只作为：

- debug 信息；
- planner scope 质量分析；
- agent 行为诊断；
- 后续优化数据。

不要把它作为安全真源。

否则系统很容易滑向：

```text
ptrace
fanotify
audit
seccomp notify
eBPF
```

复杂度会显著上升。

原则应该是：

> **不要试图证明 agent “想写什么”。**
>
> **只证明 agent 实际产出了什么 candidate state。**

---

# 4. `outside_manifest` 的可信获取方式

原问题是：

> executor 自报不可信，但如果依赖容器侧 diff，又似乎提前引入方案 C。

这个判断是成立的。

如果真实宿主工作区整体只读，声明目录单独 rw：

```text
workspace RO
+
write-set subdirectories RW
```

那么越界写已经被文件系统拒绝。

因此不存在“越界后留下来的实际文件”可以供 diff。

要得到完整、可信的实际修改集合，最自然的方式就是：

```text
baseline tree
    ↓
copy/snapshot
    ↓
candidate tree
    ↓
executor freely modifies candidate
    ↓
trusted diff
```

因此建议接受一个结论：

> **可信 candidate_manifest 本身就意味着至少引入方案 C 的一部分。**

不需要把这视为设计失败。

相反，它说明：

**candidate workspace 应当成为正式架构元素，而不是临时 workaround。**

---

# 5. Scope Approval 的生命周期

不建议 approval：

```text
绑定单次 executor run
```

也不建议：

```text
绑定整个 TASK 生命周期
```

推荐绑定一个明确的 **scope revision**。

一个 Scope Grant 至少锚定：

```text
task_id
plan_revision
baseline_digest
scope_revision
approved_write_set
policy_digest
```

例如：

```json
{
  "task_id": "TASK-123",
  "plan_rev": 4,
  "baseline": "sha256:...",
  "scope_rev": 2,
  "write_set": [
    "src/foo/**",
    "tests/foo/**"
  ],
  "policy": "sha256:..."
}
```

这样可以做到：

```text
author
  ↓
review
  ↓
fix
  ↓
review
```

只要以下内容均未变化：

- plan revision；
- baseline；
- write set；
- policy；

则整个 fix 循环可以复用同一个 scope grant。

但只要出现：

```text
plan changed
OR
baseline changed
OR
scope expanded
OR
policy changed
```

就立即：

```text
invalidate grant
```

重新裁决。

因此更准确的规则是：

> **Scope approval 应绑定一个 scope revision，而不是绑定单次 executor revision，也不是绑定整个 task。**

---

# 6. 将“四带漏斗”重写成 Candidate Import Pipeline

原设计的四带思想仍然成立。

但建议从：

```text
“某次文件写入能不能发生”
```

转换为：

```text
“某个 candidate change 能不能进入 canonical workspace”
```

新的流程：

```text
candidate diff
      │
      ▼
mechanical classifier
      │
 ┌────┴─────────┐
 │              │
IN_SCOPE     OUT_OF_SCOPE
 │              │
 │        ┌─────┴─────┐
 │        │           │
 │    HARD_DENY    VERIFIER
 │                    │
 └───────────┬────────┘
             ▼
       import manifest
             ▼
       Trusted Importer
```

映射到原四带：

### A：声明内

```text
change.path ∈ approved write set
```

机械放行。

不调用模型。

---

### B(i)：硬拒绝

任何确定性危险项立即拒绝。

永远不上模型。

---

### B(ii)：机械越界放行

保持为空。

即：

> **任何未声明写入都不会因为“看起来没问题”而被机械放行。**

---

### C：真实 scope expansion

只有以下情况进入独立 scope verifier：

```text
outside declared scope
AND
not mechanically forbidden
```

由 verifier 判断：

```text
“这个范围扩张是否被任务目标合理要求？”
```

---

### D：控制面 / 提权

继续进入人工门。

例如：

```text
tasks/**
contracts/**
runtime/**
lib/**
orchestrator policy
executor safety config
privilege / ownership / host integration
```

---

# 7. Verifier 的职责边界

这一点原设计方向正确，应继续强化。

Scope verifier 不是 planner，也不是 content reviewer。

它只回答：

> **“修改 X 是否属于完成任务 T 的合理必要范围？”**

它不回答：

> “修改后的 X 写得好不好？”

也不回答：

> “代码质量是否合格？”

更不能让 planner 同时：

```text
申请 scope
+
批准 scope
```

否则就形成：

```text
applicant == approver
```

同时 executor 输出还可能通过上下文重新进入 planner，产生提示注入和利益一致性问题。

因此推荐继续维持：

```text
planner
    │
    └─ proposes scope

executor
    │
    └─ produces candidate

scope verifier
    │
    └─ approves / denies scope expansion

content reviewer
    │
    └─ judges implementation quality

trusted importer
    │
    └─ applies approved bytes
```

四个职责不要合并。

---

# 8. Verifier 负载问题

Verifier 是否成为瓶颈，不是一个固定事实，而是由漏斗设计决定。

理想情况下：

```text
大部分变化
→ A：机械允许

明显危险变化
→ B(i)：机械拒绝

普通越界写
→ 不自动放行

只有真正的范围扩张
→ C：verifier
```

再加上：

> **每个 run / candidate revision 对整份 scope expansion 批量裁决一次。**

而不是：

```text
改一个文件
→ 问一次 verifier

再改一个
→ 再问一次
```

则 verifier 的输入会非常小。

它不需要承担内容评审，也不需要最强模型。

---

# 9. 实际最容易崩掉的环节：Write Set 可用性

相比 verifier 本身，实际更容易出现的问题是：

> planner 对任务所需写入范围预测不足。

例如 planner 声明：

```text
src/auth/**
tests/auth/**
```

实际 agent 工作中发现还必须修改：

```text
package.json
config/routes.json
src/common/types.ts
```

如果这种情况频繁发生，就会形成：

```text
agent
→ scope不足
→ request
→ verifier
→ restart / resume
→ 又发现一个路径
→ request
→ ...
```

系统在安全上正确，但开发体验严重下降。

因此建议把 planner 的 scope 声明从单一列表扩展为：

```yaml
required:
  - src/auth/**

anticipated:
  - tests/auth/**
  - package.json

forbidden:
  - .git/**
  - tasks/**
  - runtime/**
```

语义：

### required

Planner 确信任务需要。

进入 initial approved write set。

### anticipated

Planner 认为可能需要，但并不自动获得权限。

如果 agent 后续申请这些路径：

- verifier 可以看到 planner 事前已经预测过；
- 判断成本下降；
- 仍然保持独立批准。

### forbidden

Planner / policy 已知不应该进入的区域。

不过最终硬拒绝仍然应由受信 policy 定义，而不是依赖 planner。

---

# 10. B(i) 硬拒绝清单需要扩充

当前已有：

```text
控制面路径
realpath escape
..
absolute path
symlink
executable
setuid
size limit
```

建议扩充为：

| 类别 | 建议 |
|---|---|
| `..` 路径逃逸 | HARD DENY |
| absolute path | HARD DENY |
| destination escape | HARD DENY |
| symlink traversal | HARD DENY |
| 新 symlink | 默认 DENY |
| hard link | 默认 DENY / materialize |
| device node | HARD DENY |
| FIFO | HARD DENY |
| UNIX socket | HARD DENY |
| setuid | HARD DENY |
| setgid | HARD DENY |
| Linux file capabilities | HARD DENY |
| security xattrs | HARD DENY |
| ACL / xattr inheritance | 清除 |
| uid/gid ownership | 导入时重置 |
| executable bit 新增 | policy/scope gate |
| mount crossing | HARD DENY |
| 控制面路径 | HARD DENY |
| 单文件大小超限 | HARD DENY |
| 总逻辑字节超限 | HARD DENY |
| 总磁盘块超限 | HARD DENY |
| 文件数量超限 | HARD DENY |
| 路径长度超限 | HARD DENY |
| 目录深度超限 | HARD DENY |
| case collision | HARD DENY |
| Unicode/path normalization collision | HARD DENY |

---

# 11. Hard Link 不应被忽视

不能只防 symlink。

如果 importer 原样保留攻击者构造的 inode relationship，仍可能引入异常行为。

简单原则：

> **所有普通文件进入 canonical workspace 时，都应创建新的 inode。**

也就是说：

```text
candidate inode
    ≠
trusted destination inode
```

因此不建议：

```text
cp -a
```

也不应 preserve hardlinks。

Importer 应读取被批准的文件内容，再创建新的受信文件。

---

# 12. 不应继承不受信 metadata

建议 Trusted Importer 只允许导入：

```text
regular file bytes
directory structure
explicitly approved mode bits
```

默认不继承：

```text
uid
gid
ACL
xattr
security.capability
setuid
setgid
special inode
device node
socket
FIFO
```

因此 importer 的行为应该更接近：

```text
decode approved object
→ create new destination
→ write bytes
→ apply sanitized metadata
```

而不是：

```text
preserve source filesystem object
```

---

# 13. TOCTOU 是 Importer 的关键威胁

不要把安全模型建立在：

```text
realpath(path)
check(path)
copy(path)
```

上。

因为存在：

```text
CHECK
  ↓
untrusted filesystem changes
  ↓
USE
```

即典型 TOCTOU。

在 Linux 上，Importer 应尽量采用：

```text
directory-fd-relative traversal
```

并结合类似：

```text
openat2()
RESOLVE_BENEATH
RESOLVE_NO_SYMLINKS
RESOLVE_NO_XDEV
```

这一类机制限制解析。

因此：

```text
realpath validation
```

可以保留为额外检查。

但真正的 security boundary 应当是：

```text
fd-relative traversal
+
no symlink traversal
+
no root escape
+
no cross-mount
+
new destination inode
```

---

# 14. 建议正式定义五个安全对象

建议 AFR 把下面五个对象提升为正式架构概念。

---

## 14.1 Baseline

受信工作区在执行开始时的确定状态。

至少应有：

```text
baseline_digest
```

用于后续：

- diff；
- stale detection；
- import validation；
- approval binding。

---

## 14.2 Candidate

完全不受信、允许 executor 任意修改的文件树。

原则：

```text
candidate may be destroyed
candidate may contain malicious objects
candidate may contain nonsense
```

都不影响 trusted domain。

---

## 14.3 Change Manifest

由受信侧计算：

```text
Baseline → Candidate
```

之间的差异。

它描述：

```text
ADD
MODIFY
DELETE
MODE
TYPE CHANGE
...
```

并对相关内容做哈希。

---

## 14.4 Scope Grant

独立 scope policy / verifier 对某个范围做出的授权。

Grant 必须绑定：

```text
task
plan revision
baseline
scope revision
policy
approved paths
```

不能成为一个无限期 reusable token。

---

## 14.5 Import Transaction

受信侧把已经批准的 manifest 应用到 canonical workspace。

必须满足：

```text
all-or-fail
```

或者至少具备：

```text
recoverable transaction journal
```

防止 importer 中途崩溃后留下半应用状态。

---

# 15. Manifest 应成为真正的授权对象

不要：

```text
批准整个 candidate filesystem
```

应该：

```text
批准 candidate manifest
```

示例：

```json
{
  "task_id": "TASK-123",
  "baseline": "sha256:BASE",
  "candidate": "sha256:CANDIDATE",
  "scope_rev": 3,
  "policy": "sha256:POLICY",
  "changes": [
    {
      "op": "modify",
      "path": "src/auth/login.ts",
      "before": "sha256:OLD",
      "after": "sha256:NEW",
      "mode": "0644"
    },
    {
      "op": "add",
      "path": "tests/auth/login.test.ts",
      "after": "sha256:XXX",
      "mode": "0644"
    }
  ]
}
```

最终 importer 不读取“整个 candidate 是否看起来安全”。

它只执行：

```text
manifest 中明确批准的 entry
```

---

# 16. Trusted Importer 的执行前校验

在真正应用之前，至少重新确认：

```text
current baseline == manifest.baseline
candidate blobs == manifest hashes
scope grant still valid
policy digest unchanged
task state permits import
```

即：

```text
baseline still == BASE
candidate bytes still == AFTER hashes
policy still == policy_digest
scope grant still active
```

任何一项变化：

```text
FAIL CLOSED
```

重新生成 manifest / 重新裁决。

这和现有 acceptance command 的“三点锚定”设计哲学保持一致。

---

# 17. Importer 写入方式

不要直接覆盖目标文件。

建议：

```text
1. open trusted destination parent by fd
2. verify expected current state
3. create temporary sibling file
4. write approved bytes
5. fsync(temp)
6. sanitize/apply approved mode
7. atomic rename
8. fsync(parent)
```

对于删除：

```text
verify before hash
→ unlinkat trusted fd
```

对于目录：

```text
mkdirat
```

始终保持：

```text
trusted directory fd
+
relative path
```

而不是从不受信字符串重新进行任意绝对路径解析。

---

# 18. 建议的系统 invariant

最终建议把下面这条写进架构规范：

> **No model-facing component may directly mutate the canonical workspace.**

展开为：

```text
executor
planner
content reviewer
scope verifier

NONE OF THEM

has a filesystem path capable of directly modifying
the canonical workspace.
```

即使 scope verifier 也不写文件。

它只能输出：

```text
decision
```

最终：

```text
Trusted Importer
```

是唯一 writer。

---

# 19. UID 分离在新模型中的位置

在这个模型下：

```text
dedicated executor UID
```

仍然有价值。

但是它从：

```text
安全模型成立的前提
```

降级为：

```text
defense in depth
```

这非常重要。

也就是说：

即使某台机器由于现实约束暂时做不到：

```text
control plane UID
!=
executor UID
```

只要 executor 无法直接接触 canonical workspace，而只能操作 disposable candidate，则主安全模型仍然成立。

未来部署到可以 root 配置的环境时，再增加：

```text
dedicated af-exec UID
control-plane ownership
0700 control files
```

作为第二层隔离。

---

# 20. 推荐最终命名

不建议将这一机制命名为：

```text
copy-back
回拷
safe-copy
```

因为这些名字天然让实现者想到：

```text
cp
rsync
tar
```

更建议命名为：

```text
trusted-importer
```

或：

```text
workspace-import-gate
```

推荐：

```text
trusted-importer
```

因为它准确表达：

> 这是一个跨越 trust boundary 的受控导入器。

而不是普通文件同步工具。

---

# 21. 推荐最终数据流

完整的数据流建议如下：

```text
Task
 │
 ▼
Planner
 │
 ├── plan_revision
 ├── required_write_set
 └── anticipated_write_set
 │
 ▼
Scope Anchor
 │
 ▼
Baseline Snapshot
 │
 ▼
Candidate Workspace
 │
 ▼
Executor
 │
 ├── candidate changes
 └── scope expansion requests
 │
 ▼
Trusted Diff Scanner
 │
 ▼
Candidate Manifest
 │
 ▼
Mechanical Policy
 │
 ├── A: in scope ───────────────┐
 │                              │
 ├── B(i): hard deny → reject   │
 │                              │
 └── C: scope expansion         │
          │                     │
          ▼                     │
     Scope Verifier             │
          │                     │
    approve / deny              │
          │                     │
          └─────────────────────┤
                                ▼
                         Import Manifest
                                │
                                ▼
                        Trusted Importer
                                │
                                ▼
                      Canonical Workspace
                                │
                                ▼
                        Content Reviewer
                                │
                          fix loop if needed
```

内容 reviewer 也可以根据现有 AFR 生命周期放在 import 前进行 candidate review。

关键不在 reviewer 的具体前后顺序，而在于：

> **任何模型角色都不能成为 trusted filesystem writer。**

---

# 22. 与现有 AFR 设计的关系

本建议不是推翻现有设计。

保留：

```text
dynamic ROLE != PLATFORM
independent reviewer
acceptance command whitelist
acceptance command hash anchor
file-as-source-of-truth
atomic state write
task lock
crash recovery
manual circuit-breaker admit
fail-closed verifier
```

主要改变的是一个核心安全抽象：

原来：

```text
如何限制 executor 在 workspace 中能写什么？
```

改为：

```text
如何允许不受信 executor 产生任意 candidate，
但只有被授权的变更能够进入 canonical workspace？
```

后一种模型通常更容易：

- 证明；
- 测试；
- fuzz；
- 审计；
- 恢复；
- 扩展到不同 executor；
- 与未来专用 UID 隔离结合。

---

# 23. 最终建议

AFR 后续实现建议围绕下面这条原则收敛：

> **Executor 可以任意破坏自己的 candidate。**
>
> **它唯一做不到的，是让一个未经 Trusted Importer 授权的字节进入 canonical workspace。**

因此：

```text
write set
hash anchoring
mechanical deny
scope verifier
manual gate
UID separation
Docker isolation
```

都应成为这个核心 invariant 周围的辅助机制。

最终安全边界不是：

```text
“agent 是否越界写过”
```

而是：

```text
“未经批准的变化是否有任何路径进入 canonical workspace”
```

只要答案始终是：

```text
NO
```

这个架构的安全模型就是清晰、可验证且可以持续演进的。

---

## 24. 建议下一步实现顺序

### Phase 1 — Candidate / Manifest 原型

实现：

```text
baseline snapshot
candidate workspace
trusted diff
candidate_manifest
```

先不做 verifier。

验证：

```text
所有实际变化都能被准确描述
```

---

### Phase 2 — Mechanical Import Gate

实现：

```text
write set matching
hard deny
metadata sanitization
size/count limits
```

确保：

```text
manifest 中不允许的 entry 永远无法 import
```

---

### Phase 3 — Trusted Importer

实现：

```text
fd-relative path traversal
new inode creation
hash re-validation
atomic replacement
transaction / recovery
```

此阶段完成后，安全模型主体成立。

---

### Phase 4 — Scope Verifier

只把：

```text
outside declared scope
AND
not hard-denied
```

送给独立 verifier。

实现：

```text
one decision per candidate revision
structured decision
evidence
scope grant
```

---

### Phase 5 — Defense in Depth

部署环境允许时增加：

```text
dedicated af-exec UID
control-plane ownership separation
stricter Docker profile
resource limits
network policy
```

但这些不再是 Trusted Import 模型成立的前置条件。

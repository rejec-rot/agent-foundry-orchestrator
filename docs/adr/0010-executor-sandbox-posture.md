# 0010 — 执行器沙箱的姿态：默认关闭、必须显式给镜像、保留网络

- 状态：**已采纳**
- 日期：2026-09-16
- 决策者：本仓库维护者（授权执行 V2 全计划）
- 相关：`docs/ROADMAP.md` §五 P2、`docs/P2-FEASIBILITY.md` §四、ADR-0007

## 背景

P2 先完成了**验收命令**的沙箱化（默认 `auto`）。执行器是另一个长驻子进程，
而且是**真正写工作区**的那个，理应同样处理。但它不能照抄验收的默认值。

## 决策

执行器沙箱：**默认关闭**（`AF_SANDBOX_EXECUTORS=on` 才启用），
且**必须显式配置镜像**（`AF_SANDBOX_EXECUTOR_IMAGE`），网络默认走 Docker bridge。

## 理由（每条都落成了测试）

1. **为什么必须显式给镜像**：容器里要跑的是**那个 CLI 本身**，因此镜像必须**内含该 CLI**。
   选哪个镜像是**部署决策**（`P2-FEASIBILITY.md` §四列了三种取舍）。
   本模块**拒绝猜测**并给出精确原因（`ES-2`），而不是偷偷退回一个不含 CLI 的镜像。
2. **为什么保留网络**：执行器要与 provider 通信。验收命令的 `--network none` 用在执行器上会直接把它打死
   （`ES-3` 断言了"有 bridge、无 none"）。
3. **为什么转发自己的凭证**：容器不继承环境，CLI 无法认证。转发的必须是 `lib/executor-env.mjs` 的输出
   ——**只有它自己的那份**（`ES-3` 断言兄弟凭证不出现在 argv，`ES-4` 端到端断言容器内只看得见自己的）。
4. **为什么默认关闭**：开启会改变执行器的运行环境（挂载、网络、用户、CLI 来源），
   而"镜像里是否真的装了那个 CLI"在本机**无法验证**（本机未安装 claude/codex/agy/vertex）。
   按原则 5，能力不足时宁可显式关闭，也不做出无法验证的默认。
5. **为什么启用后不可用要 fail-closed**：操作员已经声明"我要沙箱"，此时**静默退回无沙箱**
   等于报告了一个比实际更强的姿态。因此返回 `SANDBOX_UNAVAILABLE` 并让该次运行失败（`ES-5`）。

## 验证

```
ES-1  默认关闭且说明原因
ES-2  启用但无镜像 → 拒绝，不猜
ES-3  计划保留网络、只转发自己的凭证、限额与挂载面正确
ES-4  端到端：容器内执行器看得见自己的凭证、看不见兄弟的
ES-5  启用但无沙箱可用 → 拒绝，绝不无沙箱运行
```

`node --test`：268 通过 / 0 失败（原 263），零依赖。

## 补充（同日）：用真实执行器验证，并纠正一处错误断言

**我最初写的"本机未安装任何执行器 CLI"是错的**——我只查了 claude/codex/agy/vertex 就下了结论，
漏掉了**本机确实装着的 `cline`**（`~/.nvm/versions/node/v24.21.0/bin/cline`，平台二进制 v3.0.62）。
经彻底清点（PATH / 所有 nvm bin / `/usr/local/bin` / `~/.local/bin` / `~/bin` / maxdepth-4 可执行文件搜索）：

| 执行器 | 本机状态 |
|---|---|
| `cline` | ✅ **已安装**（v3.0.62 平台二进制，151MB 动态链接 ELF） |
| `claude` / `codex` / `agy` / `vertex-gemini` | ❌ 确认不存在 |

于是"真实 CLI 无法验证"这个借口不成立，并已完成验证：

### 实测结论：镜像策略

| 镜像 | 结果 |
|---|---|
| `node:24-alpine`（musl） | ❌ **失败**：`not found`——平台二进制是动态链接 ELF，需要 `/lib64/ld-linux-x86-64.so.2`，musl 没有 |
| `node:24-slim`（glibc） | ✅ **成功**：容器内报告 `3.0.62`，与宿主一致 |

**可用配方**（宿主 CLI 只读挂载，即 `P2-FEASIBILITY.md` §四的选项 A）：

```bash
AF_SANDBOX_EXECUTORS=on \
AF_SANDBOX_EXECUTOR_IMAGE=node:24-slim \
AF_SANDBOX_EXECUTOR_MOUNTS="$HOME/.nvm/versions/node/<ver>/lib/node_modules" \
node bin/cline-af ...
```

因此新增能力：`buildSandboxCommand` 支持**只读额外挂载**（`roMounts`），
`planExecutorSandbox` 从 `AF_SANDBOX_EXECUTOR_MOUNTS` 读取（逗号分隔，按同路径 ro 挂载）。
只读是刻意的：沙箱不得修改它所运行的工具链。

### 这次真实验证抓出的两个真缺陷

1. **`--tmpfs /tmp` 与 `-v /tmp:/tmp` 冲突**（`Duplicate mount point: /tmp`，docker exit 125）：
   当工作区**正好是** tmpfs 路径时整个计划被 docker 拒绝。任何 `fixture_dir` 为 `/tmp` 的任务都会失败。
   已修（工作区即该路径时跳过 `--tmpfs`），并加了回归测试 ES-6。
2. **cline 健康检查写死了 node 版本**（`adapters.mjs` 里的 `~/.nvm/versions/node/v24.20.0/bin/cline`，
   而本机是 v24.21.0）——这是**作者机器残留**，构成**假阴性**：启动器缺失时，
   明明装好的 cline 会被报成不健康。已改为按 PATH 解析（与 codex 适配器同一做法），
   并用 `CLINE-10` 做有牙回归（回退该修复即报红）。

### 另一个真实教训（关于测试）

真实验证过程中 SB-8 出现**间歇性失败**：它在 ES 测试里 `SIGKILL` docker 客户端后泄漏了容器——
而"杀客户端不停容器"正是 P5 实测确认、并为之写了孤儿回收器的行为。
同时发现 SB-8 原有断言是**全局范围**的，在 node:test 并行跑测试文件时与其他沙箱测试产生竞态。
两处都已修：ES 测试自建容器自行清理；SB-8 的断言按**本进程 pid** 定界（容器名本就含 owner pid）。
修复后全量**连跑两次 271/0 一致**，无容器残留。

### 仍未验证的部分（现在是有依据的窄范围）

`claude` / `codex` / `agy` / `vertex-gemini` 四个 CLI**确认不在本机**，
所以它们的镜像仍需在部署时验证。另：容器内 TLS 需要镜像自带 CA 证书
（实测出现过 `Cannot open directory /etc/ssl/certs`），`node:24-slim` 已包含。

## 后果

- 正面：执行器与验收命令现在共用**同一套**沙箱机制与安全默认（限额、cap-drop、no-new-privileges、只挂工作区）
- 正面：失败路径显式（无镜像/无 docker → `SANDBOX_UNAVAILABLE`），不会出现"以为沙箱了其实没有"
- 负面：**默认关闭**，所以开箱即用时执行器仍与编排器同 UID、无内存上限——这是**已知且记录在案**的状态，
  不是静默降级
- 负面：真实 CLI 镜像**未验证**（本机没有这些 CLI）。启用前必须先用目标镜像跑一次真实执行器
- 负面：`--network bridge` 比验收的 `--network none` 宽松；执行器的网络访问仍受容器边界限制，
  但未做域名级白名单

## 什么情况下应重新评估

1. 选定并验证了一个含全部所需 CLI 的镜像 → 可把 `AF_SANDBOX_EXECUTORS` 默认改为 `on`
2. 需要按执行器分别指定镜像（当前是单一镜像）
3. 需要给执行器加域名级网络白名单

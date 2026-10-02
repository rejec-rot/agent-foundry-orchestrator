# P2 可行性探测报告（沙箱化）

> 按 `docs/ROADMAP.md` §三 原则 4「先探测再实现」执行。
> 所有结论均为**本机实测**，未使用记忆值。

## 一、为什么 P2 是当前第一项

`docs/ROADMAP.md` §七 的残留中，有三项**只有沙箱能解决**：

| 残留 | 现状 | 沙箱能否解决 |
|---|---|---|
| **内存无上限** | 已实现 rlimits（磁盘/CPU/核心转储），但内存**无法**用 rlimit | ✅ 容器 `--memory` |
| **双 fork + setsid 孙进程逃逸** | 进程组树杀只能抓到未脱离进程组的后代 | ✅ PID namespace |
| **执行器与编排器同 UID（根因）** | 所有文件级防护都因此打折 | ✅ 容器 `--user` / 命名空间隔离 |
| （附带）文件系统污染 | 验收命令以操作员权限裸跑 | ✅ 只挂载工作区 |

## 二、候选机制与实测结果

| 机制 | 本机结果 | 判定 |
|---|---|---|
| `nsjail` | **未安装** | 不可用 |
| `bwrap`（bubblewrap） | 已安装，但运行即失败：`bwrap: setting up uid map: Permission denied` | ❌ 不可用 |
| `unshare --user --map-root-user` | `unshare: 写失败：/proc/self/uid_map: 不允许的操作` | ❌ 不可用 |
| `systemd-run --user -p MemoryMax=64M` | scope 能建（cgroup 路径正确），但**申请 256MB 未被杀** | ❌ 限额未生效 |
| cgroup v2 子目录委派 | `mkdir /sys/fs/cgroup/af-probe-*` 被拒；`cgroup.subtree_control` 存在控制器但**不可写** | ❌ 无委派 |
| **Docker** | 客户端/服务端 `29.8.0` 均可用，`docker pull alpine:3.20` 成功 | ✅ **可用** |

> 结论：本机是受限容器环境——**非特权 user namespace 被禁**（uid_map 不可写），
> **cgroup 控制器未委派**。因此 bubblewrap / nsjail / systemd-run 三条路都走不通，
> 但 **Docker daemon 可用**，容器型沙箱成为唯一可行且可验证的路径。

## 三、关键性质实测（用 Docker 验证）

四条**全部通过**：

### 1. 文件系统隔离 ✅
```bash
docker run --rm alpine:3.20 ls -d /home/reject/DSHWorkSpace/agent-foundry-next
# → No such file or directory   （不挂载即不可见）
```

### 2. setsid 逃逸被关闭 ✅
用"心跳文件"判定（容器内外 PID 不同名，不能按宿主机 PID 比对）：

```bash
docker run --rm -v $V:/v alpine:3.20 sh -c '
  setsid sh -c "while :; do date +%s%N >> /v/heartbeat; sleep 0.1; done" & sleep 1.2'
# 容器内心跳: 12 行
# 容器退出后 1.5s: 12 行  →  停止增长
```
**守护进程随 PID namespace 一起被杀。** 这是 `docs/ROADMAP.md` §七 里"双 fork + setsid 逃逸"
的实测关闭证据——进程组树杀做不到这一点。

### 3. 内存限额生效 ✅
```bash
docker run --rm --memory=64m --memory-swap=64m alpine:3.20 \
  sh -c 'dd if=/dev/zero of=/dev/shm/hog bs=1M count=256'
# → Killed (OOM)    （tmpfs 页计入 cgroup 内存）
```
补上了 rlimit 做不到的那一项。

### 4. fork 炸弹被拦 ✅
```bash
docker run --rm --pids-limit=24 alpine:3.20 sh -c 'i=0; while [ $i -lt 200 ]; do sleep 5 & i=$((i+1)); done'
# → sh: can't fork: Resource temporarily unavailable
```

## 四、实现范围与需要决策的点

### 建议范围：**先沙箱化验收命令，执行器暂缓**

| 对象 | 为什么 |
|---|---|
| **验收命令（`lib/acceptance.mjs`）** | ✅ 风险最高：它以**操作员权限**执行一条由任务文件决定的命令，且命令内容来自白名单（`node --test` / `npm test`）——镜像需求简单，`node:24-alpine` 即可覆盖 |
| 执行器（`lib/adapters.mjs`） | ⏸ 需要镜像内含 5 种 CLI（claude/codex/cline/vertex/agy），或把宿主机二进制只读挂载进容器。**这是部署决策，不是代码问题** |

### 需要决策的点（阻塞执行器沙箱）

沙箱内的执行器从哪来？

| 选项 | 优点 | 缺点 |
|---|---|---|
| A. 现成 node 镜像 + 只读挂载宿主机 CLI | 不用建镜像 | 宿主机二进制依赖的共享库需一并挂载，脆弱 |
| B. 自建镜像，预装全部 5 种 CLI | 干净、可复现 | 需维护镜像与升级流程，镜像较大 |
| C. 每个执行器一个专用镜像 | 隔离最好 | 维护成本最高 |
| D. 执行器先不沙箱，只上 rlimits + 树杀（现状） | 零成本 | 内存限额与同 UID 根因仍在 |

**建议**：先做验收沙箱（选项 A 的简化版：`node:24-alpine` + 只读挂载工作区），
执行器等选项 A/B 决策后再做。

### 其他实现要点

1. **能力探测必须显式**：Docker 不可用时**不得静默降级**（原则 5）——
   要么按配置 fail-closed，要么明确报告"沙箱未启用，当前仅有 rlimits 保护"
2. **网络**：验收命令默认 `--network none`（测试不需要外网）；执行器若沙箱化则必须保留网络
3. **超时与回收**：容器必须能被现有的树杀路径终止（`docker run` 的进程树被 `--rm` + SIGTERM 覆盖），
   并与 `lib/child-process.mjs` 的登记/回收对接
4. **挂载**：只挂工作区（可写）+ 只读挂必要的运行时；**绝不挂编排器根目录**（与 `isInsideOrchestratorRoot` 呼应）
5. **用户**：容器内使用非 root 用户（`--user`），把"同 UID"根因在容器内消解

## 五、结论

- **P2 可行**，唯一可用机制是 **Docker**（bwrap / nsjail / systemd-run / cgroup 委派在本机均不可用）
- 四条关键性质**已实测通过**，包括此前被认为做不到的**内存限额**与**setsid 逃逸**
- 建议**先沙箱化验收命令**；执行器沙箱化需要一个镜像策略决策（见 §四）

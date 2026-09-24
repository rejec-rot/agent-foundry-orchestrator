# Web 交付说明（P4）：启动、验证、以及我们**没有**验证的东西

面向"把这套东西真正跑起来"的人。全部命令可以直接复制粘贴。

---

## 1. 交付了什么

| 部分 | 状态 | 说明 |
|---|---|---|
| 只读工作台 | ✅ 已交付 | `server/read-api.mjs` + `web/`。**结构性只读**：写路由要么不存在，要么必须带令牌 |
| 写操作（创建 / 启动 / 取消） | ✅ 已交付 | 需要服务端 `--allow-write` **且** 配置了操作令牌（§7.3） |
| 审批（Human Gate）/ 提升 | ❌ 有意不开放 | 审批需要**签名批准**（`AF_OPERATOR_KEY`）；浏览器不持有该密钥 |
| 运行式在线成果预览 | ⬜ 未交付 | 需要独立的隔离预览服务，属后续工作 |
| 流程画布 / 自动部署 | ⬜ 本期不做 | 计划里明确列在"本期不做" |

---

## 2. 启动

### 2.1 只读（默认，推荐日常先用这个）

```bash
cd /home/reject/DSHWorkSpace/agent-foundry-next
node af-admin.mjs web serve
# → 打开它打印的地址，例如 http://127.0.0.1:8787
```

页面顶部会显示「只读」，写按钮全部禁用，且**服务端根本没有可用的写入口**。

### 2.2 写模式（创建 / 启动 / 取消）

写模式需要两件东西同时成立：服务端 `--allow-write`，以及一个操作令牌。

```bash
# 1) 生成本机私有令牌（目录 700、文件 600，绝不进仓库）
mkdir -p ~/.config/agent-foundry
umask 077
head -c 32 /dev/urandom | base64 > ~/.config/agent-foundry/web-token
chmod 600 ~/.config/agent-foundry/web-token
chmod 700 ~/.config/agent-foundry

# 2) 让服务端读到它
export AF_WEB_TOKEN_FILE=~/.config/agent-foundry/web-token

# 3) 以写模式启动；--root 是允许提交的目标仓库根（可给多个）
cd /home/reject/DSHWorkSpace/agent-foundry-next
node af-admin.mjs web serve --allow-write --root /home/reject/DSHWorkSpace/agent-foundry-next
```

然后**在浏览器页面右侧**「操作令牌」里粘贴令牌内容并点「保存令牌」。令牌只留在页面内存与 `sessionStorage`（关闭标签页即失效），**不写磁盘、不进 URL、不留在 DOM**。

没令牌就启动写模式会被直接拒绝：

```
error: --allow-write needs an operator token, but no write token is configured (set AF_WEB_TOKEN_FILE)
```

### 2.3 不想用浏览器也行（CLI 等价入口）

```bash
node af-admin.mjs v2 create --spec spec.json --root /path/to/repo   # 幂等：同 key 返回同一个任务
node af-admin.mjs v2 start  --task <task_id>                        # 单一 owner；重启是续跑，不重跑作者
node af-admin.mjs v2 cancel --task <task_id> --reason "为什么" --confirm
```

---

## 3. 交付验证怎么跑

```bash
cd /home/reject/DSHWorkSpace/agent-foundry-next

# (a) 部署预检：解释器/资产/写路径卫生/systemd 单元/env 示例/监听地址，30 项
node verification/deploy-preflight.mjs

# (b) 真浏览器：只读工作台 15 项（含 390/320 无横向溢出、无控制台错误）
node verification/web-console-smoke.mjs

# (c) 真浏览器 + 真实写路径 19 项：保存令牌 → 创建 → 启动（分离 worker）→ 取消，
#     并证明**同一请求不带令牌会被服务端拒绝**（不是按钮变灰而已）
node verification/web-write-browser.mjs

# (d) 全量单元/集成
node --test
```

`verification/artifacts/` 里会留下截图（已 gitignore）。

---

## 4. 已知限制（不修好就不说它好）

1. **没有 TLS，只应跑在 loopback。** 这是明文 HTTP。`--allow-non-loopback` 存在，但只在你有反代/隧道且清楚后果时用。
2. **令牌是"单操作者共享口令"，没有身份区分、没有过期、没有轮换机制。** 谁能拿到令牌谁就能写；轮换 = 换文件 + 重启服务 + 页面重新粘贴。
3. **CSRF 防护依赖自定义头 + Origin 校验**，不是逐请求的一次性 token。对 loopback 场景足够，对"暴露到公网"的场景不够。
4. **审批与提升在浏览器里永远不可用**（设计如此）。Human Gate 的续跑必须走 `af-admin v2 gate-resume`，且需要 `AF_OPERATOR_KEY` 签名。
5. **任务是单进程 owner。** 浏览器点「启动」只会**取到锁并派发一个分离 worker**；如果已有 owner 持锁，会返回 409 而不是排队。
6. **取消不是"立即停止"。** 它写下持久化请求，在**下一个受信边界**生效；`ref` 更新一旦开始，只会被记录为 `too-late`，提升照常完成。
7. **`/proc` 陷阱（本机实测）**：`mkdirSync(recursive)` 对 `/proc/...` 路径会**无限阻塞**。事件目录、运行时目录都**不要**指向 `/proc` 下的路径。这是 OS 层面的怪癖，任何同步 API 都救不了。
8. **事件时间线是投影，不是事实来源。** 任务文件才是生命周期真相；两者不一致时页面会显式打「⚠ 事件与任务快照不一致」。历史上没有事件的任务会被标为「没有事件历史」，**不会**被伪造成一条干净时间线。
9. **真实模型任务没有在本机验收过。** 需要被授权的执行器与预算；本仓库的测试用的是注入式作者/评审。因此"前端能跑通全流程"这句话的边界是：**控制面、持久化、锁、拒绝路径、git 提升**都验证过；**模型产出的质量**没有在这里验证。
10. **未覆盖**：多用户并发、跨机器部署、systemd 真实安装（需 root）、TLS 反代、浏览器兼容性（只测了 Chrome；页面用到 `fetch`/`sessionStorage`/`<details>`）。

---

## 5. 回退

```bash
cd /home/reject/DSHWorkSpace/agent-foundry-next
git tag --list 'stage5-*'            # 每个交付批次一个 tag
git log --oneline -10                # 上游 HEAD：b366f66 web 写路径鉴权 / a719910 G5
# 关掉写模式即可回到"只读且无写入口"：不带 --allow-write 启动
```

写模式**不会**自动启动任何东西：`start` 必须由人显式点击/敲命令，且每一步都会在任务记录与事件里留痕。

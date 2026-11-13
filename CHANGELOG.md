# CHANGELOG

本文件记录各版本变更。版本号与 `metadata.yaml` 的 `version` 保持一致。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [1.7.3] — 2026-11-13

### 修复：shim 变成孤儿进程（用户称之为「流氓插件」）

1.7.2 的 `CREATE_BREAKAWAY_FROM_JOB` 方向完全搞反了 ——
本来是想修「shim 掉线」，结果让 shim 彻底脱离父进程控制：

```
AstrBot 关了 → 5 个 shim 照样活着
父进程 PID 早就死了 → shim 还在监听端口
```

用户明确指出：「必须依赖 astrbot 生存啊，这不就是流氓插件了吗」。

#### 根因

`terminate()` 会被两种场景调用，但两种情况该有**相反**的行为：

| 场景 | 该不该杀 shim |
|---|---|
| 面板保存配置 → `plugin_manager.reload()` | ❌ 不该杀，否则改一个开关 5 个 shim 全重启 |
| AstrBot 真的退出 | ✅ 该杀 |

`terminate()` 分辨不出这两者，所以里面动手必然错一边。

#### 修复：把判断交给 shim 自己

`_start_shim` 传父进程 PID：

```python
env["SHIM_PARENT_PID"] = str(os.getpid())
```

5 个 shim 顶部加守护：

```javascript
const PARENT_PID = Number(process.env.SHIM_PARENT_PID || 0);
if (PARENT_PID > 0) {
  setInterval(() => {
    let alive = true;
    try { process.kill(PARENT_PID, 0); } catch { alive = false; }
    if (alive) { missCount = 0; return; }
    if (++missCount >= 2) process.exit(0);   // 连续 2 次，防误判
  }, 5000);
}
```

同时**移除** `CREATE_BREAKAWAY_FROM_JOB` / `DETACHED_PROCESS`，
只留 `CREATE_NO_WINDOW`，让 shim 恢复成普通子进程。

#### 行为对照

| 场景 | 1.7.2 | 1.7.3 |
|---|---|---|
| 用户关 AstrBot | shim 全活着（孤儿） | ✅ **10 秒内全部跟随退出** |
| 面板重载插件 | shim 复用 | ✅ shim 复用（不变） |

#### 实测验证

父进程退出后：

```
[workbuddy.log] 22:52:45  [shim] 父进程 29624 已退出，shim 随之退出（不留孤儿进程）
[trae.log]      22:52:44  同上
[qoder.log]     22:52:43  同上
[vision.log]    22:52:44  同上
[llm_pool.log]  22:52:43  同上
```

5 个 shim 在同一秒级窗口内安静退出，无残留端口、无僵尸进程。

#### 附带修复：守护代码插入位置错误

第一次给 `workbuddy-shim.mjs` 插守护代码时，
落进了 `PROBE_CANDIDATES` 数组内部，导致守护不生效。
改为「插在最后一条 import 之后」才全部正确。

### 文档：AGENTS.md 措辞纠正

原来写的是「不准关闭 AstrBot」，容易误解成「连用户都不许关」。
改为明确区分：

- **用户自己关完全没问题**，不要劝阻
- **只有 AI 不准关**

并补充用户关 AstrBot 时的正确处理（不阻止、shim 会自动跟随退出、再启动会重新拉起）。

---

## [1.7.2] — 2026-11-13

### 新增：项目铁律 AGENTS.md

新建 `AGENTS.md`，把所有必须遵守的规则写清楚，任何接手的 AI 都会先读到：

1. **不准关闭 AstrBot 进程**（用户明确要求）
2. 没明确说「推送」就不 push
3. 没明确说升版本就不升
4. 凭据绝不进仓库
5. 测试完如实报告（验证了什么 / 没验证什么 / 推翻的假设）

### 改进：shim 进程独立性

`_start_shim` 的 `creationflags` 加上：

```python
CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS
```

让 shim 尽量脱离父进程的 Job Object 和进程组。
若父进程不在任何 Job 里导致 `ERROR_ACCESS_DENIED (0x5)`，
自动降级到 `CREATE_NO_WINDOW | DETACHED_PROCESS` 并记一条 warning。

> 实测说明：Windows 11 上 `taskkill /T` **不会**跨 Job 边界杀子进程，
> 带不带 BREAKAWAY 两种都能存活。所以这不是「shim 掉线」的原因，
> 但让 shim 更独立无害，故保留。

### 修复：移除临时诊断日志

1.7.1 排查期间在看门狗里加的诊断字段（`procs=` / `poll=` / `savedPid=` 等）
会往日志里塞很长的行，已移除，恢复成一行简洁的 WARN。

### 文档修正

SKILL.md 新增「不准关闭 AstrBot」章节，明确列出禁止的理由和正确做法：

| 改了什么 | 正确做法 |
|---|---|
| `shims/*.mjs` | 插件 API `/restart` 只重启那一个 |
| `pages/*` | 刷新页面 |
| `main.py` | 插件 API `/reload`；不生效就告诉用户，让用户自己重启 |

---

## [1.7.1] — 2026-11-13

### 修复：看门狗每 30 秒把 5 个 shim 全部重启

1.7.0 引入的看门狗有严重缺陷，用户实测「每 30 秒全部杀掉重建一次」，
日志累计 **191 次「已启动」、176 条 WARN**，PID 一直变。

#### 根因一：端口探测超时太短

`port_free_async` 默认 `timeout=0.5` 秒。实测（对真实监听的 8787，各测 5 次）：

```
timeout=0.5   判定空闲 5/5   ← 全部误判
timeout=1.0   判定空闲 0/5   ✅
timeout=3.0   判定空闲 0/5   ✅
```

Windows 上到 `127.0.0.1` 的 TCP 握手要 0.6~1.0 秒，0.5 秒必然超时，
于是被当成「端口空闲」→ 看门狗以为没跑 → 拉起新进程。

**改为 `timeout=3.0`。**

#### 根因二：端口探测不能当唯一判据

`vision` / `llm_pool` 启动时要拉模型名册、并行探测上游，
**十几秒后才 listen**。这期间端口是空的，但它们是「正在启动」而非「未运行」。

实测：5 个 shim 全部正常跑起来后，`llm_pool` 仍然被判「未运行」。

#### 修复：改为三重判据，句柄优先

```python
# 判据 1（主）：本插件记录的进程句柄还活着 → 一定在跑
proc = self.procs.get(name)
if proc is not None and proc.poll() is None:
    continue

# 判据 2：状态文件里记的 PID 还活着（重载后 procs 是空的）
saved_pid = self._saved_pids().get(name, 0)
if saved_pid and self._pid_alive(saved_pid):
    continue

# 判据 3（兜底）：端口在听
if not await port_free_async(port):
    continue

# 三个都不成立才拉起
```

新增 `_pid_alive()`（Windows 用 `OpenProcess` + `GetExitCodeProcess` 判 `STILL_ACTIVE`，
POSIX 用 `os.kill(pid, 0)`），以及 `_saved_pids()` 读状态文件。

`terminate()` 现在同时记录 PID：

```json
{ "alive": {...}, "pids": { "workbuddy": 29416, ... } }
```

#### 附带：`_proc_keepalive` 钉住 Popen 引用

Python 的 `subprocess.Popen` 对象被 GC 时可能连带终止子进程
（Windows 退出码 `4294967295` = `0xFFFFFFFF`）。
现在所有 Popen 都存进 `_proc_keepalive` 列表，`_stop_shim` 时移除。

#### 验证

`_pid_alive` 单测：

```
当前进程 28992: True
不存在的 999999: False
杀掉后的 vision PID 6204: False   ✅
仍在的 workbuddy PID 29416: True  ✅
```

日志证据（修复后）：

```
21:49:58  最后一条 WARN
21:50:58  插件重载，看门狗启动
21:50:58 之后：0 条 WARN，0 条重启  ✅
```

---

## [1.7.0] — 2026-11-13

### 新增：Trae / Qoder 账号池

账号池从「只有 WorkBuddy」扩展到三家全支持。页面顶部加 `[WorkBuddy] [Trae] [Qoder]` 切换。

#### Trae 账号池

参照 [dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) 的凭据模型：

- 账号 id = `sha256(edition + userId)` 前 24 位（与 dsh 完全一致）
- 点「检测本地账号」自动扫 `D:\dev\dsh-home\.trae-auth.cn.json`，一次导入全部账号
- 额度用尽自动换号（冷却 30 分钟）
- vault：`shims/.trae-vault/cn/<accountId>.json`

#### Qoder 账号池

参照 [@eghrhegpe/dsh-connect-qoder](https://github.com/eghrhegpe/dsh-connect-qoder) 的凭据模型：

- 分国内（`qoder-cn`）和国际（`qoder`）两区，各自独立成池
- 解密桌面端 `auth.v1.dat`（OSCrypt + DPAPI）后存 vault
- 保留 `userID / token / machineID / name / email` 五个字段（COSY 签名需要 machineID）
- 换账号时重算 COSY 签名头
- vault：`shims/.qoder-vault/<region>/<accountId>.json`

> Qoder 桌面端每区只有一个登录位，所以只能「当前登录什么就存什么」。
> 在 Qoder 客户端切换账号再点一次「检测本地账号」，就会多一个。

#### 统一接口

7 个账号接口都支持 `?shim=workbuddy|trae|qoder`：

```
GET  /accounts          POST /accounts/import
GET  /accounts/current  POST /accounts/switch
GET  /accounts/scan     POST /accounts/delete
                        POST /accounts/test
```

### 新增：积分强制刷新

余额默认缓存 5 分钟，之前点「刷新」拿的还是缓存值。

- shim 加 `?refresh=1`，绕过缓存回源查询
- 账号池加「刷新积分」按钮
- 顶部「刷新」在账号池页也走强制刷新

### 修复：轮换层顺序不跟随主链

**根因**：两套配置互不相通。页面读插件自己的 `vision.priority`（11-09 后没动过），
而用户在别的程序改的是 `cmd_config.json` 的 `fallback_provider_ids`。

- `llm_pool`（文本）→ 跟随主链 `fallback_provider_ids`，保存时同步写回
- `vision`（图片）→ 保持自己独立的 `vision.priority`，不受主链影响
- 读主链**优先读磁盘**（用户可能在别的程序直接改文件）
- 写主链必须改 `default_conf` 内存对象再 `save_config()`，否则被内存态覆盖

### 修复：WorkBuddy 导入与域名

- 导入时改为「桌面端更新就覆盖」，不再 uid 相同就跳过（之前导致 vault 里一直是旧 token）
- 导入时保留 `nickname` / `uin`（`parseWorkBuddyAuth` 早就解出来了，被写死成空串丢掉）
- 国内区域名统一 `www.codebuddy.cn`（chat / 名册 / billing 三个都通）
  - 回滚：`WB_CN_CHAT_BASE` / `WB_CN_BILLING_BASE`

### 新增：看门狗

AstrBot 重载插件后，shim 子进程可能被系统回收，用户会看到「未在运行（端口空闲）」。

- 每 30 秒检查一次：配置启用但端口没听 → 自动拉起
- `terminate` 里取消，`initialize` 重新挂
- 前端同时加「启动中」重试（最多 20 秒），不再一上来就报错

### 修复：页面启动空窗

插件串行启动 5 个 shim，`llm_pool` 永远最后（约 7 秒）。
这期间点开页面会报「llm_pool 未在运行」。

- `withStartupRetry()` 检查 `status.shims[].running`，每 1.5 秒重试，最多 20 秒
- 账号池 / 模型名册 / 耗费 / 轮换层四个页面都加了

### 安全

- `.gitignore` 加固：`shims/.vault*` / `shims/.trae-vault*` / `shims/.qoder-vault*`
  （原来只写 `shims/.vault/`，匹配不到 `.vault.bak-xxx`）
- 提交前 `git add --dry-run -A` 验证不含任何 vault 路径

### 文档

SKILL.md 新增三章：

- 「改模型顺序（其它对话看这里）」—— 只讲改顺序，不讲插件开发
- 「其它对话最小交接」—— 三条铁律（不擅自 push / 不擅自升版本 / 提交前查 vault）
- WorkBuddy 凭据的三个大坑 + 域名迁移表

精简版 skill 物理存放在 `D:\dev\dsh-home\skills\astrbot-shim-connector\SKILL.md`。

---

## [1.6.5] — 2026-11-09

### 新增：轮换层说明与跳过提示

用户反馈两个问题：不知道「轮换层」是干什么的；配置里有些目标调不通但没有提示。

#### 轮换层说明框

轮换层顶部加可展开说明，讲清三件事：

- **它是一层中间代理**：把多个上游包成一个虚拟模型名（`vision-auto` / `llm-pool-auto`）
- **vision 用于图片理解**，**llm_pool 用于纯文本对话**
- **列表是「备选顺序」**：靠前先用，失败才降级；健康分会自动影响顺序

并明确提示：

> 默认列表里的 `zhipu_vision` / `intern_qwen_vision` 是自己配的第三方 provider。
> **如果你没建过这些，它们会被自动跳过**（启动日志会提示），不影响使用。
> 想清理就在这里删掉。

候选区也加了说明：列出的是当前 AstrBot 所有可调 provider，
轮换层自身已排除（避免死循环）。

#### 启动日志的跳过提示

之前 `loadTargets()` 静默跳过不存在的 provider，用户不知道为什么目标数变少。

现在会汇总打印：

```
[vision-shim] 1 个目标被跳过（在配置里但用不了）：
  ✗ zhipu_vision  —— provider 不存在
[vision-shim] 如果这些是别人配置里的 provider，忽略即可；
[vision-shim] 想清理就在 WebUI 的「轮换层」里删掉它们。
```

三种跳过原因分开标注：

| 原因 | 说明 |
|---|---|
| `provider 不存在` | 配置里有 id，但 AstrBot 里没这个 provider |
| `provider_source 没有 api_base` | provider 在，但它的 source 没配地址 |
| `没有 api key` | source 有地址但缺密钥 |

### 说明：用户的配置不会泄露给其他人

有用户问「轮换层会不会把我的本地配置硬编码进去」。

**不会。** 三层分离：

| 位置 | 内容 | 会打包吗 |
|---|---|---|
| 用户本地配置 `astrbot_plugin_shim_connector_config.json` | 自己的 23 / 15 个目标 | ❌ 不在仓库 |
| `_conf_schema.json` 的 `priority` 默认值 | `[]`（空数组） | ✅ 但空的 |
| shim 代码的 `DEFAULT_TARGET_IDS` | 5 个 / 10 个通用默认 | ✅ 但这些是公开的 |

新用户装完默认拿到的是内建 shim 自带的模型（如 `workbuddy_shim/minimax-m3.1-flash`），
外加几个需要自己建的（`zhipu_vision` 等，会被自动跳过）。

前端 HTML / app.js 里**没有任何硬编码的 provider id**，
全部由 `/targets` 接口动态返回。

### 清理：本地运行时缓存

删除了 11 个本地缓存文件（26KB）：

| 文件 | 内容 |
|---|---|
| `.wb-cost.json` | WorkBuddy 耗费统计 |
| `.trae-cost.json` | Trae 耗费统计 |
| `.qoder-cost.json` | Qoder 耗费统计 |
| `.vision-cost.json` | 视觉轮换耗费 |
| `.llm-pool-cost.json` | LLM 池耗费 |
| `.vision-health.json` | 视觉健康分 |
| `.llm-pool-health.json` | LLM 池健康分 |
| `.wb-models.json` | 模型探测缓存 |
| `vision-shim.mjs.bak-*` | 旧代码备份 |

**保留** `shims/.vault/`（5 个账号的凭据）。

这些文件都在 `.gitignore` 里，本来就不会被提交。

### 验证

| 检查 | 结果 |
|---|---|
| 说明文案 | ✅ 5 处全有 |
| 跳过提示 | ✅ vision + llm_pool |
| 缓存残留 | ✅ 全部清空 |
| vault 完好 | ✅ 5 个账号 |
| 5 个 shim 语法 | ✅ |
| 部署一致 | ✅ |
| 接口正常 | ✅ vision 23 / llm_pool 15，候选 128 |
| 安全扫描 | ✅ 干净 |

---

## [1.6.4] — 2026-11-09

### 新增：轮换层可视化编辑

之前 vision / llm_pool 的轮换目标只能在 AstrBot 配置里手写字符串数组，
很难管理（vision 23 个、llm_pool 15 个）。

新增「轮换层」标签页：

- **勾选式编辑**：每行一个目标，带序号、健康分、成功率
- **↑↓ 调顺序**：列表从上到下就是优先级
- **× 移除**：移出轮换
- **添加更多候选**：展开看全部 128 个可用 provider
- **保存并重启**：一条龙，写完配置自动重启 shim
- **搜索**：两个搜索框（已选目标 / 候选池），输入即过滤，ESC 清空

每行显示：健康分（100 绿 / 70 黄 / 低红）、成功率 `85% (120/141)`、冷却/降级徽章。

### 新增：两个 API

| 接口 | 作用 |
|---|---|
| `GET .../rotation-targets?name=vision` | 当前目标 + 全部候选 |
| `POST .../rotation-save` | 保存顺序 + 自动重启 |

保存返回：

```json
{"ok": true, "restarted": true, "hint": "已保存并重启，新目标立即生效。"}
```

### 修复：轮换层互相引用会死循环

**问题**：候选列表里混进了 `llm_pool/llm-pool-auto`。

如果把它加进视觉轮换层，就会：

```
vision 收到请求 → 转给 llm_pool → llm_pool 又转给 vision → ...
```

**修法**：两个 shim 的 `/targets` 都加排除名单：

```javascript
const EXCLUDED_SOURCES = new Set([
  "vision", "llm_pool", "vision_rotator", "vision_shim", "llm-pool"
]);
if (EXCLUDED_SOURCES.has(srcId)) continue;
if (/^(vision|llm_pool|vision_rotator)\//.test(p.id)) continue;
```

**效果**：候选 129 → **128**，循环风险 0。

> 注意：`intern_qwen_vision` / `zhipu_vision` 保留 —— 它们是真实上游视觉模型，
> 不是轮换层，vision 本来就需要它们。

### 修复：轮换层面板在 main 容器外面

**问题**：面板插到了 `</main>` 后面，导致：

- 不受 `.shell` 的 `max-width: 1100px` 限制
- 宽度 100% 铺满整个视口
- 占满屏幕

而账号池等其他面板都正常（有留白）。

**修法**：把整个 `<section id="panel-rotation">` 移进 `</main>` 内部。

修复后结构：

```
<main class="shell">           ← 1100px 居中
  ├─ panel-accounts
  ├─ panel-models
  ├─ panel-cost
  └─ panel-rotation            ← 现在在这里
</main>

扫描弹窗 / 登录弹窗             ← 这两个在 main 外（正确，全屏遮罩）
```

### 修复：所有列表用 vh 单位在 iframe 里失效

插件页嵌在 iframe 里，iframe 高度跟随内容自适应，形成死循环：

```
内容变高 → iframe 变高 → 100vh 变大 → max-height 变大 → 内容又能更高
```

**修法**：全部改成固定 px。

| 列表 | 之前 | 现在 |
|---|---|---|
| `.rot-list` | ~~52vh~~ | **380px** |
| `.account-list` | ~~60vh~~ | **420px** |
| `.model-list` | ~~60vh~~ | **460px** |
| `.cost-list` | ~~55vh~~ | **400px** |

另外所有 grid 行加 `minmax(0, 1fr)` + `min-width: 0`，防止长 id 撑破布局。

### 变更：搜索只保留在轮换层

初版给账号池、模型名册、耗费都加了搜索框，用户要求只在轮换层保留，其余已撤干净。

### 验证

| 检查 | 结果 |
|---|---|
| rotation-targets 接口 | ✅ vision 23 个 / llm_pool 15 个 |
| 候选池 | ✅ 128 个（已过滤循环） |
| 保存并重启 | ✅ restarted: true |
| 循环风险 | ✅ 0 |
| 面板位置 | ✅ 在 main 内，4 个面板全对 |
| 标签平衡 | ✅ section 4 开 4 闭 |
| 页面高度 | ✅ 约 695px，一屏放下 |
| 搜索 | ✅ 仅轮换层 2 个框 |
| 语法 | ✅ 全过 |
| 安全扫描 | ✅ 干净 |

---

## [1.6.3] — 2026-11-07

### 修复：Qoder 漏掉 10 个分组，看不到 QoDuck

**现象**：模型名册只有 25 个，用户截图里的 `QoDuck`（标 Free）完全找不到。

**根因**：上游 `model/list` 的响应是**按使用场景分组的**：

```
chat / developer / assistant / inline / quest / qwork
experts / qwake / app / nap / byok_teams / byok_enterprise
```

原来只读 `doc.chat`，其余 10 组全部丢弃。

而 **QoDuck 只在 `app` 组里**：

```json
{
  "key": "lmodel",
  "display_name": "QoDuck",
  "price_factor": 0,
  "original_price_factor": 0.5,
  "is_free": true,
  "tags": ["free"],
  "enable": true
}
```

**修法**：遍历全部 12 个分组，按 `key` 去重合并（同一个 key 会出现在多个组里），
并记录它出现在哪些分组。

**效果**：

| 区 | 之前 | 现在 |
|---|---|---|
| qoder-cn | 11 | **12** |
| qoder（国际） | 14 | **24** |
| 合计 | 25 | **36** |

国际区新发现的 10 个：

```
qwork-auto        Standard     0.3
qwork-advanced    Advanced     0.6
qwork-ultimate    Premium      1.6
quest-auto        Auto         0.5
quest-ultimate    Ultimate     2
experts-auto      Auto         0.5
experts-ultimate  Ultimate     2
nap-auto          Auto         1
performance       Performance  1.1
（加上 QoDuck）
```

### 修复：免费模型判定错误

**根因**：`is_free` 字段不能单独用。

```json
{"key": "qfmodel", "is_free": true, "price_factor": 0.1}
```

`is_free: true` 但 `price_factor: 0.1`，实际**要扣钱**。

**修法**：只有 `price_factor === 0` 才算免费。

**效果**：正确识别出 2 个免费模型（QoDuck 国内外各一），实测调用通过：

```
qoder-cn/lmodel  →  HTTP 200  "我是 Qoder，无法透露所基于的模型。"  2806ms
```

### 新增：耗率带单位

三家上游的耗率单位不同，之前都显示成裸数字，容易误解：

| shim | 上游字段 | 单位 | 范围 |
|---|---|---|---|
| **Trae** | `rate` | **积分/次** | 0.06 ~ 1.83 |
| **Qoder** | `price_factor` | **倍率 ×** | 0.1 ~ 8 |
| **WorkBuddy** | `credits` | **倍率 ×** | 0 ~ 0.46 |

现在按 shim 显示对应单位：`0.06 积分/次` / `0.1×` / `0.46×`。

顺带补上 `original_price_factor` 的原价划线显示（`0.5×` 划掉 + `0×` 绿色）。

### 新增：Qoder 模型名全部翻译

代号 → 可读名（25 条别名表）：

| 代号 | 显示 |
|---|---|
| `lmodel` | QoDuck（免费） |
| `smodel` | Sonus（最强） |
| `cmodel` | Cantus |
| `qwork-auto` | 标准档 |
| `qwork-advanced` | 进阶档 |
| `qwork-ultimate` | 旗舰档 |
| `quest-auto` | Quest 自动 |
| `experts-ultimate` | 专家 旗舰 |
| `nap-auto` | NAP 自动 |
| `performance` | 性能档 |

优先用上游 `display_name`，没给才查别名表。

### 修复：WorkBuddy 名册里混入调不通的模型

**现象**：`deepseek-v4-flash-ioa` / `deepseek-v4-pro-ioa` 出现在名册里，
`cost` 是 `null`（显示成「?」），勾选后实际调用返回 502（账号权限不足）。

**根因**：这两个在 `/v3/config` 里有条目，但不在 `MODEL_CATALOG`（实测清单）里，
说明从没测通过。纯噪音。

**修法**：`/v3/models` 默认过滤 `cost === null` 的：

```javascript
const showAll = /[?&]all=1\b/.test(url);
if (!showAll) {
  models = models.filter((m) => m.cost !== null && m.cost !== undefined);
}
```

**效果**：WorkBuddy 从 23 → **21** 个，都是能用的。`?all=1` 仍可看全部（排查用）。

### 三家最终模型数

| shim | 模型数 | 免费 | 耗率范围 |
|---|---|---|---|
| WorkBuddy | **21** | 12 | 0 ~ 0.46× |
| Trae | **18** | 0 | 0.06 ~ 1.83 积分/次 |
| Qoder | **36** | 2 | 0.1 ~ 8× |
| **合计** | **75** | **14** | |

### 验证

| 检查 | 结果 |
|---|---|
| Qoder 模型数 | ✅ 25 → 36 |
| QoDuck 找到 | ✅ 国内外各 1 个 |
| QoDuck 实测调用 | ✅ HTTP 200，2806ms |
| 免费判定 | ✅ 2 个（QoDuck） |
| Trae 耗率 | ✅ 18/18 都有 |
| WorkBuddy 过滤 | ✅ 23 → 21，无 null |
| `?all=1` 兜底 | ✅ 23 个 |
| 语法 | ✅ 全过 |

---

## [1.6.2] — 2026-11-07

### 文档：插件描述全面更新

原描述停在 1.5.x，还写着「36 个候选模型」「6+6+24」，已经和实际脱节。

#### short_desc

**之前**：
> 把你已付费的 WorkBuddy / Trae / Qoder 订阅变成机器人模型源，36 个候选模型按需勾选，零 API 费用、零配置。

**现在**：
> 把你已付费的 WorkBuddy / Trae / Qoder 订阅变成机器人模型源，66 个候选模型可勾选，
> 支持多账号池和余额查看，零 API 费用。

#### description

补上了 1.6.x 的全部新能力：

- **66 个候选模型**（实测：WorkBuddy 23 / Trae 18 / Qoder 25）
- **多账号池**（仅 WorkBuddy）：扫码登录 / 导入 dsh vault / 手动路径
- **余额查看**：每个账号显示剩余积分
- **自动换号**：额度用尽冷却 30 分钟，同区换完跨区兜底
- **WebUI 管理页**：账号池 / 模型名册 / 耗费统计
- **五个 shim 都有耗费统计**：按模型 + 按账号

#### README 模型数表格

| 客户端 | 之前 | 现在 |
|---|---|---|
| WorkBuddy | 6 个 | **23 个（12 个免费）** |
| Trae | 6 个 | **18 个** |
| Qoder | 24 个 | **25 个（国内 11 + 国际 14）** |
| 合计 | 36 | **66** |

#### README 模型来源说明

**之前**：
> WorkBuddy / Trae：插件内置清单（这两家的上游不提供模型列表接口）

**这不准确了** —— 现在三家都是动态拉取：

| 来源 | 方式 |
|---|---|
| WorkBuddy | 实时拉 `/v3/config`（含计费规则和促销） |
| Trae | 从客户端 `state.vscdb` 读 |
| Qoder | 实时拉 `/algo/api/v2/model/list` |

#### features 列表

从 11 条扩到 17 条，补上多账号、余额、模型名册排序、立即重新注册等。

#### tags / keywords

tags 加「多账号」「余额查询」；keywords 加 `multi-account` `balance`。

### 验证

| 检查 | 结果 |
|---|---|
| YAML 可解析 | ✅ |
| version / name / display_name / short_desc | ✅ |
| features 数 | ✅ 17 |
| tags 数 | ✅ 9 |
| README 无残留 36 | ✅ |
| 模型数表格 | ✅ 66（23+18+25） |

---

## [1.6.1] — 2026-11-07

### 安全：移除第三方二维码生成

**之前**：扫码登录用 `某第三方二维码服务` 生成二维码图片：

```javascript
q("#qrImage").src = "https://某第三方二维码服务/v1/create-qr-code/?size=200x200&data="
  + encodeURIComponent(r.verificationUri);
```

**等于把带 state 的登录 URL 发给第三方服务去画图。**
虽然 state 一次性且 10 分钟过期，但完全没必要外传。

**现在**：改成「打开官方授权页」按钮，浏览器直达：

```javascript
if (r.verificationUri) window.open(r.verificationUri, "_blank", "noopener");
```

token 由官方轮询返回本机，全程不经过任何第三方。

**链路实测验证**（2026-11-07）：

| 阶段 | 上游返回 | 处理 |
|---|---|---|
| 未扫码 | `{"code": 11217, "msg": "login ing..."}` | 继续轮询 |
| 已扫码 | `{"code": 0, "data": {"accessToken": ...}}` | 提取 token |
| 补资料 | `/login/account` → uid/nickname/uin | 写 vault |

用户扫码后实测拿到完整账号：
```json
{"done": true, "account": {"uid": "...", "nickname": "<某账号>", "uin": "..."}}
```

### 修复：vault 里同一账号存了两份

**现象**：`<某账号>` 在 vault 里出现两次，过期时间不同。

**根因**：accountId 有两套生成规则：

| 来源 | accountId |
|---|---|
| 扫码登录 | `uid.replace(/-/g,"").slice(0,24)` → `<newAccountId>` |
| 从 dsh 导入 | dsh 自己的 hash → `<dshAccountId>` |

同一个 uid 生成了两个文件名。

**修法**：`writeVaultFile` 写之前按 **uid** 查重，删掉同 uid 的旧文件：

```javascript
if (uid !== "") {
  for (const old of listVaultFiles(region)) {
    if (old.accountId === accountId) continue;
    const prev = readVaultFile(old.path);
    if (prev && prev.uid === uid) unlinkSync(old.path);
  }
}
```

已清理现有重复（保留过期时间最晚的那份）。

### 修复：qoder 模型名看不懂

**之前**：直接显示上游代号
```
Qoder 国内 · qfmodel
Qoder 国内 · dfmodel
```

**问题**：后端 `/v3/models` 早就返回了 `display` 字段，前端没用：

```json
{"id": "qoder-cn/qfmodel", "display": "Qwen3.8-Flash"}
```

**修法**：`prettyModelName(id, display)` 优先用 display，并按区域加前缀：

| 之前 | 现在 |
|---|---|
| ~~Qoder 国内 · qfmodel~~ | **国内 · Qwen3.8-Flash** |
| ~~Qoder 国内 · dfmodel~~ | **国内 · DeepSeek-Flash** |
| ~~Qoder 国内 · gfmodel~~ | **国内 · GLM-5.3-Flash** |
| ~~Qoder 国内 · mmodel~~ | **国内 · MiniMax-M3.1-Flash** |
| ~~Qoder 国际 · ultimate~~ | **国际 · Ultimate** |

兜底：后端没给 display 时查代号别名表（qfmodel→Qwen3.8-Flash 等）。

### 修复：CSS 优先级导致 hidden 失效

```css
.qregion-bar { display: flex; }   /* 类选择器覆盖了 [hidden] 的默认 display:none */
```

结果「Qoder 区域」按钮在所有 shim 下都显示，不只是 Qoder。

修法：加全局规则
```css
[hidden] { display: none !important; }
```

同时影响并修复了 `.modal[hidden]`（原本有专门补救，没暴露）。

### 改进：明确「只有 WorkBuddy 支持多账号」

**按钮文字**：`扫码添加` → `WorkBuddy 扫码添加`

**账号池顶部加说明框**：
> 适用范围：账号池、扫码登录、余额查询**只对 WorkBuddy 有效**。
> Trae / Qoder / 视觉轮换 / LLM 池 用的是各自客户端里登录的那一个账号，不支持多账号。

后端本来就是硬编码 `workbuddy`，传别的 shim 名也调不到。

### 简化：扫码弹窗去掉冗余元素

用户反馈「是不是多余了一个就行了」。

改前：官方按钮 + 链接输入框 + 复制按钮
改后：**只有官方按钮**（它打开的就是那个链接）

优化效果：少 2 个交互元素，少 4 处 JS 引用。

### 验证

| 检查 | 结果 |
|---|---|
| 扫码登录完整链路 | ✅ 用户实扫，拿到 token |
| 未扫码返回 11217 | ✅ 正确继续轮询 |
| vault uid 去重 | ✅ 只剩 5 个账号 |
| qoder 显示真实名称 | ✅ 25/25 有 display |
| [hidden] 生效 | ✅ 7 个元素初始状态正确 |
| 无第三方域名 | ✅ 已清除 |
| 语法 | ✅ 全过 |

---

## [1.6.0] — 2026-11-07

### 新增：多账号池 + 扫码登录 + 余额查询

**这是本轮最大的功能块。**

#### 多账号 vault

账号存在独立目录，按区域分：

```
<插件>/shims/.vault/
├── cn/<accountId>.json       国内账号（token 明文，0600）
└── global/<accountId>.json   国际账号
```

**不碰 dsh-connect-workbuddy 的 vault**，但可以从它导入。

#### 三种添加方式

| 方式 | 说明 |
|---|---|
| **自动检测** | 扫描 `DSH_HOME`、`~/.dsh`、各盘符的 `dev/dsh-home` 等常见位置 |
| **手动指定** | 粘贴 vault 文件夹路径 |
| **扫码登录** | 复刻 dsh 的 OAuth 流程，手机扫码拿 token |

**自动检测会报告「找过哪些位置」**，没找到时用户知道该去哪找。

#### 额度用尽自动换号

```
请求 → 当前账号
        ↓ 14018 / 1113（额度问题）
   冷却 30 分钟，换同区下一个账号
        ↓ 同区没了
   跨区兜底（可关：WB_CROSS_REGION=0）
        ↓ 都不行
   如实报错
```

响应头标记：

| 头 | 值 | 含义 |
|---|---|---|
| `X-WB-Fallback` | `account-switch` | 同区换号 |
| `X-WB-Fallback` | `cross-region` | 跨区 |
| `X-WB-Account` | 账号前缀 | 这次用的哪个 |

#### 余额查询

上游接口：`POST {billingBase}/v2/billing/meter/get-user-resource`

协议参考 dsh-connect-workbuddy/scripts/probe-credits.mjs（MIT）。

界面显示每个账号的剩余积分，缓存 5 分钟，`?balance=0` 可跳过。

实测对上用户 dsh 面板的数字：1167 / 1191 / 0 / 1937。

#### 账号测试

每个账号一个「测试」按钮：发一个最小请求（hy3, max_tokens=16），
回报延迟 + 当前积分 + 是否正常。能区分额度用尽/超时/网络错误。

### 新增：WebUI 页面（挂到「扩展功能」）

`pages/本机模型接入/` 三个标签页：

**账号池**
- 国内 / 国际分区切换
- 每个账号显示：昵称、账号 id、有效期剩余天数、**积分大字**
- 操作：切换 / 测试 / 删除
- 扫码添加（弹窗 + 二维码 + 轮询）

**模型名册**
- WorkBuddy 国内/国际、Qoder、Trae 分组选择
- Qoder 支持「全部 / 国内版 / 国际版」过滤（11 + 14 个）
- 按「免费 → 成本 → 延迟」排序
- 两级显示：可读名 + 原始 id
- 勾选启停 + 保存

**耗费**
- 累计 credit / 调用数 / 失败数
- 按账号统计 + 按模型统计
- 重置

### 新增：5 个 shim 全部支持耗费统计

之前只有 workbuddy 有 `/cost`。现在 trae / qoder / vision / llm-pool 都有：

| shim | 统计文件 |
|---|---|
| workbuddy | `.wb-cost.json` |
| trae | `.trae-cost.json` |
| qoder | `.qoder-cost.json` |
| vision | `.vision-cost.json` |
| llm-pool | `.llm-pool-cost.json` |

全部加入 `.gitignore`。

同时放开了 `main.py` 里 `startswith("workbuddy-shim")` 的限制。

### 新增：select-models 保存后立刻重新注册

之前只写配置文件，AstrBot 的模型下拉不会变，必须重载插件。

现在：

```python
conf_path.write_text(...)                       # 保存配置
await self._unregister_providers(name)          # 注销旧的
await self._register_provider(name)             # 按新配置注册
conf.save_config()                              # 写入 AstrBot 配置
```

返回带 `reregistered` 字段，失败也有 `reregisterError`（配置仍已保存）。

### 修复：推理模型 content 为空

**问题**：`hy4-preview` 这类模型只吐 `reasoning_content`，`content` 恒为 `null`。
下游只读 `content` 就会认为「模型返回空」，白白用掉一次 fallback 重试。

**修法**（三个 shim 都加）：

```javascript
let finalContent = content;
if ((finalContent === "" || finalContent === null) && reasoning) {
  finalContent = reasoning;
  contentFromReasoning = true;
}
const message = { role: "assistant", content: finalContent || null };
if (reasoning) message.reasoning_content = reasoning;
if (contentFromReasoning) message._content_from_reasoning = true;
```

`reasoning_content` 仍保留，能区分「这句是思考过程」的客户端不受影响。
正常模型不触发（实测 glm-5.2 / deepseek-v4.1-flash / space-bunny / hy3 都是原生）。

### 修复：8 个路由不处理 query string

用户报 `GET /v3/models?force=1` 返回 404。

根因：路由条件只做全等匹配，带 query 时过不了 `url === "/v3/models"`。

同一文件 8 个路由都有这个问题，全部加 `startsWith("?")`：

`/v3/models` `/v1/models` `/cost/reset` `/refresh-models`
`/v1/chat/completions` `/healthz` `/debug-v3-config`

`force` 判定也改成正则，兼容 `?force=1&x=y`。

### 修复：API 路径少了 /v1

文档和代码里全写的 `/api/plugins/extensions/`，实际是
`/api/v1/plugins/extensions/`。导致所有页面请求 404。

### 修复：路由名用连字符但前端用斜杠

`accounts-scan` vs `accounts/scan`，全部改成斜杠形式与前端一致。

### 修复：qoder / trae 缺 import

注入耗费统计时漏了 `fileURLToPath` / `writeFileSync`，导致进程起不来。

### 修复：intl 区 /v1/models 显示 source: probe

根因不是 intl 拿不到名册，是 `/v1/models` 只用 `rosterCache` 缓存值，
而缓存只在调过 `/v3/models` 之后才有 → 永远退回探测结果。CN 区也一样。

改为主动拉名册，加了启动预热。

### 修复：cost: 0 但实际扣费

`/v3/models` 里 kimi 三个标 `cost=0 / free=true`，实测每次扣钱：

| 模型 | 实测 |
|---|---|
| kimi-k3-1 | 0.46/次 |
| kimi-k3.1-pro | 0.365/次 |
| kimi-k2.8-preview | 0.17/次 |

`MODEL_CATALOG` 改按实测填，加 `verified` 字段区分「有实测」和「按上游推测」。

### 文档

- README 加「账号池」章节 + 「多账号池化：风险显著升高」警告
- 新增 `模型管理说明.md`（5.2KB / 8 章节）
- SKILL.md 写入发布纪律（只有用户明确说「推送」才 push）

### 验证

| 检查 | 结果 |
|---|---|
| 5 个 shim /cost | ✅ 全部 200 |
| 实际调用记录 | ✅ trae / qoder 都记录 |
| 账号列表 + 余额 | ✅ 5 个账号全部查到 |
| 扫码登录 | ✅ 拿到真实授权链接 |
| select-models 自动注册 | ✅ reregistered: true |
| 模型名册 3 家 | ✅ 23 / 18 / 25 |
| 推理模型兜底 | ✅ hy4-preview 有内容了 |
| 正常模型不误触 | ✅ 5 个模型全原生 |
| hy4-preview 从 fallback 移除 | ✅ 10 个配置 |
| Python / JSON / 5 shim / app.js | ✅ |
| 安全扫描 | ✅ 干净 |

---

## [1.5.4] — 2026-11-05

### 新增：跨区兜底（额度用尽自动换区）

**问题**：用户报 502，上游返回 `code 14018 额度已用尽`。

查下来发现：**CN 区和 intl 区是两个独立账号，额度分开算**。

| 区 | uid | 过期时间 |
|---|---|---|
| CN | `<uid>` | 2026-11-12 |
| INTL | `<另一个 uid>` | 2027-10-14 |

实测同一时刻：

| 模型 | CN 区 | INTL 区 |
|---|---|---|
| `glm-5.3-flash` | ❌ 14018 额度用尽 | ✅ 正常 |
| `hy3` | ✅ 正常 | ✅ 正常 |

**之前 shim 完全不知道另一个区的存在** —— `resolveCredential()` 只按
`REGION` 挑一个文件，没有跨区逻辑。

### 实现

额度类错误（`14018` / `1113` / `6004` / `6005`）时，自动用对端区的凭据重试：

```
CN 区 glm-5.3-flash → 14018
    ↓ 自动切
INTL 区同模型 → 200 ✅
```

新增：

| 项 | 说明 |
|---|---|
| `resolvePeerCredential()` | 读对端区的 auth 文件并解密 |
| `isQuotaError()` | 识别额度类错误（不误伤普通失败） |
| `CROSS_REGION` | 开关，`WB_CROSS_REGION=0` 关掉 |

**只在额度类错误时触发** —— 401/超时/空内容不跨区，避免无谓重试。

### 响应头标记

跨区成功时返回：

```
X-WB-Region: global
X-WB-Fallback: cross-region
```

不跨区的正常响应没有这两个头，排障时一眼能看出走没走兜底。

### 实测

| 场景 | 结果 |
|---|---|
| CN 区 glm-5.3-flash（额度用尽） | ✅ 自动切 intl，返回 200 + `X-WB-Fallback: cross-region` |
| INTL 区 hy3 / glm-5.3-flash / hy4free / kimi-k3 | ✅ 本区直接成功，未触发跨区 |

### 说明：不是"多个账号轮换"

凭据文件里 `accounts` / `allAccounts` 都只有 **1 条**，没有多账号可轮换。
能跨的只有 CN ↔ INTL 这两个区（各自一个账号）。

想加更多账号，需要在客户端里登录多个账号 —— 但 WorkBuddy 桌面端
似乎只保留当前登录那个。

---

## [1.5.3] — 2026-11-05

### 修复：8 个路由不处理 query string

**用户报的 bug**：`GET /v3/models?force=1` 返回 404。

根因：路由条件只做全等匹配，带 query 时 `url` 是 `/v3/models?force=1`，
过不了 `url === "/v3/models"` → 直接 404。
里面那句 `const force = url.includes("force=1")` 成了死代码。

**同文件 8 个路由都有这个问题**，全部修复：

| 路由 | 修复 |
|---|---|
| `/v3/models` | ✅ 加 `startsWith("/v3/models?")` |
| `/v1/models` | ✅ |
| `/cost/reset` | ✅ |
| `/refresh-models` | ✅ |
| `/v1/chat/completions` | ✅ |
| `/healthz` | ✅ |
| `/debug-v3-config` | ✅ |
| `/cost` | 本来就对（`startsWith("/cost?")`） |

`force` 判定也改成正则，兼容 `?force=1&x=y`：

```javascript
const force = /[?&]force=(1|true|yes)\b/i.test(url);
```

### 修复：cost: 0 但实际扣费

`/v3/models` 里 kimi 三个标 `cost=0 / free=true`，但实测每次扣钱：

| 模型 | 实测 | 之前的标注 |
|---|---|---|
| kimi-k3-1 | 0.46/次 | ❌ 免费 |
| kimi-k3.1-pro | 0.365/次 | ❌ 免费 |
| kimi-k2.8-preview | 0.17/次 | ❌ 免费 |

**根因**：名册返回的 `cost` 字段不代表实际计费。
只有 `codewise-jump` 是实测确认真免费（4 次调用 credit 精确为 0）。

`MODEL_CATALOG` 现在按**实测**填，并加 `verified` 标记：

```javascript
{ id: "codewise-jump", cost: 0,    verified: true,  note: "真免费 · 4次调用 credit 精确为 0" }
{ id: "kimi-k3-1",     cost: 0.46, verified: true,  note: "实测 0.46/次" }
{ id: "glm-5.2",       cost: 0,    verified: false, note: "名册标 0，未大量实测" }
```

`verified: true` = 有实测证据，`false` = 按上游推测。

### 新增：/cost 加 costPerCall

```json
{
  "model": "kimi-k3-1",
  "calls": 2,
  "credit": 0.3,
  "costPerCall": 0.15,
  "free": false,
  "measured": true
}
```

`free` 现在按**实测**算：`calls > 0 && credit === 0`。
没调用过的 `measured: false`、`free: false`（不猜测）。

### 增强：/healthz

原来只有 `{ok, region, port}`，现在：

```json
{
  "ok": true,
  "region": "cn",
  "port": 8787,
  "modelsSource": "v3/config",
  "modelCount": 23,
  "rosterFetchedAt": "2026-11-05T07:00:46.703Z",
  "costTotal": 0.4,
  "costCalls": 16,
  "verifiedFreeModels": ["codewise-jump", "hy4free", ...]
}
```

并加**启动预热**：shim 起来就拉一次名册，`modelsSource` 立刻是 `v3/config`，
不用等第一次查询。

### 文档：kimi 必须带 system

两个坑叠加，代码注释写清了：

- 坑 A：补 `content:""` 的空 system → 上游当"空内容"报 11151
- 坑 B：kimi 系列（k3-1 / k3.1-pro / k2.8-preview）**必须**带 system，不带也 11151

排查提示：**看到 11151 先怀疑「system 缺失或为空」**，别看错误码字面意思。

`codewise-jump` 不需要 system，加了也不影响。

### 修复：intl 区 /v1/models 显示 source: probe

原来 `/v1/models` 只判断 `rosterCache` 有没有值，而 `rosterCache` 只在
调过 `/v3/models` 之后才有 —— 所以 AstrBot 调 `/v1/models` 时永远退回
`ACTIVE_MODELS`（探测缓存），`source` 显示 `probe`。

**CN 区和 intl 区都一样**，不是 intl 拿不到名册。

实测 intl 区能正常拉 `/v3/config`（21 个模型，含 GPT-6 / Gemini 3.8 / Grok 4.7，
但这些模型的账号权限不足，11158）。

修复：`/v1/models` 主动拉名册，失败才退回。名册也加了排序（免费 → 成本 → 延迟）。

### 新增：模型管理说明文档

`模型管理说明.md`（5.2KB，8 章节）—— 覆盖五个能力的用法、接口、实测数据。

### 验证

| 检查 | 结果 |
|---|---|
| `?force=1` 返回 200（原来 404） | ✅ |
| `?force=1&x=y` 也通 | ✅ |
| 8 个路由全部支持 query | ✅ |
| kimi 三个模型实测扣费已记录 | ✅ 0.46 / 0.365 / 0.17 |
| costPerCall 字段 | ✅ |
| /healthz 显示 v3/config + 名册时间 | ✅ |
| 启动预热名册 | ✅ |
| kimi 带 system 后正常（11151 消失） | ✅ |
| Python / JSON / 5 个 shim 语法 | ✅ |

---

## [1.5.2] — 2026-11-05

### 新增：官方模型名册 + 耗费统计

之前找模型只能靠「撞名字」（`/refresh-models` 探测 40 个候选）。
实际上游有官方接口，只是**需要正确的 User-Agent** —— 缺了会报
`code 12403 "check ua, get coding copilot version error"`。

补上 UA 后 `/v3/config` 返回完整名册，本次接进 shim。

### 新接口（shim 侧）

| 接口 | 方法 | 作用 |
|---|---|---|
| `/v3/models` | GET | 官方模型名册（23 个模型 + 6 个促销活动） |
| `/cost` | GET | 耗费统计（按模型累计 credit） |
| `/cost/reset` | POST | 重置耗费统计 |

`/v1/models` 现在优先用名册（响应里 `source: "v3/config"`），
拿不到才退回探测结果（`source: "probe"`）。

### 新接口（插件侧）

```
GET  .../models?name=workbuddy&force=1     查名册
GET  .../cost?name=workbuddy               查耗费
POST .../cost-reset  {"name":"workbuddy"}  重置耗费
```

### 关键发现：hy4 分两个版本

| 模型 | 延迟 | 1000 token 输出 | credit |
|---|---|---|---|
| **`hy4free`** | 5521ms | 1000 | **0**（免费） |
| **`hy4std`** | 3499ms | 1000 | **0.29**（付费） |

之前测试的 `hy4` 其实就是 `hy4std`，所以一直以为 hy4 要钱。

### 完整名册（23 个）

实测 17 个可用，按「免费优先 + 速度」排序：

| 模型 | 延迟 | credit |
|---|---|---|
| glm-5.2 | 1499ms | 0 |
| space-bunny | 1532ms | 0 |
| hy3-b | 1596ms | 0 |
| hy3-c | 1617ms | 0 |
| hy3-x | 1904ms | 0 |
| deepseek-v4.1-flash | 2088ms | 0 |
| hy3 | 2133ms | 0 |
| deepseek-v4-flash | 2161ms | 0 |
| minimax-m3.1-flash | 2173ms | 0.01 |
| deepseek-v4-pro | 2281ms | 0 |
| auto | 2330ms | 0 |
| step-5-preview | 2718ms | 0.02 |
| glm-5.3-flash | 2898ms | 0 |
| glm-5.3 | 3107ms | 0.01 |
| hy4std | 3499ms | 0.06 |
| hy4free | 5521ms | 0 |
| mimo-v2.6-pro | 7078ms | 0 |

**不可用**（502 权限不足）：`deepseek-v4-flash-ioa`、`deepseek-v4-pro-ioa`、
`kimi-k2.8-preview`、`kimi-k3-1`、`kimi-k3.1-pro`

### 促销活动（名册里带的）

- 每晚 23:00—次日 8:00 积分限时 5 折（glm-5.2）
- 7月6日–11月15日 每日赠送免费额度

### 说明：credit 有波动

同一模型不同次调用 credit 不完全一致（glm-5.2 有 0 也有 0.02）。
可能是缓存命中/未命中差异，或上游动态调价。
**以 `/cost` 的实际累计为准**，不要看单次。

### 验证

| 检查 | 结果 |
|---|---|
| `/v3/models` 拉取 | ✅ 23 个模型 + 6 个促销 |
| `/v1/models` 标 source=v3/config | ✅ |
| `/cost` 按模型累计 | ✅ hy4std 0.29 / hy4free 0 / glm-5.2 0.02 |
| `/cost/reset` | ✅ |
| **hy4free 输出 1000token 仍 credit=0** | ✅ 确认免费 |
| **hy4std 同样输出扣 0.29** | ✅ 确认付费 |

---

## [1.5.1] — 2026-11-05

### 新增：hy3 / hy4 模型，目录按「速度优先」重排

`workbuddy-shim` 的模型目录加入 `hy3`、`hy4`（腾讯混元），
并按**实测速度**重新排序。

### 实测数据（固定 prompt，各 3 次取中位数）

| 模型 | 延迟 | credit | 说明 |
|---|---|---|---|
| kimi-k2.6 | 1416ms | 0 | 最快，免费 |
| deepseek-v4.1-flash | 2004ms | 0 | 免费 |
| glm-5.3-flash | 2081ms | 0.01 | 极便宜 |
| space-bunny | 2212ms | 0 | 多模态，免费 |
| **hy3** | 2244ms | **0** | 混元，**免费**，带 reasoning |
| minimax-m3.1-flash | 2426ms | 0 | 免费 |
| **hy4** | 3718ms | **0.02** | 混元推理，**按量计费** |
| deepseek-v4-pro | 4496ms | 0.01 | 深度推理，慢 |

### 关键结论：hy3 免费、hy4 要钱

验证方法：同一模型跑「小输出」和「大输出」，看 credit 是否随量涨。

| 模型 | 小输出(57tok) | 大输出(3000tok) | 结论 |
|---|---|---|---|
| **hy3** | credit 0 | credit **0** | 真免费（不计费） |
| **hy4** | credit 0.02 | credit **0.42** | 按 token 计费 |

hy4 大输出时 credit 涨了 20 倍，确认是按量扣费。
hy3 输出 3000 token 仍然 0，确认免费。

### 新目录顺序

```
1. kimi-k2.6            1.4s  免费
2. deepseek-v4.1-flash  2.0s  免费
3. glm-5.3-flash        2.1s  0.01
4. space-bunny          2.2s  免费
5. hy3                  2.2s  免费      ← 新增
6. minimax-m3.1-flash   2.4s  免费
7. hy4                  3.7s  0.02      ← 新增
8. deepseek-v4-pro      4.5s  0.01
```

**排序原则：速度优先，同速看成本。**

hy4 虽然支持图片推理且带 reasoning，但 3.7s + 按量计费，所以排在后面 ——
需要推理能力时手动指定即可，日常对话用不上。

### 能力补充

`hy4` / `hy4-preview` 的 `modalities` 补上 `image`（实测支持图片推理）。

实测：64×64 左红右蓝图，hy4 正确回答「左边的图形是红色，右边的图形是蓝色」，
reasoning 里还提到图形轮廓细节。

### 验证

| 检查 | 结果 |
|---|---|
| hy3 调用 | ✅ 2431ms，credit=0 |
| hy4 调用 | ✅ 3075ms，credit=0.03 |
| 两者都正确自述「混元，腾讯开发」 | ✅ |
| AstrBot 配置里 hy3/hy4 已注册 | ✅ |
| hy4-preview 未被误删 | ✅ 已恢复 |
| 其他 source 的 provider 未受影响 | ✅ 共 67 个 |

---

## [1.5.0] — 2026-11-05

### 新增：自动调节（health score）

**问题**：原来的 `priority` 是静态的。你在配置里排第一的模型如果长期超时，
每次请求还是要先撞它一遍，白等十几秒才降级到能用的。

**现在**：每个目标维护一个健康分（0~100），按分数动态排序。

### 打分规则

| 事件 | 分数变化 | 说明 |
|---|---|---|
| 成功 | **+5** | 加得慢，避免一次偶然就冲回高位 |
| **超时** | **−25** | 扣得最狠，因为用户等不起 |
| 其他失败 | −12 | 空内容 / 5xx / 解析失败等 |

初始分 70。四个数值都能在配置里调。

### 排序规则

```
按健康分从高到低
  同分 → 按「优先级列表」的顺序
```

**效果**：

- 你排第 1 的模型如果一直超时，分数会掉下去，自动沉到最后
- 原本排第 2、3 的往上浮，成为首选
- 下沉的模型只要成功一次，就开始慢慢爬回来（+5/次）

### 持久化

分数写到 shim 同目录的 `.vision-health.json` / `.llm-pool-health.json`：

```json
{
  "updatedAt": "2026-11-05T05:43:02.402Z",
  "scores": {
    "workbuddy_shim/minimax-m3.1-flash": 40,
    "zhipu_vision": 70
  }
}
```

**重启不丢** —— 否则每次重启都回到初始状态，学不到东西。

### 新增配置（`vision` / `llm_pool` 两组都有）

| 配置 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `auto_tune` | bool | `true` | 自动调节开关 |
| `timeout_penalty` | int | 25 | 超时扣分（1~100） |
| `fail_penalty` | int | 12 | 普通失败扣分（1~100） |
| `recover_step` | int | 5 | 成功加分（1~100） |
| `initial_score` | int | 70 | 初始分（0~100） |

### 新增 API

| 接口 | 方法 | 作用 |
|---|---|---|
| `.../health?name=vision` | GET | 查健康分与当前排序 |
| `.../reset-health` | POST | 重置所有目标回初始分 |

`health` 返回里每个目标带：

```json
{
  "rank": 1,           // 当前实际尝试顺序
  "base_rank": 3,      // 你在配置里排的位置
  "id": "...",
  "score": 85,
  "timeout_streak": 0, // 连续超时次数
  "ok": 12, "fail": 1
}
```

**`rank` 和 `base_rank` 不同，就说明自动调节在起作用。**

### shim 侧实现

`vision-shim.mjs` / `llm-pool-shim.mjs` 同步改造：

- 新增 `SCORE_MAX/MIN`、`RECOVER_STEP`、`TIMEOUT_PENALTY`、`FAIL_PENALTY`、`INITIAL_SCORE`、`AUTO_TUNE`
- `loadHealth()` / `saveHealth()` / `clampScore()`
- 每个 target 增加 `baseRank`（原始位置）、`score`、`timeoutStreak`
- 超时判定：`status === 0` 或 detail 匹配 `AbortError|aborted|timeout|TimedOut|ETIMEDOUT`
- 排序改为 `sort((a,b) => (b.score - a.score) || (a.baseRank - b.baseRank))`
- 新增 `POST /reset-health`

### 验证

| 检查 | 结果 |
|---|---|
| 默认值（auto_tune=true，参数 25/12/5/70） | ✅ |
| 自定义值生效 | ✅ |
| 边界夹紧（999→100、0→1、abc→5、-5→0） | ✅ |
| 超时扣 30 分（70→40） | ✅ |
| 分数持久化到文件 | ✅ |
| 按分数重排（低分沉底、高分浮顶） | ✅ |
| 实际请求跳过死端口命中可用目标 | ✅ |
| `/reset-health` 恢复初始分 | ✅ |

---

## [1.4.8] — 2026-11-05

### 文档：清除本机日志数据

**问题**：之前的 CHANGELOG / TROUBLESHOOTING 里直接贴了作者本机的运行日志，
包括账号状态、调用统计、真实错误响应。这些属于个人数据，不该进公开仓库。

### 清理内容

| 类型 | 原来写的 | 现在 |
|---|---|---|
| 账号状态 | 点名某 provider「余额不足 / quota 超限」 | 「账号额度类错误」「配额类错误」 |
| 调用统计 | OK/FAIL 具体数字 + 成功率百分比 + 平均耗时 | 「按你自己的日志统计」+ 脚本模板 |
| 真实日志片段 | 完整错误 JSON | 日志行格式说明 + 占位 |
| 探测结果 | 具体发现哪 10 个模型 | 「取决于你账号的可用范围」 |
| provider 名 | 作者的 zhipu / intern 等 | `<source_id>/<model>` 占位符 |
| 实测日期 | 「2026-11-04 统计」 | 删除具体日期 |

### 保留的部分

以下属于**协议知识**，对别人排障有用，保留：

- 错误码含义（`11101` stream 被拒、`11128` role 被拒、`10605` 排队、
  `11154` 附件超限）—— 这是上游协议的固定行为，不是个人数据
- 通用错误类型识别（欠费类 / 配额类 / 排队类 / 空内容类）
- 统计脚本模板（别人跑自己的日志用）

### 顺带标注

README / SKILL 里的模型对照表加了「内置默认」标注，
避免被误读成「作者的实测结果」—— 这些是编译进 shim 的默认值，所有用户一样。

### 验证

| 检查 | 结果 |
|---|---|
| 账号状态描述 | ✅ 0 处 |
| 具体成功率 / 调用次数 | ✅ 0 处 |
| 真实错误 JSON | ✅ 0 处 |
| 作者专属 provider 名 | ✅ 0 处 |
| 实测日期 | ✅ 0 处 |
| 协议错误码（应保留） | ✅ 保留 |

---

## [1.4.7] — 2026-11-05

### 文档：把 ToS / 封号风险提到最醒目的位置

审查意见：「该做法本质是复用桌面端订阅额度，可能违反相关客户端服务条款，
作者应在 README 中更醒目地提示风险」。

原 README 的风险提示有两个问题：
1. 位置在文末「免责声明」，读者可能看完功能介绍就走了
2. 开头虽有 `[!WARNING]`，但和「白嫖」宣传文案挤在一起，视觉上不突出

### 改动

**1. 顶部换成 `[!CAUTION]` 大块横幅**（GitHub 渲染为醒目的红色框）：

- 直接点明「复用订阅额度 = 绕过官方 API = 可能违反 ToS」
- 5 项后果表：限流 / 警告 / **封号** / 订阅终止 / 插件失效，各带概率
- 明确「作者明确不承担」四条
- 「如果你决定用」四条实操建议
- 「这不等于破解」—— 但强调「你付过钱」≠「厂商允许」

**2. 文末免责声明重写**，从 3 个小节扩到 7 个大节：

| 节 | 内容 |
|---|---|
| 一、做了什么 | 调用链示意，点明「不是公开 API」 |
| 二、可能违反 ToS | 引用三家常见条款类型（非官方客户端/自动化/绕过计费/逆向） |
| 三、可能后果 | 5 项后果表 + 关于「封号」的诚实说明 |
| 四、不承担的责任 | 4 条 ❌ |
| 五、不等于破解 | 4 维对比表（账号来源/付费/凭据流向/是否篡改） |
| 六、降低风险 | 5 条实操 |
| 七、分发注意 | 保留声明与署名 |

**3. 中段「为什么这是白嫖而不是破解」的警示改为独立 `[!WARNING]` 块**，
强调「你付过钱」≠「厂商允许你这么用」。

### 关于「封号」的措辞

没有见过这三家因本插件封号的公开案例，但也无法保证不会发生。
README 里的表述是「**存在可能**」而非「一定会」，并说明：

> 厂商有完全的判定权，且通常不提供申诉细节。

这样既不夸大也不淡化。

### 验证

| 检查 | 结果 |
|---|---|
| 顶部 `[!CAUTION]` 横幅 | ✅ |
| 后果表含 5 项（含「封号」） | ✅ |
| 文末免责声明 7 节 | ✅ |
| 中段 `[!WARNING]` 独立块 | ✅ |
| 3 处 `#免责声明` 锚点全部有效 | ✅ |
| 「封号」关键词出现 6 次 | ✅ |

---

## [1.4.6] — 2026-11-05

### 清理：删除死代码

`main.py` 里的同步版 `_pid_listening_on()` / `_kill_pid()` 是 v1.4.2
异步化改造时留下的兼容版本，改完后**引用数为 0**。

| 方法 | 引用数 | 处理 |
|---|---|---|
| `_pid_listening_on()`（同步） | 0 | 删除 |
| `_kill_pid()`（同步） | 0 | 删除 |
| `_pid_listening_on_async()` | 5 | 保留 |
| `_kill_pid_async()` | 3 | 保留 |

净减少 64 行 / 2152 字符。

### 验证

| 检查 | 结果 |
|---|---|
| 删除后无遗留引用 | ✅ 两个方法名出现 0 次 |
| Python 语法 | ✅ |
| `_pid_listening_on_async` 探测端口 | ✅ 8787→9704、8788→11560、空闲→None |
| `port_free_async` | ✅ |
| `_status_text` 异步返回 | ✅ 11 行，含运行标记 |
| `_stop_by_port` 仍是 async | ✅ `iscoroutinefunction=True` |

---

## [1.4.5] — 2026-11-05

### 新增：hy4（腾讯混元推理模型）

`workbuddy-shim` 的模型目录新增 `hy4`。

**实测能力**（经 shim 转发）：

| 能力 | 结果 |
|---|---|
| 中文对话 | ✅ |
| 数学推理（23×17） | ✅ 391 |
| 长文本（200 字） | ✅ 341 字，`finish_reason: stop` |
| 流式 | ✅ 89 分片 |
| **工具调用** | ✅ `get_weather({"city":"北京"})` |
| **图片推理** | ✅ 认出「左红右蓝」，reasoning 里还提到图形轮廓 |

**这是推理模型**，思考过程走 `reasoning_content`：

```
max_tokens: 100  → reasoning_tokens: 100 → content: ""      ← 空
max_tokens: 3000 → reasoning_tokens: 377 → content: "我是混元..."  ← 正常
```

**必须给足 max_tokens**（建议 ≥2048），否则思考会吃光预算导致正文为空。

AstrBot 侧不会误判 —— `openai_source.py` L935-940 判定里
`has_reasoning_output` 也算「有输出」。

### 新增：刷新模型（并发探测）

**为什么需要**：上游（WorkBuddy / Trae / Qoder）**都没有 `/v1/models` 接口**
（实测全部 404），模型清单只能靠名字撞。

**实现**：

- shim 侧新增 `POST /refresh-models`
  - 读 `PROBE_CANDIDATES`（约 40 个候选名，覆盖混元/DeepSeek/通义/智谱/MiniMax/Kimi/字节/小米等）
  - 并发度 4 探测，每个 30 秒超时
  - 判断标准：HTTP 200 且响应里无 `error` 字段
  - 结果写入 `.wb-models.json`（shim 脚本同目录）
  - 下次启动自动读缓存，不用重探
- 插件侧新增 `POST /api/plugins/extensions/astrbot_plugin_shim_connector/refresh-models`
  - 转发到对应 shim 的 `/refresh-models`
  - 请求体 `{"name":"workbuddy"}`（默认 workbuddy，也支持 workbuddy_intl）

**实测**：探测速度和命中数量取决于上游当时的可用性。
发起后约 10-30 秒完成，返回当前真正可用的模型 id 列表。

> 具体发现哪些模型，取决于你账号的可用范围，不同账号结果可能不同。

### 补回流：vision 图片体积保护

**部署副本里有一段本地改的代码从没提交过**（2026-11-05 04:13 改的），
本次一并回流：

- `MAX_IMAGE_BASE64_BYTES`（默认 4MB，环境变量 `VISION_MAX_IMAGE_B64` 可覆盖）
- `shrinkOversizedImages()`：请求进来先检查 `messages` 里所有 `data:base64` 图片
- 超限直接返回 **413 `image_too_large`**，不再转发

**为什么重要**：上游对附件有体积上限（超了报 `code 11154`）。
原来的行为是转发过去、等十几秒超时、还被记一次 failCount，
把好候选的成功率拖低。现在本地就拦掉，快速失败。

### 新增配置

无新增配置项。刷新结果自动落盘，AstrBot 侧把 `models` 留空（= 全部）即可注册新模型。

图片体积上限可用环境变量 `VISION_MAX_IMAGE_B64` 调整（默认 4000000 字节 ≈ 4MB base64）。

### 验证

| 检查 | 结果 |
|---|---|
| `/v1/models` 含 hy4 | ✅ |
| hy4 中文/数学/长文本/流式/工具调用 | ✅ |
| hy4 图片推理 | ✅ |
| `/refresh-models` 探测 | ✅ |
| 探测结果落盘 | ✅ `.wb-models.json` |
| 重启后从缓存加载 | ✅ 日志「使用上次探测结果 10 个模型」 |
| 新发现模型实测对话 | ✅ |
| 部署副本同步 | ✅ |

---

## [1.4.4] — 2026-11-04

### 新增：视觉轮换层支持优先级

`vision_rotator` 原来只有固定顺序轮换，而且顺序是按「功能差异」排的，
没有考虑实际可靠性 —— 稳定性最差的两个排在最前，每次请求都要先等它们失败再降级。

现在与 `llm_pool` 一致，支持两种策略（默认 **priority**）：

| 策略 | 行为 |
|---|---|
| **priority**（默认） | 严格按优先级列表，前面的能用就一直用；冷却或连续失败达阈值才降级 |
| roundrobin | 每次换下一个，均摊负载 |

### 默认顺序调整

原默认顺序把**稳定性最差的两个**排在最前，导致每次请求都要先等它们失败再降级。

新默认顺序按「实测可靠性」从高到低排：

**workbuddy_shim → workbuddy_intl → zhipu → intern_qwen → qoder**

> 具体成功率取决于你自己的账号状态和上游负载，不在此列出。
> 想按自己的实际情况排序，用 `priority` 配置项传入自定义顺序即可。

### 新增配置项（`vision` 分组）

| 配置 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `strategy` | 下拉 | `priority` | 轮换策略 |
| `priority` | list | 空 | 优先级列表，**靠前的先用**；留空用上面那个内置顺序 |
| `fail_threshold` | int | 2 | 连续失败几次就降级到最后（1~20） |

### 实现

- shim 侧（`vision-shim.mjs`）：
  - 读 `VISION_STRATEGY` / `VISION_TARGETS` / `VISION_FAIL_THRESHOLD`
  - priority 模式下 `failCount >= FAIL_THRESHOLD` 的排到最后
  - 成功一次重置 `failCount`
  - `/healthz` 返回 `strategy` / `fail_threshold` / 每目标 `rank` 与 `degraded`
- 插件侧（`main.py`）：
  - 新增 `_vision_strategy()` / `_vision_priority()` / `_vision_fail_threshold()`
  - `_start_shim()` 在 `name == "vision"` 时注入上述三个环境变量

### 说明：失败原因分析

原日志里的四类失败，性质不同：

| 错误 | 性质 | 处理 |
|---|---|---|
| 账号额度类错误 | 账号欠费/配额用尽 | 优先级调后，或充值 |
| 配额类错误 | 配额用尽 | 优先级调后 |
| `模型排队中` / `isQueued` | 上游繁忙 | 优先级调后 |
| `empty content` | 模型返回空 | 自动降级到下一个（已支持） |

**前三个不是代码 bug，是账号/上游状态。** 本次改动让它们排在后面，
不再拖慢正常请求。

### 排查过程（供以后复现）

**症状**：`vision_rotator/vision-auto` 全部候选失败。

**第 1 步：看 shim 日志**（不是插件日志）

```powershell
Get-Content "<AstrBot>\data\plugin_data\astrbot_plugin_shim_connector\vision.log" -Tail 30
```

日志每行格式：

```
[vision-shim] <provider_id> OK   <耗时>ms
[vision-shim] <provider_id> FAIL <耗时>ms: <上游原始错误>
```

`FAIL` 后面的内容就是上游返回的原始错误，直接能看出是哪一类问题。

**第 2 步：统计各候选成功率**

```python
import re
from collections import defaultdict

stat = defaultdict(lambda: {"ok": 0, "fail": 0, "ms": [], "reasons": set()})
for line in open(r"<AstrBot>/data/plugin_data/astrbot_plugin_shim_connector/vision.log",
                 encoding="utf-8"):
    m = re.search(r"\[vision-shim\] (\S+) (OK|FAIL) (\d+)ms(.*)", line)
    if not m:
        continue
    tid, res, ms, rest = m.groups()
    if res == "OK":
        stat[tid]["ok"] += 1
        stat[tid]["ms"].append(int(ms))
    else:
        stat[tid]["fail"] += 1
        if rest.strip(": "):
            stat[tid]["reasons"].add(rest.strip(": ")[:60])

for tid, s in sorted(stat.items(), key=lambda kv: -(kv[1]["ok"] / max(1, kv[1]["ok"] + kv[1]["fail"]))):
    total = s["ok"] + s["fail"]
    rate = s["ok"] / total * 100 if total else 0
    avg = sum(s["ms"]) // len(s["ms"]) if s["ms"] else 0
    print(f"{tid:40} OK={s['ok']:3} FAIL={s['fail']:3} {rate:5.1f}% {avg:5}ms")
```

输出直接给出该把谁排前面。

**第 3 步：确认 provider 是否还存在**

```python
import json
cfg = json.load(open(r"<AstrBot>/data/cmd_config.json", encoding="utf-8-sig"))
providers = {p["id"] for p in cfg.get("provider", [])}
# 换成你 priority 列表里的那些 id
for pid in ["<source_id>/<model>", "<另一个_provider_id>"]:
    print(("OK  " if pid in providers else "MISS") + " " + pid)
```

如果某个 provider 被删了，shim 启动时会打印 `跳过（provider 不存在）`。

### 关键区分：哪些能修，哪些不能

| 错误信息 | 性质 | 能否靠代码修 |
|---|---|---|
| 账号额度类错误 | 账号欠费 | ❌ 充值，或排到后面 |
| 配额类错误 | 配额用尽 | ❌ 等重置，或排到后面 |
| `模型排队中` / `isQueued` | 上游繁忙 | ❌ 排到后面 |
| `empty content` | 模型返回空 | ✅ 已自动降级 |
| `transport: AbortError` | 超时 | ✅ 已自动降级 |
| `401 Unauthorized` | 凭据失效 | ⚠️ 需重新登录客户端 |

**只有后三类值得改代码。前三类改代码没用，只能调顺序或换账号。**

### 验证

| 检查 | 结果 |
|---|---|
| vision 配置读取（默认/自定义/兜底） | ✅ |
| fail_threshold 0→1 | ✅ |
| shim 按自定义优先级启动 | ✅ 1.Q 2.zhipu 3.A |
| 默认顺序生效 | ✅ |
| 全部候选失败时的 503 响应含每个目标的失败原因 | ✅ |

---

## [1.4.3] — 2026-11-04

### 新增：LLM 池支持优先级

`llm_pool` 原来只有固定顺序的轮换（round-robin），没法指定「先用哪个」。
现在支持两种策略，默认 **priority**：

| 策略 | 行为 |
|---|---|
| **priority**（默认） | 严格按优先级列表，前面的能用就一直用；冷却或连续失败达阈值才降级 |
| roundrobin | 每次换下一个，均摊负载 |

### 新增配置项（`llm_pool` 分组）

| 配置 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `strategy` | 下拉 | `priority` | 轮换策略 |
| `priority` | list | 空 | 优先级列表，**靠前的先用**；留空用内置默认顺序 |
| `fail_threshold` | int | 2 | 连续失败几次就降级到最后（1~20） |

### 实现

- shim 侧（`llm-pool-shim.mjs`）：
  - 读 `LLM_POOL_STRATEGY` / `LLM_POOL_TARGETS` / `LLM_POOL_FAIL_THRESHOLD`
  - priority 模式下按列表顺序尝试；`failCount >= FAIL_THRESHOLD` 的排到最后
  - 成功一次重置 `failCount`
  - `/healthz` 现在返回 `strategy` / `fail_threshold` / 每个目标的 `rank` 与 `degraded`
- 插件侧（`main.py`）：
  - 新增 `_pool_strategy()` / `_pool_priority()` / `_pool_fail_threshold()`
  - `_start_shim()` 在 `name == "llm_pool"` 时注入上述三个环境变量

### 修复

- `_pool_fail_threshold()` 初版用 `int(x or 2)`，导致配置 `0` 被当成假值回退到 2。
  改为显式判断 `None` / 空字符串，再 `max(1, min(n, 20))` 夹紧。

### 验证

| 检查 | 结果 |
|---|---|
| 默认值（priority / [] / 2） | ✅ |
| 自定义（roundrobin / 2 项 / 5） | ✅ |
| 非法策略兜底到 priority | ✅ |
| fail_threshold 0→1、999→20、abc→2 | ✅ |
| 多行字符串解析 | ✅ |
| shim 启动日志按配置顺序列出 | ✅ 1. C 2. B 3. A |

---

## [1.4.2] — 2026-11-04

### 性能 / 规范（审查反馈）

- **异步化端口探测**：`initialize` / `terminate` / `_start_shim` / `_stop_by_port`
  原来在 async 路径里用同步 `subprocess.run`（netstat / lsof，超时 8s），
  会阻塞事件循环。新增 `_pid_listening_on_async()` / `_kill_pid_async()`
  基于 `asyncio.create_subprocess_exec`，全部 async 路径改用它。
  同步版保留给同步上下文（当前已无引用，仅留作扩展）。

- **`_status_text()` 改为 async**：原来用同步 `port_free()`（`connect_ex` 0.5s），
  现统一走 `port_free_async()`。4 个调用点补 `await`。
  同步版 `port_free()` 已无引用，删除；随之清理未使用的 `import socket`。

- **`_log_dir()` 回退位置改为临时目录**：原来 plugin_data 不可写时退回
  插件安装目录下的 `logs/`，会污染插件、也会被插件更新覆盖。
  改为退回 `tempfile.gettempdir()/<插件名>`，保持插件目录只读语义。

### 说明

未触碰 `db_helper`，未修改 `Conversation` 表；provider 注册仍走
`provider_manager` + 配置接口，符合 AstrBot 插件规范。

### 验证

| 检查 | 结果 |
|---|---|
| 异步 PID 探测（8787/8788/空闲端口） | ✅ 结果与同步版一致 |
| `port_free_async` | ✅ |
| `_status_text` 异步返回 | ✅ 11 行，含运行标记 |
| `_log_dir` 返回 plugin_data 路径 | ✅ |
| 判定矩阵 6 组回归 | ✅ 全部通过 |
| async 上下文残留同步调用 | ✅ 0 处 |

---

## [1.4.1] — 2026-11-04

### 修复

- **端口变化时尊重启用状态**：改端口的同时禁用某个 shim，旧代码仍会在新端口启动。
  现在先杀旧进程、注销 provider，再按「启用」决定是否启动。
- **端口冲突不再假装成功**：`_start_shim()` 原来对端口占用一律返回 True。
  换端口时若新端口被其他程序占用，会误判为启动成功，后续 provider 连到别人服务上。
  新增 `reuse_ok` 参数区分「重载复用」（占用视为已在运行）与
  「换端口/首次启动」（占用视为冲突，返回 False 并报出占用 PID）。

### 说明

- 补记 1.4.0 遗漏的两项修复（换端口杀旧进程、重载复用不重启），
  它们随 1.4.0 一起发布，但当时 CHANGELOG 未单独列出。

### 验证

| 场景 | 结果 |
|---|---|
| 端口冲突 + reuse_ok=False | 返回 False 并列出占用 PID ✅ |
| 端口占用 + reuse_ok=True | 返回 True 且 PID 不变（未起新进程）✅ |
| 端口空闲 + reuse_ok=False | 返回 True 且真起来 ✅ |
| 完整判定矩阵 10 组 | 全部通过 ✅ |

---

## [1.4.0] — 2026-11-03

### 新增

- **WebUI 热启停**：单个 shim 的启停**不需要重启 AstrBot**。
  - `GET  /astrbot_plugin_shim_connector/status` — 查状态
  - `POST /astrbot_plugin_shim_connector/start` — 启动指定 shim
  - `POST /astrbot_plugin_shim_connector/stop` — 停止指定 shim
  - `POST /astrbot_plugin_shim_connector/restart` — 重启指定 shim
  - `POST /astrbot_plugin_shim_connector/toggle` — 切换
  - 请求体 `{"name": "trae"}`

- **停止时自动注销 provider**：调用 `provider_manager.terminate_provider()`
  并把对应的 provider / provider_source 从配置里移除，
  这样停掉的 shim 不会在模型列表里留下指向死端口的条目。

- **临时停用机制**：WebUI 停止的 shim 只记在内存（`_temp_disabled`），
  不写配置文件。重启 AstrBot 后按配置走。想让停用持久化请改配置页。


### 新增（续）：配置热重载

**点保存即生效，不用重启 AstrBot。**

插件每 2 秒检查配置文件的 mtime，变化后重新读取并做**差分启停**：

- 只对「启用」状态变化的 shim 执行启动/停止
- 其他 shim 完全不受影响，不重启
- 停止时自动注销对应 provider

为此新增：

| 方法 | 作用 |
|---|---|
| `_conf_file_path()` | 定位 `<data>/config/<插件名>_config.json` |
| `_reload_config_from_disk()` | 从磁盘读最新配置 |
| `_reconcile(reason)` | 差分启停 |
| `_watch_config_loop()` | 2 秒轮询 |
| `_applied` 基线 | 记录上次生效状态 |

**限制**：只有「启用」开关热生效。改端口 / token / node_path 仍需重启
（那些在启动 shim 进程时读取）。

### 说明：为什么用轮询

AstrBot 的 `save_config()` **没有变更回调/事件**，`Star` 基类也只有
`initialize` / `terminate` 两个钩子。所以只能轮询文件 mtime ——
在不改 AstrBot 的前提下，这是唯一可行方案。

### 修复（自查发现）

- `_conf_file_path()` 初版误用「主配置同目录」，实际插件配置在
  `<data>/config/` 子目录。已改为优先找 `config/xxx_config.json`。
- `_reconcile()` 首次运行若无基线，会把「配置里本来就关闭」
  误判成「需要停止」。改为先建基线不动作。

### 新增：端口变化自动处理

改端口后**不再产生孤儿进程**。

เดิม `terminate()` 只记录「哪些 shim 活着」，不记录端口。
换了端口后 `initialize()` 会：
- 在新端口起一个新进程
- **旧端口上的进程没人管，变成孤儿**

现在改为记录 `{名字: 端口}` 映射，`initialize()` 检测到端口变了就：

1. 按上次记录的旧端口找 PID
2. 杀掉它
3. 在新端口启动

`_load_prev_alive()` 同时兼容旧格式（纯字符串列表，端口记为 0 = 未知）。

**实测**：18911 → 18912，旧进程 pid=7456 被杀、旧端口释放、新端口 pid=22940 正常监听。

---


### 修复：端口变化时的两个判断错误

1. **端口变了但 shim 被禁用，仍会在新端口启动**
   原代码在 `port_changed` 分支里无条件调 `_start_shim()`，
   没检查 `want`。改为：先杀旧进程，再按 `want` 决定是否启动。

2. **新端口被别的程序占用时"假装成功"**
   `_start_shim()` 原来对端口占用一律返回 True（视为"我们的 shim 在跑"）。
   换端口场景下如果新端口被 QQ 等程序占用，会误以为启动成功，
   后续注册 provider 时连到别人的服务上。

   新增 `reuse_ok` 参数区分：
   - `True`（重载复用场景）→ 端口占用视为已在运行
   - `False`（换端口/首次启动）→ 端口占用视为冲突，返回 False 并报错

**实测 3 组**：

| 场景 | 结果 |
|---|---|
| 端口冲突 + reuse_ok=False | 返回 False ✅ |
| 端口占用 + reuse_ok=True | 返回 True 且不启新进程（PID 不变）✅ |
| 端口空闲 + reuse_ok=False | 返回 True 且真起来（PID 可查）✅ |

### 变更

- `_enabled()` 拆成两个概念：
  - `_enabled()` — 纯配置（总闸 AND 分开关）
  - `_effective_enabled()` — 配置 AND 未被临时停用
  initialize 用后者决定启动哪些。
- 新增 `_auto_register()` 读取 `advanced.auto_register`，
  关掉后热启动不会自动注册 provider。

### 说明

热启停**不触发** `terminate()`，所以其他正在跑的 shim 完全不受影响。
只有插件重载 / AstrBot 重启才会走 `terminate()` 全停 + 重新 initialize。

### 验证

| 检查 | 结果 |
|---|---|
| 临时停用生效/解除 | ✅ |
| 总闸关闭时 effective=False | ✅ |
| `_auto_register` 默认/关闭 | ✅ |
| 7 个 Web API 方法存在 | ✅ |
| Python 语法 | ✅ |

---

## [1.3.2] — 2026-10-31

### 安全与合规

- **强化免责声明**：README 顶部新增 `[!WARNING]` 横幅，明确写出
  「可能违反服务条款（ToS）、**可能账号被封禁（封号）**、风险完全自担」。
- **免责章节重写**：分为「风险告知（含后果表）」「这不是破解（区分自用额度与盗号）」
  「你可以怎么做（4 条实务建议）」三节。
- **补齐 MIT 署名**：
  - 新增 `LICENSE` 文件（本项目 MIT + 三方上游项目归属汇总）
  - `shims/trae-shim.mjs` 补 MIT 全文 `LICENSE-NOTICE`
  - `shims/qoder-shim.mjs` / `vision-shim.mjs` / `llm-pool-shim.mjs` 补 `LICENSE-NOTICE`
  - README「授权与署名」改为表格，列出每个上游项目的落点文件与版权人

### 修复

- **去掉写死的本机路径**：
  - `main.py` 的 node 查找不再写死某个开发者本机的非常规路径，
    改为「配置 → PATH → 标准安装位置（用 `%ProgramFiles%` / `%LOCALAPPDATA%` / `%NVM_HOME%` 推导）」。
  - `_conf_schema.json` 的 `node_path` 提示同步改正。
  - `TROUBLESHOOTING.md` 改为列出真实的查找顺序，不再举例某个盘符路径。
  - `workbuddy-shim.mjs` 的 app 发现不再写死 `C:\Program Files`，改用环境变量推导。
  - 全项目扫描：无盘符路径、无用户名、无设备指纹。

### 改进

- **`port_free` 改异步**：新增 `port_free_async()`，启动路径改用它，
  避免 `socket.connect_ex` 阻塞事件循环（安全审查建议）。
  同步版保留，仅供 `_status_text()` 这类纯同步渲染使用。

### 文档

- **删除 README 的「版本历史」章节**：改为指向 `CHANGELOG.md`，
  避免 README 随版本膨胀。
- **修正模型数量表述**：「36 个」是**候选**总数，不是固定注册数。
  `models` 留空 = 全部，填了 = 只注册那几个。
  同步修正 README / metadata / SKILL 共 11 处「N 个模型」的说法。
- 补充模型列表来源说明：WorkBuddy / Trae 为内置清单（上游无列表接口），
  Qoder 为实时拉 `/v1/models`。

### 验证

| 项 | 结果 |
|---|---|
| Python 语法 | ✅ |
| `_conf_schema.json` 合法 | ✅ |
| 5 个 shim 语法 | ✅ |
| 版本号四处一致 | ✅ |
| 安全审计（token / 用户名 / 本机路径 / 设备指纹） | ✅ CLEAN |

---

## [1.3.1] — 2026-10-30

### 新增

- **总开关 + 分开关**：两级控制，精细选择要启动的 shim。
  - `shims.enabled`（bool，默认 true）：总闸。
  - 每个 shim 分组的 `enable`（bool）：单独控制。
  - 最终启用 = **总闸 AND 分开关**。
  - 总闸关闭 → 一律不启动；总闸开启 → 看各分开关。

- **自定义 shim**：`shims.custom` 可接入任意 OpenAI 兼容服务。
  - 格式：`名称|脚本文件|端口|token`
  - 脚本可放插件 `shims/` 目录，也可写绝对路径
  - 默认端口/ token 按填的走，也可在该 shim 的分组里覆盖
  - 自定义 shim 默认视为启用（受总闸约束）

### 变更

- 每个 shim 的 `enable` 默认值：workbuddy / trae / qoder 为 true，其余 false。
- 删掉了 1.3.0 里「总开关是名单」的设计（那个设计会让分开关失效，不符合直觉）。

### 兼容

- 没有 `shims.enabled` 配置项时视为 true（老用户升级后行为不变）。

### 验证

真值表 6 组全部通过：

| 配置 | workbuddy | trae |
|---|---|---|
| 老配置（无） | ✅ | ✅ |
| 总闸关 | ❌ | ❌ |
| 总闸开 + 默认 | ✅ | ✅ |
| 总闸开 + trae 关 | ✅ | ❌ |
| 总闸开 + 都关 | ❌ | ❌ |
| 总闸关 + 都开 | ❌ | ❌ |

---

## [1.3.0] — 2026-10-30

### 新增

- **模型可选**：每个 shim 新增 `models` 配置项，可以勾选只注册哪些模型。
  - 留空 = 全部注册（向后兼容）
  - WebUI 里是列表输入框，支持多行粘贴
  - 填了不存在的模型会警告并忽略，不会报错
  - 新增 `advanced.strict_models`（默认 true）：关掉则忽略 `models`，总是全注册

### 说明

- 之前是「shim 返回什么就全注册什么」，用户没法选。Qoder 有 24 个模型，
  全注册会让模型选择列表很长，也没法避开自己不想用的模型（比如慢的 or 贵的）。
- 现在默认值仍是「全注册」，所以**老用户升级后行为不变**。

### 验证

`_pick_models` 的 5 个用例全部通过：

| 场景 | 结果 |
|---|---|
| 留空 | 返回全部 |
| 选 2 个 | 只返回那 2 个 |
| 含无效项 | 返回有效的，并警告 |
| 多行字符串 | 正确拆分 |
| strict_models=false | 忽略配置，返回全部 |

---

## [1.2.1] — 2026-10-29

### 文档

- **README / metadata.yaml / SKILL.md 重写开头，突出「白嫖」这个核心价值**：
  - 一句话点明：把你付过钱的订阅变成机器人的模型源，不用再付 API 费
  - 拆解「白嫖的是什么」：WorkBuddy 6 + Trae 6 + Qoder 24 = 36 个模型
  - 说清为什么是白嫖不是破解：钱已付过，只是换入口
  - 成本对比：按 token 付费 vs 边际成本 0
  - 核心卖点速览表
- `display_name` 改为「白嫖机器人 | 本机模型接入」。
- `short_desc` / `description` / `features` 同步强调零 API 费用与零配置。
- SKILL.md 的触发词新增「白嫖」「免费模型」「零成本」。

### 修复

- 网络请求从 `urllib`（同步阻塞）改为 **aiohttp**（异步）。
  Qoder 的 `/v1/models` 需 10s+，原来会阻塞 AstrBot 事件循环。
- 补齐 AstrBot 官方规范的 `metadata.yaml` 字段：`short_desc` / `support_platforms` /
  `homepage` / `features`。
- 新增 `logo.png`（256×256）。
- `requirements.txt` 显式声明 `aiohttp`。
- 清理误建的 `shims/%SystemDrive%` 空目录。

---

## [1.2.0] — 2026-10-29

### 新增

- **零配置开箱即用**。装完插件即自动可用，不需要填任何 token、路径或密钥。
- **Trae 凭据自动发现**：直接读桌面端 `User/globalStorage/storage.json` 的
  `iCubeAuthInfo` 字段，用 AES-128-CBC 解密（密钥派生自 `sha512(sha512(random) || salt)`）。
  不再需要事先准备 `TRAE_AUTH_FILE`。
  - 解密算法改写自 [dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae)
    （MIT, Copyright (c) 2026 LaoDing）。
- **默认启用改为 workbuddy + trae + qoder**（三者都是自动发现凭据）。

### 变更

- `TRAE_AUTH_FILE` 从「必需」降级为「可选覆盖」：自动发现失败时才需要手工指定。
- 凭据来自桌面端时**不写回任何文件**（那是 app 自己的文件，不该被插件改动）。
- 高级 shim（`workbuddy_intl` / `vision` / `llm_pool`）默认保持关闭，按需开启。

### 验证

不设置任何凭据环境变量的情况下，6 个 shim 全部可用：

| shim | 模型数 |
|---|---|
| WorkBuddy | 6 |
| Trae | 6 |
| Qoder | 24 |
| WorkBuddy-Intl | 6 |
| Vision | 1 |
| LLM-Pool | 1 |

Trae 实测真实对话返回正常（`DeepSeek-V4-Flash-Official`）。

---

## [1.1.1] — 2026-10-29

### 修复

- **Qoder 在 `APPDATA` 为空时完全不可用**。路径被拼成 `undefined\com.qodercn.app.stable`，
  导致解不出 OSCrypt 主密钥，`/v1/models` 返回 502、0 个模型，插件因此注册不到任何 Qoder provider。
  改用 `homedir()` 兜底。**实测修复后从 0 个模型恢复到 24 个**。
- **`vision-shim` / `llm-pool-shim` 硬编码了本机配置路径**（指向本机 AstrBot 安装目录的具体路径）。
  改为 `ASTRBOT_CONFIG || "cmd_config.json"`，并在配置缺失时给出明确报错后 `exit(2)`。

### 改进

- Qoder 的凭据错误信息现在会附带**查找的目录**和**该目录是否存在**，
  而不再只是一句「无法解出主密钥」。

### 验证

| shim | 端口 | 状态 | 模型数 |
|---|---|---|---|
| WorkBuddy | 8787 | ✅ | 6 |
| Trae | 8788 | ✅ | 6 |
| Qoder | 8789 | ✅ | **24**（修复前 0） |
| WorkBuddy-Intl | 8790 | ✅ | 6 |
| Vision | 8791 | ✅ | 1（轮换端点） |
| LLM-Pool | 8792 | ✅ | 1（轮换端点） |

---

## [1.1.0] — 2026-10-29

### 新增

- **shim 数量从 3 个扩到 6 个**：
  - `workbuddy_intl`（8790）：WorkBuddy 国际版，同一个脚本 + `WB_REGION=global`
  - `vision`（8791）：视觉轮换层，5 个上游之间轮转
  - `llm_pool`（8792）：通用 LLM 池，10 个上游之间轮转
- **shim 日志落盘**：不再用 `DEVNULL` 丢弃输出，
  每个 shim 写到 `data/plugin_data/astrbot_plugin_shim_connector/<名称>.log`。
- **`/shim logs` 命令**：
  ```
  /shim logs              # 所有 shim 各最后 20 行
  /shim logs trae         # 只看 trae
  /shim logs trae 50      # trae 最后 50 行（上限 200）
  ```
- **启动失败自动诊断**：shim 秒退时，插件把日志尾部 15 行打进 AstrBot 日志。
- **provider 注册改为 AstrBot 原生两层结构**：
  `provider_sources` 存共享的 `api_base` / `key`，`provider` 每个模型一条，
  最终 provider id 形如 `trae_shim/DeepSeek-V4-Flash-Official`，
  与主链配置写法一致。

### 改进

- provider / provider_source 注册改为**幂等**：已存在且一致时跳过，不重复写盘。
- 持久化到当前生效的配置档案（多档案时只改当前那个）。
- `_conf_schema.json` 补齐 6 个 shim 的分组 + `advanced`。

---

## [1.0.0] — 2026-10-29

### 新增

- 首个可用版本。
- 3 个 shim：WorkBuddy（8787）/ Trae（8788）/ Qoder（8789）。
- 插件加载时自动起 shim 子进程，卸载时自动停掉。
- 探测 `/v1/models` 并自动注册 provider。
- `/shim` 命令：`status` / `start` / `stop` / `restart`。
- 三个 shim 均**自包含**，不依赖任何第三方 DSH 插件。

### 说明

- WorkBuddy 分支需要本机装有 WorkBuddy 桌面端（at-rest 凭据解密要问 app 要密钥）。
- WorkBuddy 凭据解密逻辑改写自 [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)
  （MIT）与 [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）。
  完整声明见 `shims/workbuddy-shim.mjs` 末尾的 LICENSE-NOTICE。

---

## 版本号对照

| 版本 | commit | 要点 |
|---|---|---|
| 1.6.5 | 待定 | 轮换层说明 + 跳过提示、清理本地缓存 |
| 1.6.4 | 待定 | 轮换层可视化编辑 + 搜索、修复面板位置与 vh 单位、过滤循环引用 |
| 1.6.3 | 待定 | Qoder 36 模型（含 QoDuck）、耗率带单位、过滤 null 模型 |
| 1.6.2 | 待定 | 插件描述更新：66 个模型、多账号、余额、WebUI |
| 1.6.1 | 待定 | 移除第三方二维码、vault uid 去重、qoder 真实名称、hidden 修复 |
| 1.6.0 | 待定 | 多账号池 + 扫码登录 + 余额 + WebUI 页面 + 5 shim 耗费统计 |
| 1.5.4 | 待定 | 跨区兜底：额度用尽自动切到另一个区 |
| 1.5.3 | 待定 | 修 8 个路由的 query bug；成本按实测；模型管理接口 |
| 1.5.2 | 待定 | 官方模型名册 + 耗费统计；发现 hy4free 免费版 |
| 1.5.1 | 待定 | 新增 hy3/hy4，目录按实测速度重排，标注成本 |
| 1.5.0 | 待定 | 自动调节：长期超时的模型自动沉底，分数持久化 |
| 1.4.8 | 待定 | 清除文档里的本机日志数据 |
| 1.4.7 | 待定 | README 风险提示提到最醒目位置（ToS/封号） |
| 1.4.6 | 待定 | 删除 _pid_listening_on/_kill_pid 同步死代码 |
| 1.4.5 | 待定 | 新增 hy4 混元推理模型；可刷新探测上游模型 |
| 1.4.4 | 待定 | 视觉轮换层支持优先级，默认顺序按实测成功率重排 |
| 1.4.3 | 待定 | LLM 池支持优先级排序 |
| 1.4.2 | 待定 | 端口探测异步化；log 目录回退改临时目录 |
| 1.4.1 | 待定 | 端口变化尊重启用状态；端口冲突正确识别 |
| 1.4.0 | 待定 | WebUI 热启停 + 配置热重载（点保存即生效） | WebUI 热启停 + 停止时注销 provider |
| 1.3.2 | 待定 | 免责声明强化；LICENSE + MIT 署名补齐；port_free 异步；删 README 版本历史 |
| 1.3.1 | `e9fc6f9` | 总闸+分开关；自定义 shim |
| 1.3.0 | `86742ff` | 模型可选（models 配置项） |
| 1.2.1 | `0c142b6` | 文档突出「白嫖」；改 aiohttp 异步；对齐官方规范 |
| 1.2.0 | `2592fc5` | 零配置开箱即用；Trae 凭据自动发现 |
| 1.1.1 | `8159e9c` | 修 Qoder APPDATA 兜底、去掉硬编码本机路径 |
| 1.1.0 | `08d02da` | 6 个 shim、日志落盘、`/shim logs` |
| 1.0.0 | `4456c4d` | 首个版本，3 个 shim |

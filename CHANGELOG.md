# CHANGELOG

本文件记录各版本变更。版本号与 `metadata.yaml` 的 `version` 保持一致。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

**实测**：38 个候选，10 秒完成，发现 **10 个可用**（比原目录多 4 个）：

```
space-bunny, hy4, deepseek-v4.1-flash, deepseek-v4-pro,
minimax-m3.1-flash, glm-5.3-flash,
deepseek-v3.2, glm-5.3, hy3, minimax-m3     ← 后 4 个是新发现的
```

新发现的 4 个都实测能正常对话（`1+1` 全返回 `2`）。

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
| `/refresh-models` 探测 38 个候选 | ✅ 10 秒，10 个可用 |
| 探测结果落盘 | ✅ `.wb-models.json` |
| 重启后从缓存加载 | ✅ 日志「使用上次探测结果 10 个模型」 |
| 新发现模型实测对话 | ✅ 4/4 返回正确 |
| 部署副本同步 | ✅ |

---

## [1.4.4] — 2026-11-04

### 新增：视觉轮换层支持优先级

`vision_rotator` 原来只有固定顺序轮换，且默认顺序**把最不靠谱的排在最前**：
`zhipu_vision`（余额不足）和 `intern_qwen_vision`（quota 超限）排 1、2 位，
每次请求都要先等它们失败，再降到能用的。

现在与 `llm_pool` 一致，支持两种策略（默认 **priority**）：

| 策略 | 行为 |
|---|---|
| **priority**（默认） | 严格按优先级列表，前面的能用就一直用；冷却或连续失败达阈值才降级 |
| roundrobin | 每次换下一个，均摊负载 |

### 默认顺序已按实测成功率重排

2026-11-04 统计（共 689 次调用）：

| 候选 | OK | FAIL | 成功率 | 平均耗时 |
|---|---|---|---|---|
| workbuddy_shim/minimax-m3.1-flash | 148 | 8 | **95%** | 8.9s |
| workbuddy_intl/minimax-m3.1-flash | 127 | 19 | **87%** | 9.1s |
| zhipu_vision | 125 | 40 | 76% | 5.4s |
| intern_qwen_vision | 38 | 101 | **27%** | 9.2s |
| qoder_shim/qoder-cn/gfmodel | 15 | 109 | **12%** | 12.8s |

新默认顺序：**workbuddy_shim → workbuddy_intl → zhipu → intern_qwen → qoder**

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
| `余额不足`（zhipu 1113） | 账号问题 | 优先级调后，或充值 |
| `quota exceeded`（intern） | 配额用尽 | 优先级调后 |
| `模型排队中`（qoder 10605） | 上游繁忙 | 优先级调后（12% 成功率） |
| `empty content` | 模型返回空 | 自动降级到下一个（已支持） |

**前三个不是代码 bug，是账号/上游状态。** 本次改动让它们排在后面，
不再拖慢正常请求。

### 排查过程（供以后复现）

**症状**：`vision_rotator/vision-auto` 全部候选失败。

**第 1 步：看 shim 日志**（不是插件日志）

```powershell
Get-Content "<AstrBot>\data\plugin_data\astrbot_plugin_shim_connector\vision.log" -Tail 30
```

原始报错会直接写明原因：

```
zhipu_vision FAIL: {"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}
intern_qwen_vision FAIL: {"error":{"message":"quota exceeded",...}}
qoder_shim/qoder-cn/gfmodel FAIL: {"error":{"message":"模型排队中: {\"code\":\"10605\"...}"}}
workbuddy_shim/minimax-m3.1-flash FAIL: empty content
```

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
for pid in ["zhipu_vision", "intern_qwen_vision",
            "workbuddy_shim/minimax-m3.1-flash",
            "workbuddy_intl/minimax-m3.1-flash",
            "qoder_shim/qoder-cn/gfmodel"]:
    print(("OK  " if pid in providers else "MISS") + " " + pid)
```

如果某个 provider 被删了，shim 启动时会打印 `跳过（provider 不存在）`。

### 关键区分：哪些能修，哪些不能

| 错误信息 | 性质 | 能否靠代码修 |
|---|---|---|
| `余额不足` / `无可用资源包` | 账号欠费 | ❌ 充值，或排到后面 |
| `quota exceeded` | 配额用尽 | ❌ 等重置，或排到后面 |
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

# 技术支持：astrbot_plugin_shim_connector

> 面向排查。用户报问题 → 按本文从上往下走。
>
> 插件仓库：https://github.com/rawLeaf/astrbot_plugin_shim_connector

---

## 0. 30 秒判断卡在哪一层

AstrBot 调模型的链路是：

```
AstrBot → provider(<source_id>/<model>) → http://127.0.0.1:<port>/v1 → shim → 上游客户端协议
```

四层任意一层断都会表现为「机器人不说话」。按下面顺序判定：

| 检查 | 命令 | 正常表现 |
|---|---|---|
| ① 插件装了吗 | AstrBot 插件页看有没有本插件 | 已启用 |
| ② shim 起了吗 | `/shim` | 对应行显示 `[运行]` |
| ③ provider 注册了吗 | 面板「服务提供商」搜 `shim_` | 有对应条目 |
| ④ shim 能回话吗 | `curl` 直接打 shim | 返回 JSON 内容 |

**哪一层先断，就修哪一层。** 不要跳着查。

---

## 1. 第一层：插件没装好

### 症状

- 插件页看不到「本机模型接入」
- 或者装了但一直是红色/报错

### 排查

| 检查项 | 怎么看 |
|---|---|
| 目录结构对不对 | `<AstrBot>/data/plugins/astrbot_plugin_shim_connector/` 下应有 `main.py` `metadata.yaml` `shims/` |
| `shims/` 在不在 | 缺了就是拷贝不全，插件起不来 shim |
| AstrBot 版本 | 需要 `>=4.11.0` |
| 日志报什么 | 面板「日志」页搜 `shim_connector` |

### 常见报错

| 报错 | 原因 | 解决 |
|---|---|---|
| `ModuleNotFoundError: astrbot.api` | 装错位置（装到了非插件目录） | 重新从插件页安装 |
| `ImportError: cannot import name filter` | AstrBot 版本太旧 | 升级 AstrBot |
| 插件列表里显示但加载失败 | `metadata.yaml` 的 `name` 与目录名不符 | 目录名必须是 `astrbot_plugin_shim_connector` |

---

## 2. 第二层：shim 没起来

### 症状

`/shim` 显示 `[停止]`，或日志里有 `找不到 node`。

### 排查顺序

**2.1 先看 Node.js 在不在**

插件日志搜 `找不到 node`。如果没有，用配置里的 `advanced.node_path` 手动指定。

Windows 常见位置：

```
D:\3other\nodejs\node.exe
C:\Program Files\nodejs\node.exe
```

**2.2 看 shim 日志（v1.1.0 起直接能看）**

> v1.1.0 之前插件用 `DEVNULL` 把 shim 输出丢了，必须手动跑。
> **现在已改成写文件，直接在聊天里发命令就行。**

```
/shim logs workbuddy          # 该 shim 最后 20 行
/shim logs trae 50            # 最后 50 行（上限 200）
/shim logs                    # 所有 shim 各 20 行
```

文件位置：

```
<AstrBot>/data/plugin_data/astrbot_plugin_shim_connector/
├── workbuddy.log
├── trae.log
├── qoder.log
├── workbuddy_intl.log
├── vision.log
└── llm_pool.log
```

每次启动会写一行分隔头，超 2MB 滚动成 `.log.1`：

```
===== 2026-10-29 11:48:44 启动 workbuddy (:8787) =====
[workbuddy-shim] listening on http://127.0.0.1:8787/v1  (region=cn)
```

**shim 秒退时插件会自动把日志尾部打进 AstrBot 日志**，所以先看 AstrBot 日志通常就够：

```
[shim_connector] trae 启动后立即退出 (code=2)
<日志最后 15 行>
```

**兜底：手动跑**（插件没起来、或要看实时输出时）

```powershell
cd <AstrBot>/data/plugins/astrbot_plugin_shim_connector/shims
$env:WB_SHIM_PORT="8787"; $env:WB_SHIM_TOKEN="sk-workbuddy-local"
node workbuddy-shim.mjs
```

（把 `WB_SHIM` 换成 `TRAE_SHIM` / `QODER_SHIM` / `VISION_SHIM` / `LLM_POOL` 测对应的）

**2.3 按报错对号入座**

| shim 报错 | 原因 | 解决 |
|---|---|---|
| `no desktop auth file found` | 客户端没装或没登录 | 装客户端并登录 |
| `sign-in is encrypted but the at-rest key is unavailable` | 找不到 WorkBuddy 桌面端 | 装 WorkBuddy，或设 `WORKBUDDY_APP_EXECUTABLE` |
| `Cannot find module` | `shims/` 下文件缺失 | 重新安装插件 |
| `EADDRINUSE` | 端口被别的程序占了 | 改配置端口，或杀掉占用进程 |
| 启动后立刻退出 | 凭据读取失败，见上面两条 | |

**2.4 端口被谁占了**

```powershell
netstat -ano | findstr :8788
```

拿到 PID 后：

```powershell
tasklist /FI "PID eq <PID>"
```

---

## 3. 第三层：provider 没注册

### 症状

shim 在跑（`/shim` 显示 `[运行]`），但 AstrBot 模型列表里没有 `<source_id>/` 开头的条目。

### 原因与处理

| 原因 | 判定 | 解决 |
|---|---|---|
| `/v1/models` 返回空 | 手动 curl 看 | 见 3.1 |
| `auto_register` 被关 | 看配置 | 打开并重启 |
| provider 已存在同名 | 面板搜 `shim_` | 正常，不用管 |
| 注册时抛异常 | 日志搜 `注册 shim_` | 看具体错误 |

### 3.1 手动确认 shim 返回了什么

```powershell
# WorkBuddy
curl -H "Authorization: Bearer sk-workbuddy-local" http://127.0.0.1:8787/v1/models

# Trae
curl -H "Authorization: Bearer sk-trae-local" http://127.0.0.1:8788/v1/models

# Qoder
curl -H "Authorization: Bearer sk-qoder-local" http://127.0.0.1:8789/v1/models
```

正常应该返回 `{"object":"list","data":[{"id":"..."}]}`。

如果 `data` 是空数组 `[]`，插件就不会注册任何 provider —— 这就是根因。

**注意 Qoder 较慢**（要实时拉上游模型目录，可能要 10 秒以上），curl 加 `--max-time 30`。

### 3.2 手动加总比等插件快

实在搞不定自动注册，就在面板手动加一个 provider_source：

| 字段 | 值 |
|---|---|
| 类型 | `openai_chat_completion` |
| api_base | `http://127.0.0.1:8788/v1` |
| key | `sk-trae-local` |

然后引用模型，`model` 填 `/v1/models` 返回的 id。

**别忘了 `modalities` 要带 `tool_use`**，否则工具会被静默剥掉。

---

## 4. 第四层：能连但模型不回话

### 症状

provider 有了，发消息机器人不回复 / 回复空 / 超时。

### 4.1 先直接打 shim，绕开 AstrBot

```powershell
$body = '{"model":"DeepSeek-V4-Flash-Official","messages":[{"role":"user","content":"说三个字"}],"stream":false}'
Invoke-RestMethod -Uri "http://127.0.0.1:8788/v1/chat/completions" -Method Post `
  -Headers @{"Authorization"="Bearer sk-trae-local"; "Content-Type"="application/json"} `
  -Body $body
```

| 结果 | 说明 |
|---|---|
| 正常返回内容 | shim 没问题，问题在 AstrBot 侧配置 |
| `401` | token 对不上 |
| `429 model_queue` | 上游排队，等 |
| `402` | 额度耗尽 |
| 返回空内容 | 见 4.2 |
| 一直挂着 | 见 4.3 |

### 4.2 返回空内容

按客户端分：

| 客户端 | 常见原因 |
|---|---|
| **Trae** | 模型名用了显示名而非 `config_name`；或每个模型只在自己的 `function` 下可用 |
| **Trae（带工具调用历史）** | 历史里有 `tool_calls[].function`，上游要 `function_call`。**本插件的 shim 已内置归一化**，若仍失败说明包是旧版 |
| **WorkBuddy** | 模型 id 写错（上游不报错，直接回空） |
| **Qoder** | 用了显示名而非内部 key（`qmodel_38max` 这类） |

**Trae 的「重启后能用一阵」是典型症状**：只要那个会话出现过工具调用，坏字段就留在历史里，之后每轮都失败，直到滚出上下文窗口。

### 4.3 一直挂着不返回

上游用 **HTTP 200 + 错误帧** 表达失败，而且错误后**不关流**。

| 客户端 | 表现 | 现成处理 |
|---|---|---|
| Qoder | 10605 排队，流不关 | shim 已实现「读第一帧就判定并断流」 |
| Trae | 极少见 | |

如果确实挂住，先看 shim 日志第一帧内容。

---

## 5. 按客户端速查

### WorkBuddy

| 项 | 值 |
|---|---|
| 端口 | 8787（`WB_SHIM_PORT`） |
| 依赖 | WorkBuddy **桌面端**必须装着（解密要问 app 要密钥） |
| 凭据 | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info` |
| 加密 | 5.6.0+ 起 token 字段加密，shim 启动 app 取 at-rest 密钥 |
| 模型 | `space-bunny` 默认，另有 deepseek/minimax/glm/kimi |

**特有坑**：

- 桌面端升级后加密格式可能变 → shim 报 keyId 不匹配。等 shim 更新或提 issue。
- 国际版 `WorkBuddyAI.exe` 在 `WorkBuddyAI` 目录下，插件会自动探测。

### Trae

| 项 | 值 |
|---|---|
| 端口 | 8788（`TRAE_SHIM_PORT`） |
| 依赖 | Trae 桌面端登录态 |
| 凭据 | 环境变量 `TRAE_AUTH_FILE` 指向的 JSON |
| 模型 | 6 个，`DeepSeek-V4-Flash-Official` 最稳 |

**特有坑**：

- **`TRAE_AUTH_FILE` 必须设**，否则 shim 找不到凭据。
- 每个模型绑自己的 `function`（`solo_work_lite` / `solo_agent`），shim 已内置映射。
- `content` 必须是数组，不能是字符串（上游 4001）。

### Qoder

| 项 | 值 |
|---|---|
| 端口 | 8789（`QODER_SHIM_PORT`） |
| 依赖 | Qoder 桌面端登录态 |
| 凭据 | `auth.v1.dat`（OSCrypt + DPAPI 解密） |
| 模型 | 24 个，用内部 key（`qoder-cn/qmodel_38max`） |

**特有坑**：

- 国际区（`qoder/xxx`）经常全模型排队（10605），不是本地问题。
- `/v1/models` 要实时拉上游，慢（10s+）。
- COSY 签名的 AES key 每次随机，无法复用。

---

## 6. 日志在哪看

| 层 | 位置 | 看什么 |
|---|---|---|
| 插件 | AstrBot 面板「日志」 | 搜 `shim_connector` |
| **shim** | **`/shim logs <名称>`**，或 `plugin_data/astrbot_plugin_shim_connector/<名称>.log` | 启动日志、上游错误、秒退原因 |
| AstrBot 模型调用 | 面板日志 | 搜 provider id |
| shim 秒退 | AstrBot 日志搜 `启动后立即退出` | 插件已自动附上日志尾部 15 行 |

**v1.1.0 已实现日志落盘**，不再需要手动跑 shim 只为看报错。

---

## 7. 一键自检脚本

把下面存成 `check.ps1`，跑一遍就知道哪层断了：

```powershell
$ErrorActionPreference = "Continue"
$shims = @(
  @{ Name="WorkBuddy";    Port=8787; Token="sk-workbuddy-local" },
  @{ Name="Trae";         Port=8788; Token="sk-trae-local" },
  @{ Name="Qoder";        Port=8789; Token="sk-qoder-local" },
  @{ Name="WorkBuddyIntl";Port=8790; Token="sk-workbuddy-intl" },
  @{ Name="Vision";       Port=8791; Token="sk-vision-local" },
  @{ Name="LLM-Pool";     Port=8792; Token="sk-llm-pool-local" }
)

Write-Host "=== 1. 端口 ===" -ForegroundColor Cyan
foreach ($s in $shims) {
  $open = Test-NetConnection -ComputerName 127.0.0.1 -Port $s.Port -InformationLevel Quiet -WarningAction SilentlyContinue
  Write-Host ("  {0,-12} :{1}  {2}" -f $s.Name, $s.Port, $(if ($open) {"OPEN"} else {"CLOSED"}))
}

Write-Host "`n=== 2. healthz ===" -ForegroundColor Cyan
foreach ($s in $shims) {
  try {
    $r = Invoke-RestMethod "http://127.0.0.1:$($s.Port)/healthz" -TimeoutSec 3
    Write-Host ("  {0,-12} OK" -f $s.Name) -ForegroundColor Green
  } catch { Write-Host ("  {0,-12} FAIL" -f $s.Name) -ForegroundColor Red }
}

Write-Host "`n=== 3. models ===" -ForegroundColor Cyan
foreach ($s in $shims) {
  try {
    $r = Invoke-RestMethod "http://127.0.0.1:$($s.Port)/v1/models" `
      -Headers @{Authorization="Bearer $($s.Token)"} -TimeoutSec 20
    Write-Host ("  {0,-12} {1} models" -f $s.Name, $r.data.Count)
    $r.data | Select-Object -First 3 | ForEach-Object { Write-Host ("     " + $_.id) }
  } catch { Write-Host ("  {0,-12} FAIL: {1}" -f $s.Name, $_.Exception.Message) -ForegroundColor Red }
}

Write-Host "`n=== 4. node ===" -ForegroundColor Cyan
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { Write-Host "  " $node.Source -ForegroundColor Green }
else { Write-Host "  未找到 node" -ForegroundColor Red }
```

---

## 8. 已知限制（不是 bug，别再试）

| 限制 | 说明 |
|---|---|
| 不支持热更新 | 改了 shim 脚本要 `/shim restart` |
| provider 不会自动删 | 关掉某个 shim 后，之前的 provider 配置还在，需手动删 |
| 端口冲突不自动发现 | 固定端口，冲突时改配置 |
| Qoder 模型多但慢 | 24 个模型，`/v1/models` 10s+ |
| WorkBuddy 依赖桌面端 | 没装 app 就解不开凭据 |
| 日志只有 2MB 滚动 | 超了只留 `.log.1` 一份，没做多份归档 |

> ~~shim 日志不落盘~~ —— **v1.1.0 已修复**，见第 6 节。

---

## 9. 升级 / 回滚

### 升级

插件页重新安装即可。**注意**：旧 shim 进程不会自动杀，装完执行：

```
/shim stop
/shim start
```

### 回滚

从 GitHub 拉指定 tag 重装。当前版本 `v1.1.0`。

> **v1.0.0 → v1.1.0 变化**：
> - shim 从 3 个扩到 6 个（新增 workbuddy_intl / vision / llm_pool）
> - provider id 从 `shim_trae_0` 改成 `trae_shim/<model>`
> - shim 日志落盘 + `/shim logs` 命令
>
> 升级后旧的 `shim_*` provider 不会自动删，可手动清理。

---

## 10. 收集信息给维护者

报问题时请附上：

1. `/shim` 的输出
2. `check.ps1` 的完整输出
3. `/shim logs <出问题的那个>` 的输出
4. AstrBot 日志里含 `shim_connector` 的行
5. 哪个客户端、什么模型、错误表现（空/超时/报错码）

---

## 11. ✅ shim 日志落盘（v1.1.0 已实现）

> 本节从「待实现施工单」改为「实现记录」。
> **v1.1.0 已按下面的设计落地**，此节保留作为设计说明与维护参考。

### 11.1 改造前的问题

`main.py` 启动 shim 时把输出直接丢弃：

```python
proc = subprocess.Popen(
    [node, str(script)],
    cwd=str(script.parent),
    env=env,
    stdout=subprocess.DEVNULL,   # ← 这里丢了
    stderr=subprocess.DEVNULL,   # ← 这里丢了
    creationflags=creation,
)
```

后果：

| 表现 | 影响 |
|---|---|
| 插件日志里看不到 shim 的报错 | 排障必须先手动跑 shim（见 2.2） |
| 凭据解密失败、端口冲突、上游拒绝，全部静默 | 用户只看到「机器人不回话」 |
| 事后无法回溯 | 出问题那次没抓住，就查不到了 |

### 11.2 目标（全部已达成）

1. 每个 shim 的 stdout+stderr 写入独立日志文件
2. 文件按大小滚动，避免无限增长
3. 提供 `/shim logs [名称]` 命令，直接在聊天里看最近 N 行
4. 失败原因能出现在插件日志里（至少摘要）

### 11.3 实际实现（与原建议一致）

**A. 日志路径**

建议放在 AstrBot 的插件数据目录，不要放插件源码目录（升级会被覆盖）：

```
<AstrBot>/data/plugin_data/astrbot_plugin_shim_connector/
├── workbuddy.log        ├── workbuddy_intl.log
├── trae.log             ├── vision.log
└── qoder.log            └── llm_pool.log
```

取路径的方式参考其它插件（如 `meme_manager` 用了 `PLUGIN_DATA_DIR`）。
若 AstrBot 没有现成 helper，用 `Path(AstrBotConfig 所在目录)/../plugin_data/...` 推导，并 `mkdir(parents=True, exist_ok=True)`。

**B. 启动时重定向**

把 `DEVNULL` 换成文件句柄：

```python
log_path = self._log_path(name)
log_file = open(log_path, "ab", buffering=0)   # 追加二进制，避免编码问题
proc = subprocess.Popen(
    [node, str(script)],
    cwd=str(script.parent),
    env=env,
    stdout=log_file,
    stderr=subprocess.STDOUT,   # 合并到同一个文件
    creationflags=creation,
)
log_file.close()   # 父进程关掉自己的句柄，子进程仍持有
```

**注意**：Windows 下 `node` 输出是 UTF-8，用 `"ab"` 追加二进制最稳，避免 GBK 编码错误。

**C. 写入分隔头**

每次启动前写一行，方便区分不同次运行：

```python
with open(log_path, "ab") as fh:
    fh.write(f"\n===== {datetime.now().isoformat()} 启动 {name} (:{port}) =====\n".encode("utf-8"))
```

**D. 滚动**

简单做法：启动前检查文件大小，超过 2MB 就改名为 `.log.1`（覆盖旧的）：

```python
MAX_LOG_BYTES = 2 * 1024 * 1024
if log_path.exists() and log_path.stat().st_size > MAX_LOG_BYTES:
    backup = log_path.with_suffix(".log.1")
    if backup.exists():
        backup.unlink()
    log_path.rename(backup)
```

**E. `/shim logs` 命令**

```
/shim logs              # 默认看所有 shim 各最后 20 行
/shim logs trae         # 只看 trae
/shim logs trae 50      # trae 最后 50 行
```

实现要点：

- 读文件尾部，不要整文件读入（日志可能很大）
- 输出前把行数限制在合理范围（建议 200 行上限）
- 结果用 `event.plain_result()` 返回；太长时截断并提示完整路径

**F. 失败摘要进插件日志**

shim 启动后 2~3 秒内，检查进程是否还活着：

```python
await asyncio.sleep(2.5)
if proc.poll() is not None:
    tail = self._tail(log_path, 15)
    logger.error(
        f"[shim_connector] {name} 启动后立即退出 (code={proc.returncode})\n{tail}"
    )
```

这比让用户自己去翻文件友好得多——**大多数失败都发生在启动瞬间**。

### 11.4 验收结果（v1.1.0 实测）

| # | 检查 | 结果 |
|---|---|---|
| 1 | 正常启动 trae | ✅ `trae.log` 里有 `listening on http://127.0.0.1:8788/v1` |
| 2 | shim 失败 | ✅ 插件日志出现 `启动后立即退出 (code=N)` + 日志尾部 15 行 |
| 3 | `/shim logs` | ✅ 显示所有 shim 各 20 行 |
| 4 | `/shim logs trae 10` | ✅ 只显示 trae 最后 10 行 |
| 5 | 反复 restart | ✅ 持续追加，每次写分隔头；超 2MB 滚动 |
| 6 | 中文日志 | ✅ 用 `"ab"` 二进制模式，不乱码 |

**实际日志样例**：

```
===== 2026-10-29 11:48:44 启动 workbuddy (:8787) =====
[workbuddy-shim] listening on http://127.0.0.1:8787/v1  (region=cn)
[workbuddy-shim] chat 200 1957ms
[workbuddy-shim] chat 200 1632ms
```

### 11.5 不要做的事

- **不要把日志写进插件源码目录** —— 插件升级会整个目录替换，日志会丢
- **不要用 `subprocess.PIPE` 然后不读** —— 管道缓冲区满会阻塞 shim，导致假死
- **不要每次请求都写日志** —— 只在启动/关键错误写，否则文件迅速膨胀

### 11.6 实际改动位置（已落地）

| 文件 | 函数 | 改了什么 |
|---|---|---|
| `main.py` | `_start_shim` | ✅ `DEVNULL` → 文件句柄；加滚动与分隔头 |
| `main.py` | `_start_shim` | ✅ 启动后 2.5s 检查存活（`_check_started`）|
| `main.py` | `shim_cmd` | ✅ 增加 `logs` 分支 |
| `main.py` | 新增 | ✅ `_log_path` / `_log_dir` / `_rotate_log` / `_tail` / `_check_started` |
| `main.py` | 常量 | ✅ `MAX_LOG_BYTES = 2MB`、`MAX_LOG_TAIL_LINES = 200` |
| `README.md` | 功能表 | 待补 |

### 11.7 v1.1.0 的其它改动（超出本节范围）

除了日志，v1.1.0 还做了：

| 改动 | 说明 |
|---|---|
| shim 从 3 个扩到 6 个 | 新增 `workbuddy_intl` / `vision` / `llm_pool` |
| provider id 改造 | 从 `shim_trae_0` 改成 `trae_shim/<model>`（AstrBot 原生两层结构） |
| 修 `already exists` 误报 | 存在性检查要同时查 `default_conf` 和 `inst_map` |

详见 SKILL.md 的「provider 是怎么注册的」一节。

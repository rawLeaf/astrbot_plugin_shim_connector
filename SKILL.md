---
name: astrbot-shim-connector
description: 白嫖机器人：把已付费的 WorkBuddy / Trae / Qoder 订阅变成 AstrBot 的模型源（36 个模型，零 API 费用、零配置）。当用户要把本机客户端的模型接进机器人、问怎么不花 API 钱让机器人跑起来、装了这个插件、shim 起不来、provider 没注册、模型返回空、端口冲突、/shim 命令怎么用、凭据读不到，或需要判断问题出在插件层/shim 层/provider 层时使用。触发词：shim_connector、白嫖、本机模型接入、免费模型、零成本、WorkBuddy 接入、Trae 接入、Qoder 接入、provider 没注册、shim 起不来、模型返回空、8787、8788、8789、/shim 命令。
---

# 白嫖机器人 | AstrBot 本机模型接入插件

把 Qoder / Trae / WorkBuddy（国内 + 国际）这些本机已登录的客户端，
连同视觉轮换层和 LLM 池，通过 loopback shim 变成 AstrBot 可用的模型源。

**仓库**：https://github.com/rawLeaf/astrbot_plugin_shim_connector
**当前版本**：v1.3.1（2026-10-30）

---

## 它解决什么

**一句话：把你已经付过钱的 AI 订阅，变成机器人能用的模型。**

你在机器上登录了 WorkBuddy / Trae / Qoder，这些客户端每月在扣钱。
但它们不发 API Key，所以机器人调用时你还得再付一次 API 费用。

这个插件在本机起一组 shim，把「客户端已登录的额度」翻译成 OpenAI 兼容端点，
机器人直接调用——**边际成本 0，钱你已经付过了。**

合计 36 个模型：WorkBuddy 6 + Trae 6 + Qoder 24。

---

## 它是什么

插件做三件事：

1. **起 shim 进程** —— Node.js 子进程，绑 `127.0.0.1`
2. **自动注册 provider** —— 探测 `/v1/models`，先建 `provider_source` 再建 `provider`
3. **写 shim 日志到文件** —— 出问题能回溯（v1.1.0 新增）

```
AstrBot → provider(<source_id>/<model>)
       → http://127.0.0.1:<port>/v1
       → shim → 上游客户端协议
```

插件本身**不接触任何凭据**。每个 shim 自己从本机登录态读取。

---

## 六个 shim

| shim | 端口 | provider 前缀 | 说明 |
|---|---|---|---|
| `workbuddy` | 8787 | `workbuddy_shim` | WorkBuddy 国内版 |
| `trae` | 8788 | `trae_shim` | Trae（6 个模型）|
| `qoder` | 8789 | `qoder_shim` | Qoder 国内/国际（24 个模型）|
| `workbuddy_intl` | 8790 | `workbuddy_intl` | WorkBuddy 国际版 |
| `vision` | 8791 | `vision_rotator` | **视觉轮换层**（5 个上游）|
| `llm_pool` | 8792 | `llm_pool` | **通用 LLM 池**（10 个上游）|

> `workbuddy_intl` 和国内版**共用同一个 `workbuddy-shim.mjs`**，
> 靠 `WB_REGION=global` 区分。

**最少要开哪些？**

- 只想聊天 → 4 个（workbuddy / trae / qoder / workbuddy_intl）
- 还要看图、看视频 → 加 `vision`
- 还要自学习 / QQ 空间 / 决策 AI → 加 `llm_pool`

---

## 安装

### 前置

| 项 | 要求 |
|---|---|
| AstrBot | `>= 4.11.0` |
| Node.js | `>= 18` |
| 客户端 | 用哪个装哪个，且**已登录** |

### 步骤

1. 插件页 → 安装 → 填仓库地址
2. 到插件配置勾选要启用的 shim
3. 保存后重启 AstrBot，或发 `/shim start`

---

## 配置项

**两级开关**，最终启用 = 总闸 AND 分开关。

### 总闸 `shims.enabled`（bool，默认 true）

- 开：按各 shim 的 `enable` 走
- 关：**全部不启动**

### 分开关（每个 shim 一组）

| 分组 | 默认 | 端口 | `models` 留空含义 |
|---|---|---|---|
| `workbuddy` | **开** | 8787 | 全部 6 个 |
| `trae` | **开** | 8788 | 全部 6 个 |
| `qoder` | **开** | 8789 | 全部 24 个 |
| `workbuddy_intl` | 关 | 8790 | 全部 |
| `vision` | 关 | 8791 | `vision-auto` |
| `llm_pool` | 关 | 8792 | `llm-pool-auto` |

### 自定义 shim `shims.custom`（list）

格式：`名称|脚本|端口|token`，每行一个。

- 脚本可放插件 `shims/` 目录或写绝对路径
- 需提供 `/healthz`、`/v1/models`、`/v1/chat/completions`
- 默认启用（受总闸约束）
- 与内置重名的会被忽略

### models：选择要注册的模型

**留空 = 全部注册。**

| shim | 可选模型 |
|---|---|
| WorkBuddy | `space-bunny` / `deepseek-v4.1-flash` / `deepseek-v4-pro` / `minimax-m3.1-flash` / `glm-5.3-flash` / `kimi-k2.6` |
| Trae | `DeepSeek-V4-Flash-Official` / `glm-5.3-flash` / `Doubao-Seed-Code` / `mimo-v2.6-flash` / `minimax-m3.1-flash` / `qwen3.8-flash` |
| Qoder | 24 个，形如 `qoder-cn/qmodel_38max` |

填了不存在的模型 → 警告并忽略，不报错。

### advanced

| 项 | 默认 | 说明 |
|---|---|---|
| `node_path` | 空 | 留空自动从 PATH 找 |
| `auto_register` | true | 自动注册 provider |
| `strict_models` | true | 只注册 `models` 里选的 |

### 常见配置

| 需求 | 怎么配 |
|---|---|
| 只跑 trae | 总闸开，关掉 workbuddy / qoder 的 enable |
| 全部停掉 | 总闸关 |
| 精简模型列表 | 各 shim 的 `models` 只填要用的 1-2 个 |
| 接入自己的 shim | `shims.custom` 填 `名字\|脚本\|端口\|token` |


## 命令

```
/shim                  查看状态
/shim start            启动所有已启用的
/shim stop             停止插件启动的
/shim restart          重启（改了 shim 脚本后用它）
/shim logs             所有 shim 各最后 20 行
/shim logs trae        只看 trae
/shim logs trae 50     只看 trae 最后 50 行（上限 200）
```

都是管理员命令。

`/shim` 输出长这样：

```
本机 shim 状态

[运行] WorkBuddy      :8787   pid=12345  src=workbuddy_shim
[运行] Trae           :8788   pid=12346  src=trae_shim
[运行] Qoder          :8789   pid=12347  src=qoder_shim
[运行] WorkBuddy-Intl :8790   pid=12348  src=workbuddy_intl
[运行] Vision         :8791   pid=12349  src=vision_rotator
[运行] LLM-Pool       :8792   pid=12350  src=llm_pool

日志目录: <AstrBot>/data/plugin_data/astrbot_plugin_shim_connector
用法: /shim [status|start|stop|restart|logs [名称] [行数]]
```

---

## 凭据来源

| 客户端 | 从哪读 |
|---|---|
| WorkBuddy | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`，5.6.0+ 的加密字段靠启动 app 取 at-rest 密钥 |
| Trae | 环境变量 `TRAE_AUTH_FILE` 指向的 JSON |
| Qoder | `auth.v1.dat`（OSCrypt + DPAPI）|

**所有 shim 只绑 `127.0.0.1`**，用占位 token 认证。

> 安全性：shim 只把凭据发给**官方上游**（trae / 腾讯 / qoder），
> 不含任何遥测，不会把 token 写到别处或打进日志。

---

## provider 是怎么注册的（v1.1.0 起）

用 AstrBot **原生两层结构**，最终 id 是 `<source_id>/<model>`：

```python
# 第一步：建 source（含共享的 api_base / key）
provider_sources = [{
    "id": "trae_shim",
    "type": "openai_chat_completion",
    "api_base": "http://127.0.0.1:8788/v1",
    "key": ["sk-trae-local"],
}]

# 第二步：每个模型建一个 provider
provider = [{
    "id": "trae_shim/DeepSeek-V4-Flash-Official",
    "provider_source_id": "trae_shim",
    "model": "DeepSeek-V4-Flash-Official",
    "modalities": ["text", "tool_use"],   # ← 必须带 tool_use
}]
```

这样 provider id 和手写配置的 `workbuddy_shim/space-bunny` 完全一致，
**已有的模型链一行都不用改**。

> 旧版本（v1.0.0）注册的是 `shim_trae_0` 这种扁平 id，升级后会新增一套；
> 旧的可以手动删，不影响使用。

---

## 排查：按四层走

机器人不说话，一定是这四层之一断了。**从下往上查，不要跳**。

### ① 插件层

插件页能看见吗？启用了？

日志搜 `shim_connector`。

### ② shim 层

`/shim` 看状态。显示 `[停止]` 就是没起来。

**v1.1.0 起 shim 日志会写文件，直接看**：

```
/shim logs workbuddy
/shim logs trae 50
```

文件在：

```
<AstrBot>/data/plugin_data/astrbot_plugin_shim_connector/
├── workbuddy.log
├── trae.log
├── qoder.log
├── workbuddy_intl.log
├── vision.log
└── llm_pool.log
```

单文件超 2MB 自动滚动成 `.log.1`。每次启动会写一行分隔头：

```
===== 2026-10-29 11:48:44 启动 workbuddy (:8787) =====
[workbuddy-shim] listening on http://127.0.0.1:8787/v1  (region=cn)
```

**shim 秒退时，插件会自动把日志尾部打进 AstrBot 日志**：

```
[shim_connector] trae 启动后立即退出 (code=2)
<日志最后 15 行>
```

所以先看 AstrBot 日志，就够定位大部分启动失败。

### ③ provider 层

面板「服务提供商」搜 `shim_` 或 `<source_id>/`。没有就是没注册。

先手动确认 shim 返回了什么：

```powershell
curl -H "Authorization: Bearer sk-trae-local" http://127.0.0.1:8788/v1/models
```

`data` 是空数组 → 插件不会注册任何 provider，这就是根因。

### ④ 模型层

provider 有了但模型不回话，直接打 shim 绕开 AstrBot：

```powershell
$body = '{"model":"DeepSeek-V4-Flash-Official","messages":[{"role":"user","content":"说三个字"}],"stream":false}'
Invoke-RestMethod "http://127.0.0.1:8788/v1/chat/completions" -Method Post `
  -Headers @{"Authorization"="Bearer sk-trae-local"} -ContentType "application/json" -Body $body
```

正常返回内容 → 问题在 AstrBot 侧；返回空 → 看下面「按客户端」。

---

## 按客户端速查

| 客户端 | 最常踩的 |
|---|---|
| **Trae** | 必须设 `TRAE_AUTH_FILE`；模型名用 `config_name` 不是显示名；带工具调用历史会返回空（**v1.1.0 的 shim 已内置归一化**）|
| **WorkBuddy** | 必须装桌面端（解密要问 app 要密钥）；模型 id 写错会静默返回空 |
| **Qoder** | 用内部 key（`qoder-cn/qmodel_38max`）；国际区常排队；`/v1/models` 慢（10s+）|

---

## 报错对照表

| 报错 | 层 | 处理 |
|---|---|---|
| `找不到 node` | ② | 装 Node.js 或配 `advanced.node_path` |
| `no desktop auth file found` | ② | 客户端没装/没登录 |
| `sign-in is encrypted but the at-rest key is unavailable` | ② | 装 WorkBuddy 桌面端 |
| `EADDRINUSE` | ② | 端口冲突，改配置或 `/shim stop` |
| `Provider ID xxx already exists` | ③ | 该 provider 已在配置里，属正常跳过 |
| `401` | ④ | token 对不上 |
| `429 model_queue` | ④ | 上游排队，等 |
| `402` | ④ | 额度耗尽 |
| `4001` | ④ | body 字段类型错 |
| `11101` | ④ | `stream:false` 或 `tool_choice` 传对象 |
| `11128` | ④ | `role:developer` |
| `10605` | ④ | 上游排队 |

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 不支持热更新 | 改了 shim 脚本要 `/shim restart` |
| provider 不会自动删 | 关掉某个 shim 后，已注册的 provider 还在，需手动删 |
| 端口冲突不自动发现 | 固定端口，冲突时改配置 |
| Qoder 模型多但慢 | 24 个模型，`/v1/models` 10s+ |
| WorkBuddy 依赖桌面端 | 没装 app 就解不开凭据 |

---

## 给 agent 的操作要点

1. **先问是哪一层**：插件页看见了吗 → `/shim` 显示什么 → provider 列表有没有 `<source_id>/`。这三个答案能定位 90% 的问题。
2. **先看日志，别急着改配置**。v1.1.0 起 `/shim logs` 就能看到 shim 输出，不用再手动跑。
3. **先 `curl /v1/models`** 看 shim 到底返回什么，再怀疑插件。
4. **改完 shim 脚本必须 `/shim restart`**，不重启不生效。
5. **别把真实 token 写进配置**。`sk-*-local` 是占位符，shim 会自己转发到上游。
6. **provider id 是 `<source_id>/<model>`**，改模型链时照这个格式写。
7. 详细排障见同目录 `TROUBLESHOOTING.md`。

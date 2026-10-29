# astrbot_plugin_shim_connector

> **白嫖机器人：把你已经付过钱的 AI 订阅，直接喂给你的 QQ 机器人。**

---

## 一句话

你电脑里装着 **WorkBuddy**、**Trae** 或 **Qoder**，并且已经登录了。

这些客户端**每个月都在扣你的钱**（订阅费 / 积分 / 额度）——

**但它们不给你 API Key，所以你用机器人时，还得再付一次 API 费用。**

这个插件就是干这个的：

```
你已有的订阅额度  →  本机 shim  →  AstrBot 机器人直接调用
      ↑                                      ↑
   已经付过钱了                          不用再花一分钱
```

**同一笔钱，机器人白天用，你自己晚上用。不用再给大模型厂商交两遍。**

---

## 白嫖的是什么

| 你装的客户端 | 白嫖到的东西 | 实测可用模型 |
|---|---|---|
| **WorkBuddy** | 腾讯 CodeBuddy 额度（国内 + 国际两区） | 6 个 |
| **Trae** | 字节 Trae 订阅里的 6 个模型 | 6 个 |
| **Qoder** | 阿里 Qoder 免费档 / 订阅 | **24 个** |
| **合计** | | **36 个模型** |

再加上两个进阶层：

- **视觉轮换层**：5 个视觉上游轮流用，图片描述不会因为一个挂掉就全废
- **通用 LLM 池**：10 个上游轮换，给 self_learning 这类"只能填一个 provider"的插件用

---

## 为什么这是"白嫖"而不是"破解"

**因为钱你已经付过了。**

- 这些客户端的账号是你自己的，登录态在你机器上
- 你付的是订阅费，额度是自己买的
- 插件只是把「客户端能用的额度」**换个入口**让机器人也能用

**没有绕过付费，没有盗用别人的账号。就是把你自己的东西多用一次。**

> ⚠️ 但要说清楚：这种接入方式复用了客户端的私有协议，**可能违反各家的服务条款**。
> 风险自担。真被官方封了别怪插件。

---

## 为什么值得装

| 不装 | 装了 |
|---|---|
| 机器人调 API，按 token 付费 | 用已有订阅，**边际成本 0** |
| 三个厂商要配三套 API Key | **一个 Key 都不用填** |
| 换模型要改配置、测延迟 | 36 个模型自动注册好，直接选 |
| 某个模型挂了机器人就哑了 | 轮换层自动切下一个 |

**实测成本对比**：如果机器人每天跑 100 万 token，用 DeepSeek 官方 API 大约 ¥1-2/天（粗算），一个月 30-60 块。用这个插件，**0 块**。

---

## 装完是什么样

1. 装 Node.js，装并登录 WorkBuddy / Trae / Qoder（有几个装几个）
2. AstrBot 插件页装本插件 → 重启
3. 到「服务提供商」看：`workbuddy_shim/space-bunny`、`trae_shim/DeepSeek-V4-Flash-Official`、`qoder_shim/qmodel_38max`……

**完事。不用填任何 token、路径或密钥。**

---

## 核心卖点速览

| 特性 | 说明 |
|---|---|
| 💰 **零 API 费用** | 用已有订阅额度，边际成本 0 |
| 🔑 **零配置** | 凭据从客户端桌面端自动读取解密 |
| 🚀 **装完即用** | 6 个 shim 默认开 3 个，重启就生效 |
| 🔄 **自动注册** | 探测模型列表，自动建 provider |
| 📊 **36 个模型** | WorkBuddy 6 + Trae 6 + Qoder 24 |
| 🛡️ **只绑本机** | 全部 `127.0.0.1`，不暴露外网 |
| 📝 **日志可查** | `/shim logs` 直接看 |
| 🎯 **轮换兜底** | 视觉/LLM 池自动切上游 |

---

## 支持的 shim（6 个）

| shim | 端口 | provider 前缀 | 说明 |
|---|---|---|---|
| `workbuddy` | 8787 | `workbuddy_shim` | WorkBuddy 国内版 |
| `trae` | 8788 | `trae_shim` | Trae（6 个模型）|
| `qoder` | 8789 | `qoder_shim` | Qoder 国内/国际（24 个模型）|
| `workbuddy_intl` | 8790 | `workbuddy_intl` | WorkBuddy 国际版（同脚本，`WB_REGION=global`）|
| `vision` | 8791 | `vision_rotator` | 视觉轮换层（5 个上游）|
| `llm_pool` | 8792 | `llm_pool` | 通用 LLM 池（10 个上游）|

## 安装（零配置）

**装完就能用。不需要填任何 token、路径或密钥。**

1. 装 **Node.js**（>= 18）
2. 装并登录任意一个客户端：**WorkBuddy / Trae / Qoder**（装几个用几个）
3. AstrBot 插件页安装本插件 → 重启

就这样。插件会自动：

- 从各客户端**桌面端本地凭据**读出并解密（各家方式不同，见下）
- 拉起 shim 子进程
- 探测 `/v1/models` 并注册成 AstrBot 的 provider

到「服务提供商」就能看到 `workbuddy_shim/*`、`trae_shim/*`、`qoder_shim/*` 这些模型。

### 凭据是怎么拿到的（全自动，无需配置）

| 客户端 | 自动读取方式 |
|---|---|
| **WorkBuddy** | 读桌面端 `workbuddy-desktop.info`；5.6.0+ 的加密字段靠启动 app 取 at-rest 密钥解开 |
| **Trae** | 读桌面端 `User/globalStorage/storage.json` 的 `iCubeAuthInfo` 字段，AES-128-CBC 解密 |
| **Qoder** | 读桌面端 `auth.v1.dat`，OSCrypt + DPAPI 解密 |

**没有桌面端就用不了**——凭据只存在本地客户端里，插件不会、也不能凭空生成。

### 想手动指定凭据？

只有当自动发现失败时才需要：

```powershell
# Trae
$env:TRAE_AUTH_FILE = "C:\path\to\trae-auth.json"
```

### 可选的高级 shim（默认关闭）

| 分组 | 作用 | 什么时候开 |
|---|---|---|
| `workbuddy_intl` | WorkBuddy 国际版 | 你有国际版账号 |
| `vision` | 视觉轮换层（5 上游） | 图片描述经常失败 |
| `llm_pool` | 通用 LLM 池（10 上游） | self_learning 这类只填单个 provider 的插件总挂 |

## 配置说明

每个 shim 一组，都是 `enable` / `port` / `token`：

| 分组 | 默认端口 | 默认启用 | 默认 token |
|---|---|---|---|
| `workbuddy` | 8787 | **true** | `sk-workbuddy-local` |
| `trae` | 8788 | **true** | `sk-trae-local` |
| `qoder` | 8789 | **true** | `sk-qoder-local` |
| `workbuddy_intl` | 8790 | false | `sk-workbuddy-intl` |
| `vision` | 8791 | false | `sk-vision-local` |
| `llm_pool` | 8792 | false | `sk-llm-pool-local` |

| 分组 | 项 | 默认 | 说明 |
|---|---|---|---|
| advanced | `node_path` | 空 | 留空自动从 PATH 找 |
| | `auto_register` | true | 自动注册 provider |

## 命令

```
/shim                   # 查看状态
/shim start             # 启动所有已启用的 shim
/shim stop              # 停止插件启动的 shim
/shim restart           # 重启（改了 shim 脚本后用它）
/shim logs              # 所有 shim 各最后 20 行
/shim logs trae         # 只看 trae
/shim logs trae 50      # trae 最后 50 行（上限 200）
```

需要管理员权限。

## provider 是怎么注册的

用 AstrBot **原生两层结构**，最终 provider id 是 `<source_id>/<model>`：

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

## 日志

位置：

```
<AstrBot>/data/plugin_data/astrbot_plugin_shim_connector/
├── workbuddy.log        ├── workbuddy_intl.log
├── trae.log             ├── vision.log
└── qoder.log            └── llm_pool.log
```

- 每次启动写一行分隔头
- 单文件超 2MB 改名为 `.log.1`
- shim 秒退时，日志尾部 15 行会打进 AstrBot 日志
- 聊天里用 `/shim logs <名称>` 直接看

## 端口约定

| 端口 | 客户端 | 占位 token |
|---|---|---|
| 8787 | WorkBuddy | `sk-workbuddy-local` |
| 8788 | Trae | `sk-trae-local` |
| 8789 | Qoder | `sk-qoder-local` |
| 8790 | WorkBuddy Intl | `sk-workbuddy-intl` |
| 8791 | Vision | `sk-vision-local` |
| 8792 | LLM Pool | `sk-llm-pool-local` |

## 凭据怎么来的（重点）

**插件不接触任何凭据。** 每个 shim 自己从本机登录态读取：

| 客户端 | 凭据来源 |
|---|---|
| WorkBuddy | 桌面端 `workbuddy-desktop.info`，5.6.0+ 的加密字段由 shim 启动 app 取 at-rest 密钥解开 |
| Trae | 环境变量 `TRAE_AUTH_FILE` 指向的 JSON |
| Qoder | 桌面端 `auth.v1.dat`（OSCrypt + DPAPI 解密） |

所有 shim 只绑 `127.0.0.1`，用可配置的占位 token 认证，不监听外网。

**安全性审计结论**（2026-10-29 实测）：

| 项 | 结果 |
|---|---|
| 对外域名 | 全部官方（trae / 腾讯 / qoder），**零第三方** |
| 遥测上报 | **无**（telemetry/analytics/beacon/sentry 等全无命中）|
| 凭据写盘 | qoder 0 处、workbuddy 0 处；trae 只写回用户自己的 `TRAE_AUTH_FILE` |
| 凭据打日志 | 不打印 token 值，只打印路径和状态 |

## 常见问题

| 症状 | 原因 | 处理 |
|---|---|---|
| 插件日志报「找不到 node」 | PATH 里没有 Node.js | 装 Node.js，或在配置里填 `node_path` |
| shim 起了但没注册 provider | `/v1/models` 返回空 | 检查客户端是否已登录；`/shim logs <名称>` 看日志 |
| shim 启动后秒退 | 凭据读取失败 / 端口冲突 | 看插件日志里的「启动后立即退出」+ 日志尾部 |
| 模型调用返回空 | 客户端凭据过期 | 重新登录对应客户端 |
| 端口被占用 | 已有 shim 在跑 | 正常，插件会复用 |
| WorkBuddy 报「encrypted but key unavailable」 | 找不到桌面端 | 装 WorkBuddy，或设 `WORKBUDDY_APP_EXECUTABLE` |

## 版本历史

| 版本 | 变化 |
|---|---|
| v1.0.0 | 初版，支持 trae / workbuddy / qoder |
| **v1.1.0** | 扩到 6 个 shim（新增 workbuddy_intl / vision / llm_pool）；
| | provider id 改为 `<source_id>/<model>`；shim 日志落盘 + `/shim logs`；
| | 修 `already exists` 误报（同时查 default_conf 与 inst_map）|

## 授权

MIT License。

WorkBuddy 凭据解密逻辑改写自 [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)
（MIT, Copyright (c) 2026 LaoDing），其参考 [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)
（MIT, Copyright (c) 2026 Corrine Hu）。完整声明见 `shims/workbuddy-shim.mjs` 末尾 LICENSE-NOTICE。

## 免责

本插件复用已登录客户端的私有协议，可能违反对方服务条款。请自行评估风险。

---

## 变更日志

各版本改了什么见 [CHANGELOG.md](CHANGELOG.md)。

当前版本 **1.2.1**，要点：

- 6 个 shim（含 WorkBuddy 国际版、视觉轮换、LLM 池）
- shim 日志落盘 + `/shim logs` 命令
- provider 注册用 AstrBot 原生两层结构（`<source_id>/<model>`）


---

## 灵感来源与许可

本插件的三个 shim 移植/改写了以下 MIT 项目的实现思路与代码：

| 项目 | 用途 | 许可 |
|---|---|---|
| [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) | WorkBuddy at-rest 凭据解密、app 发现 | MIT, Copyright (c) 2026 LaoDing |
| [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | 上述项目的上游参考 | MIT, Copyright (c) 2026 Corrine Hu |
| [dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) | Trae storage.json 凭据解密 | MIT, Copyright (c) 2026 LaoDing |

完整许可声明见：
- `shims/workbuddy-shim.mjs` 末尾的 `LICENSE-NOTICE`
- `shims/trae-shim.mjs` 中的解密模块注释

本插件自身以 **MIT** 许可发布。

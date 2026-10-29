# astrbot_plugin_shim_connector

> 把本机已登录的 AI 客户端（Qoder / Trae / WorkBuddy）通过 loopback shim 接入 AstrBot。

## 它解决什么问题

这些客户端都不是标准 OpenAI 接口，官方也不发 API key。本插件在本机起一组 shim 代理，
把它们各自**已登录的账号**翻译成 OpenAI 兼容端点，并自动注册成 AstrBot 的模型 provider。

**已有订阅额度直接变成 AstrBot 可用的模型，不用再充 API。**

## 功能

| 能力 | 说明 |
|---|---|
| 自动起 shim | 插件加载时按配置拉起 Node 子进程，卸载时自动停掉 |
| 自动注册 provider | 探测 `/v1/models` 拿真实模型名，写进 AstrBot |
| 状态查询 | `/shim` 命令查看各端口运行状态与 pid |
| 生命周期命令 | `/shim start\|stop\|restart` |

## 安装

1. **装 Node.js**（>= 18）
2. **装对应客户端并登录**：WorkBuddy / Trae / Qoder（用哪个装哪个）
3. 在 AstrBot 插件页安装本插件（WebUI → 插件 → 安装）
4. 到插件配置里勾选要启用的 shim，保存
5. 重启 AstrBot（或 `/shim start`）

## 配置说明

| 分组 | 项 | 默认 | 说明 |
|---|---|---|---|
| trae | enable | **true** | 默认启用 |
| | port | 8788 | |
| | token | sk-trae-local | 占位 token，非真实密钥 |
| workbuddy | enable | false | 需装 WorkBuddy 桌面端 |
| | port | 8787 | |
| qoder | enable | false | 需装 Qoder 桌面端 |
| | port | 8789 | |
| advanced | node_path | 空 | 留空自动从 PATH 找 |
| | auto_register | true | 自动注册 provider |

## 命令

```
/shim            # 查看状态
/shim start      # 启动所有已启用的 shim
/shim stop       # 停止插件启动的 shim
/shim restart    # 重启
```

需要管理员权限。

## 端口约定

| 端口 | 客户端 | 占位 token |
|---|---|---|
| 8787 | WorkBuddy | `sk-workbuddy-local` |
| 8788 | Trae | `sk-trae-local` |
| 8789 | Qoder | `sk-qoder-local` |

## 凭据怎么来的（重点）

**插件不接触任何凭据。** 每个 shim 自己从本机登录态读取：

| 客户端 | 凭据来源 |
|---|---|
| WorkBuddy | 桌面端 `workbuddy-desktop.info`，5.6.0+ 的加密字段由 shim 启动 app 取 at-rest 密钥解开 |
| Trae | 环境变量 `TRAE_AUTH_FILE` 指向的 JSON |
| Qoder | 桌面端 `auth.v1.dat`（OSCrypt + DPAPI 解密） |

所有 shim 只绑 `127.0.0.1`，用可配置的占位 token 认证，不监听外网。

## 常见问题

| 症状 | 原因 | 处理 |
|---|---|---|
| 插件日志报「找不到 node」 | PATH 里没有 Node.js | 装 Node.js，或在配置里填 `node_path` |
| shim 起了但没注册 provider | `/v1/models` 返回空 | 检查客户端是否已登录；看 shim 日志 |
| 模型调用返回空 | 客户端凭据过期 | 重新登录对应客户端 |
| 端口被占用 | 已有 shim 在跑 | 正常，插件会复用 |
| WorkBuddy 报「encrypted but key unavailable」 | 找不到桌面端 | 装 WorkBuddy，或设 `WORKBUDDY_APP_EXECUTABLE` |

## 授权

MIT License。

WorkBuddy 凭据解密逻辑改写自 [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)
（MIT, Copyright (c) 2026 LaoDing），其参考 [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)
（MIT, Copyright (c) 2026 Corrine Hu）。完整声明见 `shims/workbuddy-shim.mjs` 末尾 LICENSE-NOTICE。

## 免责

本插件复用已登录客户端的私有协议，可能违反对方服务条款。请自行评估风险。

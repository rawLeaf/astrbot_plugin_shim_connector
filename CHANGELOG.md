# CHANGELOG

本文件记录各版本变更。版本号与 `metadata.yaml` 的 `version` 保持一致。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
| 1.2.0 | 待定 | 零配置开箱即用；Trae 凭据自动发现 |
| 1.1.1 | `8159e9c` | 修 Qoder APPDATA 兜底、去掉硬编码本机路径 |
| 1.1.0 | `08d02da` | 6 个 shim、日志落盘、`/shim logs` |
| 1.0.0 | `4456c4d` | 首个版本，3 个 shim |

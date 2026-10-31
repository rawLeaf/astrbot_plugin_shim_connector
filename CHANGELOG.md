# CHANGELOG

本文件记录各版本变更。版本号与 `metadata.yaml` 的 `version` 保持一致。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
  - `main.py` 的 node 查找不再写死 `D:\3other\nodejs\node.exe`（开发者本机路径），
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
| 1.3.2 | 待定 | 免责声明强化；LICENSE + MIT 署名补齐；port_free 异步；删 README 版本历史 |
| 1.3.1 | `e9fc6f9` | 总闸+分开关；自定义 shim |
| 1.3.0 | `86742ff` | 模型可选（models 配置项） |
| 1.2.1 | `0c142b6` | 文档突出「白嫖」；改 aiohttp 异步；对齐官方规范 |
| 1.2.0 | `2592fc5` | 零配置开箱即用；Trae 凭据自动发现 |
| 1.1.1 | `8159e9c` | 修 Qoder APPDATA 兜底、去掉硬编码本机路径 |
| 1.1.0 | `08d02da` | 6 个 shim、日志落盘、`/shim logs` |
| 1.0.0 | `4456c4d` | 首个版本，3 个 shim |

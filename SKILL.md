---
name: astrbot-shim-connector
description: 白嫖机器人：把已付费的 WorkBuddy / Trae / Qoder 订阅变成 AstrBot 的模型源（75 个候选模型按需勾选，零 API 费用、零配置），含多账号池、扫码登录、余额查询、轮换层可视化编辑。当用户要把本机客户端的模型接进机器人、问怎么不花 API 钱让机器人跑起来、装了这个插件、shim 起不来、provider 没注册、模型返回空、端口冲突、/shim 命令怎么用、凭据读不到、账号 401、轮换层顺序没变化、fallback_provider_ids、主链顺序、或需要判断问题出在插件层/shim 层/provider 层时使用。触发词：shim_connector、白嫖、本机模型接入、免费模型、零成本、WorkBuddy 接入、Trae 接入、Qoder 接入、provider 没注册、shim 起不来、模型返回空、8787、8788、8789、8791、8792、/shim 命令、轮换层、fallback_provider_ids、主链顺序、账号 401、vault。
---

# 白嫖机器人 | AstrBot 本机模型接入插件

把 Qoder / Trae / WorkBuddy（国内 + 国际）这些本机已登录的客户端，
连同视觉轮换层和 LLM 池，通过 loopback shim 变成 AstrBot 可用的模型源。

**仓库**：https://github.com/rawLeaf/astrbot_plugin_shim_connector
**当前版本**：v1.7.1（2026-11-13）

---

## 它解决什么

**一句话：把你已经付过钱的 AI 订阅，变成机器人能用的模型。**

你在机器上登录了 WorkBuddy / Trae / Qoder，这些客户端每月在扣钱。
但它们不发 API Key，所以机器人调用时你还得再付一次 API 费用。

这个插件在本机起一组 shim，把「客户端已登录的额度」翻译成 OpenAI 兼容端点，
机器人直接调用——**边际成本 0，钱你已经付过了。**

合计 36 个候选模型（WorkBuddy 6 + Trae 6 + Qoder 24），可按需勾选要注册哪些。

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
| `trae` | 8788 | `trae_shim` | Trae（6 个可选）|
| `qoder` | 8789 | `qoder_shim` | Qoder 国内/国际（上游实拉，实测 24 个）|
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

| shim | 内置默认模型（可用「刷新模型」探测更多） |
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
| WorkBuddy（桌面端） | `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`（CN）/`workbuddy-desktop-ai.info`（INTL），5.6.0+ 的加密字段靠启动 app 取 at-rest 密钥 |
| WorkBuddy（多账号 vault） | 扫码登录 / 从 `dsh-connect-workbuddy` 的 vault 导入 |
| Trae | 环境变量 `TRAE_AUTH_FILE` 指向的 JSON |
| Qoder | `auth.v1.dat`（OSCrypt + DPAPI）|

**所有 shim 只绑 `127.0.0.1`**，用占位 token 认证。

> 安全性：shim 只把凭据发给**官方上游**（trae / 腾讯 / qoder），
> 不含任何遥测，不会把 token 写到别处或打进日志。

---

## ⚠️ WorkBuddy 凭据的三个大坑（2026-11-10 实战）

### 坑 1：桌面端只存「当前登录」的那一个账号

`workbuddy-desktop.info` 的结构：

```json
{
  "auth": { "accessToken": "..." },          // ← 只有当前账号的 token
  "account": { "uid": "fe93119a-...", "uin": "..." },
  "accounts": [ { "uid": "fe93119a-..." } ],  // ← 只有 1 条
  "allAccounts": [ { "uid": "fe93119a-..." } ] // ← 只有 1 条
}
```

**用户在客户端切换账号时，文件被新账号覆盖，旧账号的 token 直接消失。**

所以「为什么不能从桌面端直接读出所有账号」——因为桌面端根本不留历史。
想要多账号，只能：

1. 每次某账号登录时立刻导入（趁 token 还在）
2. 用扫码登录（走 OAuth 流程，不依赖桌面端）
3. **从 `dsh-connect-workbuddy` 的 vault 导入**（那个会累积历史）

### 坑 2：vault 里可能有同一个账号的两份，其中一份是坏的

`138****6954` 出现在三个地方，只有一份能用：

| 位置 | 有效期 | issuer | 实测 |
|---|---|---|---|
| `D:\dev\dsh-home\workbuddy-vault\cn` | **12-10** | `www.codebuddy.cn` | ✅ **能用** |
| `C:\Users\<用户>\.dsh\workbuddy-vault\cn` | 11-12 | `copilot.tencent.com` | ❌ 401 |
| 插件自己的 `.vault\cn` | 11-12 | `copilot.tencent.com` | ❌ 401 |

**排查 401 时必须核对所有 vault 位置，不能只看一处就下结论。**
用 JWT 的 `iss` 字段能快速分辨新旧（`codebuddy.cn` 是新签发的）。

### 坑 3：JWT 没过期 ≠ token 有效

`138****6954` 的旧 token JWT `exp` 是 11-12（未过期），但服务端返回 **401**。

**服务端可以主动作废 token**（换设备/改密/长期不用/被新登录顶掉）。
判断 token 死活**只能实际调用**，不能只看 `exp`。

### 导入时的正确做法

`importFromDesktop` / `importFromDshVault` 必须是「**更新的覆盖旧的**」而不是「uid 相同就跳过」：

```javascript
// ❌ 错误：uid 相同就跳过 → 桌面端重新登录后 vault 还是旧 token
if (existing.some((x) => x.uid === uid)) { skip; }

// ✅ 正确：比较 expiresAtMs，更新的覆盖
const sameUid = existing.find((x) => x.uid === uid);
if (sameUid) {
  if (newExp <= oldExp) skip;
  else overwrite;
}
```

同理，导入时**必须保留 `nickname` / `uin`**（`parseWorkBuddyAuth` 已经解出来了，别再写成空串）。

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

## 改模型顺序（其它对话看这里）

**只想调整机器人用模型的先后顺序时，改这一份文件：**

```
<AstrBot data>/cmd_config.json
  → agent_runner.config.model.fallback_provider_ids[]
```

数组从上到下 = 优先顺序。改完刷新「轮换层」页面即可看到（插件读磁盘，不用重启）。

### 两个轮换层，各管各的

| 切换项 | 用途 | 顺序来自 | 改主链会影响它吗 |
|---|---|---|---|
| **通用 LLM 池 llm_pool** | 文本对话 | 上面那份 `fallback_provider_ids` | ✅ 会 |
| **视觉轮换 vision** | 图片理解 | 插件自己的 `vision.priority` | ❌ 不会 |

**不要把两边当成同一份。** 之前出过 bug：把两个都绑到主链，结果 vision 的图片顺序也被文本 fallback 带跑了。

### 页面里改

「扩展功能 → 本机模型接入 → 轮换层」：

- 先选 **视觉轮换 vision** 或 **LLM 池 llm_pool**
- ↑↓ 调顺序 → 点「保存并重启」
- 只有 **llm_pool** 的保存会同步写回主链；**vision 不会动主链**

### 常见疑问

| 问 | 答 |
|---|---|
| 我在别的程序改了顺序，页面没变 | 确认改的是 `cmd_config.json` 的 `fallback_provider_ids`，不是插件的 `vision.priority` |
| 页面显示「未在运行」 | AstrBot 重载后 shim 串行启动，等 20 秒，或看门狗 30 秒自愈 |
| 某行标「shim 未加载」 | 主链里写了不存在的 provider（如 `hy4-preview`），不影响其它行，可删可不删 |
| 改完要重启 AstrBot 吗 | 改文件不用；改插件 Python 代码才要（模块有缓存） |

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

## WorkBuddy 域名（2026-11-10 迁移）

国内区历史上用过三个域名，**目前统一到 `www.codebuddy.cn`**：

| 域名 | 状态 | 能干什么 |
|---|---|---|
| `copilot.tencent.com` | 最老，已迁 | chat / 名册（2026-11-10 实测仍通，但不建议用） |
| `www.workbuddy.cn` | 中间过渡 | chat / 名册 ✅，billing ❌ |
| **`www.codebuddy.cn`** | **当前默认** | chat / 名册 / billing **三个都通** |

代码里的定义：

```javascript
const CN_CHAT_BASE    = process.env.WB_CN_CHAT_BASE    || "https://www.codebuddy.cn";
const CN_BILLING_BASE = process.env.WB_CN_BILLING_BASE || "https://www.codebuddy.cn";
const CHAT_BASE    = REGION === "global" ? "https://www.workbuddy.ai" : CN_CHAT_BASE;
const BILLING_BASE = REGION === "global" ? "https://www.codebuddy.ai" : CN_BILLING_BASE;
```

**回滚开关**（改环境变量即可，不用动代码）：

```bash
WB_CN_CHAT_BASE=https://www.workbuddy.cn      # 只换 chat
WB_CN_BILLING_BASE=https://www.codebuddy.cn   # 只换 billing
```

### 实测方法

换域名前先用一个真账号打三个端点，全通才改代码：

```bash
# 1) 名册
curl -H "Authorization: Bearer $TOKEN" -H "User-Agent: WorkBuddy/1.0.0" \
     https://www.codebuddy.cn/v3/config

# 2) chat（必须 stream:true，否则 11101）
curl -X POST https://www.codebuddy.cn/v2/chat/completions \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -H "User-Agent: WorkBuddy/1.0.0" -H "Accept: text/event-stream" \
     -d '{"model":"hy3","messages":[{"role":"system","content":"hi"},{"role":"user","content":"hi"}],"max_tokens":20,"stream":true}'

# 3) 余额
curl -X POST https://www.codebuddy.cn/v2/billing/meter/get-user-resource \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"PageNumber":1,"PageSize":100,"ProductCode":"p_tcaca","Status":[0,3],
          "PackageEndTimeRangeBegin":"2026-11-10 00:00:00",
          "PackageEndTimeRangeEnd":"2127-11-10 00:00:00"}'
```

> `/v2/plugin/auth/state` 在 `www.workbuddy.cn` 上是 404，扫码登录仍走 `www.codebuddy.cn`。

### vault 里的 domain 字段不用改

凭据 JSON 里的 `auth.domain` 只用来**判断区域**：

```javascript
const isGlobal = domain.includes("workbuddy.ai");   // 含 .ai = global，否则 cn
```

所以 `copilot.tencent.com` / `www.codebuddy.cn` / `www.workbuddy.cn` 都会被正确判成 `cn`，
**不需要迁移旧数据**。实际请求统一走 `CHAT_BASE`，跟这个字段无关。

---

## 按客户端速查

| 客户端 | 最常踩的 |
|---|---|
| **Trae** | 必须设 `TRAE_AUTH_FILE`；模型名用 `config_name` 不是显示名；带工具调用历史会返回空（**v1.1.0 的 shim 已内置归一化**）|
| **WorkBuddy** | 必须装桌面端（解密要问 app 要密钥）；模型 id 写错会静默返回空 |
| **Qoder** | 用内部 key（`qoder-cn/qmodel_38max`）；国际区常排队；`/v1/models` 慢（10s+）|

---

## 账号池排查流程（照着走）

### 症状：某个账号报 401 / 11140 / 额度查不到

**第 1 步：别急着说是「token 失效」**

先确认你用的是哪一份凭据。同一个账号可能散落在多个 vault：

```
D:\dev\dsh-home\workbuddy-vault\cn\        ← dsh-connect-workbuddy 的（会累积历史）
C:\Users\<用户>\.dsh\workbuddy-vault\cn\   ← 旧的 dsh 位置（可能是过期副本）
<插件目录>\shims\.vault\cn\                 ← 插件自己的
%LOCALAPPDATA%\CodeBuddyExtension\...\auth\ ← 桌面端（只存当前登录）
```

**第 2 步：用 JWT 的 `iss` 快速分辨新旧**

```javascript
const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
console.log(payload.iss);   // 含 codebuddy.cn / workbuddy.cn = 新；含 copilot.tencent.com = 旧
console.log(new Date(payload.exp * 1000).toISOString());
```

**第 3 步：实际调用验证（唯二可信的判断方式）**

```bash
curl -X POST https://www.codebuddy.cn/v2/chat/completions \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -H "User-Agent: WorkBuddy/1.0.0" -H "Accept: text/event-stream" \
     -H "X-User-Id: $UID" \
     -d '{"model":"hy3","messages":[{"role":"system","content":"hi"},{"role":"user","content":"hi"}],"max_tokens":20,"stream":true}'
```

- `200` + 有 `delta` → 能用
- `401` + HTML → **服务端作废了**，只能重新登录 / 扫码
- `200` + `{"code":11140}` → 请求参数问题（常见于没带 `X-User-Id`）

**第 4 步：确认该账号在所有位置都失效了，才判定要重新登录**

### 症状：导入后界面显示「无昵称」

`importFromDesktop` 里写死了 `nickname: ""`。
`parseWorkBuddyAuth` 已经解出来了，要透传：

```javascript
nickname: cred.nickname || "",
uin: cred.uin || "",
```

### 症状：桌面端重新登录了，但 vault 里还是旧 token

导入逻辑是「uid 相同就跳过」。要改成比较有效期：

```javascript
const sameUid = existing.find((x) => x.uid === uid);
if (sameUid) {
  if (Number(cred.expiresAtMs || 0) <= Number(sameUid.expiresAtMs || 0)) {
    skip;                      // vault 里的更新或一样新
  } else {
    overwrite;                 // 桌面端更新，覆盖
  }
}
```

### 症状：安全顾虑「提交会不会上传我的 token」

每次提交前跑这个：

```bash
git add --dry-run -A
```

**输出里不应该出现任何 `vault` 路径。** 如果出现，说明 `.gitignore` 漏了。

`.gitignore` 必须有的（注意 `*` 兜住所有变体）：

```gitignore
shims/.vault*
shims/**/.vault*
shims/.wb-cost.json
shims/.vision-health.json
shims/.llm-pool-health.json
shims/.wb-models.json
shims/.trae-cost.json
shims/.qoder-cost.json
shims/.vision-cost.json
shims/.llm-pool-cost.json
```

**注意 `shims/.vault/` 只匹配目录，匹配不到 `shims/.vault.bak-xxx`** ——
备份目录会带 token，必须用 `shims/.vault*` 兜住。

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

### 备份不能放进 plugins/ 里

AstrBot 会把 `data/plugins/` 下**每个子目录**当插件扫。备份目录放在里面会被当成
残缺插件反复加载，报 `No module named ...bak-...`，面板出现「加载失败插件」。

- ❌ `data/plugins/<插件名>.bak-<时间戳>/`
- ✅ `D:\<备份盘>\backups\<插件名>-<时间戳>/`

删除后**必须重启 AstrBot**，失败记录缓存在内存里，光删目录面板还在。
详见 `TROUBLESHOOTING.md` 第 1.5 节。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| 不支持热更新 | 改了 shim 脚本要 `/shim restart` |
| provider 不会自动删 | 关掉某个 shim 后，已注册的 provider 还在，需手动删 |
| 端口冲突不自动发现 | 固定端口，冲突时改配置 |
| Qoder 模型多但慢 | 实测 24 个，`/v1/models` 10s+（异步，不阻塞） |
| WorkBuddy 依赖桌面端 | 没装 app 就解不开凭据 |

---

## ⛔ 发布纪律（最重要，违反即视为严重错误）

### 绝对规则

**只有用户明确说出「提交 github」「上传」「推送」「发布到 github」时才执行 `git push`。**

其他任何情况都**不准推送**，包括但不限于：

| 用户说的话 | 正确反应 | 错误反应 |
|---|---|---|
| 「改一下 X」 | 改代码 + 同步部署 + 本地 commit | ❌ 顺手 push |
| 「本地更新了吗」 | 只检查和同步 | ❌ 顺手 push |
| 「已经发布了？」 | **只回答状态** | ❌ 当成确认去推 |
| 「这个版本可以提交了」 | 本地 commit | ❌ 顺手 push |
| 「修复这个 bug」 | 改 + commit | ❌ 顺手 push |
| 沉默 / 没提推送 | 什么都不做 | ❌ 主动 push |

### 为什么

用户可能在本地还没验证完。提前推送会让未经确认的代码进入公开仓库（插件市场可见）。

### 正确的工作流

```
用户说改 X
    ↓
改代码
    ↓
同步到部署副本 <AstrBot>/data/plugins/
    ↓
语法检查 + 安全审计
    ↓
git add + git commit（本地）
    ↓
【停在这里，等用户说推送】
    ↓
用户说「提交 github」
    ↓
git push
```

### 每次提交后必须报告

```
本地 HEAD: xxx
线上 HEAD: xxx （或者「未推送，等你确认」）
未推送: N 个提交
```

---

## 版本号规则

### 只在打包发布时升版本号

| 场景 | 升版本？ |
|---|---|
| 改代码 / 改文档，等用户验证 | ❌ 不升 |
| 用户说「升到 X.Y.Z」 | ✅ 按用户指定 |
| 用户说「发布这个版本」 | ✅ 升一位 |
| 修 bug 但用户没说发布 | ❌ 不升 |

### 用户指定版本时严格照做

用户说「1.4.2」就写 1.4.2，**不要自作主张改成 1.4.3**。

### 版本号必须四处一致

```
metadata.yaml           version: "X.Y.Z"
README.md               当前版本 **X.Y.Z**
CHANGELOG.md            ## [X.Y.Z]
SKILL.md                **当前版本**：vX.Y.Z
```

---

## 会话纪律

### 用户说「不用」「不必」时

立即停止该方向，不要：
- ❌ 继续解释为什么要做
- ❌ 提供「替代方案」
- ❌ 问「真的不要吗」

### 用户说「不着急」「先不」时

保持现状，不要：
- ❌ 偷偷提交
- ❌ 继续改相关代码
- ❌ 反复确认「真的不提交吗」

### 测试完必须如实报告

**说「测过了」就必须真的跑过。**

| 说法 | 要求 |
|---|---|
| 「已修复」 | 必须贴出修复后的实测输出 |
| 「测试通过」 | 必须跑过真实场景，不能只做静态检查 |
| 「应该能用」 | 不准说，要么测过要么说没测 |

**反例**：用假配置、假端口、预设分数做「测试」，然后说「测过了」。
这不算测试 —— 必须用真实配置和真实上游。

---

## 其它对话最小交接

**精简版 skill（其它对话自动加载）物理存放在 D 盘**：
`D:\dev\dsh-home\skills\astrbot-shim-connector\SKILL.md`，
`C:\Users\31165\.agents\skills\astrbot-shim-connector` 是指向它的目录联接（junction）。
改 skill 直接改 D 盘那份。

改这个插件前只要知道三件事：

1. **源码**在 `D:\9\new\astrbot_plugin_shim_connector\`，
   **AstrBot 实际跑的**是 `D:\4game\ai\robot\core\data\plugins\astrbot_plugin_shim_connector\`。
   改完源码要同步过去；改 `main.py` 还要重启 AstrBot（Python 模块有缓存），
   改 `pages/*` 刷新页面即可。
2. **没明确说「推送 / 上传 / 提交 github」就不 push**；说「不要更新版本」就不动版本号。
3. **提交前 `git add --dry-run -A` 确认没有 `.vault`**，账号 token 绝不进仓库。

改模型顺序只看上一章。其它细节（凭据、域名、端口、看门狗）在本文档其余章节里。

---
## 给 agent 的操作要点

1. **先问是哪一层**：插件页看见了吗 → `/shim` 显示什么 → provider 列表有没有 `<source_id>/`。这三个答案能定位 90% 的问题。
2. **先看日志，别急着改配置**。v1.1.0 起 `/shim logs` 就能看到 shim 输出，不用再手动跑。
3. **先 `curl /v1/models`** 看 shim 到底返回什么，再怀疑插件。
4. **改完 shim 脚本必须 `/shim restart`**，不重启不生效。
5. **别把真实 token 写进配置**。`sk-*-local` 是占位符，shim 会自己转发到上游。
6. **provider id 是 `<source_id>/<model>`**，改模型链时照这个格式写。
7. 详细排障见同目录 `TROUBLESHOOTING.md`。

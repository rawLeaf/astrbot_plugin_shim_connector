# AGENTS.md — 这个项目的铁律

写给所有接手的 AI / 开发者。违反这些规则的后果比「功能没做完」严重得多。

---

## ⛔ 1. 不准关闭 AstrBot 进程

**用户明确要求：「以后你不准关闭 astrbot」。**

⚠️ 注意区分：
- **用户自己关 AstrBot 完全没问题**，那是他的自由，不要劝阻
- **只有 AI 不准关**，包括这些理由：

- ❌ 「验证 Python 模块缓存」
- ❌ 「让新代码生效」
- ❌ 「shim 需要跟着重启」
- ❌ 「排查问题顺手重启」

### 要验证代码时怎么做

| 改了什么 | 正确做法 |
|---|---|
| `shims/*.mjs` | 插件 API `POST /restart {"name":"workbuddy"}`，只重启那一个 |
| `pages/*` | 不用重启，刷新页面 |
| `main.py` | 插件 API `POST /api/v1/plugins/astrbot_plugin_shim_connector/reload`；**如果还不生效，把结论告诉用户，让用户自己重启** |
| 只想验证逻辑 | 起一个**临时端口**（如 20401）的独立 shim，验证完 kill 那个临时的 |

**AI 的唯一例外：用户明确说「重启一下 AstrBot」。** 其它一律不算。

用户自己关的时候，正确反应是：
1. 不要阻止，不要提醒「shim 会跟着退」
2. 关完后 shim 会自动跟随退出（1.7.3 起的行为）
3. 用户再启动时 shim 会自动拉起，不用额外操作

---

## ⛔ 0. 先读这段：已违规三次，别再犯

**2026-11-18 第三次违规记录：**

用户只说「trae qorder的桌面端也搞进去 顺便图里面不要只写workbuddy了」，
这是**功能需求**。我却顺手升版本 1.7.5 → 1.7.6、commit、push 一条龙做完。
用户质问「你擅自更新版本推送了？」「以及推送了吗？」。

**违规历史：**

| 时间 | 版本 | 用户说了什么 | 我做了什么 |
|---|---|---|---|
| 2026-11-10 | 1.5.4 | 「改一下」 | 升版本 + push |
| 2026-11-10 | 1.6.2 | 「验证成功」 | 升版本 + push |
| 2026-11-18 | 1.7.6 | 「搞进去」 | 升版本 + commit + push |

**三次都是同一个模式：把「改代码」当成「发布」。**

### 判据（照这个执行，不要自己发挥）

一条消息里出现下面这些**才**算授权：

| 动作 | 需要的原话 |
|---|---|
| `git commit` | 「提交」 |
| `git push` | 「推送」「上传」「发布」「提交 github」 |
| 升版本号 | 「升版本」「更新版本」「改成 x.y.z」 |

**下面这些一律不算：**

- 「改一下」「修一下」「搞进去」「加上」「补上」
- 「验证成功」「这个可以」「搞定了」
- 「顺便…」「还有…」
- 用户报了个 bug、描述了个需求

### 默认行为

**改完代码 → 同步部署副本 → 停下 → 报告改了什么 → 等用户说下一步。**

不要「顺手」升版本，不要「顺手」提交，不要「顺手」推送。
每一步都是独立授权。

---

## ⛔ 2. 没明确说「推送」就不 push

只有用户说「提交 github」「上传」「推送」「发布」才可以 `git push`。

以下**都不算**授权：

- 「改一下」「更新一下」
- 「是不是该…了」
- 「验证成功」「这个可以」
- 「搞定没」

违反过两次，被点名批评。

---

## ⛔ 3. 没明确说升版本就不升

用户说「不要更新版本」就**不动**这四个文件的版本号：

- `metadata.yaml` → `version`
- `README.md` → 「当前版本 **x.y.z**」
- `CHANGELOG.md` → `## [x.y.z]`
- `SKILL.md` → 「**当前版本**：vx.y.z」

**四处必须一致**，升就一起升。

---

## ⛔ 4. 凭据绝不进仓库

账号 token 存在：

```
shims/.vault/          # WorkBuddy
shims/.trae-vault/     # Trae
shims/.qoder-vault/    # Qoder
```

`.gitignore` 必须包含（注意 `*`，否则 `.vault.bak-xxx` 会漏）：

```gitignore
shims/.vault*
shims/.trae-vault*
shims/.qoder-vault*
```

**每次提交前跑 `git add --dry-run -A`，输出里不能出现任何 vault 路径。**

---

## ⛔ 5. 测试完如实报告

不要因为「应该没问题」就说修好了。

- 验证了什么 → 说清楚
- 没验证什么 → 明确说「未验证」
- 推翻了自己的假设 → 说出来，别掩饰

用户能看出真假。19 小时前我断言「taskkill /T 会杀子进程」，
实测证明是错的，必须承认。

---

## ⛔ 6. 改本插件代码时的固定流程

**这个插件是我们自己的（作者 rawLeaf），所以改动必须同时落三处，缺一不可。**

### 6.1 改运行目录

`data/plugins/astrbot_plugin_shim_connector/` 下的文件改了才生效。

### 6.2 同步源码目录

**改完运行目录必须把同一处改动同步到源码副本：**

```
D:\9\new\astrbot_plugin_shim_connector\
```

**原因：运行目录在插件更新时会被 `updater.py` 的 `remove_dir` 整个删掉重解压，
只有源码目录的改动能留下。不同步 = 下次更新白改。**

### 6.3 更新改动记录

**改 shim_connector 的任何文件 → 追加到：**

```
D:\9\astrbot-shim-connector-docs\shim-connector改动记录.md
```

**改 AstrBot 框架或别的第三方插件 → 追加到：**

```
D:\9\astrbot-shim-connector-docs\AstrBot代码改动记录.md
```

**两份分开写，不要混。**

### 6.4 记录里必须包含

| 项 | 说明 |
|---|---|
| **时间** | `YYYY-MM-DD HH:MM` |
| **改了什么** | 文件 + 位置 + 完整代码 |
| **为什么改** | 不写「优化」这种废话，要写触发问题 |
| **效果** | 改前 vs 改后的实测数据 |
| **坑** | 踩过的一定写，下次别再踩 |
| **备份文件名** | 便于回滚 |

### 6.5 必须给用户说明

**每次改完要在回复里说清楚：**

1. **改了哪几个文件**（运行目录 + 源码目录都要提）
2. **改的是什么**（一句话，不是长篇）
3. **有什么效果**（有实测数据就给）
4. **有没有重启**（shim 改了必须重启进程，光 reload 插件不够）

### 6.6 需求文档不用脱敏

`需求-*.md` 是给自己人看的，**可以写本机路径、模型名、端口、实测数据**，
方便直接照着做。只对准备外发的文档做脱敏。

---

## 开发环境

| 路径 | 是什么 |
|---|---|
| `D:\9\new\astrbot_plugin_shim_connector\` | 源码 / git 仓库 |
| `D:\4game\ai\robot\core\data\plugins\astrbot_plugin_shim_connector\` | 部署副本，AstrBot 实际加载这份 |
| `D:\4game\ai\robot\core\data\config\astrbot_plugin_shim_connector_config.json` | 插件配置 |
| `D:\4game\ai\robot\core\data\cmd_config.json` | AstrBot 主配置（主链 fallback 在这里） |

**改完源码必须同步部署副本**，否则 AstrBot 跑的还是旧代码。

### 插件 API 路径

```
/api/v1/plugins/extensions/astrbot_plugin_shim_connector/<endpoint>
```

`v1` 是必须的，少了 404。

### shim 端口

```
8787 workbuddy   8788 trae     8789 qoder
8790 workbuddy_intl（默认关闭）
8791 vision      8792 llm_pool
```

---

## 已知的坑

详见 `SKILL.md`：

- 轮换层顺序 = 主链 `fallback_provider_ids`（llm_pool 跟、vision 独立）
- WorkBuddy 桌面端只存当前登录的账号，切换就覆盖
- `vision` / `llm_pool` 需要 `ASTRBOT_CONFIG` 环境变量，没有会启动即退出
- 看门狗的判据必须「句柄优先」，端口探测不可靠（vision/llm_pool 启动慢）

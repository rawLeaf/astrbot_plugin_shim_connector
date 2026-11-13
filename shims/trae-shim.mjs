#!/usr/bin/env node
/**
 * trae-shim —— 把 Trae（国内版）模型接到 OpenAI 兼容接口上，给 AstrBot 用
 *
 * 凭据来源（自动发现，无需配置）：
 *   1. Trae 桌面端 User/globalStorage/storage.json，解密 iCubeAuthInfo 字段
 *   2. 或用 TRAE_AUTH_FILE 指定凭据 JSON
 * 上游协议：POST https://trae-api-cn.mchost.guru/api/ide/v2/llm_raw_chat
 *   - Authorization: Cloud-IDE-JWT <token> + X-Ide-Token
 *   - body 需要 config_name（= 模型名）与 pass_back_reasoning
 *   - 强制 stream: true
 *
 * 用法：
 *   WB_SHIM_PORT=8788 node trae-shim.mjs
 */

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";





// ── Trae 桌面端凭据自动发现（storage.json 解密）─────────────────────
// 算法改写自 dsh-connect-trae（MIT, Copyright (c) 2026 LaoDing）
// https://github.com/dingminhua/dsh-connect-trae
//
// Trae 桌面端把凭据存在 User/globalStorage/storage.json 的
// "iCubeAuthInfo://icube.cloudide" 字段里，格式为：
//   [6字节头][32字节随机][AES-128-CBC 密文]
// 密钥/IV = sha512(sha512(random) || salt) 的前 32 字节
// 密文内容 = sha512(body) || body            （前 64 字节是校验和）

/** 两套盐值（hex），分别对应两种加密家族。 */
const SALT_A = Buffer.from("52096ad53036a538bf40a39e81f3d7fb7ce339829b2fff87348e4344c4dee9cb547b9432a6c2233dee4c950b42fac34e082ea16628d924b2765ba2496d8bd125", "hex");
const SALT_B = Buffer.from("1fdda8338807c731b11210592780ec5f60517fa919b54a0d2de57a9f93c99cefa0e03b4dae2af5b0c8ebbb3c83539961172b047eba77d626e169146355210c7d", "hex");

const TRAE_AUTH_KEY = "iCubeAuthInfo://icube.cloudide";

function xorBuffers(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] ^ (b[i] ?? 0);
  return out;
}

function decryptTraeValue(encoded) {
  const buf = Buffer.from(encoded, "base64");
  if (buf.length <= 102) throw new Error("Trae 凭据密文过短");
  const header = buf.subarray(0, 6);
  const isAes = header.equals(Buffer.from([116, 99, 5, 16, 0, 0]));
  const isAesPrivate = header.equals(Buffer.from([18, 57, 32, 32, 2, 3]));
  if (!isAes && !isAesPrivate) throw new Error("未知的 Trae 凭据加密头");
  const random = buf.subarray(6, 38);
  const encrypted = buf.subarray(38);
  const salt = xorBuffers(SALT_A, SALT_B);
  const first = createHash("sha512").update(random).digest();
  const derived = createHash("sha512").update(Buffer.concat([first, salt])).digest();
  const decipher = createDecipheriv("aes-128-cbc", derived.subarray(0, 16), derived.subarray(16, 32));
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  if (decrypted.length < 64) throw new Error("Trae 凭据明文过短");
  const expected = decrypted.subarray(0, 64);
  const plaintext = decrypted.subarray(64);
  const actual = createHash("sha512").update(plaintext).digest();
  if (!expected.equals(actual)) throw new Error("Trae 凭据完整性校验失败");
  return plaintext.toString("utf8");
}

/** Trae 桌面端 storage.json 的候选路径。 */
function traeStorageCandidates() {
  const home = homedir();
  const out = [];
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA || join(home, "AppData", "Roaming");
    for (const app of ["Trae CN", "Trae", "TraeCN"]) {
      out.push(join(roaming, app, "User", "globalStorage", "storage.json"));
    }
  } else if (process.platform === "darwin") {
    for (const app of ["Trae CN", "Trae"]) {
      out.push(join(home, "Library", "Application Support", app, "User", "globalStorage", "storage.json"));
    }
  } else {
    const cfg = process.env.XDG_CONFIG_HOME || join(home, ".config");
    for (const app of ["Trae CN", "Trae"]) {
      out.push(join(cfg, app, "User", "globalStorage", "storage.json"));
    }
  }
  return out;
}

/** 从 Trae 桌面端 storage.json 直接解出凭据（不依赖 DSH 插件）。 */
function loadCredentialFromDesktop() {
  const tried = [];
  for (const p of traeStorageCandidates()) {
    tried.push(p);
    if (!existsSync(p)) continue;
    let doc;
    try {
      doc = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    const enc = doc[TRAE_AUTH_KEY];
    if (typeof enc !== "string" || enc === "") continue;
    let plain;
    try {
      plain = decryptTraeValue(enc);
    } catch {
      continue;
    }
    let j;
    try {
      j = JSON.parse(plain);
    } catch {
      continue;
    }
    const token = typeof j.token === "string" ? j.token : "";
    if (token === "") continue;
    return {
      accessToken: token,
      refreshToken: typeof j.refreshToken === "string" ? j.refreshToken : "",
      userId: String(j.userId ?? ""),
      host: typeof j.host === "string" ? j.host : "",
      userRegion: typeof j.userRegion === "string" ? j.userRegion : "",
      expiresAtMs: typeof j.expiredAt === "number" ? j.expiredAt : 0,
      source: "desktop:" + p,
    };
  }
  throw new Error(
    "找不到 Trae 凭据。已尝试：\n  " + tried.join("\n  ") +
    "\n\n请确认：\n  1. Trae 桌面端已安装并登录\n" +
    "  2. 或用 TRAE_AUTH_FILE 指定凭据 JSON"
  );
}

// ── Trae 账号池 ─────────────────────────────────────────────
//
// 参考 dsh-connect-trae 的 .trae-auth.<region>.json 格式：
//   { version, credentials: { <key>: { accessToken, refreshToken, userId,
//     accountName, host, userRegion, expiresAtMs, edition, source } } }
//
// 插件自己维护一份 vault（不碰 dsh 的文件），格式与 workbuddy 的 vault 对齐：
//   .trae-vault/cn/<accountId>.json
//
// 2026-11-13：trae-shim 原来只用 credentials 里的**第一个**账号，
// 现在支持多个、页面可勾选排序、额度用尽自动换号。

const TRAE_VAULT = process.env.TRAE_VAULT_DIR ||
  join(fileURLToPath(new URL(".", import.meta.url)), ".trae-vault");

/** Trae 账号 id：sha256(edition + userId) 前 24 位（对齐 dsh-connect-trae）。 */
function traeAccountId(rec) {
  const stable = String(rec.edition || "cn") + "\0" + String(rec.userId || rec.accountName || "unknown");
  return createHash("sha256").update(stable).digest("hex").slice(0, 24);
}

function traeVaultDir(region = "cn") {
  return join(TRAE_VAULT, region);
}

function ensureTraeVault(region = "cn") {
  const d = traeVaultDir(region);
  try { mkdirSync(d, { recursive: true, mode: 0o700 }); } catch { /* 已存在 */ }
  return d;
}

function traeVaultFiles(region = "cn") {
  const d = traeVaultDir(region);
  let entries = [];
  try { entries = readdirSync(d); } catch { return []; }
  return entries
    .filter((n) => /\.json$/.test(n))
    .map((n) => ({ accountId: n.replace(/\.json$/, ""), path: join(d, n) }));
}

function readTraeVault(path) {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    if (doc && typeof doc.accessToken === "string" && doc.accessToken !== "") return doc;
  } catch { /* 坏文件 */ }
  return null;
}

/** 把一条 dsh 格式凭据写进 vault。 */
function writeTraeVault(region, rec) {
  const d = ensureTraeVault(region);
  const accountId = traeAccountId(rec);
  const target = join(d, accountId + ".json");
  const tmp = target + ".tmp." + process.pid;
  const doc = {
    version: 1,
    accountId,
    refreshedAtMs: Date.now(),
    accessToken: rec.accessToken || rec.token || "",
    refreshToken: rec.refreshToken || "",
    userId: rec.userId || "",
    accountName: rec.accountName || rec.account?.username || "",
    host: rec.host || "https://api.trae.cn",
    userRegion: rec.userRegion || "CN",
    edition: rec.edition || "cn",
    expiresAtMs: Number(rec.expiresAtMs || rec.expiredAt || rec.expiresAt || 0),
    refreshExpiresAtMs: Number(rec.refreshExpiresAtMs || 0),
    source: rec.source || "dsh",
  };
  if (doc.accessToken === "") return null;
  writeFileSync(tmp, JSON.stringify(doc, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, target);
  return accountId;
}

/** 列出 vault 里的账号（脱敏，供页面）。 */
function listTraeAccounts(region = "cn") {
  return traeVaultFiles(region).map((f) => {
    const a = readTraeVault(f.path);
    if (!a) return { accountId: f.accountId, valid: false, region };
    const exp = Number(a.expiresAtMs || 0);
    return {
      accountId: a.accountId,
      region,
      valid: true,
      nickname: a.accountName || "(无昵称)",
      userId: a.userId || "",
      edition: a.edition || "cn",
      expiresAtMs: exp,
      expired: exp > 0 && exp < Date.now(),
      remainingMs: exp > 0 ? Math.max(0, exp - Date.now()) : null,
      source: a.source || "dsh",
    };
  });
}

/** 当前选中/粘性账号。 */
let stickyTraeAccountId = null;
const traeCooldown = new Map();   // accountId → 冷却到什么时候

/** 选一个可用账号。 */
function pickTraeAccount(region = "cn") {
  const files = traeVaultFiles(region);
  if (files.length === 0) return null;
  const now = Date.now();
  const candidates = [];
  for (const f of files) {
    const a = readTraeVault(f.path);
    if (!a) continue;
    const exp = Number(a.expiresAtMs || 0);
    if (exp > 0 && exp - now < 300000) continue;      // 快过期
    if ((traeCooldown.get(a.accountId) || 0) > now) continue;
    candidates.push(a);
  }
  if (candidates.length === 0) {
    if (traeCooldown.size > 0) {
      traeCooldown.clear();
      return pickTraeAccount(region);
    }
    return null;
  }
  if (stickyTraeAccountId) {
    const hit = candidates.find((a) => a.accountId === stickyTraeAccountId);
    if (hit) return hit;
  }
  stickyTraeAccountId = candidates[0].accountId;
  return candidates[0];
}

/** 额度用尽 → 冷却 30 分钟。 */
function coolDownTrae(accountId, minutes = 30) {
  if (!accountId) return;
  traeCooldown.set(accountId, Date.now() + minutes * 60000);
  if (stickyTraeAccountId === accountId) stickyTraeAccountId = null;
  console.error("[TRAE-shim] 账号 " + accountId.slice(0, 12) + " 冷却 " + minutes + " 分钟");
}

/** 从 dsh-home 的 .trae-auth.<region>.json 导入多个账号。 */
function importTraeFromDsh(region = "cn") {
  const dshHome = process.env.DSH_HOME ||
    join(homedir(), ".dsh");
  const candidates = [
    join(dshHome, `.trae-auth.${region}.json`),
    join("D:", "dev", "dsh-home", `.trae-auth.${region}.json`),
  ];
  const seen = new Set();
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    let doc;
    try { doc = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
    const list = doc.credentials || {};
    for (const rec of (Array.isArray(list) ? list : Object.values(list))) {
      if (!rec || typeof rec !== "object") continue;
      const id = traeAccountId(rec);
      if (seen.has(id)) continue;
      seen.add(id);
      writeTraeVault(region, rec);
    }
  }
  return seen.size;
}



// ── 耗费统计 ────────────────────────────────────────────────
//
// 累计每个模型的调用次数、token 用量、以及上游返回的成本字段（若有）。
// 落盘到 .trae-cost.json，供 /cost 查询。

const COST_FILE = process.env.TRAE_COST_FILE ||
  join(fileURLToPath(new URL(".", import.meta.url)), ".trae-cost.json");

let costStats = (() => {
  try {
    const doc = JSON.parse(readFileSync(COST_FILE, "utf8"));
    if (doc && typeof doc === "object" && doc.byModel) {
      return { byModel: doc.byModel, since: doc.since || new Date().toISOString() };
    }
  } catch { /* 首次运行 */ }
  return { byModel: {}, since: new Date().toISOString() };
})();

let costDirty = false;

/** 记录一次成功调用。 */
function recordCost(model, credit, usage) {
  if (!model) return;
  const cur = costStats.byModel[model] || {
    calls: 0, credit: 0, promptTokens: 0, completionTokens: 0, fails: 0,
  };
  cur.calls += 1;
  if (credit !== null && credit !== undefined) {
    cur.credit = Number((cur.credit + (Number(credit) || 0)).toFixed(4));
  }
  if (usage) {
    cur.promptTokens += Number(usage.prompt_tokens || 0);
    cur.completionTokens += Number(usage.completion_tokens || 0);
  }
  costStats.byModel[model] = cur;
  costDirty = true;
}

/** 记录一次失败。 */
function recordFail(model) {
  if (!model) return;
  const cur = costStats.byModel[model] || {
    calls: 0, credit: 0, promptTokens: 0, completionTokens: 0, fails: 0,
  };
  cur.fails += 1;
  costStats.byModel[model] = cur;
  costDirty = true;
}

/** 落盘（只在有变化时写）。 */
function flushCost() {
  if (!costDirty) return;
  try {
    writeFileSync(
      COST_FILE,
      JSON.stringify({ ...costStats, updatedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
    costDirty = false;
  } catch (e) {
    console.error("[TRAE-shim] 写耗费统计失败: " + String(e));
  }
}

setInterval(flushCost, 30000).unref?.();

/**
 * 构造 /cost 的响应体。
 */
function buildCostResponse() {
  const byModel = costStats.byModel || {};
  let totalCredit = 0;
  let totalCalls = 0;
  let totalFails = 0;

  const rows = Object.entries(byModel)
    .map(([id, x]) => {
      const calls = x.calls || 0;
      const credit = Number((x.credit || 0).toFixed(4));
      totalCredit += credit;
      totalCalls += calls;
      totalFails += x.fails || 0;
      return {
        model: id,
        calls,
        fails: x.fails || 0,
        credit,
        costPerCall: calls > 0 ? Number((credit / calls).toFixed(4)) : null,
        free: calls > 0 && credit === 0,
        measured: calls > 0,
        promptTokens: x.promptTokens || 0,
        completionTokens: x.completionTokens || 0,
      };
    })
    .sort((a, b) => b.credit - a.credit || b.calls - a.calls);

  return {
    ok: true,
    since: costStats.since,
    totalCredit: Number(totalCredit.toFixed(4)),
    totalCalls,
    totalFails,
    byModel: rows,
  };
}

const PORT = Number(process.env.TRAE_SHIM_PORT ?? 8788);
const TOKEN = process.env.TRAE_SHIM_TOKEN ?? "sk-trae-local";
const HOST = "127.0.0.1";
const CHAT_BASE = "https://trae-api-cn.mchost.guru";
const CHAT_PATH = "/api/agent/v3/llm_utils_chat";
/**
 * Trae 客户端的**公开应用标识**，写死在客户端本体里，所有用户完全相同。
 * 不是你的账号 ID，也不是任何个人数据 —— 它用于上游区分"这是 Trae 客户端"。
 * 来源：Trae CN 安装目录的 app.asar 常量表。
 */
const APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";

/**
 * Trae 模型目录 —— display_name（客户端显示）→ config_name（上游 API 真名）+ function。
 *
 * 2026-10-28 从 Trae CN 的 state.vscdb（key: AI.agent.model.model_list_map）挖出。
 * 上游 llm_utils_chat 的 body 里 config_name 必须是 config_name，不是 display_name；
 * 且每个模型只在自己的 function（agent 标签）下可用，用错了返回
 * event:error / code 4001 "the param is invalid"（看起来像"模型返回空"）。
 *
 * 实测（2026-10-28，全部 finish_reason=stop 且返回正常文本）：
 *   Doubao-Seed-Code           solo_agent        1020ms
 *   glm-5.3-flash              solo_work_lite    2755ms
 *   DeepSeek-V4-Flash-Official solo_work_lite    1174ms
 *   mimo-v2.6-flash            solo_work_lite    2080ms
 *   minimax-m3.1-flash         solo_work_lite    1972ms
 *   qwen3.8-flash              solo_agent        1835ms
 *
 * rate = features.consumption_rate.data.rate（积分倍率，越小越便宜）。
 */
const MODEL_CATALOG = [
  { id: "DeepSeek-V4-Flash-Official", fn: "solo_work_lite", rate: 0.06, display: "DeepSeek-V4-Flash" },
  { id: "glm-5.3-flash",              fn: "solo_work_lite", rate: 0.08, display: "GLM-5.3-Flash" },
  { id: "Doubao-Seed-Code",           fn: "solo_agent",     rate: 0.06, display: "Seed-Code" },
  { id: "mimo-v2.6-flash",            fn: "solo_work_lite", rate: 0.06, display: "MiMo-V2.6-Flash" },
  { id: "minimax-m3.1-flash",         fn: "solo_work_lite", rate: 0.09, display: "MiniMax-M3.1-Flash" },
  { id: "qwen3.8-flash",              fn: "solo_agent",     rate: 0.08, display: "Qwen3.8-Flash" },
];

// ── 动态模型名册（从客户端 state.vscdb 读）────────────────────
//
// Trae 把完整模型清单存在 state.vscdb 的
//   <id>:AI.agent.model.model_list_map
// 里，按 agent 分类（solo_agent / solo_work_lite / chat_v3 ...）。
//
// 每个模型带 features.consumption_rate.data.rate（积分倍率），
// 这就是「耗费」的量化值：0.06 表示最便宜那一档。

import { existsSync as _existsSync } from "node:fs";
import { join as _join } from "node:path";
import { homedir as _homedir } from "node:os";


// ── 父进程守护 ──────────────────────────────────────────────
//
// 2026-11-13 用户要求：shim 必须依赖 AstrBot 生存，不能变成孤儿进程。
//
// 为什么不在插件的 terminate() 里杀：
//   AstrBot 有两个场景会调 terminate()：
//     1. 用户在面板保存配置 → plugin_manager.reload()
//     2. AstrBot 真的退出
//   terminate() 分辨不出这两个。如果在里面杀 shim，
//   用户改一个开关就会导致 5 个 shim 全部重启（很糟的体验）。
//
// 所以让 shim 自己监控父进程：
//   AstrBot 进程还在 → 继续跑（被下次 initialize 复用，零重启）
//   AstrBot 进程没了 → 主动退出（不留孤儿）
//
// 实现：process.kill(pid, 0) 只做权限/存在性检查，不发信号。
// 连续 MISS_LIMIT 次探测失败才退出，避免瞬时误判。
const PARENT_PID = Number(process.env.SHIM_PARENT_PID || 0);
const PARENT_GUARD_MS = Number(process.env.SHIM_PARENT_GUARD_MS || 5000);
const PARENT_MISS_LIMIT = 2;

if (PARENT_PID > 0) {
  let missCount = 0;
  const guardTimer = setInterval(() => {
    let alive = true;
    try {
      process.kill(PARENT_PID, 0);
    } catch {
      alive = false;
    }
    if (alive) {
      missCount = 0;
      return;
    }
    missCount += 1;
    if (missCount >= PARENT_MISS_LIMIT) {
      console.error(
        "[shim] 父进程 " + PARENT_PID + " 已退出，" +
        "shim 随之退出（不留孤儿进程）"
      );
      clearInterval(guardTimer);
      process.exit(0);
    }
  }, PARENT_GUARD_MS);
  guardTimer.unref?.();
  console.error("[shim] 父进程守护已启用: PID=" + PARENT_PID +
    " 探测间隔 " + PARENT_GUARD_MS + "ms");
}


/** Trae CN 的 state.vscdb 路径。 */
function traeVscdbPath() {
  if (process.env.TRAE_VSCDB) return process.env.TRAE_VSCDB;
  const h = _homedir();
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA || _join(h, "AppData", "Roaming");
    return _join(roaming, "Trae CN", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "darwin") {
    return _join(h, "Library", "Application Support", "Trae CN", "User", "globalStorage", "state.vscdb");
  }
  return _join(h, ".config", "Trae CN", "User", "globalStorage", "state.vscdb");
}

/** 用哪个 agent 的模型列表（默认 solo_agent，模型最全）。 */
const ROSTER_AGENT = process.env.TRAE_ROSTER_AGENT || "solo_agent";

/** 缓存。 */
let rosterCache = null;
let rosterCachedAt = 0;
const ROSTER_TTL_MS = 5 * 60 * 1000;

/**
 * 从 vscdb 读模型名册。
 *
 * 用 node:sqlite（Node 22+）只读打开。读不到就返回 null，
 * 调用方退回静态 MODEL_CATALOG。
 *
 * @param {boolean} force 忽略缓存
 * @returns {Promise<Array|null>} [{id, display, rate, multimodal, reasoning}]
 */
async function loadRosterFromVscdb(force = false) {
  if (!force && rosterCache && Date.now() - rosterCachedAt < ROSTER_TTL_MS) {
    return rosterCache;
  }
  const dbPath = traeVscdbPath();
  if (!_existsSync(dbPath)) {
    console.error("[trae-shim] vscdb 不存在: " + dbPath);
    return null;
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (e) {
    console.error("[trae-shim] node:sqlite 不可用（需要 Node 22+）: " + String(e));
    return null;
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // key 前缀是机器 hash，用 LIKE 匹配
    const row = db.prepare(
      "SELECT key, value FROM ItemTable WHERE key LIKE '%AI.agent.model.model_list_map' LIMIT 1"
    ).get();
    if (!row || !row.value) {
      console.error("[trae-shim] vscdb 里没有 model_list_map");
      return null;
    }
    const map = JSON.parse(row.value);
    const list = Array.isArray(map[ROSTER_AGENT]) ? map[ROSTER_AGENT] : null;
    if (!list) {
      console.error("[trae-shim] agent '" + ROSTER_AGENT + "' 不存在，可选: " + Object.keys(map).join(", "));
      return null;
    }
    const out = [];
    for (const m of list) {
      if (!m || typeof m.name !== "string") continue;
      if (m.selectable === false || m.status === false) continue;
      const rate = m.features?.consumption_rate?.data?.rate;
      out.push({
        id: m.name,
        display: m.display_name || m.name,
        rate: typeof rate === "number" ? rate : null,
        multimodal: m.multimodal === true || m.features?.multimodal?.enable === true,
        reasoning: m.model_type === "reasoning_model" || m.features?.reasoning?.enable === true,
        maxTokens: m.max_tokens ?? null,
      });
    }
    rosterCache = out;
    rosterCachedAt = Date.now();
    console.error(
      "[trae-shim] 从 vscdb 读到 " + out.length + " 个模型（agent=" + ROSTER_AGENT + "）"
    );
    return out;
  } catch (e) {
    console.error("[trae-shim] 读 vscdb 失败: " + String(e));
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** 当前生效的模型 id 列表（动态优先，退回静态）。 */
async function activeModelIds() {
  const roster = await loadRosterFromVscdb();
  if (roster && roster.length > 0) return roster.map((m) => m.id);
  return MODEL_CATALOG.map((m) => m.id);
}

/** 查某个模型的详情（动态优先，退回静态）。 */
async function describeModel(id) {
  const roster = await loadRosterFromVscdb();
  if (roster) {
    const hit = roster.find((m) => m.id === id || m.display === id);
    if (hit) return hit;
  }
  const st = MODEL_CATALOG.find((m) => m.id === id);
  if (st) return { id: st.id, display: st.display, rate: st.rate, multimodal: true, reasoning: false };
  return null;
}

/** 客户端里看到的 display_name → 上游真实 config_name，允许直接用显示名调用 */
const MODEL_ALIAS = {
  "Seed-Code": "Doubao-Seed-Code",
  "MiMo-V2.6-Flash": "mimo-v2.6-flash",
  "MiniMax-M3.1-Flash": "minimax-m3.1-flash",
  "Qwen3.8-Flash": "qwen3.8-flash",
  "GLM-5.3-Flash": "glm-5.3-flash",
  "DeepSeek-V4-Flash": "DeepSeek-V4-Flash-Official",
};

/** 归一化模型名，并取出该模型所属的 function 标签 */
function resolveModel(input) {
  const raw = typeof input === "string" && input.trim() !== "" ? input.trim() : "DeepSeek-V4-Flash-Official";
  const id = MODEL_ALIAS[raw] ?? raw;
  const entry = MODEL_CATALOG.find((m) => m.id === id);
  return { id, fn: entry?.fn ?? "solo_work_lite", entry };
}

// Trae 桌面端的稳定身份（来自 %APPDATA%/Trae CN 的 storage.json / machineid）
const TRAE_IDENTITY = {
  machineId: process.env.TRAE_MACHINE_ID ?? "",
  deviceId: process.env.TRAE_DEVICE_ID ?? "",
  appVersion: process.env.TRAE_APP_VERSION ?? "2.3.93438",
  // app_version_code 必须是数字型：string 会被上游拒为 4001
  buildVersion: Number(process.env.TRAE_BUILD_VERSION ?? 202393438),
};

/**
 * 刷新凭据用的 legacy 契约（实测 2026-10-27 可用）。
 *
 * DSH 的 dsh-connect-trae 插件刷新后**只把新 token 留在内存**，不写回
 * .trae-auth.cn.json，所以文件里的 expiresAtMs 会一直停在旧值，看起来像"过期"，
 * 实际宿主侧是活的。这里补上落盘，让 shim 能自己续期。
 *
 * 当前契约（/trae/api/v3/oauth/ExchangeToken）需要设备私钥签名，外部做不到；
 * legacy 契约只要 ClientID + RefreshToken + UserID，不需要签名，所以走这条。
 */
const EXCHANGE_URL = "https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken";
const DESKTOP_CLIENT_ID = "ono9krqynydwx5";

async function refreshCredential(cred) {
  if (!cred?.refreshToken || !cred?.userId) return null;
  const body = {
    ClientID: DESKTOP_CLIENT_ID,
    ClientSecret: "-",
    RefreshToken: cred.refreshToken,
    UserID: cred.userId,
  };
  const res = await fetch(EXCHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) return null;
  const payload = await res.json();
  const result = payload?.Result ?? {};
  const token = typeof result.Token === "string" ? result.Token : "";
  if (token === "") return null;
  const expiresAtMs = typeof result.TokenExpireAt === "number" ? result.TokenExpireAt : 0;
  return {
    ...cred,
    accessToken: token,
    expiresAtMs,
    ...(typeof result.RefreshToken === "string" && result.RefreshToken !== ""
      ? { refreshToken: result.RefreshToken }
      : {}),
  };
}

/** 把刷新结果写回凭据文件，让下次启动直接可用。 */
function persistCredential(cred) {
  // 只有显式指定了文件才写回；桌面端凭据不碰（那是 app 的文件）
  const target = process.env.TRAE_AUTH_FILE;
  if (!target || !existsSync(target)) {
    console.error("[trae-shim] 凭据来自桌面端，不写回任何文件");
    return;
  }
  try {
    // 刷新的是 vault 里的账号 → 写回对应文件
    if (cred.accountId) {
      const p = join(traeVaultDir("cn"), cred.accountId + ".json");
      if (existsSync(p)) {
        writeFileSync(p, JSON.stringify({ ...cred, refreshedAtMs: Date.now() }, null, 2), "utf8");
        console.error("[TRAE-shim] 已把新 token 写回 vault: " + cred.accountId.slice(0, 12));
        return;
      }
    }
    const doc = JSON.parse(readFileSync(target, "utf8"));
    const list = doc.credentials ?? {};
    const key = Object.keys(list)[0];
    if (key === undefined) return;
    doc.credentials[key] = cred;
    writeFileSync(target, JSON.stringify(doc, null, 2), "utf8");
    console.error("[trae-shim] 已把新 token 写回 " + target);
  } catch (error) {
    console.error("[trae-shim] 写回凭据失败: " + (error && error.message ? error.message : error));
  }
}

/**
 * 取可用凭据：文件里的还没过期就直接用；过期就先刷新再回退到文件值。
 */
async function resolveCredential() {
  let cred;
  try {
    cred = loadCredential();
  } catch (error) {
    console.error("[trae-shim] " + error.message);
    throw error;
  }
  const now = Date.now();
  const expiry = Number(cred.expiresAtMs ?? 0);
  // 留 60 秒余量，避免刚好卡在边界
  if (expiry === 0 || expiry - 60000 > now) return cred;

  console.error("[trae-shim] 凭据已过期，尝试刷新…");
  const fresh = await refreshCredential(cred);
  if (fresh === null) {
    console.error("[trae-shim] 刷新失败，沿用文件里的旧 token");
    return cred;
  }
  persistCredential(fresh);
  console.error("[trae-shim] 刷新成功，新到期时间 " + new Date(fresh.expiresAtMs).toISOString());
  return fresh;
}

/**
 * 取凭据。优先级：
 *   1. TRAE_AUTH_FILE 指定的文件（若存在）
 *   2. Trae 桌面端 storage.json 自动解密
 *
 * 这样第三方用户只要装了 Trae 并登录，**不配任何东西就能用**。
 */
function loadCredential() {
  // 1) 账号池 vault 优先（多账号，页面可管理）
  const vaultCred = pickTraeAccount("cn");
  if (vaultCred) {
    return { ...vaultCred, source: "vault" };
  }

  // 2) 显式指定的文件（兼容旧配置）
  const explicit = process.env.TRAE_AUTH_FILE;
  if (explicit && existsSync(explicit)) {
    const doc = JSON.parse(readFileSync(explicit, "utf8"));
    const list = doc.credentials ?? {};
    const first = list[Object.keys(list)[0]];
    if (first && typeof first.accessToken === "string") {
      return { ...first, source: "file:" + explicit };
    }
    throw new Error("Trae 凭据为空或格式不符: " + explicit);
  }

  // 3) 自动从桌面端解出
  return loadCredentialFromDesktop();
}

function buildHeaders(cred, accept = "text/event-stream") {
  const requestId = randomUUID();
  const traceId = requestId.replaceAll("-", "").slice(0, 32);
  return {
    "Authorization": "Cloud-IDE-JWT " + cred.accessToken,
    "X-Ide-Token": cred.accessToken,
    "x-plugin-channel": "icube-ai",
    "User-Agent": "Trae/" + TRAE_IDENTITY.appVersion,
    "x-app-id": APP_ID,
    "x-machine-id": TRAE_IDENTITY.machineId,
    "x-device-id": TRAE_IDENTITY.deviceId,
    "x-device-type": "windows",
    "x-app-version": TRAE_IDENTITY.appVersion,
    "x-ide-version": TRAE_IDENTITY.appVersion,
    "x-app-version-code": TRAE_IDENTITY.buildVersion,
    "x-ide-version-code": TRAE_IDENTITY.buildVersion,
    "x-ide-version-type": "stable",
    "x-uid": cred.userId,
    "X-Cloudide-Token": cred.accessToken,
    "x-custom-trace-id": traceId,
    "x-flow-traceparent": "04-" + traceId + "-" + traceId.slice(0, 16) + "-01",
    "request-traffic-type": "prod",
    "Content-Type": "application/json",
    "Accept": accept,
  };
}

/**
 * 把一条历史消息的 content 归一化成 Trae 上游能接受的形态。
 *
 * 2026-10-28 复盘（"原神的胡桃" 63 秒卡死）实测结论：
 *
 *   1. content 必须是**数组**（[{type:"text",text}]）。
 *      传字符串直接 4001：
 *      "json: cannot unmarshal string into Go struct field
 *       LLMRawMessage.messages.content of type []*idecopilot.LLMRawMessageContent"
 *      —— 所以字符串要包成数组，而不是反过来。
 *
 *   2. content 数组里不能出现 {type:"think"}。
 *      think 块是 AstrBot 自己的推理载体，上游不认，会 4001 param is invalid。
 *      要降级成 {type:"text"}。
 *
 *   3. tool_calls[].function 必须改写成 **function_call**。
 *      这是最坑的一条：上游 Go 结构体字段叫 FunctionCall，用 OpenAI 的
 *      "function" 上游读不到 Name，报
 *        "LLMRawMessage read field 5 'ToolCalls' error:
 *         ToolCall read field 4 'FunctionCall' error: required field Name is not set"
 *      然后 AstrBot 侧只看到 content:null + finish_reason:'error'，
 *      表现成"模型返回空"，白白重试 3 次再切下一个模型。
 *
 *   4. content 为 null/缺失时补一个空 text 部件，别留给上游自己猜。
 */
function normalizeContent(content) {
  if (content == null) return [{ type: "text", text: "" }];
  if (typeof content === "string") {
    return content === "" ? [{ type: "text", text: "" }] : [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) return [{ type: "text", text: String(content) }];

  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push({ type: "text", text: part });
      continue;
    }
    if (part === null || typeof part !== "object") continue;
    if (part.type === "think") {
      const think = typeof part.think === "string" ? part.think : "";
      if (think !== "") parts.push({ type: "text", text: think });
      continue;
    }
    parts.push(part);
  }
  return parts.length === 0 ? [{ type: "text", text: "" }] : parts;
}

/** 把 OpenAI 的 tool_calls 改写成上游要的 function_call 形态。 */
function normalizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
  return toolCalls.map((tc, i) => {
    if (tc === null || typeof tc !== "object") return tc;
    const fn = tc.function_call ?? tc.function ?? { name: "", arguments: "{}" };
    const out = { type: "function", function_call: fn };
    if (tc.id !== undefined && tc.id !== null) out.id = tc.id;
    out.index = typeof tc.index === "number" ? tc.index : i;
    return out;
  });
}

/** 把 OpenAI 请求体翻成 Trae raw_chat 的 body */
function toTraeBody(input) {
  // display_name（Seed-Code / Qwen3.8-Flash …）和 config_name 都接受，统一归一化
  const { id: model, fn: modelFn } = resolveModel(input.model);
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const RAW = process.env.TRAE_SHIM_RAW === "1";
  // 过滤空 content（上游对空字符串报 11151，kimi 系尤其严格）
  const cleaned = messages.filter((m) => {
    if (!m || typeof m !== "object") return false;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true;
    if (Array.isArray(m.content)) return m.content.length > 0;
    return typeof m.content === "string" && m.content.trim() !== "";
  });
  const shaped = cleaned.map((m) => {
    if (RAW) return m;
    const out = { ...m, content: normalizeContent(m.content) };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      out.tool_calls = normalizeToolCalls(m.tool_calls);
    } else {
      delete out.tool_calls;
    }
    return out;
  });
  // 注意：Trae 上游**不接受 system 角色**（加了会 4001 bad request）。
  // 所以这里不注入 system，只做空消息过滤。
  const body = {
    messages: shaped,
    model,
    config_name: model,
    // 每个模型只在自己的 agent 标签下可用，用错上游直接 4001
    function: typeof input.function === "string" && input.function !== "" ? input.function : modelFn,
    stream: true,
  };
  if (Array.isArray(input.tools) && input.tools.length > 0) {
    // 上游是 Go 服务，FunctionDefinition.tools.function.parameters 声明成 string，
    // 直接传对象会 4001: "cannot unmarshal object into Go struct field
    // FunctionDefinition.tools.function.parameters of type string"。这里序列化成字符串。
    body.tools = input.tools.map((t) => {
      const fn = t?.function;
      if (!fn || typeof fn !== "object") return t;
      const params = fn.parameters;
      if (typeof params === "string" || params == null) return t;
      return { ...t, function: { ...fn, parameters: JSON.stringify(params) } };
    });
    if (input.tool_choice !== undefined) body.tool_choice = input.tool_choice;
  }
  if (typeof input.max_tokens === "number") body.max_tokens = input.max_tokens;
  if (typeof input.temperature === "number") body.temperature = input.temperature;
  return body;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
const sendError = (res, status, message, code = "error") =>
  sendJson(res, status, { error: { message, type: code, code } });

const LIMIT = 64 * 1024 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > LIMIT) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * 解析 Trae 的 SSE。
 *
 * Trae 用的是自己的事件协议，**不是** OpenAI 的 choices/delta：
 *
 *   event:output
 *   data:{"response":"正文","reasoning_content":"思考","tool_calls":null,"phase":null}
 *
 * 只认 delta.content 会把每一帧都丢掉，最后 content 为 null —— 看起来像
 * "模型返回空"，实际模型一直在正常输出（2026-10-27 实测踩过）。
 * 这里两种协议都吃，以 Trae 的 response 字段为主。
 */
function aggregateSse(text, model) {
  let content = "";
  let reasoning = "";
  const toolCalls = new Map();
  let finishReason = "stop";
  let usage = null;
  let id = "";
  let created = Math.floor(Date.now() / 1000);

  let upstreamError = null;
  let currentEvent = "";
  for (const line of text.split(/\r?\n/)) {
    // 记录当前事件名；Trae 的 data 行不带类型，靠上一行的 event: 判断
    const evtMatch = /^event:\s*(\S+)/.exec(line);
    if (evtMatch !== null) {
      currentEvent = evtMatch[1];
      if (currentEvent === "error") finishReason = "error";
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") break;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { continue; }

    // 上游错误帧：{"code":4001,"message":"...param is invalid..."}
    // 不把它记下来，聚合完就只剩 content:null，看起来像"模型返回空"
    if (currentEvent === "error") {
      upstreamError = { code: chunk.code ?? null, message: chunk.message ?? "" };
      continue;
    }

    // --- Trae 原生：{response, reasoning_content, tool_calls} ---
    if (typeof chunk.response === "string" && "reasoning_content" in chunk) {
      content += chunk.response;
      if (typeof chunk.reasoning_content === "string") reasoning += chunk.reasoning_content;
      if (Array.isArray(chunk.tool_calls)) {
        for (const tc of chunk.tool_calls) {
          const idx = tc.index ?? toolCalls.size;
          if (!toolCalls.has(idx)) toolCalls.set(idx, { id: "", type: "function", function: { name: "", arguments: "" } });
          const slot = toolCalls.get(idx);
          // Trae 原生字段是 function_call（不是 OpenAI 的 function），
          // 名字只出现在第一帧、参数在后续帧里增量追加
          const fn = tc.function_call ?? tc.function ?? {};
          if (tc.id) slot.id = tc.id;
          if (tc.type) slot.type = tc.type;
          if (fn.name) slot.function.name += fn.name;
          if (fn.arguments) slot.function.arguments += fn.arguments;
        }
      }
      continue;
    }

    // --- OpenAI 兼容：choices[0].delta ---
    id = chunk.id || id;
    created = chunk.created || created;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (typeof delta.content === "string") content += delta.content;
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCalls.has(idx)) toolCalls.set(idx, { id: "", type: "function", function: { name: "", arguments: "" } });
        const slot = toolCalls.get(idx);
        const fn = tc.function_call ?? tc.function ?? {};
        if (tc.id) slot.id = tc.id;
        if (fn.name) slot.function.name += fn.name;
        if (fn.arguments) slot.function.arguments += fn.arguments;
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  // content 为空但 reasoning 有值时，用 reasoning 顶替（同 workbuddy）
  let finalContent = content;
  let contentFromReasoning = false;
  if ((finalContent === "" || finalContent === null || finalContent === undefined) && reasoning) {
    finalContent = reasoning;
    contentFromReasoning = true;
  }

  const message = { role: "assistant", content: finalContent || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (contentFromReasoning) message._content_from_reasoning = true;
  // 上游报错且没有任何正文：把原始错误带出去，避免静默的 content:null
  if (upstreamError !== null && content === "") {
    message.content = null;
    message.upstream_error = upstreamError;
    finishReason = "error";
  }
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    if (finishReason === "stop") finishReason = "tool_calls";
  }
  const out = {
    id: id || "chatcmpl-" + randomUUID(),
    object: "chat.completion",
    created, model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  if (usage) out.usage = usage;
  return out;
}

function bearerOk(req) {
  const h = req.headers.authorization;
  if (typeof h !== "string") return false;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m !== null && m[1] === TOKEN;
}

async function handleChat(req, res) {
  const raw = (await readBody(req)).toString("utf8");
  let input;
  try { input = JSON.parse(raw); } catch { sendError(res, 400, "invalid JSON", "client"); return; }

  let cred;
  try { cred = await resolveCredential(); } catch (error) {
    sendError(res, 401, String(error), "not_signed_in");
    return;
  }

  const streamDown = input.stream === true;
  const model = typeof input.model === "string" ? input.model : "unknown";
  const body = JSON.stringify(toTraeBody(input));

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  // 账号池：额度用尽 / 鉴权失败时自动换下一个账号重试
  // 参照 workbuddy-shim 的 pickVaultAccount + accountCooldown 逻辑。
  const MAX_ACCOUNT_TRIES = Number(process.env.TRAE_ACCOUNT_RETRY ?? "3");
  let upstream = null;
  let lastError = "";
  let usedCred = cred;

  for (let attempt = 0; attempt < MAX_ACCOUNT_TRIES; attempt++) {
    if (attempt > 0) {
      const next = pickTraeAccount("cn");
      if (!next) {
        console.error("[TRAE-shim] 没有更多可用账号，放弃重试");
        break;
      }
      usedCred = next;
      console.error("[TRAE-shim] 换账号重试：" + String(next.accountName || next.accountId || "").slice(0, 20));
    }

    try {
      upstream = await fetch(CHAT_BASE + CHAT_PATH, {
        method: "POST",
        headers: buildHeaders(usedCred),
        body,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
      });
    } catch (error) {
      lastError = "transport error: " + String(error);
      continue;
    }

    if (upstream.ok) break;

    const text = (await upstream.text()).slice(0, 800);
    lastError = text || ("upstream " + upstream.status);

    // 只对「额度/鉴权」类错误换号，其它错误直接报
    const quotaLike = upstream.status === 401 || upstream.status === 403 ||
      /quota|limit|exceed|insufficient|balance|credit|14018|too many/i.test(text);
    if (!quotaLike) {
      sendError(res, upstream.status === 401 ? 401 : 502, lastError, "upstream");
      return;
    }

    if (usedCred.accountId) coolDownTrae(usedCred.accountId, 30);
    console.error("[TRAE-shim] 账号 " + String(usedCred.accountId || "?").slice(0, 12) +
      " 触发额度/鉴权限制，准备换号");
    upstream = null;
  }

  if (upstream === null) {
    sendError(res, 502, lastError || "所有账号均不可用", "upstream");
    return;
  }

  if (!upstream.ok) {
    sendError(res, 502, lastError || "upstream error", "upstream");
    return;
  }

  if (streamDown) {
    // 以前是把 Trae 原生 SSE 原样转发出去，但那不是 OpenAI 的
    // choices[].delta 协议（是 event:output + data:{response}），
    // OpenAI SDK 解析会拿到空内容。这里改成：聚合完再自己重发标准 SSE。
    const text = await upstream.text();
    const out = aggregateSse(text, model);
    // 记录耗费
    try {
      const u = out.usage || {};
      recordCost(model, u.credit ?? null, u);
      flushCost();
    } catch { /* 统计失败不影响主流程 */ }
    const msg = out.choices[0].message;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const frame = (obj) => "data: " + JSON.stringify(obj) + "\n\n";
    const base = { id: out.id, object: "chat.completion.chunk", created: out.created, model };
    if (typeof msg.reasoning_content === "string" && msg.reasoning_content !== "") {
      res.write(frame({ ...base, choices: [{ index: 0, delta: { reasoning_content: msg.reasoning_content }, finish_reason: null }] }));
    }
    if (typeof msg.content === "string" && msg.content !== "") {
      res.write(frame({ ...base, choices: [{ index: 0, delta: { content: msg.content }, finish_reason: null }] }));
    }
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      res.write(frame({
        ...base,
        choices: [{
          index: 0,
          delta: {
            tool_calls: msg.tool_calls.map((tc, i) => ({ index: i, id: tc.id, type: "function", function: tc.function })),
          },
          finish_reason: null,
        }],
      }));
    }
    res.write(frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: out.choices[0].finish_reason }] }));
    if (out.usage) res.write(frame({ ...base, choices: [], usage: out.usage }));
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  const text = await upstream.text();
  const finalOut = aggregateSse(text, model);
  try {
    const u = finalOut.usage || {};
    recordCost(model, u.credit ?? null, u);
    flushCost();
  } catch { /* ignore */ }
  sendJson(res, 200, finalOut);
}

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  // ── Trae 账号池接口 ───────────────────────────────────────
  if (req.method === "GET" && (url === "/accounts" || url.startsWith("/accounts?"))) {
    const region = /[?&]region=(cn|sg)\b/.exec(url)?.[1] || "cn";
    sendJson(res, 200, {
      ok: true,
      region,
      vaultDir: traeVaultDir(region),
      current: stickyTraeAccountId,
      accounts: listTraeAccounts(region),
    });
    return;
  }

  if (req.method === "GET" && (url === "/accounts/current" || url.startsWith("/accounts/current?"))) {
    (async () => {
      const cred = await resolveCredential().catch(() => null);
      const now = Date.now();
      const cooling = [];
      for (const [id, until] of traeCooldown.entries()) {
        if (until > now) cooling.push({ accountId: id, remainMin: Math.round((until - now) / 60000) });
      }
      sendJson(res, 200, {
        ok: true,
        current: cred ? {
          accountId: cred.accountId || "(desktop/file)",
          nickname: cred.accountName || "",
          userId: cred.userId || "",
          source: cred.source || "file",
          expiresAtMs: cred.expiresAtMs || 0,
        } : null,
        sticky: stickyTraeAccountId,
        cooling,
      });
    })().catch((e) => { if (!res.headersSent) sendError(res, 500, String(e), "internal"); });
    return;
  }

  // 扫描本机所有 Trae 凭据（dsh-home + 桌面端）
  if (req.method === "GET" && (url === "/accounts/scan" || url.startsWith("/accounts/scan?"))) {
    (async () => {
      const found = [];
      const seen = new Set();

      // 1) dsh-home 的 .trae-auth.<region>.json
      const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
      const dshPaths = [
        join(dshHome, ".trae-auth.cn.json"),
        join("D:", "dev", "dsh-home", ".trae-auth.cn.json"),
      ];
      for (const p of dshPaths) {
        if (!existsSync(p)) continue;
        let doc;
        try { doc = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
        const list = doc.credentials || {};
        for (const rec of (Array.isArray(list) ? list : Object.values(list))) {
          if (!rec || typeof rec !== "object") continue;
          const id = traeAccountId(rec);
          if (seen.has(id)) continue;
          seen.add(id);
          found.push({
            accountId: id,
            nickname: rec.accountName || rec.account?.username || "(无昵称)",
            userId: rec.userId || "",
            edition: rec.edition || "cn",
            expiresAtMs: Number(rec.expiresAtMs || 0),
            from: p,
          });
        }
      }

      // 2) 桌面端当前登录
      try {
        const desktop = loadCredentialFromDesktop();
        if (desktop && desktop.accessToken) {
          const id = traeAccountId(desktop);
          if (!seen.has(id)) {
            seen.add(id);
            found.push({
              accountId: id,
              nickname: desktop.accountName || "(桌面端)",
              userId: desktop.userId || "",
              edition: desktop.edition || "cn",
              expiresAtMs: Number(desktop.expiresAtMs || 0),
              from: "desktop",
            });
          }
        }
      } catch { /* 没登录 */ }

      const inVault = new Set(traeVaultFiles("cn").map((x) => x.accountId));
      for (const x of found) x.inVault = inVault.has(x.accountId);

      sendJson(res, 200, { ok: true, found, vaultCount: inVault.size });
    })().catch((e) => { if (!res.headersSent) sendError(res, 500, String(e), "internal"); });
    return;
  }

  if (req.method === "POST" && (url === "/accounts/import" || url.startsWith("/accounts/import?"))) {
    (async () => {
      let body = {};
      try {
        const raw = (await readBody(req)).toString("utf8");
        if (raw.trim() !== "") body = JSON.parse(raw);
      } catch { /* ignore */ }
      const region = String(body.region || "cn");
      const n = importTraeFromDsh(region);
      console.error("[TRAE-shim] 从 dsh 导入 " + n + " 个账号");
      sendJson(res, 200, { ok: true, imported: n, region, accounts: listTraeAccounts(region) });
    })().catch((e) => { if (!res.headersSent) sendError(res, 500, String(e), "internal"); });
    return;
  }

  if (req.method === "POST" && (url === "/accounts/switch" || url.startsWith("/accounts/switch?"))) {
    (async () => {
      let body = {};
      try {
        const raw = (await readBody(req)).toString("utf8");
        if (raw.trim() !== "") body = JSON.parse(raw);
      } catch { /* ignore */ }
      const id = String(body.accountId || "");
      const region = String(body.region || "cn");
      const hit = traeVaultFiles(region).find((x) => x.accountId === id);
      if (!hit) { sendError(res, 404, "账号不存在: " + id, "not_found"); return; }
      stickyTraeAccountId = id;
      traeCooldown.delete(id);
      sendJson(res, 200, { ok: true, current: id, region });
    })().catch((e) => { if (!res.headersSent) sendError(res, 500, String(e), "internal"); });
    return;
  }

  if (req.method === "POST" && (url === "/accounts/delete" || url.startsWith("/accounts/delete?"))) {
    (async () => {
      let body = {};
      try {
        const raw = (await readBody(req)).toString("utf8");
        if (raw.trim() !== "") body = JSON.parse(raw);
      } catch { /* ignore */ }
      const id = String(body.accountId || "");
      const region = String(body.region || "cn");
      const hit = traeVaultFiles(region).find((x) => x.accountId === id);
      if (!hit) { sendError(res, 404, "账号不存在: " + id, "not_found"); return; }
      try { unlinkSync(hit.path); } catch { /* ignore */ }
      if (stickyTraeAccountId === id) stickyTraeAccountId = null;
      sendJson(res, 200, { ok: true, deleted: id });
    })().catch((e) => { if (!res.headersSent) sendError(res, 500, String(e), "internal"); });
    return;
  }

  if (req.method === "POST" && (url === "/accounts/test" || url.startsWith("/accounts/test?"))) {
    (async () => {
      let body = {};
      try {
        const raw = (await readBody(req)).toString("utf8");
        if (raw.trim() !== "") body = JSON.parse(raw);
      } catch { /* ignore */ }
      const id = String(body.accountId || "");
      const region = String(body.region || "cn");
      const hit = traeVaultFiles(region).find((x) => x.accountId === id);
      if (!hit) { sendError(res, 404, "账号不存在: " + id, "not_found"); return; }
      const cred = readTraeVault(hit.path);
      if (!cred) { sendError(res, 400, "账号文件损坏", "bad_file"); return; }

      // 用该账号发一个最小请求（复用 chat 的请求构造）
      const started = Date.now();
      let ok = false, message = "", latencyMs = null;
      try {
        const input = {
          model: "Doubao-Seed-Code",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 16,
        };
        // 复用 chat 的同一个构造函数，别自己拼（之前写成不存在的 buildTraeBody）
        const rawBody = JSON.stringify(toTraeBody(input));
        const r = await fetch(CHAT_BASE + CHAT_PATH, {
          method: "POST",
          headers: buildHeaders(cred),
          body: rawBody,
          signal: AbortSignal.timeout(45000),
        });
        latencyMs = Date.now() - started;
        const t = await r.text();
        ok = r.ok && !/"code"\s*:/.test(t.slice(0, 200));
        message = ok ? "正常" : (t.slice(0, 80) || "HTTP " + r.status);
      } catch (e) {
        latencyMs = Date.now() - started;
        message = String(e).includes("timeout") ? "超时" : "网络错误";
      }
      sendJson(res, 200, { ok, accountId: id, region, latencyMs, message });
    })().catch((e) => { if (!res.headersSent) sendError(res, 500, String(e), "internal"); });
    return;
  }

  // 耗费统计
  if (req.method === "GET" && (url === "/cost" || url.startsWith("/cost?"))) {
    sendJson(res, 200, buildCostResponse());
    return;
  }

  // 重置耗费统计
  if (req.method === "POST" && (url === "/cost/reset" || url.startsWith("/cost/reset?"))) {
    costStats = { byModel: {}, since: new Date().toISOString() };
    costDirty = true;
    flushCost();
    console.error("[TRAE-shim] 耗费统计已重置");
    sendJson(res, 200, { ok: true, message: "耗费统计已重置", since: costStats.since });
    return;
  }

  if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
    sendJson(res, 200, { ok: true, provider: "trae", port: PORT });
    return;
  }
  if (!bearerOk(req)) { sendError(res, 401, "missing or invalid Authorization bearer", "unauthorized"); return; }
  // 完整名册（动态，从 vscdb 读）
  if (req.method === "GET" && (url.startsWith("/v3/models") || url.startsWith("/v4/models"))) {
    (async () => {
      const force = url.includes("force=1");
      const roster = await loadRosterFromVscdb(force);
      if (!roster) {
        sendJson(res, 200, {
          ok: false,
          source: "none",
          agent: ROSTER_AGENT,
          vscdb: traeVscdbPath(),
          message: "vscdb 读取失败，请检查 Trae 是否安装并登录",
          models: [],
        });
        return;
      }
      // 按 rate 升序（便宜的在前），rate 为 null 的排最后
      const rows = roster.map((m) => ({
        id: m.id,
        display: m.display,
        cost: m.rate,
        rate: m.rate,
        free: m.rate === 0,
        multimodal: m.multimodal,
        reasoning: m.reasoning,
        maxTokens: m.maxTokens,
      }));
      rows.sort((a, b) => {
        const ca = a.cost === null ? 9999 : a.cost;
        const cb = b.cost === null ? 9999 : b.cost;
        return ca - cb;
      });
      sendJson(res, 200, {
        ok: true,
        source: "vscdb",
        agent: ROSTER_AGENT,
        vscdb: traeVscdbPath(),
        fetchedAt: new Date().toISOString(),
        models: rows,
      });
    })().catch((e) => {
      if (!res.headersSent) sendError(res, 500, String(e), "internal");
    });
    return;
  }

  // OpenAI 兼容：优先用动态名册
  if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
    (async () => {
      const roster = await loadRosterFromVscdb();
      if (roster && roster.length > 0) {
        sendJson(res, 200, {
          object: "list",
          source: "vscdb",
          data: roster.map((m) => ({
            id: m.id,
            object: "model",
            created: 0,
            owned_by: "trae",
            display_name: m.display,
            price_factor: m.rate,
            free: m.rate === 0,
            multimodal: m.multimodal,
            is_reasoning: m.reasoning,
            function: MODEL_CATALOG.find((x) => x.id === m.id)?.fn ?? "solo_work_lite",
          })).sort((a, b) => {
            const ca = a.price_factor === null ? 9999 : a.price_factor;
            const cb = b.price_factor === null ? 9999 : b.price_factor;
            return ca - cb;
          }),
        });
        return;
      }
      // 退回静态
      sendJson(res, 200, {
        object: "list",
        source: "static",
        data: MODEL_CATALOG.map((m) => ({
          id: m.id,
          object: "model",
          created: 0,
          owned_by: "trae",
          display_name: m.display,
          price_factor: m.rate,
          function: m.fn,
        })),
      });
    })().catch((e) => {
      if (!res.headersSent) sendError(res, 500, String(e), "internal");
    });
    return;
  }
  if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
    handleChat(req, res).catch((error) => {
      if (!res.headersSent) sendError(res, 500, String(error), "internal");
      else res.end();
    });
    return;
  }
  sendError(res, 404, "no such route: " + req.method + " " + url, "not_found");
});

process.on("uncaughtException", (e) => console.error("[trae-shim] uncaught: " + (e?.stack ?? e)));
process.on("unhandledRejection", (e) => console.error("[trae-shim] unhandled: " + (e?.stack ?? e)));

server.listen(PORT, HOST, () => {
  console.log("[trae-shim] listening on http://" + HOST + ":" + PORT + "/v1");
});


/*
 * LICENSE-NOTICE
 *
 * 本文件中的 Trae 凭据解密逻辑（decryptTraeValue / loadCredentialFromDesktop）
 * 改写自：
 *   dsh-connect-trae — MIT License, Copyright (c) 2026 LaoDing
 *   https://github.com/dingminhua/dsh-connect-trae
 *
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

#!/usr/bin/env node
/**
 * workbuddy-shim —— WorkBuddy 桌面端 → OpenAI 兼容端点（独立版，不依赖 DSH 插件）
 *
 * 自包含实现：直接读 WorkBuddy 桌面端的登录凭据并解密，转发到上游。
 *
 * ## 凭据解密（WorkBuddy 5.6.0+）
 *
 * 桌面端不再明文存 token，而是写成字段包装：
 *   { "$wbEncrypted": 1, "envelope": "<base64>" }
 * envelope 解开是 { suite, keyId, nonce, authTag, ciphertext }，AES-256-GCM。
 *
 * 密钥不是用户秘密，是编译在 app 的 Electron native module
 * (electron_browser_workbuddy_storage) 里的常量。app 通过 loggerGet() 取到它，
 * 对返回的 base64 **字符串**做 SHA-256，得到 32 字节密钥；
 * keyId = 该密钥 SHA-256 的前 16 位十六进制。
 *
 * 本文件通过启动已安装的 app 并让它吐出同一 payload 来重算密钥，
 * 在进程内缓存，不落盘、不打印。
 *
 * ## 授权
 *
 * 凭据解密与 app 发现逻辑改写自 dsh-connect-workbuddy（MIT, Copyright (c) 2026 LaoDing），
 * 其本身参考 corrinehu/dsh-workbuddy-connect（MIT, Copyright (c) 2026 Corrine Hu）。
 * 依 MIT 协议保留上述版权声明与许可全文，见文件末尾 LICENSE-NOTICE。
 *
 * 用法：
 *   node workbuddy-shim.mjs
 *   WB_SHIM_PORT=8787 WB_SHIM_TOKEN=sk-workbuddy-local node workbuddy-shim.mjs
 */

import { createServer } from "node:http";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── 配置 ───────────────────────────────────────────────────────────
const PORT = Number(process.env.WB_SHIM_PORT ?? 8787);
const TOKEN = process.env.WB_SHIM_TOKEN ?? "sk-workbuddy-local";
const HOST = "127.0.0.1";
const REGION = process.env.WB_REGION ?? "cn";

const CHAT_BASE = REGION === "global" ? "https://www.workbuddy.ai" : "https://copilot.tencent.com";
const BILLING_BASE = REGION === "global" ? "https://www.codebuddy.ai" : "https://www.codebuddy.cn";

// ── 常量（源自 dsh-connect-workbuddy，MIT）──────────────────────────
const WORKBUDDY_LIVE_FILENAME = "workbuddy-desktop.info";
const APP_EXECUTABLE_NAMES = ["WorkBuddy.exe", "WorkBuddyAI.exe"];
const FRAMING_CODE_FIELD = 2;
const STANDARD_FORMAT_ID_FIELD = "WBEV1";
const AAD_DOMAIN = Buffer.from("WB-AAD\0", "ascii");
const SYMMETRIC_SCHEME = "sym-v1";
const KEY_FETCH_TIMEOUT_MS = 10000;
const APP_EXECUTABLE_MISS_TTL_MS = 60000;

/**
 * 模型目录 —— 成本以**实测 credit / 调用次数**为准（2026-11-05）。
 *
 * 重要：名册里 `cost: 0` **不代表真免费**。
 * kimi 三个在 /v3/models 里标 cost=0，但实测每次都扣钱：
 *   kimi-k3-1        3 次  1.38  → 0.46/次
 *   kimi-k3.1-pro    2 次  0.73  → 0.37/次
 *   kimi-k2.8-preview 2 次 0.34  → 0.17/次
 *
 * 只有 codewise-jump 是**实测确认真免费**（4 次调用，credit 精确为 0）。
 *
 * cost 字段 = 单次平均 credit（实测），free = cost === 0 且有实测证据。
 * verified: true 表示有实测数据，false 表示按上游 rate 推测。
 */
const MODEL_CATALOG = [
  // ── 实测真免费（credit 精确为 0）──
  { id: "codewise-jump",            lat: 671,  cost: 0,     verified: true,  note: "真免费 · 最快 · 仅文本（视觉返回空）" },
  { id: "glm-5.2",                  lat: 1499, cost: 0,     verified: false, note: "名册标 0，未大量实测" },
  { id: "space-bunny",              lat: 1532, cost: 0.056, verified: true,  note: "实测 0.056/次 · 多模态" },
  { id: "hy3-b",                    lat: 1596, cost: 0,     verified: false, note: "名册标 0" },
  { id: "hy3-c",                    lat: 1617, cost: 0,     verified: false, note: "名册标 0" },
  { id: "hy3-x",                    lat: 1904, cost: 0,     verified: false, note: "名册标 0" },
  { id: "deepseek-v4.1-flash",      lat: 2088, cost: 0.044, verified: true,  note: "实测 0.044/次" },
  { id: "hy3",                      lat: 2133, cost: 0,     verified: false, note: "名册标 0" },
  { id: "deepseek-v4-flash",        lat: 2161, cost: 0,     verified: false, note: "名册标 0" },
  { id: "deepseek-v4-pro",          lat: 2281, cost: 0,     verified: false, note: "名册标 0" },
  { id: "auto",                     lat: 2330, cost: 0,     verified: false, note: "名册标 0 · 自动选择" },
  { id: "glm-5.3-flash",            lat: 2898, cost: 0,     verified: false, note: "名册标 0" },
  { id: "hy4free",                  lat: 5521, cost: 0,     verified: true,  note: "实测免费 · 混元推理 · 强但慢" },
  { id: "mimo-v2.6-pro",            lat: 7078, cost: 0,     verified: false, note: "名册标 0 · 很慢" },
  // ── 实测要钱 ──
  { id: "kimi-k3-1",                lat: 4233, cost: 0.46,  verified: true,  note: "实测 0.46/次 · 贵 · 需 system" },
  { id: "kimi-k3.1-pro",            lat: 4681, cost: 0.365, verified: true,  note: "实测 0.365/次 · 需 system" },
  { id: "kimi-k2.8-preview",        lat: 2783, cost: 0.17,  verified: true,  note: "实测 0.17/次 · 需 system" },
  { id: "minimax-m3.1-flash",       lat: 2173, cost: 0.01,  verified: false, note: "名册标 0.01" },
  { id: "glm-5.3",                  lat: 3107, cost: 0.01,  verified: false, note: "名册标 0.01" },
  { id: "step-5-preview",           lat: 2718, cost: 0.02,  verified: false, note: "名册标 0.02" },
  { id: "hy4std",                   lat: 3499, cost: 0.06,  verified: true,  note: "实测 0.06~0.29/次 · 混元标准版" },
  // ── intl 区专用 ──
  { id: "default-model",            lat: 1329, cost: 0,     verified: true,  note: "intl · 实测免费" },
  { id: "deepseek-v4.1-flash-sg",   lat: 1737, cost: 0,     verified: true,  note: "intl · 实测免费" },
  { id: "max-model",                lat: 2541, cost: 0.02,  verified: true,  note: "intl · 最强档" },
  { id: "kimi-k3",                  lat: 5015, cost: 0.06,  verified: true,  note: "intl · 实测 0.06/次 · 需 system" },
];

/**
 * 探测候选名 —— 「刷新模型」会逐个试这些 id，能通的才收进清单。
 *
 * 上游没有 /v1/models 接口（探测确认 404），所以只能靠名字撞。
 * 这里的名单是基于各厂商公开模型名 + 实测整理，覆盖常见命名变体。
 */
const PROBE_CANDIDATES = [
  // 腾讯混元
  "hy4", "hy3", "hunyuan-turbos", "hunyuan-pro", "hunyuan-lite", "hunyuan-t1",
  // DeepSeek
  "deepseek-v4.1-flash", "deepseek-v4-pro", "deepseek-v4", "deepseek-v3.2",
  "deepseek-r2", "deepseek-reasoner", "deepseek-chat",
  // 通义
  "qwen3.8-flash", "qwen3.8-max", "qwen3-max", "qwen3-coder",
  // 智谱
  "glm-5.3-flash", "glm-5.3", "glm-5", "glm-4.6",
  // MiniMax
  "minimax-m3.1-flash", "minimax-m3", "minimax-m2",
  // Kimi
  "kimi-k2.6", "kimi-k2", "kimi-k1.5",
  // 字节
  "doubao-seed-code", "Doubao-Seed-Code", "doubao-pro",
  // 小米
  "mimo-v2.6-flash", "mimo-v2", "mimo",
  // WorkBuddy 自有
  "space-bunny",
  // 其他常见
  "gpt-5", "gpt-4.1", "claude-sonnet-4.5", "gemini-2.5-pro",
];


// ── 耗费统计（credit）───────────────────────────────────────
//
// WorkBuddy 上游在 usage.credit 里返回本次调用扣的积分。
// 免费模型恒为 0，付费模型按 token 量浮动。
//
// 这里累计到内存 + 定期落盘，供 /cost 查询。

const COST_FILE = process.env.WB_COST_FILE ||
  join(fileURLToPath(new URL(".", import.meta.url)), ".wb-cost.json");

/** 每个模型的累计耗费。 */
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

/** 记录一次调用的耗费。 */
function recordCost(model, credit, usage) {
  if (!model) return;
  const cur = costStats.byModel[model] || {
    calls: 0, credit: 0, promptTokens: 0, completionTokens: 0, fails: 0,
  };
  cur.calls += 1;
  cur.credit = Number((cur.credit + (Number(credit) || 0)).toFixed(4));
  if (usage) {
    cur.promptTokens += Number(usage.prompt_tokens || 0);
    cur.completionTokens += Number(usage.completion_tokens || 0);
  }
  costStats.byModel[model] = cur;
  costDirty = true;
}

/** 记录一次失败（无 credit）。 */
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
    console.error("[workbuddy-shim] 写耗费统计失败: " + String(e));
  }
}

// 每 30 秒落盘一次，避免每次调用都写文件
setInterval(flushCost, 30000).unref?.();

// ── 上游模型名册（/v3/config）────────────────────────────────
//
// 这是官方接口，返回完整模型清单 + 计费规则 + 促销活动。
// 需要正确的 User-Agent（缺了报 code 12403 "check ua"）。

/** 缓存的名册。 */
let rosterCache = null;
let rosterCachedAt = 0;
const ROSTER_TTL_MS = 10 * 60 * 1000;  // 10 分钟

/**
 * 拉取上游模型名册。
 *
 * @param {object} cred 凭据
 * @param {boolean} force 忽略缓存
 * @returns {Promise<object>} 名册数据
 */
async function fetchRoster(cred, force = false) {
  if (!force && rosterCache && Date.now() - rosterCachedAt < ROSTER_TTL_MS) {
    return rosterCache;
  }
  const r = await fetch(CHAT_BASE + "/v3/config", {
    headers: buildHeaders(cred),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) {
    const t = (await r.text()).slice(0, 300);
    throw new Error("拉取名册失败 HTTP" + r.status + ": " + t);
  }
  const doc = await r.json();
  if (!doc || doc.code !== 0 || !doc.data) {
    throw new Error("名册格式异常: " + JSON.stringify(doc).slice(0, 200));
  }

  // 提取模型清单（递归找 models / model / modelIds 字段）
  const models = new Set();
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    for (const [k, v] of Object.entries(o)) {
      if (k === "models" && Array.isArray(v)) v.forEach((m) => typeof m === "string" && models.add(m));
      if (k === "model" && typeof v === "string") models.add(v);
      if (k === "modelIds" && Array.isArray(v)) v.forEach((m) => typeof m === "string" && models.add(m));
      walk(v);
    }
  })(doc.data);

  // 排序：有实测数据的先（免费 + 快），没数据的排最后
  const meta = new Map(MODEL_CATALOG.map((m) => [m.id, m]));
  const sorted = [...models].sort((a, b) => {
    const ma = meta.get(a);
    const mb = meta.get(b);
    // 有成本信息 < 无信息
    if (!!ma !== !!mb) return ma ? -1 : 1;
    if (ma && mb) {
      // 免费优先
      const fa = ma.cost === 0 ? 0 : 1;
      const fb = mb.cost === 0 ? 0 : 1;
      if (fa !== fb) return fa - fb;
      // 同免费/同付费：先比成本，再比延迟
      if (ma.cost !== mb.cost) return ma.cost - mb.cost;
      return ma.lat - mb.lat;
    }
    // 都没信息：按字母
    return a.localeCompare(b);
  });

  rosterCache = {
    models: sorted,
    promotions: doc.data.modelPromotions || [],
    config: doc.data.config || {},
    fetchedAt: new Date().toISOString(),
  };
  rosterCachedAt = Date.now();
  console.error("[workbuddy-shim] 名册已刷新，" + rosterCache.models.length + " 个模型");
  return rosterCache;
}

// ── 模型探测（「刷新模型」）──────────────────────────────────

/**
 * 探测结果缓存文件。放在 shim 脚本同目录，下次启动直接读，
 * 避免每次启动都要重新撞一遍（37 个候选 × 每个 3-30 秒）。
 */
const DISCOVERED_FILE = process.env.WB_DISCOVERED_FILE ||
  join(fileURLToPath(new URL(".", import.meta.url)), ".wb-models.json");

/** 读上次探测结果。 */
function loadDiscovered() {
  try {
    const raw = readFileSync(DISCOVERED_FILE, "utf8");
    const doc = JSON.parse(raw);
    if (Array.isArray(doc.models) && doc.models.length > 0) return doc.models;
  } catch { /* 没有就用默认 */ }
  return null;
}

/** 写探测结果。 */
function saveDiscovered(models) {
  try {
    writeFileSync(
      DISCOVERED_FILE,
      JSON.stringify({ updatedAt: new Date().toISOString(), models }, null, 2),
      "utf8",
    );
    return true;
  } catch (e) {
    console.error("[workbuddy-shim] 写探测结果失败: " + String(e));
    return false;
  }
}

/** 当前生效的模型清单：优先用探测结果，否则用内置目录。 */
let ACTIVE_MODELS = (() => {
  const saved = loadDiscovered();
  if (saved) {
    console.log("[workbuddy-shim] 使用上次探测结果 " + saved.length + " 个模型");
    return saved;
  }
  return MODEL_CATALOG.map((m) => m.id);
})();

/**
 * 用一个最小请求探测某个模型是否可用。
 *
 * 判断标准：HTTP 200 且响应里没有 error 字段。
 * 不校验内容质量（有些模型对 "hi" 会返回空，但仍算可用）。
 */
async function probeOne(cred, modelId) {
  const body = JSON.stringify({
    model: modelId,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 64,
    stream: false,
  });
  try {
    const r = await fetch(CHAT_BASE + "/v2/chat/completions", {
      method: "POST",
      headers: buildHeaders(cred),
      body: prepareChatBody(body),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) {
      const t = (await r.text()).slice(0, 200);
      return { ok: false, reason: "HTTP" + r.status + " " + t.replace(/\s+/g, " ").slice(0, 80) };
    }
    const t = await r.text();
    // 上游用 SSE 响应，错误帧里带 error
    if (/"error"\s*:/.test(t) && !/"delta"\s*:\s*\{[^}]*"content"\s*:\s*"/.test(t)) {
      return { ok: false, reason: "error frame: " + t.replace(/\s+/g, " ").slice(0, 80) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "transport: " + String(e).slice(0, 80) };
  }
}

/**
 * 并发探测全部候选，返回可用模型 id 列表。
 *
 * 并发度默认 4 —— 太高会被上游限流（429），太低太慢。
 */
async function discoverModels(cred, concurrency = 4) {
  const results = [];
  const queue = PROBE_CANDIDATES.slice();
  const queue2 = [];
  // 已在目录里的先补进候选去重
  for (const m of MODEL_CATALOG) if (!queue.includes(m.id)) queue.push(m.id);

  let index = 0;
  async function worker() {
    while (true) {
      const i = index++;
      if (i >= queue.length) return;
      const id = queue[i];
      const r = await probeOne(cred, id);
      if (r.ok) {
        results.push(id);
        console.error("[workbuddy-shim] 探测 OK   " + id);
      } else {
        console.error("[workbuddy-shim] 探测 FAIL " + id + "  " + r.reason);
      }
    }
  }

  const workers = [];
  for (let k = 0; k < Math.max(1, concurrency); k += 1) workers.push(worker());
  await Promise.all(workers);

  // 保持目录顺序在前，新发现的按字母序
  const known = MODEL_CATALOG.map((m) => m.id).filter((id) => results.includes(id));
  const extra = results.filter((id) => !known.includes(id)).sort();
  return known.concat(extra);
}

// ── at-rest 解密（改写自 at-rest.ts，MIT）───────────────────────────

/** uint32 大端。 */
function encodeUint32(value) {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

/** 长度前缀 UTF-8 字符串：uint32 大端长度 + 字节。 */
function encodeLengthPrefixed(value) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([encodeUint32(bytes.length), bytes]);
}

/** sym-v1 FIELD 框架的 AAD。 */
function fieldAad(keyId, suite, scheme) {
  if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error("workbuddy: envelope keyId is malformed");
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed(STANDARD_FORMAT_ID_FIELD),
    encodeLengthPrefixed(scheme || SYMMETRIC_SCHEME),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([FRAMING_CODE_FIELD]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

/** 是否 app 的加密字段包装。 */
function isEncryptedFieldWrapper(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 2 && keys[0] === "$wbEncrypted" && keys[1] === "envelope" &&
    value["$wbEncrypted"] === 1 && typeof value["envelope"] === "string";
}

/** 密钥 id = 密钥 SHA-256 前 16 位十六进制。 */
function deriveAtRestKeyId(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** 从 app 吐出的 payload JSON 派生 32 字节密钥。 */
function deriveAtRestKey(payloadJson) {
  let payload;
  try { payload = JSON.parse(payloadJson); }
  catch { throw new Error("workbuddy: at-rest key payload is not valid JSON"); }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("workbuddy: at-rest key payload is not an object");
  }
  const secret = payload["atRestSecretKey"];
  if (typeof secret !== "string" || secret === "") {
    throw new Error("workbuddy: at-rest key payload carries no atRestSecretKey");
  }
  // 注意：hash 的是 base64 字符串本身，不是解码后的字节
  return createHash("sha256").update(secret, "utf8").digest();
}

/** 解开一个加密字段。 */
function openEncryptedField(field, key) {
  let envelope;
  try { envelope = JSON.parse(Buffer.from(field.envelope, "base64").toString("utf8")); }
  catch { throw new Error("workbuddy: encrypted field envelope is not valid JSON"); }
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new Error("workbuddy: encrypted field envelope is not an object");
  }
  const suite = envelope["suite"];
  const keyId = envelope["keyId"];
  const nonce = envelope["nonce"];
  const authTag = envelope["authTag"];
  const ciphertext = envelope["ciphertext"];
  if (typeof suite !== "number" || typeof keyId !== "string") {
    throw new Error("workbuddy: encrypted field envelope is missing suite or keyId");
  }
  if (typeof nonce !== "string" || typeof authTag !== "string" || typeof ciphertext !== "string") {
    throw new Error("workbuddy: encrypted field envelope is missing nonce, authTag or ciphertext");
  }
  const expectedKeyId = deriveAtRestKeyId(key);
  if (keyId !== expectedKeyId) {
    throw new Error("workbuddy: encrypted field belongs to key " + keyId + ", not the available key " + expectedKeyId);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"), { authTagLength: 16 });
  decipher.setAAD(fieldAad(keyId, suite));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

/** 取一个凭据字段：明文直接用，加密的自带密钥解开。 */
function credentialField(value, key) {
  if (typeof value === "string") return value;
  if (!isEncryptedFieldWrapper(value)) return undefined;
  if (key === undefined) return undefined;
  return openEncryptedField(value, key);
}

/** 可选凭据字段：解不开就当没有。 */
function optionalCredentialField(value, key) {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (!isEncryptedFieldWrapper(value)) return undefined;
  if (key === undefined) return undefined;
  try { return openEncryptedField(value, key); } catch { return undefined; }
}


// ── app 发现与密钥获取（改写自 at-rest.ts / auth.ts，MIT）────────────

/** 平台默认的桌面端 auth 目录。 */
function defaultDesktopAuthDirs() {
  const home = homedir();
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    const roaming = process.env.APPDATA || join(home, "AppData", "Roaming");
    return [
      join(local, "CodeBuddyExtension", "Data", "Public", "auth"),
      join(roaming, "CodeBuddyExtension", "Data", "Public", "auth"),
    ];
  }
  if (process.platform === "darwin") {
    return [join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth")];
  }
  const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
  return [join(config, "CodeBuddyExtension", "Data", "Public", "auth")];
}

/** 通过注册表找 WorkBuddy 可执行文件（Windows）。 */
function windowsRegistryAppExecutable() {
  const roots = [
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  for (const root of roots) {
    let listing;
    try {
      listing = execFileSync("reg", ["query", root, "/s", "/f", "WorkBuddy", "/t", "REG_SZ"], {
        encoding: "utf8", windowsHide: true, timeout: 10000,
      });
    } catch { continue; }
    if (!listing) continue;
    // 找 DisplayIcon / InstallLocation 里指向 exe 的行
    for (const line of listing.split(/\r?\n/)) {
      const m = /REG_SZ\s+(.+)$/.exec(line);
      if (!m) continue;
      const raw = m[1].trim().replace(/^"|"$/g, "").replace(/,\s*-?\d+\s*$/, "");
      if (!raw) continue;
      const base = basename(raw).toLowerCase();
      if (APP_EXECUTABLE_NAMES.some((n) => n.toLowerCase() === base)) return raw;
      // InstallLocation 是目录，拼上 exe 名试一下
      if (!raw.toLowerCase().endsWith(".exe")) {
        for (const n of APP_EXECUTABLE_NAMES) {
          const candidate = join(raw, n);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
  }
  return undefined;
}

/** 常见安装路径兜底。 */
function windowsCommonPaths() {
  // 不写死盘符：优先环境变量，缺失时用系统盘推导
  const sysDrive = process.env.SystemDrive || "C:";
  const roots = [
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    process.env.ProgramFiles || sysDrive + "\\Program Files",
    process.env["ProgramFiles(x86)"] || sysDrive + "\\Program Files (x86)",
  ].filter(Boolean);
  const dirs = ["WorkBuddy", "WorkBuddyAI", "Tencent\\WorkBuddy", "CodeBuddy"];
  const out = [];
  for (const r of roots) {
    for (const d of dirs) {
      for (const n of APP_EXECUTABLE_NAMES) {
        const c = join(r, d, n);
        if (existsSync(c)) out.push(c);
        const c2 = join(r, d, "Application", n);
        if (existsSync(c2)) out.push(c2);
      }
    }
  }
  return out;
}

let cachedAppExecutable;

/** 找到 WorkBuddy 可执行文件。 */
function discoverAppExecutable() {
  const now = Date.now();
  if (cachedAppExecutable !== undefined) {
    if (now - cachedAppExecutable.foundAtMs < APP_EXECUTABLE_MISS_TTL_MS) return cachedAppExecutable.executable || undefined;
    cachedAppExecutable = undefined;
  }
  let exe = process.env.WORKBUDDY_APP_EXECUTABLE;
  if (!exe || !existsSync(exe)) {
    exe = process.platform === "win32" ? windowsRegistryAppExecutable() : undefined;
  }
  if (!exe && process.platform === "win32") {
    const hits = windowsCommonPaths();
    if (hits.length > 0) exe = hits[0];
  }
  cachedAppExecutable = {
    executable: exe || "",
    foundAtMs: exe ? Number.POSITIVE_INFINITY : now,
  };
  return exe;
}

/** 让 app 吐出密钥 payload。 */
function fetchAtRestKeyPayload(executable) {
  const code = "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}";
  return new Promise((resolve, reject) => {
    execFile(executable, ["-e", code], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: KEY_FETCH_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1048576,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error("workbuddy: failed to read at-rest key from app: " + (stderr || error.message)));
        return;
      }
      if (!stdout || stdout.trim() === "") {
        reject(new Error("workbuddy: app returned an empty at-rest key payload"));
        return;
      }
      resolve(stdout);
    });
  });
}

let cachedKey;
let inflightKey;
let failedKeyAtMs = 0;

/** 取 at-rest 密钥（进程内缓存）。 */
async function readAtRestKey() {
  if (cachedKey !== undefined) return cachedKey;
  if (inflightKey !== undefined) return inflightKey;
  if (failedKeyAtMs !== 0 && Date.now() - failedKeyAtMs < 60000) return undefined;
  inflightKey = (async () => {
    const executable = discoverAppExecutable();
    if (executable === undefined) return undefined;
    return deriveAtRestKey(await fetchAtRestKeyPayload(executable));
  })().then((key) => {
    cachedKey = key;
    failedKeyAtMs = key === undefined ? Date.now() : 0;
    inflightKey = undefined;
    return key;
  }, () => {
    failedKeyAtMs = Date.now();
    inflightKey = undefined;
    return undefined;
  });
  return inflightKey;
}


// ── 凭据读取 ───────────────────────────────────────────────────────

function expiryToMs(value) {
  if (value <= 0) return 0;
  return value > 0xe8d4a51000 ? value : value * 1000;
}

/** 解析一个桌面端 auth 文件。 */
function parseWorkBuddyAuth(text, key) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const hasAuth = typeof parsed["auth"] === "object" && parsed["auth"] !== null;
  const auth = hasAuth ? parsed["auth"] : parsed;
  const identity = hasAuth && typeof parsed["account"] === "object" && parsed["account"] !== null ? parsed["account"] : {};

  let accessToken;
  let refreshToken;
  try {
    accessToken = credentialField(auth["accessToken"], key);
    refreshToken = credentialField(auth["refreshToken"], key);
  } catch { return undefined; }
  if (accessToken === undefined || accessToken === "") return undefined;

  const expiresAtMs = typeof auth["expiresAt"] === "number" ? expiryToMs(auth["expiresAt"]) : 0;
  const refreshExpiresAtMs = typeof auth["refreshExpiresAt"] === "number" ? expiryToMs(auth["refreshExpiresAt"]) : undefined;
  return {
    accessToken,
    refreshToken,
    expiresAtMs,
    refreshExpiresAtMs,
    domain: optionalCredentialField(auth["domain"], key) || "",
    uid: optionalCredentialField(identity["uid"], key) || "",
    nickname: optionalCredentialField(identity["nickname"], key),
    uin: optionalCredentialField(identity["uin"], key),
    enterpriseId: optionalCredentialField(identity["enterpriseId"], key),
  };
}

/** 是否需要解密（决定要不要去问 app 要密钥）。 */
function hasEncryptedCredentialFields(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return false; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const hasAuth = typeof parsed["auth"] === "object" && parsed["auth"] !== null;
  const auth = hasAuth ? parsed["auth"] : parsed;
  const identity = hasAuth && typeof parsed["account"] === "object" && parsed["account"] !== null ? parsed["account"] : parsed;
  return isEncryptedFieldWrapper(auth["accessToken"]) || isEncryptedFieldWrapper(auth["refreshToken"]) ||
    isEncryptedFieldWrapper(identity["nickname"]) || isEncryptedFieldWrapper(identity["uin"]) ||
    isEncryptedFieldWrapper(identity["uid"]) || isEncryptedFieldWrapper(auth["domain"]);
}

let cachedCredential;

/** 在当前区域的所有 auth 文件里找可用凭据。 */
async function resolveCredential() {
  if (cachedCredential) {
    const exp = Number(cachedCredential.expiresAtMs || 0);
    if (!exp || exp - Date.now() > 300000) return cachedCredential;
  }

  const dirs = defaultDesktopAuthDirs();
  const files = [];
  for (const dir of dirs) {
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      // 只认 workbuddy-desktop.info / workbuddy-desktop-ai.info 及其带时间戳的备份
      //
      // 2026-10-29 修复：原正则 /^workbuddy-desktop(\.[\w-]+)?\.info$/ 里
      // (\.[\w-]+)? 要求后缀以「.」开头，而国际版文件名是
      // workbuddy-desktop-ai.info（以「-」开头），匹配不上。
      // 结果国际版 shim 永远读到国内版的旧凭据 -> 上游 401。
      if (!/^workbuddy-desktop(-[\w-]+)?(\.[\w-]+)?\.info$/.test(name)) continue;
      files.push(join(dir, name));
    }
  }
  if (files.length === 0) {
    throw new Error("workbuddy: no desktop auth file found. Looked in:\n  " + dirs.join("\n  ") +
      "\n  WorkBuddy must be installed and signed in.");
  }

  // 🆕 2026-10-29：按区域挑选对应的 live 文件。
  //
  // 国内版（region=cn）  -> workbuddy-desktop.info
  // 国际版（region=global）-> workbuddy-desktop-ai.info
  //
  // 不区分的话，两个文件都会被读，国内版会抢到国际版凭据（或反之）。
  const regionLive = REGION === "global"
    ? "workbuddy-desktop-ai.info"
    : WORKBUDDY_LIVE_FILENAME;

  // 优先本区域的 live 文件，其次按修改时间倒序
  files.sort((a, b) => {
    const la = basename(a) === regionLive ? 0 : 1;
    const lb = basename(b) === regionLive ? 0 : 1;
    if (la !== lb) return la - lb;
    try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; }
  });

  for (const file of files) {
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    if (!hasEncryptedCredentialFields(text)) {
      const cred = parseWorkBuddyAuth(text, undefined);
      if (cred) { cachedCredential = cred; return cred; }
      continue;
    }
    // 需要密钥
    const key = await readAtRestKey();
    if (key === undefined) {
      throw new Error("workbuddy: your sign-in is encrypted but the at-rest key is unavailable.\n" +
        "  The WorkBuddy desktop app must be installed so it can hand over its key.\n" +
        "  If it lives elsewhere, set WORKBUDDY_APP_EXECUTABLE to its .exe path.\n" +
        "  Signing in again will not change this.");
    }
    const cred = parseWorkBuddyAuth(text, key);
    if (cred) { cachedCredential = cred; return cred; }
  }
  throw new Error("workbuddy: found auth files but none yielded a usable credential: " + files.join(", "));
}


// ── 上游请求 ───────────────────────────────────────────────────────

/** 上游要求的全套 CLI 形态请求头。 */
function buildHeaders(cred) {
  const domain = cred.domain || (REGION === "global" ? "www.workbuddy.ai" : "copilot.tencent.com");
  return {
    "Authorization": "Bearer " + cred.accessToken,
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": BILLING_BASE,
    "Referer": BILLING_BASE + "/",
    "X-Product": "SaaS",
    "X-User-Id": cred.uid || "",
    "X-No-Enterprise-Id": "1",
    "X-Domain": domain,
    "X-IDE-Type": "CLI",
    "X-IDE-Name": "WorkBuddy",
    "X-Conversation-ID": randomUUID(),
    "X-Conversation-Request-ID": randomUUID(),
    "X-Conversation-Message-ID": randomUUID(),
    // /v3/config 会校验 UA（缺了报 code 12403 "check ua"）
    "User-Agent": process.env.WB_UA ||
      "WorkBuddy/1.0.0 (Windows NT 10.0; Win64; x64) CodeBuddy-CLI/1.0.0",
  };
}

/** 抹平上游协议怪癖。 */
function prepareChatBody(raw) {
  let obj;
  try { obj = JSON.parse(raw); } catch { return raw; }
  if (typeof obj !== "object" || obj === null) return raw;

  // 1) 强制流式（stream:false 被拒 11101）
  obj.stream = true;

  // 2) tool_choice 传对象被拒，压平成字符串
  if (obj.tool_choice !== undefined && typeof obj.tool_choice === "object" && obj.tool_choice !== null) {
    obj.tool_choice = obj.tool_choice.type || "auto";
  }

  // 3) role: developer → system（11128）
  if (Array.isArray(obj.messages)) {
    for (const m of obj.messages) {
      if (m && m.role === "developer") m.role = "system";
    }
    // 4) 首条不是 system 就补一个**非空** system
    //
    // 两个坑叠在一起：
    //
    // 坑 A：原来补的是 content:"" 的空 system，上游把空字符串也当"空内容"，
    //       报 11151 "a message has empty content"。
    //
    // 坑 B：kimi 系列（kimi-k3-1 / kimi-k3.1-pro / kimi-k2.8-preview）
    //       **必须**带 system 消息，不带就 11151。
    //
    // 实测：
    //   kimi-k3-1  无 system        → ❌ 11151
    //   kimi-k3-1  有 system（非空）→ ✅ 正常返回
    //   codewise-jump 不需要 system → ✅ 加了也不影响
    //
    // 结论：统一补一条非空 system，对所有模型都安全。
    // 排查提示：下游看到 11151 先怀疑「system 缺失或为空」，别看错误码字面意思。
    if (obj.messages.length === 0 || obj.messages[0].role !== "system") {
      obj.messages.unshift({
        role: "system",
        content: process.env.WB_SYSTEM_PROMPT || "You are a helpful assistant.",
      });
    }

    // 5) 清掉所有空 content 的消息（11151 的另一个来源）
    //    只保留有实际内容的，或带 tool_calls / 图片的
    obj.messages = obj.messages.filter((m, i) => {
      if (!m || typeof m !== "object") return false;
      // system 必须有内容
      if (m.role === "system") {
        return typeof m.content === "string" && m.content.trim() !== "";
      }
      // assistant 带 tool_calls 的允许 content 为空
      if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        return true;
      }
      // 多模态数组：只要有任意 part 有内容就保留
      if (Array.isArray(m.content)) {
        return m.content.length > 0;
      }
      // 其余必须有非空字符串
      return typeof m.content === "string" && m.content.trim() !== "";
    });

    // 6) 过滤后如果连 user 消息都没了，补一条，否则上游会报别的错
    if (!obj.messages.some((m) => m.role === "user")) {
      obj.messages.push({ role: "user", content: "请继续。" });
    }
  }
  return JSON.stringify(obj);
}

/** 上游错误码 → OpenAI 错误体。 */
const KIND_STATUS = {
  hard_credit: 402,
  soft_rate: 429,
  model_busy: 429,
  session_dead: 401,
  policy_reject: 403,
  account_restricted: 403,
  channel_reject: 400,
  model_queue: 429,
  not_found: 502,
  server: 502,
  client: 400,
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
function sendError(res, status, message, code) {
  sendJson(res, status, { error: { message, type: code || "error", code: code || "error" } });
}

const LIMIT = 64 * 1024 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > LIMIT) { reject(new Error("request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** SSE → 聚合 JSON。 */
function aggregateSse(text, model) {
  let content = "";
  let reasoning = "";
  const toolCalls = new Map();
  let finishReason = "stop";
  let usage = null;
  let id = "";
  let created = Math.floor(Date.now() / 1000);

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") break;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { continue; }
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
        if (!toolCalls.has(idx)) {
          toolCalls.set(idx, { id: tc.id || "", type: "function", function: { name: "", arguments: "" } });
        }
        const slot = toolCalls.get(idx);
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const message = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    if (!message.content) delete message.content;
    message.content = message.content ?? null;
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


// ── 路由 ───────────────────────────────────────────────────────────

function bearerOk(req) {
  const h = req.headers.authorization;
  if (typeof h !== "string") return false;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m !== null && m[1] === TOKEN;
}

async function handleChat(req, res) {
  const started = Date.now();
  res.on("finish", () => {
    console.error("[workbuddy-shim] chat " + res.statusCode + " " + (Date.now() - started) + "ms");
  });
  const raw = (await readBody(req)).toString("utf8");

  let credential;
  try {
    credential = await resolveCredential();
  } catch (error) {
    sendError(res, 401, String(error && error.message ? error.message : error), "not_signed_in");
    return;
  }

  const prepared = prepareChatBody(raw);
  let model = "unknown";
  let streamDown = false;
  try {
    const b = JSON.parse(raw);
    if (typeof b.model === "string") model = b.model;
    streamDown = b.stream === true;
  } catch { /* 上游会拒 */ }

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  const url = CHAT_BASE + "/v2/chat/completions";
  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: buildHeaders(credential),
      body: prepared,
      redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
    });
  } catch (error) {
    sendError(res, 502, "transport error: " + String(error), "server");
    return;
  }

  if (!upstream.ok) {
    const t = (await upstream.text()).slice(0, 800);
    recordFail(model);
    flushCost();
    sendError(res, upstream.status === 401 ? 401 : 502, t || ("upstream " + upstream.status), "upstream");
    return;
  }

  if (streamDown) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } catch { /* 客户端断开 */ }
    res.end();
    return;
  }

  const text = await upstream.text();
  const out = aggregateSse(text, model);
  // 记录耗费（免费模型 credit 恒为 0）
  if (out && out.usage) {
    recordCost(model, out.usage.credit, out.usage);
    flushCost();  // 立即落盘，避免进程被杀丢数据
  } else {
    recordCost(model, 0, null);
  }
  sendJson(res, 200, out);
}

const server = createServer((req, res) => {
  const url = req.url ?? "/";

  if (req.method === "GET" && (url === "/healthz" || url === "/healthz/" || url.startsWith("/healthz?"))) {
    sendJson(res, 200, {
      ok: true,
      region: REGION,
      port: PORT,
      // 名册来源（v3/config 或 probe）
      modelsSource: rosterCache ? "v3/config" : "probe",
      modelCount: rosterCache ? rosterCache.models.length : ACTIVE_MODELS.length,
      rosterFetchedAt: rosterCache ? rosterCache.fetchedAt : null,
      // 耗费概况
      costTotal: Number(
        Object.values(costStats.byModel || {}).reduce(
          (s, x) => s + (Number(x.credit) || 0), 0
        ).toFixed(4)
      ),
      costCalls: Object.values(costStats.byModel || {}).reduce(
        (s, x) => s + (Number(x.calls) || 0), 0
      ),
      // 目录里实测免费的模型数
      verifiedFreeModels: MODEL_CATALOG.filter(
        (m) => m.verified === true && m.cost === 0
      ).map((m) => m.id),
    });
    return;
  }

  // 调试端点：用真实凭据查上游 model 名册（WB_DEBUG=1 时启用）
  if (process.env.WB_DEBUG === "1" && req.method === "GET" &&
      (url === "/debug-v3-config" || url === "/debug-v3-config/" || url.startsWith("/debug-v3-config?"))) {
    (async () => {
      const cred = await resolveCredential().catch((e) => {
        sendError(res, 500, "凭据加载失败: " + String(e), "no_cred");
        return null;
      });
      if (!cred) return;
      const paths = ["/v3/config", "/v2/config", "/v1/config"];
      const uas = [
        process.env.WB_UA || "WorkBuddy/1.0.0 (Windows NT 10.0; Win64; x64) CodeBuddy-CLI/1.0.0",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) WorkBuddy/5.6.0 Chrome/120.0.0.0 Electron/28.0.0 Safari/537.36",
        "CodeBuddy-CLI/1.0.0",
        "workbuddy/5.6.0",
      ];
      const out = [];
      for (const p of paths) {
        for (const ua of uas) {
          try {
            const h = { ...buildHeaders(cred), "User-Agent": ua };
            const r = await fetch(CHAT_BASE + p, {
              headers: h,
              signal: AbortSignal.timeout(15000),
            });
            const t = await r.text();
            out.push({ path: p, ua: ua.slice(0, 40), status: r.status, len: t.length, body: t.slice(0, 200000) });
            if (r.status === 200 && t.length > 100) break;  // 成功就不试别的 UA
          } catch (e) {
            out.push({ path: p, ua: ua.slice(0, 40), status: 0, error: String(e).slice(0, 100) });
          }
        }
      }
      sendJson(res, 200, { ok: true, base: CHAT_BASE, results: out });
    })().catch((e) => {
      if (!res.headersSent) sendError(res, 500, String(e), "internal");
    });
    return;
  }

  if (!bearerOk(req)) {
    sendError(res, 401, "missing or invalid Authorization bearer", "unauthorized");
    return;
  }

  // 官方模型名册（/v3/config）—— 完整清单 + 计费规则 + 促销
  if (req.method === "GET" && (url === "/v3/models" || url === "/v3/models/" || url.startsWith("/v3/models?"))) {
    (async () => {
      const cred = await resolveCredential().catch(() => null);
      if (!cred) {
        sendError(res, 500, "无法加载凭据", "no_cred");
        return;
      }
      const force = /[?&]force=(1|true|yes)\b/i.test(url);
      try {
        const roster = await fetchRoster(cred, force);
        // 补充成本/延迟信息（来自实测目录）
        const meta = new Map(MODEL_CATALOG.map((m) => [m.id, m]));
        const models = roster.models.map((id) => {
          const m = meta.get(id);
          return {
            id,
            display: id,
            cost: m ? m.cost : null,
            free: m ? m.cost === 0 : null,
            latencyMs: m ? m.lat : null,
            note: m ? m.note : "",
            // 免费模型立即可用；付费模型也返回，由上层决定是否启用
            selectable: true,
          };
        });
        // 按「免费优先 + 延迟」排序
        models.sort((a, b) => {
          const fa = a.free === true ? 0 : 1;
          const fb = b.free === true ? 0 : 1;
          if (fa !== fb) return fa - fb;
          return (a.latencyMs ?? 99999) - (b.latencyMs ?? 99999);
        });
        sendJson(res, 200, {
          ok: true,
          source: "v3/config",
          fetchedAt: roster.fetchedAt,
          models,
          promotions: roster.promotions,
        });
      } catch (e) {
        sendError(res, 502, String(e && e.message ? e.message : e), "roster_failed");
      }
    })().catch((e) => {
      if (!res.headersSent) sendError(res, 500, String(e), "internal");
    });
    return;
  }

  // 耗费统计
  if (req.method === "GET" && (url === "/cost" || url.startsWith("/cost?"))) {
    const byModel = costStats.byModel || {};
    const totalCredit = Object.values(byModel).reduce((s, x) => s + (Number(x.credit) || 0), 0);
    const totalCalls = Object.values(byModel).reduce((s, x) => s + (Number(x.calls) || 0), 0);
    const totalFails = Object.values(byModel).reduce((s, x) => s + (Number(x.fails) || 0), 0);
    // 按耗费降序
    const rows = Object.entries(byModel)
      .map(([id, x]) => {
        const calls = x.calls || 0;
        const credit = Number((x.credit || 0).toFixed(4));
        // 单次平均耗费（更直观）
        const costPerCall = calls > 0 ? Number((credit / calls).toFixed(4)) : null;
        return {
          model: id,
          calls,
          fails: x.fails || 0,
          credit,
          costPerCall,
          // free 按**实测**算：有成功调用且累计 credit 为 0 才算真免费
          free: calls > 0 && credit === 0,
          // 有实测数据（区别于猜的）
          measured: calls > 0,
          promptTokens: x.promptTokens || 0,
          completionTokens: x.completionTokens || 0,
        };
      })
      .sort((a, b) => b.credit - a.credit || b.calls - a.calls);
    sendJson(res, 200, {
      ok: true,
      since: costStats.since,
      totalCredit: Number(totalCredit.toFixed(4)),
      totalCalls,
      totalFails,
      byModel: rows,
    });
    return;
  }

  // 重置耗费统计
  if (req.method === "POST" && (url === "/cost/reset" || url === "/cost/reset/" || url.startsWith("/cost/reset?"))) {
    costStats = { byModel: {}, since: new Date().toISOString() };
    costDirty = true;
    flushCost();
    console.error("[workbuddy-shim] 耗费统计已重置");
    sendJson(res, 200, { ok: true, message: "耗费统计已重置", since: costStats.since });
    return;
  }

  if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/" || url.startsWith("/v1/models?"))) {
    (async () => {
      const noteOf = new Map(MODEL_CATALOG.map((m) => [m.id, m.note]));
      // 主动拉名册（有缓存就用缓存，10 分钟过期）
      //
      // 2026-11-05 修正：原来只判断 rosterCache 有没有值，
      // 由于此前没人调过 /v3/models，rosterCache 一直是空的，
      // 导致 /v1/models 永远退回 ACTIVE_MODELS（探测缓存），source 显示 "probe"。
      // 现在这里主动拉一次，失败才退回。
      let roster = null;
      try {
        const cred = await resolveCredential().catch(() => null);
        if (cred) roster = await fetchRoster(cred).catch(() => null);
      } catch { /* 退回探测结果 */ }

      const list = roster && roster.models.length > 0
        ? roster.models
        : ACTIVE_MODELS;
      const source = roster ? "v3/config" : "probe";

      // 名册里没实测过的模型，成本/延迟未知，这里补上已知的
      const meta = new Map(MODEL_CATALOG.map((m) => [m.id, m]));
      sendJson(res, 200, {
        object: "list",
        source,
        count: list.length,
        data: list.map((id) => {
          const m = meta.get(id);
          return {
            id,
            object: "model",
            created: 0,
            owned_by: "workbuddy",
            note: m ? m.note : "",
            cost: m ? m.cost : null,
            free: m ? m.cost === 0 : null,
            latencyMs: m ? m.lat : null,
          };
        }),
      });
    })().catch((e) => {
      if (!res.headersSent) {
        // 兜底：直接用探测结果，不让请求失败
        const noteOf = new Map(MODEL_CATALOG.map((m) => [m.id, m.note]));
        sendJson(res, 200, {
          object: "list",
          source: "probe",
          data: ACTIVE_MODELS.map((id) => ({
            id, object: "model", created: 0, owned_by: "workbuddy",
            note: noteOf.get(id) || "",
          })),
        });
      }
    });
    return;
  }

  // 刷新模型：并发探测上游，返回可用的清单并落盘
  if (req.method === "POST" && (url === "/refresh-models" || url === "/refresh-models/" || url.startsWith("/refresh-models?"))) {
    (async () => {
      const cred = await resolveCredential().catch(() => null);
      if (!cred) {
        sendError(res, 500, "无法加载凭据，刷新失败", "no_credential");
        return;
      }
      console.error("[workbuddy-shim] 开始探测模型（" + PROBE_CANDIDATES.length + " 个候选）...");
      const t0 = Date.now();
      const found = await discoverModels(cred, 4);
      const ms = Date.now() - t0;
      if (found.length === 0) {
        sendError(res, 502, "探测完成但没有任何模型可用", "empty");
        return;
      }
      ACTIVE_MODELS = found;
      saveDiscovered(found);
      console.error("[workbuddy-shim] 探测完成 " + found.length + " 个，用时 " + ms + "ms");
      sendJson(res, 200, {
        ok: true,
        count: found.length,
        elapsedMs: ms,
        models: found,
        savedTo: DISCOVERED_FILE,
      });
    })().catch((e) => {
      if (!res.headersSent) sendError(res, 500, String(e), "internal");
    });
    return;
  }

  if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/" || url.startsWith("/v1/chat/completions?"))) {
    handleChat(req, res).catch((error) => {
      if (!res.headersSent) sendError(res, 500, String(error), "internal");
      else res.end();
    });
    return;
  }

  sendError(res, 404, "no such route: " + req.method + " " + url, "not_found");
});

process.on("uncaughtException", (e) => {
  console.error("[workbuddy-shim] uncaught: " + (e && e.stack ? e.stack : e));
});
process.on("unhandledRejection", (e) => {
  console.error("[workbuddy-shim] unhandled: " + (e && e.stack ? e.stack : e));
});

server.listen(PORT, HOST, () => {
  console.log("[workbuddy-shim] listening on http://" + HOST + ":" + PORT + "/v1  (region=" + REGION + ")");

  // 启动时预热模型名册，这样 /healthz 的 modelsSource 立刻就是 v3/config
  // （失败也不影响服务，只是退回 probe）
  resolveCredential()
    .then((cred) => fetchRoster(cred))
    .then((r) => {
      console.log(
        "[workbuddy-shim] 启动预热名册完成：" + r.models.length + " 个模型（region=" + REGION + "）"
      );
    })
    .catch((e) => {
      console.error("[workbuddy-shim] 启动预热名册失败（将退回探测缓存）: " + String(e).slice(0, 120));
    });
});

/*
 * LICENSE-NOTICE
 *
 * 本文件中的凭据解密（at-rest）与 app 发现逻辑改写自：
 *   dsh-connect-workbuddy — MIT License, Copyright (c) 2026 LaoDing
 *   https://github.com/dingminhua/dsh-connect-workbuddy
 *
 * 其上游参考：
 *   dsh-workbuddy-connect — MIT License, Copyright (c) 2026 Corrine Hu
 *   https://github.com/corrinehu/dsh-workbuddy-connect
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



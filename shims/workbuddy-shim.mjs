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
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
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
  // 记下用的哪个账号，供按账号统计
  if (cachedCredential && cachedCredential.accountId) {
    cur.accountId = cachedCredential.accountId;
  }
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

// ── 余额查询（积分）──────────────────────────────────────────
//
// 上游接口：POST {billingBase}/v2/billing/meter/get-user-resource
// 协议参考 dsh-connect-workbuddy/scripts/probe-credits.mjs（MIT, (c) 2026 LaoDing）
//
// 返回的结构（层层嵌套）：
//   data.Response.Data.Accounts[]  每个积分包一条
//     CycleCapacitySize      周期总量
//     CycleCapacityRemain    周期剩余
//     CycleCapacityUsed      周期已用
//     CapacityRemain         总量剩余
//     PackageEndTime         过期时间
//     PackageName            包名

/** 缓存余额（避免每次请求都打上游）。 */
const balanceCache = new Map();   // accountId → { at, data }
const BALANCE_TTL_MS = 5 * 60 * 1000;   // 5 分钟

/**
 * 查某个账号的积分余额。
 *
 * @param {object} cred 凭证（需 accessToken / uid / domain）
 * @param {boolean} force 忽略缓存
 * @returns {Promise<object|null>} 余额信息，失败返回 null
 */
async function fetchBalance(cred, force = false) {
  if (!cred || !cred.accessToken) return null;

  const key = cred.accountId || cred.uid || "unknown";
  const cached = balanceCache.get(key);
  if (!force && cached && Date.now() - cached.at < BALANCE_TTL_MS) {
    return cached.data;
  }

  const domain = cred.domain || "";
  const isGlobal = domain.includes("workbuddy.ai");
  const billingBase = isGlobal ? "https://www.workbuddy.ai" : "https://www.codebuddy.cn";

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (d) =>
    d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());

  const headers = {
    "Authorization": "Bearer " + cred.accessToken,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
  if (cred.uid) headers["X-User-Id"] = cred.uid;
  if (domain) headers["X-Domain"] = domain;

  const body = {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: "p_tcaca",
    Status: [0, 3],
    PackageEndTimeRangeBegin: fmt(now),
    PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
  };

  try {
    const r = await fetch(billingBase + "/v2/billing/meter/get-user-resource", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      console.error("[workbuddy-shim] 余额查询 HTTP " + r.status);
      return null;
    }
    const doc = await r.json();
    const inner = doc?.data?.Response?.Data || {};
    const accounts = Array.isArray(inner.Accounts) ? inner.Accounts : [];

    // 汇总所有未过期积分包
    let totalRemain = 0;
    let totalSize = 0;
    const packages = [];
    for (const a of accounts) {
      const size = a.CycleCapacitySize ?? a.CapacitySize ?? 0;
      const cycleRemain = a.CycleCapacityRemain ?? 0;
      const cycleUsed = a.CycleCapacityUsed ?? 0;
      const capRemain = a.CapacityRemain ?? 0;
      const remain = size > 0 ? cycleRemain : (cycleRemain > 0 || cycleUsed > 0 ? cycleRemain : capRemain);
      if (remain <= 0) continue;
      totalRemain += remain;
      totalSize += size;
      packages.push({
        name: a.PackageName || "",
        remain,
        size,
        used: cycleUsed,
        endTime: a.PackageEndTime || "",
      });
    }

    const result = {
      credit: Math.round(totalRemain),
      totalSize: Math.round(totalSize),
      packages: packages.sort((a, b) => b.remain - a.remain),
      fetchedAt: new Date().toISOString(),
      region: isGlobal ? "global" : "cn",
    };

    balanceCache.set(key, { at: Date.now(), data: result });
    console.error(
      "[workbuddy-shim] 余额查询成功：" + result.credit + " 分（" + packages.length + " 个包）"
    );
    return result;
  } catch (e) {
    console.error("[workbuddy-shim] 余额查询失败: " + String(e).slice(0, 120));
    return null;
  }
}

// ── 多账号 vault ─────────────────────────────────────────────
//
// 独立的账号库，放在 <AstrBot data>/plugin_data/astrbot_plugin_shim_connector/vault/
// 按区域分目录，一个账号一个 JSON 文件（文件名 = accountId）。
//
// 为什么不用 ~/.dsh/workbuddy-vault：那是 dsh-connect-workbuddy 的目录，
// 两个项目写同一份文件会互相覆盖。这里用自己的一份，需要时可通过
// 导入功能把 dsh 的账号搬过来。
//
// 文件格式（兼容 dsh 的 vault 格式，方便互相导入）：
// {
//   "version": 1,
//   "accountId": "...",
//   "refreshedAtMs": 1234567890,
//   "auth": { "accessToken": "...", "refreshToken": "...", "expiresAt": ..., "domain": "..." },
//   "account": { "uid": "...", "nickname": "...", "uin": "..." }
// }

/** vault 根目录。默认在 shim 同级的 .vault/，可用 WB_VAULT_DIR 覆盖。 */
const VAULT_DIR = process.env.WB_VAULT_DIR ||
  join(fileURLToPath(new URL(".", import.meta.url)), ".vault");

/** 一区的 vault 目录。 */
function vaultDirOf(region) {
  return join(VAULT_DIR, region);
}

/** 确保目录存在。 */
function ensureVaultDir(region) {
  const d = vaultDirOf(region);
  try { mkdirSync(d, { recursive: true, mode: 0o700 }); } catch { /* 已存在 */ }
  return d;
}

/**
 * 列出某区所有账号文件。
 *
 * @returns {Array<{accountId, file, path}>}
 */
function listVaultFiles(region) {
  const d = vaultDirOf(region);
  let entries = [];
  try { entries = readdirSync(d); } catch { return []; }
  const out = [];
  for (const name of entries) {
    if (!/\.json$/.test(name)) continue;
    if (name.startsWith(".")) continue;
    out.push({
      accountId: name.replace(/\.json$/, ""),
      file: name,
      path: join(d, name),
    });
  }
  return out;
}

/** 读一个 vault 文件（容错：坏文件返回 null，不抛）。 */
function readVaultFile(path) {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    if (!doc || typeof doc !== "object") return null;
    const auth = doc.auth || {};
    const account = doc.account || {};
    if (typeof auth.accessToken !== "string" || auth.accessToken === "") return null;
    return {
      accountId: String(doc.accountId || basename(path).replace(/\.json$/, "")),
      accessToken: auth.accessToken,
      refreshToken: typeof auth.refreshToken === "string" ? auth.refreshToken : "",
      expiresAtMs: normalizeExpiry(auth.expiresAt),
      refreshExpiresAtMs: normalizeExpiry(auth.refreshExpiresAt),
      domain: String(auth.domain || ""),
      uid: String(account.uid || ""),
      nickname: String(account.nickname || ""),
      uin: String(account.uin || ""),
      raw: doc,
      filePath: path,
    };
  } catch {
    return null;
  }
}

/** 把各种形态的过期时间统一成毫秒。 */
function normalizeExpiry(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // 秒 vs 毫秒
  return n > 1e12 ? n : n * 1000;
}

/** 写一个 vault 文件（原子写：先 tmp 再 rename）。 */
function writeVaultFile(region, account) {
  const d = ensureVaultDir(region);
  const accountId = account.accountId;
  if (!accountId) throw new Error("accountId 不能为空");

  // 按 uid 去重：如果已有同 uid 但不同 accountId 的文件，先删掉。
  //
  // 起因（2026-11-07）：扫码登录生成的 accountId 是 uid 前 24 位，
  // 而从 dsh 导入的 accountId 是 dsh 自己的 hash，两者不同。
  // 结果同一个账号在 vault 里出现两份（155****9291 出现了两次）。
  const uid = String(account.uid || "").trim();
  if (uid !== "") {
    for (const old of listVaultFiles(region)) {
      if (old.accountId === accountId) continue;
      const prev = readVaultFile(old.path);
      if (prev && String(prev.uid || "").trim() === uid) {
        try {
          unlinkSync(old.path);
          console.error(
            "[workbuddy-shim] 去重：删除同 uid 的旧账号文件 " +
            old.accountId + "（uid=" + uid.slice(0, 12) + "）"
          );
        } catch { /* 删不掉就算了 */ }
      }
    }
  }

  const target = join(d, accountId + ".json");
  const tmp = target + ".tmp." + process.pid;

  const doc = {
    version: 1,
    accountId,
    refreshedAtMs: Date.now(),
    auth: {
      accessToken: account.accessToken,
      refreshToken: account.refreshToken || "",
      expiresAt: Math.floor((account.expiresAtMs || 0) / 1000),
      refreshExpiresAt: Math.floor((account.refreshExpiresAtMs || 0) / 1000),
      domain: account.domain || (region === "global" ? "www.workbuddy.ai" : "copilot.tencent.com"),
    },
    account: {
      uid: account.uid || "",
      nickname: account.nickname || "",
      uin: account.uin || "",
    },
  };

  writeFileSync(tmp, JSON.stringify(doc, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, target);
  console.error("[workbuddy-shim] 已写入账号 " + accountId + " 到 " + region + " 区 vault");
  return target;
}

/** 删一个 vault 文件。 */
function deleteVaultFile(region, accountId) {
  const p = join(vaultDirOf(region), accountId + ".json");
  try {
    unlinkSync(p);
    console.error("[workbuddy-shim] 已删除账号 " + accountId + "（" + region + " 区）");
    return true;
  } catch {
    return false;
  }
}

/** 列出某区所有账号（含余额，异步）。 */
async function listVaultAccountsWithBalance(region, withBalance = true) {
  const base = listVaultAccounts(region);
  if (!withBalance) return base;

  // 并发查余额
  const results = await Promise.all(
    base.map(async (item) => {
      if (!item.valid) return item;
      const file = listVaultFiles(region).find((f2) => f2.accountId === item.accountId);
      if (!file) return item;
      const a = readVaultFile(file.path);
      if (!a) return item;
      const bal = await fetchBalance({
        accessToken: a.accessToken,
        uid: a.uid,
        domain: a.domain,
        accountId: a.accountId,
      }).catch(() => null);
      return {
        ...item,
        credit: bal ? bal.credit : null,
        creditPackages: bal ? bal.packages.length : 0,
        creditFetchedAt: bal ? bal.fetchedAt : null,
      };
    })
  );
  return results;
}

/** 列出某区所有账号（脱敏，供 API 返回）。 */
function listVaultAccounts(region) {
  return listVaultFiles(region).map((f) => {
    const a = readVaultFile(f.path);
    if (!a) {
      return {
        accountId: f.accountId,
        valid: false,
        uid: "",
        nickname: "",
        uin: "",
        expiresAtMs: 0,
        expired: true,
      };
    }
    const now = Date.now();
    return {
      accountId: a.accountId,
      valid: true,
      uid: a.uid,
      nickname: a.nickname,
      uin: a.uin,
      expiresAtMs: a.expiresAtMs,
      expired: a.expiresAtMs > 0 && a.expiresAtMs < now,
      remainingMs: a.expiresAtMs > 0 ? Math.max(0, a.expiresAtMs - now) : null,
    };
  });
}

/**
 * 从 vault 选一个可用账号。
 *
 * 策略：
 *   1. 优先用上次成功的那个（粘性），避免每次换号导致上下文不一致
 *   2. 它失效/过期时才换下一个
 *   3. 都没有就退回桌面端凭据（原逻辑）
 *
 * @param {string} region 区域
 * @param {string} preferAccountId 优先账号（可选）
 * @returns {object|null} 凭证对象，或 null 表示用桌面端
 */
let stickyAccountId = null;

/** 因额度用尽被临时跳过的账号：accountId → 跳过到什么时候。 */
const accountCooldown = new Map();

function pickVaultAccount(region, preferAccountId) {
  const files = listVaultFiles(region);
  if (files.length === 0) return null;

  const now = Date.now();
  const candidates = [];

  for (const f of files) {
    const a = readVaultFile(f.path);
    if (!a) continue;
    // 过期不算可用（留 5 分钟余量）
    if (a.expiresAtMs > 0 && a.expiresAtMs - now < 300000) continue;
    // 额度冷却中跳过
    const cool = accountCooldown.get(a.accountId) || 0;
    if (cool > now) continue;
    candidates.push(a);
  }

  if (candidates.length === 0) {
    // 全在冷却 → 清空冷却重试（避免永久卡死）
    if (accountCooldown.size > 0) {
      console.error("[workbuddy-shim] 所有 vault 账号都在冷却，清空重试");
      accountCooldown.clear();
      return pickVaultAccount(region, preferAccountId);
    }
    return null;
  }

  const want = preferAccountId || stickyAccountId;
  if (want) {
    const hit = candidates.find((a) => a.accountId === want);
    if (hit) return hit;
  }
  stickyAccountId = candidates[0].accountId;
  return candidates[0];
}

/**
 * 标记某账号进入冷却（额度用尽时调用）。
 *
 * @param {string} accountId
 * @param {number} minutes 冷却分钟数
 */
function coolDownAccount(accountId, minutes = 30) {
  if (!accountId) return;
  accountCooldown.set(accountId, Date.now() + minutes * 60000);
  // 如果当前粘性的就是它，清掉，让下次选别的
  if (stickyAccountId === accountId) stickyAccountId = null;
  cachedCredential = null;
  console.error(
    "[workbuddy-shim] 账号 " + accountId.slice(0, 12) + " 进入冷却 " + minutes + " 分钟"
  );
}

// ── 扫码登录（OAuth QR sign-in）──────────────────────────────
//
// 协议复刻自 dsh-connect-workbuddy/src/oauth.ts（MIT, Copyright (c) 2026 LaoDing），
// 只保留取凭据所必需的三步，UI 部分由 AstrBot 的 pages 承担。
//
// 流程：
//   1. POST {base}/v2/plugin/auth/state?platform=workbuddy
//        → 拿到 state + authUrl（用户在浏览器打开这个 URL 扫码/确认）
//   2. 轮询 GET {base}/v2/plugin/auth/token?state={state}
//        → code=0/200 且带 accessToken 即成功
//   3. GET {base}/v2/plugin/login/account  （带 Bearer）
//        → 拿 uid / nickname / uin
//   4. 写入 vault
//
// 会话只在进程内存（loginSessions），进程重启即取消 —— 和参考实现一致。

/** 上游插件 API 前缀。 */
const OAUTH_API_PREFIX = "/v2/plugin";

/** 登录会话有效期（秒）。 */
const OAUTH_TIMEOUT_SECONDS = 600;

/** 内存里的登录会话：loginId → session。 */
const loginSessions = new Map();

/** 某区发起登录用的 base。 */
function oauthBaseOf(region) {
  if (region === "global") return process.env.WB_GLOBAL_BASE || "https://www.workbuddy.ai";
  return process.env.WB_CN_BASE || "https://www.codebuddy.cn";
}

/** 读 JSON，非 JSON 返回 undefined。 */
async function readJsonSafe(resp) {
  try {
    const text = await resp.text();
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
  } catch { /* fall through */ }
  return undefined;
}

/** 取信封里的 data 对象。 */
function envelopeData(doc) {
  const d = doc && doc.data;
  return typeof d === "object" && d !== null && !Array.isArray(d) ? d : {};
}

/** 多个可能的 key 取第一个非空字符串。 */
function firstString(src, keys) {
  for (const k of keys) {
    const v = src[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

/** 过期时间：绝对时间戳（秒/毫秒）或相对 TTL（秒）。 */
function expiryOf(src, absKeys, ttlKeys) {
  for (const k of absKeys) {
    const v = src[k];
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  }
  for (const k of ttlKeys) {
    const n = Number(src[k]);
    if (Number.isFinite(n) && n > 0) return Date.now() + n * 1000;
  }
  return 0;
}

// ── 导入外部凭据（dsh vault + 桌面端）────────────────────────
//
// 用户本地可能已经有账号：
//   1. dsh-connect-workbuddy 的 vault（~/.dsh/workbuddy-vault/）
//   2. WorkBuddy 桌面端的 auth 文件（CodeBuddyExtension/.../auth/）
//
// 这个函数把它们全部搬进我们的 vault，之后统一走 vault 选号逻辑。

/**
 * dsh vault 的可能位置（按优先级）。
 *
 * 只认**环境变量**和**用户主目录**下的默认位置，不猜具体盘符。
 *
 * 支持的来源：
 *   1. DSH_HOME 环境变量（dsh 官方约定）
 *   2. WB_DSH_VAULT 环境变量（本插件专用，可直接指向 vault 目录）
 *   3. ~/.dsh/workbuddy-vault（默认）
 *   4. Windows 上额外试 %USERPROFILE%/.dsh/workbuddy-vault（已在 3 覆盖）
 *
 * 如果 vault 在别处，用户需要设 DSH_HOME 或 WB_DSH_VAULT。
 */
/**
 * 生成 dsh vault 的**候选位置**（不检查是否存在）。
 *
 * 用于：
 *   1. 自动检测（逐个检查存在性）
 *   2. 给用户看「我找过这些地方」，方便手动指定
 *
 * 不写死任何具体盘符 —— 用环境变量和用户目录推导。
 */
function dshVaultCandidates() {
  const h = homedir();
  const out = [];
  const seen = new Set();

  const push = (p, why) => {
    if (!p) return;
    const k = p.toLowerCase().replace(/[\\/]+$/, "");
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ path: p, why });
  };

  // 1) 环境变量（最可靠）
  if (process.env.WB_DSH_VAULT) {
    push(process.env.WB_DSH_VAULT, "环境变量 WB_DSH_VAULT");
  }
  const dshHomeEnv = (process.env.DSH_HOME || "").trim();
  if (dshHomeEnv !== "") {
    push(join(dshHomeEnv, "workbuddy-vault"), "环境变量 DSH_HOME");
    push(join(dshHomeEnv, "vault"), "环境变量 DSH_HOME（备选名）");
  }

  // 2) 用户主目录
  push(join(h, ".dsh", "workbuddy-vault"), "默认位置 ~/.dsh/workbuddy-vault");

  // 3) 常见自定义开发目录（相对主目录，不假设具体盘符）
  push(join(h, "dev", "dsh-home", "workbuddy-vault"), "~/dev/dsh-home 下的 vault");
  push(join(h, "dsh-home", "workbuddy-vault"), "~/dsh-home 下的 vault");

  // 4) Windows：遍历已有盘符，探测 <盘>/dev/dsh-home 与 <盘>/dsh-home
  //    只作为候选列出，不假设一定存在
  if (process.platform === "win32") {
    const drives = [];
    for (const letter of "CDEFGHIJ".split("")) {
      try {
        if (existsSync(letter + ":\\")) drives.push(letter + ":");
      } catch { /* skip */ }
    }
    for (const d of drives) {
      push(join(d + "\\", "dev", "dsh-home", "workbuddy-vault"), d + " 盘的 dev/dsh-home");
      push(join(d + "\\", "dsh-home", "workbuddy-vault"), d + " 盘的 dsh-home");
    }
  }

  return out;
}

/** 只返回实际存在的 vault 目录。 */
function dshVaultDirs() {
  return dshVaultCandidates()
    .filter((x) => {
      try { return existsSync(x.path); } catch { return false; }
    })
    .map((x) => x.path);
}

/**
 * 探测报告：所有候选位置 + 是否存在 + 里面有几个账号。
 *
 * 供 /accounts/scan 接口返回，前端展示「我找过哪些地方」。
 */
function scanVaultLocations() {
  const candidates = dshVaultCandidates();
  return candidates.map((x) => {
    let exists = false;
    let accountCount = 0;
    let regions = {};
    try {
      exists = existsSync(x.path);
      if (exists) {
        for (const region of ["cn", "global"]) {
          const rd = join(x.path, region);
          if (!existsSync(rd)) continue;
          let files = [];
          try { files = readdirSync(rd); } catch { continue; }
          const n = files.filter((f) => /\.json$/.test(f)).length;
          if (n > 0) {
            regions[region] = n;
            accountCount += n;
          }
        }
      }
    } catch { /* ignore */ }
    return {
      path: x.path,
      why: x.why,
      exists,
      accountCount,
      regions,
      // 已导入到我们 vault 的数量（去重后）
      imported: exists && accountCount > 0,
    };
  });
}

/** 向后兼容：返回第一个存在的。 */
function dshVaultDir() {
  const all = dshVaultDirs();
  return all.length > 0 ? all[0] : join(homedir(), ".dsh", "workbuddy-vault");
}

/**
 * 从 dsh vault 导入账号（明文 token，直接可读）。
 *
 * @param {boolean} dryRun 只报告不写入
 * @returns {Promise<{imported, skipped, errors, details}>}
 */
async function importFromDshVault(dryRun = false, explicitPath = "") {
  // explicitPath 非空时只用它（手动指定），否则自动扫描
  const roots = explicitPath ? [explicitPath] : dshVaultDirs();
  const result = { imported: 0, skipped: 0, errors: [], details: [], sources: roots };

  if (explicitPath && !existsSync(explicitPath)) {
    result.errors.push("指定的路径不存在: " + explicitPath);
    return result;
  }

  if (roots.length === 0) {
    result.errors.push("没找到 dsh vault 目录。可用 DSH_HOME 或 WB_DSH_VAULT 环境变量指定");
    return result;
  }

  console.error("[workbuddy-shim] 找到 " + roots.length + " 个 dsh vault: " + roots.join(", "));

  for (const root of roots) {
  for (const region of ["cn", "global"]) {
    const dir = join(root, region);
    if (!existsSync(dir)) continue;

    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }

    for (const name of entries) {
      if (!/\.json$/.test(name)) continue;
      const p = join(dir, name);
      const a = readVaultFile(p);
      if (!a) {
        result.errors.push("解析失败: " + name);
        continue;
      }
      // 已存在同 uid 的就跳过
      const existing = listVaultFiles(region)
        .map((x) => readVaultFile(x.path))
        .filter(Boolean);
      if (existing.some((x) => x.uid === a.uid && a.uid !== "")) {
        result.skipped += 1;
        result.details.push({ region, accountId: a.accountId, action: "skip", reason: "已存在" });
        continue;
      }
      if (!dryRun) {
        writeVaultFile(region, {
          accountId: a.accountId,
          accessToken: a.accessToken,
          refreshToken: a.refreshToken,
          expiresAtMs: a.expiresAtMs,
          refreshExpiresAtMs: a.refreshExpiresAtMs,
          domain: a.domain,
          uid: a.uid,
          nickname: a.nickname,
          uin: a.uin,
        });
      }
      result.imported += 1;
      result.details.push({
        region,
        accountId: a.accountId,
        nickname: a.nickname,
        uid: a.uid,
        action: dryRun ? "would-import" : "imported",
      });
    }
  }
  }  // for (const root of roots)
  return result;
}

/**
 * 从桌面端 auth 文件导入（token 是加密的，需要 at-rest 密钥）。
 *
 * @param {boolean} dryRun
 * @returns {Promise<{imported, skipped, errors, details}>}
 */
async function importFromDesktop(dryRun = false) {
  const result = { imported: 0, skipped: 0, errors: [], details: [] };

  let key;
  try {
    key = await readAtRestKey();
  } catch (e) {
    result.errors.push("拿不到 at-rest 密钥（桌面端可能没安装）: " + String(e).slice(0, 100));
    return result;
  }
  if (key === undefined) {
    result.errors.push("桌面端凭据是加密的，但没有可用的 at-rest 密钥");
    return result;
  }

  const dirs = defaultDesktopAuthDirs();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }

    for (const name of entries) {
      if (!/^workbuddy-desktop(-[\w-]+)?(\.[\w-]+)?\.info$/.test(name)) continue;
      if (name.includes(".observation.") || name.endsWith(".tmp")) continue;

      const p = join(dir, name);
      let text;
      try { text = readFileSync(p, "utf8"); } catch { continue; }

      const cred = parseWorkBuddyAuth(text, key);
      if (!cred || !cred.accessToken) {
        result.errors.push("解密失败: " + name);
        continue;
      }

      // 判断区域
      const region = (cred.domain || "").includes("workbuddy.ai") ? "global" : "cn";
      const uid = cred.uid || "";
      const accountId = uid !== "" ? uid.replace(/-/g, "").slice(0, 24) : randomUUID().replace(/-/g, "").slice(0, 24);

      const existing = listVaultFiles(region)
        .map((x) => readVaultFile(x.path))
        .filter(Boolean);
      if (existing.some((x) => x.uid === uid && uid !== "")) {
        result.skipped += 1;
        result.details.push({ region, accountId, action: "skip", reason: "已存在" });
        continue;
      }

      if (!dryRun) {
        writeVaultFile(region, {
          accountId,
          accessToken: cred.accessToken,
          refreshToken: cred.refreshToken || "",
          expiresAtMs: Number(cred.expiresAtMs || 0),
          refreshExpiresAtMs: 0,
          domain: cred.domain || (region === "global" ? "www.workbuddy.ai" : "copilot.tencent.com"),
          uid,
          nickname: "",
          uin: "",
        });
      }
      result.imported += 1;
      result.details.push({ region, accountId, uid, action: dryRun ? "would-import" : "imported" });
    }
  }
  return result;
}

/** 一次性导入所有外部凭据。 */
async function importAllExternal(dryRun = false, explicitPath = "") {
  const dsh = await importFromDshVault(dryRun, explicitPath);
  const desktop = await importFromDesktop(dryRun);
  return {
    dryRun,
    dshVault: dsh,
    desktop,
    total: {
      imported: dsh.imported + desktop.imported,
      skipped: dsh.skipped + desktop.skipped,
    },
    errors: [...dsh.errors, ...desktop.errors],
  };
}

/**
 * 发起一次扫码登录。
 *
 * @param {string} region "cn" | "global"
 * @returns {Promise<{loginId, verificationUri, expiresIn} | {error}>}
 */
async function oauthStart(region) {
  const base = oauthBaseOf(region).replace(/\/+$/, "");
  let resp;
  try {
    resp = await fetch(base + OAUTH_API_PREFIX + "/auth/state?platform=workbuddy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { error: "连不上 " + base + "：" + String(e).slice(0, 120) };
  }
  const doc = await readJsonSafe(resp);
  if (doc === undefined) {
    return { error: "登录服务返回了非 JSON（HTTP " + resp.status + "）" };
  }
  const data = envelopeData(doc);
  const state = firstString(data, ["state", "State"]);
  if (state === "") {
    return { error: "登录服务没有下发 state（HTTP " + resp.status + "）" };
  }
  const authUrl = firstString(data, ["authUrl", "auth_url", "url", "Url"])
    || base + "/login?state=" + encodeURIComponent(state);

  const loginId = "wb_" + randomUUID().replace(/-/g, "");
  loginSessions.set(loginId, {
    region,
    base,
    state,
    expiresAtMs: Date.now() + OAUTH_TIMEOUT_SECONDS * 1000,
    done: false,
  });
  console.error("[workbuddy-shim] 发起登录 " + loginId + "（" + region + " 区）");
  return { loginId, verificationUri: authUrl, expiresIn: OAUTH_TIMEOUT_SECONDS };
}

/**
 * 轮询一次登录结果。
 *
 * @param {string} loginId
 * @returns {Promise<{done:false} | {done:true, account} | {done:true, error}>}
 */
async function oauthPoll(loginId) {
  const s = loginSessions.get(loginId);
  if (!s) return { done: true, error: "登录会话不存在，请重新发起" };
  if (s.done) return { done: true, error: s.error || "登录已结束" };
  if (Date.now() > s.expiresAtMs) {
    s.done = true;
    loginSessions.delete(loginId);
    return { done: true, error: "登录超时，请重新发起" };
  }

  let resp;
  try {
    resp = await fetch(
      s.base + OAUTH_API_PREFIX + "/auth/token?state=" + encodeURIComponent(s.state),
      { method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30000) },
    );
  } catch {
    // 网络抖动不算失败，用户可能还在扫码
    return { done: false };
  }
  const doc = await readJsonSafe(resp);
  if (doc === undefined) return { done: false };

  const code = typeof doc.code === "number" ? doc.code : -1;
  if (code !== 0 && code !== 200) return { done: false };

  const data = envelopeData(doc);
  const accessToken = firstString(data, ["accessToken", "access_token", "AccessToken"]);
  if (accessToken === "") return { done: false };

  // 成功：补账号资料
  const domain = firstString(data, ["domain", "Domain"]);
  const headers = { Authorization: "Bearer " + accessToken, Accept: "application/json" };
  if (domain !== "") headers["X-Domain"] = domain;

  let profile = {};
  try {
    const pr = await fetch(s.base + OAUTH_API_PREFIX + "/login/account", {
      method: "GET", headers, signal: AbortSignal.timeout(30000),
    });
    const pd = await readJsonSafe(pr);
    if (pd !== undefined) profile = envelopeData(pd);
  } catch { /* 资料是展示用，拿不到不影响登录 */ }

  const uid = firstString(profile, ["uid", "Uid", "userId", "UserID"]);
  const nickname = firstString(profile, ["nickname", "NickName", "ScreenName"]);
  const uin = firstString(profile, ["uin", "Uin"]);
  const refreshToken = firstString(data, ["refreshToken", "refresh_token", "RefreshToken"]);
  const expiresAtMs = expiryOf(data, ["expiresAt", "expires_at"], ["expiresIn", "expires_in"]);
  const refreshExpiresAtMs = expiryOf(data, ["refreshExpiresAt", "refresh_expires_at"], ["refreshExpiresIn", "refresh_expires_in"]);

  // accountId：优先用 uid（稳定），没 uid 就用随机串
  const accountId = uid !== "" ? uid.replace(/-/g, "").slice(0, 24) : randomUUID().replace(/-/g, "").slice(0, 24);

  const account = {
    accountId,
    accessToken,
    refreshToken,
    expiresAtMs,
    refreshExpiresAtMs,
    domain: domain || (s.region === "global" ? "www.workbuddy.ai" : "copilot.tencent.com"),
    uid,
    nickname,
    uin,
  };

  try {
    writeVaultFile(s.region, account);
  } catch (e) {
    s.done = true;
    loginSessions.delete(loginId);
    return { done: true, error: "登录成功但写入 vault 失败：" + String(e).slice(0, 150) };
  }

  s.done = true;
  loginSessions.delete(loginId);
  console.error("[workbuddy-shim] 登录成功：" + (nickname || uid || accountId) + "（" + s.region + " 区）");
  return { done: true, account };
}

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
/** 读对端区的凭据（用于跨区兜底）。 */
let peerCredCache = null;
let peerCredAt = 0;

async function resolvePeerCredential() {
  if (peerCredCache && Date.now() - peerCredAt < 300000) return peerCredCache;

  // ① 对端区的 vault 账号优先
  try {
    const v = pickVaultAccount(PEER_REGION);
    if (v) {
      peerCredCache = {
        accessToken: v.accessToken,
        refreshToken: v.refreshToken,
        expiresAtMs: v.expiresAtMs,
        domain: v.domain || (PEER_REGION === "global" ? "www.workbuddy.ai" : "copilot.tencent.com"),
        uid: v.uid,
        accountId: v.accountId,
        source: "vault",
      };
      peerCredAt = Date.now();
      console.error("[workbuddy-shim] 跨区兜底：用 vault 里的 " + PEER_REGION + " 区账号");
      return peerCredCache;
    }
  } catch { /* 退回桌面端 */ }

  // ② 退回桌面端凭据
  const home = homedir();
  const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
  const roaming = process.env.APPDATA || join(home, "AppData", "Roaming");
  const dirs = [
    join(local, "CodeBuddyExtension", "Data", "Public", "auth"),
    join(roaming, "CodeBuddyExtension", "Data", "Public", "auth"),
  ];

  // 对端区的 live 文件名
  const peerFile = PEER_REGION === "global"
    ? "workbuddy-desktop-ai.info"
    : "workbuddy-desktop.info";

  for (const dir of dirs) {
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    if (!entries.includes(peerFile)) continue;

    let text;
    try { text = readFileSync(join(dir, peerFile), "utf8"); } catch { continue; }

    let cred = null;
    if (!hasEncryptedCredentialFields(text)) {
      // 明文
      cred = parseWorkBuddyAuth(text, undefined);
    } else {
      // 需要 at-rest 密钥（和本区共用同一个密钥）
      const key = await readAtRestKey().catch(() => undefined);
      if (key === undefined) continue;
      cred = parseWorkBuddyAuth(text, key);
    }
    if (cred && cred.accessToken) {
      cred.domain = PEER_REGION === "global" ? "www.workbuddy.ai" : "copilot.tencent.com";
      peerCredCache = cred;
      peerCredAt = Date.now();
      console.error("[workbuddy-shim] 跨区兜底：已加载 " + PEER_REGION + " 区凭据");
      return cred;
    }
  }
  return null;
}

async function resolveCredential() {
  if (cachedCredential) {
    const exp = Number(cachedCredential.expiresAtMs || 0);
    if (!exp || exp - Date.now() > 300000) return cachedCredential;
  }

  // ① 优先用 vault 里的账号（扫码登录添加的）
  //    多个账号时按 stickyAccountId 保持粘性，避免每次换号
  try {
    const v = pickVaultAccount(REGION);
    if (v) {
      cachedCredential = {
        accessToken: v.accessToken,
        refreshToken: v.refreshToken,
        expiresAtMs: v.expiresAtMs,
        domain: v.domain || (REGION === "global" ? "www.workbuddy.ai" : "copilot.tencent.com"),
        uid: v.uid,
        accountId: v.accountId,
        source: "vault",
      };
      return cachedCredential;
    }
  } catch (e) {
    console.error("[workbuddy-shim] 读 vault 失败，退回桌面端凭据: " + String(e).slice(0, 100));
  }

  // ② vault 没有可用账号，退回桌面端凭据（原有逻辑）
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

// ── 跨区兜底（额度用尽时自动换区）──────────────────────────
//
// 问题：CN 区和 intl 区是**两个独立账号**，额度分开算。
// 实测 2026-11-05：
//   CN   glm-5.3-flash → 14018 额度已用尽，但 hy3 还能用
//   INTL glm-5.3-flash → 正常
//
// 所以 CN 区某个模型额度用尽时，可以试试 intl 区的同名模型。
//
// 开关：WB_CROSS_REGION=0 关掉（默认开）
// 触发条件：上游返回 14018（额度用尽）或 1113（余额不足）
const CROSS_REGION = (process.env.WB_CROSS_REGION ?? "1") !== "0";

/** 跨区映射：本区 → 对端区。 */
const PEER_REGION = REGION === "global" ? "cn" : "global";
const PEER_BASE = PEER_REGION === "global" ? "https://www.workbuddy.ai" : "https://copilot.tencent.com";

/** 是否属于「额度/余额问题」——这类才值得跨区重试。 */
function isQuotaError(text) {
  return /"code"\s*:\s*(14018|1113|6004|6005)\b/.test(text)
    || /额度已用尽|余额不足|无可用资源包|credit.*用完/i.test(text);
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

  // content 为空但 reasoning 有值时，用 reasoning 顶替 content。
  //
  // 起因（2026-11-05）：hy4-preview 这类推理模型只吐 reasoning_content，
  // content 恒为 null。下游（AstrBot）只读 content，就会认为「模型返回空」，
  // 白白用掉一次 fallback 重试。
  //
  // 注意：reasoning_content 仍然保留，能区分出"这句是思考过程"的客户端不受影响。
  let finalContent = content;
  let contentFromReasoning = false;
  if ((finalContent === "" || finalContent === null || finalContent === undefined) && reasoning) {
    finalContent = reasoning;
    contentFromReasoning = true;
  }

  const message = { role: "assistant", content: finalContent || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (contentFromReasoning) message._content_from_reasoning = true;
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

    // ── 换账号重试（同区内）──
    // 额度用尽时，先在本区换下一个 vault 账号试试，再考虑跨区。
    // 顺序：本区换号 → 跨区换号 → 放弃
    if (isQuotaError(t) && credential && credential.accountId) {
      coolDownAccount(credential.accountId, 30);
      console.error(
        "[workbuddy-shim] " + model + " 额度问题，尝试同区换号重试"
      );
      try {
        const next = pickVaultAccount(REGION);
        if (next && next.accountId !== credential.accountId) {
          const nextHeaders = buildHeaders({
            ...next,
            domain: next.domain || (REGION === "global" ? "www.workbuddy.ai" : "copilot.tencent.com"),
          });
          const retryRes = await fetch(CHAT_BASE + "/v2/chat/completions", {
            method: "POST",
            headers: nextHeaders,
            body: prepared,
            redirect: "error",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
          });
          if (retryRes.ok) {
            console.error(
              "[workbuddy-shim] " + model + " 换号成功（" + next.accountId.slice(0, 12) + "）"
            );
            cachedCredential = {
              accessToken: next.accessToken,
              refreshToken: next.refreshToken,
              expiresAtMs: next.expiresAtMs,
              domain: next.domain,
              uid: next.uid,
              accountId: next.accountId,
              source: "vault",
            };
            if (streamDown) {
              res.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "X-WB-Account": next.accountId.slice(0, 12),
                "X-WB-Fallback": "account-switch",
              });
              const reader = retryRes.body.getReader();
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  res.write(Buffer.from(value));
                }
              } catch { /* client gone */ }
              res.end();
              return;
            }
            const retryText = await retryRes.text();
            const retryOut = aggregateSse(retryText, model);
            if (retryOut && retryOut.usage) {
              recordCost(model, retryOut.usage.credit, retryOut.usage);
              flushCost();
            }
            res.setHeader("X-WB-Account", next.accountId.slice(0, 12));
            res.setHeader("X-WB-Fallback", "account-switch");
            sendJson(res, 200, retryOut);
            return;
          }
          const retryErr = (await retryRes.text()).slice(0, 200);
          console.error("[workbuddy-shim] 换号也失败: " + retryErr);
          // 换的号也不行 → 也冷却
          if (isQuotaError(retryErr)) coolDownAccount(next.accountId, 30);
        } else {
          console.error("[workbuddy-shim] 同区没有其他可用账号");
        }
      } catch (e) {
        console.error("[workbuddy-shim] 换号重试异常: " + String(e).slice(0, 120));
      }
    }

    // ── 跨区兜底 ──
    // 额度用尽（14018）或余额不足（1113）时，试试对端区的同一个模型。
    // CN 和 intl 是两个独立账号，额度分开算，所以这条路常常有效。
    if (CROSS_REGION && isQuotaError(t)) {
      console.error(
        "[workbuddy-shim] " + model + " " + REGION + " 区额度问题，尝试跨区兜底 → " + PEER_REGION
      );
      try {
        const peer = await resolvePeerCredential();
        if (peer) {
          const peerHeaders = { ...buildHeaders(peer), "X-Domain": PEER_REGION === "global" ? "www.workbuddy.ai" : "copilot.tencent.com" };
          const peerRes = await fetch(PEER_BASE + "/v2/chat/completions", {
            method: "POST",
            headers: peerHeaders,
            body: prepared,
            redirect: "error",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
          });
          if (peerRes.ok) {
            console.error("[workbuddy-shim] " + model + " 跨区兜底成功（" + PEER_REGION + " 区）");
            // 用对端响应继续走后续流程
            if (streamDown) {
              res.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "X-WB-Region": PEER_REGION,
                "X-WB-Fallback": "cross-region",
              });
              const reader = peerRes.body.getReader();
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
            const peerText = await peerRes.text();
            const peerOut = aggregateSse(peerText, model);
            if (peerOut && peerOut.usage) {
              recordCost(model, peerOut.usage.credit, peerOut.usage);
              flushCost();
            }
            res.setHeader("X-WB-Region", PEER_REGION);
            res.setHeader("X-WB-Fallback", "cross-region");
            sendJson(res, 200, peerOut);
            return;
          }
          const peerErr = (await peerRes.text()).slice(0, 300);
          console.error("[workbuddy-shim] 跨区兜底也失败: " + peerErr);
        } else {
          console.error("[workbuddy-shim] 跨区兜底跳过：拿不到 " + PEER_REGION + " 区凭据");
        }
      } catch (e) {
        console.error("[workbuddy-shim] 跨区兜底异常: " + String(e).slice(0, 150));
      }
    }

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

  // ── 账号管理 ──────────────────────────────────────────────

  // 当前正在用的账号
  if (req.method === "GET" && (url === "/accounts/current" || url.startsWith("/accounts/current?"))) {
    (async () => {
      const cred = await resolveCredential().catch(() => null);
      const now = Date.now();
      const cooling = [];
      for (const [id, until] of accountCooldown.entries()) {
        if (until > now) cooling.push({ accountId: id, untilMs: until, remainMin: Math.round((until-now)/60000) });
      }
      sendJson(res, 200, {
        ok: true,
        region: REGION,
        current: cred ? {
          accountId: cred.accountId || "(desktop)",
          uid: cred.uid || "",
          source: cred.source || "desktop",
          expiresAtMs: cred.expiresAtMs || 0,
        } : null,
        sticky: stickyAccountId,
        cooling,
      });
    })().catch((e) => {
      if (!res.headersSent) sendError(res, 500, String(e), "internal");
    });
    return;
  }

  // 导入外部凭据（dsh vault + 桌面端）
  if (req.method === "POST" && (url === "/accounts/import" || url.startsWith("/accounts/import?"))) {
    (async () => {
      let body = {};
      try {
        const raw = (await readBody(req)).toString("utf8");
        if (raw.trim() !== "") body = JSON.parse(raw);
      } catch { /* ignore */ }
      const dryRun = body.dryRun === true;
      const source = String(body.source || "all");  // all | dsh | desktop
      const explicitPath = String(body.path || "").trim();  // 手动指定的 vault 路径

      let result;
      if (source === "dsh") result = { dshVault: await importFromDshVault(dryRun, explicitPath) };
      else if (source === "desktop") result = { desktop: await importFromDesktop(dryRun) };
      else result = await importAllExternal(dryRun, explicitPath);

      console.error(
        "[workbuddy-shim] 导入外部凭据" + (dryRun ? "（试运行）" : "") + ": " +
        JSON.stringify(result.total || {})
      );
      sendJson(res, 200, { ok: true, ...result });
    })().catch((e) => {
      if (!res.headersSent) sendError(res, 500, String(e), "internal");
    });
    return;
  }

  // 扫描 vault 候选位置（告诉用户找过哪些地方）
  if (req.method === "GET" && (url === "/accounts/scan" || url.startsWith("/accounts/scan?"))) {
    sendJson(res, 200, {
      ok: true,
      candidates: scanVaultLocations(),
      vaultDir: VAULT_DIR,
      hint: "自动扫描只覆盖常见位置。如果你的 vault 在别处，用「手动指定路径」或设 DSH_HOME / WB_DSH_VAULT 环境变量。",
    });
    return;
  }

  // 列出某区所有账号
  if (req.method === "GET" && (url === "/accounts" || url.startsWith("/accounts?"))) {
    (async () => {
      const region = /[?&]region=(global|cn)\b/.exec(url)?.[1] || REGION;
      // ?balance=0 可跳过余额查询（更快）
      const withBalance = !/[?&]balance=0\b/.test(url);
      const accounts = await listVaultAccountsWithBalance(region, withBalance);
      sendJson(res, 200, {
        ok: true,
        region,
        vaultDir: vaultDirOf(region),
        accounts,
      });
    })().catch((e) => {
      if (!res.headersSent) sendError(res, 500, String(e), "internal");
    });
    return;
  }

  // 发起扫码登录
  if (req.method === "POST" && (url === "/login/start" || url.startsWith("/login/start?"))) {
    (async () => {
      let body = {};
      try {
        const raw = (await readBody(req)).toString("utf8");
        if (raw.trim() !== "") body = JSON.parse(raw);
      } catch { /* 空 body 也行 */ }
      const region = String(body.region || (/[?&]region=(global|cn)\b/.exec(url)?.[1]) || REGION);
      if (region !== "cn" && region !== "global") {
        sendError(res, 400, "region 只能是 cn 或 global", "bad_region");
        return;
      }
      const r = await oauthStart(region);
      if (r.error) sendError(res, 502, r.error, "login_start_failed");
      else sendJson(res, 200, { ok: true, ...r });
    })().catch((e) => {
      if (!res.headersSent) sendError(res, 500, String(e), "internal");
    });
    return;
  }

  // 轮询登录结果
  if (req.method === "GET" && (url === "/login/poll" || url.startsWith("/login/poll?"))) {
    (async () => {
      const loginId = /[?&]loginId=([^&]+)/.exec(url)?.[1];
      if (!loginId) {
        sendError(res, 400, "缺少 loginId 参数", "bad_request");
        return;
      }
      const r = await oauthPoll(decodeURIComponent(loginId));
      if (r.done && r.account) {
        sendJson(res, 200, {
          ok: true,
          done: true,
          account: {
            accountId: r.account.accountId,
            uid: r.account.uid,
            nickname: r.account.nickname,
            uin: r.account.uin,
            expiresAtMs: r.account.expiresAtMs,
          },
        });
      } else if (r.done) {
        sendJson(res, 200, { ok: false, done: true, error: r.error || "登录失败" });
      } else {
        sendJson(res, 200, { ok: true, done: false });
      }
    })().catch((e) => {
      if (!res.headersSent) sendError(res, 500, String(e), "internal");
    });
    return;
  }

  // 删除账号
  if (req.method === "POST" && (url === "/accounts/delete" || url.startsWith("/accounts/delete?"))) {
    (async () => {
      let body = {};
      try {
        const raw = (await readBody(req)).toString("utf8");
        if (raw.trim() !== "") body = JSON.parse(raw);
      } catch { /* ignore */ }
      const region = String(body.region || REGION);
      const accountId = String(body.accountId || "");
      if (!accountId) {
        sendError(res, 400, "缺少 accountId", "bad_request");
        return;
      }
      const ok = deleteVaultFile(region, accountId);
      if (ok && stickyAccountId === accountId) stickyAccountId = null;
      sendJson(res, 200, { ok, region, accountId });
    })().catch((e) => {
      if (!res.headersSent) sendError(res, 500, String(e), "internal");
    });
    return;
  }

  // 测试某个账号是否可用
  if (req.method === "POST" && (url === "/accounts/test" || url.startsWith("/accounts/test?"))) {
    (async () => {
      let body = {};
      try {
        const raw = (await readBody(req)).toString("utf8");
        if (raw.trim() !== "") body = JSON.parse(raw);
      } catch { /* ignore */ }

      const accountId = String(body.accountId || "");
      const region = String(body.region || REGION);
      if (!accountId) {
        sendError(res, 400, "缺少 accountId", "bad_request");
        return;
      }

      const file = listVaultFiles(region).find((x) => x.accountId === accountId);
      if (!file) {
        sendError(res, 404, "账号不存在: " + accountId, "not_found");
        return;
      }
      const acc = readVaultFile(file.path);
      if (!acc) {
        sendError(res, 400, "账号文件损坏", "bad_file");
        return;
      }

      // 用该账号发一个最小请求
      const testModel = String(body.model || "hy3");
      const chatBase = region === "global" ? "https://www.workbuddy.ai" : "https://copilot.tencent.com";
      const cred = {
        accessToken: acc.accessToken,
        domain: acc.domain || (region === "global" ? "www.workbuddy.ai" : "copilot.tencent.com"),
        uid: acc.uid,
        accountId: acc.accountId,
      };

      const started = Date.now();
      let ok = false;
      let message = "";
      let model = testModel;
      let latencyMs = null;

      try {
        const payload = JSON.stringify({
          model: testModel,
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "hi" },
          ],
          max_tokens: 16,
          stream: true,
        });
        const r = await fetch(chatBase + "/v2/chat/completions", {
          method: "POST",
          headers: buildHeaders(cred),
          body: payload,
          signal: AbortSignal.timeout(45000),
        });
        latencyMs = Date.now() - started;
        const t = await r.text();

        if (r.ok) {
          // 非流式响应也可能直接给 JSON
          let content = "";
          try {
            const doc = JSON.parse(t);
            content = doc?.choices?.[0]?.message?.content || "";
          } catch {
            // 是 SSE，看看有没有 error
          }
          const errMatch = /"code"\s*:\s*(\d+)/.exec(t);
          if (errMatch && /error/i.test(t.slice(0, 200))) {
            ok = false;
            message = "上游返回错误码 " + errMatch[1];
          } else {
            ok = true;
            message = "正常";
          }
        } else {
          ok = false;
          const codeMatch = /"code"\s*:\s*(\d+)/.exec(t);
          const msgMatch = /"msg"\s*:\s*"([^"]{0,80})"/.exec(t);
          if (codeMatch && codeMatch[1] === "14018") {
            message = "积分已用尽";
          } else if (codeMatch) {
            message = "错误码 " + codeMatch[1] + (msgMatch ? "：" + msgMatch[1] : "");
          } else {
            message = "HTTP " + r.status;
          }
        }
      } catch (e) {
        latencyMs = Date.now() - started;
        ok = false;
        message = String(e).includes("timeout") || String(e).includes("abort")
          ? "超时"
          : "网络错误：" + String(e).slice(0, 60);
      }

      // 顺带查一次余额（强制刷新）
      const bal = await fetchBalance(cred, true).catch(() => null);

      console.error(
        "[workbuddy-shim] 测试账号 " + accountId.slice(0, 12) +
        " → " + (ok ? "通过" : "失败") + "（" + message + "）"
      );

      sendJson(res, 200, {
        ok,
        accountId,
        region,
        model,
        latencyMs,
        message,
        credit: bal ? bal.credit : null,
      });
    })().catch((e) => {
      if (!res.headersSent) sendError(res, 500, String(e), "internal");
    });
    return;
  }

  // 切换当前使用的账号（粘性）
  if (req.method === "POST" && (url === "/accounts/switch" || url.startsWith("/accounts/switch?"))) {
    (async () => {
      let body = {};
      try {
        const raw = (await readBody(req)).toString("utf8");
        if (raw.trim() !== "") body = JSON.parse(raw);
      } catch { /* ignore */ }
      const accountId = String(body.accountId || "");
      const region = String(body.region || REGION);
      const files = listVaultFiles(region);
      const hit = files.find((x) => x.accountId === accountId);
      if (!hit) {
        sendError(res, 404, "账号不存在: " + accountId, "not_found");
        return;
      }
      stickyAccountId = accountId;
      cachedCredential = null;   // 强制下次重新解析
      console.error("[workbuddy-shim] 已切换到账号 " + accountId);
      sendJson(res, 200, { ok: true, current: accountId, region });
    })().catch((e) => {
      if (!res.headersSent) sendError(res, 500, String(e), "internal");
    });
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
    // 按账号统计（如果记录里有 accountId）
    const byAccount = {};
    for (const [id, x] of Object.entries(byModel)) {
      const acc = x.accountId || "unknown";
      if (!byAccount[acc]) {
        byAccount[acc] = { accountId: acc, calls: 0, credit: 0 };
      }
      byAccount[acc].calls += x.calls || 0;
      byAccount[acc].credit = Number(
        (byAccount[acc].credit + (x.credit || 0)).toFixed(4)
      );
    }

    // 当前账号信息（从 vault 读，含剩余有效期）
    let currentAccount = null;
    try {
      const files = listVaultFiles(REGION);
      const cur = files.find((f2) => f2.accountId === stickyAccountId) || files[0];
      if (cur) {
        const a = readVaultFile(cur.path);
        if (a) {
          currentAccount = {
            accountId: a.accountId,
            nickname: a.nickname,
            uid: a.uid,
            expiresAtMs: a.expiresAtMs,
            remainDays: a.expiresAtMs > 0
              ? Math.max(0, Math.floor((a.expiresAtMs - Date.now()) / 86400000))
              : null,
          };
        }
      }
    } catch { /* ignore */ }

    sendJson(res, 200, {
      ok: true,
      since: costStats.since,
      region: REGION,
      totalCredit: Number(totalCredit.toFixed(4)),
      totalCalls,
      totalFails,
      currentAccount,
      accountCount: listVaultFiles(REGION).length,
      byAccount: Object.values(byAccount).sort((a, b) => b.credit - a.credit),
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



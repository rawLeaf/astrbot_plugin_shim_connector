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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

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
 * 模型目录 —— WorkBuddy 上游接受的模型 id。
 *
 * 这些是实测可用的（2026-10-28）。上游不提供模型列表接口，
 * 所以这里静态列出；调用 /v1/models 时返回它们，
 * 好让下游（如 AstrBot 插件）能自动注册 provider。
 */
const MODEL_CATALOG = [
  { id: "space-bunny",                 note: "默认，多模态" },
  { id: "deepseek-v4.1-flash",         note: "DeepSeek 快速" },
  { id: "deepseek-v4-pro",             note: "DeepSeek 深度" },
  { id: "minimax-m3.1-flash",          note: "MiniMax 快速" },
  { id: "glm-5.3-flash",               note: "智谱快速" },
  { id: "kimi-k2.6",                   note: "Kimi" },
];


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
  const roots = [
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    "C:\\Program Files",
    "C:\\Program Files (x86)",
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
      // 只认 workbuddy-desktop.info 和带时间戳的备份
      if (!/^workbuddy-desktop(\.[\w-]+)?\.info$/.test(name)) continue;
      files.push(join(dir, name));
    }
  }
  if (files.length === 0) {
    throw new Error("workbuddy: no desktop auth file found. Looked in:\n  " + dirs.join("\n  ") +
      "\n  WorkBuddy must be installed and signed in.");
  }

  // 优先 live 文件，其次按修改时间倒序
  files.sort((a, b) => {
    const la = basename(a) === WORKBUDDY_LIVE_FILENAME ? 0 : 1;
    const lb = basename(b) === WORKBUDDY_LIVE_FILENAME ? 0 : 1;
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
    // 4) 首条不是 system 就补一个空 system，避免上游按身份声明拒绝
    if (obj.messages.length === 0 || obj.messages[0].role !== "system") {
      obj.messages.unshift({ role: "system", content: "" });
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
  sendJson(res, 200, aggregateSse(text, model));
}

const server = createServer((req, res) => {
  const url = req.url ?? "/";

  if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
    sendJson(res, 200, { ok: true, region: REGION, port: PORT });
    return;
  }

  if (!bearerOk(req)) {
    sendError(res, 401, "missing or invalid Authorization bearer", "unauthorized");
    return;
  }

  if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
    sendJson(res, 200, {
      object: "list",
      data: MODEL_CATALOG.map((m) => ({
        id: m.id,
        object: "model",
        created: 0,
        owned_by: "workbuddy",
        note: m.note,
      })),
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

process.on("uncaughtException", (e) => {
  console.error("[workbuddy-shim] uncaught: " + (e && e.stack ? e.stack : e));
});
process.on("unhandledRejection", (e) => {
  console.error("[workbuddy-shim] unhandled: " + (e && e.stack ? e.stack : e));
});

server.listen(PORT, HOST, () => {
  console.log("[workbuddy-shim] listening on http://" + HOST + ":" + PORT + "/v1  (region=" + REGION + ")");
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



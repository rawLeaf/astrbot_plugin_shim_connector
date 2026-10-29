#!/usr/bin/env node
/**
 * qoder-shim —— 把 Qoder（国内版 + 国际版）模型接到 OpenAI 兼容接口上
 *
 * 凭据：Qoder 桌面端的 auth.v1.dat（Chromium OSCrypt，DPAPI 加密主密钥），
 *       本文件复用 dsh-connect-qoder 插件同款的解密流程。
 * 上游：POST {baseUrl}algo/api/v2/service/pro/sse/agent_chat_generation?...
 *       鉴权是 COSY 签名（RSA 包 AES 密钥 + 自定义 base64 + MD5 转录）。
 *
 * 模型命名：qoder-cn/<key> 或 qoder/<key>，两区共用一个端口。
 *
 * 用法：
 *   QODER_SHIM_PORT=8789 node qoder-shim.mjs
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";

const PORT = Number(process.env.QODER_SHIM_PORT ?? 8789);
const TOKEN = process.env.QODER_SHIM_TOKEN ?? "sk-qoder-local";
const HOST = "127.0.0.1";

/** APPDATA 可能为空（服务账户、精简环境），用 homedir 兜底。 */
function roamingDir(sub) {
  const base = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(base, sub);
}

const REGIONS = {
  "qoder-cn": {
    dir: process.env.QODER_REGION_DIR_CN || roamingDir("com.qodercn.app.stable"),
    baseUrl: "https://gateway.qoder.com.cn/",
  },
  qoder: {
    dir: process.env.QODER_REGION_DIR_GLOBAL || roamingDir("com.qoder.app.stable"),
    baseUrl: "https://api3.qoder.sh/",
  },
};

// ── DPAPI 解包 ────────────────────────────────────────────────────────
const PS = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class QQSH{[StructLayout(LayoutKind.Sequential)]public struct B{public int cbData;public IntPtr pbData;}
[DllImport("Crypt32.dll",SetLastError=true)]static extern bool CryptUnprotectData(ref B i,IntPtr d,IntPtr e,IntPtr r,IntPtr p,int f,ref B o);
[DllImport("Kernel32.dll")]static extern IntPtr LocalFree(IntPtr h);
public static byte[] U(byte[] data){B i=new B();i.cbData=data.Length;i.pbData=Marshal.AllocHGlobal(data.Length);Marshal.Copy(data,0,i.pbData,data.Length);B o=new B();
try{if(!CryptUnprotectData(ref i,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,0,ref o))throw new Exception("DPAPI "+Marshal.GetLastWin32Error());
byte[] r=new byte[o.cbData];Marshal.Copy(o.pbData,r,0,o.cbData);return r;}finally{Marshal.FreeHGlobal(i.pbData);if(o.pbData!=IntPtr.Zero)LocalFree(o.pbData);}}}
'@
$json=Get-Content (Join-Path $env:QD_APP_DIR 'Local State') -Raw|ConvertFrom-Json
$raw=[Convert]::FromBase64String($json.os_crypt.encrypted_key)
[Convert]::ToBase64String([QQSH]::U($raw[5..($raw.Length-1)]))`;

const credCache = new Map();

function loadCredential(regionId) {
  if (credCache.has(regionId)) return credCache.get(regionId);
  const r = REGIONS[regionId];
  const ps = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", PS], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, QD_APP_DIR: r.dir },
  });
  const keyB64 = (ps.stdout || "").trim();
  if (keyB64.length === 0) throw new Error(
      "无法解出 Qoder OSCrypt 主密钥: " + regionId +
      "\n  查找目录: " + r.dir +
      "\n  该目录存在: " + existsSync(r.dir)
    );
  const key = Buffer.from(keyB64, "base64");
  const blob = readFileSync(r.dir + "\\auth.v1.dat");
  const b = blob.subarray(3);
  const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(b.length - 16));
  const doc = JSON.parse(
    Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString("utf8"),
  );
  const machineId = readFileSync(r.dir + "\\auth.machine-id", "utf8").trim();
  const cred = {
    userID: doc.user.id,
    token: doc.token,
    name: doc.user.name ?? "",
    email: doc.user.email ?? "",
    machineID: machineId,
  };
  credCache.set(regionId, cred);
  return cred;
}

// ── COSY 签名 ────────────────────────────────────────────────────────
const RSA_PUB = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
const COSY_VERSION = "1.1.38";
const DATA_POLICY = "disagree";
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const ENCODE_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[i] = i;
  for (let i = 0; i < 64; i++) t[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
  t["=".charCodeAt(0)] = "$".charCodeAt(0);
  return t;
})();

function encodeBody(plaintext) {
  const std = plaintext.toString("base64");
  const n = std.length;
  const third = Math.floor(n / 3);
  const out = Buffer.allocUnsafe(n);
  const enc = (code) => ENCODE_TABLE[code] ?? code;
  let dst = 0;
  for (let i = n - third; i < n; i++) out[dst++] = enc(std.charCodeAt(i));
  for (let i = third; i < n - third; i++) out[dst++] = enc(std.charCodeAt(i));
  for (let i = 0; i < third; i++) out[dst++] = enc(std.charCodeAt(i));
  return out;
}

function aesEncryptCBCBase64(plaintext, keyString) {
  const key = Buffer.from(keyString);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, key);
  return cipher.update(plaintext, "utf8", "base64") + cipher.final("base64");
}

function signaturePath(url) {
  let p = new URL(url).pathname;
  if (p.startsWith("/algo")) p = p.slice(5);
  return p;
}

function authHeaders(body, url, credential) {
  const aesKey = randomUUID().replace(/-/g, "").slice(0, 16);
  const infoB64 = aesEncryptCBCBase64(
    JSON.stringify({
      uid: credential.userID,
      security_oauth_token: credential.token,
      name: credential.name ?? "",
      aid: "",
      email: credential.email ?? "",
    }),
    aesKey,
  );
  const cosyKey = crypto.publicEncrypt(
    { key: RSA_PUB, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(aesKey),
  ).toString("base64");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payloadB64 = Buffer.from(
    JSON.stringify({
      version: "v1",
      requestId: randomUUID(),
      info: infoB64,
      cosyVersion: COSY_VERSION,
      ideVersion: "",
    }),
  ).toString("base64");
  const path = signaturePath(url);
  const bodyBytes = body ?? Buffer.alloc(0);
  const sig = crypto
    .createHash("md5")
    .update(payloadB64).update("\n").update(cosyKey).update("\n")
    .update(timestamp).update("\n").update(bodyBytes).update("\n").update(path)
    .digest("hex");
  return {
    Authorization: "Bearer COSY." + payloadB64 + "." + sig,
    "Cosy-Key": cosyKey,
    "Cosy-User": credential.userID,
    "Cosy-Date": timestamp,
    "Cosy-Version": COSY_VERSION,
    "Cosy-Machineid": credential.machineID,
    "Cosy-Machinetoken": credential.machineID,
    "Cosy-Machinetype": "5",
    "Cosy-Machineos": "x86_64_windows",
    "Cosy-Clienttype": "5",
    "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": crypto.createHash("md5").update(bodyBytes).digest("hex"),
    "Cosy-Bodylength": String(bodyBytes.length),
    "Cosy-Sigpath": path,
    "Cosy-Data-Policy": DATA_POLICY,
    "Cosy-Organization-Id": "",
    "Cosy-Organization-Tags": "",
    "Login-Version": "v2",
    "X-Request-Id": randomUUID(),
  };
}

// ── 模型目录 ──────────────────────────────────────────────────────────
const catalogCache = new Map();

async function fetchCatalog(regionId) {
  if (catalogCache.has(regionId)) return catalogCache.get(regionId);
  const region = REGIONS[regionId];
  const cred = loadCredential(regionId);
  const url = region.baseUrl + "algo/api/v2/model/list?Encode=1";
  const body = Buffer.alloc(0);
  const res = await fetch(url, {
    method: "GET",
    headers: { ...authHeaders(body, url, cred), Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error("model list HTTP " + res.status);
  const doc = await res.json();
  const list = Array.isArray(doc.chat) ? doc.chat : [];
  const models = list.map((m) => ({
    key: m.key,
    name: m.display_name ?? m.key,
    reasoning: m.is_reasoning === true,
    vl: m.is_vl === true,
    priceFactor: m.price_factor ?? 0,
    maxInputTokens: m.max_input_tokens ?? 200000,
  }));
  catalogCache.set(regionId, models);
  return models;
}

// ── 聊天请求 ──────────────────────────────────────────────────────────
function buildQoderBody(input, modelKey) {
  const recordId = randomUUID();
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastText = typeof lastUser?.content === "string" ? lastUser.content : "";
  const parameters = {};
  if (Number.isSafeInteger(input.max_tokens) && input.max_tokens > 0) parameters.max_tokens = input.max_tokens;
  // 部分模型「始终思考」，显式发 enable_thinking:false 会被拒（1210）。
  // 因此只有调用方明确要求时才带这个字段。
  if (input.enable_thinking === true) {
    parameters.enable_thinking = true;
    if (typeof input.reasoning_effort === "string" && input.reasoning_effort !== "") {
      parameters.reasoning_effort = input.reasoning_effort;
    }
  } else if (input.enable_thinking === false) {
    parameters.enable_thinking = false;
  }
  return {
    request_id: randomUUID(),
    request_set_id: recordId,
    chat_record_id: recordId,
    session_id: "dsh-" + randomUUID(),
    stream: true,
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: "",
    image_urls: null,
    aliyun_user_type: "",
    system: "",
    messages,
    tools: input.tools ?? [],
    parameters,
    chat_context: {
      chatPrompt: "",
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: modelKey, is_reasoning: false },
        originalContent: lastText,
      },
      features: [],
      text: lastText,
    },
    model_config: { key: modelKey, source: "system", is_reasoning: false },
    business: {
      product: "cli",
      version: "1.0.0",
      type: "agent",
      stage: "start",
      id: randomUUID(),
      name: lastText.slice(0, 30),
      begin_at: Date.now(),
    },
  };
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

/** 上游 SSE 帧 → OpenAI chunk */
function framesToOpenAI(text) {
  const out = [];
  let failure = undefined;
  let streamDone = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") { if (payload === "[DONE]") streamDone = true; continue; }
    let chunk;
    try { chunk = JSON.parse(payload); } catch {
      // 非 JSON 帧（多为终止标记）——不是错误，跳过
      continue;
    }
    // 外层信封：{ headers, body: "<json string>", statusCode }
    if (chunk && typeof chunk === "object" && typeof chunk.body === "string") {
      const inner = chunk.body;
      if (inner === "null" || inner === "") continue;
      if (inner === "[DONE]") { streamDone = true; continue; }
      try { chunk = JSON.parse(inner); } catch {
        if (inner.trim() === "[DONE]" || inner.trim() === "") { streamDone = true; continue; }
        // 上游的错误帧把 JSON 又转义了一层（"{\"code\":...}"），
        // 直接 parse 会失败。先剥掉一层转义再试。
        let relaxed = inner;
        for (let i = 0; i < 2; i++) {
          try { relaxed = JSON.parse(relaxed); break; } catch {
            relaxed = relaxed.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
          }
        }
        if (typeof relaxed === "string") {
          try { relaxed = JSON.parse(relaxed); } catch { relaxed = inner; }
        }
        if (relaxed && typeof relaxed === "object" && relaxed.code !== undefined) {
          chunk = relaxed;
        } else {
          failure = failure ?? new Error("上游返回无法解析的帧: " + inner.slice(0, 160));
          continue;
        }
      }
    } else if (chunk && typeof chunk === "object" && chunk.body && typeof chunk.body === "object") {
      chunk = chunk.body;
    }
    if (chunk === null || chunk === undefined) continue;
    // 错误信封：{ code, message, details }
    if (chunk.code !== undefined && chunk.choices === undefined) {
      const details = typeof chunk.details === "string" ? chunk.details : "";
      const inner = (() => { try { return JSON.parse(details); } catch { return null; } })();
      // 上游把真实错误再套一层 JSON 字符串
      const deepest = (() => {
        const m = inner?.error?.message;
        if (typeof m !== "string") return null;
        try { return JSON.parse(m); } catch { return null; }
      })();
      const msg = deepest?.message ?? inner?.error?.message ?? chunk.message ?? chunk.code;
      const isQueue = deepest?.code === 10605 || deepest?.isQueued === true || /queue|RESOURCE_LIMIT|排队/i.test(String(msg));
      failure = failure ?? (isQueue
        ? Object.assign(new Error("模型排队中: " + String(msg)), { qoderQueue: true, retryAfterSeconds: deepest?.retryAfterSeconds ?? 30 })
        : new Error(String(msg)));
      continue;
    }
    if (chunk.choices !== undefined || (chunk.usage && chunk.usage !== null)) out.push(chunk);
  }
  if (failure !== undefined) throw failure;
  return out;
}

function aggregate(frames, model) {
  let content = "";
  let sawChunk = false;
  const toolCalls = new Map();
  let finishReason = "stop";
  let usage = null;
  let id = "";
  for (const chunk of frames) {
    id = chunk.id || id;
    if (chunk.usage) usage = chunk.usage;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) { sawChunk = true; continue; }
    const delta = choice.delta || {};
    if (typeof delta.content === "string") content += delta.content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCalls.has(idx)) toolCalls.set(idx, { id: tc.id || "", type: "function", function: { name: "", arguments: "" } });
        const slot = toolCalls.get(idx);
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  const message = { role: "assistant", content: content || null };
  if (toolCalls.size > 0) {
    message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    if (finishReason === "stop") finishReason = "tool_calls";
  }
  const out = {
    id: id || "chatcmpl-" + randomUUID(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
  if (usage) out.usage = usage;
  if (!sawChunk && !content && toolCalls.size === 0) {
    // 上游一个 chunk 都没给：如实报告空回复，而不是假装成功
    const err = new Error("上游没有返回任何内容帧");
    err.qoderEmpty = true;
    throw err;
  }
  return out;
}

/**
 * 在 SSE 文本里找上游的错误信封。
 * 上游把错误放在 { headers, body: "<json>" } 信封里，body 可能是
 * { code: 403, message: "<嵌套 json>" }，而错误码 10605 表示排队。
 */
function findUpstreamError(text) {
  // 帧里的 JSON key 常被转义成 \"code\"，所以不能只匹配 "code"
  if (!/\\?"code\\?"\s*:/.test(text) && !/"code"\s*:/.test(text)) return null;
  let message = text.slice(0, 400);
  try {
    const frames = framesToOpenAI(text);
    // framesToOpenAI 遇到错误会 throw；到这里说明没 throw
    void frames;
  } catch (e) {
    message = String(e?.message ?? message);
  }
  const queued = /排队|queue|RESOURCE_LIMIT|10605/i.test(message);
  return { message, queued };
}

/**
 * 读上游 SSE，直到出现错误帧或流结束。
 * 上游在 403 排队时不会关闭流（连接会一直挂着），所以不能等 text()。
 * 这里只读到"判定所需"为止：一旦识别出错误帧立刻返回。
 */
async function readUntilDecided(upstream, maxBytes = 4 * 1024 * 1024) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let total = 0;
  while (total < maxBytes) {
    const r = await reader.read();
    if (r.done) break;
    const chunk = Buffer.from(r.value);
    total += chunk.length;
    buf += decoder.decode(chunk, { stream: true });
    const err = findUpstreamError(buf);
    if (err !== null) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return { text: buf, error: err };
    }
    // 已经拿到完整的回答（有 choices 且有内容），就收工
    if (buf.includes("[DONE]")) break;
  }
  try { await reader.cancel(); } catch { /* ignore */ }
  return { text: buf, error: null };
}

function bearerOk(req) {
  const h = req.headers.authorization;
  if (typeof h !== "string") return false;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m !== null && m[1] === TOKEN;
}

/** 从模型名解析区域与 key：qoder-cn/xxx 或 qoder/xxx */
function parseModel(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  const slash = s.indexOf("/");
  if (slash > 0) {
    const region = s.slice(0, slash);
    if (REGIONS[region]) return { region, key: s.slice(slash + 1) };
  }
  return { region: "qoder-cn", key: s || "auto" };
}

async function handleChat(req, res) {
  const raw = (await readBody(req)).toString("utf8");
  let input;
  try { input = JSON.parse(raw); } catch { sendError(res, 400, "invalid JSON", "client"); return; }

  const { region, key } = parseModel(input.model);
  const streamDown = input.stream === true;

  let cred;
  try { cred = loadCredential(region); } catch (error) {
    sendError(res, 401, String(error), "not_signed_in");
    return;
  }

  const url = REGIONS[region].baseUrl +
    "algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
  const body = encodeBody(Buffer.from(JSON.stringify(buildQoderBody(input, key))));
  const headers = {
    ...authHeaders(body, url, cred),
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
    "Accept-Encoding": "identity",
    "X-Model-Key": key,
    "X-Model-Source": "system",
  };

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
    });
  } catch (error) {
    sendError(res, 502, "transport error: " + String(error), "server");
    return;
  }

  if (!upstream.ok) {
    const t = (await upstream.text()).slice(0, 600);
    sendError(res, upstream.status === 401 ? 401 : 502, t || "upstream " + upstream.status, "upstream");
    return;
  }
  // 上游用 200 + 错误帧表达排队，这里先探一次再决定
  // （真正的判定在聚合阶段，这里只让 200 帧流过去）

  if (streamDown) {
    const reader = upstream.body.getReader();
    // 上游用 200 + 错误帧表达排队/拒绝（例如 10605 排队）。
    // 必须逐帧判定：只要第一帧是错误，就立刻转成 HTTP 错误，
    // 否则客户端会一直等 [DONE] 而挂死。
    let first = null;
    let earlyError = null;
    try {
      const r = await reader.read();
      if (!r.done) {
        first = Buffer.from(r.value);
        earlyError = findUpstreamError(first.toString("utf8"));
      }
    } catch { /* ignore */ }
    if (earlyError !== null) {
      sendError(res, earlyError.queued ? 429 : 502, earlyError.message, earlyError.queued ? "model_queue" : "upstream");
      try { await reader.cancel(); } catch { /* ignore */ }
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    if (first !== null) res.write(first);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } catch { /* client closed */ }
    res.end();
    return;
  }

  const decided = await readUntilDecided(upstream);
  if (decided.error !== null) {
    sendError(
      res,
      decided.error.queued ? 429 : 502,
      decided.error.message,
      decided.error.queued ? "model_queue" : "upstream",
    );
    return;
  }
  try {
    sendJson(res, 200, aggregate(framesToOpenAI(decided.text), input.model ?? key));
  } catch (error) {
    const queued = error?.qoderQueue === true;
    sendError(
      res,
      queued ? 429 : 502,
      String(error?.message ?? error),
      queued ? "model_queue" : "upstream",
    );
  }
}

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
    sendJson(res, 200, { ok: true, provider: "qoder", port: PORT });
    return;
  }
  if (!bearerOk(req)) { sendError(res, 401, "missing or invalid Authorization bearer", "unauthorized"); return; }

  if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
    (async () => {
      try {
        const data = [];
        for (const region of Object.keys(REGIONS)) {
          for (const m of await fetchCatalog(region)) {
            data.push({
              id: region + "/" + m.key,
              object: "model",
              created: 0,
              owned_by: region,
              // 积分倍率（上游 price_factor），供客户端评估成本
              price_factor: m.priceFactor ?? 0,
              is_reasoning: m.reasoning === true,
              is_vl: m.vl === true,
              max_input_tokens: m.maxInputTokens ?? null,
              // 上游真实显示名（如 "DeepSeek-V4-Flash"），key 只是内部代号
              display_name: m.name ?? m.key,
            });
          }
        }
        sendJson(res, 200, { object: "list", data });
      } catch (error) {
        sendError(res, 502, String(error), "upstream");
      }
    })();
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

process.on("uncaughtException", (e) => console.error("[qoder-shim] uncaught: " + (e?.stack ?? e)));
process.on("unhandledRejection", (e) => console.error("[qoder-shim] unhandled: " + (e?.stack ?? e)));

server.listen(PORT, HOST, () => {
  console.log("[qoder-shim] listening on http://" + HOST + ":" + PORT + "/v1");
});

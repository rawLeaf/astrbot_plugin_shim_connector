#!/usr/bin/env node
/**
 * trae-shim —— 把 Trae（国内版）模型接到 OpenAI 兼容接口上，给 AstrBot 用
 *
 * 凭据来源：一个 JSON 文件（{"credentials":{"0":{"accessToken","userId"}}}），用 TRAE_AUTH_FILE 指向
 * 上游协议：POST https://trae-api-cn.mchost.guru/api/ide/v2/llm_raw_chat
 *   - Authorization: Cloud-IDE-JWT <token> + X-Ide-Token
 *   - body 需要 config_name（= 模型名）与 pass_back_reasoning
 *   - 强制 stream: true
 *
 * 用法：
 *   WB_SHIM_PORT=8788 node trae-shim.mjs
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.TRAE_SHIM_PORT ?? 8788);
const TOKEN = process.env.TRAE_SHIM_TOKEN ?? "sk-trae-local";
const HOST = "127.0.0.1";
const AUTH_FILE = process.env.TRAE_AUTH_FILE || "trae-auth.json";
const CHAT_BASE = "https://trae-api-cn.mchost.guru";
const CHAT_PATH = "/api/agent/v3/llm_utils_chat";
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
  try {
    const doc = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
    const list = doc.credentials ?? {};
    const key = Object.keys(list)[0];
    if (key === undefined) return;
    doc.credentials[key] = cred;
    writeFileSync(AUTH_FILE, JSON.stringify(doc, null, 2), "utf8");
    console.error("[trae-shim] 已把新 token 写回 " + AUTH_FILE);
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

function loadCredential() {
  const doc = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
  const list = doc.credentials ?? {};
  const first = list[Object.keys(list)[0]];
  if (!first || typeof first.accessToken !== "string") {
    throw new Error("Trae 凭据为空或格式不符: " + AUTH_FILE);
  }
  return first;
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
  const shaped = messages.map((m) => {
    if (RAW) return m;
    const out = { ...m, content: normalizeContent(m.content) };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      out.tool_calls = normalizeToolCalls(m.tool_calls);
    } else {
      delete out.tool_calls;
    }
    return out;
  });
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

  const message = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
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

  let upstream;
  try {
    upstream = await fetch(CHAT_BASE + CHAT_PATH, {
      method: "POST",
      headers: buildHeaders(cred),
      body,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
    });
  } catch (error) {
    sendError(res, 502, "transport error: " + String(error), "server");
    return;
  }

  if (!upstream.ok) {
    const text = (await upstream.text()).slice(0, 800);
    sendError(res, upstream.status === 401 ? 401 : 502, text || "upstream " + upstream.status, "upstream");
    return;
  }

  if (streamDown) {
    // 以前是把 Trae 原生 SSE 原样转发出去，但那不是 OpenAI 的
    // choices[].delta 协议（是 event:output + data:{response}），
    // OpenAI SDK 解析会拿到空内容。这里改成：聚合完再自己重发标准 SSE。
    const text = await upstream.text();
    const out = aggregateSse(text, model);
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
  sendJson(res, 200, aggregateSse(text, model));
}

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
    sendJson(res, 200, { ok: true, provider: "trae", port: PORT });
    return;
  }
  if (!bearerOk(req)) { sendError(res, 401, "missing or invalid Authorization bearer", "unauthorized"); return; }
  if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
    sendJson(res, 200, {
      object: "list",
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

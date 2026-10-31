#!/usr/bin/env node
/**
 * llm-pool-shim —— 通用 LLM 轮换池，给 self_learning 这类"只能填一个 provider"的地方用
 *
 * 为什么需要它：
 *   astrbot_plugin_self_learning 有三个角色（filter/refine/reinforce），
 *   每个只绑一个 provider（framework_llm_adapter.py:96-181），
 *   调用失败只 catch 后 return None（:373-376），没有跨 provider 回退。
 *   之前 filter 配了 workbuddy_shim/deepseek-v4.1-flash，一 429 整个自学习就瘫。
 *
 *   本 shim 提供一个 OpenAI 兼容端点，内部在多个上游之间轮换 + 失败转移，
 *   上层只要填一个 provider id 就行。
 *
 * 用法：
 *   LLM_POOL_PORT=8792 LLM_POOL_TARGETS="id1,id2,id3" node llm-pool-shim.mjs
 */

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";

const PORT = Number(process.env.LLM_POOL_PORT ?? 8792);
const TOKEN = process.env.LLM_POOL_TOKEN ?? "sk-llm-pool-local";
const HOST = "127.0.0.1";
const CONFIG_FILE = process.env.ASTRBOT_CONFIG || "cmd_config.json";

// 启动时若配置文件不存在，明确告知而不是静默失败
if (!existsSync(CONFIG_FILE)) {
  console.error(
    "[llm-pool-shim] 找不到 AstrBot 配置: " + CONFIG_FILE + "\n" +
    "  请用 ASTRBOT_CONFIG 环境变量指向你的 cmd_config.json"
  );
  process.exit(2);
}

/**
 * 轮换目标。默认值按"自学习任务需要能稳定输出结构化文本"挑选：
 * 都是 chat 模型、都支持 tool_use、都不是限额状态。
 */
const TARGETS_ENV = process.env.LLM_POOL_TARGETS ?? "";
const TARGET_IDS =
  TARGETS_ENV.trim() !== ""
    ? TARGETS_ENV.split(",").map((s) => s.trim()).filter(Boolean)
    : [
        "trae_shim/DeepSeek-V4-Flash-Official",
        "trae_shim/Doubao-Seed-Code",
        "workbuddy_shim/space-bunny",
        "workbuddy_intl/minimax-m3.1-flash",
        "intern_kimi",
        "trae_shim/mimo-v2.6-flash",
        "workbuddy_shim/minimax-m3.1-flash",
        "trae_shim/qwen3.8-flash",
        "trae_shim/minimax-m3.1-flash",
        "trae_shim/glm-5.3-flash",
      ];

function loadTargets() {
  const raw = readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, "");
  const doc = JSON.parse(raw);
  const providers = doc.provider ?? [];
  const sources = doc.provider_sources ?? [];
  const bySource = new Map(sources.map((s) => [s.id, s]));

  const out = [];
  for (const id of TARGET_IDS) {
    const p = providers.find((x) => x.id === id);
    if (!p) {
      console.error("[llm-pool] 跳过（provider 不存在）: " + id);
      continue;
    }
    const s = bySource.get(p.provider_source_id);
    if (!s || !s.api_base) {
      console.error("[llm-pool] 跳过（无 api_base）: " + id);
      continue;
    }
    const keys = Array.isArray(s.key) ? s.key : [];
    out.push({
      id,
      base: String(s.api_base).replace(/\/$/, ""),
      model: p.model ?? id,
      key: keys[0] ?? "",
      cooldownUntil: 0,
      okCount: 0,
      failCount: 0,
    });
  }
  return out;
}

const targets = loadTargets();
console.error(
  "[llm-pool] 轮换目标 " + targets.length + " 个: " + targets.map((t) => t.id).join(", "),
);

let cursor = 0;
const COOLDOWN_RATE_LIMIT = 60_000;
const COOLDOWN_OTHER = 30_000;

const LIMIT = 64 * 1024 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > LIMIT) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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

function bearerOk(req) {
  const h = req.headers.authorization;
  if (typeof h !== "string") return false;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m !== null && m[1] === TOKEN;
}

function usable(payload) {
  try {
    const ch = payload?.choices?.[0];
    if (!ch) return false;
    const c = ch.message?.content;
    const hasText = typeof c === "string" && c.trim() !== "";
    const hasTool = Array.isArray(ch.message?.tool_calls) && ch.message.tool_calls.length > 0;
    return hasText || hasTool;
  } catch {
    return false;
  }
}

async function tryOne(t, bodyObj, signal) {
  const upstream = await fetch(t.base + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + t.key,
    },
    body: JSON.stringify({ ...bodyObj, model: t.model }),
    signal,
  });
  if (!upstream.ok) {
    const text = (await upstream.text()).slice(0, 400);
    return { ok: false, rateLimited: upstream.status === 429, status: upstream.status, detail: text };
  }
  const text = await upstream.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, rateLimited: false, status: 200, detail: "bad json" };
  }
  if (!usable(payload)) {
    return { ok: false, rateLimited: false, status: 200, detail: "empty content" };
  }
  return { ok: true, payload };
}

async function handleChat(req, res) {
  const raw = (await readBody(req)).toString("utf8");
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    sendError(res, 400, "invalid JSON", "client");
    return;
  }

  // 保留 stream 语义：上层如果要流式，这里也照做（聚合后重发标准 SSE）
  const wantStream = input.stream === true;
  const bodyObj = { ...input, stream: false };
  delete bodyObj.stream;

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  const n = targets.length;
  if (n === 0) {
    sendError(res, 503, "no llm target available", "no_target");
    return;
  }

  const now = Date.now();
  const order = [];
  for (let i = 0; i < n; i += 1) order.push(targets[(cursor + i) % n]);

  const failures = [];
  for (const t of order) {
    if (t.cooldownUntil > now) {
      failures.push(t.id + ": cooldown");
      continue;
    }
    const t0 = Date.now();
    let r;
    try {
      r = await tryOne(t, bodyObj, AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]));
    } catch (error) {
      r = { ok: false, rateLimited: false, status: 0, detail: "transport: " + String(error) };
    }
    const ms = Date.now() - t0;

    if (r.ok) {
      t.okCount += 1;
      t.cooldownUntil = 0;
      cursor = (targets.indexOf(t) + 1) % n;
      const out = r.payload;
      out._llm_target = t.id;
      console.error("[llm-pool] " + t.id + " OK " + ms + "ms");

      if (!wantStream) {
        sendJson(res, 200, out);
        return;
      }
      // 流式：把聚合结果拆成标准 SSE 帧
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const frame = (o) => "data: " + JSON.stringify(o) + "\n\n";
      const base = { id: out.id, object: "chat.completion.chunk", created: out.created, model: out.model };
      const msg = out.choices[0].message;
      if (typeof msg.reasoning_content === "string" && msg.reasoning_content !== "") {
        res.write(frame({ ...base, choices: [{ index: 0, delta: { reasoning_content: msg.reasoning_content }, finish_reason: null }] }));
      }
      if (typeof msg.content === "string" && msg.content !== "") {
        res.write(frame({ ...base, choices: [{ index: 0, delta: { content: msg.content }, finish_reason: null }] }));
      }
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        res.write(frame({ ...base, choices: [{ index: 0, delta: { tool_calls: msg.tool_calls.map((tc, i) => ({ index: i, id: tc.id, type: "function", function: tc.function })) }, finish_reason: null }] }));
      }
      res.write(frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: out.choices[0].finish_reason }] }));
      if (out.usage) res.write(frame({ ...base, choices: [], usage: out.usage }));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    t.failCount += 1;
    t.cooldownUntil = Date.now() + (r.rateLimited ? COOLDOWN_RATE_LIMIT : COOLDOWN_OTHER);
    failures.push(t.id + " HTTP" + r.status + " " + String(r.detail).slice(0, 100));
    console.error("[llm-pool] " + t.id + " FAIL " + ms + "ms: " + String(r.detail).slice(0, 150));
  }

  sendError(res, 503, "all llm targets failed: " + failures.join(" | "), "all_failed");
}

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
    sendJson(res, 200, {
      ok: true,
      provider: "llm-pool",
      port: PORT,
      targets: targets.map((t) => ({
        id: t.id,
        cooling: t.cooldownUntil > Date.now(),
        ok: t.okCount,
        fail: t.failCount,
      })),
    });
    return;
  }
  if (!bearerOk(req)) {
    sendError(res, 401, "missing or invalid Authorization bearer", "unauthorized");
    return;
  }
  if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
    sendJson(res, 200, {
      object: "list",
      data: [{ id: "llm-pool-auto", object: "model", created: 0, owned_by: "llm-pool" }],
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

process.on("uncaughtException", (e) => console.error("[llm-pool] uncaught: " + (e?.stack ?? e)));
process.on("unhandledRejection", (e) => console.error("[llm-pool] unhandled: " + (e?.stack ?? e)));

server.listen(PORT, HOST, () => {
  console.log("[llm-pool] listening on http://" + HOST + ":" + PORT + "/v1");
});

/*
 * LICENSE-NOTICE
 *
 * 本文件为原始实现（轮换池），未移植第三方代码。
 * 依赖 AstrBot 自身的 provider 配置结构。
 *
 * MIT License — 同项目根目录 LICENSE。
 */

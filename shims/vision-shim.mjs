#!/usr/bin/env node
/**
 * vision-shim —— 视觉模型轮换器，给 AstrBot 的图片描述用
 *
 * 为什么需要它：
 *   AstrBot 的 default_image_caption_provider_id 只接受**一个** provider ID，
 *   _request_img_caption() 里没有任何 fallback（astr_main_agent.py:757-785）。
 *   而且视觉在 5 个地方被用到（核心图片描述、chat_plus 群聊/私聊、meme 语义/自动收集），
 *   全部各自按 ID 取 provider。改核心只能覆盖 1 个，改插件要动 2 个代码库。
 *
 *   所以在最底下加一层：所有视觉配置都指向 vision_rotator/vision-auto，
 *   由本 shim 在这些上游之间轮换 + 失败自动换下一个。
 *
 * 用法：
 *   VISION_SHIM_PORT=8791 node vision-shim.mjs
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.VISION_SHIM_PORT ?? 8791);
const TOKEN = process.env.VISION_SHIM_TOKEN ?? "sk-vision-local";
const HOST = "127.0.0.1";
const CONFIG_FILE = process.env.ASTRBOT_CONFIG ?? "D:\\4game\\ai\\robot\\core\\data\\cmd_config.json";

const VIRTUAL_MODEL = "vision-auto";

/**
 * 参与轮换的视觉模型。providerId 用来从 cmd_config.json 里取 api_base 和 key，
 * 不把密钥写进本文件。
 *
 * 2026-10-28 实测（纯蓝 64x64 PNG）：
 *   zhipu_vision/glm-4v-flash          573ms  OK
 *   intern_qwen_vision/qwen3.8-27b     688ms  OK
 *   workbuddy_shim/minimax-m3.1-flash 2141ms  OK
 *   workbuddy_intl/minimax-m3.1-flash 1956ms  OK
 *   qoder_shim/qoder-cn/gfmodel       3873ms  OK（时好时坏）
 *   workbuddy 的两个 deepseek-v4.1-flash 都是 429 soft_rate，暂时排除
 */
const TARGET_IDS = [
  "zhipu_vision",
  "intern_qwen_vision",
  "workbuddy_shim/minimax-m3.1-flash",
  "workbuddy_intl/minimax-m3.1-flash",
  "qoder_shim/qoder-cn/gfmodel",
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
    if (!p) continue;
    const s = bySource.get(p.provider_source_id);
    if (!s || !s.api_base) continue;
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

let targets = loadTargets();
console.error(
  "[vision-shim] 轮换目标 " + targets.length + " 个: " + targets.map((t) => t.id).join(", "),
);

/** 轮换游标：每次成功就往后挪一格，实现"换着使用" */
let cursor = 0;

/** 失败后冷却多久再参与轮换 */
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

/** 上游返回是否算"这个目标能用" */
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

/** 依次尝试：从游标开始，跳过冷却中的，失败换下一个 */
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
    return { ok: false, rateLimited: false, status: 200, detail: "bad json: " + text.slice(0, 200) };
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

  // 客户端传来的 model 忽略，统一按轮换走；但保留其他字段（messages/图片/tools 等）
  const bodyObj = { ...input, model: VIRTUAL_MODEL, stream: false };
  delete bodyObj.stream;

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  const n = targets.length;
  if (n === 0) {
    sendError(res, 503, "no vision target available", "no_target");
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
      r = await tryOne(
        t,
        bodyObj,
        AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
      );
    } catch (error) {
      r = { ok: false, rateLimited: false, status: 0, detail: "transport: " + String(error) };
    }
    const ms = Date.now() - t0;

    if (r.ok) {
      t.okCount += 1;
      t.cooldownUntil = 0;
      // 成功后游标挪到它的下一个，实现轮换
      cursor = (targets.indexOf(t) + 1) % n;
      const out = r.payload;
      out.model = VIRTUAL_MODEL;
      out._vision_target = t.id;
      console.error("[vision-shim] " + t.id + " OK " + ms + "ms");
      sendJson(res, 200, out);
      return;
    }

    t.failCount += 1;
    t.cooldownUntil = Date.now() + (r.rateLimited ? COOLDOWN_RATE_LIMIT : COOLDOWN_OTHER);
    failures.push(t.id + " HTTP" + r.status + " " + String(r.detail).slice(0, 120));
    console.error("[vision-shim] " + t.id + " FAIL " + ms + "ms: " + String(r.detail).slice(0, 160));
  }

  sendError(
    res,
    503,
    "all vision targets failed: " + failures.join(" | "),
    "all_failed",
  );
}

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
    sendJson(res, 200, {
      ok: true,
      provider: "vision",
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
      data: [{ id: VIRTUAL_MODEL, object: "model", created: 0, owned_by: "vision-rotator" }],
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

process.on("uncaughtException", (e) => console.error("[vision-shim] uncaught: " + (e?.stack ?? e)));
process.on("unhandledRejection", (e) => console.error("[vision-shim] unhandled: " + (e?.stack ?? e)));

server.listen(PORT, HOST, () => {
  console.log("[vision-shim] listening on http://" + HOST + ":" + PORT + "/v1");
});

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
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// ── 耗费统计 ────────────────────────────────────────────────
//
// 累计每个模型的调用次数、token 用量、以及上游返回的成本字段（若有）。
// 落盘到 .llm-pool-cost.json，供 /cost 查询。

const COST_FILE = process.env.LLM_POOL_COST_FILE ||
  join(fileURLToPath(new URL(".", import.meta.url)), ".llm-pool-cost.json");

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
    console.error("[LLM_POOL-shim] 写耗费统计失败: " + String(e));
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
/** 内置默认轮换顺序（按"能稳定输出结构化文本"排的）。 */
const DEFAULT_TARGET_IDS = [
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

/**
 * 轮换策略：
 *   "priority" —— 按列表顺序，优先用靠前的；前面的挂了/冷却才用后面的（默认）
 *   "roundrobin" —— 依次轮换，均摊负载
 */
const STRATEGY = (process.env.LLM_POOL_STRATEGY ?? "priority").trim().toLowerCase();

/** 优先级模式下的失败降级阈值：连续失败几次就跳到下一个。 */
const FAIL_THRESHOLD = Number(process.env.LLM_POOL_FAIL_THRESHOLD ?? 2) || 2;

const TARGETS_ENV = process.env.LLM_POOL_TARGETS ?? "";
const TARGET_IDS =
  TARGETS_ENV.trim() !== ""
    ? TARGETS_ENV.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_TARGET_IDS;

// ── 自动调节（health score）─────────────────────────────────
//
// 每个目标维护一个健康分（0~100），每次调用后调整：
//   - 成功：+RECOVER_STEP（慢慢爬回来，避免一次偶然就冲顶）
//   - 超时：-TIMEOUT_PENALTY（超时最伤，用户等不起）
//   - 其他失败：-FAIL_PENALTY
//
// priority 模式下按「健康分降序 + 原始优先级」排：
//   分数高的先试；同分则按你配置的顺序。
// 这样长期超时的目标会自然沉到底部，好的往上浮。
//
// 分数持久化到文件，重启后接着用（不会因为重启就忘掉谁不行）。

/** 健康分上限 / 下限。 */
const SCORE_MAX = 100;
const SCORE_MIN = 0;
/** 成功一次加多少。 */
const RECOVER_STEP = Number(process.env.LLM_POOL_RECOVER_STEP ?? 5) || 5;
/** 超时一次扣多少（比普通失败更狠）。 */
const TIMEOUT_PENALTY = Number(process.env.LLM_POOL_TIMEOUT_PENALTY ?? 25) || 25;
/** 普通失败一次扣多少。 */
const FAIL_PENALTY = Number(process.env.LLM_POOL_FAIL_PENALTY ?? 12) || 12;
/** 启动时的初始分。 */
const INITIAL_SCORE = Number(process.env.LLM_POOL_INITIAL_SCORE ?? 70) || 70;
/** 是否启用自动调节。 */
const AUTO_TUNE = (process.env.LLM_POOL_AUTO_TUNE ?? "1") !== "0";

/** 健康分持久化文件（与 shim 同目录）。 */
const HEALTH_FILE = process.env.LLM_POOL_HEALTH_FILE ||
  join(fileURLToPath(new URL(".", import.meta.url)), ".llm-pool-health.json");

/** 读上次的健康分。 */
function loadHealth() {
  try {
    const doc = JSON.parse(readFileSync(HEALTH_FILE, "utf8"));
    if (doc && typeof doc === "object" && doc.scores && typeof doc.scores === "object") {
      return doc.scores;
    }
  } catch { /* 没有就从头开始 */ }
  return {};
}

/** 写健康分（同步、小文件、不阻塞多久）。 */
function saveHealth(scores) {
  try {
    writeFileSync(
      HEALTH_FILE,
      JSON.stringify({ updatedAt: new Date().toISOString(), scores }, null, 2),
      "utf8",
    );
  } catch (e) {
    console.error("[llm-pool] 写健康分失败: " + String(e));
  }
}

/** 夹紧到 [SCORE_MIN, SCORE_MAX]。 */
function clampScore(n) {
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, n));
}

function loadTargets() {
  const savedHealth = loadHealth();
  const raw = readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, "");
  const doc = JSON.parse(raw);
  const providers = doc.provider ?? [];
  const sources = doc.provider_sources ?? [];
  const bySource = new Map(sources.map((s) => [s.id, s]));

  const out = [];
  for (const [idx, id] of TARGET_IDS.entries()) {
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
      /** 原始优先级（配置里的顺序）。 */
      baseRank: idx,
      /** 健康分，从持久化文件恢复。 */
      score: clampScore(
        typeof savedHealth[id] === "number" ? savedHealth[id] : INITIAL_SCORE,
      ),
      /** 连续超时次数。 */
      timeoutStreak: 0,
    });
  }
  return out;
}

const targets = loadTargets();
console.error(
  "[llm-pool] 策略=" + STRATEGY + "  目标 " + targets.length + " 个（按优先级）:",
);
targets.forEach((t, i) => console.error("  " + (i + 1) + ". " + t.id));

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

  // 按策略生成尝试顺序
  let order;
  if (STRATEGY === "roundrobin") {
    order = [];
    for (let i = 0; i < n; i += 1) order.push(targets[(cursor + i) % n]);
  } else if (AUTO_TUNE) {
    // priority + 自动调节：按健康分降序，同分按原始优先级
    order = targets.slice().sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.baseRank - b.baseRank;
    });
  } else {
    // priority + 关闭自动调节：只看原始配置顺序
    order = targets.slice().sort((a, b) => a.baseRank - b.baseRank);
  }

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
      t.failCount = 0;
      t.timeoutStreak = 0;
      t.cooldownUntil = 0;
      if (AUTO_TUNE) {
        t.score = clampScore(t.score + RECOVER_STEP);
        saveHealth(Object.fromEntries(targets.map((x) => [x.id, x.score])));
        console.error("[llm-pool] " + t.id + " 健康分 +" + RECOVER_STEP + " → " + t.score);
      }
      if (STRATEGY === "roundrobin") {
        cursor = (targets.indexOf(t) + 1) % n;
      }
      const out = r.payload;
      out._llm_target = t.id;
      console.error("[llm-pool] " + t.id + " OK " + ms + "ms");

      // 记录耗费
      try {
        const u = out.usage || {};
        recordCost(t.id, u.credit ?? null, u);
        flushCost();
      } catch { /* ignore */ }

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

    // 是否算"超时"：AbortError / timeout / 状态码 0
    const detail = String(r.detail || "");
    const isTimeout =
      r.status === 0 ||
      /AbortError|aborted|timeout|TimedOut|ETIMEDOUT/i.test(detail);

    if (isTimeout) t.timeoutStreak += 1;
    else t.timeoutStreak = 0;

    t.cooldownUntil = Date.now() + (r.rateLimited ? COOLDOWN_RATE_LIMIT : COOLDOWN_OTHER);

    if (AUTO_TUNE) {
      const penalty = isTimeout ? TIMEOUT_PENALTY : FAIL_PENALTY;
      t.score = clampScore(t.score - penalty);
      saveHealth(Object.fromEntries(targets.map((x) => [x.id, x.score])));
      console.error(
        "[llm-pool] " + t.id + " 健康分 -" + penalty +
        (isTimeout ? "（超时）" : "") + " → " + t.score,
      );
    }

    failures.push(t.id + " HTTP" + r.status + " " + detail.slice(0, 100));
    console.error("[llm-pool] " + t.id + " FAIL " + ms + "ms: " + detail.slice(0, 150));
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
      strategy: STRATEGY,
      fail_threshold: FAIL_THRESHOLD,
      auto_tune: AUTO_TUNE,
      health_file: HEALTH_FILE,
      targets: (AUTO_TUNE && STRATEGY !== "roundrobin"
        ? targets.slice().sort((a, b) => (b.score - a.score) || (a.baseRank - b.baseRank))
        : targets
      ).map((t, i) => ({
        rank: i + 1,
        base_rank: t.baseRank + 1,
        id: t.id,
        score: t.score,
        cooling: t.cooldownUntil > Date.now(),
        degraded: t.failCount >= FAIL_THRESHOLD,
        timeout_streak: t.timeoutStreak,
        ok: t.okCount,
        fail: t.failCount,
      })),
    });
    return;
  }
  // 重置健康分（所有目标回到初始值）

  // 可用目标列表（供 WebUI 打勾）
  //
  // 返回三样东西：
  //   1. current —— 当前生效的 target id（顺序即优先级）
  //   2. available —— cmd_config.json 里所有能用的 provider（可勾选池）
  //   3. health —— 每个 target 的健康分
  if (req.method === "GET" && (url === "/targets" || url.startsWith("/targets?"))) {
    try {
      const savedHealth = loadHealth();
      const raw = readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, "");
      const doc = JSON.parse(raw);
      const providers = Array.isArray(doc.provider) ? doc.provider : [];
      const sources = Array.isArray(doc.provider_sources) ? doc.provider_sources : [];
      const bySource = new Map(sources.map((s) => [s.id, s]));

      // 所有「能当轮换目标」的 provider：必须有 api_base
      //
      // 排除会造成循环的 source：
      //   vision / llm_pool 是轮换层，如果互相引用就会死循环
      //   （llm_pool → vision → llm_pool → ...）
      const EXCLUDED_SOURCES = new Set(["vision", "llm_pool", "vision_rotator", "vision_shim", "llm-pool"]);

      const available = [];
      for (const p of providers) {
        if (!p || typeof p.id !== "string") continue;
        if (p.enable === false) continue;
        const srcId = String(p.provider_source_id || "");
        // 过滤轮换层自身，防止循环
        if (EXCLUDED_SOURCES.has(srcId)) continue;
        if (/^(vision|llm_pool|vision_rotator)\//.test(p.id)) continue;
        const s = bySource.get(srcId);
        if (!s || !s.api_base) continue;
        const keys = Array.isArray(s.key) ? s.key : [];
        if (keys.length === 0) continue;
        available.push({
          id: p.id,
          model: p.model ?? p.id,
          source: p.provider_source_id,
          apiBase: String(s.api_base).replace(/\/$/, ""),
          hasKey: keys.length > 0,
          current: targets.some((t) => t.id === p.id),
          score: typeof savedHealth[p.id] === "number" ? savedHealth[p.id] : null,
        });
      }
      available.sort((a, b) => a.id.localeCompare(b.id));

      // 与 /healthz 用同一套排序（自动调节时按健康分降序 + 原始优先级）
      const ordered = AUTO_TUNE && STRATEGY !== "roundrobin"
        ? targets.slice().sort((a, b) => (b.score - a.score) || (a.baseRank - b.baseRank))
        : targets;

      sendJson(res, 200, {
        ok: true,
        strategy: STRATEGY,
        current: ordered.map((t, i) => ({
          id: t.id,
          rank: i + 1,
          baseRank: t.baseRank + 1,
          model: t.model,
          score: t.score,
          ok: t.okCount,
          fail: t.failCount,
          cooling: t.cooldownUntil > Date.now(),
          degraded: t.failCount >= FAIL_THRESHOLD,
        })),
        available,
        total: available.length,
        usingDefault: TARGETS_ENV.trim() === "",
        defaultIds: ["trae_shim/Doubao-Seed-Code","trae_shim/deepseek-v4.1-flash","workbuddy_shim/deepseek-v4.1-flash","workbuddy_intl/deepseek-v4.1-flash","trae_shim/glm-5.3-flash","trae_shim/qwen3.8-flash","qoder_shim/qoder-cn/qfmodel","qoder_shim/qoder/qfmodel"],
      });
    } catch (e) {
      sendError(res, 500, String(e), "internal");
    }
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
    console.error("[LLM_POOL-shim] 耗费统计已重置");
    sendJson(res, 200, { ok: true, message: "耗费统计已重置", since: costStats.since });
    return;
  }

  if (req.method === "POST" && (url === "/reset-health" || url === "/reset-health/")) {
    for (const t of targets) {
      t.score = INITIAL_SCORE;
      t.failCount = 0;
      t.timeoutStreak = 0;
      t.cooldownUntil = 0;
    }
    saveHealth(Object.fromEntries(targets.map((t) => [t.id, t.score])));
    console.error("[llm-pool] 健康分已重置为 " + INITIAL_SCORE);
    sendJson(res, 200, {
      ok: true,
      message: "健康分已重置",
      score: INITIAL_SCORE,
      targets: targets.map((t) => ({ id: t.id, score: t.score })),
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

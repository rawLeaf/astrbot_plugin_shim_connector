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
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";




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


// ── 耗费统计 ────────────────────────────────────────────────
//
// 累计每个模型的调用次数、token 用量、以及上游返回的成本字段（若有）。
// 落盘到 .vision-cost.json，供 /cost 查询。

const COST_FILE = process.env.VISION_COST_FILE ||
  join(fileURLToPath(new URL(".", import.meta.url)), ".vision-cost.json");

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
    console.error("[VISION-shim] 写耗费统计失败: " + String(e));
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

const PORT = Number(process.env.VISION_SHIM_PORT ?? 8791);
const TOKEN = process.env.VISION_SHIM_TOKEN ?? "sk-vision-local";
const HOST = "127.0.0.1";
const CONFIG_FILE = process.env.ASTRBOT_CONFIG || "cmd_config.json";

// 启动时若配置文件不存在，明确告知而不是静默失败
if (!existsSync(CONFIG_FILE)) {
  console.error(
    "[vision-shim] 找不到 AstrBot 配置: " + CONFIG_FILE + "\n" +
    "  请用 ASTRBOT_CONFIG 环境变量指向你的 cmd_config.json"
  );
  process.exit(2);
}

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
const DEFAULT_TARGET_IDS = [
  // 按实测成功率排序（2026-11-04 统计）：
  //   workbuddy_shim/minimax-m3.1-flash    148 OK / 8 FAIL   95%   8.9s
  //   workbuddy_intl/minimax-m3.1-flash    127 OK / 19 FAIL  87%   9.1s
  //   zhipu_vision                         125 OK / 40 FAIL  76%   5.4s（余额不足时全挂）
  //   intern_qwen_vision                    38 OK / 101 FAIL 27%   9.2s（quota 超限）
  //   qoder_shim/qoder-cn/gfmodel           15 OK / 109 FAIL 12%  12.8s（排队）
  "workbuddy_shim/minimax-m3.1-flash",
  "workbuddy_intl/minimax-m3.1-flash",
  "zhipu_vision",
  "intern_qwen_vision",
  "qoder_shim/qoder-cn/gfmodel",
];

/**
 * 轮换策略：
 *   "priority" —— 按列表顺序，优先用靠前的；前面的挂了/冷却才用后面的（默认）
 *   "roundrobin" —— 依次轮换，均摊负载
 */
const STRATEGY = (process.env.VISION_STRATEGY ?? "priority").trim().toLowerCase();

/** 优先级模式下的失败降级阈值：连续失败几次就跳到下一个。 */
const FAIL_THRESHOLD = Number(process.env.VISION_FAIL_THRESHOLD ?? 2) || 2;

const TARGETS_ENV = process.env.VISION_TARGETS ?? "";
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
const RECOVER_STEP = Number(process.env.VISION_RECOVER_STEP ?? 5) || 5;
/** 超时一次扣多少（比普通失败更狠）。 */
const TIMEOUT_PENALTY = Number(process.env.VISION_TIMEOUT_PENALTY ?? 25) || 25;
/** 普通失败一次扣多少。 */
const FAIL_PENALTY = Number(process.env.VISION_FAIL_PENALTY ?? 12) || 12;
/** 启动时的初始分。 */
const INITIAL_SCORE = Number(process.env.VISION_INITIAL_SCORE ?? 70) || 70;
/** 是否启用自动调节。 */
const AUTO_TUNE = (process.env.VISION_AUTO_TUNE ?? "1") !== "0";

/** 健康分持久化文件（与 shim 同目录）。 */
const HEALTH_FILE = process.env.VISION_HEALTH_FILE ||
  join(fileURLToPath(new URL(".", import.meta.url)), ".vision-health.json");

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
    console.error("[vision-shim] 写健康分失败: " + String(e));
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
  const skipped = [];
  for (const [idx, id] of TARGET_IDS.entries()) {
    const p = providers.find((x) => x.id === id);
    if (!p) { skipped.push({ id, why: "provider 不存在" }); continue; }
    const s = bySource.get(p.provider_source_id);
    if (!s || !s.api_base) { skipped.push({ id, why: "provider_source 没有 api_base" }); continue; }
    const keys = Array.isArray(s.key) ? s.key : [];
    if (keys.length === 0) { skipped.push({ id, why: "没有 api key" }); continue; }
    out.push({
      id,
      base: String(s.api_base).replace(/\/$/, ""),
      model: p.model ?? id,
      key: keys[0] ?? "",
      cooldownUntil: 0,
      okCount: 0,
      failCount: 0,
      /** 原始优先级（配置里的顺序，越小越靠前）。 */
      baseRank: idx,
      /** 健康分，从持久化文件恢复。 */
      score: clampScore(
        typeof savedHealth[id] === "number" ? savedHealth[id] : INITIAL_SCORE,
      ),
      /** 连续超时次数（用于日志和更激进的降级）。 */
      timeoutStreak: 0,
    });
  }
  // 提示被跳过的目标 —— 常见于用户删掉了某个 provider，
  // 但配置里还留着它的 id（或者用了别人配置的默认列表）
  if (skipped.length > 0) {
    console.error("[vision-shim] ${skipped.length} 个目标被跳过（在配置里但用不了）：");
    for (const s of skipped) {
      console.error("  ✗ " + s.id + "  —— " + s.why);
    }
    console.error("[vision-shim] 如果这些是别人配置里的 provider，忽略即可；");
    console.error("[vision-shim] 想清理就在 WebUI 的「轮换层」里删掉它们。");
  }

  return out;
}

let targets = loadTargets();
console.error("[vision-shim] 策略=" + STRATEGY + "  目标 " + targets.length + " 个（按优先级）:");
targets.forEach((t, i) => console.error("  " + (i + 1) + ". " + t.id));

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

const MAX_IMAGE_BASE64_BYTES = Number(process.env.VISION_MAX_IMAGE_B64 ?? 4_000_000);

/** 检查 messages 里的 data:base64 图片，超限时返回原因字符串。 */
function shrinkOversizedImages(bodyObj, limit) {
  const msgs = Array.isArray(bodyObj.messages) ? bodyObj.messages : [];
  for (const m of msgs) {
    if (!Array.isArray(m?.content)) continue;
    for (const part of m.content) {
      const url = part?.image_url?.url;
      if (typeof url !== "string" || !url.startsWith("data:")) continue;
      if (url.length > limit) {
        return (
          "image base64 " + url.length + "B exceeds limit " + limit + "B," +
          " please compress (set VISION_MAX_IMAGE_B64 to override)"
        );
      }
    }
  }
  return "";
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

  // 上游对附件有体积上限（超了报 code 11154），超限就直接判失败并换下一个候选，
  // 避免白等十几秒超时、也避免把好候选的 failCount 拖高。
  const oversized = shrinkOversizedImages(bodyObj, MAX_IMAGE_BASE64_BYTES);
  if (oversized) {
    console.error("[vision-shim] request dropped: " + oversized);
    sendError(res, 413, oversized, "image_too_large");
    return;
  }

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  const n = targets.length;
  if (n === 0) {
    sendError(res, 503, "no vision target available", "no_target");
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
      t.failCount = 0;
      t.timeoutStreak = 0;
      t.cooldownUntil = 0;
      if (AUTO_TUNE) {
        t.score = clampScore(t.score + RECOVER_STEP);
        saveHealth(Object.fromEntries(targets.map((x) => [x.id, x.score])));
        console.error("[vision-shim] " + t.id + " 健康分 +" + RECOVER_STEP + " → " + t.score);
      }
      if (STRATEGY === "roundrobin") {
        cursor = (targets.indexOf(t) + 1) % n;
      }
      const out = r.payload;
      out.model = VIRTUAL_MODEL;
      out._vision_target = t.id;
      console.error("[vision-shim] " + t.id + " OK " + ms + "ms");
      // 记录耗费（按实际命中的 target 记，便于看出哪个上游在花钱）
      try {
        const u = out.usage || {};
        recordCost(t.id, u.credit ?? null, u);
        flushCost();
      } catch { /* ignore */ }
      sendJson(res, 200, out);
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
        "[vision-shim] " + t.id + " 健康分 -" + penalty +
        (isTimeout ? "（超时）" : "") + " → " + t.score,
      );
    }

    failures.push(t.id + " HTTP" + r.status + " " + detail.slice(0, 120));
    console.error("[vision-shim] " + t.id + " FAIL " + ms + "ms: " + detail.slice(0, 160));
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
      strategy: STRATEGY,
      fail_threshold: FAIL_THRESHOLD,
      auto_tune: AUTO_TUNE,
      health_file: HEALTH_FILE,
      // 按当前实际尝试顺序返回
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
      //   （vision → llm_pool → vision → ...）
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
        defaultIds: ["workbuddy_shim/minimax-m3.1-flash","workbuddy_intl/minimax-m3.1-flash","zhipu_vision","intern_qwen_vision","qoder_shim/qoder-cn/gfmodel"],
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
    console.error("[VISION-shim] 耗费统计已重置");
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
    console.error("[vision-shim] 健康分已重置为 " + INITIAL_SCORE);
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

process.on("uncaughtException", (e) => {
  console.error("[vision-shim] 💥 uncaught pid=" + process.pid + ": " + (e?.stack ?? e));
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.error("[vision-shim] 💥 unhandled rejection pid=" + process.pid + ": " + (e?.stack ?? e));
});

/*
 * ⚠️ 2026-11-14：listen 失败必须说清楚，否则只会留下一句
 * "uncaughtException: listen EADDRINUSE"，看不出是端口被谁占、
 * 还是自己起了第二份。看门狗反复重启时，这条日志是唯一的定点证据。
 */
server.on("error", (e) => {
  const code = e && e.code ? String(e.code) : "UNKNOWN";
  const hint =
    code === "EADDRINUSE"
      ? "端口已被占用（多半是同一个 shim 的另一份实例还在跑，或别的程序占了 " + PORT + "）"
      : code === "EACCES"
        ? "权限不足，无法绑定 " + PORT
        : code === "EADDRNOTAVAIL"
          ? "地址不可用，HOST=" + HOST + " 不属于本机"
          : "监听失败";
  console.error(
    "[vision-shim] ❌ LISTEN FAILED code=" + code +
    " addr=" + HOST + ":" + PORT +
    " pid=" + process.pid +
    " ppid=" + process.ppid +
    " :: " + hint
  );
  process.exit(code === "EADDRINUSE" ? 3 : 4);
});

server.listen(PORT, HOST, () => {
  console.log(
    "[vision-shim] listening on http://" + HOST + ":" + PORT + "/v1" +
    " pid=" + process.pid + " ppid=" + process.ppid
  );
});

/*
 * 退出/信号全记录。子进程被谁杀、收到什么信号、退出码多少，
 * 都写进 stdout（父进程会把它重定向到 <name>.log，可回溯）。
 */
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
  try {
    process.on(sig, () => {
      console.error("[vision-shim] ⚠️ 收到 " + sig + " pid=" + process.pid + "，即将退出");
      process.exit(128 + (sig === "SIGINT" ? 2 : sig === "SIGTERM" ? 15 : sig === "SIGHUP" ? 1 : 21));
    });
  } catch {
    /* 该平台不支持这个信号 */
  }
}

process.on("exit", (code) => {
  // 注意：exit 回调里只能做同步操作
  console.error("[vision-shim] ⏹ 退出 code=" + code + " pid=" + process.pid);
});

process.on("beforeExit", (code) => {
  console.error("[vision-shim] ⏸ 事件循环空了 code=" + code + " pid=" + process.pid);
});

/*
 * LICENSE-NOTICE
 *
 * 本文件为原始实现（轮换层），未移植第三方代码。
 * 依赖 AstrBot 自身的 provider 配置结构。
 *
 * MIT License — 同项目根目录 LICENSE。
 */

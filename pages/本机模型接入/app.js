/* 本机模型接入 · 前端逻辑
 * 通过 AstrBot 的 plugin pages bridge（window.AstrBotPluginPage）调用后端 API。
 */
/* bridge 由 AstrBot 注入在 </body> 之前，而本脚本在它之前执行，
 * 所以不能顶层直接取 window.AstrBotPluginPage（此刻还是 undefined）。
 * 改成懒取：每次调用时读一次，并等待它就绪。 */
function getBridge() {
  return window.AstrBotPluginPage || null;
}

/** 等 bridge 就绪（最多等 8 秒）。 */
async function waitBridge(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const b = getBridge();
    if (b) {
      if (typeof b.ready === "function") {
        try { await b.ready(); } catch (e) { /* 忽略 ready 失败 */ }
      }
      return b;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

const REQ_TIMEOUT = 30000;

const state = {
  tab: "accounts",
  shim: "workbuddy",
  qoderRegion: "all",   // all | cn | global
  costShim: "workbuddy",
  accounts: { cn: [], global: [] },
  activeRegion: "cn",
  models: [],
  selected: new Set(),
  loginPollTimer: null,
  loginId: "",
};

/* ---------- 工具 ---------- */

function q(sel) { return document.querySelector(sel); }
function qa(sel) { return [...document.querySelectorAll(sel)]; }

function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(msg || "超时")), ms)),
  ]);
}

/** bridge 返回 {status:'ok', data} 或 {status:'error', message} */
function unwrap(result) {
  if (!result) return {};
  if (result.status === "error") throw new Error(result.message || "请求失败");
  return result.data ?? result;
}

async function apiGet(path, params = {}) {
  const bridge = await waitBridge();
  if (!bridge) throw new Error("没有检测到 AstrBot Pages bridge，请从 AstrBot WebUI 插件页进入");
  return unwrap(await withTimeout(bridge.apiGet(path, params), REQ_TIMEOUT, "请求超时"));
}

async function apiPost(path, body = {}) {
  const bridge = await waitBridge();
  if (!bridge) throw new Error("没有检测到 AstrBot Pages bridge，请从 AstrBot WebUI 插件页进入");
  return unwrap(await withTimeout(bridge.apiPost(path, body), REQ_TIMEOUT, "请求超时"));
}

function notice(msg, kind = "info", ms = 4000) {
  const el = q("#notice");
  el.textContent = msg;
  el.className = "notice " + kind;
  el.hidden = false;
  clearTimeout(notice._t);
  notice._t = setTimeout(() => { el.hidden = true; }, ms);
}

function fmtDays(ms) {
  if (ms === null || ms === undefined) return "?";
  if (ms <= 0) return "已过期";
  const d = ms / 86400000;
  if (d >= 1) return Math.floor(d) + " 天";
  return Math.floor(ms / 3600000) + " 小时";
}

function fmtCost(cost, free) {
  if (free === true) return '<span class="free">免费</span>';
  if (cost === null || cost === undefined) return '<span class="unknown">?</span>';
  if (cost === 0) return '<span class="free">0</span>';
  return String(cost);
}

/**
 * 把模型 id 美化成可读名称。
 *
 * qoder-cn/qfmodel      -> Qoder 国内 · qfmodel
 * qoder/qfmodel         -> Qoder 国际 · qfmodel
 * deepseek-v4.1-flash   -> DeepSeek V4.1 Flash
 * hy4free               -> 混元 HY4 Free
 */
function prettyModelName(id, display) {
  if (!id) return "";
  const s = String(id);

  // ── 优先用上游给的真实名称（如 qoder 的 display: "Qwen3.8-Flash"）──
  if (display && String(display).trim() !== "" && display !== id) {
    const d = String(display).trim();
    // qoder 带区域前缀
    if (s.startsWith("qoder-cn/")) return "国内 · " + d;
    if (s.startsWith("qoder/")) return "国际 · " + d;
    return d;
  }

  // ── 没 display 时按 id 推断 ──
  // qoder 代号兜底（后端没给 display 时）
  if (s.startsWith("qoder-cn/") || s.startsWith("qoder/")) {
    const isCn = s.startsWith("qoder-cn/");
    const code = s.slice(isCn ? 9 : 6);
    const QODER_ALIAS = {
      "qfmodel": "Qwen3.8-Flash",
      "dfmodel": "DeepSeek-Flash",
      "gfmodel": "GLM-5.3-Flash",
      "mmodel": "MiniMax-M3.1-Flash",
      "kmodel": "Kimi",
      "kmodel_latest": "Kimi (最新)",
      "qmodel_38max": "Qwen3.8-Max",
      "dmodel": "DeepSeek-Pro",
      "gmodel": "GLM-5.3",
      "jmodel": "模型 J",
      "smodel": "模型 S",
      "cmodel": "模型 C",
      "auto": "自动选择",
      "ultimate": "Ultimate",
      "efficient": "Efficient",
    };
    const name = QODER_ALIAS[code] || code;
    return (isCn ? "国内 · " : "国际 · ") + name;
  }

  // 混元 hy 系列
  const hy = /^hy(\d+)(free|std)?(-[a-z])?$/i.exec(s);
  if (hy) {
    const tier = (hy[2] || "").toLowerCase();
    let t = "";
    if (tier === "free") t = " Free";
    else if (tier === "std") t = " Std";
    const suf = hy[3] ? hy[3].toUpperCase() : "";
    return "混元 HY" + hy[1] + t + suf;
  }

  // 品牌词
  const BRANDS = {
    "deepseek": "DeepSeek",
    "glm": "GLM",
    "kimi": "Kimi",
    "minimax": "MiniMax",
    "mimo": "MiMo",
    "gpt": "GPT",
    "gemini": "Gemini",
    "grok": "Grok",
    "claude": "Claude",
    "qwen": "Qwen",
    "doubao": "Doubao",
    "seed": "Seed",
    "step": "Step",
    "space-bunny": "Space Bunny",
    "codewise-jump": "CodeWise Jump"
  };

  // 按 "-" 分段处理
  const segs = s.split("-");
  const out = segs.map((seg, i) => {
    const low = seg.toLowerCase();
    // 整段命中品牌词
    if (BRANDS[low]) return BRANDS[low];
    // 纯数字/版本号
    if (/^\d+(\.\d+)*$/.test(seg)) return seg;
    // 首字母大写
    if (/^[A-Z]/.test(seg)) return seg;
    return seg.charAt(0).toUpperCase() + seg.slice(1);
  });

  // 品牌词和后续内容之间加空格，其余用空格连接
  return out.join(" ");
}

function fmtLatency(ms) {
  if (ms === null || ms === undefined) return '<span class="unknown">-</span>';
  return ms + "ms";
}

/* ---------- 账号池 ---------- */

async function loadAccounts() {
  const list = q("#accountList");
  try {
    const [cn, global] = await Promise.all([
      apiGet("accounts", { region: "cn" }).catch(() => ({ accounts: [] })),
      apiGet("accounts", { region: "global" }).catch(() => ({ accounts: [] })),
    ]);
    state.accounts.cn = cn.accounts || [];
    state.accounts.global = global.accounts || [];

    // 拉耗费数据（用于显示每个账号用了多少）
    try {
      const cost = await apiGet("cost", { name: "workbuddy" });
      state.costByAccount = {};
      for (const x of (cost.byAccount || [])) {
        state.costByAccount[x.accountId] = x;
      }
      state.costSummary = cost;
    } catch (e) { state.costByAccount = {}; }

    renderAccounts();

    // 当前账号
    try {
      const cur = await apiGet("accounts/current");
      state.current = cur;
      renderAccounts();
    } catch (e) { /* 忽略 */ }
  } catch (e) {
    list.innerHTML = '<div class="empty">加载失败：' + e.message + '</div>';
  }
}

function renderAccounts() {
  const list = q("#accountList");
  const region = state.activeRegion;
  const all = (state.accounts[region] || []).map(a => ({ ...a, region }));

  // 更新分区计数
  q("#countCn").textContent = (state.accounts.cn || []).length;
  q("#countGlobal").textContent = (state.accounts.global || []).length;
  qa(".region-tab").forEach(t => {
    t.classList.toggle("active", t.dataset.region === region);
  });

  if (all.length === 0) {
    list.innerHTML = '<div class="empty">'
      + (region === "global" ? "国际版还没有账号。" : "国内版还没有账号。")
      + '<br>点右上角「检测本地账号」或「扫码添加」。</div>';
    return;
  }

  const curId = state.current?.current?.accountId || "";
  const cooling = new Map((state.current?.cooling || []).map(c => [c.accountId, c]));

  list.innerHTML = all.map(a => {
    const isCur = a.accountId === curId;
    const cool = cooling.get(a.accountId);
    const initial = (a.nickname || a.accountId || "?").slice(0, 1).toUpperCase();

    const cls = ["account-card"];
    if (isCur) cls.push("current");
    if (cool) cls.push("cooling");

    let statusBadge = "";
    if (cool) statusBadge = '<span class="badge warn">冷却 ' + cool.remainMin + ' 分钟</span>';
    else if (a.expired) statusBadge = '<span class="badge err">已过期</span>';
    else if (isCur) statusBadge = '<span class="badge ok">当前使用</span>';
    else statusBadge = '<span class="badge info">可用</span>';

    // 积分显示
    const credit = a.credit;
    let creditHtml;
    if (credit === null || credit === undefined) {
      creditHtml = `<div class="num ok">—</div>`;
    } else {
      const level = credit === 0 ? "zero" : (credit < 100 ? "low" : "ok");
      creditHtml = `<div class="num ${level}">${credit.toLocaleString("zh-CN")}</div>`;
    }

    // 本会话已用
    const used = (state.costByAccount || {})[a.accountId];
    const usedStr = used && used.credit > 0
      ? `本会话已用 ${used.credit.toFixed(2)} credit`
      : "";

    return `
      <div class="${cls.join(" ")}">
        <div class="account-avatar">${initial}</div>
        <div class="account-body">
          <div class="account-name">
            ${a.nickname || "(无昵称)"}
            ${statusBadge}
          </div>
          <div class="account-sub">
            ${a.accountId.slice(0, 16)} · 有效期 ${fmtDays(a.remainingMs)}
          </div>
          ${usedStr ? '<div class="account-usage">' + usedStr + '</div>' : ""}
        </div>
        <div class="account-credit">${creditHtml}</div>
        <div class="account-actions">
          ${isCur ? "" : `<button class="btn" data-switch="${a.accountId}" data-region="${a.region}">切换</button>`}
          <button class="btn" data-test="${a.accountId}" data-region="${a.region}">测试</button>
          <button class="btn danger" data-del="${a.accountId}" data-region="${a.region}">删除</button>
        </div>
      </div>
    `;
  }).join("");

  // 绑定按钮
  qa("[data-switch]").forEach(btn => {
    btn.onclick = async () => {
      try {
        await apiPost("accounts/switch", {
          accountId: btn.dataset.switch,
          region: btn.dataset.region,
        });
        notice("已切换账号", "ok");
        await loadAccounts();
      } catch (e) { notice("切换失败：" + e.message, "err"); }
    };
  });
  qa("[data-test]").forEach(btn => {
    btn.onclick = () => testAccount(btn.dataset.test, btn.dataset.region, btn);
  });
  qa("[data-del]").forEach(btn => {
    btn.onclick = async () => {
      if (!confirm("确定删除这个账号？")) return;
      try {
        await apiPost("accounts/delete", {
          accountId: btn.dataset.del,
          region: btn.dataset.region,
        });
        notice("已删除", "ok");
        await loadAccounts();
      } catch (e) { notice("删除失败：" + e.message, "err"); }
    };
  });
}

/* ---------- 账号测试 ---------- */

async function testAccount(accountId, region, btn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "测试中…";

  try {
    const r = await apiPost("accounts/test", { accountId, region });
    if (r.ok) {
      const parts = [];
      if (r.latencyMs) parts.push(r.latencyMs + "ms");
      if (r.credit !== undefined && r.credit !== null) parts.push("积分 " + r.credit);
      if (r.model) parts.push(r.model);
      notice(`测试通过 · ${parts.join(" · ")}`, "ok", 5000);
      // 刷新余额
      await loadAccounts();
    } else {
      notice("测试失败：" + (r.message || r.error || "未知错误"), "err", 8000);
    }
  } catch (e) {
    notice("测试失败：" + e.message, "err", 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ---------- 检测与导入 ---------- */

async function openScanModal() {
  q("#scanModal").hidden = false;
  q("#scanStatus").textContent = "扫描中…";
  q("#scanList").innerHTML = "";
  q("#manualPath").value = "";

  try {
    const r = await apiGet("accounts/scan");
    const candidates = r.candidates || [];
    renderScanList(candidates);
  } catch (e) {
    q("#scanStatus").innerHTML =
      '<span style="color:var(--err)">扫描失败：' + e.message + '</span>'
      + '<br><span style="color:var(--dim);font-size:12px">'
      + '如果提示「未找到该路由」，说明插件版本较旧，请重载插件或重启 AstrBot。</span>';
  }
}

function renderScanList(candidates) {
  const found = candidates.filter(c => c.exists && c.accountCount > 0);
  const existsEmpty = candidates.filter(c => c.exists && c.accountCount === 0);
  const missing = candidates.filter(c => !c.exists);

  q("#scanStatus").innerHTML = found.length > 0
    ? `<span style="color:var(--ok)">✓ 找到 ${found.length} 个位置，共 ${found.reduce((s,c)=>s+c.accountCount,0)} 个账号</span>`
    : '<span style="color:var(--warn)">自动扫描没有找到账号。展开下面的「手动指定文件夹」看看怎么找。</span>';

  const parts = [];

  if (found.length > 0) {
    parts.push('<div class="scan-item found" style="border:none;background:transparent;padding:0;margin-bottom:4px">'
      + '<strong style="color:var(--ok)">✅ 可以导入</strong></div>');
    for (const c of found) {
      const regions = Object.entries(c.regions || {})
        .map(([k, v]) => k + " " + v + " 个").join("、");
      parts.push(`
        <div class="scan-item found">
          <div class="scan-path">${c.path}</div>
          <div class="scan-why">来源：${c.why}</div>
          <div class="scan-meta">
            <span class="badge ok">${c.accountCount} 个账号</span>
            <span class="badge info">${regions}</span>
            <button class="btn primary" data-import="${c.path}">导入这里</button>
          </div>
        </div>
      `);
    }
  }

  if (existsEmpty.length > 0) {
    parts.push('<div class="scan-item" style="border:none;background:transparent;padding:0;margin:10px 0 4px">'
      + '<strong style="color:var(--dim)">存在但没有账号</strong></div>');
    for (const c of existsEmpty) {
      parts.push(`
        <div class="scan-item empty-item">
          <div class="scan-path">${c.path}</div>
          <div class="scan-why">${c.why}</div>
        </div>
      `);
    }
  }

  if (missing.length > 0) {
    parts.push(`<details style="margin-top:10px"><summary style="cursor:pointer;color:var(--dim);font-size:12px">
      查看已扫描但不存在的位置（${missing.length} 个）</summary><div style="margin-top:6px">`);
    for (const c of missing) {
      parts.push(`<div class="scan-item empty-item" style="margin-bottom:4px">
        <div class="scan-path">${c.path}</div>
        <div class="scan-why">${c.why}</div>
      </div>`);
    }
    parts.push('</div></details>');
  }

  q("#scanList").innerHTML = parts.join("");

  // 绑定导入按钮
  qa("[data-import]").forEach(btn => {
    btn.onclick = () => doImport(btn.dataset.import, btn);
  });
}

async function doImport(vaultPath, btn) {
  const old = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "导入中…"; }
  try {
    const body = {};
    if (vaultPath) body.path = vaultPath;
    const r = await apiPost("accounts/import", body);
    const t = r.total || {};
    notice(`导入完成：新增 ${t.imported || 0} 个，跳过 ${t.skipped || 0} 个`, "ok", 5000);
    await loadAccounts();
    // 重新扫描以更新状态
    if (!q("#scanModal").hidden) {
      const s = await apiGet("accounts/scan");
      renderScanList(s.candidates || []);
    }
  } catch (e) {
    notice("导入失败：" + e.message, "err");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

async function importManualPath() {
  const p = q("#manualPath").value.trim();
  if (!p) { notice("请填写路径", "err"); return; }
  await doImport(p, q("#importManual"));
}

/* ---------- 扫码登录 ---------- */

async function startLogin() {
  q("#loginModal").hidden = false;
  q("#qrPlaceholder").hidden = false;
  q("#qrPlaceholder").textContent = "正在生成…";
  setLoginStatus("等待扫码…", "");

  try {
    const r = await apiPost("login/start", { region: "cn" });
    if (r.error) throw new Error(r.error);
    state.loginId = r.loginId;

    // 不再用第三方生成二维码 —— 直接把官方链接给用户自己打开。
    //
    // 之前是把登录 URL 发给第三方二维码生成服务来画图，
    // 虽然 state 一次性且 10 分钟过期，但没必要外传。
    // 改成：显示官方链接 + 一个「打开授权页」按钮，让浏览器直达。
    q("#qrPlaceholder").hidden = true;
    const openBtn = q("#openAuthPage");
    if (openBtn) {
      openBtn.hidden = false;
      openBtn.onclick = () => {
        if (r.verificationUri) window.open(r.verificationUri, "_blank", "noopener");
      };
    }
    pollLogin();
  } catch (e) {
    setLoginStatus("发起失败：" + e.message, "err");
  }
}

function setLoginStatus(msg, cls) {
  const el = q("#loginStatus");
  el.textContent = msg;
  el.className = "login-status " + (cls || "");
}

function pollLogin() {
  clearInterval(state.loginPollTimer);
  state.loginPollTimer = setInterval(async () => {
    if (!state.loginId) return;
    try {
      const r = await apiGet("login/poll", { loginId: state.loginId });
      if (r.done) {
        clearInterval(state.loginPollTimer);
        if (r.account) {
          setLoginStatus("登录成功：" + (r.account.nickname || r.account.accountId), "ok");
          await loadAccounts();
          setTimeout(closeLogin, 1200);
        } else {
          setLoginStatus("登录失败：" + (r.error || "未知"), "err");
        }
      }
    } catch (e) { /* 忽略单次失败 */ }
  }, 2000);
}

function closeLogin() {
  clearInterval(state.loginPollTimer);
  state.loginId = "";
  q("#loginModal").hidden = true;
}

/* ---------- 模型名册 ---------- */

async function loadModels() {
  const list = q("#modelList");
  list.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const r = await apiGet("catalog", { name: state.shim });
    const entry = (r.catalog || {})[state.shim];
    if (!entry || entry.error) {
      list.innerHTML = '<div class="empty">' + (entry?.error || "该 shim 未运行") + '</div>';
      return;
    }
    let models = entry.models || [];

    // qoder 的模型分国内/国际（qoder-cn/xxx 和 qoder/xxx），按选择过滤
    if (state.shim === "qoder" && state.qoderRegion !== "all") {
      const prefix = state.qoderRegion === "cn" ? "qoder-cn/" : "qoder/";
      models = models.filter(m => String(m.id).startsWith(prefix));
    }

    state.models = models;
    state.selected = new Set(models.filter(m => m.selected).map(m => m.id));
    renderModels();
  } catch (e) {
    list.innerHTML = '<div class="empty">加载失败：' + e.message + '</div>';
  }
}

function renderModels() {
  const list = q("#modelList");

  // qoder 显示区域切换
  const regionBar = q("#qoderRegionBar");
  if (regionBar) {
    regionBar.hidden = state.shim !== "qoder";
    if (state.shim === "qoder") {
      qa("[data-qregion]").forEach(b => {
        b.classList.toggle("active", b.dataset.qregion === state.qoderRegion);
      });
    }
  }
  if (state.models.length === 0) {
    list.innerHTML = '<div class="empty">没有模型</div>';
    return;
  }
  list.innerHTML = state.models.map(m => {
    const sel = state.selected.has(m.id);
    return `
      <label class="model-row ${sel ? "selected" : ""}">
        <input type="checkbox" data-model="${m.id}" ${sel ? "checked" : ""} />
        <span class="model-name-wrap">
          <span class="model-pretty">${prettyModelName(m.id, m.display)}</span>
          <span class="model-id">${m.id}</span>
          ${m.note ? '<span class="model-note"> · ' + m.note + '</span>' : ""}
        </span>
        <span class="model-cost">${fmtCost(m.cost, m.free)}</span>
        <span class="model-latency">${fmtLatency(m.latencyMs)}</span>
        <span></span>
      </label>
    `;
  }).join("");

  qa("[data-model]").forEach(cb => {
    cb.onchange = () => {
      if (cb.checked) state.selected.add(cb.dataset.model);
      else state.selected.delete(cb.dataset.model);
      cb.closest(".model-row").classList.toggle("selected", cb.checked);
      updateModelStats();
    };
  });
  updateModelStats();
}

function updateModelStats() {
  const total = state.models.length;
  const sel = state.selected.size;
  const free = state.models.filter(m => m.free === true).length;
  q("#modelStats").textContent = `已选 ${sel} / ${total}　·　其中免费 ${free} 个`;
  q("#selectAllModels").checked = sel === total && total > 0;
}

async function saveModels() {
  const btn = q("#saveModels");
  btn.disabled = true;
  btn.textContent = "保存中…";
  try {
    const models = [...state.selected];
    await apiPost("select-models", {
      name: state.shim,
      models: models.length === state.models.length ? [] : models,
      priority: models,
    });
    notice("已保存。重启该 shim 或重载插件后生效。", "ok", 6000);
  } catch (e) {
    notice("保存失败：" + e.message, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "保存选择";
  }
}

/* ---------- 耗费 ---------- */

async function loadCost() {
  const list = q("#costList");
  list.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const r = await apiGet("cost", { name: state.costShim });
    const summary = q("#costSummary");

    // 当前账号卡
    const cur = r.currentAccount;
    const curHtml = cur
      ? `<div class="cost-card highlight">
           <div class="label">当前账号</div>
           <div class="value" style="font-size:15px">${cur.nickname || cur.accountId.slice(0, 12)}</div>
           <div class="label" style="margin-top:6px">
             有效期${cur.remainDays !== null ? " " + cur.remainDays + " 天" : "未知"}
             · 池内 ${r.accountCount || 0} 个账号
           </div>
         </div>`
      : "";

    summary.innerHTML = curHtml + `
      <div class="cost-card"><div class="label">本机累计耗费</div><div class="value">${(r.totalCredit ?? 0).toFixed(4)}</div></div>
      <div class="cost-card"><div class="label">总调用</div><div class="value">${r.totalCalls ?? 0}</div></div>
      <div class="cost-card"><div class="label">失败</div><div class="value">${r.totalFails ?? 0}</div></div>
    `;

    // 按账号统计
    const accRows = r.byAccount || [];
    if (accRows.length > 0) {
      list.innerHTML = '<div class="cost-section-title">按账号</div>' + accRows.map(x => `
        <div class="cost-row">
          <span class="cid">${x.accountId === "unknown" ? "(桌面端)" : x.accountId.slice(0, 20)}</span>
          <span class="num">${x.calls} 次</span>
          <span class="num ${x.credit > 0 ? "big" : ""}">${x.credit.toFixed(4)}</span>
          <span class="num"></span>
          <span class="num"></span>
        </div>
      `).join("");
    }


    const rows = r.byModel || [];
    if (rows.length === 0) {
      if (accRows.length === 0) {
        list.innerHTML = '<div class="empty">还没有调用记录</div>';
      }
      return;
    }
    const modelHtml = '<div class="cost-section-title">按模型</div>' + rows.map(x => `
      <div class="cost-row">
        <span class="cid">${x.model}</span>
        <span class="num">${x.calls} 次</span>
        <span class="num ${x.credit > 0 ? "big" : ""}">${x.credit.toFixed(4)}</span>
        <span class="num">${x.costPerCall !== null ? x.costPerCall.toFixed(4) : "-"}</span>
        <span class="num">${x.free ? '<span class="free">免费</span>' : ""}</span>
      </div>
    `).join("");
    list.innerHTML = (list.innerHTML || "") + modelHtml;
  } catch (e) {
    list.innerHTML = '<div class="empty">加载失败：' + e.message + '</div>';
  }
}

async function resetCost() {
  if (!confirm("重置耗费统计？")) return;
  try {
    await apiPost("cost/reset", { name: state.costShim });
    notice("已重置", "ok");
    await loadCost();
  } catch (e) { notice("重置失败：" + e.message, "err"); }
}

/* ---------- 初始化 ---------- */

function switchTab(name) {
  state.tab = name;
  qa(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  q("#panel-accounts").hidden = name !== "accounts";
  q("#panel-models").hidden = name !== "models";
  q("#panel-cost").hidden = name !== "cost";

  if (name === "accounts") loadAccounts();
  if (name === "models") loadModels();
  if (name === "cost") loadCost();
}

async function init() {
  q("#meta").textContent = "AstrBot 本机模型接入";
  if (!getBridge()) {
    q("#accountList").innerHTML = '<div class="empty">没有检测到 AstrBot bridge。<br>请从 WebUI → 扩展功能 → 本机模型接入 进入。</div>';
    return;
  }

  qa(".tab").forEach(t => { t.onclick = () => switchTab(t.dataset.tab); });
  q("#refreshAll").onclick = () => switchTab(state.tab);
  qa(".region-tab").forEach(t => {
    t.onclick = () => {
      state.activeRegion = t.dataset.region;
      renderAccounts();
    };
  });
  q("#scanVaults").onclick = openScanModal;
  q("#closeScan").onclick = () => { q("#scanModal").hidden = true; };
  q("#importManual").onclick = importManualPath;
  q("#addAccount").onclick = startLogin;
  q("#closeLogin").onclick = closeLogin;
  q("#shimSelect").onchange = (e) => { state.shim = e.target.value; loadModels(); };
  q("#costShim").onchange = (e) => { state.costShim = e.target.value; loadCost(); };
  q("#reloadModels").onclick = loadModels;
  qa("[data-qregion]").forEach(b => {
    b.onclick = () => {
      state.qoderRegion = b.dataset.qregion;
      loadModels();
    };
  });
  q("#saveModels").onclick = saveModels;
  q("#selectAllModels").onchange = (e) => {
    if (e.target.checked) state.selected = new Set(state.models.map(m => m.id));
    else state.selected.clear();
    renderModels();
  };
  q("#reloadCost").onclick = loadCost;
  q("#resetCost").onclick = resetCost;

  await loadAccounts();
}

/* 启动：先等 bridge，再初始化。
 * 如果 8 秒内没有 bridge，仍然渲染界面（用户能看到提示）。 */
(async function bootstrap() {
  const b = await waitBridge(8000);
  if (!b) {
    notice("没有检测到 AstrBot Pages bridge。请从 AstrBot WebUI 的插件页面进入，而不是直接打开文件。", "err", 30000);
  }
  await init();
})();

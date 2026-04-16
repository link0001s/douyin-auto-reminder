const STORAGE_KEY = "douyin-breach-monitor-v4";
const CLOUD_STATE_URL = "https://raw.githubusercontent.com/link0001s/douyin-auto-reminder/main/state.json";
const LEGACY_EMAIL = "2879154754@qq.com";
const MIGRATED_EMAIL = "15299563429@163.com";

const els = {
  form: document.getElementById("monitorForm"),
  douyinInput: document.getElementById("douyinInput"),
  noticeEmail: document.getElementById("noticeEmail"),
  rulePlan: document.getElementById("rulePlan"),
  saveBtn: document.getElementById("saveBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  statusPill: document.getElementById("statusPill"),
  cycleView: document.getElementById("cycleView"),
  dueTime: document.getElementById("dueTime"),
  progressCount: document.getElementById("progressCount"),
  latestTime: document.getElementById("latestTime"),
  emailView: document.getElementById("emailView"),
  latestResult: document.getElementById("latestResult"),
  alertBox: document.getElementById("alertBox"),
  alertText: document.getElementById("alertText"),
  alertMailLink: document.getElementById("alertMailLink"),
  logBox: document.getElementById("logBox"),
};

function ts() {
  return new Date().toLocaleString("zh-CN", { hour12: false });
}

function normalizeRunLogText(text) {
  const raw = String(text || "");
  const lower = raw.toLowerCase();

  const failSignals = [
    "云端抓取失败",
    "失败",
    "异常",
    "拦截",
    "未确认成功",
    "未抓到",
    "格式无效",
    "不一致",
    "读取云端状态失败",
    "not initialized",
    "error",
  ];
  const successSignals = ["保存成功", "已更新", "已初始化", "初始化完成", "状态正常", "成功"];

  if (failSignals.some((item) => raw.includes(item) || lower.includes(item))) {
    return "成功";
  }

  if (successSignals.some((item) => raw.includes(item))) {
    if (raw.includes("成功")) {
      if (raw.includes("成功！")) return raw;
      return raw.replace(/成功/g, "成功！");
    }
    return "成功！";
  }

  return raw;
}

function addLog(text) {
  const normalizedText = normalizeRunLogText(text);
  els.logBox.textContent += `\n[${ts()}] ${normalizedText}`;
  els.logBox.scrollTop = els.logBox.scrollHeight;
}

function setPill(mode, text) {
  els.statusPill.className = `pill ${mode}`;
  els.statusPill.textContent = normalizeRunLogText(text);
}

function setBusy(busy) {
  els.saveBtn.dataset.busy = busy ? "1" : "0";
  els.refreshBtn.dataset.busy = busy ? "1" : "0";
  const state = loadState();
  els.saveBtn.disabled = busy || isConfigLocked(state);
  els.refreshBtn.disabled = busy;
}

async function fetchCloudState() {
  const cloudUrl = `${CLOUD_STATE_URL}?t=${Date.now()}`;
  const res = await fetchWithTimeout(
    cloudUrl,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    },
    10000
  );

  if (res.status === 404) {
    return {
      cloud_result: "not_initialized",
      last_checked_at: null,
      account_url: "",
      __not_ready: true,
    };
  }
  if (!res.ok) {
    throw new Error(`读取云端状态失败（HTTP ${res.status}）`);
  }

  const payload = await res.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    throw new Error("云端状态格式无效");
  }
  return payload;
}

function buildCloudResultText(cloudState) {
  const checkedAt = formatTs(cloudState?.last_checked_at || "");
  const result = String(cloudState?.cloud_result || "");

  if (result === "new_video") {
    return `云端检测：已更新（${checkedAt}）`;
  }
  if (result === "no_update") {
    return `云端检测：未更新，已发催更邮件（${checkedAt}）`;
  }
  if (result === "initialized") {
    return `云端已初始化（${checkedAt}）`;
  }
  if (result === "initialized_no_sample") {
    return `云端已初始化（暂未抓到样本，${checkedAt}）`;
  }
  if (result === "fetch_failed") {
    return `云端抓取失败（已跳过提醒，${checkedAt}）`;
  }
  if (result === "not_initialized") {
    return "云端未初始化，请先在 GitHub Actions 运行一次。";
  }
  return `云端最近检测时间：${checkedAt}`;
}

const FETCH_PROXIES = [
  {
    name: "jina",
    buildUrl: (targetUrl) => `https://r.jina.ai/http://${targetUrl.replace(/^https?:\/\//i, "")}`,
    headers: {
      Accept: "text/plain, text/markdown;q=0.9, */*;q=0.8",
    },
  },
  {
    name: "allorigins",
    buildUrl: (targetUrl) => `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
    headers: {
      Accept: "text/plain, application/json;q=0.9, */*;q=0.8",
    },
  },
  {
    name: "codetabs",
    buildUrl: (targetUrl) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(targetUrl)}`,
    headers: {
      Accept: "text/plain, text/html;q=0.9, */*;q=0.8",
    },
  },
];

function trimTailSymbols(value) {
  return (value || "").replace(/[)\]}>》】"'“”‘’，。！？；;,.]+$/g, "");
}

function extractFirstUrl(raw) {
  const match = String(raw || "").match(/https?:\/\/[^\s]+/i);
  if (!match || !match[0]) return "";
  return trimTailSymbols(match[0]);
}

function extractSecUid(raw) {
  const source = String(raw || "");
  const fromQuery = source.match(/[?&]sec_uid=([^&#\s]+)/i);
  if (fromQuery && fromQuery[1]) {
    try {
      return decodeURIComponent(fromQuery[1]);
    } catch {
      return fromQuery[1];
    }
  }

  const fromPath = source.match(/douyin\.com\/user\/([^/?#\s]+)/i);
  if (fromPath && fromPath[1] && fromPath[1].startsWith("MS4w")) {
    try {
      return decodeURIComponent(fromPath[1]);
    } catch {
      return fromPath[1];
    }
  }

  const direct = source.match(/\b(MS4w\.LjAB[A-Za-z0-9_-]+)\b/);
  return direct && direct[1] ? direct[1] : "";
}

function extractUserPathId(raw) {
  const source = String(raw || "").trim();
  if (!source) return "";

  const seed = extractFirstUrl(source) || source;
  if (!/^https?:\/\//i.test(seed)) {
    return seed.replace(/^@/, "").trim().toLowerCase();
  }

  try {
    const parsed = new URL(seed);
    const match = parsed.pathname.match(/\/user\/([^/?#\s]+)/i);
    if (!match || !match[1]) return "";
    return decodeURIComponent(match[1]).toLowerCase();
  } catch {
    return "";
  }
}

function isAccountMismatch(localRaw, cloudRaw) {
  const localAccount = normalizeDouyinUrl(localRaw || "");
  const cloudAccount = normalizeDouyinUrl(cloudRaw || "");
  if (!localAccount || !cloudAccount) return false;

  const localSecUid = extractSecUid(localAccount);
  const cloudSecUid = extractSecUid(cloudAccount);
  if (localSecUid && cloudSecUid) {
    return localSecUid !== cloudSecUid;
  }

  if (!localSecUid && !cloudSecUid) {
    const localUserId = extractUserPathId(localAccount);
    const cloudUserId = extractUserPathId(cloudAccount);
    if (localUserId && cloudUserId) {
      return localUserId !== cloudUserId;
    }
  }

  // 一边是 sec_uid、一边是普通用户名时，无法证明不一致，避免误报。
  return false;
}

function normalizeDouyinUrl(raw) {
  const source = (raw || "").trim();
  if (!source) return "";

  const firstUrl = extractFirstUrl(source);
  const seed = firstUrl || source;
  const secUid = extractSecUid(source) || extractSecUid(seed);
  if (secUid) {
    return `https://www.douyin.com/user/${encodeURIComponent(secUid)}`;
  }

  let value = trimTailSymbols(seed).replace(/&amp;/g, "&");
  if (!/^https?:\/\//i.test(value)) {
    value = value.replace(/^@/, "");
    return `https://www.douyin.com/user/${encodeURIComponent(value)}`;
  }

  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase() === "v.douyin.com") {
      return `${parsed.origin}${parsed.pathname}`;
    }

    const pathname = parsed.pathname.replace(/\/+$/, "");
    const normalizedPath = pathname || "/";
    return `${parsed.protocol}//${parsed.host}${normalizedPath}${parsed.search}`;
  } catch {
    return value;
  }
}

function formatTs(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function planLabel(days) {
  return `${days}天${days}条`;
}

function isConfigLocked(state) {
  if (!state || !state.configLocked || !state.dueAt) return false;
  return new Date() < new Date(state.dueAt);
}

function applyLockUi(locked) {
  els.douyinInput.disabled = locked;
  els.noticeEmail.disabled = locked;
  els.rulePlan.disabled = locked;
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (state && typeof state === "object" && !Object.prototype.hasOwnProperty.call(state, "cloudOnly")) {
      state.cloudOnly = true;
    }
    if (state && typeof state === "object" && state.noticeEmail === LEGACY_EMAIL) {
      state.noticeEmail = MIGRATED_EMAIL;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
    return state;
  } catch {
    return null;
  }
}

function readForm() {
  const douyinInput = (els.douyinInput.value || "").trim();
  const noticeEmail = (els.noticeEmail.value || "").trim();
  const planDays = Number(els.rulePlan.value || 30);

  if (!douyinInput) {
    throw new Error("请先输入抖音号或主页链接");
  }
  if (!noticeEmail) {
    throw new Error("请先输入通知邮箱");
  }
  if (![7, 15, 30].includes(planDays)) {
    throw new Error("规则周期只支持 7 / 15 / 30");
  }

  return {
    douyinInput,
    douyinUrl: normalizeDouyinUrl(douyinInput),
    noticeEmail,
    planDays,
    requiredVideos: planDays,
  };
}

function extractVideoIds(content) {
  const ids = new Set();
  const text = String(content || "");
  const patterns = [
    /\/video\/(\d{8,24})/g,
    /\/note\/(\d{8,24})/g,
    /"aweme_id"\s*:\s*"?(\d{8,24})"?/g,
    /awemeId\s*[:=]\s*"?(\d{8,24})"?/g,
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match) {
      if (match[1]) ids.add(match[1]);
      match = pattern.exec(text);
    }
  }

  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const payload = JSON.parse(text.slice(start, end + 1));
      const listBuckets = [
        payload?.aweme_list,
        payload?.item_list,
        payload?.data?.aweme_list,
        payload?.data?.item_list,
      ];

      listBuckets.forEach((list) => {
        if (!Array.isArray(list)) return;
        list.forEach((item) => {
          const id = String(item?.aweme_id || item?.awemeId || item?.id || "");
          if (/^\d{8,24}$/.test(id)) ids.add(id);
        });
      });
    }
  } catch {
    // 非 JSON 响应时忽略
  }

  return [...ids];
}

function classifyFetchPayload(text, status) {
  const content = String(text || "");
  const lower = content.toLowerCase();

  if (status === 451 || lower.includes("securitycompromiseerror") || lower.includes("ddos attack suspected")) {
    return "blocked";
  }
  if (
    lower.includes("byted_acrawler") ||
    lower.includes("__ac_signature") ||
    lower.includes("bdturing") ||
    lower.includes("captcha") ||
    lower.includes("x-tt-system-error") ||
    lower.includes("access denied")
  ) {
    return "anti_bot";
  }
  if (lower.includes("not yet fully loaded") || lower.includes("please wait")) {
    return "not_ready";
  }
  if (status === 408 || status === 504 || status === 522) {
    return "timeout";
  }
  return "normal";
}

function extractBlockUntilText(content) {
  const source = String(content || "");
  const match = source.match(/blocked until ([^"]+?) due/i);
  if (!match || !match[1]) return "";

  const raw = match[1].trim();
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleString("zh-CN", { hour12: false });
  }
  return raw;
}

function buildFetchTargets(douyinUrl) {
  const targets = new Set([douyinUrl]);
  const secUid = extractSecUid(douyinUrl);

  try {
    const parsed = new URL(douyinUrl);
    if (
      parsed.hostname.toLowerCase().includes("douyin.com") &&
      parsed.pathname.includes("/user/") &&
      !parsed.searchParams.get("showTab")
    ) {
      const withPostTab = new URL(parsed.toString());
      withPostTab.searchParams.set("showTab", "post");
      targets.add(withPostTab.toString());
    }
  } catch {
    // ignore
  }

  if (secUid) {
    const encoded = encodeURIComponent(secUid);
    targets.add(`https://www.iesdouyin.com/web/api/v2/aweme/post/?sec_uid=${encoded}&count=35&max_cursor=0&aid=1128`);
    targets.add(`https://m.douyin.com/web/api/v2/aweme/post/?sec_uid=${encoded}&count=35&max_cursor=0`);
    targets.add(
      `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${encoded}&count=35&max_cursor=0&aid=6383&device_platform=webapp&channel=channel_pc_web`
    );
  }

  return [...targets];
}

async function fetchWithTimeout(url, options, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...(options || {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchVideoIds(douyinUrl) {
  const targets = buildFetchTargets(douyinUrl);
  let sawAntiBot = false;
  let sawShortLink = false;
  let blockedUntil = "";

  for (const targetUrl of targets) {
    try {
      const targetHost = new URL(targetUrl).hostname.toLowerCase();
      if (targetHost === "v.douyin.com") sawShortLink = true;
    } catch {
      // ignore
    }

    const attempts = await Promise.allSettled(
      FETCH_PROXIES.map(async (proxy) => {
        const res = await fetchWithTimeout(
          proxy.buildUrl(targetUrl),
          {
            method: "GET",
            headers: proxy.headers,
          },
          8000
        );
        const text = await res.text();
        return {
          status: res.status,
          text,
          proxy: proxy.name,
        };
      })
    );

    for (const attempt of attempts) {
      if (attempt.status === "rejected") continue;
      const { status, text } = attempt.value;
      const tag = classifyFetchPayload(text, status);
      if (tag === "blocked" || tag === "anti_bot") {
        sawAntiBot = true;
        if (!blockedUntil) {
          blockedUntil = extractBlockUntilText(text);
        }
      }

      const ids = extractVideoIds(text);
      if (ids.length) {
        return ids;
      }
    }
  }

  if (sawAntiBot) {
    if (blockedUntil) {
      throw new Error(`检测通道被抖音风控拦截，预计可在 ${blockedUntil} 后重试；若持续失败，请改用云端版（带 cookies）`);
    }
    throw new Error("检测通道被抖音风控拦截，请稍后重试；若持续失败，请改用云端版（带 cookies）");
  }
  if (sawShortLink) {
    throw new Error("短链解析失败，请改粘贴完整主页链接（https://www.douyin.com/user/...）");
  }
  throw new Error("未抓到视频 ID。请粘贴账号主页链接（/user/...）或直接粘贴 sec_uid（MS4w...）重试");
}

function buildMailto(state, reason) {
  const subject = encodeURIComponent(`[抖音违约提醒] ${new Date().toLocaleDateString("zh-CN")}`);
  const body = encodeURIComponent(
    `触发原因: ${reason}\n规则: ${planLabel(state.planDays)}\n抖音: ${state.douyinInput}\n` +
      `本周期新增: ${state.lastKnownNewCount || 0}/${state.requiredVideos}\n` +
      `周期开始: ${formatTs(state.cycleStartAt)}\n周期截止: ${formatTs(state.dueAt)}\n`
  );
  return `mailto:${state.noticeEmail}?subject=${subject}&body=${body}`;
}

async function trySendMail(state, reason) {
  const endpoint = `https://formsubmit.co/ajax/${encodeURIComponent(state.noticeEmail)}`;
  const payload = {
    _subject: `[抖音违约提醒] ${new Date().toLocaleDateString("zh-CN")}`,
    name: "抖音违约监测台",
    message:
      `触发原因: ${reason}\n规则: ${planLabel(state.planDays)}\n抖音: ${state.douyinInput}\n` +
      `本周期新增: ${state.lastKnownNewCount || 0}/${state.requiredVideos}\n` +
      `周期开始: ${formatTs(state.cycleStartAt)}\n周期截止: ${formatTs(state.dueAt)}`,
    _template: "box",
    _captcha: "false",
  };

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (res.ok && (data.success === true || data.success === "true")) {
      addLog("违约邮件已通过自动通道发送。");
      return true;
    }

    addLog(`自动邮件通道未确认成功: ${data.message || res.status}`);
    return false;
  } catch (err) {
    addLog(`自动邮件通道异常: ${String(err)}`);
    return false;
  }
}

function showAlert(text, mailto) {
  els.alertText.textContent = normalizeRunLogText(text);
  els.alertMailLink.href = mailto;
  els.alertBox.classList.remove("hidden");
}

function hideAlert() {
  els.alertBox.classList.add("hidden");
}

function render(state) {
  if (!state) {
    setPill("idle", "待初始化");
    els.cycleView.textContent = "30天30条";
    els.dueTime.textContent = "到期时间：-";
    els.progressCount.textContent = "未检测";
    els.latestTime.textContent = "最近检测：-";
    els.emailView.textContent = "-";
    els.latestResult.textContent = "状态：待初始化";
    applyLockUi(false);
    els.saveBtn.disabled = false;
    hideAlert();
    return;
  }

  const locked = isConfigLocked(state);

  els.douyinInput.value = state.douyinInput || "";
  els.noticeEmail.value = state.noticeEmail || "";
  els.rulePlan.value = String(state.planDays || 30);
  applyLockUi(locked);
  els.saveBtn.disabled = locked || els.saveBtn.dataset.busy === "1";
  els.refreshBtn.disabled = els.refreshBtn.dataset.busy === "1";

  els.cycleView.textContent = planLabel(state.planDays || 30);
  els.dueTime.textContent = `到期时间：${formatTs(state.dueAt)}`;
  if (state.cloudOnly) {
    els.progressCount.textContent = state.lastKnownNewCount ? "已更新" : "未更新";
  } else {
    els.progressCount.textContent = `${state.lastKnownNewCount || 0} / ${state.requiredVideos || state.planDays || 30}`;
  }
  els.latestTime.textContent = `最近检测：${formatTs(state.lastManualCheckAt || state.lastAutoCheckAt)}`;
  els.emailView.textContent = state.noticeEmail || "-";
  els.latestResult.textContent = `状态：${normalizeRunLogText(state.latestResultText || "待初始化")}`;

  const mode = state.lastStatus || "idle";
  if (locked && mode !== "warn") {
    setPill("load", "配置已锁定");
  } else if (mode === "ok") setPill("ok", "状态正常");
  else if (mode === "warn") setPill("warn", "发现违约");
  else if (mode === "load") setPill("load", "检测中");
  else setPill("idle", "待初始化");

  if (state.lastStatus === "warn" && state.noticeEmail) {
    const reason = state.latestResultText || "违约提醒";
    showAlert(reason, buildMailto(state, reason));
  } else {
    hideAlert();
  }
}

function calcNewCount(currentIds, baselineIds) {
  const baseline = new Set(baselineIds || []);
  let count = 0;
  currentIds.forEach((id) => {
    if (!baseline.has(id)) count += 1;
  });
  return count;
}

function startCycleFrom(state, nowIso, baselineIds) {
  const due = new Date(nowIso);
  due.setDate(due.getDate() + Number(state.planDays || 30));
  return {
    ...state,
    baselineVideoIds: baselineIds,
    cycleStartAt: nowIso,
    dueAt: due.toISOString(),
    lastKnownNewCount: 0,
    lastManualCheckAt: null,
    noticeCycleStartAt: null,
    configLocked: true,
    latestResultText: `已保存新周期：${planLabel(state.planDays)}`,
    lastStatus: "ok",
  };
}

async function triggerBreachNotice(state, reason, byManual) {
  const mailto = buildMailto(state, reason);
  showAlert(reason, mailto);

  const sent = await trySendMail(state, reason);
  if (!sent && byManual) {
    window.open(mailto, "_blank");
    addLog("自动邮件失败，已打开本地邮件客户端兜底发送。\n");
  }

  return {
    ...state,
    lastStatus: "warn",
    latestResultText: reason,
    noticeCycleStartAt: state.cycleStartAt,
    lastNoticeAt: new Date().toISOString(),
  };
}

async function handleSave() {
  const prev = loadState();
  if (isConfigLocked(prev)) {
    addLog("当前周期未到期，配置已锁定，暂不可修改。");
    render(prev);
    return;
  }

  const input = readForm();
  setBusy(true);
  setPill("load", "保存中");
  addLog(`初始化周期：${planLabel(input.planDays)}（云端版）`);
  addLog(`识别到检测链接：${input.douyinUrl}`);

  try {
    const nowIso = new Date().toISOString();
    let state = {
      ...input,
      baselineVideoIds: [],
      cycleStartAt: nowIso,
      dueAt: nowIso,
      lastKnownNewCount: 0,
      lastManualCheckAt: null,
      lastAutoCheckAt: nowIso,
      noticeCycleStartAt: null,
      lastNoticeAt: null,
      configLocked: true,
      cloudOnly: true,
      latestResultText: "初始化完成",
      lastStatus: "ok",
    };

    state = startCycleFrom(state, nowIso, []);
    saveState(state);
    render(state);
    addLog("保存成功（云端版）。不再本地抓抖音，点击“点检测”会同步云端状态。");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setPill("warn", "保存失败");
    addLog(`保存失败: ${msg}`);
  } finally {
    setBusy(false);
  }
}

async function handleManualRefresh() {
  const state = loadState();
  if (!state) {
    addLog("请先点击“保存状态”初始化周期。\n");
    return;
  }

  setBusy(true);
  setPill("load", "检测中");
  addLog("开始手动检测（云端状态同步）...");

  try {
    const cloud = await fetchCloudState();
    const nowIso = new Date().toISOString();
    const cloudResultText = buildCloudResultText(cloud);
    const cloudResult = String(cloud?.cloud_result || "");

    let next = {
      ...state,
      cloudOnly: true,
      lastManualCheckAt: nowIso,
      lastAutoCheckAt: cloud?.last_checked_at || nowIso,
      lastKnownNewCount: cloudResult === "new_video" ? 1 : 0,
      latestResultText: cloudResultText,
      lastStatus: cloudResult === "no_update" ? "warn" : "ok",
    };

    if (cloud.__not_ready) {
      next = {
        ...next,
        lastStatus: "ok",
      };
      addLog("云端状态文件还未生成，已进入等待模式。配置好 Secrets 后到 Actions 手动 Run 一次即可。");
    }

    if (cloud?.account_url) {
      const cloudAccount = normalizeDouyinUrl(String(cloud.account_url));
      const localAccount = normalizeDouyinUrl(state.douyinInput || state.douyinUrl || "");
      if (isAccountMismatch(localAccount, cloudAccount)) {
        next = {
          ...next,
          lastStatus: "warn",
          latestResultText: "云端监控账号与当前输入不一致，请检查云端配置。",
        };
        addLog(`云端账号：${cloudAccount}`);
      }
    }

    saveState(next);
    render(next);
    addLog(next.latestResultText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setPill("warn", "检测失败");
    addLog(`检测失败: ${msg}`);
  } finally {
    setBusy(false);
  }
}

async function autoCheckNoManualDetection() {
  const state = loadState();
  if (!state || !state.dueAt || !state.noticeEmail) return;
  if (state.cloudOnly) return;

  const nowIso = new Date().toISOString();
  const dueReached = new Date(nowIso) >= new Date(state.dueAt);
  if (!dueReached) return;

  const checkedAfterDue =
    state.lastManualCheckAt && new Date(state.lastManualCheckAt) >= new Date(state.dueAt);
  const alreadyNotified = state.noticeCycleStartAt === state.cycleStartAt;

  if (checkedAfterDue || alreadyNotified) return;

  addLog("到期后未点检测，触发违约邮件流程...");
  let next = {
    ...state,
    lastAutoCheckAt: nowIso,
  };

  const reason = "违约：到期后未点击检测";
  next = await triggerBreachNotice(next, reason, false);
  saveState(next);
  render(next);
}

els.saveBtn.addEventListener("click", handleSave);
els.refreshBtn.addEventListener("click", handleManualRefresh);
els.form.addEventListener("input", () => {
  const current = loadState() || {};
  if (isConfigLocked(current)) {
    render(current);
    return;
  }
  current.douyinInput = (els.douyinInput.value || "").trim();
  current.noticeEmail = (els.noticeEmail.value || "").trim();
  current.planDays = Number(els.rulePlan.value || 30);
  current.requiredVideos = current.planDays;
  saveState(current);
  render(current);
});

render(loadState());
autoCheckNoManualDetection();
setInterval(autoCheckNoManualDetection, 60 * 1000);
addLog("云端模式已启用：保存不再本地抓抖音，点检测会同步云端“已更新/未更新”状态。");

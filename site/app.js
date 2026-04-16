const STORAGE_KEY = "douyin-breach-monitor-v4";

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

function addLog(text) {
  els.logBox.textContent += `\n[${ts()}] ${text}`;
  els.logBox.scrollTop = els.logBox.scrollHeight;
}

function setPill(mode, text) {
  els.statusPill.className = `pill ${mode}`;
  els.statusPill.textContent = text;
}

function setBusy(busy) {
  els.saveBtn.dataset.busy = busy ? "1" : "0";
  const state = loadState();
  els.saveBtn.disabled = busy || isConfigLocked(state);
  els.refreshBtn.disabled = busy;
}

function normalizeDouyinUrl(raw) {
  const value = (raw || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return `https://www.douyin.com/user/${encodeURIComponent(value)}`;
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
    return JSON.parse(raw);
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
  const patterns = [
    /\/video\/(\d{8,24})/g,
    /"aweme_id"\s*:\s*"?(\d{8,24})"?/g,
    /awemeId\s*[:=]\s*"?(\d{8,24})"?/g,
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(content);
    while (match) {
      if (match[1]) ids.add(match[1]);
      match = pattern.exec(content);
    }
  }

  return [...ids];
}

async function fetchVideoIds(douyinUrl) {
  const stripped = douyinUrl.replace(/^https?:\/\//i, "");
  const proxyUrl = `https://r.jina.ai/http://${stripped}`;

  const res = await fetch(proxyUrl, {
    method: "GET",
    headers: {
      Accept: "text/plain, text/markdown;q=0.9, */*;q=0.8",
    },
  });

  if (!res.ok) {
    throw new Error(`抓取失败: ${res.status}`);
  }

  const text = await res.text();
  const ids = extractVideoIds(text);

  if (!ids.length) {
    throw new Error("未抓到视频 ID，请改用完整抖音主页链接重试");
  }

  return ids;
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
  els.alertText.textContent = text;
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
    els.progressCount.textContent = "0 / 30";
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

  els.cycleView.textContent = planLabel(state.planDays || 30);
  els.dueTime.textContent = `到期时间：${formatTs(state.dueAt)}`;
  els.progressCount.textContent = `${state.lastKnownNewCount || 0} / ${state.requiredVideos || state.planDays || 30}`;
  els.latestTime.textContent = `最近检测：${formatTs(state.lastManualCheckAt || state.lastAutoCheckAt)}`;
  els.emailView.textContent = state.noticeEmail || "-";
  els.latestResult.textContent = `状态：${state.latestResultText || "待初始化"}`;

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
  addLog(`初始化周期：${planLabel(input.planDays)}，开始抓取基准视频...`);

  try {
    const ids = await fetchVideoIds(input.douyinUrl);
    const nowIso = new Date().toISOString();

    let state = {
      ...input,
      baselineVideoIds: ids,
      cycleStartAt: nowIso,
      dueAt: nowIso,
      lastKnownNewCount: 0,
      lastManualCheckAt: null,
      lastAutoCheckAt: nowIso,
      noticeCycleStartAt: null,
      lastNoticeAt: null,
      configLocked: true,
      latestResultText: "初始化完成",
      lastStatus: "ok",
    };

    state = startCycleFrom(state, nowIso, ids);
    saveState(state);
    render(state);
    addLog(`保存成功，基准样本 ${ids.length} 条。到期后请点“检测”。`);
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
  addLog("开始手动检测...");

  try {
    const nowIso = new Date().toISOString();
    const ids = await fetchVideoIds(state.douyinUrl || normalizeDouyinUrl(state.douyinInput));
    const newCount = calcNewCount(ids, state.baselineVideoIds || []);

    let next = {
      ...state,
      lastManualCheckAt: nowIso,
      lastAutoCheckAt: nowIso,
      lastKnownNewCount: newCount,
    };

    const dueReached = new Date(nowIso) >= new Date(state.dueAt);

    if (!dueReached) {
      next.lastStatus = "ok";
      next.latestResultText = `未到期，当前新增 ${newCount}/${state.requiredVideos}`;
      saveState(next);
      render(next);
      addLog(next.latestResultText);
      return;
    }

    if (newCount >= state.requiredVideos) {
      addLog(`到期检测通过：${newCount}/${state.requiredVideos}，自动开启下一周期。`);
      next = startCycleFrom(next, nowIso, ids);
      saveState(next);
      render(next);
      return;
    }

    const reason = `违约：到期检测仅 ${newCount}/${state.requiredVideos}`;
    next = await triggerBreachNotice(next, reason, true);
    saveState(next);
    render(next);
    addLog(reason);
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
addLog("规则已启用：7天7条 / 15天15条 / 30天30条。到期未点检测也会触发提醒。");

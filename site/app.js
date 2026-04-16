const STORAGE_KEY = "douyin-breach-monitor-v3";

const els = {
  form: document.getElementById("monitorForm"),
  douyinInput: document.getElementById("douyinInput"),
  noticeEmail: document.getElementById("noticeEmail"),
  breachHours: document.getElementById("breachHours"),
  saveBtn: document.getElementById("saveBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  statusPill: document.getElementById("statusPill"),
  baselineVideo: document.getElementById("baselineVideo"),
  baselineTime: document.getElementById("baselineTime"),
  latestResult: document.getElementById("latestResult"),
  latestTime: document.getElementById("latestTime"),
  emailView: document.getElementById("emailView"),
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
  els.saveBtn.disabled = busy;
  els.refreshBtn.disabled = busy;
}

function normalizeDouyinUrl(raw) {
  const value = (raw || "").trim();
  if (!value) return "";

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  return `https://www.douyin.com/user/${encodeURIComponent(value)}`;
}

function pickVideoId(content) {
  const patterns = [
    /\/video\/(\d{8,24})/g,
    /"aweme_id"\s*:\s*"?(\d{8,24})"?/g,
    /awemeId\s*[:=]\s*"?(\d{8,24})"?/g,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (match && match[1]) {
      return match[1];
    }
  }

  return "";
}

async function fetchLatestVideoId(douyinUrl) {
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
  const videoId = pickVideoId(text);

  if (!videoId) {
    throw new Error("未识别到视频 ID，建议改用完整抖音主页链接再试");
  }

  return {
    videoId,
    proxyUrl,
  };
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

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function formatAgo(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

function render(state) {
  if (!state) {
    els.baselineVideo.textContent = "未保存";
    els.baselineTime.textContent = "-";
    els.latestResult.textContent = "未检测";
    els.latestTime.textContent = "-";
    els.emailView.textContent = "-";
    setPill("idle", "待初始化");
    return;
  }

  els.douyinInput.value = state.douyinInput || "";
  els.noticeEmail.value = state.noticeEmail || "";
  els.breachHours.value = String(state.breachHours || 24);

  els.baselineVideo.textContent = state.baselineVideoId || "未识别";
  els.baselineTime.textContent = formatAgo(state.baselineSavedAt);

  els.latestResult.textContent = state.latestResultText || "未检测";
  els.latestTime.textContent = formatAgo(state.latestCheckedAt);
  els.emailView.textContent = state.noticeEmail || "-";

  const status = state.lastStatus || "idle";
  if (status === "ok") {
    setPill("ok", "状态正常");
  } else if (status === "warn") {
    setPill("warn", "发现违约");
  } else if (status === "load") {
    setPill("load", "检测中");
  } else {
    setPill("idle", "待初始化");
  }
}

function readForm() {
  const douyinInput = (els.douyinInput.value || "").trim();
  const noticeEmail = (els.noticeEmail.value || "").trim();
  const breachHours = Number(els.breachHours.value || 24);

  if (!douyinInput) {
    throw new Error("请先输入抖音号或抖音主页链接");
  }
  if (!noticeEmail) {
    throw new Error("请先输入通知邮箱");
  }
  if (!Number.isFinite(breachHours) || breachHours <= 0) {
    throw new Error("违约阈值必须大于 0 小时");
  }

  return {
    douyinInput,
    noticeEmail,
    breachHours,
    douyinUrl: normalizeDouyinUrl(douyinInput),
  };
}

function buildMailto(state, reason) {
  const subject = encodeURIComponent(`[抖音违约提醒] ${new Date().toLocaleDateString("zh-CN")}`);
  const body = encodeURIComponent(
    `触发原因: ${reason}\n抖音: ${state.douyinInput}\n基准视频: ${state.baselineVideoId || "未识别"}\n最近检测时间: ${formatAgo(state.latestCheckedAt)}\n` +
      `请尽快更新内容。`
  );
  return `mailto:${state.noticeEmail}?subject=${subject}&body=${body}`;
}

async function trySendNoticeByFormSubmit(state, reason) {
  const endpoint = `https://formsubmit.co/ajax/${encodeURIComponent(state.noticeEmail)}`;
  const payload = {
    _subject: `[抖音违约提醒] ${new Date().toLocaleDateString("zh-CN")}`,
    name: "抖音违约监测台",
    message: `触发原因: ${reason}\n抖音: ${state.douyinInput}\n基准视频: ${state.baselineVideoId || "未识别"}\n最近检测时间: ${formatAgo(state.latestCheckedAt)}`,
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
      addLog("已尝试发送违约邮件（FormSubmit）。");
      return true;
    }

    addLog(`自动邮件通道未确认成功: ${data.message || res.status}`);
    return false;
  } catch (err) {
    addLog(`自动邮件通道异常: ${String(err)}`);
    return false;
  }
}

async function handleSave() {
  const input = readForm();
  setBusy(true);
  setPill("load", "保存中");
  addLog(`开始保存基准状态: ${input.douyinUrl}`);

  try {
    const latest = await fetchLatestVideoId(input.douyinUrl);

    const state = {
      ...input,
      baselineVideoId: latest.videoId,
      baselineSavedAt: new Date().toISOString(),
      latestVideoId: latest.videoId,
      latestCheckedAt: new Date().toISOString(),
      latestResultText: "已保存基准",
      lastStatus: "ok",
      lastNoticeAt: null,
    };

    saveState(state);
    render(state);
    addLog(`保存成功。基准视频 ID: ${latest.videoId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setPill("warn", "保存失败");
    addLog(`保存失败: ${msg}`);
  } finally {
    setBusy(false);
  }
}

async function handleRefresh() {
  const existing = loadState();
  if (!existing) {
    addLog("请先点击“保存状态”建立基准。\n");
    return;
  }

  setBusy(true);
  setPill("load", "刷新中");
  addLog("开始刷新状态...");

  try {
    const latest = await fetchLatestVideoId(existing.douyinUrl || normalizeDouyinUrl(existing.douyinInput));
    const nowIso = new Date().toISOString();

    const elapsedMs = new Date(nowIso).getTime() - new Date(existing.baselineSavedAt || nowIso).getTime();
    const elapsedHours = elapsedMs / (1000 * 60 * 60);
    const threshold = Number(existing.breachHours || 24);

    const noUpdate = latest.videoId === existing.baselineVideoId;
    const isBreach = noUpdate && elapsedHours >= threshold;

    const next = {
      ...existing,
      latestVideoId: latest.videoId,
      latestCheckedAt: nowIso,
      lastStatus: isBreach ? "warn" : "ok",
      latestResultText: isBreach
        ? `违约：${threshold} 小时内未更新`
        : noUpdate
        ? `未违约：仍未更新，但未到 ${threshold} 小时阈值`
        : "状态正常：检测到新视频",
    };

    if (!noUpdate) {
      next.baselineVideoId = latest.videoId;
      next.baselineSavedAt = nowIso;
      addLog(`检测到新视频，基准已自动更新为 ${latest.videoId}`);
    }

    if (isBreach) {
      const today = nowIso.slice(0, 10);
      const lastNoticeDay = (existing.lastNoticeAt || "").slice(0, 10);

      if (today !== lastNoticeDay) {
        const reason = `${threshold} 小时未更新`; 
        const sent = await trySendNoticeByFormSubmit(next, reason);
        if (!sent) {
          const mailto = buildMailto(next, reason);
          window.open(mailto, "_blank");
          addLog("已打开本地邮件客户端作为兜底发送方式。");
        }
        next.lastNoticeAt = nowIso;
      } else {
        addLog("今天已发送过违约通知，跳过重复发送。");
      }
    }

    saveState(next);
    render(next);
    addLog(`刷新完成: ${next.latestResultText}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setPill("warn", "刷新失败");
    addLog(`刷新失败: ${msg}`);
  } finally {
    setBusy(false);
  }
}

els.saveBtn.addEventListener("click", handleSave);
els.refreshBtn.addEventListener("click", handleRefresh);
els.form.addEventListener("input", () => {
  const state = loadState() || {};
  state.douyinInput = els.douyinInput.value.trim();
  state.noticeEmail = els.noticeEmail.value.trim();
  state.breachHours = Number(els.breachHours.value || 24);
  saveState(state);
  render(state);
});

render(loadState());
addLog("你可以先输入抖音号与邮箱，然后点击“保存状态”。");

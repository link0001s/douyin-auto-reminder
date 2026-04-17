const STORAGE_KEY = "douyin-breach-monitor-v4";
const CLOUD_STATE_URL = "https://raw.githubusercontent.com/link0001s/douyin-auto-reminder/main/state.json";
const FORMSUBMIT_ACTIVATED_INBOX = "2879154754@qq.com";
const UNLOCK_TAP_TARGET = 5;
const UNLOCK_TAP_WINDOW_MS = 5000;
const DRAGON_TAP_TARGET = 5;
const DRAGON_TAP_WINDOW_MS = 5000;
const EVIDENCE_MAX_EDGE = 960;
const EVIDENCE_MIN_MAX_SIDE = 420;
const EVIDENCE_MAX_BYTES = 180 * 1024;
const EVIDENCE_MAX_COUNT = 5;

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
  dragonBreachChip: document.getElementById("dragonBreachChip"),
  wolfUnlockChip: document.getElementById("wolfUnlockChip"),
  evidenceImageInput: document.getElementById("evidenceImageInput"),
  evidencePickBtn: document.getElementById("evidencePickBtn"),
  evidenceClearBtn: document.getElementById("evidenceClearBtn"),
  evidenceHint: document.getElementById("evidenceHint"),
  evidencePreview: document.getElementById("evidencePreview"),
  deerGuardBtn: document.getElementById("deerGuardBtn"),
  deerLockChip: document.getElementById("deerLockChip"),
};

let unlockTapCount = 0;
let unlockTapDeadline = 0;
let dragonTapCount = 0;
let dragonTapDeadline = 0;
let dragonTapBusy = false;

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
  const locked = isConfigLocked(state);
  els.saveBtn.disabled = busy || locked;
  els.refreshBtn.disabled = busy;
  syncEvidenceButtonsWithSaveState();
}

function syncEvidenceButtonsWithSaveState() {
  const saveDisabled = Boolean(els.saveBtn?.disabled);
  if (els.evidencePickBtn) {
    els.evidencePickBtn.disabled = saveDisabled;
  }
  if (els.evidenceClearBtn) {
    els.evidenceClearBtn.disabled = saveDisabled;
  }
}

function estimateDataUrlBytes(dataUrl) {
  const base64 = String(dataUrl || "").split(",")[1] || "";
  return Math.floor((base64.length * 3) / 4);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("解析图片失败"));
    img.src = dataUrl;
  });
}

function sanitizeEvidenceName(name) {
  const raw = String(name || "evidence-image").replace(/\.[^.]+$/, "");
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned || "evidence-image";
}

function buildEvidenceName(originalName, mime) {
  const base = sanitizeEvidenceName(originalName);
  const low = String(mime || "").toLowerCase();
  const ext = low.includes("png") ? "png" : low.includes("jpeg") || low.includes("jpg") ? "jpg" : "jpg";
  return `${base}.${ext}`;
}

async function optimizeEvidenceImage(file) {
  const source = await readFileAsDataUrl(file);
  const img = await loadImageFromDataUrl(source);
  const maxSide = Math.max(img.width, img.height) || 1;
  const scale = Math.min(1, EVIDENCE_MAX_EDGE / maxSide);
  let width = Math.max(1, Math.round(img.width * scale));
  let height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  let preferredMime = "image/jpeg";
  try {
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const testWebp = canvas.toDataURL("image/webp", 0.8);
    if (testWebp.startsWith("data:image/webp")) {
      preferredMime = "image/webp";
    }
  } catch {
    preferredMime = "image/jpeg";
  }

  let dataUrl = "";
  let bytes = Infinity;
  for (let scaleStep = 0; scaleStep < 8; scaleStep += 1) {
    canvas.width = Math.max(1, width);
    canvas.height = Math.max(1, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("图片处理失败");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    let quality = 0.86;
    for (let i = 0; i < 10; i += 1) {
      dataUrl = canvas.toDataURL(preferredMime, quality);
      bytes = estimateDataUrlBytes(dataUrl);
      if (bytes <= EVIDENCE_MAX_BYTES) break;
      quality = Math.max(0.32, quality - 0.07);
    }

    if (bytes <= EVIDENCE_MAX_BYTES) break;
    const currentMaxSide = Math.max(width, height);
    if (currentMaxSide <= EVIDENCE_MIN_MAX_SIDE) break;
    width = Math.max(1, Math.round(width * 0.84));
    height = Math.max(1, Math.round(height * 0.84));
  }

  if (!dataUrl || bytes > EVIDENCE_MAX_BYTES) {
    throw new Error("图片过大，请换一张更小的图片");
  }

  const mime = (String(dataUrl).match(/^data:([^;]+);/) || [])[1] || preferredMime;
  return {
    dataUrl,
    bytes,
    mime,
    fileName: buildEvidenceName(file.name || "evidence-image", mime),
  };
}

function dataUrlToBlob(dataUrl) {
  const raw = String(dataUrl || "");
  const match = raw.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error("图片数据无效");
  }
  const mime = match[1] || "image/webp";
  const base64 = match[2] || "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return {
    blob: new Blob([bytes], { type: mime }),
    mime,
  };
}

function canvasToJpegBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("图片转码失败"));
          return;
        }
        resolve(blob);
      },
      "image/jpeg",
      quality
    );
  });
}

function toFileLike(blob, fileName, mime) {
  const type = String(mime || blob?.type || "application/octet-stream");
  const safeName = String(fileName || "evidence.jpg");
  try {
    return new File([blob], safeName, { type });
  } catch {
    return blob;
  }
}

async function ensureEmailAttachmentFromDataUrl(dataUrl, originalName) {
  const parsed = dataUrlToBlob(dataUrl);
  const lowMime = String(parsed.mime || "").toLowerCase();
  if (!lowMime.includes("webp")) {
    return {
      blob: parsed.blob,
      mime: parsed.mime,
      fileName: buildEvidenceName(originalName || "evidence-image", parsed.mime),
    };
  }

  try {
    const img = await loadImageFromDataUrl(dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = img.width || 1;
    canvas.height = img.height || 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("图片处理失败");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToJpegBlob(canvas, 0.9);
    return {
      blob,
      mime: "image/jpeg",
      fileName: buildEvidenceName(originalName || "evidence-image", "image/jpeg"),
    };
  } catch {
    return {
      blob: parsed.blob,
      mime: parsed.mime,
      fileName: buildEvidenceName(originalName || "evidence-image", parsed.mime),
    };
  }
}

function normalizeEvidenceItem(raw, fallbackName = "evidence-image") {
  if (!raw || typeof raw !== "object") return null;
  const dataUrl = String(raw.dataUrl || raw.evidenceImageDataUrl || "").trim();
  if (!dataUrl.startsWith("data:image/")) return null;
  const detectedMime = (String(dataUrl).match(/^data:([^;]+);/) || [])[1] || "image/jpeg";
  const mime = String(raw.mime || raw.evidenceImageMime || detectedMime);
  const fileName = buildEvidenceName(raw.fileName || raw.evidenceImageName || fallbackName, mime);
  const bytes = Number(raw.bytes || raw.evidenceImageBytes || estimateDataUrlBytes(dataUrl));
  const updatedAt = String(raw.updatedAt || raw.evidenceImageUpdatedAt || new Date().toISOString());
  return { dataUrl, fileName, mime, bytes, updatedAt };
}

function getEvidenceImages(state) {
  const fromList = [];
  if (Array.isArray(state?.evidenceImages)) {
    state.evidenceImages.forEach((item, index) => {
      if (fromList.length >= EVIDENCE_MAX_COUNT) return;
      const normalized = normalizeEvidenceItem(item, `evidence-image-${index + 1}`);
      if (normalized) fromList.push(normalized);
    });
  }
  if (fromList.length) return fromList;

  if (state?.evidenceImageDataUrl) {
    const normalized = normalizeEvidenceItem(state, "evidence-image-1");
    return normalized ? [normalized] : [];
  }
  return [];
}

function applyEvidenceImages(state, images) {
  const next = { ...(state || {}) };
  const normalized = [];
  (images || []).forEach((item, index) => {
    if (normalized.length >= EVIDENCE_MAX_COUNT) return;
    const parsed = normalizeEvidenceItem(item, `evidence-image-${index + 1}`);
    if (parsed) normalized.push(parsed);
  });

  if (!normalized.length) {
    delete next.evidenceImages;
    delete next.evidenceImageDataUrl;
    delete next.evidenceImageName;
    delete next.evidenceImageMime;
    delete next.evidenceImageBytes;
    delete next.evidenceImageUpdatedAt;
    return next;
  }

  next.evidenceImages = normalized;
  const first = normalized[0];
  // 兼容历史字段，避免旧逻辑读不到图片。
  next.evidenceImageDataUrl = first.dataUrl;
  next.evidenceImageName = first.fileName;
  next.evidenceImageMime = first.mime;
  next.evidenceImageBytes = first.bytes;
  next.evidenceImageUpdatedAt = first.updatedAt;
  return next;
}

function renderEvidence(state) {
  if (
    !els.evidenceHint ||
    !els.evidencePreview ||
    !els.evidenceClearBtn ||
    !els.evidencePickBtn
  ) {
    return;
  }

  const images = getEvidenceImages(state);
  const locked = isConfigLocked(state);
  if (!images.length) {
    els.evidenceHint.textContent = locked ? "配置已锁定，违约图片不可更改。" : "未插入图片，违约邮件只发送文字（最多支持5张）。";
    els.evidencePreview.classList.add("hidden");
    els.evidencePreview.textContent = "";
    return;
  }

  els.evidenceHint.textContent = locked
    ? `已插入图片：${images.length}/${EVIDENCE_MAX_COUNT}（已随保存状态锁定）`
    : `已插入图片：${images.length}/${EVIDENCE_MAX_COUNT}`;

  const fileRow = document.createElement("div");
  fileRow.className = "evidence-file-row";
  let openIndex = -1;
  const imageWrap = document.createElement("div");
  imageWrap.className = "evidence-inline-image hidden";
  const img = document.createElement("img");
  img.alt = "";
  imageWrap.appendChild(img);

  images.forEach((item, index) => {
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "evidence-preview-trigger";
    trigger.textContent = `文件${index + 1}`;
    trigger.title = item.fileName || `文件${index + 1}`;

    trigger.addEventListener("click", () => {
      if (openIndex === index) {
        openIndex = -1;
        imageWrap.classList.add("hidden");
        img.src = "";
        img.alt = "";
        fileRow.querySelectorAll(".evidence-preview-trigger").forEach((btn) => btn.classList.remove("is-active"));
        return;
      }

      openIndex = index;
      img.src = item.dataUrl;
      img.alt = item.fileName || `文件${index + 1}`;
      imageWrap.classList.remove("hidden");
      imageWrap.classList.remove("compact");
      fileRow.querySelectorAll(".evidence-preview-trigger").forEach((btn, btnIndex) => {
        btn.classList.toggle("is-active", btnIndex === index);
      });
      imageWrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });

    fileRow.appendChild(trigger);
  });

  els.evidencePreview.replaceChildren(fileRow, imageWrap);
  els.evidencePreview.classList.remove("hidden");
}

function handlePickEvidenceImage() {
  if (!els.evidenceImageInput) return;
  const state = loadState();
  if (isConfigLocked(state)) {
    addLog("配置已锁定，违约图片不可更改。");
    return;
  }
  els.evidenceImageInput.click();
}

async function handleEvidenceImageChange(event) {
  const target = event?.target;
  const files = Array.from(target?.files || []);
  if (!files.length) return;

  const state = loadState();
  if (isConfigLocked(state)) {
    addLog("配置已锁定，违约图片不可更改。");
    target.value = "";
    return;
  }

  const current = loadState() || {};
  const existingImages = getEvidenceImages(current);
  const freeSlots = EVIDENCE_MAX_COUNT - existingImages.length;
  if (freeSlots <= 0) {
    addLog(`违约图片最多支持 ${EVIDENCE_MAX_COUNT} 张，请先移除后再添加。`);
    target.value = "";
    return;
  }

  const queue = files.slice(0, freeSlots);
  if (files.length > queue.length) {
    addLog(`最多还能添加 ${freeSlots} 张，其余 ${files.length - queue.length} 张已忽略。`);
  }

  const added = [];
  let failCount = 0;
  for (const file of queue) {
    if (!String(file.type || "").startsWith("image/")) {
      failCount += 1;
      addLog(`图片插入失败：${file.name || "未知文件"} 不是图片`);
      continue;
    }

    try {
      const packed = await optimizeEvidenceImage(file);
      added.push({
        dataUrl: packed.dataUrl,
        fileName: packed.fileName,
        mime: packed.mime,
        bytes: packed.bytes,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      failCount += 1;
      const msg = err instanceof Error ? err.message : String(err);
      addLog(`图片插入失败：${file.name || "未知文件"} - ${msg}`);
    }
  }

  if (added.length) {
    const next = applyEvidenceImages(current, [...existingImages, ...added]);
    const saved = saveState(next);
    if (saved) {
      render(next);
      addLog(`图片插入成功：新增 ${added.length} 张，当前 ${getEvidenceImages(next).length}/${EVIDENCE_MAX_COUNT}`);
    } else {
      render(current);
      addLog("提醒：本次新增图片未保存，请先移除部分图片后再重试。");
    }
  }
  if (!added.length && failCount) {
    addLog("本次没有可用图片被保存。");
  }

  target.value = "";
}

function handleEvidenceImageClear() {
  const current = loadState() || {};
  if (isConfigLocked(current)) {
    addLog("配置已锁定，违约图片不可更改。");
    return;
  }
  if (!getEvidenceImages(current).length) {
    addLog("当前没有可移除的违约图片。");
    return;
  }

  const next = applyEvidenceImages(current, []);
  if (saveState(next)) {
    render(next);
    addLog("已移除违约图片。");
  } else {
    addLog("提醒：移除图片时本地状态写入有问题，请刷新页面后重试。");
  }
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

function resolveBreachNotifyEmail(state) {
  return String(state?.noticeEmail || "").trim().toLowerCase();
}

function isConfigLocked(state) {
  if (!state || !state.configLocked || !state.dueAt) return false;
  return new Date() < new Date(state.dueAt);
}

function isDeerHardLockActive(state) {
  return Boolean(state?.deerHardLock) && isConfigLocked(state);
}

function syncDeerGuardUi(state) {
  const armed = isDeerHardLockActive(state);
  [els.deerGuardBtn, els.deerLockChip].forEach((el) => {
    if (!el) return;
    el.classList.toggle("lock-armed", armed);
    el.title = armed ? "鹿锁已启用：必须等周期结束" : "启用鹿锁：本周期不可狼头解锁";
  });
}

function activateDeerHardLock(source) {
  const state = loadState();
  if (!state) {
    addLog("请先点击“保存状态”后再启用鹿锁。");
    return;
  }
  if (!isConfigLocked(state)) {
    addLog("当前不在锁定周期，鹿锁无需启用。");
    return;
  }
  if (isDeerHardLockActive(state)) {
    addLog("鹿锁已启用，本周期必须等到到期。");
    return;
  }

  const next = {
    ...state,
    deerHardLock: true,
    latestResultText: "已启用鹿锁：本周期仅能到期解锁",
    lastStatus: state.lastStatus || "ok",
  };
  saveState(next);
  render(next);
  addLog(source === "deer" ? "已启用鹿锁，狼头解锁已禁用。" : "鹿锁已启用。");
}

function applyLockUi(locked) {
  els.douyinInput.disabled = locked;
  els.noticeEmail.disabled = locked;
  els.rulePlan.disabled = locked;
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (err) {
    console.error("[saveState] localStorage 写入失败：", err);
    addLog("提示：本地存储空间已接近上限，请先移除部分违约图片后再试。");
    return false;
  }
}

function resetUnlockTapProgress() {
  unlockTapCount = 0;
  unlockTapDeadline = 0;
}

function resetDragonTapProgress() {
  dragonTapCount = 0;
  dragonTapDeadline = 0;
}

function unlockConfigLock(successText) {
  const state = loadState();
  if (!isConfigLocked(state)) {
    resetUnlockTapProgress();
    return false;
  }
  if (isDeerHardLockActive(state)) {
    addLog("鹿锁已启用，必须等到规划周期结束后才可解锁。");
    resetUnlockTapProgress();
    return false;
  }

  const unlockedState = {
    ...state,
    configLocked: false,
    latestResultText: "已解除锁定，可重新保存状态",
    lastStatus: "ok",
  };

  saveState(unlockedState);
  render(unlockedState);
  addLog(successText || "配置已解除锁定");
  resetUnlockTapProgress();
  return true;
}

function handleStatusPillUnlockTap() {
  const state = loadState();
  if (!isConfigLocked(state)) {
    resetUnlockTapProgress();
    return;
  }

  const now = Date.now();
  if (now > unlockTapDeadline) {
    unlockTapCount = 0;
  }

  unlockTapCount += 1;
  unlockTapDeadline = now + UNLOCK_TAP_WINDOW_MS;

  if (unlockTapCount < UNLOCK_TAP_TARGET) {
    const remaining = UNLOCK_TAP_TARGET - unlockTapCount;
    addLog(`隐藏解锁：再点 ${remaining} 次可解除锁定`);
    return;
  }

  unlockConfigLock("已连点5次，配置已解除锁定");
}

function handleWolfUnlockTap() {
  unlockConfigLock("点击狼头，配置已解除锁定");
}

function handleDeerGuardClick() {
  activateDeerHardLock("button");
}

function handleDeerLockChipClick() {
  activateDeerHardLock("deer");
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (state && typeof state === "object" && !Object.prototype.hasOwnProperty.call(state, "cloudOnly")) {
      state.cloudOnly = true;
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
  const breachEmail = resolveBreachNotifyEmail(state);
  const subject = encodeURIComponent(`[抖音违约提醒] ${new Date().toLocaleDateString("zh-CN")}`);
  const evidenceNames = getEvidenceImages(state).map((item) => item.fileName);
  const imageLine = evidenceNames.length
    ? `违约图片: ${evidenceNames.join("、")}（自动邮件通道会尝试附图）\n`
    : "";
  const body = encodeURIComponent(
    `触发原因: ${reason}\n规则: ${planLabel(state.planDays)}\n抖音: ${state.douyinInput}\n` +
      imageLine +
      `本周期新增: ${state.lastKnownNewCount || 0}/${state.requiredVideos}\n` +
      `周期开始: ${formatTs(state.cycleStartAt)}\n周期截止: ${formatTs(state.dueAt)}\n`
  );
  return `mailto:${breachEmail}?subject=${subject}&body=${body}`;
}

async function trySendMail(state, reason) {
  const breachEmail = resolveBreachNotifyEmail(state);
  const directEndpoint = `https://formsubmit.co/${encodeURIComponent(FORMSUBMIT_ACTIVATED_INBOX)}`;
  const evidenceImages = getEvidenceImages(state);
  const evidenceNames = evidenceImages.map((item) => item.fileName);

  const message =
    `触发原因: ${reason}\n规则: ${planLabel(state.planDays)}\n抖音: ${state.douyinInput}\n` +
    `${evidenceNames.length ? `违约图片: ${evidenceNames.join("、")}\n` : ""}` +
    `本周期新增: ${state.lastKnownNewCount || 0}/${state.requiredVideos}\n` +
    `周期开始: ${formatTs(state.cycleStartAt)}\n周期截止: ${formatTs(state.dueAt)}`;

  const buildBaseForm = () => {
    const form = new FormData();
    form.append("_subject", `[抖音违约提醒] ${new Date().toLocaleDateString("zh-CN")}`);
    form.append("name", "抖音违约监测台");
    form.append("message", message);
    form.append("_template", "box");
    form.append("_captcha", "false");
    if (breachEmail && breachEmail !== FORMSUBMIT_ACTIVATED_INBOX) {
      form.append("_cc", breachEmail);
    }
    return form;
  };

  const evidencePacks = [];
  for (const image of evidenceImages) {
    try {
      const packed = await ensureEmailAttachmentFromDataUrl(image.dataUrl, image.fileName || "evidence-image");
      evidencePacks.push(packed);
    } catch {
      addLog(`违约图片解析失败：${image.fileName || "未知图片"}，已跳过该图片。`);
    }
  }

  try {
    const form = buildBaseForm();
    if (evidencePacks.length) {
      evidencePacks.forEach((pack) => {
        const directFile = toFileLike(pack.blob, pack.fileName, pack.mime);
        form.append("attachment", directFile, pack.fileName);
      });
    }

    const res = await fetch(directEndpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
      },
      body: form,
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      addLog(`自动邮件通道返回异常：${res.status} ${data.message || ""}`);
      return false;
    }

    if (data.message && (data.message.toLowerCase().includes("needs activation") || data.message.toLowerCase().includes("activate"))) {
      addLog("邮箱未激活：请到该邮箱收件箱/垃圾箱，点击 FormSubmit 的“Activate Form”链接后再发。");
      return false;
    }

    if (data.success === "true") {
      const ccTip = breachEmail && breachEmail !== FORMSUBMIT_ACTIVATED_INBOX ? `（已抄送到 ${breachEmail}）` : "";
      addLog(
        evidencePacks.length
          ? `违约邮件已发送（图片附件 ${evidencePacks.length} 张）${ccTip}。`
          : `违约邮件已发送${ccTip}。`
      );
      return true;
    }

    addLog("邮件通道已提交，但未拿到明确成功回执。");
    return false;
  } catch (err) {
    addLog(`自动邮件通道发送失败（可能是网络拦截或图片过大）: ${String(err)}`);
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
    syncEvidenceButtonsWithSaveState();
    syncDeerGuardUi(null);
    hideAlert();
    renderEvidence(null);
    return;
  }

  const locked = isConfigLocked(state);

  els.douyinInput.value = state.douyinInput || "";
  els.noticeEmail.value = state.noticeEmail || "";
  els.rulePlan.value = String(state.planDays || 30);
  applyLockUi(locked);
  els.saveBtn.disabled = locked || els.saveBtn.dataset.busy === "1";
  els.refreshBtn.disabled = els.refreshBtn.dataset.busy === "1";
  syncEvidenceButtonsWithSaveState();
  syncDeerGuardUi(state);

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

  renderEvidence(state);
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
  addLog(`违约通知邮箱：${resolveBreachNotifyEmail(state)}`);
  const evidenceNames = getEvidenceImages(state).map((item) => item.fileName);
  if (evidenceNames.length) {
    addLog(`违约图片已加入邮件：${evidenceNames.join("、")}`);
  }
  showAlert(reason, mailto);

  const sent = await trySendMail(state, reason);
  if (!sent && byManual) {
    addLog("自动邮件失败，请查看控制台报错后重试；或点击页面中的邮件按钮手动发送。\n");
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
    if (isDeerHardLockActive(prev)) {
      addLog("鹿锁已启用，本周期必须等到到期后才可修改。");
    } else {
      addLog("当前周期未到期，配置已锁定，暂不可修改。");
    }
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
    const evidenceSeed = applyEvidenceImages({}, getEvidenceImages(prev));
    let state = {
      ...input,
      ...evidenceSeed,
      baselineVideoIds: [],
      cycleStartAt: nowIso,
      dueAt: nowIso,
      lastKnownNewCount: 0,
      lastManualCheckAt: null,
      lastAutoCheckAt: nowIso,
      noticeCycleStartAt: null,
      lastNoticeAt: null,
      configLocked: true,
      deerHardLock: false,
      cloudOnly: true,
      latestResultText: "初始化完成",
      lastStatus: "ok",
    };

    state = startCycleFrom(state, nowIso, []);
    if (!saveState(state)) {
      throw new Error("本地空间不足，保存状态未完成。请先移除部分违约图片后重试。");
    }
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
    let mismatchDetected = false;

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
        mismatchDetected = true;
        next = {
          ...next,
          lastStatus: "warn",
          latestResultText: "云端监控账号与当前输入不一致，请检查云端配置。",
        };
        addLog(`云端账号：${cloudAccount}`);
      }
    }

    const alreadyNotified = next.noticeCycleStartAt === next.cycleStartAt;
    if (cloudResult === "no_update" && !mismatchDetected && !alreadyNotified) {
      next = await triggerBreachNotice(next, `违约：${planLabel(next.planDays || 30)}检测未达标`, false);
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

async function handleDragonBreachTap() {
  if (dragonTapBusy) return;

  const state = loadState();
  if (!state) {
    addLog("请先点击“保存状态”初始化配置后再使用龙头快捷发送。");
    resetDragonTapProgress();
    return;
  }
  if (!state.noticeEmail) {
    addLog("请先填写违约通知邮箱。");
    resetDragonTapProgress();
    return;
  }
  if (!getEvidenceImages(state).length) {
    addLog("请先插入违约图片，再使用龙头快捷发送。");
    resetDragonTapProgress();
    return;
  }

  const now = Date.now();
  if (now > dragonTapDeadline) {
    dragonTapCount = 0;
  }

  dragonTapCount += 1;
  dragonTapDeadline = now + DRAGON_TAP_WINDOW_MS;

  if (dragonTapCount < DRAGON_TAP_TARGET) {
    const remaining = DRAGON_TAP_TARGET - dragonTapCount;
    addLog(`龙头快捷发送：再点 ${remaining} 次将直接发送违约图片。`);
    return;
  }

  resetDragonTapProgress();
  dragonTapBusy = true;
  addLog("龙头五连点已触发，开始发送违约图片...");

  try {
    const next = await triggerBreachNotice(state, "违约：龙头五连点手动触发", true);
    saveState(next);
    render(next);
    addLog("龙头快捷发送完成。");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addLog(`龙头快捷发送失败: ${msg}`);
  } finally {
    dragonTapBusy = false;
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
els.statusPill.addEventListener("click", handleStatusPillUnlockTap);
if (els.wolfUnlockChip) {
  els.wolfUnlockChip.addEventListener("click", handleWolfUnlockTap);
}
if (els.deerGuardBtn) {
  els.deerGuardBtn.addEventListener("click", handleDeerGuardClick);
}
if (els.deerLockChip) {
  els.deerLockChip.addEventListener("click", handleDeerLockChipClick);
}
if (els.dragonBreachChip) {
  els.dragonBreachChip.addEventListener("click", handleDragonBreachTap);
}
if (els.evidencePickBtn) {
  els.evidencePickBtn.addEventListener("click", handlePickEvidenceImage);
}
if (els.evidenceImageInput) {
  els.evidenceImageInput.addEventListener("change", handleEvidenceImageChange);
}
if (els.evidenceClearBtn) {
  els.evidenceClearBtn.addEventListener("click", handleEvidenceImageClear);
}
if (els.evidencePreview) {
  // 兜底：无论预览区里是否出现旧版 <a>，都不允许跳转到新页面
  els.evidencePreview.addEventListener(
    "click",
    (event) => {
      event.preventDefault();
    },
    true
  );
}
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

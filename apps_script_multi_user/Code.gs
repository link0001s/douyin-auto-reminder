const APP_NAME = "Link's Update Monitor";
const SHEET_NAME = "monitors";
const DEFAULT_TZ = "Asia/Shanghai";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const HEADERS = [
  "monitorId",
  "createdAt",
  "updatedAt",
  "douyinInput",
  "noticeEmail",
  "planDays",
  "requiredVideos",
  "cycleStartAt",
  "dueAt",
  "configLocked",
  "lastManualCheckAt",
  "lastAutoCheckAt",
  "lastKnownNewCount",
  "lastStatus",
  "latestResultText",
  "noticeCycleStartAt",
  "lastNoticeAt",
  "lastSeenVideoId",
  "lastSeenTitle",
  "lastSeenUrl",
  "lastSeenPublishedAt",
  "lastFetchError",
];

function doGet() {
  return HtmlService.createHtmlOutputFromFile("Index").setTitle(APP_NAME);
}

function apiSaveMonitor(payload) {
  return withLock_(function () {
    const data = payload || {};
    const nowIso = new Date().toISOString();
    const monitorId = String(data.monitorId || "").trim();
    const douyinInput = String(data.douyinInput || "").trim();
    const noticeEmail = String(data.noticeEmail || "").trim();
    const planDays = Number(data.planDays || 30);

    if (!douyinInput) {
      throw new Error("请先输入抖音号或主页链接");
    }
    if (!isValidEmail_(noticeEmail)) {
      throw new Error("请先输入有效通知邮箱");
    }
    if ([7, 15, 30].indexOf(planDays) < 0) {
      throw new Error("规则周期仅支持 7 / 15 / 30");
    }

    const sheet = getOrCreateSheet_();
    let target = null;
    if (monitorId) {
      target = findRecordById_(sheet, monitorId);
      if (!target) {
        throw new Error("监控编号不存在，请确认后重试");
      }
      if (isConfigLocked_(target.record)) {
        throw new Error("当前周期未结束，配置已锁定，暂不可修改");
      }
    }

    const nextId = target ? target.record.monitorId : makeMonitorId_();
    const createdAt = target ? target.record.createdAt || nowIso : nowIso;
    const dueAt = addDaysIso_(nowIso, planDays);

    const record = Object.assign({}, emptyRecord_(), target ? target.record : {}, {
      monitorId: nextId,
      createdAt: createdAt,
      updatedAt: nowIso,
      douyinInput: douyinInput,
      noticeEmail: noticeEmail,
      planDays: planDays,
      requiredVideos: planDays,
      cycleStartAt: nowIso,
      dueAt: dueAt,
      configLocked: true,
      lastManualCheckAt: "",
      lastAutoCheckAt: "",
      lastKnownNewCount: 0,
      lastStatus: "ok",
      latestResultText: `已保存新周期：${planLabel_(planDays)}`,
      noticeCycleStartAt: "",
      lastNoticeAt: "",
      lastFetchError: "",
    });

    if (target) {
      writeRecordAtRow_(sheet, target.rowIndex, record);
    } else {
      appendRecord_(sheet, record);
    }

    return buildClientState_(record, "save");
  });
}

function apiGetMonitor(monitorId) {
  const id = String(monitorId || "").trim();
  if (!id) throw new Error("请先输入监控编号");
  const sheet = getOrCreateSheet_();
  const target = findRecordById_(sheet, id);
  if (!target) throw new Error("监控编号不存在");
  return buildClientState_(target.record, "get");
}

function apiCheckMonitor(monitorId) {
  return withLock_(function () {
    const id = String(monitorId || "").trim();
    if (!id) throw new Error("请先输入监控编号");
    const sheet = getOrCreateSheet_();
    const target = findRecordById_(sheet, id);
    if (!target) throw new Error("监控编号不存在");

    const nowIso = new Date().toISOString();
    const next = evaluateMonitor_(target.record, true, nowIso);
    next.updatedAt = nowIso;
    writeRecordAtRow_(sheet, target.rowIndex, next);
    return buildClientState_(next, "check");
  });
}

function runDailyAutoCheck() {
  return withLock_(function () {
    const sheet = getOrCreateSheet_();
    const all = readAllRecords_(sheet);
    const now = new Date();
    const nowIso = now.toISOString();

    let processed = 0;
    const summary = [];

    all.forEach(function (item) {
      const record = item.record;
      if (!record.monitorId) return;
      const due = toDateSafe_(record.dueAt);
      if (!due || now < due) return;

      const next = evaluateMonitor_(record, false, nowIso);
      next.updatedAt = nowIso;
      writeRecordAtRow_(sheet, item.rowIndex, next);
      processed += 1;
      summary.push({
        monitorId: next.monitorId,
        status: next.lastStatus,
        result: next.latestResultText,
      });
    });

    return {
      ok: true,
      processed: processed,
      items: summary,
    };
  });
}

function setupDailyTrigger() {
  clearDailyTrigger();
  ScriptApp.newTrigger("runDailyAutoCheck")
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .nearMinute(10)
    .inTimezone(DEFAULT_TZ)
    .create();

  return {
    ok: true,
    message: "已创建每天自动触发器（09:10 Asia/Shanghai）",
  };
}

function clearDailyTrigger() {
  const all = ScriptApp.getProjectTriggers();
  all.forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "runDailyAutoCheck") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  return { ok: true };
}

function sendTestMailNow(toEmail) {
  const email = String(toEmail || "").trim();
  if (!isValidEmail_(email)) {
    throw new Error("请传入有效邮箱，例如 2879154754@qq.com");
  }
  MailApp.sendEmail({
    to: email,
    subject: "[测试] 惩罚邮件通道正常",
    body: "这是一封测试邮件，说明多用户自动提醒通道已打通。",
    htmlBody: "<b>测试成功：</b>多用户自动提醒通道已打通。",
    name: APP_NAME,
  });
  return { ok: true, message: "测试邮件已发送", to: email };
}

function evaluateMonitor_(record, byManual, nowIso) {
  const now = toDateSafe_(nowIso) || new Date();
  const next = Object.assign({}, record);

  if (byManual) {
    next.lastManualCheckAt = now.toISOString();
  } else {
    next.lastAutoCheckAt = now.toISOString();
  }

  const requiredVideos = Number(next.requiredVideos || next.planDays || 30);
  const planDays = Number(next.planDays || requiredVideos || 30);
  const cycleStart = toDateSafe_(next.cycleStartAt) || now;
  const dueAt = toDateSafe_(next.dueAt) || toDateSafe_(addDaysIso_(now.toISOString(), planDays)) || now;

  let videos = [];
  try {
    videos = fetchRecentVideos_(String(next.douyinInput || ""), 60);
    next.lastFetchError = "";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    next.lastStatus = "warn";
    next.latestResultText = `检测失败：${msg}`;
    next.lastFetchError = msg;
    return next;
  }

  if (videos.length > 0) {
    const latest = videos[0];
    next.lastSeenVideoId = latest.videoId || "";
    next.lastSeenTitle = latest.title || "";
    next.lastSeenUrl = latest.url || "";
    next.lastSeenPublishedAt = latest.publishedAt || "";
  }

  const cycleStartTs = Math.floor(cycleStart.getTime() / 1000);
  const inCycleCount = videos.filter(function (video) {
    return Number(video.publishedTs || 0) >= cycleStartTs;
  }).length;
  next.lastKnownNewCount = inCycleCount;

  const dueReached = now >= dueAt;
  if (!dueReached) {
    next.lastStatus = "ok";
    next.latestResultText =
      inCycleCount > 0
        ? `本周期已更新 ${inCycleCount}/${requiredVideos}`
        : `本周期暂未更新 0/${requiredVideos}`;
    return next;
  }

  const manualCheckAt = toDateSafe_(next.lastManualCheckAt);
  const manualCheckedAfterDue = manualCheckAt ? manualCheckAt >= dueAt : false;

  let breachReason = "";
  if (!manualCheckedAfterDue && !byManual) {
    breachReason = "违约：到期后未点检测";
  } else if (inCycleCount < requiredVideos) {
    breachReason = `违约：${planLabel_(planDays)}检测未达标`;
  }

  if (breachReason) {
    try {
      sendBreachMail_(next, breachReason, inCycleCount, requiredVideos);
      next.lastNoticeAt = now.toISOString();
      next.latestResultText = `${breachReason}（已发送提醒）`;
      next.lastStatus = "warn";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      next.latestResultText = `${breachReason}（邮件发送失败）`;
      next.lastStatus = "warn";
      next.lastFetchError = `邮件发送失败: ${msg}`;
    }
  } else {
    next.lastStatus = "ok";
    next.latestResultText = `达标：${inCycleCount}/${requiredVideos}`;
  }

  const newCycleStart = now.toISOString();
  next.cycleStartAt = newCycleStart;
  next.dueAt = addDaysIso_(newCycleStart, planDays);
  next.requiredVideos = planDays;
  next.lastKnownNewCount = 0;
  next.configLocked = true;
  next.noticeCycleStartAt = "";

  return next;
}

function sendBreachMail_(record, reason, count, required) {
  const to = String(record.noticeEmail || "").trim();
  if (!isValidEmail_(to)) {
    throw new Error("通知邮箱无效");
  }

  const now = new Date();
  const dayText = Utilities.formatDate(now, DEFAULT_TZ, "yyyy-MM-dd");
  const subject = `[抖音违约提醒] ${dayText}`;
  const accountUrl = String(record.douyinInput || "-");
  const title = String(record.lastSeenTitle || "(未知标题)");
  const publishedAt = formatIsoLocal_(record.lastSeenPublishedAt);
  const videoUrl = String(record.lastSeenUrl || accountUrl);

  const body =
    `触发原因: ${reason}\n` +
    `规则: ${planLabel_(Number(record.planDays || required || 30))}\n` +
    `抖音账号主页: ${accountUrl}\n` +
    `上次已知视频: ${title}\n` +
    `发布时间: ${publishedAt}\n` +
    `视频链接: ${videoUrl}\n` +
    `本周期新增: ${count}/${required}\n` +
    `周期开始: ${formatIsoLocal_(record.cycleStartAt)}\n` +
    `周期截止: ${formatIsoLocal_(record.dueAt)}\n`;

  const htmlBody =
    `<div style="font-family:Arial,'PingFang SC','Microsoft YaHei',sans-serif;background:#f4f6fb;padding:20px;">` +
    `<div style="max-width:680px;margin:0 auto;background:#fff;border:1px solid #e3e8f2;border-radius:12px;overflow:hidden;">` +
    `<div style="padding:16px 18px;background:linear-gradient(135deg,#0f172a,#1e3a8a);color:#fff;">` +
    `<div style="font-size:13px;opacity:.9;">抖音违约提醒</div>` +
    `<div style="font-size:20px;font-weight:700;margin-top:6px;">${escapeHtml_(subject)}</div>` +
    `</div>` +
    `<div style="padding:16px 18px;color:#1f2937;line-height:1.75;">` +
    `<p style="margin:0 0 10px;"><b>触发原因：</b>${escapeHtml_(reason)}</p>` +
    `<p style="margin:0 0 10px;"><b>抖音账号主页：</b><a href="${escapeHtml_(accountUrl)}">${escapeHtml_(accountUrl)}</a></p>` +
    `<p style="margin:0 0 10px;"><b>上次已知视频：</b>${escapeHtml_(title)}</p>` +
    `<p style="margin:0 0 10px;"><b>发布时间：</b>${escapeHtml_(publishedAt)}</p>` +
    `<p style="margin:0 0 10px;"><b>视频链接：</b><a href="${escapeHtml_(videoUrl)}">${escapeHtml_(videoUrl)}</a></p>` +
    `<p style="margin:0;"><b>本周期新增：</b>${count}/${required}</p>` +
    `</div></div></div>`;

  MailApp.sendEmail({
    to: to,
    subject: subject,
    body: body,
    htmlBody: htmlBody,
    name: APP_NAME,
  });
}

function fetchRecentVideos_(douyinInput, maxCount) {
  const secUid = resolveSecUid_(douyinInput);
  if (!secUid) {
    throw new Error("无法解析 sec_uid，请粘贴完整主页链接或抖音 user 链接");
  }

  const encoded = encodeURIComponent(secUid);
  const endpoints = [
    `https://www.iesdouyin.com/web/api/v2/aweme/post/?sec_uid=${encoded}&count=60&max_cursor=0&aid=1128`,
    `https://m.douyin.com/web/api/v2/aweme/post/?sec_uid=${encoded}&count=60&max_cursor=0`,
  ];

  for (let i = 0; i < endpoints.length; i += 1) {
    const endpoint = endpoints[i];
    const res = UrlFetchApp.fetch(endpoint, {
      method: "get",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json,text/plain,*/*",
      },
      muteHttpExceptions: true,
      followRedirects: true,
    });

    const code = Number(res.getResponseCode() || 0);
    if (code >= 400) {
      continue;
    }

    const payload = parsePossibleJson_(res.getContentText() || "");
    if (!payload) continue;
    const list = extractVideoListFromPayload_(payload);
    if (!list.length) continue;

    const mapped = list
      .map(function (item) {
        return mapAwemeToVideo_(item);
      })
      .filter(function (item) {
        return Boolean(item);
      })
      .sort(function (a, b) {
        return Number(b.publishedTs || 0) - Number(a.publishedTs || 0);
      });

    if (mapped.length > 0) {
      return mapped.slice(0, Number(maxCount || 60));
    }
  }

  throw new Error("云端抓取失败，请稍后重试或改用完整主页链接");
}

function resolveSecUid_(input) {
  let source = String(input || "").trim();
  if (!source) return "";
  if (/^MS4w/i.test(source)) return source;

  let m = source.match(/[?&]sec_uid=([^&#\s]+)/i);
  if (m && m[1]) return safeDecode_(m[1]);

  m = source.match(/\/user\/(MS4w[^\s/?#]+)/i);
  if (m && m[1]) return safeDecode_(m[1]);

  if (/^https?:\/\//i.test(source) && /v\.douyin\.com/i.test(source)) {
    const expanded = expandShortLink_(source);
    if (expanded) {
      source = expanded;
      m = source.match(/[?&]sec_uid=([^&#\s]+)/i);
      if (m && m[1]) return safeDecode_(m[1]);
      m = source.match(/\/user\/(MS4w[^\s/?#]+)/i);
      if (m && m[1]) return safeDecode_(m[1]);
    }
  }

  if (/^https?:\/\//i.test(source)) {
    const html = UrlFetchApp.fetch(source, {
      method: "get",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      muteHttpExceptions: true,
      followRedirects: true,
    }).getContentText();

    m = html.match(/sec_uid(?:%3D|=)(MS4w[^"&\s]+)/i);
    if (m && m[1]) return safeDecode_(m[1]);
  }

  return "";
}

function expandShortLink_(url) {
  try {
    const res = UrlFetchApp.fetch(url, {
      method: "get",
      muteHttpExceptions: true,
      followRedirects: false,
      headers: {
        "User-Agent": USER_AGENT,
      },
    });
    const headers = res.getHeaders() || {};
    const location = getHeaderValue_(headers, "Location");
    return location || url;
  } catch (err) {
    return url;
  }
}

function extractVideoListFromPayload_(payload) {
  const list = [];
  const buckets = [
    payload.aweme_list,
    payload.item_list,
    payload.data && payload.data.aweme_list,
    payload.data && payload.data.item_list,
  ];

  buckets.forEach(function (bucket) {
    if (Array.isArray(bucket)) {
      bucket.forEach(function (item) {
        if (item && typeof item === "object") {
          list.push(item);
        }
      });
    }
  });

  return list;
}

function mapAwemeToVideo_(item) {
  const createTs = Number(item.create_time || item.publish_time || 0);
  const awemeId = String(item.aweme_id || item.id || item.group_id || "");
  const title = String(item.desc || (item.share_info && item.share_info.share_title) || "(无标题)");
  const url = String(item.share_url || item.aweme_url || (awemeId ? `https://www.douyin.com/video/${awemeId}` : ""));

  return {
    videoId: awemeId || title,
    title: title,
    url: url,
    publishedTs: createTs || 0,
    publishedAt: createTs > 0 ? new Date(createTs * 1000).toISOString() : "",
  };
}

function parsePossibleJson_(text) {
  const raw = String(text || "");
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(raw.substring(start, end + 1));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e2) {
      return null;
    }
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function getOrCreateSheet_() {
  const props = PropertiesService.getScriptProperties();
  const sheetId = String(props.getProperty("MONITOR_SHEET_ID") || "").trim();

  let spreadsheet = null;
  if (sheetId) {
    try {
      spreadsheet = SpreadsheetApp.openById(sheetId);
    } catch (err) {
      spreadsheet = null;
    }
  }

  if (!spreadsheet) {
    spreadsheet = SpreadsheetApp.create("LinkUpdateMonitor_Data");
    props.setProperty("MONITOR_SHEET_ID", spreadsheet.getId());
  }

  let sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
  }
  ensureHeader_(sheet);
  return sheet;
}

function ensureHeader_(sheet) {
  const width = HEADERS.length;
  if (sheet.getMaxColumns() < width) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  }
  sheet.getRange(1, 1, 1, width).setValues([HEADERS]);
  sheet.setFrozenRows(1);
}

function readAllRecords_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  return values.map(function (row, idx) {
    const record = emptyRecord_();
    HEADERS.forEach(function (key, i) {
      record[key] = row[i];
    });
    return {
      rowIndex: idx + 2,
      record: normalizeRecord_(record),
    };
  });
}

function findRecordById_(sheet, monitorId) {
  const all = readAllRecords_(sheet);
  for (let i = 0; i < all.length; i += 1) {
    if (String(all[i].record.monitorId || "").trim() === String(monitorId || "").trim()) {
      return all[i];
    }
  }
  return null;
}

function appendRecord_(sheet, record) {
  const row = HEADERS.map(function (key) {
    return record[key] !== undefined ? record[key] : "";
  });
  sheet.appendRow(row);
}

function writeRecordAtRow_(sheet, rowIndex, record) {
  const row = HEADERS.map(function (key) {
    return record[key] !== undefined ? record[key] : "";
  });
  sheet.getRange(rowIndex, 1, 1, HEADERS.length).setValues([row]);
}

function emptyRecord_() {
  const obj = {};
  HEADERS.forEach(function (key) {
    obj[key] = "";
  });
  return obj;
}

function normalizeRecord_(record) {
  const next = Object.assign({}, emptyRecord_(), record || {});
  next.planDays = Number(next.planDays || 30);
  next.requiredVideos = Number(next.requiredVideos || next.planDays || 30);
  next.lastKnownNewCount = Number(next.lastKnownNewCount || 0);
  next.configLocked = toBool_(next.configLocked);
  return next;
}

function buildClientState_(record, source) {
  const state = normalizeRecord_(record);
  return {
    ok: true,
    source: source || "api",
    monitorId: String(state.monitorId || ""),
    douyinInput: String(state.douyinInput || ""),
    noticeEmail: String(state.noticeEmail || ""),
    planDays: Number(state.planDays || 30),
    requiredVideos: Number(state.requiredVideos || state.planDays || 30),
    cycleStartAt: String(state.cycleStartAt || ""),
    dueAt: String(state.dueAt || ""),
    lastKnownNewCount: Number(state.lastKnownNewCount || 0),
    lastStatus: String(state.lastStatus || "idle"),
    latestResultText: String(state.latestResultText || "待初始化"),
    lastManualCheckAt: String(state.lastManualCheckAt || ""),
    lastAutoCheckAt: String(state.lastAutoCheckAt || ""),
    lastSeenTitle: String(state.lastSeenTitle || ""),
    lastSeenUrl: String(state.lastSeenUrl || ""),
    lastSeenPublishedAt: String(state.lastSeenPublishedAt || ""),
    lastFetchError: String(state.lastFetchError || ""),
    locked: isConfigLocked_(state),
  };
}

function isConfigLocked_(record) {
  const due = toDateSafe_(record && record.dueAt);
  return Boolean(toBool_(record && record.configLocked)) && Boolean(due) && new Date() < due;
}

function isValidEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function makeMonitorId_() {
  return `MON-${Utilities.getUuid().replace(/-/g, "").substring(0, 12).toUpperCase()}`;
}

function addDaysIso_(isoText, days) {
  const base = toDateSafe_(isoText) || new Date();
  base.setDate(base.getDate() + Number(days || 0));
  return base.toISOString();
}

function toDateSafe_(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === "[object Date]") {
    return isNaN(value.getTime()) ? null : value;
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function planLabel_(days) {
  return `${days}天${days}条`;
}

function formatIsoLocal_(isoText) {
  const d = toDateSafe_(isoText);
  if (!d) return "未知";
  return Utilities.formatDate(d, DEFAULT_TZ, "yyyy-MM-dd HH:mm:ss");
}

function toBool_(value) {
  if (typeof value === "boolean") return value;
  const text = String(value || "").trim().toLowerCase();
  return text === "true" || text === "1" || text === "yes";
}

function safeDecode_(text) {
  try {
    return decodeURIComponent(text);
  } catch (err) {
    return text;
  }
}

function getHeaderValue_(headers, key) {
  const target = String(key || "").toLowerCase();
  const source = headers || {};
  for (const name in source) {
    if (String(name).toLowerCase() === target) {
      return String(source[name] || "");
    }
  }
  return "";
}

function escapeHtml_(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

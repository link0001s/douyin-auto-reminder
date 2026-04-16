import sodium from "https://cdn.jsdelivr.net/npm/libsodium-wrappers@0.7.15/+esm";

const workflowFile = "douyin-reminder.yml";
const formEl = document.getElementById("configForm");
const logBox = document.getElementById("logBox");
const latestRun = document.getElementById("latestRun");
const statusBadge = document.getElementById("statusBadge");
const buttons = {
  save: document.getElementById("saveSecretsBtn"),
  run: document.getElementById("runBtn"),
  saveAndRun: document.getElementById("saveAndRunBtn"),
  refresh: document.getElementById("refreshBtn"),
};

const savedFields = [
  "repoOwner",
  "repoName",
  "douyinUrl",
  "smtpHost",
  "smtpPort",
  "smtpUser",
  "emailFrom",
  "emailTo",
  "timezone",
  "subjectPrefix",
];

function nowStamp() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function addLog(message) {
  logBox.textContent += `\n[${nowStamp()}] ${message}`;
  logBox.scrollTop = logBox.scrollHeight;
}

function setBadge(type, text) {
  statusBadge.className = `badge ${type}`;
  statusBadge.textContent = text;
}

function setBusy(isBusy) {
  Object.values(buttons).forEach((btn) => {
    btn.disabled = isBusy;
  });
}

function getValue(id) {
  const el = document.getElementById(id);
  return (el?.value || "").trim();
}

function setValue(id, value) {
  const el = document.getElementById(id);
  if (el && value) {
    el.value = value;
  }
}

function persistForm() {
  const payload = {};
  savedFields.forEach((key) => {
    payload[key] = getValue(key);
  });
  localStorage.setItem("douyin-control-form", JSON.stringify(payload));
}

function restoreForm() {
  try {
    const raw = localStorage.getItem("douyin-control-form");
    if (!raw) return;
    const data = JSON.parse(raw);
    savedFields.forEach((key) => setValue(key, data[key]));
  } catch (err) {
    addLog(`读取本地表单失败: ${String(err)}`);
  }
}

function readAuthConfig() {
  const config = {
    token: getValue("githubToken"),
    owner: getValue("repoOwner"),
    repo: getValue("repoName"),
  };

  const required = [
    ["token", config.token],
    ["owner", config.owner],
    ["repo", config.repo],
  ];

  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new Error(`缺少字段: ${missing.join(", ")}`);
  }

  return config;
}

function readFullConfig() {
  const auth = readAuthConfig();
  const secrets = {
    DOUYIN_USER_URL: getValue("douyinUrl"),
    SMTP_HOST: getValue("smtpHost"),
    SMTP_PORT: getValue("smtpPort"),
    SMTP_USER: getValue("smtpUser"),
    SMTP_PASSWORD: getValue("smtpPassword"),
    EMAIL_FROM: getValue("emailFrom"),
    EMAIL_TO: getValue("emailTo"),
    TIMEZONE: getValue("timezone") || "Asia/Shanghai",
    MAIL_SUBJECT_PREFIX: getValue("subjectPrefix") || "[抖音催更]",
    DOUYIN_COOKIES_B64: getValue("cookiesB64"),
  };

  const required = [
    ["DOUYIN_USER_URL", secrets.DOUYIN_USER_URL],
    ["SMTP_HOST", secrets.SMTP_HOST],
    ["SMTP_PORT", secrets.SMTP_PORT],
    ["SMTP_USER", secrets.SMTP_USER],
    ["SMTP_PASSWORD", secrets.SMTP_PASSWORD],
    ["EMAIL_FROM", secrets.EMAIL_FROM],
    ["EMAIL_TO", secrets.EMAIL_TO],
  ];

  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new Error(`缺少字段: ${missing.join(", ")}`);
  }

  return { ...auth, secrets };
}

async function githubApi(path, token, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }

  if (res.status === 204) {
    return null;
  }

  return res.json();
}

async function encryptSecret(secretValue, base64PublicKey) {
  await sodium.ready;
  const keyBytes = sodium.from_base64(
    base64PublicKey,
    sodium.base64_variants.ORIGINAL
  );
  const valueBytes = sodium.from_string(secretValue);
  const encryptedBytes = sodium.crypto_box_seal(valueBytes, keyBytes);
  return sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);
}

async function saveAllSecrets() {
  const { token, owner, repo, secrets } = readFullConfig();
  addLog("读取仓库公钥...");

  const keyResp = await githubApi(
    `/repos/${owner}/${repo}/actions/secrets/public-key`,
    token
  );

  const allSecrets = Object.entries(secrets).filter(([, value]) => Boolean(value));

  for (const [name, value] of allSecrets) {
    addLog(`写入 secret: ${name}`);
    const encryptedValue = await encryptSecret(value, keyResp.key);
    await githubApi(`/repos/${owner}/${repo}/actions/secrets/${name}`, token, {
      method: "PUT",
      body: JSON.stringify({
        encrypted_value: encryptedValue,
        key_id: keyResp.key_id,
      }),
    });
  }

  persistForm();
  addLog(`Secrets 写入完成，共 ${allSecrets.length} 项。`);
}

async function triggerRun() {
  const { token, owner, repo } = readAuthConfig();
  addLog("触发工作流执行...");

  await githubApi(
    `/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ ref: "main" }),
    }
  );

  addLog("触发成功，正在拉取最新运行状态...");
  await refreshLatestRun();
}

function prettyTime(iso) {
  if (!iso) return "未知";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

function renderLatestRun(run, owner, repo) {
  if (!run) {
    latestRun.className = "latest-run empty";
    latestRun.textContent = "还没有读取到运行记录。";
    return;
  }

  const repoUrl = `https://github.com/${owner}/${repo}`;
  const conclusion = run.conclusion || "进行中";

  latestRun.className = "latest-run";
  latestRun.innerHTML = `
    <p class="run-title">${run.name || "Douyin Daily Reminder"}</p>
    <div class="run-meta">
      <span>状态: ${run.status}</span>
      <span>结论: ${conclusion}</span>
      <span>时间: ${prettyTime(run.created_at)}</span>
      <a href="${run.html_url}" target="_blank" rel="noreferrer">打开本次运行</a>
      <a href="${repoUrl}/actions" target="_blank" rel="noreferrer">打开全部运行</a>
    </div>
  `;
}

async function refreshLatestRun() {
  const { token, owner, repo } = readAuthConfig();
  addLog("查询最新运行记录...");

  const payload = await githubApi(
    `/repos/${owner}/${repo}/actions/runs?per_page=20`,
    token
  );

  const run = (payload.workflow_runs || []).find(
    (item) => item.name === "Douyin Daily Reminder"
  );

  renderLatestRun(run, owner, repo);

  if (!run) {
    setBadge("idle", "暂无记录");
    addLog("没有找到 Douyin Daily Reminder 的运行记录。");
    return;
  }

  if (run.status !== "completed") {
    setBadge("loading", `运行中: ${run.status}`);
  } else if (run.conclusion === "success") {
    setBadge("success", "最近运行成功");
  } else {
    setBadge("error", `最近运行失败: ${run.conclusion}`);
  }

  addLog(`最新运行: ${run.status}/${run.conclusion || "pending"}`);
}

async function runTask(taskName, fn) {
  try {
    setBusy(true);
    setBadge("loading", `${taskName}中`);
    await fn();
    if (taskName.includes("刷新")) {
      return;
    }
    setBadge("success", `${taskName}成功`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setBadge("error", `${taskName}失败`);
    addLog(`${taskName}失败: ${message}`);
  } finally {
    setBusy(false);
  }
}

buttons.save.addEventListener("click", () => runTask("保存 Secrets", saveAllSecrets));
buttons.run.addEventListener("click", () => runTask("触发检测", triggerRun));
buttons.saveAndRun.addEventListener("click", () =>
  runTask("保存并运行", async () => {
    await saveAllSecrets();
    await triggerRun();
  })
);
buttons.refresh.addEventListener("click", () => runTask("刷新状态", refreshLatestRun));

formEl.addEventListener("input", () => {
  persistForm();
});

restoreForm();
addLog("已加载本地表单（不含 Token 与授权码）。");

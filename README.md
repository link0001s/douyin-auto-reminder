# 抖音催更自动提醒（云端免费版）

这个项目支持两种运行方式：

1. GitHub Actions 云端定时（电脑关机也能跑，推荐）
2. 本地 cron 定时（电脑需开机）

---

## 网页控制台（推荐）

控制台地址（部署完成后可直接使用）：

- https://link0001s.github.io/douyin-auto-reminder/

你可以在网页上：

1. 只输入抖音号（或主页链接）
2. 只输入违约通知邮箱
3. 点击“保存状态 / 刷新状态”直接使用

---

## 云端版（推荐）

### 第 1 步：新建仓库并上传本目录文件

新建仓库链接（可直接点开）：  
<https://github.com/new?name=douyin-auto-reminder>

把当前目录全部上传到仓库根目录（包含 `.github/workflows/douyin-reminder.yml`）。

### 第 2 步：配置仓库 Secrets

进入：`Settings -> Secrets and variables -> Actions -> New repository secret`

必填 Secrets：

- `DOUYIN_USER_URL`：抖音账号主页链接（`https://www.douyin.com/user/...`）
- `SMTP_HOST`：SMTP 地址（如 `smtp.qq.com`）
- `SMTP_PORT`：SMTP 端口（如 `465`）
- `SMTP_USER`：发件邮箱账号
- `SMTP_PASSWORD`：SMTP 授权码
- `EMAIL_FROM`：发件邮箱
- `EMAIL_TO`：收件邮箱（多个用英文逗号分隔）

可选 Secrets：

- `TIMEZONE`：默认 `Asia/Shanghai`
- `MAIL_SUBJECT_PREFIX`：默认 `[抖音催更]`
- `DOUYIN_COOKIES_B64`：可选，抖音风控时建议加

### 第 3 步：手动点一次 Run workflow 初始化状态

进入 `Actions -> Douyin Daily Reminder -> Run workflow` 执行一次。

说明：

- 首次运行只初始化 `state.json`，不发催更邮件。
- 后续每天自动执行（默认北京时间 09:00）。

---

## 本地版（可选）

```bash
cd /Users/link/Documents/Playground/douyin_auto_reminder
cp config.example.json config.json
./run_once.sh
./install_daily_cron.sh "0 9 * * *"
```

---

## 常见问题

1. 抓取失败（风控）
- 建议使用 `DOUYIN_COOKIES_B64`（将 `cookies.txt` 做 base64 后放入 secret）。

2. 邮件发不出去
- 大部分邮箱用 SMTP 授权码，不是登录密码。
- 优先用 SSL 465 端口。

3. 定时不触发
- GitHub cron 是 UTC 时间。当前工作流 `0 1 * * *` 等于北京时间每天 09:00。

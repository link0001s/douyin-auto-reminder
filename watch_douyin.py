#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import smtplib
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Any
from urllib import error as urlerror
from urllib import request as urlrequest
from zoneinfo import ZoneInfo

SCRIPT_DIR = Path(__file__).resolve().parent


@dataclass
class EmailConfig:
    provider: str
    to: list[str]
    sender: str | None = None
    smtp_host: str | None = None
    smtp_port: int = 465
    smtp_user: str | None = None
    smtp_password: str | None = None
    use_ssl: bool = True
    use_starttls: bool = False


@dataclass
class AppConfig:
    douyin_user_url: str
    timezone: str
    mail_subject_prefix: str
    state_file: Path
    yt_dlp_cookie_file: Path | None
    yt_dlp_playlistend: int
    email: EmailConfig


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="每天检查抖音账号是否更新，未更新时发送催更邮件。"
    )
    parser.add_argument(
        "--config",
        default=str(SCRIPT_DIR / "config.json"),
        help="配置文件路径，默认是当前目录下的 config.json",
    )
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def parse_email_config(data: dict[str, Any]) -> EmailConfig:
    recipients = data.get("to")
    if not isinstance(recipients, list) or not recipients:
        raise ValueError("email.to 必须是非空数组")
    recipient_list = [str(x) for x in recipients if str(x).strip()]
    if not recipient_list:
        raise ValueError("email.to 必须至少包含一个有效邮箱")

    provider = str(data.get("provider", "smtp")).strip().lower()
    if provider == "formsubmit":
        return EmailConfig(
            provider="formsubmit",
            sender=str(data.get("from") or ""),
            to=recipient_list,
        )

    if provider != "smtp":
        raise ValueError("email.provider 只支持 smtp 或 formsubmit")

    required = ["smtp_host", "smtp_port", "smtp_user", "smtp_password", "from"]
    missing = [k for k in required if not str(data.get(k) or "").strip()]
    if missing:
        raise ValueError(f"email(smtp) 配置缺少字段: {', '.join(missing)}")

    return EmailConfig(
        provider="smtp",
        smtp_host=str(data["smtp_host"]),
        smtp_port=int(data["smtp_port"]),
        smtp_user=str(data["smtp_user"]),
        smtp_password=str(data["smtp_password"]),
        sender=str(data["from"]),
        to=recipient_list,
        use_ssl=bool(data.get("use_ssl", True)),
        use_starttls=bool(data.get("use_starttls", False)),
    )


def load_config(path: Path) -> AppConfig:
    if not path.exists():
        raise FileNotFoundError(f"配置文件不存在: {path}")

    data = load_json(path)
    for key in ["douyin_user_url", "email"]:
        if key not in data or not data[key]:
            raise ValueError(f"配置缺少字段: {key}")

    state_file = data.get("state_file", "state.json")
    state_path = Path(state_file)
    if not state_path.is_absolute():
        state_path = (path.parent / state_path).resolve()

    yt_dlp_data = data.get("yt_dlp", {})
    cookie_path: Path | None = None
    if isinstance(yt_dlp_data, dict) and yt_dlp_data.get("cookies_file"):
        candidate = Path(str(yt_dlp_data["cookies_file"]))
        cookie_path = candidate if candidate.is_absolute() else (path.parent / candidate).resolve()

    playlistend = 30
    if isinstance(yt_dlp_data, dict) and yt_dlp_data.get("playlistend"):
        playlistend = int(yt_dlp_data["playlistend"])

    return AppConfig(
        douyin_user_url=str(data["douyin_user_url"]),
        timezone=str(data.get("timezone", "Asia/Shanghai")),
        mail_subject_prefix=str(data.get("mail_subject_prefix", "[抖音催更]")),
        state_file=state_path,
        yt_dlp_cookie_file=cookie_path,
        yt_dlp_playlistend=playlistend,
        email=parse_email_config(data["email"]),
    )


def parse_entry_published_at(entry: dict[str, Any]) -> datetime | None:
    ts = entry.get("timestamp")
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts, tz=timezone.utc)

    upload_date = entry.get("upload_date")
    if isinstance(upload_date, str) and len(upload_date) == 8 and upload_date.isdigit():
        dt = datetime.strptime(upload_date, "%Y%m%d")
        return dt.replace(tzinfo=timezone.utc)

    return None


def pick_latest_entry(entries: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not entries:
        return None

    scored: list[tuple[float, dict[str, Any]]] = []
    for index, entry in enumerate(entries):
        published = parse_entry_published_at(entry)
        if published:
            score = published.timestamp()
        else:
            # 没有时间戳时，按抓取顺序兜底（通常第一条是最新）
            score = float("-inf") - index
        scored.append((score, entry))

    scored.sort(key=lambda item: item[0], reverse=True)
    return scored[0][1]


def extract_latest_video(
    douyin_user_url: str,
    *,
    cookie_file: Path | None = None,
    playlistend: int = 30,
) -> dict[str, Any] | None:
    try:
        import yt_dlp  # type: ignore
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "缺少依赖 yt-dlp。先运行: pip3 install -r requirements.txt"
        ) from exc

    ydl_opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "playlistend": playlistend,
    }
    if cookie_file:
        ydl_opts["cookiefile"] = str(cookie_file)

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(douyin_user_url, download=False)

    if info is None:
        return None

    entries: list[dict[str, Any]] = []
    if isinstance(info.get("entries"), list):
        entries = [e for e in info["entries"] if isinstance(e, dict)]

    latest = pick_latest_entry(entries)
    if latest is None and isinstance(info, dict):
        latest = info

    if latest is None:
        return None

    published_at = parse_entry_published_at(latest)
    title = str(latest.get("title") or "(无标题)")
    video_id = str(
        latest.get("id")
        or latest.get("url")
        or latest.get("webpage_url")
        or title
    )

    return {
        "video_id": video_id,
        "title": title,
        "webpage_url": str(latest.get("webpage_url") or latest.get("url") or ""),
        "published_at": (
            published_at.astimezone(timezone.utc).isoformat()
            if published_at
            else None
        ),
    }


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def send_email_via_formsubmit(recipients: list[str], subject: str, body: str) -> None:
    for recipient in recipients:
        endpoint = f"https://formsubmit.co/ajax/{recipient}"
        payload = {
            "_subject": subject,
            "name": "抖音更新检测台",
            "message": body,
            "_template": "box",
            "_captcha": "false",
        }
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urlrequest.Request(
            endpoint,
            data=raw,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )

        try:
            with urlrequest.urlopen(req, timeout=30) as resp:
                status = int(resp.getcode() or 0)
                text = resp.read().decode("utf-8", errors="ignore")
        except urlerror.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(
                f"FormSubmit 发送失败({recipient}) HTTP {exc.code}: {detail[:180]}"
            ) from exc
        except urlerror.URLError as exc:
            raise RuntimeError(f"FormSubmit 发送失败({recipient}): {exc.reason}") from exc

        data: dict[str, Any] = {}
        if text:
            try:
                parsed = json.loads(text)
                if isinstance(parsed, dict):
                    data = parsed
            except json.JSONDecodeError:
                data = {}

        success = data.get("success")
        if status >= 400 or not (success is True or str(success).lower() == "true"):
            detail = str(data.get("message") or text or f"HTTP {status}")
            raise RuntimeError(
                f"FormSubmit 发送失败({recipient})。可能需要先在 FormSubmit 完成邮箱激活。返回: {detail[:180]}"
            )


def send_email(config: AppConfig, subject: str, body: str) -> None:
    if config.email.provider == "formsubmit":
        send_email_via_formsubmit(config.email.to, subject, body)
        return

    smtp_host = config.email.smtp_host
    smtp_port = config.email.smtp_port
    smtp_user = config.email.smtp_user
    smtp_password = config.email.smtp_password
    sender = config.email.sender
    if not smtp_host or not smtp_user or not smtp_password or not sender:
        raise RuntimeError("SMTP 配置不完整，无法发送邮件")

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = ", ".join(config.email.to)
    msg.set_content(body)

    if config.email.use_ssl:
        with smtplib.SMTP_SSL(
            smtp_host, smtp_port, timeout=30
        ) as smtp:
            smtp.login(smtp_user, smtp_password)
            smtp.send_message(msg)
        return

    with smtplib.SMTP(smtp_host, smtp_port, timeout=30) as smtp:
        if config.email.use_starttls:
            smtp.starttls()
        smtp.login(smtp_user, smtp_password)
        smtp.send_message(msg)


def iso_to_local_time(iso_text: str | None, tz: ZoneInfo) -> str:
    if not iso_text:
        return "未知"
    try:
        dt = datetime.fromisoformat(iso_text)
        return dt.astimezone(tz).strftime("%Y-%m-%d %H:%M:%S %Z")
    except ValueError:
        return iso_text


def main() -> int:
    args = parse_args()
    config_path = Path(args.config).expanduser().resolve()
    config = load_config(config_path)

    tz = ZoneInfo(config.timezone)
    now = datetime.now(tz)
    today = now.strftime("%Y-%m-%d")

    latest_video = extract_latest_video(
        config.douyin_user_url,
        cookie_file=config.yt_dlp_cookie_file,
        playlistend=config.yt_dlp_playlistend,
    )
    state = load_state(config.state_file)

    current_video_id = latest_video["video_id"] if latest_video else ""
    last_video_id = str(state.get("last_seen_video_id") or "")

    state["account_url"] = config.douyin_user_url
    state["last_checked_at"] = now.isoformat()
    state["cloud_result"] = "unknown"

    if latest_video is None:
        raise RuntimeError("本次未抓取到视频信息，可能是网络、风控或 cookies 失效。")

    if "last_seen_video_id" not in state:
        state["last_seen_video_id"] = current_video_id
        state["last_seen_title"] = latest_video["title"] if latest_video else ""
        state["last_seen_url"] = latest_video["webpage_url"] if latest_video else ""
        state["last_seen_published_at"] = (
            latest_video["published_at"] if latest_video else None
        )
        state["last_reminder_date"] = None
        state["cloud_result"] = "initialized"
        save_state(config.state_file, state)
        print("首次运行：已初始化状态，不发送催更邮件。")
        return 0

    if current_video_id and current_video_id != last_video_id:
        state["last_seen_video_id"] = current_video_id
        state["last_seen_title"] = latest_video["title"]
        state["last_seen_url"] = latest_video["webpage_url"]
        state["last_seen_published_at"] = latest_video["published_at"]
        state["last_reminder_date"] = None
        state["cloud_result"] = "new_video"
        save_state(config.state_file, state)
        print("检测到新视频，已更新状态，不发送催更邮件。")
        return 0

    if state.get("last_reminder_date") == today:
        state["cloud_result"] = "no_update"
        print("今天已发送过催更邮件，跳过。")
        save_state(config.state_file, state)
        return 0

    last_publish_local = iso_to_local_time(
        state.get("last_seen_published_at"),
        tz,
    )

    subject = f"{config.mail_subject_prefix} {today} 未更新"
    body = (
        "抖音账号今日未检测到新短视频。\n\n"
        f"账号主页: {config.douyin_user_url}\n"
        f"上次已知视频: {state.get('last_seen_title') or '(未知标题)'}\n"
        f"发布时间: {last_publish_local}\n"
        f"视频链接: {state.get('last_seen_url') or '(未知链接)'}\n\n"
        "这封邮件由自动检测脚本发送。"
    )

    send_email(config, subject, body)
    state["last_reminder_date"] = today
    state["cloud_result"] = "no_update"
    save_state(config.state_file, state)
    print("未检测到更新，已发送催更邮件。")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"运行失败: {exc}", file=sys.stderr)
        raise SystemExit(1)

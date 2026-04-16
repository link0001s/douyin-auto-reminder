#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
CRON_TIME="${1:-0 9 * * *}"
PYTHON_BIN="$PROJECT_DIR/.venv/bin/python"
LOG_FILE="$PROJECT_DIR/logs/cron.log"
TAG="# douyin_auto_reminder"

mkdir -p "$PROJECT_DIR/logs"

if [ ! -x "$PYTHON_BIN" ]; then
  echo "未找到 $PYTHON_BIN，请先执行 ./run_once.sh"
  exit 1
fi

PROJECT_DIR_Q=$(printf "%q" "$PROJECT_DIR")
PYTHON_BIN_Q=$(printf "%q" "$PYTHON_BIN")
LOG_FILE_Q=$(printf "%q" "$LOG_FILE")
SCRIPT_Q=$(printf "%q" "$PROJECT_DIR/watch_douyin.py")
CONFIG_Q=$(printf "%q" "$PROJECT_DIR/config.json")

CRON_LINE="$CRON_TIME cd $PROJECT_DIR_Q && $PYTHON_BIN_Q $SCRIPT_Q --config $CONFIG_Q >> $LOG_FILE_Q 2>&1 $TAG"

EXISTING="$(crontab -l 2>/dev/null || true)"
CLEANED="$(printf "%s\n" "$EXISTING" | sed '/douyin_auto_reminder/d')"
UPDATED="$(printf "%s\n%s\n" "$CLEANED" "$CRON_LINE" | sed '/^$/d')"

printf "%s\n" "$UPDATED" | crontab -
echo "已安装每日任务: $CRON_TIME"
echo "查看日志: tail -f $LOG_FILE"

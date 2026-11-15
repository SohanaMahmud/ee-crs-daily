#!/bin/bash
# Installs ee-crs-daily and schedules it every day at 18:00 with macOS launchd (no Claude needed).
# Usage: ./install.sh            (or ./install.sh 18 0  for hour and minute)
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"
HOUR="${1:-18}"; MIN="${2:-0}"
LABEL="ca.ee-crs-daily"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js is not installed. Install it (e.g. 'brew install node') and run this again."; exit 1; }
echo "Using Node $("$NODE" -v) at $NODE"

npm install --omit=dev --no-audit --no-fund
npx playwright install chromium

if [ ! -f config.json ]; then
  cp config.example.json config.json
  chmod 600 config.json
  echo
  echo "Created config.json. Fill it in (CSV source + Gmail app password), then run:"
  echo "  node crs-daily.js --dry-run"
  echo "and run ./install.sh again to schedule it."
  exit 0
fi
chmod 600 config.json
mkdir -p logs

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$DIR/crs-daily.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MIN</integer></dict>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StandardOutPath</key><string>$DIR/logs/run.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/run.log</string>
</dict>
</plist>
PL

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
printf "Scheduled: every day at %02d:%02d. Log: %s/logs/run.log\n" "$HOUR" "$MIN" "$DIR"
echo "Run it now (sends the email):  launchctl kickstart gui/$(id -u)/$LABEL"

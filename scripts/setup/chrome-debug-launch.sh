#!/usr/bin/env bash
# chrome-debug-launch.sh — start Google Chrome with --remote-debugging-port=9222 if not already listening.
#
# Invoked by the com.user.chrome-debug LaunchAgent at login. The remote-debug
# port is the entry point puppeteer-core uses (analyst's plan-utilization
# monitor) to scrape claude.ai/settings/usage from Saurav's logged-in Chrome
# session.
#
# Idempotent: if a Chrome instance is already serving DevTools on :9222 we
# exit cleanly. If port :9222 is free we launch Chrome with the flag,
# preserving the user's default profile (NOT a separate profile — the
# point is to reuse the logged-in claude.ai tab).
#
# Caveat: if Chrome is already running WITHOUT --remote-debugging-port the
# launch is a no-op (Chrome refuses to attach a debug port to an existing
# instance) and the script logs a hint. In that case Saurav must quit Chrome
# completely (⌘Q, not ⌘W) and re-run this script (or `launchctl kickstart`
# the agent) to take effect.

set -euo pipefail

PORT="${CHROME_DEBUG_PORT:-9222}"
CHROME_APP="/Applications/Google Chrome.app"
LOG_PREFIX="[chrome-debug-launch]"

if curl -fsS --max-time 2 "http://localhost:${PORT}/json/version" >/dev/null 2>&1; then
  echo "${LOG_PREFIX} Chrome DevTools already serving on :${PORT} — nothing to do."
  exit 0
fi

if pgrep -f "Google Chrome" >/dev/null 2>&1; then
  echo "${LOG_PREFIX} Chrome is running but :${PORT} is not open."
  echo "${LOG_PREFIX} A running Chrome cannot adopt a debug port — quit Chrome (⌘Q) and re-run."
  echo "${LOG_PREFIX} Re-run via: launchctl kickstart -k gui/\$(id -u)/com.user.chrome-debug"
  exit 1
fi

if [ ! -d "${CHROME_APP}" ]; then
  echo "${LOG_PREFIX} ${CHROME_APP} not found." >&2
  exit 2
fi

echo "${LOG_PREFIX} Launching Chrome with --remote-debugging-port=${PORT} on the default profile."
open -a "${CHROME_APP}" --args --remote-debugging-port="${PORT}"

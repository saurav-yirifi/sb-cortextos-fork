# scripts/setup/

One-time operator setup artifacts that aren't cortextos daemon infra and aren't agent code. Things you install once on a fresh Mac and forget about.

## `com.user.chrome-debug.plist.template` + `chrome-debug-launch.sh`

LaunchAgent that ensures Google Chrome is running with `--remote-debugging-port=9222` on the default profile after every login. This is the persistence half of Phase 1 for analyst's plan-utilization monitor (`orgs/sb-personal/agents/analyst/specs/plan-utilization-monitoring.md`) — the monitor's `puppeteer-core` `connect()` call needs a debug-port-enabled Chrome session to scrape `claude.ai/settings/usage`.

### Why this exists

Without the LaunchAgent, every Mac reboot drops the debug port and the plan-utilization monitor pages the operator with `chrome_not_running`. This puts the start-Chrome-with-flag step on launchd instead of human memory.

### Install (one-time)

```bash
# 1. Copy the launcher script to a stable location and make it executable
mkdir -p "$HOME/Library/Application Support/com.user.chrome-debug"
cp scripts/setup/chrome-debug-launch.sh \
   "$HOME/Library/Application Support/com.user.chrome-debug/chrome-debug-launch.sh"
chmod +x "$HOME/Library/Application Support/com.user.chrome-debug/chrome-debug-launch.sh"

# 2. Render the plist with your $HOME path baked in
sed "s|{HOME}|$HOME|g" scripts/setup/com.user.chrome-debug.plist.template \
  > "$HOME/Library/LaunchAgents/com.user.chrome-debug.plist"

# 3. Load it
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.user.chrome-debug.plist"

# 4. Fire it once now (don't wait for next login)
launchctl kickstart -k "gui/$(id -u)/com.user.chrome-debug"

# 5. Verify the port is up and DevTools is listening
curl -fsS http://localhost:9222/json/version | head -1
```

If step 5 returns a `Browser` / `webSocketDebuggerUrl` JSON, you're done. If it errors, check `~/Library/Logs/com.user.chrome-debug.stderr.log`.

### First launch behavior

If Chrome was already running when the LaunchAgent fires, the script logs a hint and exits non-zero. Chrome cannot adopt a debug port retroactively — quit Chrome completely (`⌘Q`, not `⌘W`) and re-run via:

```bash
launchctl kickstart -k "gui/$(id -u)/com.user.chrome-debug"
```

### Two prerequisites the LaunchAgent does NOT solve

The plan-utilization monitor also requires:

1. A logged-in `claude.ai` tab in the same Chrome session (manual; one-time).
2. macOS Accessibility permission granted to whatever process invokes the puppeteer script (granted on first run; one-time).

The plist solves the "is Chrome running with the flag" condition. The other two are out of scope.

### Uninstall

```bash
launchctl bootout "gui/$(id -u)/com.user.chrome-debug" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.user.chrome-debug.plist"
rm -rf "$HOME/Library/Application Support/com.user.chrome-debug"
```

### Considering an alternative

Phase 1 of the plan-utilization monitor depends on three persistent human conditions (Chrome+flag, accessibility, logged-in tab). This plist closes one of them. A lossy-but-zero-dependency alternative exists — aggregate local `~/.claude/projects/*.jsonl` token counts against published Max-20x range mid-points — and is documented in the "Tradeoff" section of `orgs/sb-personal/agents/analyst/specs/plan-utilization-monitoring.md`. Before committing to the Chrome path, decide which pipeline you want; the plist is only useful for the Chrome path.

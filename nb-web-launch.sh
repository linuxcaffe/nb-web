#!/bin/bash
# nb-web-launch.sh — ensure Flask is running, then open the Epiphany PWA
#
# Usage:
#   nb-web-launch.sh           start server (if needed) + open app
#   nb-web-launch.sh --clean   wipe stale SW cache first, then launch
#   nb-web-launch.sh --stop    stop the Flask server
#
# First-time setup:
#   Open http://localhost:5001/ in Epiphany, then ⋮ → Install as Web App.
#   After that, this script auto-detects the generated profile.

FLASK_DIR="$HOME/dev/nb-web"
FLASK_LOG="/tmp/nb-web.log"
FLASK_PID_FILE="/tmp/nb-web.pid"
FLASK_URL="http://localhost:5001/"

# Auto-detect Epiphany profile (created when you install the PWA)
EPIPHANY_PROFILE=$(ls -d ~/.local/share/org.gnome.Epiphany.WebApp-nb-web-* 2>/dev/null | head -1)
SW_DIR="${EPIPHANY_PROFILE}/serviceworkers"
CACHE_BASE=$(ls -d ~/.cache/org.gnome.Epiphany.WebApp-nb-web-* 2>/dev/null | head -1)
WEBKIT_CACHE="${CACHE_BASE}/WebKitCache"
SW_CACHE_STORAGE="${CACHE_BASE}/CacheStorage"

# ── --stop: kill server ───────────────────────────────────────────────────────
if [ "$1" = "--stop" ]; then
    if [ -f "$FLASK_PID_FILE" ]; then
        PID=$(cat "$FLASK_PID_FILE")
        kill "$PID" 2>/dev/null && echo "nb-web-launch: stopped Flask (pid $PID)"
        rm -f "$FLASK_PID_FILE"
    else
        pkill -f "python3 app.py" 2>/dev/null && echo "nb-web-launch: stopped Flask" || echo "nb-web-launch: server not running"
    fi
    exit 0
fi

# ── --clean: wipe SW registration + ALL caches, restart Flask ────────────────
if [ "$1" = "--clean" ]; then
    if pgrep -x epiphany-browser > /dev/null; then
        echo "nb-web-launch: closing Epiphany for clean launch..."
        pkill -x epiphany-browser
        sleep 1
    fi
    if [ -d "$SW_DIR" ]; then
        echo "nb-web-launch: removing service worker registration..."
        rm -rf "$SW_DIR"
    fi
    if [ -d "$WEBKIT_CACHE" ]; then
        echo "nb-web-launch: removing WebKit HTTP cache..."
        rm -rf "$WEBKIT_CACHE"
    fi
    if [ -d "$SW_CACHE_STORAGE" ]; then
        echo "nb-web-launch: removing SW CacheStorage (Cache API)..."
        rm -rf "$SW_CACHE_STORAGE"
    fi
    if [ -f "$FLASK_PID_FILE" ]; then
        PID=$(cat "$FLASK_PID_FILE")
        kill "$PID" 2>/dev/null && echo "nb-web-launch: restarting Flask (pid $PID)..."
        rm -f "$FLASK_PID_FILE"
        sleep 0.5
    else
        pkill -f "python3 app.py" 2>/dev/null \
            && echo "nb-web-launch: restarting Flask..." \
            && sleep 0.5
    fi
fi

# ── Start Flask if not already running ───────────────────────────────────────
if curl -s "$FLASK_URL" > /dev/null 2>&1; then
    echo "nb-web-launch: server already running"
else
    echo "nb-web-launch: starting Flask server..."
    cd "$FLASK_DIR" || { echo "ERROR: $FLASK_DIR not found"; exit 1; }
    python3 app.py > "$FLASK_LOG" 2>&1 &
    FLASK_PID=$!
    echo "$FLASK_PID" > "$FLASK_PID_FILE"

    for i in $(seq 1 20); do
        curl -s "$FLASK_URL" > /dev/null 2>&1 && break
        sleep 0.5
    done

    if ! curl -s "$FLASK_URL" > /dev/null 2>&1; then
        echo "ERROR: Flask server failed to start. Check $FLASK_LOG"
        kill "$FLASK_PID" 2>/dev/null
        rm -f "$FLASK_PID_FILE"
        exit 1
    fi
    echo "nb-web-launch: server ready (pid $FLASK_PID)"
fi

# ── Launch Epiphany PWA (detaches; server keeps running) ─────────────────────
if [ -z "$EPIPHANY_PROFILE" ]; then
    echo "nb-web-launch: PWA not installed yet — opening in regular Epiphany."
    echo "  Install via ⋮ → Install as Web App, then re-run this script."
    epiphany-browser "$FLASK_URL" &
else
    epiphany-browser --application-mode \
        "--profile=$EPIPHANY_PROFILE" \
        "$FLASK_URL" &
fi

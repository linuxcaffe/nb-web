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
#
# nb-web runs containerized (rootless Podman) as a systemd --user unit --
# see claude:nb-web_phase2_docker_and_permissions_2026-07-18.md. This
# script now drives that unit instead of spawning `python3 app.py` and
# tracking a pid file; the Epiphany cache-clearing logic below is
# unrelated to that change (pure browser-side state) and is untouched.
# A fresh rebuild's first start can take up to ~1min (rootless Podman's
# --userns=keep-id pays a one-time ID-mapped-layer-copy cost per image
# build); restarts of an already-built image are near-instant.
#
# Any (re)start warns (doesn't block) if the running image's baked-in commit
# doesn't match this repo's local HEAD -- a restart, --clean or otherwise,
# never picks up new commits, only .tools/rebuild-container.sh does. Bit
# twice silently before this warning existed (2026-08-02, see
# .checks/sys-container-stale.sh's own header for the first incident).

FLASK_URL="http://localhost:5001/"
NBWEB_UNIT="container-nb-web.service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Stale-image check — offers to rebuild, doesn't just warn ─────────────────
# A restart (--clean or otherwise) reuses whatever image is already built --
# it never picks up new commits, only a rebuild does. This bit twice now
# (see .checks/sys-container-stale.sh's own header, root-caused 2026-08-02):
# a whole feature got shipped across several commits, this script's --clean
# was run believing it would deploy the fix, and it silently didn't -- the
# container kept serving code from before the session started, no error,
# nothing to notice except unexpectedly-old behavior in the browser. That
# check only ever ran as an ambient note-level check inside nb-web itself,
# never wired into the actual command that causes the gap. First fix here was
# a passive warning; upgraded same day to an actual Y/n prompt (default yes)
# so the fix is one keypress away instead of a second remembered command.
_warn_if_stale() {
    command -v podman > /dev/null 2>&1 || return 0
    podman inspect nb-web > /dev/null 2>&1 || return 0
    [ -d "$SCRIPT_DIR/.git" ] || return 0

    local image_commit repo_head
    image_commit=$(podman inspect nb-web --format '{{index .Config.Labels "nb_web_commit"}}' 2>/dev/null)
    if [ -z "$image_commit" ] || [ "$image_commit" = "<no value>" ] || [ "$image_commit" = "unknown" ]; then
        return 0   # no usable label to compare against
    fi

    repo_head=$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null)
    if [ -z "$repo_head" ] || [ "$repo_head" = "$image_commit" ]; then
        return 0   # up to date
    fi

    echo "nb-web-launch: container image is stale (has $image_commit, repo HEAD is $repo_head) -- a restart alone won't pick this up."
    if [ ! -t 0 ]; then
        echo "nb-web-launch: no terminal to prompt on -- run .tools/rebuild-container.sh, or re-run this interactively to be asked."
        return 0
    fi
    local _ans
    read -r -p "nb-web-launch: rebuild now? [Y/n] " _ans
    case "$_ans" in
        [nN]*) echo "nb-web-launch: skipping -- this launch will keep serving $image_commit." ;;
        *)     "$SCRIPT_DIR/.tools/rebuild-container.sh" ;;
    esac
}

# Auto-detect Epiphany profile (created when you install the PWA)
EPIPHANY_PROFILE=$(ls -d ~/.local/share/org.gnome.Epiphany.WebApp-nb-web-* 2>/dev/null | head -1)
SW_DIR="${EPIPHANY_PROFILE}/serviceworkers"
CACHE_BASE=$(ls -d ~/.cache/org.gnome.Epiphany.WebApp-nb-web-* 2>/dev/null | head -1)
WEBKIT_CACHE="${CACHE_BASE}/WebKitCache"
SW_CACHE_STORAGE="${CACHE_BASE}/CacheStorage"

# ── --stop: stop the container ────────────────────────────────────────────────
if [ "$1" = "--stop" ]; then
    if systemctl --user is-active --quiet "$NBWEB_UNIT"; then
        systemctl --user stop "$NBWEB_UNIT" && echo "nb-web-launch: stopped ($NBWEB_UNIT)"
    else
        echo "nb-web-launch: server not running"
    fi
    exit 0
fi

# ── --clean: wipe SW registration + ALL caches, restart Flask ────────────────
if [ "$1" = "--clean" ]; then
    _warn_if_stale
    if pgrep -x epiphany > /dev/null; then
        echo "nb-web-launch: closing Epiphany for clean launch..."
        pkill -x epiphany
        sleep 1
    fi
    # Delete Epiphany session so restore doesn't reopen stale nb-web tabs.
    # Editing the XML surgically breaks it; a clean wipe is safer.
    if ls ~/.local/share/epiphany/session_state.xml* > /dev/null 2>&1; then
        echo "nb-web-launch: clearing Epiphany session (prevents stale tab restore)..."
        rm -f ~/.local/share/epiphany/session_state.xml \
              ~/.local/share/epiphany/session_state.xml~
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
    # Also clear the main Epiphany SW and cache if no PWA profile.
    # Wipe the whole serviceworkers dir — stale SW registrations crash Epiphany.
    if [ -z "$EPIPHANY_PROFILE" ]; then
        rm -rf ~/.local/share/epiphany/serviceworkers 2>/dev/null
        rm -rf ~/.cache/epiphany/WebKitCache 2>/dev/null
        rm -rf ~/.cache/epiphany/CacheStorage 2>/dev/null
    fi
    if systemctl --user is-active --quiet "$NBWEB_UNIT"; then
        echo "nb-web-launch: restarting ($NBWEB_UNIT)..."
        systemctl --user stop "$NBWEB_UNIT"
        sleep 0.5
    fi
fi

# ── Kill nb browse daemon if running (conflicts with nb-web auto-sync) ────────
if pgrep -f "nb browse --respond" > /dev/null 2>&1; then
    echo "nb-web-launch: killing nb browse daemon (incompatible with nb-web sync model)..."
    pkill -f "nb browse --respond" 2>/dev/null
    pkill -f "socat.*6789" 2>/dev/null
fi

# ── Kill stuck nb sync processes ─────────────────────────────────────────────
# nb sync should complete in seconds; anything still running >60s is hung
# (waiting on an unreachable git remote, burning CPU indefinitely).
# Use elapsed time to avoid killing fresh syncs or nb add commands whose
# --content argument happens to contain the word "sync".
while IFS= read -r _pid; do
    _etime=$(ps -o etimes= -p "$_pid" 2>/dev/null | tr -d ' ')
    if [ -n "$_etime" ] && [ "$_etime" -gt 60 ]; then
        echo "nb-web-launch: killing stuck nb sync (pid $_pid, running ${_etime}s)"
        kill "$_pid" 2>/dev/null
    fi
done < <(pgrep -f "nb [a-z_-]*:?sync" 2>/dev/null)

# ── Start the container if not already running ───────────────────────────────
if curl -s "$FLASK_URL" > /dev/null 2>&1; then
    echo "nb-web-launch: server already running"
else
    _warn_if_stale
    echo "nb-web-launch: starting $NBWEB_UNIT..."
    systemctl --user start "$NBWEB_UNIT"

    # Up to ~2min: a freshly rebuilt image pays a one-time ID-mapped-layer
    # copy cost (rootless Podman's --userns=keep-id) on first container
    # creation, observed up to ~1min on this system. Restarts of an
    # already-built image are near-instant, so this rarely runs long.
    for i in $(seq 1 40); do
        curl -s "$FLASK_URL" > /dev/null 2>&1 && break
        sleep 3
    done

    if ! curl -s "$FLASK_URL" > /dev/null 2>&1; then
        echo "ERROR: server failed to start. Check: journalctl --user -u $NBWEB_UNIT"
        exit 1
    fi
    echo "nb-web-launch: server ready"
fi

# ── Launch Epiphany PWA (detaches; server keeps running) ─────────────────────
if [ -z "$EPIPHANY_PROFILE" ]; then
    echo "nb-web-launch: PWA not installed yet — opening in regular Epiphany."
    echo "  Install via ⋮ → Install as Web App, then re-run this script."
    # Only open if not already showing nb-web (avoid stacking tabs on re-run)
    if ! pgrep -x epiphany > /dev/null; then
        epiphany-browser "$FLASK_URL" &
    else
        echo "nb-web-launch: Epiphany already running — skipping open."
    fi
else
    if ! pgrep -x epiphany > /dev/null; then
        epiphany-browser --application-mode \
            "--profile=$EPIPHANY_PROFILE" \
            "$FLASK_URL" &
    else
        echo "nb-web-launch: Epiphany PWA already running — skipping open."
    fi
fi

# nb-web — Phase 2 single-tenant image (see claude:nb_web.md roadmap).
#
# Build (GIT_COMMIT bakes in which commit this image actually is -- see the
# LABEL below; without it nbweb-tui's Process tab can't tell a stale image
# apart from one that matches the current checkout):
#   podman build --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) \
#     -t nb-web -f Containerfile .
#
# Run (djp as tenant 0, real ~/.nb mounted read-write):
#   podman run -d --name nb-web \
#     -p 5001:5001 \
#     -v ~/.nb:/data:Z \
#     -v ~/.nb-web-secrets/.flask_secret:/app/.flask_secret:Z \
#     -v ~/.nb-web-secrets/.api_token:/app/.api_token:Z \
#     -v ~/.nb-web-secrets/nb-settings.json:/app/nb-settings.json:Z \
#     nb-web
#
# In practice: `systemctl --user restart container-nb-web.service` after a
# rebuild (see ~/.config/systemd/user/container-nb-web.service) -- this raw
# `podman run` form is for a first-time/manual run.
#
# The two secret files are bind-mounted individually rather than baked into
# the image or left inside /app: app.py auto-generates them next to itself
# (Path(__file__).parent) if missing, and /app is an image layer rebuilt on
# every deploy, not a persistent volume. Without this, every image rebuild
# would mint a new Flask secret and silently invalidate every session and
# nb-new-item's API token. Create the empty host files once
# (`mkdir -p ~/.nb-web-secrets && touch ~/.nb-web-secrets/.flask_secret
# ~/.nb-web-secrets/.api_token`) before first run so Podman bind-mounts
# files, not directories.
#
# Deferred, not in this pass: gh CLI auth (nb-website/quartz publish),
# afterwriting/node PDF export, SSH keys for `nb sync` git push/pull from
# inside the container. See claude:nb_web.md Phase 2 checklist.

FROM python:3.10-slim-bookworm

# Which commit this image actually is -- read by nbweb-tui's Process tab
# (process.nb_web_commit()) so a stale, un-rebuilt image reports its real,
# stale commit instead of silently reading the checkout's current HEAD and
# claiming to be up to date. Defaults to "unknown" if built without the
# --build-arg, rather than a misleading guess.
ARG GIT_COMMIT=unknown
LABEL nb_web_commit=$GIT_COMMIT

# git: nb CLI + every notebook's own git repo. hledger/taskwarrior: the two
# plugin codeblock backends that already degrade gracefully (503) if
# missing, but Phase 2's own scope is a real single-tenant deploy, not a
# crippled one.
#
# `nb` itself is fetched directly (git clone --depth 1, public HTTPS, no
# auth needed) rather than via `apt install nodejs npm && npm install -g
# nb.sh` -- nb is a plain bash script (confirmed: `head -1` on the real
# installed binary is `#!/usr/bin/env bash`), npm was only ever being used
# as an installer convenience. Real cost discovered the hard way: Debian's
# nodejs/npm packages drag in a huge, mostly-irrelevant dependency tree
# (webpack, eslint, jest, babel -- none of which `nb` needs), which under
# rootless Podman's --userns=keep-id turned "create a fresh container" into
# a 3+ minute operation (per-file chown of the whole ID-mapped layer copy,
# confirmed via `time podman run`) -- unworkable for a tool restarted on
# every code change. Cloning just the script avoids the entire dependency
# tree.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        curl \
        hledger \
        taskwarrior \
    && git clone --depth 1 https://github.com/linuxcaffe/nb.git /tmp/nb-src \
    && install -m 0755 /tmp/nb-src/nb /usr/local/bin/nb \
    && rm -rf /tmp/nb-src /var/lib/apt/lists/*

# Dedicated, non-root service user/group — the "process ceiling" answer the
# security-architecture tree left open (see
# claude:nb-web_security_architecture_—_root-to-leaf_shape_(confirmed_2026-07-09).md).
# Flask never runs as root inside the container, and rootless Podman's own
# user-namespace remapping means this uid has no path to real root on the
# host either.
#
# Fixed uid/gid 1000 (not --system's arbitrary uid) deliberately: this image
# is scoped to Phase 2 -- a single-tenant self-hoster running it against
# their OWN ~/.nb, bind-mounted straight in. 1000 is the near-universal
# Linux convention for "the primary non-root account," so this matches most
# self-hosters' own uid by convention, not because it's hardcoded to any one
# person -- it just happens to also be djp's. Bind-mounted volume ownership
# is why this matters: a container user with a mismatched uid can't write to
# a host directory it doesn't own. Revisit at Phase 3/4, where tenant uid
# and box-owner uid are no longer the same thing by definition.
RUN groupadd --gid 1000 nbweb && useradd --uid 1000 --gid nbweb --create-home nbweb

# `nb` refuses to do anything useful without a configured git identity --
# a fresh container user with no ~/.gitconfig gets `nb`'s own first-run
# setup wizard text instead of real output, which app.py's run_nb() then
# silently parses as data (same failure shape as the $EDITOR issue below).
# Matches the identity every existing commit in ~/.nb was already made
# under -- not a placeholder, since Phase 2 is single-tenant and djp is
# the only author these commits will ever have.
RUN su nbweb -c "git config --global user.name 'linuxcaffe' && git config --global user.email 'davamundo@gmail.com'"

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
RUN chown -R nbweb:nbweb /app

# NB_DIR is deliberately NOT $HOME/.nb (app.py's own default) — /data is an
# explicit, unambiguous mount point so the volume contract is obvious from
# `podman run` rather than relying on nbweb's home directory matching
# convention.
ENV NB_DIR=/data
ENV NB_WEB_HOST=0.0.0.0
# The bare-metal server has always had $EDITOR set via the desktop session
# environment it inherits -- the container has no such session, so `nb`
# printed its own "$EDITOR not set" help text on every call instead of real
# output, and app.py's run_nb() (which just captures stdout as-is) silently
# parsed that help text as data. Confirmed nb-web never needs an editor to
# actually launch -- every `nb edit` call in app.py passes --content
# explicitly -- so `true` is a safe no-op, not a masked real dependency.
ENV EDITOR=true
VOLUME /data

EXPOSE 5001

USER nbweb

# gunicorn, not `python3 app.py` (Flask's own dev server): the dev server
# doesn't handle SIGTERM, so every container stop/restart used to wait out
# Podman's ~10s grace period and get SIGKILLed -- systemd then logged a
# completely normal stop as a failure. gthread (not sync/default) because
# flask-sock's PTY/Claude-streaming websockets need real per-connection
# concurrency, matching app.py's own `threaded=True` dev-server behaviour;
# 1 worker (not N) to match that same single-process model exactly --
# app.py has module-level state (caches, locks) that assumes one process.
# Verified empirically, not assumed: simple_websocket has explicit built-in
# support for gunicorn's sync/gthread workers (`gunicorn.socket` in the WSGI
# environ) -- confirmed by reading the installed library source, then
# proven by actually opening a real /ws/pty session through gunicorn and
# reading real streamed shell output back.
#
# --graceful-timeout 8 (below Podman's own ~10s stop grace period)
# deliberately: an OPEN websocket connection (someone's terminal left open)
# still can't be gracefully drained -- flask-sock hijacks the raw socket for
# the connection's whole lifetime, so gunicorn's graceful-shutdown model
# (wait for in-flight requests to finish naturally) waits forever on one
# that never finishes on its own. Bounding it to 8s means gunicorn force-
# closes it on its own terms before Podman's harsher outer SIGKILL would
# anyway -- one deliberate, tunable timeout instead of two stacked ones.
# --no-control-socket: gunicorn 26's own interactive control socket
# defaults to a path under $HOME, which fails under --read-only (logs an
# ERROR on every boot, though non-fatal). Not needed here -- systemd/Podman
# already own process control -- so disabled outright rather than carving
# out another writable exception for a feature nothing uses.
CMD ["gunicorn", "-c", "gunicorn.conf.py", "--worker-class", "gthread", "--workers", "1", \
     "--threads", "8", "--graceful-timeout", "8", "--no-control-socket", \
     "--bind", "0.0.0.0:5001", "app:app"]

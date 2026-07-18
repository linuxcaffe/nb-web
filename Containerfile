# nb-web — Phase 2 single-tenant image (see claude:nb_web.md roadmap).
#
# Build:
#   podman build -t nb-web -f Containerfile .
#
# Run (djp as tenant 0, real ~/.nb mounted read-write):
#   podman run -d --name nb-web \
#     -p 5001:5001 \
#     -v ~/.nb:/data:Z \
#     -v ~/.nb-web-secrets/.flask_secret:/app/.flask_secret:Z \
#     -v ~/.nb-web-secrets/.api_token:/app/.api_token:Z \
#     nb-web
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

# git: nb CLI + every notebook's own git repo. hledger/taskwarrior: the two
# plugin codeblock backends that already degrade gracefully (503) if
# missing, but Phase 2's own scope is a real single-tenant deploy, not a
# crippled one. nodejs/npm: nb CLI's install/distribution mechanism (it's a
# shell script; npm just bundles and can update it).
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        curl \
        nodejs \
        npm \
        hledger \
        taskwarrior \
    && npm install -g nb.sh \
    && rm -rf /var/lib/apt/lists/*

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

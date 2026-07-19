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
#     -v ~/.nb:/home/nbweb/.nb:Z \
#     -v ~/.taskrc:/home/nbweb/.taskrc:Z,ro \
#     -v ~/.task:/home/nbweb/.task:Z \
#     -v ~/dev/nbweb-cine:/home/nbweb/dev/nbweb-cine:Z,ro \
#     -v ~/dev/nbweb-claude:/home/nbweb/dev/nbweb-claude:Z,ro \
#     -v ~/.nb-web-secrets/.flask_secret:/app/.flask_secret:Z \
#     -v ~/.nb-web-secrets/.api_token:/app/.api_token:Z \
#     -v ~/.nb-web-secrets/nb-settings.json:/app/nb-settings.json:Z \
#     nb-web
#
# In practice: `systemctl --user restart container-nb-web.service` after a
# rebuild (see ~/.config/systemd/user/container-nb-web.service) -- this raw
# `podman run` form is for a first-time/manual run.
#
# HOME-mirroring, not an arbitrary /data mountpoint: app.py has several
# Path.home()-relative dependencies beyond just NB_DIR (hledger journal
# includes, taskwarrior timelog, plugin asset paths), traced 2026-07-19 after
# the "journal not found" incident -- real journal files use `~/...` absolute
# includes, which only resolve if the container's home actually mirrors the
# host's. Mounting ~/.nb at /home/nbweb/.nb (nbweb's real home, matching
# app.py's own default Path.home()/'.nb') instead of an unrelated /data name
# makes every current AND future `~/...` reference resolve for free, rather
# than chasing each one individually as it's discovered. ~/.task is a
# genuinely separate system (own binary, own DB, used outside nb-web too) --
# mounted explicitly rather than folded into ~/.nb. ~/.taskrc itself needed
# the same treatment as the hledger journals: it had a hardcoded absolute
# `data.location=/home/<user>/.task`, found live in scratch-container
# testing (task count failed -- "no rc file" -- because .taskrc wasn't
# mounted, then failed again after mounting it because the absolute path
# didn't resolve); fixed at the source (`data.location=~/.task`, taskwarrior
# expands `~` itself) rather than patched per-environment. ~/dev/nbweb-cine
# and ~/dev/nbweb-claude are nb-web's own plugin repos, referenced from
# inside ~/.nb via *relative* symlinks under .web/external/ (see app.py's
# _COURIER_PRIME_DIR / _NBWEB_CLAUDE_MCP_SERVER) -- relative, not absolute,
# so they resolve correctly regardless of which username owns the home
# directory on either side (an absolute-target version of these same
# symlinks was also found broken live: it hardcoded djp's host username into
# the symlink target, which doesn't exist inside the container's nbweb
# home). Mounted read-only at the same host-relative sibling path (.nb and
# dev/* as siblings, on both sides) so the relative symlinks resolve.
#
# The three secret/settings files are bind-mounted individually rather than
# baked into the image or left inside /app: app.py auto-generates them next
# to itself (Path(__file__).parent) if missing, and /app is an image layer
# rebuilt on every deploy, not a persistent volume. Without this, every image
# rebuild would mint a new Flask secret and silently invalidate every session
# and nb-new-item's API token. Create the empty host files once
# (`mkdir -p ~/.nb-web-secrets && touch ~/.nb-web-secrets/.flask_secret
# ~/.nb-web-secrets/.api_token`) before first run so Podman bind-mounts
# files, not directories.
#
# Deferred, not in this pass: gh CLI auth (nb-website/quartz publish), Node
# for Quartz builds (not needed until that feature is actually exercised
# in-container -- app.py's nvm-PATH lookup already no-ops safely if absent),
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

# Build-time smoke test, not a runtime one: fail the BUILD if a dependency
# app.py silently degrades without (rather than crashing on) isn't actually
# installed. This is the exact gap that caused the 2026-07-18 "everything is
# broken" incident -- app.py wraps `import yaml` in try/except ImportError
# with no crash and no log line, so a missing PyYAML silently turned every
# structured frontmatter value (dicts, arrays) into an unparsed raw string
# across unrelated features (checks, hledger, taskwarrior, git, nb command
# dispatch...) instead of loudly failing anywhere. Deliberately does NOT
# `import app` here -- that would trigger app.py's own module-load side
# effects (_get_secret_key()/_get_api_token() writing .flask_secret/
# .api_token next to themselves), baking a throwaway secret into this image
# layer, which is exactly what the bind-mounted-secrets design avoids.
# See claude:nb-web_phase2_docker_and_permissions_2026-07-18.md.
RUN python3 -c "import yaml, markdown" || \
    (echo "FATAL: a dependency app.py silently degrades without (not crashes without) failed to import -- see the comment above this RUN step" && exit 1)

COPY . .
RUN chown -R nbweb:nbweb /app

# No NB_DIR override: app.py's own default (Path.home()/'.nb') applies
# naturally once HOME is right, which it is -- nbweb's real home
# (/home/nbweb, from --create-home above) is exactly where the run
# invocation mounts ~/.nb. Superseded 2026-07-19: an explicit /data
# mountpoint was cleaner in isolation, but app.py has several other
# Path.home()-relative dependencies (hledger includes, taskwarrior,
# plugin assets) that only resolve if the container's home genuinely
# mirrors the host's -- see the header comment above.
ENV NB_WEB_HOST=0.0.0.0
# The bare-metal server has always had $EDITOR set via the desktop session
# environment it inherits -- the container has no such session, so `nb`
# printed its own "$EDITOR not set" help text on every call instead of real
# output, and app.py's run_nb() (which just captures stdout as-is) silently
# parsed that help text as data. Confirmed nb-web never needs an editor to
# actually launch -- every `nb edit` call in app.py passes --content
# explicitly -- so `true` is a safe no-op, not a masked real dependency.
ENV EDITOR=true
VOLUME /home/nbweb/.nb
VOLUME /home/nbweb/.task

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

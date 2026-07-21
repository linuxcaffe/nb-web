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
#     -v ~/dev:/home/nbweb/dev:Z \
#     -v ~/.config/gh:/home/nbweb/.config/gh:Z,ro \
#     -v ${SSH_AUTH_SOCK}:/run/ssh-agent.sock:Z \
#     -e SSH_AUTH_SOCK=/run/ssh-agent.sock \
#     -v ~/.ssh/known_hosts:/home/nbweb/.ssh/known_hosts:Z,ro \
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
# mounted explicitly rather than folded into ~/.nb. ~/.hledger.journal isn't
# in this mount list at all -- it's created as an in-container symlink
# instead (see the `ln -s .nb/accts/personal.journal` RUN step below),
# needed because _hledger_journal_path() falls back to
# Path.home()/'.hledger.journal' for any notebook whose .nb-hledger.json
# doesn't set an explicit journal (preciousfinds.ca does exactly this --
# `.nb-hledger.json` is `{}`, a stub, never filled in -- found live,
# 2026-07-19, as check-sweep's "Journal not found" errors across the whole
# notebook). A bind mount was tried first and rejected: it dereferences the
# host symlink into a flat file, which breaks personal.journal's own
# relative `include accounts.journal` -- see the RUN step's own comment.
# ~/.taskrc itself needed
# the same treatment as the hledger journals: it had a hardcoded absolute
# `data.location=/home/<user>/.task`, found live in scratch-container
# testing (task count failed -- "no rc file" -- because .taskrc wasn't
# mounted, then failed again after mounting it because the absolute path
# didn't resolve); fixed at the source (`data.location=~/.task`, taskwarrior
# expands `~` itself) rather than patched per-environment. ~/dev is mounted
# wholesale (read-only), not per-repo: nb-web's own plugin repos
# (nbweb-cine, nbweb-claude) are referenced from inside ~/.nb via *relative*
# symlinks under .web/external/ (see app.py's _COURIER_PRIME_DIR /
# _NBWEB_CLAUDE_MCP_SERVER) -- relative, not absolute, so they resolve
# correctly regardless of which username owns the home directory on either
# side (an absolute-target version of these same symlinks was also found
# broken live: it hardcoded djp's host username into the symlink target,
# which doesn't exist inside the container's nbweb home). Separately, the
# sysadmin dashboard's git-status codeblock reads an arbitrary, config-driven
# `git_repos` map from nb-settings.json (currently nb-web, tw-web -- found
# broken live: "Repo path not found" for nb-web itself, which was never
# mounted at all) -- rather than mounting each entry in that config
# individually and re-discovering gaps one repo at a time as new ones get
# added, mount ~/dev as a whole.
#
# Read-write, not read-only -- changed 2026-07-19: /api/website/publish
# needs to `git push` *from* a notebook's configured quartz_path (e.g.
# ~/dev/quartz-preciousfinds.ca), and even a pure outbound push updates the
# local repo's own remote-tracking refs, which needs a writable .git/. Found
# live: "cannot lock ref 'refs/remotes/origin/main': ... Read-only file
# system" -- the notebook's own content push succeeded (via ~/.nb, already
# read-write) but the Quartz config push silently failed, so the triggered
# build could run against stale components/CSS. Accepted as consistent with
# the trust model already in effect here, not a new category of exposure:
# this same container can already push to real GitHub repos with djp's real
# identity via the forwarded ssh-agent + gh token below -- local write
# access to those same repos' checkouts is a strict subset of that
# capability, not an addition to it.
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
# gh CLI (installed below) is no longer deferred -- found live, 2026-07-19,
# trying to publish preciousfinds.ca: /api/website/publish shells out to
# `gh workflow run`/`gh run list` to trigger and poll the Quartz deploy
# workflow, which crashed with an unhandled FileNotFoundError (gh wasn't
# installed at all, and api_website_publish's gh subprocess.run call isn't
# wrapped in its own try/except the way sibling endpoints are). `gh` itself
# reads its auth token from $HOME/.config/gh/hosts.yml by default -- same
# HOME-mirroring mount contract as everything else, mounted read-only since
# the container only ever needs to read djp's existing host auth, never
# manage it. Real credential material (unlike ~/.task or ~/dev, which are
# djp's own data/code): accepted under the same single-tenant, djp-is-
# tenant-0 trust model already covering the rest of this mount list, not a
# new category of exposure.
#
# SSH (openssh-client, installed below) is no longer deferred either --
# found live, 2026-07-19, in the same preciousfinds.ca publish attempt as
# the gh gap above: djp's git remotes use the ssh:// protocol
# (git@github.com:...), and the `ssh` binary wasn't in the image at all
# ("cannot run ssh: No such file or directory"). Fixed the same way as gh:
# read djp's existing host auth rather than provision new credentials for
# the container. Specifically **forwards the host's ssh-agent socket**
# (`$SSH_AUTH_SOCK`, GNOME Keyring's agent in djp's case) rather than
# mounting raw private key files -- the container gets a signing channel,
# never the key bytes themselves, a real difference for a socket that's
# reachable from every request handler in the process. `--userns=keep-id`
# makes this work without extra permission wrangling: the container's
# `nbweb` process runs as the real host UID underneath, and the socket is
# already owned by that same UID. `~/.ssh/known_hosts` mounted read-only so
# the first real connection to github.com doesn't hang on an interactive
# host-key prompt with no TTY to answer it (`GIT_TERMINAL_PROMPT=0` already
# suppresses the credential-prompt half of this class of problem, not the
# host-key half).
#
# Still deferred, not in this pass: Node for Quartz builds (not needed until
# that specific feature is exercised in-container -- app.py's nvm-PATH
# lookup already no-ops safely if absent), afterwriting/node PDF export.
# See claude:nb_web.md Phase 2 checklist.

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
#
# hledger is NOT the apt package -- found live, 2026-07-19: Debian
# bookworm's `hledger` apt package is 1.25 (stale; that release line is
# years old), while djp's host installs hledger via Homebrew, currently
# 1.51.2, and real journal-note codeblocks use flags/behavior that only
# exist on the newer release (`register -n 15` hard-errored as an unknown
# flag on 1.25). Fetching the same upstream static-binary release djp's
# Homebrew install effectively tracks keeps both environments on equivalent
# footing instead of silently diverging on Debian's packaging cadence --
# same "fetch the real artifact, don't trust the distro's stale channel"
# principle as the `nb` fetch above. Pinned explicitly (not "latest") for
# reproducibility, matching the taskwarrior version-pin precedent below.
ARG HLEDGER_VERSION=1.51.2
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        curl \
        gh \
        openssh-client \
        taskwarrior \
    && git clone --depth 1 https://github.com/linuxcaffe/nb.git /tmp/nb-src \
    && install -m 0755 /tmp/nb-src/nb /usr/local/bin/nb \
    && rm -rf /tmp/nb-src \
    && curl -sL "https://github.com/simonmichael/hledger/releases/download/${HLEDGER_VERSION}/hledger-linux-x64.tar.gz" \
        -o /tmp/hledger.tar.gz \
    && tar -xzf /tmp/hledger.tar.gz -C /usr/local/bin hledger \
    && chmod 0755 /usr/local/bin/hledger \
    && rm -rf /tmp/hledger.tar.gz /var/lib/apt/lists/*

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

# SSH connection multiplexing (ControlMaster/ControlPersist) -- found live,
# 2026-07-19, stress-testing the new "sync all notebooks" feature: 17
# notebooks synced in a tight sequential loop, each opening its own fresh
# SSH connection for pull and another for push (up to ~34 handshakes in a
# short burst) -- 8 of the 17 failed, either "Connection closed" mid-
# handshake or a 30s timeout. A single git push earlier tonight (nb-web's
# own repo) hit the exact same "Connection closed" shape once too, in
# isolation -- this many fresh handshakes in a burst just multiplies the
# exposure to that same transient failure mode, not a new one. Reusing one
# already-authenticated connection per host (instead of re-handshaking on
# every single git operation) both removes most of the surface for it and
# is substantially faster. ControlPath uses %C (a hash of the connection
# tuple) rather than the more common %r@%h:%p form -- Unix domain socket
# paths have a real length ceiling (~104 bytes on Linux) that %r@%h:%p can
# exceed for a long username/hostname combination; %C is OpenSSH's own
# recommended safe form. Baked into the image (nbweb's own ~/.ssh/config),
# not the host's real ~/.ssh/config -- this is container-specific
# infrastructure, not something that should change djp's own SSH behavior
# outside the container. Permissions matter: sshd -- and here, the ssh
# *client* config loader -- silently ignores a config file that's group- or
# world-writable, so 700/600 are load-bearing, not just convention.
RUN su nbweb -c "mkdir -p -m 700 /home/nbweb/.ssh && \
    printf 'Host *\n  ControlMaster auto\n  ControlPath /tmp/ssh-mux-%%C\n  ControlPersist 600\n' \
        > /home/nbweb/.ssh/config && \
    chmod 600 /home/nbweb/.ssh/config"

# ~/.hledger.journal as an in-container symlink, not a bind mount of the
# host's symlink -- found live, 2026-07-19: bind-mounting a symlink *source*
# path dereferences it at mount time (Podman mounts the resolved target's
# content as a plain file at the destination, not a symlink), which breaks
# personal.journal's own relative `include accounts.journal` -- hledger
# resolves that against the *including file's own location*, and a flat
# /home/nbweb/.hledger.journal has no accounts.journal next to it. hledger
# resolves relative includes through symlinks fine (confirmed: the host's
# own ~/.hledger.journal symlink works), so recreating the symlink here
# achieves the same thing correctly, and needs no separate mount at all
# since ~/.nb is already mounted at this exact relative location.
RUN su nbweb -c "ln -s .nb/accts/personal.journal /home/nbweb/.hledger.journal"

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

# plugins/{nbweb-cine,nbweb-claude,nbweb-hledger}.js are committed as
# symlinks to sibling ~/dev/nbweb-* checkouts -- real dev repos that nb-web
# itself doesn't vendor, matching nb-config's manifest (separately cloned/
# managed plugin repos, symlinked in for serving). Fixed host-side to be
# relative (../../nbweb-X/...), which resolves correctly on ANY host since
# nb-web and nbweb-X really are siblings under ~/dev there -- but COPY bakes
# in that symlink's literal (relative) target too, and inside the image
# /app is not a sibling of the ~/dev bind mount (an image layer and a
# runtime volume, not related paths) -- ../../nbweb-cine from /app/plugins/
# lands on /nbweb-cine, nowhere. Found live, 2026-07-19: specialty toolbars
# and the cine `shots` codeblock silently failed to load (dangling
# symlinks), the actual root cause of both -- not fixed by any of the
# ~/.nb-relative work above, a completely separate mechanism (this repo's
# own plugin-loading symlinks, not app.py's Path.home() references).
# Re-point them at this image's own known, controlled mount contract (the
# ~/dev bind mount above) instead of trusting whatever the host committed --
# same "reconfigure the image for its own environment, don't guess" approach
# as the UID/keep-id fix.
#
# nbweb-specialty is NOT in this list -- folded into nb-web core, 2026-07-19
# (subtree merge, full history preserved): it self-labelled `@type core`,
# is a global plugin with no detect() (active for every notebook, unlike
# cine/claude/hledger's genuinely optional vertical scoping), and other
# plugins (nbweb-quartz) already treated its header system as foundational
# infrastructure rather than a peer. Was split into its own repo out of
# habit, not a deliberate choice -- see claude:nb_web.md's Phase 2 plugin-
# sourcing item. Now a real vendored file at plugins/nbweb-specialty.js,
# same category as nbweb-archive.js/nbweb-codeblocks.js/nbweb-contacts.js;
# needs no runtime re-link, no ~/dev access, and (being previously the one
# *private* plugin repo) removes the one case in this list that would have
# needed build-time SSH-agent forwarding once the other three move to a
# build-time public clone instead of a runtime ~/dev mount.
RUN for p in nbweb-cine nbweb-claude nbweb-hledger; do \
        ln -sf "/home/nbweb/dev/$p/$p.js" "/app/plugins/$p.js"; \
    done

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
# _assert_nb_auto_sync_off() (app.py, run from gunicorn.conf.py's on_starting
# hook) tries to persist this by writing ~/.nbrc via `nb set auto_sync 0` --
# but this image runs --read-only, and ~/.nbrc isn't a writable bind-mount,
# so that write has been silently failing since Phase 2 shipped (confirmed
# live 2026-07-20: `touch /home/nbweb/.nbrc` -> "Read-only file system").
# The function's own success-check only looks for "set to 0" in the
# subprocess output, so a silent failure still prints the same reassuring
# "NB_AUTO_SYNC: OK (0)" -- nothing ever surfaced the gap. Real effect: nb's
# auto_sync fell back to its own built-in default (not 0) for every `nb`
# invocation inside the container, including the ordinary `nb show <selector>
# --path` calls app.py shells out to while serving normal note requests --
# and auto-sync pulling on every add/edit/delete is exactly the documented,
# previously-known cross-notebook-contamination risk under this repo's
# branch-per-notebook design (see _assert_nb_auto_sync_off's own docstring).
# Caught live: a routine check-sweep.py note fetch triggered a ~500-commit
# rebase against the wrong remote branch in the `docs` notebook.
#
# Setting the env var directly here sidesteps the read-only filesystem
# entirely -- .nbrc's own convention (`export
# NB_AUTO_SYNC="${NB_AUTO_SYNC:-0}"`) already defers to an existing
# environment value over the file default, so this wins for every process
# in the container, gunicorn and every `nb`/`git` subprocess it spawns,
# without needing any file write to succeed at all.
ENV NB_AUTO_SYNC=0
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

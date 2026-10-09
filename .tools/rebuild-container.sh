#!/usr/bin/env bash
# Rebuild the real nb-web container from the current repo state and restart
# the live service -- turns the verify skill's documented recipe into an
# actual command instead of copy-pasted shell. Picks the next phase2-vN tag
# automatically, builds, retags `phase2`, restarts container-nb-web.service,
# then verifies the running container's files actually match this checkout
# (not just that the build succeeded) the same way sys-container-stale.sh
# checks for the gap this exists to close.
#
# Usage: .tools/rebuild-container.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."   # nb-web repo root

# `|| true`: with no image at all (after `podman system reset`) grep finds nothing and, under
# pipefail, this used to end the script silently before it built anything (2026-10-07)
last_v=$(podman images --format '{{.Tag}}' localhost/nb-web 2>/dev/null \
    | grep -oP '(?<=^phase2-v)\d+' | sort -n | tail -1 || true)
next_v=$(( ${last_v:-0} + 1 ))
tag="phase2-v${next_v}"
commit=$(git rev-parse --short HEAD)

echo "Building localhost/nb-web:${tag} (nb-web @ ${commit})..."
# the host's git identity, so notebook commits stay attributed as before (no default in the image)
podman build --build-arg GIT_COMMIT="$commit" \
    --build-arg GIT_AUTHOR_NAME="$(git config --global user.name)" \
    --build-arg GIT_AUTHOR_EMAIL="$(git config --global user.email)" \
    -t "localhost/nb-web:${tag}" -f Containerfile .

echo "Tagging as active (localhost/nb-web:phase2)..."
podman tag "localhost/nb-web:${tag}" localhost/nb-web:phase2

echo "Restarting container-nb-web.service..."
# after failed starts (e.g. no image, after a podman reset) systemd refuses with "start request
# repeated too quickly" until the failure count is cleared
systemctl --user reset-failed container-nb-web.service 2>/dev/null || true
systemctl --user restart container-nb-web.service
sleep 3

echo
echo "Verifying..."
running_commit=$(podman inspect nb-web --format '{{index .Config.Labels "nb_web_commit"}}' 2>/dev/null || echo "?")
if [ "$running_commit" = "$commit" ]; then
    echo "OK: running container reports nb-web @ ${commit}, matches this checkout."
else
    echo "MISMATCH: running container reports '${running_commit}', expected '${commit}' -- something went wrong." >&2
    exit 1
fi

for p in nbweb-cine nbweb-claude nbweb-hledger; do
    repo="$(dirname "$PWD")/$p"
    if [ ! -d "$repo/.git" ]; then
        echo "SKIP: $p -- no local checkout at $repo to compare against."
        continue
    fi
    # The image always clones the repo's own default branch (Containerfile's
    # plain `git clone`, no -b) -- never whatever branch happens to be checked
    # out locally. Deriving the comparison branch from `git branch
    # --show-current` used to silently produce ZERO output for a plugin
    # whenever its local checkout was on a feature branch (confirmed live
    # 2026-09-03: nbweb-cine on org-directive-scaffolding --
    # origin/org-directive-scaffolding doesn't exist, both old `|| continue`s
    # fired, and the whole plugin's verification line vanished with no
    # warning at all -- a real rebuild's output had "OK" lines for claude and
    # hledger and nothing whatsoever for cine). Ask the remote which branch
    # is actually default instead of trusting local checkout state.
    branch=$(git -C "$repo" remote show origin 2>/dev/null | sed -n 's/^ *HEAD branch: //p')
    if [ -z "$branch" ]; then
        echo "WARN: $p -- couldn't determine origin's default branch (offline? remote misconfigured?)."
        continue
    fi
    remote_head=$(git -C "$repo" rev-parse --short "origin/$branch" 2>/dev/null)
    if [ -z "$remote_head" ]; then
        echo "WARN: $p -- no local origin/$branch ref; try 'git -C $repo fetch'."
        continue
    fi
    image_commit=$(podman exec nb-web cat "/app/plugins/.$p.commit" 2>/dev/null | tr -d '[:space:]')
    if [ "$image_commit" = "$remote_head" ]; then
        echo "OK: $p @ ${image_commit}, matches origin/$branch."
    else
        echo "NOTE: $p image has '${image_commit:-?}', origin/$branch is '${remote_head}' -- push first if this should match."
    fi
done

echo
echo "Pruning old phase2-vN tags (keeping the newest 5 + phase2)..."
# This keeps `podman images` readable; it frees little. Tagged images share most layers
# (six tags used 0.5 GB together, 2026-10-07). The disk goes elsewhere: podman 3.4 leaks
# layers no image uses, about 5 GB per rebuild, and no prune removes them (CLAUDE.md
# invariant 26). The check at the end of this script says when to reset podman.
old_tags=$(podman images --format '{{.Tag}}' localhost/nb-web 2>/dev/null \
    | grep -oP '(?<=^phase2-v)\d+' | sort -rn | tail -n +6)
for v in $old_tags; do
    podman rmi "localhost/nb-web:phase2-v${v}" 2>/dev/null \
        && echo "  removed phase2-v${v}" \
        || echo "  skipped phase2-v${v} (in use or already gone)"
done

echo
echo "Live at whatever port container-nb-web.service publishes (check with: podman port nb-web)."

# podman 3.4 leaks layers on every build; say so here, where it happens (invariant 26)
leak_check="$HOME/.nb/.checks/sys-podman-leak.sh"
if [ -x "$leak_check" ]; then
    leak=$(bash "$leak_check" 2>/dev/null)
    if [ -n "$leak" ]; then
        echo
        echo "$leak" | sed 's/\*\*//g; s/`//g'
    fi
fi

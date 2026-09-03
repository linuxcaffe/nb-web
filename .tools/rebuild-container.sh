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

last_v=$(podman images --format '{{.Tag}}' localhost/nb-web 2>/dev/null \
    | grep -oP '(?<=^phase2-v)\d+' | sort -n | tail -1)
next_v=$(( ${last_v:-0} + 1 ))
tag="phase2-v${next_v}"
commit=$(git rev-parse --short HEAD)

echo "Building localhost/nb-web:${tag} (nb-web @ ${commit})..."
podman build --build-arg GIT_COMMIT="$commit" -t "localhost/nb-web:${tag}" -f Containerfile .

echo "Tagging as active (localhost/nb-web:phase2)..."
podman tag "localhost/nb-web:${tag}" localhost/nb-web:phase2

echo "Restarting container-nb-web.service..."
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
# `podman images` inflates each tag's "reclaimable" size by counting shared
# base layers redundantly (confirmed 2026-08-06: system df claimed 130GB
# reclaimable across 400+ images while the real containers/storage directory
# was 29MB total) -- this is about keeping `podman images` readable across
# repeated rebuilds, not meaningful disk savings. `podman rmi` on a tag only
# removes layers no other tag still references, so this is safe even though
# most of the bytes are shared with the tag(s) being kept.
old_tags=$(podman images --format '{{.Tag}}' localhost/nb-web 2>/dev/null \
    | grep -oP '(?<=^phase2-v)\d+' | sort -rn | tail -n +6)
for v in $old_tags; do
    podman rmi "localhost/nb-web:phase2-v${v}" 2>/dev/null \
        && echo "  removed phase2-v${v}" \
        || echo "  skipped phase2-v${v} (in use or already gone)"
done

echo
echo "Live at whatever port container-nb-web.service publishes (check with: podman port nb-web)."

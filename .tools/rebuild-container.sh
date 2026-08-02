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
    [ -d "$repo/.git" ] || continue
    branch=$(git -C "$repo" branch --show-current 2>/dev/null) || continue
    remote_head=$(git -C "$repo" rev-parse --short "origin/$branch" 2>/dev/null) || continue
    image_commit=$(podman exec nb-web cat "/app/plugins/.$p.commit" 2>/dev/null | tr -d '[:space:]')
    if [ "$image_commit" = "$remote_head" ]; then
        echo "OK: $p @ ${image_commit}, matches origin/$branch."
    else
        echo "NOTE: $p image has '${image_commit:-?}', origin/$branch is '${remote_head}' -- push first if this should match."
    fi
done

echo
echo "Live at whatever port container-nb-web.service publishes (check with: podman port nb-web)."

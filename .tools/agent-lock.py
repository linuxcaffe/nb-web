#!/usr/bin/env python3
"""agent-lock.py — module checkout/locking for concurrent agent work.

Motivating problem: after the main.js modularization (tiers 1-4), separate
agents can plausibly work in this repo at the same time without touching
the same file at all -- but only if something actually stops two of them
from picking the same file. Git worktree isolation (Agent tool's
isolation="worktree") prevents clobbering uncommitted bytes, but it does
NOT prevent two agents independently doing the same work and discovering
the collision only at merge time. This is the piece that prevents that:
a "checked out" module can't be picked up by a second holder at all.

Policy this implements: .rules/agent.md "Resource-suggestion tags" /
.rules/mcp-tools.md. Lock state is per-repo, stored in .agent-locks.json
at the repo root (gitignored -- this is live coordination state, not
history worth committing). A holder is any caller-chosen identifier: a
todo selector ("claude:142"), an agent/session id, anything stable enough
to tell "am I re-acquiring my own lock" from "someone else has this."

Not yet wired into an actual dispatcher -- no code parses #agent-todo tags
and calls this automatically yet. This is the primitive to build on: use
it directly (from a subagent, or by hand) until that dispatcher exists.
"""
import argparse
import json
import sys
import time
from pathlib import Path

LOCK_FILE = '.agent-locks.json'
DEFAULT_TTL_MINUTES = 60


def _lock_path(repo: Path) -> Path:
    return Path(repo) / LOCK_FILE


def _load(repo: Path) -> dict:
    p = _lock_path(repo)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def _save(repo: Path, locks: dict) -> None:
    _lock_path(repo).write_text(json.dumps(locks, indent=2, sort_keys=True) + '\n')


def _is_expired(entry: dict, now: float) -> bool:
    return now > entry['acquired'] + entry['ttl_minutes'] * 60


def _drop_expired(locks: dict, now: float) -> dict:
    return {f: e for f, e in locks.items() if not _is_expired(e, now)}


def checkout(repo: Path, files: list[str], holder: str,
             ttl_minutes: int = DEFAULT_TTL_MINUTES) -> tuple[bool, list[tuple[str, str]]]:
    """Attempt to acquire locks on every file in `files`, atomically -- all
    or nothing, so a caller never ends up holding a partial set. Expired
    locks are treated as free and silently reclaimed. Re-checking out a
    file the same holder already has just refreshes its TTL.

    Returns (True, []) on success, or (False, [(file, other_holder), ...])
    listing exactly what's blocking, so a caller can decide whether to
    wait, pick a different file, or do something else entirely.
    """
    now = time.time()
    locks = _drop_expired(_load(repo), now)
    conflicts = [(f, locks[f]['holder']) for f in files
                 if f in locks and locks[f]['holder'] != holder]
    if conflicts:
        return False, conflicts
    for f in files:
        locks[f] = {'holder': holder, 'acquired': now, 'ttl_minutes': ttl_minutes}
    _save(repo, locks)
    return True, []


def release(repo: Path, files: list[str], holder: str) -> list[str]:
    """Release locks held by `holder`. Never touches a lock held by anyone
    else -- releasing isn't a force-unlock, only the holder that acquired
    it (or TTL expiry) can free it. Returns the filenames actually
    released."""
    now = time.time()
    locks = _drop_expired(_load(repo), now)
    released = [f for f in files if f in locks and locks[f]['holder'] == holder]
    for f in released:
        del locks[f]
    _save(repo, locks)
    return released


def status(repo: Path) -> dict:
    """Current live locks, pruning expired ones first (and persisting that
    prune, so a stale entry doesn't keep showing up in every status call)."""
    now = time.time()
    raw = _load(repo)
    live = _drop_expired(raw, now)
    if live != raw:
        _save(repo, live)
    return live


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--repo', default='.', help='repo root (default: cwd)')
    sub = ap.add_subparsers(dest='cmd', required=True)

    co = sub.add_parser('checkout', help='acquire locks on one or more files')
    co.add_argument('files', nargs='+')
    co.add_argument('--holder', required=True)
    co.add_argument('--ttl-minutes', type=int, default=DEFAULT_TTL_MINUTES)

    rel = sub.add_parser('release', help='release locks on one or more files')
    rel.add_argument('files', nargs='+')
    rel.add_argument('--holder', required=True)

    sub.add_parser('status', help='list current live locks')

    args = ap.parse_args()
    repo = Path(args.repo).resolve()

    if args.cmd == 'checkout':
        ok, conflicts = checkout(repo, args.files, args.holder, args.ttl_minutes)
        if ok:
            print(f'checked out: {", ".join(args.files)}')
            return 0
        for f, holder in conflicts:
            print(f'blocked: {f} is checked out by {holder}', file=sys.stderr)
        return 1

    if args.cmd == 'release':
        released = release(repo, args.files, args.holder)
        missing = set(args.files) - set(released)
        if released:
            print(f'released: {", ".join(released)}')
        if missing:
            print(f'not held by {args.holder}, skipped: {", ".join(sorted(missing))}', file=sys.stderr)
        return 0

    if args.cmd == 'status':
        locks = status(repo)
        if not locks:
            print('no locks held')
            return 0
        now = time.time()
        for f, entry in sorted(locks.items()):
            remaining = int(entry['acquired'] + entry['ttl_minutes'] * 60 - now)
            print(f'{f}: held by {entry["holder"]} ({remaining // 60}m {remaining % 60}s remaining)')
        return 0


if __name__ == '__main__':
    sys.exit(main())

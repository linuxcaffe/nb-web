#!/usr/bin/env python3
"""private-scan.py — gate a commit to a public repo on the private-names list.

Scans the added lines of `git diff HEAD` (staged and unstaged; pass extra `git diff`
arguments to narrow it) in the current repo for any name in ~/.nb/.rules/private-names.txt,
matched the way readme-export.py's private_names() does (comment lines skipped, literal,
case-insensitive, word-bounded), plus Tailscale/LAN addresses.

Exit 0 only when it scanned and found nothing; any hit or any error exits non-zero, so

    python3 -I ~/dev/nb-web/.tools/private-scan.py && git commit ... && git push ...

fails closed. `grep -f private-names.txt` doesn't: its `#` comment lines are read as
patterns, one has a bare `(`, grep exits 2, and `if grep ...; then STOP; else commit` pushed
tw-mobilize 0.7.2 unscanned (2026-10-23).
"""
import re
import subprocess
import sys
from pathlib import Path

names = [ln.strip() for ln in (Path.home() / '.nb' / '.rules' / 'private-names.txt').read_text().splitlines()
         if ln.strip() and not ln.strip().startswith('#')]
pats = [re.compile(r'(?<![\w])' + re.escape(n) + r'(?![\w])', re.I) for n in names]
pats += [re.compile(r'\b100\.\d+\.\d+\.\d+\b'), re.compile(r'\b10\.0\.0\.\d+\b')]

diff = subprocess.run(['git', 'diff', 'HEAD'] + sys.argv[1:], capture_output=True, text=True, check=True).stdout
hits = [ln for ln in diff.splitlines()
        if ln.startswith('+') and not ln.startswith('+++') and any(p.search(ln) for p in pats)]
print(f'private-scan: {len(names)} names; {len(hits)} hits')
for h in hits:
    print('  ' + h[:120])
sys.exit(1 if hits else 0)

#!/usr/bin/env python3
"""Benchmark GET /api/note in-process, against real ~/.nb data.

    python3 .tools/bench-api-note.py                       # a few default notes
    python3 .tools/bench-api-note.py docs:help.md djp:djp.md --rounds 5

Prints the median/mean time of warm calls (the first round warms caches and is not counted),
and how many YAML parses and `nb` subprocess runs each call cost. Written 2026-10-05 for
docs:dev/dev-render-pipeline.md bottleneck 7 (221 ms -> 6 ms); run it before and after any
change to the note-loading path. Read-only: it only calls api_note().
"""
import argparse
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app  # noqa: E402
from flask import session  # noqa: E402

DEFAULT = ['features:basics/help.md', 'docs:wikilinks.md', 'docs:NOTEBOOKS.md', 'features:features.md']


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('selectors', nargs='*', default=DEFAULT)
    ap.add_argument('--rounds', type=int, default=3)
    ap.add_argument('--user', default='claude')
    ap.add_argument('--level', default='tech')
    a = ap.parse_args()

    counts = {'yaml': 0, 'nb': 0}
    real_load, real_run = app._yaml.safe_load, app.run_nb

    def load(*x, **k):
        counts['yaml'] += 1
        return real_load(*x, **k)

    def run(*x, **k):
        counts['nb'] += 1
        return real_run(*x, **k)

    app._yaml.safe_load, app.run_nb = load, run
    times, calls = [], 0
    for rnd in range(a.rounds):
        for sel in a.selectors:
            with app.app.test_request_context('/api/note', query_string={'selector': sel}):
                session['user'] = {'username': a.user, 'level': a.level, 'notebooks': []}
                t0 = time.perf_counter()
                r = app.api_note()
                dt = time.perf_counter() - t0
            status = r[1] if isinstance(r, tuple) else getattr(r, 'status_code', 200)
            if status != 200:
                print(f'{sel}: HTTP {status}', file=sys.stderr)
            calls += 1
            if rnd:
                times.append(dt)
    if not times:
        sys.exit('need --rounds 2 or more')
    print(f'api_note: median {statistics.median(times) * 1000:.1f} ms, '
          f'mean {statistics.mean(times) * 1000:.1f} ms over {len(times)} warm calls')
    print(f'per call: {counts["yaml"] / calls:.1f} YAML parses, {counts["nb"] / calls:.2f} nb runs')


if __name__ == '__main__':
    main()

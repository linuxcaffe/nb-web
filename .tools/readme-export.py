#!/usr/bin/env python3
"""Export docs:README.md as the repo's README.md, with GitHub-readable copies of the docs it links to.

    python3 .tools/readme-export.py              # write README.md + docs/ in this repo
    python3 .tools/readme-export.py --dry-run    # list what would be written, and the warnings
    python3 .tools/readme-export.py --check      # what's out of date; exit 1 if anything (sys-readme-stale)

The source is always the docs notebook; everything this writes carries a "generated from" header
and is overwritten on the next run. What it does (plan: claude:readme_github_export_plan_2026-10-02.md):

1. Strips frontmatter.
2. Turns [[wikilinks]] into relative GitHub links (filename or title match, notebook prefix dropped,
   #Heading -> GitHub's anchor slug). A link it can't resolve (another notebook, a missing note)
   becomes its plain label, with a warning naming file and line.
3. Leaves code (fences and `inline code`) and HTML comments alone; warns on nb-only syntax outside
   them: term: links (kept as their label) and {{...}} queries.
4. Rebuilds the tour between <!-- readme:categories --> and <!-- readme:categories-end -->: one
   section per features: category (folder order from the notebook's .index), read at the
   `pristine` tag so scratchpad edits never leak in. Each section is the dashboard's title and
   caption, then for every {{inline:}} chapter its docs topic note (matched by topic:): link,
   caption: and ## Summary. Categories with no written chapters are skipped. A hand-written ###
   section already between the markers stays (after the generated ones) until a generated topic of
   the same name replaces it, so nothing disappears from GitHub before its category is written.
5. Copies every docs note (except ones with `export: false`) the README links to, transitively, into docs/ (plus local images they
   use), and removes generated docs/ files no longer linked.

Tests: nb-web-tests/test_readme_export.py.
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

HEADER = '<!-- Generated from docs:{src} by .tools/readme-export.py. Edit the source, not this file. -->\n\n'
GEN_MARK = 'by .tools/readme-export.py. Edit the source'
START, END = '<!-- readme:categories', '<!-- readme:categories-end -->'

_FM_RE = re.compile(r'\A---\n(.*?)\n---\n?', re.S)
_PROTECT_RE = re.compile(r'(^```.*?^```[^\n]*$|^~~~.*?^~~~[^\n]*$|<!--.*?-->|`[^`\n]+`)', re.S | re.M)
_WIKI_RE = re.compile(r'\[\[([^\]\n]+?)\]\]')
_TERM_RE = re.compile(r'\[([^\]\n]*)\]\(term:[^)\n]*\)')
_QUERY_RE = re.compile(r'\{\{[^}\n]*\}\}')
_MDLINK_RE = re.compile(r'(!?\[[^\]\n]*\]\()([^)\s]+)(\))')
_INLINE_CH_RE = re.compile(r'^\{\{\s*inline:\s*([^}\s#]+)[^}]*\}\}\s*$', re.M)


def github_slug(heading):
    s = heading.strip().lower()
    s = re.sub(r'[^\w\- ]', '', s)
    return s.replace(' ', '-')


def split_fm(text):
    m = _FM_RE.match(text)
    if not m:
        return {}, text
    try:
        meta = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError:
        meta = {}
    return (meta if isinstance(meta, dict) else {}), text[m.end():]


def section(body, name):
    """The text under '## name' up to the next heading of level 1-2."""
    m = re.search(r'^##\s+' + re.escape(name) + r'\s*$', body, re.M)
    if not m:
        return ''
    rest = body[m.end():]
    n = re.search(r'^#{1,2}\s', rest, re.M)
    return (rest[:n.start()] if n else rest).strip()


class Docs:
    """The docs notebook: resolve a wikilink target to a note path relative to the notebook."""

    def __init__(self, root):
        self.root = root
        self.notes = {}   # rel path -> (meta, body)
        for p in sorted(root.rglob('*.md')):
            rel = p.relative_to(root)
            if any(part.startswith('.') for part in rel.parts):
                continue
            self.notes[rel.as_posix()] = split_fm(p.read_text(errors='replace'))
        # export: false in a note's frontmatter keeps it out of the repo (private details)
        self.private = {k for k, (meta, _) in self.notes.items() if meta.get('export') is False}

    def resolve(self, target, from_rel):
        t = target.strip()
        if t.lower().startswith('docs:'):
            t = t[5:]
        elif re.match(r'^[\w.\-]+:', t):
            return None                                   # another notebook
        t = t.lstrip('/')
        if not t or t.endswith('/'):
            return None
        cands = [t] if t.lower().endswith('.md') else [t + '.md', t]
        lower = {k.lower(): k for k in self.notes}
        for c in cands:                                   # path from the notebook root
            if c.lower() in lower:
                return lower[c.lower()]
        if '/' not in t:                                  # bare name: same folder, then anywhere
            here = os.path.dirname(from_rel)
            stem = t[:-3] if t.lower().endswith('.md') else t
            hits = [k for k in self.notes if Path(k).stem.lower() == stem.lower()]
            hits.sort(key=lambda k: (os.path.dirname(k) != here, k.count('/'), k))
            if hits:
                return hits[0]
            for k, (meta, _) in self.notes.items():
                if str(meta.get('title', '')).strip().lower() == t.lower():
                    return k
        return None

    def by_topic(self, topic):
        for k, (meta, _) in self.notes.items():
            if str(meta.get('topic', '')).strip() == topic:
                return k
        return None


def out_path(rel):
    return 'README.md' if rel == 'README.md' else 'docs/' + rel


def _protected(text, fn):
    """Apply fn to the parts of text outside code and HTML comments; fn(chunk, offset)."""
    out, pos = [], 0
    for m in _PROTECT_RE.finditer(text):
        out.append(fn(text[pos:m.start()], pos))
        out.append(m.group(0))
        pos = m.end()
    out.append(fn(text[pos:], pos))
    return ''.join(out)


def translate(text, rel, docs, warnings, linked, assets):
    """Rewrite one note's body for GitHub. rel = source path in the docs notebook."""
    me_out = out_path(rel)
    me_dir = os.path.dirname(me_out)
    src_dir = os.path.dirname(rel)

    def lineno(offset):
        return text.count('\n', 0, offset) + 1

    def where(chunk_off, m):
        return f'docs:{rel}:{lineno(chunk_off + m.start())}'

    def relink(target_out):
        return os.path.relpath(target_out, me_dir or '.')

    def fix(chunk, off):
        def wiki(m):
            inner = m.group(1)
            target, _, label = inner.replace('\\|', '|').partition('|')   # \| inside tables
            target, _, heading = target.partition('#')
            hit = docs.resolve(target, rel) if target.strip() else rel
            if hit is None or hit in docs.private:
                why = 'export: false' if hit else 'unresolvable'
                warnings.append(f'{where(off, m)}: {why} link [[{inner}]] (left as text)')
                return label or target.split(':', 1)[-1].strip()
            if not label:
                label = str(docs.notes[hit][0].get('title') or '').strip() or Path(hit).stem
            linked.add(hit)
            url = relink(out_path(hit)) if hit != rel else ''
            if heading:
                url += '#' + github_slug(heading)
            return f'[{label}]({url or "#"})'

        def term(m):
            warnings.append(f'{where(off, m)}: term: link "{m.group(1)}" kept as plain text')
            return m.group(1)

        def query(m):
            warnings.append(f'{where(off, m)}: nb-only query {m.group(0)} left as is')
            return m.group(0)

        def mdlink(m):
            url = m.group(2)
            if re.match(r'^([a-z][\w+.-]*:|#|/)', url, re.I):
                return m.group(0)
            path = os.path.normpath(os.path.join(src_dir, url.split('#')[0]))
            if path.startswith('..') or not (docs.root / path).is_file():
                return m.group(0)
            if path in docs.private:
                warnings.append(f'{where(off, m)}: export: false link {path} (left as text)')
                return m.group(1)[1:-2] if not m.group(1).startswith('!') else ''
            if path.endswith('.md') and path in docs.notes:
                linked.add(path)
                tgt = out_path(path)
            else:
                assets.add(path)
                tgt = 'docs/' + path
            frag = '#' + url.split('#', 1)[1] if '#' in url else ''
            return m.group(1) + relink(tgt) + frag + m.group(3)

        chunk = _WIKI_RE.sub(wiki, chunk)
        chunk = _TERM_RE.sub(term, chunk)
        chunk = _QUERY_RE.sub(query, chunk)
        return _MDLINK_RE.sub(mdlink, chunk)

    return _protected(text, fix)


def _git_show(repo, rev, path):
    r = subprocess.run(['git', '-C', str(repo), 'show', f'{rev}:{path}'], capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def build_tour(nb_root, docs, features='features', rev='pristine', warnings=None, labels=None):
    """Markdown for the tour: one ### section per category with written chapters. Each chapter's
    label is added to `labels` (lower-cased), for keep_hand_sections."""
    repo = nb_root / features
    index = _git_show(repo, rev, '.index')
    if index is None:
        (warnings if warnings is not None else []).append(f'{features}: no {rev} tag; tour left empty')
        return ''
    parts = []
    for cat in [ln.strip() for ln in index.splitlines() if ln.strip()]:
        dash = _git_show(repo, rev, f'{cat}/{cat}.md')
        if dash is None:
            continue
        meta, body = split_fm(dash)
        entries = []
        for page in _INLINE_CH_RE.findall(body):
            page = page.split(':', 1)[1] if ':' in page else page
            pmeta, _ = split_fm(_git_show(repo, rev, page) or '')
            topic = str(pmeta.get('topic') or '').strip()
            hit = docs.by_topic(topic) if topic else None
            if not hit:
                continue
            tmeta, tbody = docs.notes[hit]
            label = str(pmeta.get('title') or tmeta.get('title') or topic).strip()
            if labels is not None:
                labels.update({label.lower(), str(tmeta.get('title') or '').strip().lower(), topic.lower()})
            cap = str(tmeta.get('caption') or '').strip()
            head = f'**[[docs:{hit}|{label}]]**' + (f' — {cap}' if cap else '')
            summary = section(tbody, 'Summary')
            entries.append(head + ('\n\n' + summary if summary else ''))
        if not entries:
            continue
        title = str(meta.get('title') or cat).strip()
        cap = str(meta.get('caption') or '').strip()
        parts.append(f'### {title}\n\n' + (f'_{cap}_\n\n' if cap else '') + '\n\n'.join(entries))
    return '\n\n---\n\n'.join(parts)


def keep_hand_sections(hand, labels):
    """The hand-written ### sections of the old tour that no generated topic has replaced yet, so a
    category isn't missing from GitHub before it's written."""
    hand = hand.split('-->', 1)[1] if '-->' in hand else hand
    keep = []
    for sec in re.split(r'^(?=### )', hand, flags=re.M)[1:]:
        title = sec.splitlines()[0][4:].strip()
        if title.lower() in labels:
            continue
        keep.append(re.sub(r'\n-{3,}\s*$', '', sec.rstrip()).rstrip())
    return keep


def _build(nb_root, features='features'):
    """(outputs {path: text}, assets {docs-relative path}, docs, warnings), writing nothing."""
    docs = Docs(Path(nb_root) / 'docs')
    warnings = []
    if 'README.md' not in docs.notes:
        raise SystemExit('docs:README.md not found')

    _, body = docs.notes['README.md']
    s, e = body.find(START), body.find(END)
    if s != -1 and e > s:
        labels = set()
        tour = build_tour(Path(nb_root), docs, features, warnings=warnings, labels=labels)
        tour = '\n\n---\n\n'.join([t for t in [tour] if t] + keep_hand_sections(body[s:e], labels))
        body = (body[:s] + START + ' (generated from the features notebook) -->\n\n' + tour + '\n\n'
                + body[e:])
    else:
        warnings.append('docs:README.md: no readme:categories markers; tour not built')
    docs.notes['README.md'] = ({}, body)

    outputs, assets, done, todo = {}, set(), set(), ['README.md']
    while todo:
        rel = todo.pop()
        if rel in done:
            continue
        done.add(rel)
        linked = set()
        text = translate(docs.notes[rel][1].lstrip('\n'), rel, docs, warnings, linked, assets)
        outputs[out_path(rel)] = HEADER.format(src=rel) + text.rstrip() + '\n'
        todo.extend(sorted(linked - done))
    return outputs, assets, docs, warnings


def _stale_generated(out_root, outputs):
    """Generated docs/ copies nothing links to any more."""
    gen_docs = out_root / 'docs'
    if not gen_docs.is_dir():
        return []
    return sorted(p for p in gen_docs.rglob('*.md')
                  if p.relative_to(out_root).as_posix() not in outputs
                  and GEN_MARK in p.read_text(errors='replace')[:300])


def check(nb_root, out_root, features='features'):
    """What an export would change in out_root, as 'path (changed|missing|no longer linked)'."""
    out_root = Path(out_root)
    outputs, assets, docs, _ = _build(nb_root, features)
    found = []
    for rel, text in outputs.items():
        p = out_root / rel
        if not p.exists():
            found.append(f'{rel} (missing)')
        elif p.read_text(errors='replace') != text:
            found.append(f'{rel} (changed)')
    for a in assets:
        p = out_root / 'docs' / a
        if not p.exists() or p.read_bytes() != (docs.root / a).read_bytes():
            found.append(f'docs/{a} (' + ('changed' if p.exists() else 'missing') + ')')
    found += [f'{p.relative_to(out_root).as_posix()} (no longer linked)'
              for p in _stale_generated(out_root, outputs)]
    return sorted(found)


def export(nb_root, out_root, dry_run=False, features='features'):
    """Returns (written file list relative to out_root, warnings)."""
    out_root = Path(out_root)
    outputs, assets, docs, warnings = _build(nb_root, features)
    files = sorted(outputs) + sorted('docs/' + a for a in assets)
    if dry_run:
        return files, warnings

    for p in _stale_generated(out_root, outputs):   # drop copies nothing links to now
        p.unlink()
    for rel, text in outputs.items():
        p = out_root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    for a in assets:
        p = out_root / 'docs' / a
        p.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(docs.root / a, p)
    return files, warnings


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--nb', default=os.path.expanduser('~/.nb'), help='nb root (default ~/.nb)')
    ap.add_argument('--out', default=str(Path(__file__).resolve().parent.parent),
                    help='output root (default: this repo)')
    ap.add_argument('--features', default='features', help='features notebook name')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--check', action='store_true',
                    help='list what an export would change and exit 1 if anything; write nothing')
    a = ap.parse_args()
    if a.check:
        found = check(a.nb, a.out, a.features)
        for f in found:
            print(f)
        sys.exit(1 if found else 0)
    files, warnings = export(a.nb, a.out, a.dry_run, a.features)
    print(('would write' if a.dry_run else 'wrote') + f' {len(files)} files:')
    for f in files:
        print('  ' + f)
    if warnings:
        print(f'\n{len(warnings)} warnings:', file=sys.stderr)
        for w in warnings:
            print('  ' + w, file=sys.stderr)


if __name__ == '__main__':
    main()

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
4. Expands the book: each {{inline:}} on a line of its own (outside code) becomes the note it
   names -- its body, or one #Heading section -- and `summary <dashboard>` the dashboard's
   README summary (dashboard_summary.py, the same function the app uses). features: notes are
   read at the `pristine` tag so scratchpad edits never leak in. docs:README.md is three such
   lines (readme-top, features:features.md#Categories, readme-footer); a README chapter that
   can't be expanded stops the export. Inlined notes aren't copied as files of their own.
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

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import dashboard_summary  # noqa: E402  (nb-web root, shared with the app)

HEADER = '<!-- Generated from docs:{src} by .tools/readme-export.py. Edit the source, not this file. -->\n\n'
GEN_MARK = 'by .tools/readme-export.py. Edit the source'

_FM_RE = re.compile(r'\A---\n(.*?)\n---\n?', re.S)
_PROTECT_RE = re.compile(r'(^```.*?^```[^\n]*$|^~~~.*?^~~~[^\n]*$|<!--.*?-->|`[^`\n]+`)', re.S | re.M)
_WIKI_RE = re.compile(r'\[\[([^\]\n]+?)\]\]')
_TERM_RE = re.compile(r'\[([^\]\n]*)\]\(term:[^)\n]*\)')
_QUERY_RE = re.compile(r'\{\{[^}\n]*\}\}')
_MDLINK_RE = re.compile(r'(!?\[[^\]\n]*\]\()([^)\s]+)(\))')
_INLINE_LINE_RE = re.compile(r'^\{\{\s*inline:\s*(.+?)\s*\}\}\s*$')


def github_slug(heading):
    s = heading.strip().lower()
    s = re.sub(r'[^\w\- ]', '', s)
    return s.replace(' ', '-')


def split_fm(text, errors=None, name=''):
    m = _FM_RE.match(text)
    if not m:
        return {}, text
    try:
        meta = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError as e:
        meta = {}
        if errors is not None:   # say so: a broken block silently loses caption:, help_for:, ...
            errors.append(f'{name}: frontmatter does not parse ({str(e).splitlines()[0]})')
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
        self.errors = []  # frontmatter that doesn't parse
        self.notes = {}   # rel path -> (meta, body)
        for p in sorted(root.rglob('*.md')):
            rel = p.relative_to(root)
            if any(part.startswith('.') for part in rel.parts):
                continue
            self.notes[rel.as_posix()] = split_fm(p.read_text(errors='replace'), self.errors,
                                                  f'docs:{rel.as_posix()}')
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


def slice_section(body, heading):
    """The text under a heading named `heading` (any level), up to the next heading of the same
    or a higher level, without the heading line; None if there's none (the app's _sliceSection)."""
    lines, start, level, fence = body.split('\n'), None, 0, False
    for i, ln in enumerate(lines):
        if ln.lstrip().startswith(('```', '~~~')):
            fence = not fence
        if fence:
            continue
        m = re.match(r'^(#{1,6})\s+(.*?)\s*#*\s*$', ln)
        if not m:
            continue
        if start is None:
            if m.group(2).strip().lower() == heading.strip().lower():
                start, level = i + 1, len(m.group(1))
        elif len(m.group(1)) <= level:
            return '\n'.join(lines[start:i]).strip()
    return None if start is None else '\n'.join(lines[start:]).strip()


class Book:
    """Expands {{inline:}} chapters: docs: notes from the working tree (the source), features:
    notes at the pristine tag."""

    def __init__(self, nb_root, docs, features='features', rev='pristine'):
        self.docs, self.repo, self.features, self.rev = docs, Path(nb_root) / features, features, rev

    def _feature(self, target):
        rel = target.split(':', 1)[1].lstrip('/')
        return _git_show(self.repo, self.rev, rel)

    def _topic(self, topic):
        for k, (meta, body) in self.docs.notes.items():
            if str(meta.get('topic') or '').strip() == topic and meta.get('help_for') and k not in self.docs.private:
                return f'docs:{k}', meta, body
        return None

    def chapter(self, arg, host):
        """(markdown, None) for one inline's argument, or (None, why)."""
        arg = arg.strip()
        if re.match(r'^summary\s+', arg, re.I):
            target = re.sub(r'^summary\s+', '', arg, flags=re.I)
            if not target.startswith(self.features + ':'):
                return None, 'summary of a note outside the features notebook'
            dash = self._feature(target)
            if dash is None:
                return None, f'{target} not found at the {self.rev} tag'
            read = lambda t: self._feature(t) if t.startswith(self.features + ':') else None  # noqa: E731
            return dashboard_summary.dashboard_summary(dash, read, self._topic), None
        target, _, heading = arg.partition('#')
        target = target.strip()
        if target.startswith(self.features + ':'):
            text, sel = self._feature(target), target
            if text is None:
                return None, f'{target} not found at the {self.rev} tag'
        else:
            hit = self.docs.resolve(target, host)
            if hit is None:
                return None, f'{target} is not a docs note'
            if hit in self.docs.private:
                return None, f'export: false note {hit}'
            text, sel = None, f'docs:{hit}'
        body = split_fm(text)[1] if text is not None else self.docs.notes[sel[5:]][1]
        if heading:
            body = slice_section(body, heading)
            if body is None:
                return None, f'no section "{heading}" in {target}'
        return dashboard_summary.qualify_links(body.strip(), sel), None

    def expand(self, text, rel, warnings, strict=False, depth=0):
        """Replace the chapter lines in `text` (a note at docs:rel); nested chapters two deep."""
        def fix(chunk, off):
            out = []
            for line in chunk.split('\n'):
                m = _INLINE_LINE_RE.match(line.strip())
                if not m:
                    out.append(line)
                    continue
                md, why = self.chapter(m.group(1), rel)
                if md is None:
                    msg = f'docs:{rel}: cannot expand {{{{inline: {m.group(1)}}}}}: {why}'
                    if strict:
                        raise SystemExit(f'readme-export: {msg}; nothing written')
                    warnings.append(msg + ' (left out)' if why.startswith('export: false') else msg + ' (left as is)')
                    out.append('' if why.startswith('export: false') else line)
                    continue
                out.append(self.expand(md, rel, warnings, strict, depth + 1) if depth < 1 else md)
            return '\n'.join(out)
        return _protected(text, fix)


def _build(nb_root, features='features'):
    """(outputs {path: text}, assets {docs-relative path}, docs, warnings), writing nothing."""
    docs = Docs(Path(nb_root) / 'docs')
    warnings = list(docs.errors)
    if 'README.md' not in docs.notes:
        raise SystemExit('docs:README.md not found')
    book = Book(nb_root, docs, features)

    outputs, assets, done, todo = {}, set(), set(), ['README.md']
    while todo:
        rel = todo.pop()
        if rel in done:
            continue
        done.add(rel)
        linked = set()
        body = book.expand(docs.notes[rel][1].lstrip('\n'), rel, warnings, strict=(rel == 'README.md'))
        text = translate(body, rel, docs, warnings, linked, assets)
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

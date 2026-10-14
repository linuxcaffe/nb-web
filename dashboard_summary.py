"""A category dashboard summarised for the README: `{{inline: summary <dashboard>}}`.

One function for the app (/api/summary, live notes, the viewer's access) and the README exporter
(.tools/readme-export.py, the features notebook at its `pristine` tag), so the README read in
nb-web and the one published on GitHub are built the same way (2026-10-08, djp: the README is a
book of readme-top, the features front page's ## Categories, readme-footer).

A summary: the dashboard's title as ###, its caption, its intro (the text between the H1 and the
first chapter or subheading, minus a first sentence that only repeats the caption), then for each
`{{inline:}}` chapter -- a tour page -- the docs topic note named by the page's topic:: a linked
label (the page's title), the topic's caption, and its ## Summary.
A section (type: section, 2026-10-13) is summarised by its own ## Summary instead, where an
`{{inline: contents}}` line becomes contents(): its pages from the folder's .index, nested.
Tests: nb-web-tests/test_dashboard_summary.py, test_section_contents.py.
"""
import re

import yaml

_FM_RE = re.compile(r'\A---\n(.*?)\n---\n?', re.S)
_CHAPTER_RE = re.compile(r'^\{\{\s*inline:\s*([^}\s#]+)[^}]*\}\}\s*$')
_WIKI_RE = re.compile(r'\[\[([^\]\n]+?)\]\]')
_CODE_RE = re.compile(r'(^```.*?^```[^\n]*$|^~~~.*?^~~~[^\n]*$|`[^`\n]+`)', re.S | re.M)


def split_fm(text):
    m = _FM_RE.match(text or '')
    if not m:
        return {}, text or ''
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


def chapters(body):
    """Targets of the {{inline:}} lines that stand on their own, in order (a book's chapters)."""
    return [m.group(1) for line in body.splitlines() if (m := _CHAPTER_RE.match(line.strip()))]


def intro(body, caption=''):
    """Text after the H1 up to the first chapter line, subheading or --- rule (a tour dashboard's
    reset link sits below one), without HTML comments."""
    lines = body.splitlines()
    i = next((k + 1 for k, ln in enumerate(lines) if re.match(r'^#\s', ln)), 0)
    out = []
    for ln in lines[i:]:
        if _CHAPTER_RE.match(ln.strip()) or re.match(r'^#{1,6}\s', ln) or re.match(r'^\s*(-{3,}|\*{3,})\s*$', ln):
            break
        out.append(ln)
    text = re.sub(r'<!--.*?-->', '', '\n'.join(out), flags=re.S)
    text = re.sub(r'\n{3,}', '\n\n', text).strip()
    cap = str(caption or '').strip().rstrip('.')
    if cap and text.lower().startswith(cap.lower()):
        text = text[len(cap):].lstrip('.').strip()
    return text


def qualify_links(text, selector):
    """Bare wikilinks in a topic's text, made explicit so they resolve wherever the summary is
    shown: [[X]] -> [[<notebook>:X]], [[#H]] -> [[<selector>#H]]."""
    notebook = selector.split(':', 1)[0]

    def fix(m):
        inner = m.group(1)
        target, bar, label = inner.partition('|')
        if target.startswith('#'):
            target = selector + target
        elif ':' not in target.split('#', 1)[0]:
            target = f'{notebook}:{target}'
        return f'[[{target}{bar}{label}]]'
    # not inside code: a Summary may show wikilink syntax (`[[Note]]`) as an example
    parts = _CODE_RE.split(text)
    return ''.join(p if i % 2 else _WIKI_RE.sub(fix, p) for i, p in enumerate(parts))


_CONTENTS_RE = re.compile(r'^\{\{\s*inline:\s*contents\s*\}\}\s*$', re.M)


def _label(meta, fallback):
    """A short label: the title up to its " — " (blocks/fm/list.md is "fm list — Key Browser")."""
    return str(meta.get('title') or fallback).split(' — ')[0].strip() or fallback


def contents(section_sel, read_index, read_page, find_topic, topics_under, link='page'):
    """A section's contents as a nested Markdown list, in its folder's .index order.
    read_index(folder_selector) -> [names]; read_page(selector) -> text or None (missing or not
    for this reader); find_topic(topic) -> (selector, meta, body) or None; topics_under(topic
    selector) -> [(selector, meta)], the topics in its sub-folder, in order. link='page' links
    the tour pages, 'topic' their docs topics (the README)."""
    def entry(indent, sel, label, cap):
        text = f'[[{sel}|{label}]]' if sel else label
        return f'{indent}- {text}' + (f' — {cap}' if cap else '')

    def walk(sec_sel, depth):
        nb, path = sec_sel.split(':', 1)
        folder = path.rsplit('/', 1)[0] if '/' in path else ''
        out = []
        for name in read_index(f'{nb}:{folder}'):
            name = name.strip()
            if not name or name.startswith('.') or '/' in name:
                continue
            ind = '  ' * depth
            if not name.endswith('.md'):                        # a sub-section, or example data
                sub = f'{nb}:{folder}/{name}/{name}.md' if folder else f'{nb}:{name}/{name}.md'
                text = read_page(sub)
                meta = split_fm(text)[0] if text else {}
                if meta.get('type') != 'section':
                    continue
                out.append(entry(ind, sub if link == 'page' else '', _label(meta, name),
                                 str(meta.get('caption') or '').strip()))
                if depth < 2:
                    out.extend(walk(sub, depth + 1))
                continue
            sel = f'{nb}:{folder}/{name}' if folder else f'{nb}:{name}'
            if sel == sec_sel:
                continue
            text = read_page(sel)
            meta = split_fm(text)[0] if text else {}
            if meta.get('type') != 'feature':
                continue
            topic = str(meta.get('topic') or '').strip()
            hit = find_topic(topic) if topic else None
            cap = str(meta.get('caption') or (hit[1].get('caption') if hit else '') or '').strip()
            target = sel if link == 'page' else (hit[0] if hit else '')
            out.append(entry(ind, target, _label(meta, name[:-3]), cap))
            if hit:
                for tsel, tmeta in topics_under(hit[0]):
                    out.append(entry(ind + '  ', tsel, _label(tmeta, tsel), str(tmeta.get('caption') or '').strip()))
        return out
    return '\n'.join(walk(section_sel, 0))


def dashboard_summary(dash_text, read_page, find_topic, heading='###', contents=None):
    """Markdown for one dashboard. read_page(target) -> the chapter page's text, or None;
    find_topic(topic) -> (selector, meta, body) of its docs topic note, or None. Either returning
    None (missing, or not for this reader) leaves that chapter out. A section with a ## Summary
    is that Summary, its {{inline: contents}} line replaced by contents() (a no-argument
    callable; None drops the line)."""
    meta, body = split_fm(dash_text)
    title = str(meta.get('title') or '').strip() or 'Untitled'
    cap = str(meta.get('caption') or '').strip()
    parts = [f'{heading} {title}']
    if cap:
        parts.append(f'_{cap}_')
    own = section(body, 'Summary') if meta.get('type') == 'section' else ''
    if own:
        own = _CONTENTS_RE.sub(lambda m: (contents() if contents else ''), own)
        parts.append(re.sub(r'\n{3,}', '\n\n', own).strip())
        return '\n\n'.join(parts)
    text = intro(body, cap)
    if text:
        parts.append(text)
    for target in chapters(body):
        page = read_page(target)
        if page is None:
            continue
        pmeta, _ = split_fm(page)
        topic = str(pmeta.get('topic') or '').strip()
        hit = find_topic(topic) if topic else None
        if not hit:
            continue
        sel, tmeta, tbody = hit
        label = str(pmeta.get('title') or tmeta.get('title') or topic).strip()
        tcap = str(tmeta.get('caption') or '').strip()
        entry = f'**[[{sel}|{label}]]**' + (f' — {tcap}' if tcap else '')
        summary = section(tbody, 'Summary')
        parts.append(entry + ('\n\n' + qualify_links(summary, sel) if summary else ''))
    return '\n\n'.join(parts)

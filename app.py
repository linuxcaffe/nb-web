#!/usr/bin/env python3
"""nb-web — Flask backend for nb note-taking web interface."""

import json
import os
import re
import subprocess
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder='.', static_url_path='')

NB_BIN  = os.environ.get('NB_BIN', 'nb')
NB_DIR  = Path(os.environ.get('NB_DIR', Path.home() / '.nb'))
HOST    = os.environ.get('NB_WEB_HOST', '127.0.0.1')
PORT    = int(os.environ.get('NB_WEB_PORT', 5001))


# ---------------------------------------------------------------------------
# nb CLI helpers
# ---------------------------------------------------------------------------

def run_nb(*args, input_text=None, readonly=False):
    """Run nb with args; return {'stdout', 'stderr', 'returncode'}."""
    # --no-color must trail the subcommand, so append it rather than prepend.
    cmd = [NB_BIN] + list(args) + ['--no-color']
    result = subprocess.run(
        cmd,
        capture_output=True, text=True,
        input=input_text,
        env={**os.environ, 'NO_COLOR': '1'},
    )
    return {
        'stdout':     result.stdout.strip(),
        'stderr':     result.stderr.strip(),
        'returncode': result.returncode,
    }


def nb_ok(r):
    return r['returncode'] == 0


# ---------------------------------------------------------------------------
# File-system helpers (fast reads; writes always go through CLI)
# ---------------------------------------------------------------------------

def nb_dir_for(notebook):
    return NB_DIR / notebook


def read_index(notebook, folder=''):
    """Return ordered list of filenames from .index for a notebook/folder."""
    path = nb_dir_for(notebook) / folder / '.index'
    if not path.exists():
        return []
    return [l.strip() for l in path.read_text().splitlines() if l.strip()]


def parse_frontmatter(text):
    """Return (meta_dict, body_str) from a markdown file."""
    meta = {}
    if text.startswith('---'):
        end = text.find('\n---', 3)
        if end != -1:
            block = text[3:end].strip()
            for line in block.splitlines():
                if ':' in line:
                    k, _, v = line.partition(':')
                    meta[k.strip()] = v.strip()
            text = text[end + 4:].lstrip()
    return meta, text


def note_title(filename, body):
    """Extract title from first H1 or filename stem."""
    for line in body.splitlines():
        line = line.strip()
        if line.startswith('# '):
            return line[2:].strip()
        if line.startswith('# [ ] ') or line.startswith('# [x] '):
            return line[6:].strip()
    return Path(filename).stem


def classify(filename):
    """Return item type string based on filename extension."""
    f = filename.lower()
    if f.endswith('.bookmark.md'):    return 'bookmark'
    if f.endswith('.todo.md'):        return 'todo'
    if f.endswith('.enc'):            return 'encrypted'
    ext = Path(f).suffix
    if ext in ('.md', '.org', '.txt', '.rst', '.adoc', '.asciidoc', '.latex'):
        return 'note'
    if ext in ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'):
        return 'image'
    if ext in ('.mp3', '.ogg', '.flac', '.wav', '.m4a'):
        return 'audio'
    if ext in ('.mp4', '.mkv', '.webm', '.avi'):
        return 'video'
    if ext in ('.pdf',):              return 'pdf'
    if ext in ('.epub',):             return 'ebook'
    if ext in ('.docx', '.odt'):      return 'document'
    return 'file'


INDICATORS = {
    'bookmark':  '🔖',
    'todo':      '✔️',
    'encrypted': '🔒',
    'image':     '🌄',
    'audio':     '🔉',
    'video':     '📹',
    'ebook':     '📖',
    'document':  '📄',
    'note':      '',
    'file':      '',
}

ANSI_RE = re.compile(r'\x1b\[[0-9;]*m')


def strip_ansi(s):
    return ANSI_RE.sub('', s)


# ---------------------------------------------------------------------------
# API: Notebooks
# ---------------------------------------------------------------------------

@app.route('/api/notebooks')
def api_notebooks():
    r = run_nb('notebooks', '--names', '--unarchived', '--global')
    names = [n for n in r['stdout'].splitlines() if n.strip()]
    return jsonify({'notebooks': names})


# ---------------------------------------------------------------------------
# API: Notes list
# ---------------------------------------------------------------------------

@app.route('/api/notes')
def api_notes():
    notebook = request.args.get('notebook', 'home')
    folder   = request.args.get('folder', '')
    query    = request.args.get('q', '').strip()
    limit    = int(request.args.get('limit', 200))

    if query:
        nb_arg = '' if notebook == '_all' else notebook
        return _search_notes(nb_arg, folder, query, limit)
    if notebook == '_all':
        return _list_all_notes(limit)
    return _list_notes(notebook, folder, limit)


def _list_all_notes(limit):
    """Aggregate recent notes across all non-archived notebooks."""
    all_items = []
    for nb_dir in sorted(NB_DIR.iterdir()):
        if not nb_dir.is_dir() or nb_dir.name.startswith('.'):
            continue
        nb_name = nb_dir.name
        index = read_index(nb_name)
        for fname in reversed(index):
            fpath = nb_dir / fname
            if not fpath.exists() or fname.startswith('.') or fpath.is_dir():
                continue
            try:
                raw = fpath.read_text(errors='replace')
            except OSError:
                continue
            meta, body = parse_frontmatter(raw)
            itype = classify(fname)
            title = meta.get('title') or note_title(fname, body)
            excerpt = next((l.strip()[:120] for l in body.splitlines()
                            if l.strip() and not l.startswith('#')), '')
            all_items.append({
                'type':      itype,
                'indicator': INDICATORS.get(itype, ''),
                'filename':  fname,
                'title':     title,
                'selector':  f"{nb_name}:{fname}",
                'excerpt':   excerpt,
                'notebook':  nb_name,
                'updated':   '',
                'pinned':    False,
            })
    # Sort by filesystem mtime descending, cap at limit
    all_items.sort(key=lambda i: (NB_DIR / i['notebook'] / i['filename']).stat().st_mtime
                   if (NB_DIR / i['notebook'] / i['filename']).exists() else 0, reverse=True)
    all_items = all_items[:limit]
    return jsonify({'notes': all_items, 'total': len(all_items)})


def _list_notes(notebook, folder, limit):
    """List notes by reading .index + file metadata directly."""
    nb_path = nb_dir_for(notebook)
    folder_path = nb_path / folder if folder else nb_path
    index = read_index(notebook, folder)
    total = len(index)   # position in index = ID (1-based)

    items = []
    for pos, fname in enumerate(reversed(index)):   # newest first
        item_id = total - pos                        # ID: last entry = total
        fpath = folder_path / fname
        if not fpath.exists() or fname.startswith('.'):
            continue
        if fpath.is_dir():
            items.append({
                'type': 'folder', 'indicator': '📂',
                'id': '', 'filename': fname, 'title': fname,
                'selector': f"{notebook}:{folder + '/' if folder else ''}{fname}/",
                'excerpt': '', 'updated': '',
            })
            continue
        try:
            raw  = fpath.read_text(errors='replace')
        except OSError:
            continue
        meta, body = parse_frontmatter(raw)
        itype = classify(fname)
        title = meta.get('title') or note_title(fname, body)
        excerpt = ''
        for line in body.splitlines():
            line = line.strip()
            if line and not line.startswith('#'):
                excerpt = line[:120]
                break
        sel_path = (folder + '/' if folder else '') + fname
        items.append({
            'type':      itype,
            'indicator': INDICATORS.get(itype, ''),
            'id':        item_id,
            'filename':  fname,
            'title':     title,
            'selector':  f"{notebook}:{sel_path}",
            'excerpt':   excerpt,
            'updated':   '',
            'pinned':    meta.get('pinned', '') == 'true',
        })
        if len(items) >= limit:
            break

    pinned   = [i for i in items if i.get('pinned')]
    unpinned = [i for i in items if not i.get('pinned')]
    return jsonify({'notes': pinned + unpinned, 'total': len(items)})


def _search_notes(notebook, folder, query, limit):
    """Full-text search via nb CLI.

    nb search --list output format: [selector]  Title
    selector is a bare id (e.g. 41), a path (2026/01-January/7),
    or notebook:id (gbct:1) when using --all.
    """
    args = [f"{notebook}:search", query, '--list'] if notebook else ['search', query, '--list']
    r = run_nb(*args)
    lines = [strip_ansi(l) for l in r['stdout'].splitlines() if l.strip()]
    items = []
    # Pattern: [selector]  Title (with optional emoji indicators before title)
    pat = re.compile(r'^\[([^\]]+)\]\s+(.+)$')
    for line in lines[:limit]:
        m = pat.match(line.strip())
        if not m:
            continue
        raw_sel = m.group(1).strip()
        title   = m.group(2).strip()
        # Strip leading indicator emoji from title (e.g. "✅ [x] Todo title")
        title   = re.sub(r'^[\U00010000-\U0010ffff✔️✅📌🔖🔒📂🌄🔉📹📖📄]\s*', '', title).strip()
        title   = re.sub(r'^\[[ x]\]\s*', '', title).strip()  # strip [ ] or [x]
        # Build a full selector: if already has notebook: prefix use as-is, else prepend notebook
        if ':' in raw_sel:
            selector = raw_sel
            nb_part  = raw_sel.split(':')[0]
        else:
            selector = f"{notebook}:{raw_sel}" if notebook else raw_sel
            nb_part  = notebook

        # Guess type from title suffix / known patterns
        itype = 'note'
        if title.endswith(('.bookmark.md', '.bookmark')):
            itype = 'bookmark'
        elif '[x]' in line or '✅' in line:
            itype = 'todo'

        items.append({
            'selector':  selector,
            'filename':  raw_sel,
            'title':     title or raw_sel,
            'type':      itype,
            'indicator': INDICATORS.get(itype, ''),
            'excerpt':   '',
            'updated':   '',
            'pinned':    False,
        })
    return jsonify({'notes': items, 'total': len(items), 'query': query})


# ---------------------------------------------------------------------------
# API: Single note
# ---------------------------------------------------------------------------

@app.route('/api/note')
def api_note():
    selector = request.args.get('selector', '')
    if not selector:
        return jsonify({'error': 'selector required'}), 400

    # Resolve selector to a real path first (handles both filename and id selectors)
    path_r = run_nb('show', selector, '--path')
    if not nb_ok(path_r):
        return jsonify({'error': 'not found'}), 404
    fpath = path_r['stdout'].strip()

    # Determine notebook name and numeric id from filesystem path
    p = Path(fpath)
    note_notebook = None
    note_id = None
    try:
        for nb_candidate in NB_DIR.iterdir():
            if not nb_candidate.is_dir() or nb_candidate.name.startswith('.'):
                continue
            try:
                rel = p.relative_to(nb_candidate)
                note_notebook = nb_candidate.name
                idx = read_index(note_notebook)
                fname_key = rel.name
                if fname_key in idx:
                    note_id = idx.index(fname_key) + 1
                break
            except ValueError:
                continue
    except Exception:
        pass

    try:
        raw = Path(fpath).read_text(errors='replace')
    except OSError:
        return jsonify({'error': 'could not read file'}), 404

    meta, body = parse_frontmatter(raw)
    filename = Path(fpath).name
    itype = classify(filename)
    title = meta.get('title') or note_title(filename, body)

    tags = re.findall(r'#([\w/-]+)', body)

    return jsonify({
        'selector': selector,
        'notebook': note_notebook or '',
        'id':       note_id,
        'filename': filename,
        'title':    title,
        'type':     itype,
        'indicator': INDICATORS.get(itype, ''),
        'raw':      raw,
        'body':     body,
        'meta':     meta,
        'tags':     tags,
        'path':     fpath,
    })


# ---------------------------------------------------------------------------
# API: Today (nb daily)
# ---------------------------------------------------------------------------

@app.route('/api/today')
def api_today():
    """Return today's daily log content. nb daily prints it; path via --last."""
    # Run nb daily with no args — displays today's log (creates if missing)
    r = run_nb('daily')
    if not nb_ok(r):
        return jsonify({'error': r['stderr']}), 500
    # Resolve path of the most-recently-modified item (today's log)
    path_r = run_nb('show', 'home:--last', '--path')
    if not nb_ok(path_r):
        path_r = run_nb('show', '--last', '--path')
    fpath = path_r['stdout'].strip() if nb_ok(path_r) else ''
    # Read file directly for clean content
    if fpath and Path(fpath).exists():
        raw = Path(fpath).read_text(errors='replace')
    else:
        raw = r['stdout']
    meta, body = parse_frontmatter(raw)
    return jsonify({
        'raw':  raw,
        'body': body,
        'meta': meta,
        'path': fpath,
    })


@app.route('/api/today', methods=['POST'])
def api_today_append():
    """Append a timestamped entry to today's log."""
    data    = request.get_json() or {}
    content = data.get('content', '').strip()
    if not content:
        return jsonify({'error': 'content required'}), 400
    r = run_nb('daily', content)
    return jsonify({'success': nb_ok(r), 'stderr': r['stderr']})


# ---------------------------------------------------------------------------
# API: Create note
# ---------------------------------------------------------------------------

@app.route('/api/notes', methods=['POST'])
def api_create_note():
    data     = request.get_json() or {}
    notebook = data.get('notebook', 'home')
    folder   = data.get('folder', '')
    title    = data.get('title', '')
    content  = data.get('content', '')
    tags     = data.get('tags', [])
    ntype    = data.get('type', 'note')   # note | bookmark | todo

    target = f"{notebook}:" + (f"{folder}/" if folder else '')

    if ntype == 'bookmark':
        url = data.get('url', '')
        if not url:
            return jsonify({'error': 'url required for bookmark'}), 400
        args = [target, url]
        if tags:  args += ['--tags', ','.join(tags)]
        if title: args += ['--title', title]
        if data.get('comment'): args += ['--comment', data['comment']]
        if data.get('quote'):   args += ['--quote',   data['quote']]
        r = run_nb('bookmark', *args)
    elif ntype == 'todo':
        args = ['todo', 'add', target + (title or 'New todo')]
        if tags:  args += ['--tags', ','.join(tags)]
        r = run_nb(*args)
    else:
        args = ['add', target]
        if title:   args += ['--title', title]
        if content: args += ['--content', content]
        if tags:    args += ['--tags', ','.join(tags)]
        r = run_nb(*args)

    if not nb_ok(r):
        return jsonify({'success': False, 'error': r['stderr']}), 400
    return jsonify({'success': True, 'output': strip_ansi(r['stdout'])})


# ---------------------------------------------------------------------------
# API: Edit note
# ---------------------------------------------------------------------------

@app.route('/api/note', methods=['PUT'])
def api_edit_note():
    data     = request.get_json() or {}
    selector = data.get('selector', '')
    content  = data.get('content')
    append   = data.get('append')
    prepend  = data.get('prepend')

    if not selector:
        return jsonify({'error': 'selector required'}), 400

    if append is not None:
        r = run_nb('edit', selector, '--content', append)
    elif prepend is not None:
        r = run_nb('edit', selector, '--content', prepend, '--prepend')
    elif content is not None:
        r = run_nb('edit', selector, '--content', content, '--overwrite')
    else:
        return jsonify({'error': 'content, append, or prepend required'}), 400

    return jsonify({'success': nb_ok(r), 'stderr': r['stderr']})


# ---------------------------------------------------------------------------
# API: Delete note
# ---------------------------------------------------------------------------

@app.route('/api/note', methods=['DELETE'])
def api_delete_note():
    selector = request.args.get('selector', '')
    if not selector:
        return jsonify({'error': 'selector required'}), 400
    r = run_nb('delete', selector, '--force')
    return jsonify({'success': nb_ok(r), 'stderr': r['stderr']})


# ---------------------------------------------------------------------------
# API: Todo toggle (do / undo)
# ---------------------------------------------------------------------------

@app.route('/api/todo', methods=['POST'])
def api_todo_toggle():
    data     = request.get_json() or {}
    selector = data.get('selector', '')
    done     = data.get('done', True)
    task_num = data.get('task', None)
    if not selector:
        return jsonify({'error': 'selector required'}), 400
    cmd = 'do' if done else 'undo'
    args = [cmd, selector]
    if task_num is not None:
        args.append(str(task_num))
    r = run_nb(*args)
    return jsonify({'success': nb_ok(r), 'stderr': r['stderr']})


# ---------------------------------------------------------------------------
# API: Search tags
# ---------------------------------------------------------------------------

@app.route('/api/tags')
def api_tags():
    notebook = request.args.get('notebook', '')
    args = ['--tags'] if not notebook else [f'{notebook}:', '--tags']
    r = run_nb('list', *args)
    tags = [strip_ansi(t).strip().lstrip('#') for t in r['stdout'].splitlines() if t.strip()]
    return jsonify({'tags': sorted(set(tags))})


# ---------------------------------------------------------------------------
# API: Sync
# ---------------------------------------------------------------------------

@app.route('/api/sync', methods=['POST'])
def api_sync():
    data     = request.get_json() or {}
    notebook = data.get('notebook', '')
    args = ['sync'] if not notebook else [f'{notebook}:sync']
    r = run_nb(*args)
    return jsonify({'success': nb_ok(r), 'output': strip_ansi(r['stdout']), 'stderr': r['stderr']})


# ---------------------------------------------------------------------------
# API: Run read-only nb command (cal, daily, info, weather, notebooks)
# ---------------------------------------------------------------------------

@app.route('/api/run')
def api_run():
    cmd = request.args.get('cmd', '').strip()
    ALLOWED = {'info', 'weather', 'cal', 'daily', 'notebooks', 'version'}
    if cmd not in ALLOWED:
        return jsonify({'error': f'command not in allowed list: {cmd}'}), 400
    extra = []
    for flag in ('month', 'year'):
        v = request.args.get(flag)
        if v: extra += [f'--{flag}', v]
    date = request.args.get('date')
    if date and cmd == 'daily':
        extra.append(date)   # nb daily 2026-04-30 (positional)
    r = run_nb(cmd, *extra)
    return jsonify({
        'output':  strip_ansi(r['stdout']),
        'success': nb_ok(r),
        'stderr':  strip_ansi(r['stderr']),
    })


# ---------------------------------------------------------------------------
# API: Config / settings
# ---------------------------------------------------------------------------

@app.route('/api/config')
def api_config():
    settings = {}
    for key in ('editor', 'nb_dir', 'default_extension', 'limit', 'auto_sync',
                'color_theme', 'encryption_tool'):
        r = run_nb('settings', 'get', key)
        if nb_ok(r):
            settings[key] = r['stdout']
    return jsonify({'settings': settings})


# ---------------------------------------------------------------------------
# Static / SPA
# ---------------------------------------------------------------------------

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')


@app.errorhandler(404)
def not_found(_):
    return send_from_directory('.', 'index.html')


if __name__ == '__main__':
    os.environ.pop('WERKZEUG_RUN_MAIN', None)
    os.environ.pop('WERKZEUG_SERVER_FD', None)
    app.run(host=HOST, port=PORT, debug=True, use_reloader=False)

#!/usr/bin/env python3
"""nb-web — Flask backend for nb note-taking web interface."""

import json
import os
import re
import subprocess
import sys
import threading
import time
import unicodedata
from pathlib import Path

try:
    import yaml as _yaml
    _YAML_OK = True
except ImportError:
    _YAML_OK = False

from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder='.', static_url_path='')

NB_BIN  = os.environ.get('NB_BIN', 'nb')
NB_DIR  = Path(os.environ.get('NB_DIR', Path.home() / '.nb'))
HOST    = os.environ.get('NB_WEB_HOST', '127.0.0.1')
PORT    = int(os.environ.get('NB_WEB_PORT', 5001))

GLOBAL_TEMPLATES_DIR = NB_DIR / '.templates'
CMDS_FILE            = Path(__file__).parent / 'cmds.txt'

_RE_HEADING = re.compile(r'^#{1,6}(\s|$)')   # true MD heading; bare #tag is not a heading

# Startup stamp — visible in menu so you can confirm a restart happened
from datetime import datetime
_STARTED_AT = datetime.now().strftime('%m-%d %H:%M')
try:
    _GIT_REV = subprocess.run(
        ['git', 'rev-parse', '--short', 'HEAD'],
        capture_output=True, text=True,
        cwd=str(Path(__file__).parent),
    ).stdout.strip() or '—'
except Exception:
    _GIT_REV = '—'


@app.after_request
def _dev_no_cache(response):
    """Prevent stale JS/CSS during development."""
    if request.path.endswith(('.js', '.css')):
        response.headers['Cache-Control'] = 'no-cache, must-revalidate'
        response.headers['Pragma'] = 'no-cache'
    return response


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
        input=input_text if input_text is not None else '',
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
    # Keep blank lines — nb counts every line (including blanks) as an ID position.
    return [l.strip() for l in path.read_text().splitlines()]


def parse_frontmatter(text):
    """Return (meta_dict, body_str) from a markdown file."""
    meta = {}
    if text.startswith('---'):
        end = text.find('\n---', 3)
        if end != -1:
            block = text[3:end].strip()
            if _YAML_OK:
                try:
                    parsed = _yaml.safe_load(block)
                    if isinstance(parsed, dict):
                        meta = parsed
                except Exception:
                    pass
            if not meta:
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


def classify(filename, notebook=None):
    """Return item type string based on filename extension (and notebook)."""
    f = filename.lower()
    if f.endswith('.bookmark.md'):    return 'bookmark'
    if f.endswith('.todo.md'):        return 'todo'
    if f.endswith('.enc'):            return 'encrypted'
    ext = Path(f).suffix
    if ext in ('.md', '.org', '.txt', '.rst', '.adoc', '.asciidoc', '.latex'):
        return 'contact' if notebook == 'contacts' else 'note'
    if ext == '.vcf':
        return 'contact'
    if ext in ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'):
        return 'image'
    if ext == '.csv':
        return 'sheet'
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
    'sheet':     '🗃️',
    'contact':   '🪪',
    'note':      '',
    'file':      '',
}

ANSI_RE = re.compile(r'\x1b\[[0-9;]*m')


def strip_ansi(s):
    return ANSI_RE.sub('', s)


# ---------------------------------------------------------------------------
# API: Notebooks
# ---------------------------------------------------------------------------

@app.route('/api/templates')
def api_templates():
    notebook = request.args.get('notebook', 'home')
    local_dir  = NB_DIR / notebook / '.templates'
    global_dir = GLOBAL_TEMPLATES_DIR
    seen, templates = set(), []
    for scope, tdir in [('local', local_dir), ('global', global_dir)]:
        if not tdir.is_dir():
            continue
        for f in sorted(tdir.glob('*.md')):
            if f.name.startswith('.') or f.stem in seen:
                continue
            seen.add(f.stem)
            try:
                preview = f.read_text(errors='replace')[:200]
            except OSError:
                preview = ''
            templates.append({
                'name':    f.stem,
                'path':    str(f),
                'scope':   scope,
                'preview': preview,
            })
    return jsonify({'templates': templates})


@app.route('/api/templates', methods=['POST'])
def api_save_template():
    data     = request.get_json() or {}
    name     = re.sub(r'\s+', '-', re.sub(r'[^\w\s-]', '', data.get('name', '').strip()).strip())
    content  = data.get('content', '')
    scope    = data.get('scope', 'global')
    notebook = data.get('notebook', 'home')
    if not name:
        return jsonify({'error': 'name required'}), 400
    tdir = (NB_DIR / notebook / '.templates') if scope == 'local' else GLOBAL_TEMPLATES_DIR
    tdir.mkdir(parents=True, exist_ok=True)
    tpath = tdir / f"{name}.md"
    tpath.write_text(content)
    return jsonify({'success': True, 'path': str(tpath), 'scope': scope, 'name': name})


@app.route('/api/template')
def api_get_template():
    """Return raw content of a template file for preview."""
    path = request.args.get('path', '').strip()
    if not path:
        return jsonify({'error': 'path required'}), 400
    tpath = Path(path)
    # Safety: must be inside NB_DIR
    try:
        tpath.relative_to(NB_DIR)
    except ValueError:
        return jsonify({'error': 'invalid path'}), 403
    if not tpath.exists():
        return jsonify({'error': 'not found'}), 404
    return jsonify({'content': tpath.read_text(errors='replace'), 'name': tpath.stem})


@app.route('/api/task-info')
def api_task_info():
    uuid = request.args.get('uuid', '').strip()
    if not uuid or not re.match(r'^[a-f0-9]{8,}$', uuid):
        return jsonify({'output': '', 'success': False}), 400
    try:
        result = subprocess.run(
            ['task', f'uuid.startswith:{uuid}', 'information'],
            capture_output=True, text=True,
            env={**os.environ, 'NO_COLOR': '1', 'TERM': 'dumb'},
        )
        output = strip_ansi(result.stdout.strip())
        return jsonify({'output': output, 'success': bool(output)})
    except FileNotFoundError:
        return jsonify({'output': '', 'success': False, 'error': 'task not found'})


@app.route('/api/version')
def api_version():
    return jsonify({'started': _STARTED_AT, 'rev': _GIT_REV})


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
            if not fname:
                continue
            fpath = nb_dir / fname
            if not fpath.exists() or fname.startswith('.'):
                continue
            if fpath.is_dir():
                all_items.append({
                    'type': 'folder', 'indicator': '📂',
                    'filename': fname, 'title': fname,
                    'selector': f"{nb_name}:{fname}/",
                    'excerpt': '', 'notebook': nb_name,
                    'updated': '', 'pinned': False, 'status': None,
                })
                continue
            try:
                raw = fpath.read_text(errors='replace')
            except OSError:
                continue
            meta, body = parse_frontmatter(raw)
            itype = classify(fname, nb_name)
            title = meta.get('title') or note_title(fname, body)
            excerpt = next((l.strip()[:120] for l in body.splitlines()
                            if l.strip() and not _RE_HEADING.match(l)), '')
            todo_status = None
            if itype == 'todo':
                first = next((l.strip() for l in body.splitlines() if l.strip()), '')
                todo_status = 'closed' if first.startswith('# [x]') else 'open'
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
                'status':    todo_status,
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
        if not fname:                                # blank line = gap in index
            continue
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
        itype = classify(fname, notebook)
        title = meta.get('title') or note_title(fname, body)
        excerpt = ''
        for line in body.splitlines():
            line = line.strip()
            if line and not _RE_HEADING.match(line):
                excerpt = line[:120]
                break
        todo_status = None
        if itype == 'todo':
            first = next((l.strip() for l in body.splitlines() if l.strip()), '')
            todo_status = 'closed' if first.startswith('# [x]') else 'open'
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
            'status':    todo_status,
        })
        if len(items) >= limit:
            break

    pinned   = [i for i in items if i.get('pinned')]
    unpinned = [i for i in items if not i.get('pinned')]
    return jsonify({'notes': pinned + unpinned, 'total': len(items)})


def _read_excerpt(nb_name, raw_id_or_sel):
    """Return first non-heading body line for a note identified by id or selector."""
    try:
        raw_id = str(raw_id_or_sel).split(':')[-1]
        if not raw_id.isdigit():
            return ''
        idx    = read_index(nb_name)
        id_num = int(raw_id)
        if not (1 <= id_num <= len(idx)):
            return ''
        fname  = idx[id_num - 1]
        if not fname:
            return ''
        fpath  = NB_DIR / nb_name / fname
        _, body = parse_frontmatter(fpath.read_text(errors='replace'))
        for line in body.splitlines():
            line = line.strip()
            if line and not _RE_HEADING.match(line):
                return line[:120]
    except Exception:
        pass
    return ''


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
            'excerpt':   _read_excerpt(nb_part, raw_sel),
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
    itype = classify(filename, note_notebook)
    title = meta.get('title') or note_title(filename, body)

    tags = re.findall(r'#([\w/-]+)', body)

    todo_status = None
    if itype == 'todo':
        first = body.lstrip().splitlines()[0] if body.strip() else ''
        todo_status = 'closed' if first.startswith('# [x]') else 'open'

    return jsonify({
        'selector': selector,
        'notebook': note_notebook or '',
        'id':       note_id,
        'filename': filename,
        'title':    title,
        'type':     itype,
        'status':   todo_status,
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

    template_path = data.get('template_path', '').strip()

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
        # 'nb todo add notebook:title' treats the whole string as a literal title.
        # Use 'nb notebook: todo add title' so nb doesn't prepend the notebook name.
        todo_title = (f'{folder}/{title}' if folder and title else
                      f'{folder}/' if folder else title or 'New todo')
        args = [f'{notebook}:', 'todo', 'add', todo_title]
        if tags:  args += ['--tags', ','.join(tags)]
        r = run_nb(*args)
    elif ntype == 'folder':
        folder_name = (title or 'newfolder').strip().strip('/')
        r = run_nb('add', target + folder_name + '/')
    elif ntype == 'notebook':
        nb_name = (title or 'notebook').strip()
        r = run_nb('notebooks', 'add', nb_name)
    else:
        args = ['add', target]
        if title:   args += ['--title', title]
        args += ['--content', content or '\n']
        if tags:    args += ['--tags', ','.join(tags)]
        # Datestamp-prefixed filename keeps the clean title while making notes cal-visible
        slug = re.sub(r'[^\w]+', '_', title or 'note').strip('_').lower()
        dated_filename = f"{datetime.now().strftime('%Y%m%d%H%M%S')}_{slug}.md"
        args += ['--filename', dated_filename]
        # Validate template path is inside NB_DIR before passing to shell
        if template_path:
            tp = Path(template_path)
            try:
                tp.relative_to(NB_DIR)
                if tp.exists():
                    args += ['--template', template_path]
            except ValueError:
                pass
        r = run_nb(*args)
        if nb_ok(r):
            pass  # falls through to shared return below

    if not nb_ok(r):
        return jsonify({'success': False, 'error': r['stderr']}), 400
    m = re.search(r'\[([^\]]+)\]', r['stdout'])
    selector = m.group(1) if m else None
    if selector and ':' not in selector:
        selector = f'{notebook}:{selector}'
    return jsonify({'success': True, 'output': strip_ansi(r['stdout']),
                    'selector': selector})


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
# API: Grep — ripgrep with context, structured per-file results
# ---------------------------------------------------------------------------

def _resolve_file_to_note(fpath_str):
    """Resolve a filesystem path to nb note metadata dict, or None."""
    fpath = Path(fpath_str)
    if not fpath.exists():
        return None
    for nb_dir in NB_DIR.iterdir():
        if not nb_dir.is_dir() or nb_dir.name.startswith('.'):
            continue
        try:
            fpath.relative_to(nb_dir)   # raises ValueError if not under nb_dir
        except ValueError:
            continue
        nb_name = nb_dir.name
        fname   = fpath.name
        idx     = read_index(nb_name)
        note_id = (idx.index(fname) + 1) if fname in idx else None
        try:
            raw = fpath.read_text(errors='replace')
        except OSError:
            return None
        _, body = parse_frontmatter(raw)
        itype   = classify(fname, nb_name)
        return {
            'notebook':  nb_name,
            'id':        note_id,
            'filename':  fname,
            'selector':  f"{nb_name}:{fname}",
            'title':     note_title(fname, body),
            'type':      itype,
            'indicator': INDICATORS.get(itype, ''),
        }
    return None


def _parse_rg_json(stdout, limit=100):
    """Parse ripgrep --json NDJSON output into per-file result dicts."""
    results = []
    current = None
    for raw_line in stdout.splitlines():
        try:
            obj = json.loads(raw_line)
        except (json.JSONDecodeError, ValueError):
            continue
        t    = obj.get('type')
        data = obj.get('data', {})
        if t == 'begin':
            path = data.get('path', {}).get('text', '')
            current = {'path': path, 'lines': []}
        elif t in ('match', 'context') and current is not None:
            text = data.get('lines', {}).get('text', '').rstrip('\n')
            current['lines'].append({'text': text, 'match': t == 'match'})
        elif t == 'end' and current is not None:
            if current['lines'] and len(results) < limit:
                note = _resolve_file_to_note(current['path'])
                if note:
                    note['lines'] = current['lines']
                    results.append(note)
            current = None
    return results


@app.route('/api/grep')
def api_grep():
    query    = request.args.get('q', '').strip()
    notebook = request.args.get('notebook', 'home')
    before   = int(request.args.get('B', 0))
    after    = int(request.args.get('A', 0))
    case_sen = request.args.get('sensitive', '0') == '1'
    fixed    = request.args.get('fixed', '0') == '1'
    word     = request.args.get('word', '0') == '1'
    limit    = int(request.args.get('limit', 100))

    if not query:
        return jsonify({'results': []})

    search_dir = str(NB_DIR / notebook) if notebook and notebook != '_all' else str(NB_DIR)

    rg_args = ['rg', '--json',
               f'-B{before}', f'-A{after}',
               '--glob=!.git', '--glob=!.index']
    if not case_sen:
        rg_args.append('--smart-case')
    if fixed:
        rg_args.append('--fixed-strings')
    if word:
        rg_args.append('--word-regexp')
    rg_args += ['--', query, search_dir]

    try:
        proc    = subprocess.run(rg_args, capture_output=True, text=True)
        results = _parse_rg_json(proc.stdout, limit)
    except FileNotFoundError:
        # rg not available — fall back to plain nb search (no context lines)
        nb_prefix = '' if notebook == '_all' else notebook
        args = ([f'{nb_prefix}:search', query, '--list']
                if nb_prefix else ['search', query, '--list'])
        r = run_nb(*args)
        results = []
        pat = re.compile(r'^\[([^\]]+)\]\s+(.+)$')
        for line in strip_ansi(r['stdout']).splitlines()[:limit]:
            m = pat.match(line.strip())
            if m:
                raw_sel = m.group(1).strip()
                title   = re.sub(r'^[\U00010000-\U0010ffff✔️✅📌🔖🔒📂🌄]+\s*', '',
                                 m.group(2).strip()).strip()
                results.append({'selector': raw_sel, 'title': title,
                                'type': 'note', 'indicator': '', 'lines': []})

    return jsonify({'results': results})


# ---------------------------------------------------------------------------
# API: Cal — return structured dated-note entries for a date range
# ---------------------------------------------------------------------------

_CAL_LINE        = re.compile(r'\[([^\]]+)\]\s+(\d{4}-\d{2}-\d{2})\s+(.*)')
_CAL_GREP_HEADER = re.compile(r'[─\-]{2,}\s+(\d{4}-\d{2}-\d{2})\s+(\S+)\s+[─\-]{2,}')
_CAL_GREP_MATCH  = re.compile(r'^\d+:(.*)')


def _parse_cal_grep(raw, nb_name):
    """Parse `nb cal … g <term>` output into entry dicts.

    Output format (one block per matching file):
        ── YYYY-MM-DD  filename.md ──
        N:matched line content
        N:another matched line
    We emit one entry per file, using the first match line for the title/excerpt.
    """
    entries = []
    seen = set()
    cur_date = cur_fname = cur_excerpt = None

    def _flush():
        if not cur_fname or cur_fname in seen:
            return
        seen.add(cur_fname)
        # Resolve filename → numeric selector via .index
        fpath = NB_DIR / nb_name / cur_fname
        selector = f"{nb_name}:{cur_fname}"   # fallback
        if fpath.exists():
            idx = read_index(nb_name)
            if cur_fname in idx:
                selector = f"{nb_name}:{idx.index(cur_fname) + 1}"
        # Derive title from file content (first heading)
        title = cur_fname
        try:
            _, body = parse_frontmatter(fpath.read_text(errors='replace'))
            title = note_title(cur_fname, body)
        except OSError:
            pass
        entries.append({
            'selector': selector,
            'date':     cur_date,
            'title':    title,
            'excerpt':  cur_excerpt or '',
            'done':     False,
        })

    for line in raw.splitlines():
        line = line.strip()
        hm = _CAL_GREP_HEADER.search(line)
        if hm:
            _flush()
            cur_date, cur_fname, cur_excerpt = hm.group(1), hm.group(2), None
            continue
        if cur_fname and cur_excerpt is None:
            mm = _CAL_GREP_MATCH.match(line)
            if mm:
                cur_excerpt = mm.group(1).strip()
    _flush()
    return entries


@app.route('/api/cal')
def api_cal():
    start    = request.args.get('start', '').strip()
    end      = request.args.get('end',   '').strip()
    notebook = request.args.get('notebook', '')
    query    = request.args.get('q', '').strip()

    if not start and not end:
        return jsonify({'error': 'start or end required'}), 400

    nb_name = notebook if notebook and notebook not in ('_all', '') else 'home'

    # Build args: dates first, then optional notebook scope, then optional grep
    args = ['cal']
    if start: args += ['--start', start]
    if end:   args += ['--end',   end]
    if notebook and notebook not in ('_all', ''):
        args.append(f'{notebook}:')

    if query:
        args += ['g', query]
        r   = run_nb(*args)
        raw = strip_ansi(r['stdout'])
        entries = _parse_cal_grep(raw, nb_name)
    else:
        r   = run_nb(*args)
        raw = strip_ansi(r['stdout'])
        entries = []
        for line in raw.splitlines():
            m = _CAL_LINE.match(line.strip())
            if m:
                title = m.group(3).strip()
                entries.append({
                    'selector': m.group(1),
                    'date':     m.group(2),
                    'title':    title,
                    'done':     title.startswith('[x]'),
                })

    return jsonify({'entries': entries})


# ---------------------------------------------------------------------------
# API: Import file(s) into a notebook
# ---------------------------------------------------------------------------

@app.route('/api/import', methods=['POST'])
def api_import():
    import tempfile, shutil
    f        = request.files.get('file')
    notebook = request.form.get('notebook', 'home').strip() or 'home'
    if not f or not f.filename:
        return jsonify({'success': False, 'error': 'no file provided'}), 400

    safe_name = Path(f.filename).name.replace('/', '_').replace('..', '_')

    # vCard files → parse into contact notes
    if safe_name.lower().endswith('.vcf'):
        try:
            text     = f.read().decode('utf-8', errors='replace')
            contacts = _parse_vcard(text)
            created  = []
            for c in contacts:
                md   = _contact_to_md(c)
                slug = _contact_slug(c.get('name') or c.get('fn', 'contact'))
                fname = f"{slug}.md"
                dest  = NB_DIR / 'contacts' / fname
                dest.parent.mkdir(parents=True, exist_ok=True)
                # avoid clobbering: append suffix if exists
                if dest.exists():
                    import uuid
                    fname = f"{slug}_{uuid.uuid4().hex[:4]}.md"
                    dest  = NB_DIR / 'contacts' / fname
                dest.write_text(md)
                run_nb('index', 'reconcile', 'contacts:')
                created.append(c.get('name', fname))
            return jsonify({'success': True, 'output': f"Imported {len(created)} contact(s): {', '.join(created)}"})
        except Exception as e:
            return jsonify({'success': False, 'error': f'vCard parse error: {e}'})

    tmp_dir   = Path(tempfile.mkdtemp())
    tmp_path  = tmp_dir / safe_name
    try:
        f.save(str(tmp_path))
        r = run_nb('import', str(tmp_path), f'{notebook}:')
        success = r['returncode'] == 0
        return jsonify({'success': success, 'output': r['stdout'], 'stderr': r['stderr']})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _slug(text):
    """ASCII slug from arbitrary text."""
    text = unicodedata.normalize('NFKD', str(text)).encode('ascii', 'ignore').decode()
    text = re.sub(r'[^\w\s-]', '', text).strip().lower()
    return re.sub(r'[-\s]+', '_', text) or 'contact'


def _contact_slug(name):
    return _slug(name)[:48]


def _parse_vcard(text):
    """Parse a vCard string (one or many contacts) into list of dicts."""
    contacts = []
    card = None
    # unfold: join lines starting with whitespace to previous line
    lines = []
    for raw in text.splitlines():
        if raw and raw[0] in (' ', '\t') and lines:
            lines[-1] += raw[1:]
        else:
            lines.append(raw)

    for line in lines:
        line = line.rstrip('\r')
        if line.upper() == 'BEGIN:VCARD':
            card = {}
        elif line.upper() == 'END:VCARD':
            if card is not None:
                contacts.append(card)
            card = None
        elif card is not None and ':' in line:
            prop, _, val = line.partition(':')
            prop_parts   = prop.upper().split(';')
            prop_name    = prop_parts[0]
            params       = {}
            for p in prop_parts[1:]:
                if '=' in p:
                    pk, _, pv = p.partition('=')
                    params[pk] = pv
                else:
                    params['TYPE'] = p

            ptype = params.get('TYPE', '').lower().split(',')[0] or 'default'

            if prop_name == 'FN':
                card['fn'] = val
            elif prop_name == 'N':
                parts = val.split(';')
                given  = parts[1].strip() if len(parts) > 1 else ''
                family = parts[0].strip()
                card['given']  = given
                card['family'] = family
                card['name']   = f"{given} {family}".strip() or family
            elif prop_name == 'EMAIL':
                card.setdefault('email', {})
                card['email'][ptype or 'email'] = val
            elif prop_name == 'TEL':
                card.setdefault('phone', {})
                card['phone'][ptype or 'phone'] = val
            elif prop_name == 'ORG':
                card['org'] = val.split(';')[0].strip()
            elif prop_name == 'TITLE':
                card['title'] = val
            elif prop_name == 'URL':
                card['url'] = val
            elif prop_name == 'BDAY':
                card['birthday'] = val[:10] if len(val) >= 8 else val
            elif prop_name == 'NOTE':
                card['note'] = val.replace('\\n', '\n')
            elif prop_name == 'ADR':
                parts = (val + ';;;;;;').split(';')
                addr  = ', '.join(p.strip() for p in parts[2:6] if p.strip())
                card['address'] = addr
            elif prop_name == 'CATEGORIES':
                card['tags'] = [t.strip().lower() for t in val.split(',') if t.strip()]

    return contacts


def _contact_to_md(c):
    """Serialise a parsed vCard dict to nb contact markdown."""
    import io
    fm = {}
    name = c.get('name') or c.get('fn', '')
    if name:       fm['name']     = name
    if c.get('given'):   fm['given']   = c['given']
    if c.get('family'):  fm['family']  = c['family']
    if c.get('email'):   fm['email']   = c['email']
    if c.get('phone'):   fm['phone']   = c['phone']
    if c.get('org'):     fm['org']     = c['org']
    if c.get('title'):   fm['title']   = c['title']
    if c.get('address'): fm['address'] = c['address']
    if c.get('birthday'):fm['birthday']= c['birthday']
    if c.get('url'):     fm['url']     = c['url']
    if c.get('tags'):    fm['tags']    = c['tags']

    if _YAML_OK:
        yaml_block = _yaml.dump(fm, allow_unicode=True, default_flow_style=False).rstrip()
    else:
        yaml_block = '\n'.join(f"{k}: {v}" for k, v in fm.items())

    body    = c.get('note', '')
    heading = f"# {name}\n\n" if name else ''
    return f"---\n{yaml_block}\n---\n\n{heading}{body}\n"


# ---------------------------------------------------------------------------
# API: Run read-only nb command (daily, info, weather, notebooks)
# ---------------------------------------------------------------------------

@app.route('/api/cmds')
def api_cmds():
    items = []
    try:
        for line in CMDS_FILE.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            if line == '---':
                items.append({'type': 'divider'})
            elif line.startswith('#'):
                label = line[1:].strip()
                if label:
                    items.append({'type': 'section', 'label': label})
            elif '|' in line:
                cmd, _, label = line.partition('|')
                items.append({'type': 'item', 'cmd': cmd.strip(), 'label': label.strip()})
    except OSError:
        pass
    return jsonify({'items': items})


@app.route('/api/run')
def api_run():
    cmd = request.args.get('cmd', '').strip()
    ALLOWED = {'info', 'weather', 'cal', 'daily', 'notebooks', 'version',
               'status', 'plugins', 'import', 'export'}
    if cmd not in ALLOWED:
        return jsonify({'error': f'command not in allowed list: {cmd}'}), 400
    extra = []
    selector = request.args.get('selector')
    if selector and cmd == 'info':
        extra.append(selector)   # nb info <selector>
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
# API: Rename / Move note
# ---------------------------------------------------------------------------

@app.route('/api/note/rename', methods=['POST'])
def api_rename():
    data     = request.get_json() or {}
    selector = data.get('selector', '').strip()
    name     = data.get('name', '').strip()
    if not selector or not name:
        return jsonify({'error': 'selector and name required'}), 400

    # Read current content so we can update the title-bearing element in place.
    # nb rename only changes the filename; if the title comes from an H1 or
    # frontmatter, the displayed title would not change after a plain rename.
    path_r = run_nb('show', selector, '--path')
    if not nb_ok(path_r):
        return jsonify({'error': 'not found'}), 404
    try:
        raw = Path(path_r['stdout'].strip()).read_text(errors='replace')
    except OSError:
        return jsonify({'error': 'could not read file'}), 404

    meta, body = parse_frontmatter(raw)

    if meta.get('title'):
        new_raw = re.sub(r'^(title:\s*).*$', lambda m: m.group(1) + name,
                         raw, count=1, flags=re.MULTILINE)
        r = run_nb('edit', selector, '--content', new_raw, '--overwrite')
    else:
        lines = body.splitlines(keepends=True)
        updated = False
        for i, line in enumerate(lines):
            s = line.strip()
            if s.startswith('# [ ] ') or s.startswith('# [x] '):
                lines[i] = s[:6] + name + '\n'   # keep '# [ ] ' / '# [x] ' prefix
                updated = True
                break
            if s.startswith('# '):
                lines[i] = '# ' + name + '\n'
                updated = True
                break
        if updated:
            fm_part = ''
            if raw.startswith('---'):
                fm_end = raw.find('\n---', 3)
                fm_part = raw[:fm_end + 4] + '\n'
            r = run_nb('edit', selector, '--content', fm_part + ''.join(lines), '--overwrite')
        else:
            # Title is filename-derived — rename the file
            r = run_nb('rename', selector, name, '--force')

    return jsonify({'success': nb_ok(r), 'stderr': strip_ansi(r['stderr'])})


@app.route('/api/note/move', methods=['POST'])
def api_move():
    data     = request.get_json() or {}
    selector = data.get('selector', '').strip()
    dest     = data.get('dest', '').strip()   # e.g. "work:" or "tasks:folder/"
    if not selector or not dest:
        return jsonify({'error': 'selector and dest required'}), 400
    r = run_nb('move', selector, dest, '--force')
    return jsonify({'success': nb_ok(r), 'stderr': strip_ansi(r['stderr'])})


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
# Dev: restart server
# ---------------------------------------------------------------------------

@app.route('/api/restart', methods=['POST'])
def api_restart():
    def _do_restart():
        time.sleep(0.3)
        # Close all non-standard fds (including the bound socket) so the
        # exec'd process can bind port 5001 fresh.
        for fd in range(3, 256):
            try: os.close(fd)
            except OSError: pass
        os.execv(sys.executable, [sys.executable] + sys.argv)
    threading.Thread(target=_do_restart, daemon=True).start()
    return jsonify({'ok': True})


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

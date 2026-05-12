#!/usr/bin/env python3
"""nb-web — Flask backend for nb note-taking web interface."""

import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
from pathlib import Path

try:
    import yaml as _yaml
    _YAML_OK = True
except ImportError:
    _YAML_OK = False

import shlex
import shutil

from flask import Flask, jsonify, request, send_file, send_from_directory
from flask_sock import Sock

app = Flask(__name__, static_folder='.', static_url_path='')
sock = Sock(app)

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

# ---------------------------------------------------------------------------
# Settings (settings.json — persisted, editable via /api/nb-settings)
# ---------------------------------------------------------------------------

_SETTINGS_PATH = Path(__file__).parent / 'nb-settings.json'

_SETTINGS_SCHEMA = {
    'hledger_web_url': {'type': str,  'default': '',
                        'coerce': lambda v: str(v).strip().rstrip('/')},
    'tw_web_url':      {'type': str,  'default': 'http://localhost:5000',
                        'coerce': lambda v: str(v).strip().rstrip('/')},
    'pty_height':      {'type': int,  'default': 320,
                        'coerce': lambda v: max(60, min(1200, int(v)))},
    'pty_init':        {'type': str,  'default': '',
                        'coerce': lambda v: str(v).strip()},
    'pty_cwd':         {'type': str,  'default': '',
                        'coerce': lambda v: str(v).strip()},
}

def _load_settings():
    out = {k: m['default'] for k, m in _SETTINGS_SCHEMA.items()}
    try:
        if _SETTINGS_PATH.exists():
            saved = json.loads(_SETTINGS_PATH.read_text())
            for key, meta in _SETTINGS_SCHEMA.items():
                if key in saved:
                    out[key] = meta['coerce'](saved[key])
    except Exception:
        pass
    return out

def _save_settings(patch):
    existing = {}
    try:
        if _SETTINGS_PATH.exists():
            existing = json.loads(_SETTINGS_PATH.read_text())
    except Exception:
        pass
    existing.update(patch)
    fd, tmp = tempfile.mkstemp(dir=_SETTINGS_PATH.parent, prefix='.nb-settings.')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(existing, f, indent=2)
            f.write('\n')
        os.rename(tmp, str(_SETTINGS_PATH))
    except Exception:
        try: os.unlink(tmp)
        except Exception: pass
        raise

_settings = _load_settings()

# ---------------------------------------------------------------------------
# Template variable resolution
# ---------------------------------------------------------------------------

_weather_cache: dict = {'value': None, 'ts': 0.0}

def _fetch_weather() -> str:
    if _weather_cache['value'] and time.time() - _weather_cache['ts'] < 3600:
        return _weather_cache['value']
    try:
        import urllib.request
        url = 'https://wttr.in/?format=%c+%C,+%t+(feels+%f),+%h+humidity,+%w&m'
        req = urllib.request.Request(url, headers={'User-Agent': 'curl/7.88'})
        with urllib.request.urlopen(req, timeout=5) as resp:
            result = resp.read().decode('utf-8', errors='replace').strip()
        _weather_cache['value'] = result
        _weather_cache['ts'] = time.time()
        return result
    except Exception:
        return '(weather unavailable)'


def _resolve_template_vars(text: str, title: str = '', tags: str = '', content: str = '') -> str:
    """Resolve {{placeholders}} in a template before note creation.

    Handled vars: {{title}}, {{tags}}, {{content}}, {{date}}, {{day}},
    {{time}}, {{weather}} ({{weather}} triggers a wttr.in fetch only if present).
    """
    now = datetime.now()
    subs = {
        '{{title}}':   title,
        '{{tags}}':    tags,
        '{{content}}': content,
        '{{date}}':    now.strftime('%Y-%m-%d'),
        '{{day}}':     now.strftime('%A, %B %-d, %Y'),
        '{{time}}':    now.strftime('%H:%M'),
    }
    if '{{weather}}' in text:
        subs['{{weather}}'] = _fetch_weather()
    for k, v in subs.items():
        text = text.replace(k, v)
    return text
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
    """Return (meta_dict, body_str) from a markdown file.

    Handles two layouts:
      - standard: starts with ---\\nyaml\\n---
      - nb legacy: starts with # Title\\n\\n---\\nyaml\\n---
    """
    meta = {}
    # Strip a leading heading line that nb used to prepend before the YAML block
    fm_text = text
    if not text.startswith('---'):
        lines = text.splitlines(keepends=True)
        if lines and lines[0].startswith('# '):
            rest = ''.join(lines[1:]).lstrip()
            if rest.startswith('---'):
                fm_text = rest
    if fm_text.startswith('---'):
        end = fm_text.find('\n---', 3)
        if end != -1:
            block = fm_text[3:end].strip()
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
            text = fm_text[end + 4:].lstrip()
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
    if any(f.endswith(s) for s in ('.tar.gz', '.tar.bz2', '.tar.xz')): return 'archive'
    ext = Path(f).suffix
    if ext in ('.md', '.org', '.txt', '.rst', '.adoc', '.asciidoc', '.latex'):
        return 'contact' if notebook == 'contacts' else 'note'
    if ext == '.vcf':                 return 'contact'
    if ext in ('.html', '.htm'):      return 'html'
    if ext in ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'): return 'image'
    if ext == '.csv':                 return 'sheet'
    if ext in ('.zip', '.tar', '.tgz', '.7z', '.rar', '.gz', '.bz2'): return 'archive'
    if ext in ('.mp3', '.ogg', '.flac', '.wav', '.m4a'):  return 'audio'
    if ext in ('.mp4', '.mkv', '.webm', '.avi'):          return 'video'
    if ext in ('.pdf',):              return 'pdf'
    if ext in ('.epub',):             return 'ebook'
    if ext in ('.docx', '.odt'):      return 'document'
    return 'file'


# Types whose content must not be read as text
BINARY_TYPES = frozenset({'image', 'audio', 'video', 'pdf', 'ebook', 'document', 'encrypted', 'archive'})

INDICATORS = {
    'bookmark':    '🔖',
    'todo':        '✔️',
    'todo_open':   '○',
    'todo_closed': '✔️',
    'encrypted':   '🔒',
    'image':       '🌄',
    'audio':       '🔉',
    'video':       '📹',
    'ebook':       '📖',
    'document':    '📄',
    'sheet':       '🗃️',
    'contact':     '🪪',
    'html':        '🌐',
    'archive':     '📦',
    'note':        '',
    'file':        '',
}


def _sanitize_html(html):
    """Strip executable content from HTML before inline display."""
    html = re.sub(r'<script[\s\S]*?</script>',  '', html, flags=re.IGNORECASE)
    html = re.sub(r'<style[\s\S]*?</style>',    '', html, flags=re.IGNORECASE)
    html = re.sub(r'<link\b[^>]*>',             '', html, flags=re.IGNORECASE)
    html = re.sub(r'<iframe[\s\S]*?</iframe>',  '', html, flags=re.IGNORECASE)
    html = re.sub(r"\s+on\w+\s*=\s*'[^']*'",   '', html, flags=re.IGNORECASE)
    html = re.sub(r'\s+on\w+\s*=\s*"[^"]*"',   '', html, flags=re.IGNORECASE)
    return html


def _list_archive(fpath):
    """Return a text listing of an archive's members."""
    import zipfile, tarfile as _tarfile
    name = fpath.name.lower()
    try:
        if fpath.suffix.lower() == '.zip':
            with zipfile.ZipFile(fpath) as z:
                return '\n'.join(sorted(z.namelist()))
        if any(name.endswith(s) for s in ('.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tar.xz')):
            with _tarfile.open(fpath) as t:
                return '\n'.join(sorted(t.getnames()))
    except Exception:
        pass
    try:
        r = subprocess.run(['atool', '--list', '--', str(fpath)],
                           capture_output=True, text=True, timeout=15)
        if r.returncode == 0:
            return r.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return '(cannot list — install atool for .7z / .rar support)'

def _indicator(itype, todo_status=None):
    if itype == 'todo' and todo_status:
        return INDICATORS.get(f'todo_{todo_status}', '✔️')
    return INDICATORS.get(itype, '')


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
    path = request.args.get('path', '').strip()
    if not path:
        return jsonify({'error': 'path required'}), 400
    tpath = Path(path)
    try:
        tpath.relative_to(NB_DIR)
    except ValueError:
        return jsonify({'error': 'invalid path'}), 403
    if not tpath.exists():
        return jsonify({'error': 'not found'}), 404
    return jsonify({'content': tpath.read_text(errors='replace'), 'name': tpath.stem})


@app.route('/api/template', methods=['PUT'])
def api_update_template():
    data    = request.get_json() or {}
    path    = data.get('path', '').strip()
    content = data.get('content', '')
    if not path:
        return jsonify({'error': 'path required'}), 400
    tpath = Path(path)
    try:
        tpath.relative_to(NB_DIR)
    except ValueError:
        return jsonify({'error': 'invalid path'}), 403
    if not tpath.exists():
        return jsonify({'error': 'not found'}), 404
    tpath.write_text(content)
    return jsonify({'success': True})


@app.route('/api/template/default')
def api_get_template_default():
    """Return the auto-default template for a notebook (exactly one in its .templates/)."""
    notebook = request.args.get('notebook', '').strip()
    if not notebook:
        return jsonify({'template': None})
    tmpl_dir = NB_DIR / notebook / '.templates'
    if not tmpl_dir.is_dir():
        return jsonify({'template': None})
    templates = sorted(
        f for f in tmpl_dir.iterdir()
        if f.is_file() and not f.name.startswith('.') and f.suffix in ('.md', '.txt', '.org')
    )
    if len(templates) == 1:
        t = templates[0]
        return jsonify({'template': {'name': t.stem, 'path': str(t)}})
    return jsonify({'template': None})


@app.route('/api/template/default', methods=['POST'])
def api_set_template_default():
    """Copy a template into a notebook's .templates/ dir, making it the auto-default."""
    data          = request.get_json() or {}
    template_path = data.get('template_path', '').strip()
    notebook      = data.get('notebook', '').strip()
    if not template_path or not notebook:
        return jsonify({'error': 'template_path and notebook required'}), 400
    src = Path(template_path)
    try:
        src.relative_to(NB_DIR)
    except ValueError:
        return jsonify({'error': 'invalid path'}), 403
    if not src.is_file():
        return jsonify({'error': 'template not found'}), 404
    dest_dir = NB_DIR / notebook / '.templates'
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / src.name
    import shutil
    shutil.copy2(src, dest)
    return jsonify({'success': True, 'path': str(dest)})


@app.route('/api/template', methods=['DELETE'])
def api_delete_template():
    path = request.args.get('path', '').strip()
    if not path:
        return jsonify({'error': 'path required'}), 400
    tpath = Path(path)
    try:
        tpath.relative_to(NB_DIR)
    except ValueError:
        return jsonify({'error': 'invalid path'}), 403
    if not tpath.exists():
        return jsonify({'error': 'not found'}), 404
    tpath.unlink()
    return jsonify({'success': True})


# ---------------------------------------------------------------------------
# API: Serve raw file (images, audio, video, PDF …)
# ---------------------------------------------------------------------------

def _resolve_to_nb_path(selector):
    """Return Path within NB_DIR for selector, or None on error/traversal."""
    path_r = run_nb('show', selector, '--path')
    if not nb_ok(path_r):
        return None
    p = Path(path_r['stdout'].strip())
    try:
        p.relative_to(NB_DIR)
    except ValueError:
        return None
    return p


@app.route('/api/file')
def api_file():
    """Serve the raw file so the browser can render it natively."""
    selector = request.args.get('selector', '')
    if not selector:
        return jsonify({'error': 'selector required'}), 400
    fpath = _resolve_to_nb_path(selector)
    if not fpath or not fpath.is_file():
        return jsonify({'error': 'not found'}), 404
    return send_file(fpath, conditional=True)


@app.route('/api/preview')
def api_preview():
    """Return a renderable preview for non-text file types."""
    selector = request.args.get('selector', '')
    if not selector:
        return jsonify({'error': 'selector required'}), 400
    fpath = _resolve_to_nb_path(selector)
    if not fpath or not fpath.is_file():
        return jsonify({'error': 'not found'}), 404

    itype = classify(fpath.name)

    if itype == 'html':
        try:
            html = fpath.read_text(errors='replace')
            return jsonify({'type': 'html', 'html': _sanitize_html(html)})
        except OSError as e:
            return jsonify({'error': str(e)}), 500

    if itype in ('ebook', 'document'):
        try:
            r = subprocess.run(
                ['pandoc', '--to=html5', '--no-highlight', '--', str(fpath)],
                capture_output=True, text=True, timeout=30)
            if r.returncode == 0:
                return jsonify({'type': 'html', 'html': _sanitize_html(r.stdout)})
            return jsonify({'type': 'unavailable',
                            'error': f'pandoc failed: {r.stderr.strip()[:200]}'})
        except FileNotFoundError:
            return jsonify({'type': 'unavailable', 'error': 'pandoc not installed'})
        except subprocess.TimeoutExpired:
            return jsonify({'type': 'unavailable', 'error': 'pandoc timed out'})

    if itype == 'archive':
        return jsonify({'type': 'listing', 'text': _list_archive(fpath)})

    # Fallback: try reading as text
    try:
        return jsonify({'type': 'text', 'text': fpath.read_text(errors='replace')})
    except OSError as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/open', methods=['POST'])
def api_open():
    """Open a file in the system's default desktop application (xdg-open)."""
    data = request.get_json() or {}
    selector = data.get('selector', '')
    if not selector:
        return jsonify({'error': 'selector required'}), 400
    fpath = _resolve_to_nb_path(selector)
    if not fpath or not fpath.is_file():
        return jsonify({'error': 'not found'}), 404
    try:
        subprocess.Popen(['xdg-open', str(fpath)])
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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


@app.route('/api/task-query')
def api_task_query():
    """Run a read-only taskwarrior filter and return exported JSON tasks."""
    q = request.args.get('q', '').strip()
    # Block write verbs — this endpoint is read-only
    if q and re.search(r'\b(add|modify|delete|done|start|stop|annotate|denotate|edit|import|sync|undo|purge)\b', q, re.I):
        return jsonify({'error': 'Only read filters are allowed'}), 400
    filter_args = q.split() if q else []
    try:
        result = subprocess.run(
            ['task', 'rc.hooks=off', 'rc.confirmation=no'] + filter_args + ['export'],
            capture_output=True, text=True,
            env={**os.environ, 'NO_COLOR': '1', 'TERM': 'dumb'},
            timeout=10,
        )
        # task exits 1 for "no tasks match" — still valid
        tasks = json.loads(result.stdout or '[]')
        return jsonify({'tasks': tasks})
    except FileNotFoundError:
        return jsonify({'error': 'taskwarrior not found'}), 500
    except (json.JSONDecodeError, subprocess.TimeoutExpired) as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/task-action', methods=['POST'])
def api_task_action():
    """Perform a single-task action: done, start, or stop."""
    data   = request.get_json(silent=True) or {}
    uuid   = data.get('uuid', '').strip()
    action = data.get('action', '').strip()
    if not uuid or not re.match(r'^[a-f0-9\-]{8,}$', uuid):
        return jsonify({'error': 'invalid uuid'}), 400
    if action not in ('done', 'start', 'stop'):
        return jsonify({'error': 'action must be done, start, or stop'}), 400
    try:
        result = subprocess.run(
            ['task', 'rc.confirmation=no', f'uuid:{uuid}', action],
            capture_output=True, text=True,
            env={**os.environ, 'NO_COLOR': '1', 'TERM': 'dumb'},
            timeout=10,
        )
        return jsonify({'success': result.returncode == 0, 'stderr': result.stderr.strip()})
    except FileNotFoundError:
        return jsonify({'error': 'taskwarrior not found'}), 500


_HLEDGER_READ_CMDS = {
    'balance','bal','b',
    'register','reg','r',
    'incomestatement','is',
    'balancesheet','bs',
    'cashflow','cf',
    'accounts','acc','a',
    'prices','commodities','stats','tags','files',
}

@app.route('/api/hledger-query')
def api_hledger_query():
    """Run a read-only hledger report and return JSON or plain text."""
    q    = request.args.get('q', '').strip()
    args = q.split() if q else ['balance']
    cmd  = args[0].lower()
    if cmd not in _HLEDGER_READ_CMDS:
        return jsonify({'error': f'Command not allowed: {args[0]}'}), 400
    # Expand ~ in -f / --file args so codeblocks can reference home-dir paths.
    expanded = [args[0]]
    i = 1
    while i < len(args):
        a = args[i]
        if a in ('-f', '--file') and i + 1 < len(args):
            expanded.append(a)
            expanded.append(os.path.expanduser(args[i + 1]))
            i += 2
        elif a.startswith('--file='):
            expanded.append('--file=' + os.path.expanduser(a[7:]))
            i += 1
        else:
            expanded.append(a)
            i += 1
    try:
        result = subprocess.run(
            ['hledger'] + expanded + ['--output-format', 'json'],
            capture_output=True, text=True,
            env={**os.environ, 'NO_COLOR': '1', 'TERM': 'dumb'},
            timeout=15,
        )
        stderr = result.stderr.strip()
        if result.returncode != 0:
            return jsonify({'error': stderr or 'hledger error'}), 500
        web_url = (os.environ.get('HLEDGER_WEB_URL') or _settings.get('hledger_web_url', '')).rstrip('/')
        extra   = {'webUrl': web_url} if web_url else {}
        try:
            data = json.loads(result.stdout or 'null')
            return jsonify({'cmd': cmd, 'data': data, **extra})
        except json.JSONDecodeError:
            return jsonify({'cmd': cmd, 'text': result.stdout.strip(), **extra})
    except FileNotFoundError:
        return jsonify({'error': 'hledger not found — is it installed?'}), 500
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'hledger timed out'}), 500


@app.route('/api/hledger-add', methods=['POST'])
def api_hledger_add():
    """Append a new transaction to LEDGER_FILE; validates and rolls back on error."""
    data      = request.get_json(silent=True) or {}
    date      = data.get('date', '').strip()
    desc      = data.get('description', '').strip()
    postings  = [p for p in data.get('postings', [])
                 if str(p.get('account', '')).strip()]

    if not date or not desc:
        return jsonify({'error': 'Date and description are required'}), 400
    if not postings:
        return jsonify({'error': 'At least one posting is required'}), 400

    ledger_env = os.environ.get('LEDGER_FILE', '')
    if not ledger_env:
        return jsonify({'error': 'LEDGER_FILE not set — cannot write'}), 400
    ledger_path = Path(os.path.expanduser(ledger_env))
    if not ledger_path.exists():
        return jsonify({'error': f'Ledger file not found: {ledger_path}'}), 400

    # Build journal entry text
    lines = [f'{date} {desc}']
    for p in postings:
        account = str(p.get('account', '')).strip()
        amount  = str(p.get('amount',  '')).strip()
        lines.append(f'    {account}    {amount}' if amount else f'    {account}')
    entry = '\n'.join(lines) + '\n'

    original_size = ledger_path.stat().st_size
    try:
        with open(ledger_path, 'a') as f:
            f.write('\n' + entry)

        result = subprocess.run(
            ['hledger', '-f', str(ledger_path), 'check'],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            with open(ledger_path, 'r+') as f:
                f.truncate(original_size)
            return jsonify({'error': result.stderr.strip() or 'Validation failed'}), 400

        return jsonify({'ok': True})
    except Exception as e:
        try:
            with open(ledger_path, 'r+') as f:
                f.truncate(original_size)
        except Exception:
            pass
        return jsonify({'error': str(e)}), 500


@app.route('/api/version')
def api_version():
    return jsonify({'started': _STARTED_AT, 'rev': _GIT_REV})


@sock.route('/ws/pty')
def ws_pty(ws):
    """WebSocket PTY: open a shell in the browser terminal panel."""
    import pty, select, fcntl, termios, struct

    first = ws.receive(timeout=10)
    if not first:
        return
    try:
        payload  = json.loads(first)
        cwd_str  = payload.get('cwd',  '').strip()
        init_str = payload.get('init', '').strip()
        cols     = int(payload.get('cols', 80))
        rows     = int(payload.get('rows', 24))
    except Exception:
        cwd_str = init_str = ''
        cols, rows = 80, 24

    cwd = None
    if cwd_str:
        p = Path(cwd_str).expanduser()
        cwd = str(p) if p.is_dir() else None

    master_fd, slave_fd = pty.openpty()
    winsize = struct.pack('HHHH', rows, cols, 0, 0)
    fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, winsize)

    shell_bin = os.environ.get('SHELL') or shutil.which('bash') or 'sh'

    def _preexec():
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)

    try:
        proc = subprocess.Popen(
            [shell_bin],
            stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
            close_fds=True, cwd=cwd,
            env={**os.environ, 'TERM': 'xterm-256color'},
            preexec_fn=_preexec,
        )
    except Exception as e:
        os.close(master_fd); os.close(slave_fd)
        ws.send(f'\r\n[pty] Failed to start shell: {e}\r\n')
        return

    if init_str:
        time.sleep(0.15)
        for line in init_str.splitlines():
            line = line.strip()
            if line:
                os.write(master_fd, (line + '\n').encode())
                time.sleep(0.05)

    os.close(slave_fd)
    try:
        while True:
            r, _, _ = select.select([master_fd], [], [], 0.05)
            if r:
                try:
                    data = os.read(master_fd, 4096)
                except OSError:
                    break
                if not data:
                    break
                ws.send(data.decode('utf-8', errors='replace'))
            try:
                inp = ws.receive(timeout=0)
                if inp:
                    if inp.startswith('\x00resize:'):
                        # Resize message: \x00resize:cols,rows
                        try:
                            c, r2 = inp[8:].split(',')
                            ws2 = struct.pack('HHHH', int(r2), int(c), 0, 0)
                            fcntl.ioctl(master_fd, termios.TIOCSWINSZ, ws2)
                        except Exception:
                            pass
                    else:
                        os.write(master_fd, inp.encode('utf-8'))
            except Exception:
                pass
            if proc.poll() is not None:
                try:
                    while True:
                        r2, _, _ = select.select([master_fd], [], [], 0.1)
                        if not r2:
                            break
                        data = os.read(master_fd, 4096)
                        if data:
                            ws.send(data.decode('utf-8', errors='replace'))
                except OSError:
                    pass
                break
    finally:
        try: os.close(master_fd)
        except OSError: pass
        proc.wait()


@app.route('/api/notebooks')
def api_notebooks():
    r = run_nb('notebooks', '--names', '--unarchived', '--global')
    names = [n for n in r['stdout'].splitlines() if n.strip()]
    return jsonify({'notebooks': names})


@app.route('/api/folders')
def api_folders():
    notebook = request.args.get('notebook', 'home')
    nb_path  = nb_dir_for(notebook)
    folders  = []
    if nb_path.exists():
        for p in sorted(nb_path.iterdir()):
            if p.is_dir() and not p.name.startswith('.') and (p / '.index').exists():
                folders.append(p.name)
    return jsonify({'folders': folders})


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
        tags   = request.args.get('tags', '').strip() or None
        return _search_notes(nb_arg, folder, query, limit, tags=tags)
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
            itype = classify(fname, nb_name)
            if itype in BINARY_TYPES:
                meta, body = {}, ''
            else:
                try:
                    raw = fpath.read_text(errors='replace')
                except OSError:
                    continue
                meta, body = parse_frontmatter(raw)
            title = meta.get('title') or meta.get('name') or note_title(fname, body)
            excerpt = next((l.strip()[:120] for l in body.splitlines()
                            if l.strip() and not _RE_HEADING.match(l)
                            and not l.strip().startswith('<!--')), '')
            todo_status = None
            if itype == 'todo':
                first = next((l.strip() for l in body.splitlines() if l.strip()), '')
                todo_status = 'closed' if first.startswith('# [x]') else 'open'
            all_items.append({
                'type':      itype,
                'indicator': _indicator(itype, todo_status),
                'mtime':     fpath.stat().st_mtime,
                'filename':  fname,
                'title':     title,
                'selector':  f"{nb_name}:{fname}",
                'excerpt':   excerpt,
                'notebook':  nb_name,
                'updated':   '',
                'pinned':    False,
                'status':    todo_status,
            })
    # Folders always included; only cap the note/file items by mtime
    folders   = [i for i in all_items if i['type'] == 'folder']
    non_folders = [i for i in all_items if i['type'] != 'folder']
    non_folders.sort(key=lambda i: (NB_DIR / i['notebook'] / i['filename']).stat().st_mtime
                     if (NB_DIR / i['notebook'] / i['filename']).exists() else 0, reverse=True)
    combined = folders + non_folders[:limit]
    return jsonify({'notes': combined, 'total': len(combined)})


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
        itype = classify(fname, notebook)
        if itype in BINARY_TYPES:
            meta, body = {}, ''
        else:
            try:
                raw  = fpath.read_text(errors='replace')
            except OSError:
                continue
            meta, body = parse_frontmatter(raw)
        title = meta.get('title') or meta.get('name') or note_title(fname, body)
        excerpt = ''
        for line in body.splitlines():
            line = line.strip()
            if line and not _RE_HEADING.match(line) and not line.startswith('<!--'):
                excerpt = line[:120]
                break
        todo_status = None
        if itype == 'todo':
            first = next((l.strip() for l in body.splitlines() if l.strip()), '')
            todo_status = 'closed' if first.startswith('# [x]') else 'open'
        sel_path = (folder + '/' if folder else '') + fname
        items.append({
            'type':      itype,
            'indicator': _indicator(itype, todo_status),
            'id':        item_id,
            'mtime':     fpath.stat().st_mtime,
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


def _resolve_fname(nb_name, raw_id_or_sel):
    """Return (fname, fpath) for a note identified by id or selector, or (None, None)."""
    try:
        raw_id = str(raw_id_or_sel).split(':')[-1]
        if not raw_id.isdigit():
            return None, None
        idx    = read_index(nb_name)
        id_num = int(raw_id)
        if not (1 <= id_num <= len(idx)):
            return None, None
        fname = idx[id_num - 1]
        if not fname:
            return None, None
        return fname, NB_DIR / nb_name / fname
    except Exception:
        return None, None


def _read_excerpt(nb_name, raw_id_or_sel):
    """Return first non-heading body line for a note identified by id or selector."""
    try:
        fname, fpath = _resolve_fname(nb_name, raw_id_or_sel)
        if not fpath:
            return ''
        _, body = parse_frontmatter(fpath.read_text(errors='replace'))
        for line in body.splitlines():
            line = line.strip()
            if line and not _RE_HEADING.match(line):
                return line[:120]
    except Exception:
        pass
    return ''


def _search_notes(notebook, folder, query, limit, tags=None):
    """Full-text search via nb CLI.

    nb search --list output format: [selector]  Title
    selector is a bare id (e.g. 41), a path (2026/01-January/7),
    or notebook:id (gbct:1) when using --all.

    When tags is also provided, runs a second search for the tag and
    returns only items present in both result sets (AND logic).
    """
    def _run_search(q):
        if notebook:
            args = [f"{notebook}:search", q, '--list']
        else:
            args = ['search', q, '--all', '--list']
        r = run_nb(*args)
        return [strip_ansi(l) for l in r['stdout'].splitlines() if l.strip()]

    pat   = re.compile(r'^\[([^\]]+)\]\s+(.+)$')
    lines = _run_search(query)

    # If a tag filter is also active, intersect by selector
    tag_selectors = None
    if tags:
        tag_lines = _run_search(tags)
        tag_selectors = set()
        for tl in tag_lines:
            tm = pat.match(tl.strip())
            if not tm:
                continue
            rs = tm.group(1).strip()
            sel = rs if ':' in rs else (f"{notebook}:{rs}" if notebook else rs)
            tag_selectors.add(sel)

    items      = []
    seen_sels  = set()
    for line in lines[:limit * 2]:   # over-read to allow for dedup
        m = pat.match(line.strip())
        if not m:
            continue
        raw_sel = m.group(1).strip()
        title   = m.group(2).strip()
        # Strip leading indicator emoji + variation selectors (e.g. "✅ [x] Todo title")
        title   = re.sub(r'^[\U00010000-\U0010ffff✔✅📌🔖🔒📂🌄🔉📹📖📄︀-️]+\s*', '', title).strip()
        title   = re.sub(r'^\[[ x]\]\s*', '', title).strip()  # strip [ ] or [x]
        # Strip "filename · Title" duplicate format nb emits for filename matches
        title   = re.sub(r'^[^·]+·\s*', '', title).strip() if '·' in title else title
        # Build a full selector
        if ':' in raw_sel:
            selector = raw_sel
            nb_part  = raw_sel.split(':')[0]
        else:
            selector = f"{notebook}:{raw_sel}" if notebook else raw_sel
            nb_part  = notebook

        # Deduplicate — nb search emits the same selector for filename + content matches
        if selector in seen_sels:
            continue
        seen_sels.add(selector)

        # AND logic: skip if not in tag results
        if tag_selectors is not None and selector not in tag_selectors:
            continue

        if len(items) >= limit:
            break

        # Classify using actual filename so contacts/sheets get correct type
        fname, _ = _resolve_fname(nb_part, raw_sel)
        if fname:
            itype = classify(fname, nb_part)
        else:
            itype = 'note'

        # For todos, also derive status from line content
        todo_status = None
        if itype == 'todo':
            todo_status = 'closed' if ('[x]' in line or '✅' in line) else 'open'
        elif itype == 'note':
            # Fallback: infer todo from line markers (for notebooks where classify can't help)
            if '[ ]' in line or '[x]' in line or '✅' in line:
                itype       = 'todo'
                todo_status = 'closed' if ('[x]' in line or '✅' in line) else 'open'

        try:
            fmtime = (NB_DIR / nb_part / fname).stat().st_mtime if fname else 0
        except OSError:
            fmtime = 0
        items.append({
            'selector':  selector,
            'filename':  fname or raw_sel,
            'title':     title or raw_sel,
            'type':      itype,
            'status':    todo_status,
            'indicator': _indicator(itype, todo_status),
            'mtime':     fmtime,
            'excerpt':   _read_excerpt(nb_part, raw_sel),
            'notebook':  nb_part,
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
                # For subfolder notes, read the folder's own index
                folder_rel = '/'.join(rel.parts[:-1]) if len(rel.parts) > 1 else ''
                idx = read_index(note_notebook, folder_rel)
                fname_key = rel.name
                if fname_key in idx:
                    note_id = idx.index(fname_key) + 1
                break
            except ValueError:
                continue
    except Exception:
        pass

    filename = Path(fpath).name
    itype = classify(filename, note_notebook)

    # Don't read binary files as text — frontend fetches /api/file for those
    if itype in BINARY_TYPES:
        return jsonify({
            'selector': selector, 'notebook': note_notebook or '',
            'id': note_id, 'filename': filename,
            'title': note_title(filename, ''),
            'type': itype, 'binary': True,
            'raw': '', 'body': '', 'tags': [], 'meta': {},
        })

    try:
        raw = Path(fpath).read_text(errors='replace')
    except OSError:
        return jsonify({'error': 'could not read file'}), 404

    meta, body = parse_frontmatter(raw)
    title = meta.get('title') or meta.get('name') or note_title(filename, body)

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
        r = run_nb('folders', 'add', target + folder_name)
    elif ntype == 'notebook':
        nb_name = (title or 'notebook').strip()
        r = run_nb('notebooks', 'add', nb_name)
    else:
        # Resolve template vars in Python so {{date}}, {{weather}} etc. work
        # for any template, not just daily-template.
        note_content = content or '\n'
        if template_path:
            tp = Path(template_path)
            try:
                tp.relative_to(NB_DIR)
                if tp.exists():
                    note_content = _resolve_template_vars(
                        tp.read_text(errors='replace'),
                        title=title,
                        tags=' '.join(f'#{t}' for t in tags) if tags else '',
                        content=content or '',
                    )
            except (ValueError, OSError):
                pass

        args = ['add', target]
        # Skip --title when a template is used: {{title}} is already substituted
        # into the content, and nb prepending "# Title\n\n" breaks YAML frontmatter.
        if title and not template_path:
            args += ['--title', title]
        args += ['--content', note_content]
        if tags:    args += ['--tags', ','.join(tags)]
        # Datestamp-prefixed filename keeps the clean title while making notes cal-visible
        slug = re.sub(r'[^\w]+', '_', title or 'note').strip('_').lower()
        dated_filename = f"{datetime.now().strftime('%Y%m%d%H%M%S')}_{slug}.md"
        args += ['--filename', dated_filename]
        r = run_nb(*args)
        if nb_ok(r):
            # We control the filename, so build the selector directly — avoids
            # parsing nb's ID-based output which won't match filename selectors in the list.
            return jsonify({'success': True, 'output': strip_ansi(r['stdout']),
                            'selector': f'{notebook}:{dated_filename}'})

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
# API: Git log (recent commits for Done-with-commit UI)
# ---------------------------------------------------------------------------

@app.route('/api/git/log')
def api_git_log():
    n = min(int(request.args.get('n', 8)), 20)
    try:
        result = subprocess.run(
            ['git', 'log', f'-{n}', '--format=%h\t%s\t%cd', '--date=short'],
            capture_output=True, text=True,
            cwd=str(Path(__file__).parent),
        )
        commits = []
        for line in result.stdout.splitlines():
            if not line.strip():
                continue
            parts = line.split('\t', 2)
            commits.append({
                'hash':    parts[0] if len(parts) > 0 else '',
                'subject': parts[1] if len(parts) > 1 else '',
                'date':    parts[2] if len(parts) > 2 else '',
            })
        return jsonify({'commits': commits})
    except Exception as e:
        return jsonify({'commits': [], 'error': str(e)})


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
        itype       = classify(fname, nb_name)
        todo_status = None
        if itype == 'todo':
            first = next((l.strip() for l in body.splitlines() if l.strip()), '')
            todo_status = 'closed' if first.startswith('# [x]') else 'open'
        return {
            'notebook':  nb_name,
            'id':        note_id,
            'filename':  fname,
            'selector':  f"{nb_name}:{fname}",
            'title':     note_title(fname, body),
            'type':      itype,
            'indicator': _indicator(itype, todo_status),
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


@app.route('/api/export')
def api_export():
    import io
    selector = request.args.get('selector', '').strip()
    fmt      = request.args.get('fmt', 'md').strip().lower()
    if not selector:
        return jsonify({'error': 'selector required'}), 400

    fpath = _resolve_to_nb_path(selector)
    if not fpath:
        return jsonify({'error': 'not found'}), 404

    stem = fpath.stem

    if fmt == 'md':
        return send_file(str(fpath), as_attachment=True,
                         download_name=fpath.name, mimetype='text/markdown')

    FORMAT_MAP = {
        'html': ('.html', 'text/html'),
        'docx': ('.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
        'odt':  ('.odt',  'application/vnd.oasis.opendocument.text'),
    }
    if fmt not in FORMAT_MAP:
        return jsonify({'error': f'unsupported format: {fmt}'}), 400

    suffix, mimetype = FORMAT_MAP[fmt]
    extra = ['--standalone'] if fmt == 'html' else []
    try:
        import tempfile
        tmp = Path(tempfile.mktemp(suffix=suffix))
        r = subprocess.run(
            ['pandoc', str(fpath), '-t', fmt, '-o', str(tmp)] + extra,
            capture_output=True, timeout=30)
        if r.returncode != 0:
            return jsonify({'error': r.stderr.decode(errors='replace')}), 500
        data = tmp.read_bytes()
        tmp.unlink(missing_ok=True)
        return send_file(io.BytesIO(data), as_attachment=True,
                         download_name=f'{stem}{suffix}', mimetype=mimetype)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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
    if c.get('tags'):
        raw = c['tags']
        if isinstance(raw, list):
            fm['tags'] = [str(t).strip() for t in raw if t]
        else:
            fm['tags'] = [t.strip() for t in str(raw).replace(',', ' ').split() if t.strip()]

    if _YAML_OK:
        yaml_block = _yaml.dump(fm, allow_unicode=True, default_flow_style=False).rstrip()
    else:
        yaml_block = '\n'.join(f"{k}: {v}" for k, v in fm.items())

    body    = c.get('note', '')
    heading = f"# {name}\n\n" if name else ''
    # Append #hashtag line so nb full-text search finds contacts by tag
    tag_line = ''
    if c.get('tags'):
        raw_tags = c['tags']
        if isinstance(raw_tags, list):
            tag_line = '\n\n' + ' '.join(f"#{t}" for t in raw_tags if t)
        elif isinstance(raw_tags, str):
            tag_line = '\n\n' + ' '.join(
                f"#{t.strip()}" for t in raw_tags.replace(',', ' ').split() if t.strip()
            )
    return f"---\n{yaml_block}\n---\n\n{heading}{body}{tag_line}\n"


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
# API: Note history (git-backed undo)
# ---------------------------------------------------------------------------

def _nb_root_and_rel(fpath):
    """Return (nb_root_Path, rel_path_str) for a file inside NB_DIR."""
    parts = fpath.relative_to(NB_DIR).parts
    nb_root = NB_DIR / parts[0]
    rel_path = str(fpath.relative_to(nb_root))
    return nb_root, rel_path


@app.route('/api/note/history')
def api_note_history():
    selector = request.args.get('selector', '').strip()
    if not selector:
        return jsonify({'error': 'selector required'}), 400
    fpath = _resolve_to_nb_path(selector)
    if not fpath:
        return jsonify({'error': 'not found'}), 404
    nb_root, rel_path = _nb_root_and_rel(fpath)
    r = subprocess.run(
        ['git', 'log', '--format=%H\t%s\t%cd', '--date=short', '--', rel_path],
        capture_output=True, text=True, cwd=str(nb_root))
    commits = []
    for line in r.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split('\t', 2)
        commits.append({
            'hash':    parts[0] if len(parts) > 0 else '',
            'subject': parts[1] if len(parts) > 1 else '',
            'date':    parts[2] if len(parts) > 2 else '',
        })
    return jsonify({'commits': commits})


@app.route('/api/note/version')
def api_note_version():
    selector = request.args.get('selector', '').strip()
    git_hash = request.args.get('hash', '').strip()
    if not selector or not git_hash:
        return jsonify({'error': 'selector and hash required'}), 400
    if not re.match(r'^[0-9a-f]{4,64}$', git_hash):
        return jsonify({'error': 'invalid hash'}), 400
    fpath = _resolve_to_nb_path(selector)
    if not fpath:
        return jsonify({'error': 'not found'}), 404
    nb_root, rel_path = _nb_root_and_rel(fpath)
    r = subprocess.run(
        ['git', 'show', f'{git_hash}:{rel_path}'],
        capture_output=True, text=True, cwd=str(nb_root))
    if r.returncode != 0:
        return jsonify({'error': r.stderr.strip()}), 404
    raw = r.stdout
    meta, body = parse_frontmatter(raw)
    title = meta.get('title') or meta.get('name') or note_title(fpath.name, body)
    return jsonify({'raw': raw, 'body': body, 'meta': meta, 'title': title,
                    'type': classify(fpath.name, fpath.relative_to(NB_DIR).parts[0]),
                    'hash': git_hash})


@app.route('/api/note/restore', methods=['POST'])
def api_note_restore():
    data     = request.get_json() or {}
    selector = data.get('selector', '').strip()
    git_hash = data.get('hash', '').strip()
    if not selector or not git_hash:
        return jsonify({'error': 'selector and hash required'}), 400
    if not re.match(r'^[0-9a-f]{4,64}$', git_hash):
        return jsonify({'error': 'invalid hash'}), 400
    fpath = _resolve_to_nb_path(selector)
    if not fpath:
        return jsonify({'error': 'not found'}), 404
    nb_root, rel_path = _nb_root_and_rel(fpath)
    r = subprocess.run(
        ['git', 'show', f'{git_hash}:{rel_path}'],
        capture_output=True, text=True, cwd=str(nb_root))
    if r.returncode != 0:
        return jsonify({'error': r.stderr.strip()}), 500
    fpath.write_text(r.stdout)
    subprocess.run(['git', 'add', '--', rel_path], cwd=str(nb_root))
    subprocess.run(
        ['git', 'commit', '-m', f'[nb] Restore: {fpath.name} to {git_hash[:7]}'],
        cwd=str(nb_root))
    return jsonify({'success': True})


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


@app.route('/api/nb-settings', methods=['GET', 'PATCH'])
def api_nb_settings():
    global _settings
    if request.method == 'PATCH':
        patch = request.get_json(silent=True) or {}
        validated = {}
        for key, val in patch.items():
            if key not in _SETTINGS_SCHEMA:
                return jsonify({'error': f'Unknown setting: {key}'}), 400
            try:
                validated[key] = _SETTINGS_SCHEMA[key]['coerce'](val)
            except Exception as e:
                return jsonify({'error': f'Invalid value for {key}: {e}'}), 400
        _save_settings(validated)
        _settings = _load_settings()
    return jsonify(_settings)


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

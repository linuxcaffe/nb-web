#!/usr/bin/env python3
"""nb-web — Flask backend for nb note-taking web interface."""

import json
import os
import re
import signal
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

import csv
import hashlib
import io
import shlex
import shutil
import socket
import zipfile

from flask import Flask, Response, jsonify, redirect, request, send_file, send_from_directory, session
from flask_sock import Sock

app = Flask(__name__, static_folder='.', static_url_path='')
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50 MB upload limit
app.json.sort_keys = False                             # preserve document key order (Flask 2.2+)
sock = Sock(app)

NB_BIN  = os.environ.get('NB_BIN', 'nb')
NB_DIR  = Path(os.environ.get('NB_DIR', Path.home() / '.nb'))
HOST    = os.environ.get('NB_WEB_HOST', '127.0.0.1')
PORT    = int(os.environ.get('NB_WEB_PORT', 5001))
DEBUG   = os.environ.get('NB_WEB_DEBUG', '').lower() in ('1', 'true', 'yes')

GLOBAL_TEMPLATES_DIR = NB_DIR / '.templates'
TEST_DIR             = NB_DIR / '.test'
WEB_DIR              = NB_DIR / '.web'
WEB_PLUGINS_DIR      = WEB_DIR / 'plugins'
CMDS_FILE            = Path(__file__).parent / 'cmds.txt'

_RE_HEADING       = re.compile(r'^#{1,6}(\s|$)')   # true MD heading; bare #tag is not a heading
_RE_NOTEBOOK_NAME = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$')

def _check_notebook(name: str) -> str:
    """Return name unchanged if safe; raise ValueError if it could escape NB_DIR."""
    if not name or not _RE_NOTEBOOK_NAME.match(name):
        raise ValueError(f'Invalid notebook name: {name!r}')
    return name
_RE_FENCE    = re.compile(r'^```')            # fenced code block opening/closing line

def _first_excerpt_line(body: str, meta: dict) -> str:
    """Return the best single-line excerpt for a note body.

    Priority: caption → phone (contact notes) → email → first body line.
    Entire fenced blocks are skipped so ` ```csv ` doesn't show as an excerpt.
    """
    if meta.get('caption'):
        return str(meta['caption'])[:120]
    for field in ('desc', 'phone', 'email'):
        val = meta.get(field)
        if val:
            first = next(iter(val.values()), None) if isinstance(val, dict) else str(val)
            if first:
                return str(first)[:120]
    in_fence = False
    for raw_line in body.splitlines():
        line = raw_line.strip()
        if _RE_FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if line and not _RE_HEADING.match(line) and not line.startswith('<!--'):
            return line[:120]
    return ''

# Startup stamp — visible in menu so you can confirm a restart happened
from datetime import datetime
_STARTED_AT = datetime.now().strftime('%m-%d %H:%M')

# ---------------------------------------------------------------------------
# Settings (settings.json — persisted, editable via /api/nb-settings)
# ---------------------------------------------------------------------------

_SETTINGS_PATH = Path(__file__).parent / 'nb-settings.json'

_SETTINGS_SCHEMA = {
    'hledger_web_cmd': {'type': str,  'default': '',
                        'coerce': lambda v: str(v).strip()},
    'hledger_terminal':{'type': bool, 'default': False,
                        'coerce': lambda v: bool(v)},
    'tw_web_cmd':      {'type': str,  'default': '',
                        'coerce': lambda v: str(v).strip()},
    'tw_terminal':     {'type': bool, 'default': False,
                        'coerce': lambda v: bool(v)},
    'pty_height':      {'type': int,  'default': 320,
                        'coerce': lambda v: max(60, min(1200, int(v)))},
    'pty_init':        {'type': str,  'default': '',
                        'coerce': lambda v: str(v).strip()},
    'pty_cwd':         {'type': str,  'default': '',
                        'coerce': lambda v: str(v).strip()},
    'import_max_mb':   {'type': int,  'default': 25,
                        'coerce': lambda v: max(1, min(500, int(v)))},
    'import_max_files':{'type': int,  'default': 20,
                        'coerce': lambda v: max(1, min(200, int(v)))},
    'git_repos':        {'type': dict, 'default': {},
                        'coerce': lambda v: {
                            str(k): str(Path(os.path.expanduser(str(p))).resolve())
                            for k, p in (v.items() if isinstance(v, dict) else {}.items())
                        }},
    'default_git_remote': {'type': str, 'default': '',
                            'coerce': lambda v: str(v).strip()},
    'notebook_prefs':     {'type': dict, 'default': {},
                            'coerce': lambda v: v if isinstance(v, dict) else {}},
    'vcf_source':         {'type': str, 'default': '~/Downloads/contacts.vcf',
                            'coerce': lambda v: str(v).strip()},
    'contact_tag':        {'type': str, 'default': 'djp',
                            'coerce': lambda v: str(v).strip().lstrip('#')},
    'plugin_prefs':       {'type': dict, 'default': {},
                            'coerce': lambda v: v if isinstance(v, dict) else {}},
    'plugins':            {'type': list, 'default': [],
                            'coerce': lambda v: [
                                {
                                    'url':      str(p.get('url', '')),
                                    'name':     str(p.get('name', '')),
                                    'enabled':  bool(p.get('enabled', True)),
                                    'type':     str(p.get('type', 'plugin')),
                                    'homepage': str(p.get('homepage', '')),
                                }
                                for p in v if isinstance(p, dict) and p.get('url')
                            ] if isinstance(v, list) else []},
    'codeblock_access':   {'type': dict, 'default': {},
                            'coerce': lambda v: v if isinstance(v, dict) else {}},
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


def _cb_write_allowed(block_type):
    """Return True if the current session user meets the write level for block_type."""
    level = (_settings.get('codeblock_access') or {}).get(block_type, {}).get('write')
    if not level:
        return True
    user = session.get('user', {})
    return _level_gte(user.get('level', ''), level)


# ---------------------------------------------------------------------------
# Template variable resolution
# ---------------------------------------------------------------------------

_weather_cache: dict = {'value': None, 'ts': 0.0}
_test_cache:    dict = {}   # (script, selector) -> {'result': dict, 'ts': float}
_TEST_CACHE_TTL = 30        # seconds; force=True bypasses

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

    Handled vars: {{title}}, {{input}} (alias for title — whatever the user
    typed in the title/input field), {{tags}}, {{content}}, {{date}}, {{day}},
    {{time}}, {{weather}} (triggers a wttr.in fetch only if present).
    """
    now = datetime.now()
    subs = {
        '{{title}}':   title,
        '{{input}}':   title,   # same value — name signals "inject the user's input here"
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

def _safe_notebook(name: str) -> str | None:
    """Return name if it's a safe single path component, else None.

    Guards against path traversal via notebook=../../etc in URL params.
    """
    if not name or '/' in name or '\\' in name or name.startswith('.'):
        return None
    # Reject any component that would traverse upward
    if Path(name).parts != (name,):
        return None
    return name


def nb_dir_for(notebook):
    return NB_DIR / notebook


_index_cache: dict = {}   # (notebook, folder) -> (mtime, [filenames])

def read_index(notebook, folder=''):
    """Return ordered list of filenames from .index for a notebook/folder."""
    path = nb_dir_for(notebook) / folder / '.index'
    if not path.exists():
        return []
    try:
        mtime = path.stat().st_mtime
        key = (notebook, folder)
        hit = _index_cache.get(key)
        if hit and hit[0] == mtime:
            return hit[1]
        # Keep blank lines — nb counts every line (including blanks) as an ID position.
        lines = [l.strip() for l in path.read_text().splitlines()]
        _index_cache[key] = (mtime, lines)
        return lines
    except OSError:
        return []


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


# ---------------------------------------------------------------------------
# Auth — session login; users are .md files in ~/.nb/.users/
# ---------------------------------------------------------------------------

from werkzeug.security import check_password_hash

USERS_DIR  = NB_DIR / '.users'
LEVELS     = ['guest', 'user', 'office', 'admin', 'tech']
DOTFOLDERS = ['.users', '.tools', '.changes', '.images', '.rules', '.lib']

_SECRET_FILE = Path(__file__).parent / '.flask_secret'

def _get_secret_key():
    if _SECRET_FILE.exists():
        return _SECRET_FILE.read_text().strip()
    import secrets as _secrets
    key = _secrets.token_hex(32)
    _SECRET_FILE.write_text(key + '\n')
    _SECRET_FILE.chmod(0o600)
    return key

app.secret_key = _get_secret_key()

_RE_USERNAME = re.compile(r'^[a-zA-Z0-9_.-]+$')

def _load_user(username):
    """Return user dict from ~/.nb/.users/<username>.md frontmatter, or None."""
    if not username or not _RE_USERNAME.match(username):
        return None
    path = USERS_DIR / f'{username}.md'
    if not path.exists():
        return None
    try:
        meta, _ = parse_frontmatter(path.read_text())
        nbs = meta.get('notebooks')
        return {
            'username':      username,
            'name':          str(meta.get('name', username)),
            'level':         str(meta.get('level', 'user')),
            'notebooks':     list(nbs) if isinstance(nbs, (list, tuple)) else [],
            'password_hash': str(meta.get('password_hash', '')),
        }
    except Exception:
        return None

def _level_gte(have, need):
    try:
        return LEVELS.index(have) >= LEVELS.index(need)
    except ValueError:
        return False

def _notebook_config(notebook):
    """Read ~/<notebook>/.<notebook>.md and return its frontmatter dict."""
    cfg = NB_DIR / notebook / f'.{notebook}.md'
    if not cfg.exists():
        return {}
    try:
        meta, _ = parse_frontmatter(cfg.read_text())
        return meta
    except Exception:
        return {}

def _effective_access(note_meta, nb_meta):
    """Return the minimum level required to view a note.

    Resolution order:
      note access:    → explicit override, always wins
      note user:      → inherits that user's level from their card
      notebook config → access: in .<notebook>.md
      system default  → 'user' (guests see nothing unless explicitly granted)
    """
    if note_meta.get('access'):
        return str(note_meta['access'])
    if note_meta.get('user'):
        card = _load_user(str(note_meta['user']))
        if card:
            return card.get('level', 'user')
    return str(nb_meta.get('access') or 'user')

@app.before_request
def _check_auth():
    if request.path in ('/login', '/logout', '/setup'):
        return
    if not session.get('user'):
        if request.path.startswith('/api/') or request.path.startswith('/ws'):
            return jsonify(error='Authentication required'), 401
        return redirect('/login')

_LOGIN_HTML = '''<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>nb-web</title>
  <style>
    *, *::before, *::after {{ box-sizing: border-box; }}
    body {{ font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0;
            display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }}
    form {{ background: #16213e; padding: 2rem; border-radius: 8px; width: 100%; max-width: 300px; }}
    h2   {{ margin: 0 0 1.5rem; color: #a0c4ff; font-size: 1.2rem; }}
    label {{ display: block; margin-bottom: .3rem; font-size: .8rem; color: #aaa;
             text-transform: uppercase; letter-spacing: .05em; }}
    input {{ display: block; width: 100%; padding: .5rem .6rem; margin-bottom: 1rem;
             background: #0f3460; border: 1px solid #2a4a8a; border-radius: 4px;
             color: #e0e0e0; font-size: 1rem; }}
    input:focus {{ outline: none; border-color: #5588cc; }}
    button {{ width: 100%; padding: .6rem; background: #3a7bd5; border: none;
              border-radius: 4px; color: #fff; font-size: 1rem; cursor: pointer; }}
    button:hover {{ background: #2d63b8; }}
    .err {{ color: #ff8080; margin-bottom: 1rem; font-size: .9rem; }}
  </style>
</head>
<body>
  <form method="POST" action="/login">
    <h2>nb-web</h2>
    {error}
    <label>Username</label>
    <input name="username" type="text" autocomplete="username" autofocus>
    <label>Password</label>
    <input name="password" type="password" autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>
</body>
</html>'''

@app.route('/login', methods=['GET', 'POST'])
def login():
    if not USERS_DIR.exists() or not any(USERS_DIR.glob('*.md')):
        return redirect('/setup')
    if request.method == 'GET':
        return _LOGIN_HTML.format(error=''), 200, {'Content-Type': 'text/html; charset=utf-8'}
    username = request.form.get('username', '').strip().lower()
    password = request.form.get('password', '')
    user = _load_user(username)
    if user and user['password_hash'] and check_password_hash(user['password_hash'], password):
        session['user'] = {k: user[k] for k in ('username', 'name', 'level', 'notebooks')}
        return redirect('/')
    err = '<p class="err">Invalid username or password.</p>'
    return _LOGIN_HTML.format(error=err), 401, {'Content-Type': 'text/html; charset=utf-8'}

@app.route('/logout')
def logout():
    session.clear()
    return redirect('/login')

@app.route('/api/me')
def api_me():
    user = session.get('user')
    if not user:
        return jsonify(error='Not authenticated'), 401
    return jsonify(user)


# Dotfolders readable by all authenticated users (client-side data-min-level handles tiering)
_DOT_OPEN = {'.lib', '.images'}

def _is_dot_notebook(name):
    return name in DOTFOLDERS

def _dot_selector_to_path(selector):
    """Parse '.dotfolder:filename' → Path, or None if not a dotfolder selector."""
    if ':' not in selector:
        return None
    nb, _, filename = selector.partition(':')
    if nb not in DOTFOLDERS or not filename or '/' in filename or filename.startswith('.'):
        return None
    return NB_DIR / nb / filename

def _list_dotfolder_notes(dotfolder, limit=200):
    folder_path = NB_DIR / dotfolder
    items = []
    if not folder_path.is_dir():
        return jsonify({'notes': [], 'total': 0})
    entries = sorted(folder_path.iterdir(), key=lambda p: -p.stat().st_mtime)
    for fpath in entries:
        if fpath.name.startswith('.') or not fpath.is_file():
            continue
        itype = classify(fpath.name, None)
        if itype in BINARY_TYPES:
            meta, body = {}, ''
        else:
            try:
                raw = fpath.read_text(errors='replace')
            except OSError:
                continue
            meta, body = parse_frontmatter(raw)
            itype = _apply_meta_type(itype, meta)
        title   = meta.get('title') or meta.get('name') or note_title(fpath.name, body)
        excerpt = _first_excerpt_line(body, meta)
        items.append({
            'type':      itype,
            'indicator': _indicator(itype, None),
            'id':        '',
            'mtime':     fpath.stat().st_mtime,
            'filename':  fpath.name,
            'title':     title,
            'selector':  f'{dotfolder}:{fpath.name}',
            'excerpt':   excerpt,
            'updated':   '',
        })
        if len(items) >= limit:
            break
    return jsonify({'notes': items, 'total': len(items)})


def note_title(filename, body):
    """Extract title from first H1 or filename stem."""
    for line in body.splitlines():
        line = line.strip()
        if line.startswith('# '):
            return line[2:].strip()
        if line.startswith('# [ ] ') or line.startswith('# [x] '):
            return line[6:].strip()
    fname = Path(filename).name
    if fname.lower().endswith('.enc'):
        stem = Path(fname).stem                  # strip .enc
        if stem.lower().endswith('.md'):
            stem = stem[:-3]                     # strip .md
        stem = re.sub(r'^\d{14}_?', '', stem)    # strip YYYYMMDDHHMMSS_ prefix
        return stem.replace('_', ' ').strip() or fname
    return Path(filename).stem


def classify(filename, notebook=None):
    """Return item type string based on filename extension (and notebook)."""
    f = filename.lower()
    if f.endswith('.bookmark.md'):    return 'bookmark'
    if f.endswith('.todo.md'):        return 'todo'
    if f.endswith('.enc'):            return 'encrypted'
    if any(f.endswith(s) for s in ('.tar.gz', '.tar.bz2', '.tar.xz')): return 'archive'
    ext = Path(f).suffix
    if ext in ('.md', '.org', '.rst', '.adoc', '.asciidoc', '.latex'):
        return 'contact' if notebook == 'contacts' else 'note'
    if ext == '.txt':                                  return 'code'
    if ext in ('.sh', '.bash', '.zsh', '.fish'):         return 'code'
    if ext in ('.journal', '.ledger', '.hledger'):       return 'code'
    if ext in ('.hs', '.lhs'):                           return 'code'
    if ext in ('.py', '.pyw'):                           return 'code'
    if ext in ('.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'): return 'code'
    if ext in ('.html', '.htm', '.xml', '.svg'):         return 'code'
    if ext in ('.css', '.scss', '.less'):                return 'code'
    if ext in ('.json', '.jsonc'):                       return 'code'
    if ext in ('.sql',):                                 return 'code'
    if ext in ('.yaml', '.yml'):                         return 'code'
    if ext in ('.c', '.h'):                              return 'code'
    if ext in ('.cpp', '.cc', '.cxx', '.hpp', '.hxx'):   return 'code'
    if ext in ('.rs',):                                  return 'code'
    if ext in ('.toml',):                                return 'code'
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
    'strip':       '🎞️',
    'shot':        '🎬',
    'scene':       '📜',
    'storyline':   '🧵',
    'story':       '🃏',
    'actor':       '🧑',
    'location':    '📍',
    'day':         '📅',
    'resource':    '🎁',
    'note':        '',
    'code':        '📋',
    'file':        '',
}

# Frontmatter type: values that override classify().
#
# classify() is filename-only; this hook lets notes opt into a richer type via
# frontmatter  type: <name>  without renaming the file.  To register a new type:
#   1. Add its name to _FM_TYPES below.
#   2. Add its icon to INDICATORS above.
#   3. Add it to the icon breakdown in main.js renderList if it should appear in
#      the type count bar (e.g. `strip:'🎞️'`).
#   4. Add it to the markdown-rendering whitelist in main.js renderPreview:
#      ['note','file','strip',''].includes(note.type)   ← add the new name here
#   5. Registered types automatically get a `meta` dict in list items (scalar
#      frontmatter fields only). Plugins use this via `listTitle: note => ...`
#      to compute a custom display title from note.meta.
#
# Currently registered frontmatter types:
#   strip     — film production stripboard note      🎞️  (NbWeb-cine plugin)
#   shot      — individual camera shot               🎬  (NbWeb-cine plugin)
#   scene     — screenplay scene document            📜  (NbWeb-cine plugin)
#   storyline — named lane in the storylines board   🧵  (NbWeb-cine plugin)
#   story     — card on the storylines board         🃏  (NbWeb-cine plugin)
#   actor     — cast member / talent card            🧑  (NbWeb-cine plugin)
#   location  — shooting location card               📍  (NbWeb-cine plugin)
#   day       — shoot day record (date, hours)       📅  (NbWeb-cine plugin)
#   resource  — BTL line-item resource (rate, unit)  🎁  (NbWeb-cine plugin)
_FM_TYPES = frozenset({'strip', 'shot', 'scene', 'storyline', 'story', 'actor', 'location', 'day', 'resource'})

def _apply_meta_type(itype, meta):
    fm = str(meta.get('type', '') or '').strip().lower()
    return fm if fm in _FM_TYPES else itype

def _slim_meta(meta):
    """Scalar frontmatter fields for list items (registered FM types only)."""
    skip = frozenset({'title', 'type', 'tags'})
    return {k: v for k, v in meta.items()
            if isinstance(v, (str, int, float, bool)) and k not in skip}


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
    # `notebook` param kept for API compat but no longer used for filtering —
    # we return all templates from every notebook plus global, always.
    global_dir = GLOBAL_TEMPLATES_DIR
    seen, templates = set(), []

    # Scan every notebook's .templates/ (root + subfolders)
    for nb_dir in sorted(NB_DIR.iterdir()):
        if not nb_dir.is_dir() or nb_dir.name.startswith('.') or nb_dir.name.startswith('-'):
            continue
        nb_name = nb_dir.name
        tmpl_dirs = []
        if (nb_dir / '.templates').is_dir():
            tmpl_dirs.append((nb_dir / '.templates', ''))
        for sub in sorted(nb_dir.rglob('.templates')):
            if sub == nb_dir / '.templates' or not sub.is_dir():
                continue
            rel = sub.parent.relative_to(nb_dir)
            tmpl_dirs.append((sub, str(rel)))

        for tdir, subfolder in tmpl_dirs:
            for f in sorted(tdir.glob('*.md')):
                if f.name.startswith('.'):
                    continue
                key = f'{nb_name}/{subfolder}/{f.stem}' if subfolder else f'{nb_name}/{f.stem}'
                if key in seen:
                    continue
                seen.add(key)
                try:
                    preview = f.read_text(errors='replace')[:200]
                except OSError:
                    preview = ''
                templates.append({
                    'name':      f.stem,
                    'path':      str(f),
                    'scope':     'local',
                    'notebook':  nb_name,
                    'subfolder': subfolder,
                    'preview':   preview,
                })

    # Global templates
    if global_dir.is_dir():
        for f in sorted(global_dir.glob('*.md')):
            if f.name.startswith('.'):
                continue
            key = f'global/{f.stem}'
            if key in seen:
                continue
            seen.add(key)
            try:
                preview = f.read_text(errors='replace')[:200]
            except OSError:
                preview = ''
            templates.append({
                'name':      f.stem,
                'path':      str(f),
                'scope':     'global',
                'notebook':  '',
                'subfolder': '',
                'preview':   preview,
            })

    # Annotation templates — .template-annotation.md anywhere in a notebook tree
    for nb_dir in sorted(NB_DIR.iterdir()):
        if not nb_dir.is_dir() or nb_dir.name.startswith('.') or nb_dir.name.startswith('-'):
            continue
        nb_name = nb_dir.name
        for f in sorted(nb_dir.rglob('.template-annotation.md')):
            rel = f.parent.relative_to(nb_dir)
            subfolder = str(rel) if str(rel) != '.' else ''
            key = f'{nb_name}/{subfolder}/.template-annotation' if subfolder else f'{nb_name}/.template-annotation'
            if key in seen:
                continue
            seen.add(key)
            try:
                preview = f.read_text(errors='replace')[:200]
            except OSError:
                preview = ''
            templates.append({
                'name':          '.template-annotation',
                'path':          str(f),
                'scope':         'annotation',
                'notebook':      nb_name,
                'subfolder':     subfolder,
                'template_type': 'annotation',
                'preview':       preview,
            })

    # Export templates — one per notebook + global
    for nb_dir in sorted(NB_DIR.iterdir()):
        if not nb_dir.is_dir() or nb_dir.name.startswith('.') or nb_dir.name.startswith('-'):
            continue
        loc = nb_dir / '.export.template.html'
        if loc.exists():
            key = f'{nb_dir.name}/.export.template.html'
            if key not in seen:
                seen.add(key)
                templates.append({
                    'name':          '.export.template.html',
                    'path':          str(loc),
                    'scope':         'local',
                    'notebook':      nb_dir.name,
                    'template_type': 'export_html',
                })
    global_export = NB_DIR / '.export.template.html'
    if global_export.exists():
        key = 'global/.export.template.html'
        if key not in seen:
            seen.add(key)
            templates.append({
                'name':          '.export.template.html',
                'path':          str(global_export),
                'scope':         'global',
                'notebook':      '',
                'template_type': 'export_html',
            })

    return jsonify({'templates': templates})


@app.route('/api/templates', methods=['POST'])
def api_save_template():
    data     = request.get_json() or {}
    name     = re.sub(r'\s+', '-', re.sub(r'[^\w\s-]', '', data.get('name', '').strip()).strip())
    content  = data.get('content', '')
    scope    = data.get('scope', 'global')
    notebook = data.get('notebook', 'home')
    if scope == 'annotation':
        folder = data.get('folder', '').strip('/')
        tdir   = NB_DIR / notebook / folder if folder else NB_DIR / notebook
        tdir.mkdir(parents=True, exist_ok=True)
        tpath  = tdir / '.template-annotation.md'
        tpath.write_text(content)
        return jsonify({'success': True, 'path': str(tpath), 'scope': scope})
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
    """Return the auto-default template for a notebook (exactly one in its .templates/).
    If ?folder=items is given, check {notebook}/{folder}/.templates/ first."""
    notebook = request.args.get('notebook', '').strip()
    folder   = request.args.get('folder', '').strip().strip('/')
    if not notebook:
        return jsonify({'template': None})

    def _pick(tmpl_dir):
        if not tmpl_dir.is_dir():
            return None
        templates = sorted(
            f for f in tmpl_dir.iterdir()
            if f.is_file() and not f.name.startswith('.') and f.suffix in ('.md', '.txt', '.org')
        )
        if len(templates) == 1:
            t = templates[0]
            return {'name': t.stem, 'path': str(t)}
        return None

    if folder:
        result = _pick(NB_DIR / notebook / folder / '.templates')
        if result:
            return jsonify({'template': result, 'folder': folder})

    result = _pick(NB_DIR / notebook / '.templates')
    return jsonify({'template': result})


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
# API: HTML export templates (.export.template.html)
# ---------------------------------------------------------------------------

# Default starter template — modern grayscale + indigo accent
_EXPORT_TEMPLATE_STARTER = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{title}}</title>
  <style>
    :root {
      --text:         #1a1a1a;
      --text-muted:   #6b7280;
      --bg:           #ffffff;
      --bg-alt:       #f7f7f8;
      --border:       #e5e7eb;
      --accent:       #6366f1;
      --accent-light: #eef2ff;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      font-size: 15px;
      line-height: 1.75;
      color: var(--text);
      background: var(--bg);
      max-width: 760px;
      margin: 0 auto;
      padding: 52px 36px;
    }
    h1, h2, h3, h4, h5, h6 {
      font-weight: 600;
      line-height: 1.3;
      color: #111;
      margin: 1.8em 0 0.5em;
    }
    h1 { font-size: 2em;   border-bottom: 2px solid var(--accent); padding-bottom: 0.3em; }
    h2 { font-size: 1.4em; color: #222; }
    h3 { font-size: 1.15em; }
    h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
    p { margin: 0.8em 0; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    strong { font-weight: 600; }
    em     { font-style: italic; }
    code {
      font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
      font-size: 0.875em;
      background: var(--bg-alt);
      border: 1px solid var(--border);
      padding: 1px 5px;
      border-radius: 4px;
    }
    pre {
      background: var(--bg-alt);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      padding: 14px 18px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 1em 0;
    }
    pre code { background: none; border: none; padding: 0; font-size: 0.9em; }
    blockquote {
      margin: 1em 0;
      padding: 0.6em 1.2em;
      border-left: 3px solid var(--accent);
      background: var(--accent-light);
      color: var(--text-muted);
      border-radius: 0 6px 6px 0;
    }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.93em; }
    th {
      background: var(--accent);
      color: #fff;
      padding: 8px 14px;
      text-align: left;
      font-weight: 600;
    }
    td { border-bottom: 1px solid var(--border); padding: 8px 14px; }
    tr:nth-child(even) td { background: var(--bg-alt); }
    img { max-width: 100%; border-radius: 6px; display: block; margin: 1em 0; }
    hr  { border: none; border-top: 1px solid var(--border); margin: 2em 0; }
    ul, ol { padding-left: 1.5em; margin: 0.6em 0; }
    li { margin: 0.25em 0; }
    /* nb codeblock headers */
    .nb-hl-header, .nb-tw-block > *:first-child {
      font-size: 0.78em; color: var(--text-muted); margin-bottom: 4px;
    }
    @media print {
      body { padding: 0; max-width: none; }
      a { color: inherit; }
      pre { border-left-color: #888; }
      h1  { border-bottom-color: #888; }
    }
  </style>
</head>
<body>
{{content}}
</body>
</html>
"""


def _find_export_template(notebook: str = '') -> str | None:
    """Return .export.template.html content; notebook-level overrides global."""
    if notebook:
        local = NB_DIR / notebook / '.export.template.html'
        if local.exists():
            return local.read_text(errors='replace')
    global_ = NB_DIR / '.export.template.html'
    if global_.exists():
        return global_.read_text(errors='replace')
    return None


@app.route('/api/export-template', methods=['POST'])
def api_create_export_template():
    """Create a starter .export.template.html at global or notebook scope."""
    data     = request.get_json() or {}
    scope    = data.get('scope', 'global')
    notebook = data.get('notebook', '').strip()
    dest = (NB_DIR / notebook / '.export.template.html'
            if scope == 'local' and notebook
            else NB_DIR / '.export.template.html')
    if dest.exists():
        return jsonify({'error': 'already exists', 'path': str(dest)}), 409
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(_EXPORT_TEMPLATE_STARTER, encoding='utf-8')
    return jsonify({'success': True, 'path': str(dest)})


# ---------------------------------------------------------------------------
# API: Serve raw file (images, audio, video, PDF …)
# ---------------------------------------------------------------------------

def _resolve_to_nb_path(selector):
    """Return Path within NB_DIR for selector, or None on error/traversal."""
    path_r = run_nb('show', selector, '--path')
    if nb_ok(path_r):
        p = Path(path_r['stdout'].strip())
        try:
            p.relative_to(NB_DIR)
        except ValueError:
            return None
        return p
    # Fallback for non-indexed files (images, attachments) via direct path construction.
    # nb show won't find them but the file exists at NB_DIR/notebook/rel_path.
    if ':' in selector:
        nb_name, rel = selector.split(':', 1)
        try:
            p = (NB_DIR / nb_name / rel).resolve()
            p.relative_to(NB_DIR)  # must stay within NB_DIR
            return p if p.exists() else None
        except (ValueError, OSError):
            pass
    return None


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


@app.route('/api/render')
def api_render():
    """Server-side markdown render for large/plain notes (large: true frontmatter or >100 KB).
    Returns clean HTML without custom codeblock widgets or wikilink spans."""
    selector = request.args.get('selector', '')
    if not selector:
        return jsonify({'error': 'selector required'}), 400
    fpath = _resolve_to_nb_path(selector)
    if not fpath or not fpath.is_file():
        return jsonify({'error': 'not found'}), 404
    try:
        raw = fpath.read_text(errors='replace')
    except OSError as e:
        return jsonify({'error': str(e)}), 500
    _, body = parse_frontmatter(raw)
    try:
        import markdown as _md
        html = _md.markdown(body, extensions=['fenced_code', 'tables'])
    except Exception as e:
        return jsonify({'error': f'render failed: {e}'}), 500
    return jsonify({'html': html})


# ── Cross-reference infrastructure ───────────────────────────────────────────
_xref_cache: dict = {}  # {notebook: {'mtime': float, 'index': dict}}

_XREF_STOP = frozenset({
    'a','an','the','and','or','but','in','on','at','to','for','of',
    'with','by','from','as','is','was','are','were','be','been','being',
    'have','has','had','do','does','did','will','would','could','should',
    'may','might','shall','can','into','through','during','before',
    'after','above','below','between','each','all','both','few','more',
    'most','other','some','such','no','not','only','same','so','than',
    'too','very','just','also','that','this','these','those','its','it',
    'we','you','he','she','they','them','their','our','your','his','her',
    'what','which','who','when','where','why','how','if','then',
    'use','using','used','file','files','note','notes','see','about',
})

_STEM_RULES_XREF = [
    ('ations',''), ('ation',''), ('ings',''),  ('ing',''),
    ('ions',''),   ('ion',''),   ('ments',''), ('ment',''),
    ('ness',''),   ('ities',''), ('ity',''),   ('ies','y'),
    ('ves','f'),   ('ed',''),    ('ly',''),    ('er',''),
    ('es',''),     ('s',''),
]

def _stem_xref(word: str) -> str:
    w = re.sub(r'[^a-z0-9]', '', word.lower())
    if len(w) < 4:
        return w
    for suf, rep in _STEM_RULES_XREF:
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            return w[:-len(suf)] + rep
    return w

def _build_xref_index(scan_dir: Path, notebook: str) -> dict:
    """Build inverted index: stem → [{selector, title}] from titles + annotation free text."""
    index: dict = {}
    for fpath in sorted(scan_dir.glob('*.md')):
        if fpath.name.startswith('.'):
            continue
        try:
            raw = fpath.read_text(errors='replace')
        except OSError:
            continue
        meta, body = parse_frontmatter(raw)
        title = meta.get('title') or note_title(fpath.name, body)
        if not title:
            continue
        sel   = f'{notebook}:{fpath.relative_to(NB_DIR / notebook)}'
        entry = {'selector': sel, 'title': title}
        texts = [title]
        ann   = _annotation_path(str(fpath))
        if ann.exists():
            try:
                texts.append(ann.read_text(errors='replace'))
            except OSError:
                pass
        stems_seen: set = set()
        for text in texts:
            for word in re.findall(r'[a-zA-Z][a-zA-Z0-9-]*', text):
                stem = _stem_xref(word)
                if not stem or len(stem) < 3 or stem in _XREF_STOP or stem in stems_seen:
                    continue
                stems_seen.add(stem)
                index.setdefault(stem, []).append(entry)
    return index


@app.route('/api/xref')
def api_xref():
    """Cross-reference lookup: for a set of stems, return matching notes in a target.
    target param: 'hledger:' (whole notebook) or 'accts:tutorial/' (folder).
    Uses prefix matching (min 5 chars) for fuzzy plural/conjugation handling."""
    target    = request.args.get('target', '').strip()
    stems_raw = request.args.get('stems', '').strip()
    if not target or not stems_raw:
        return jsonify({'error': 'target and stems required'}), 400
    # Parse "notebook:" or "notebook:folder/" or "notebook:/folder/"
    notebook, _, folder = target.partition(':')
    notebook = notebook.strip()
    folder   = folder.strip().lstrip('/')
    nb_dir   = NB_DIR / notebook
    scan_dir = (nb_dir / folder) if folder else nb_dir
    if not scan_dir.is_dir():
        return jsonify({'error': f'target {target!r} not found'}), 404
    try:
        dir_mtime = scan_dir.stat().st_mtime
    except OSError:
        dir_mtime = 0.0
    cached = _xref_cache.get(target)
    if not cached or cached['mtime'] != dir_mtime:
        _xref_cache[target] = {'mtime': dir_mtime, 'index': _build_xref_index(scan_dir, notebook)}
    index = _xref_cache[target]['index']
    query_stems = [s for s in stems_raw.split(',') if s]
    result = {}
    for qs in query_stems:
        seen:    set  = set()
        matches: list = []
        for idx_stem, entries in index.items():
            plen = min(len(qs), len(idx_stem))
            if idx_stem == qs or (plen >= 5 and (idx_stem.startswith(qs) or qs.startswith(idx_stem))):
                for e in entries:
                    if e['selector'] not in seen:
                        seen.add(e['selector'])
                        matches.append(e)
        if matches:
            result[qs] = matches
    return jsonify(result)


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
    if not uuid or not re.match(r'^[a-f0-9\-]{8,}$', uuid):
        return jsonify({'output': '', 'success': False}), 400
    try:
        result = subprocess.run(
            ['task', f'uuid.startswith:{uuid}', 'information'],
            capture_output=True, text=True,
            env={**os.environ, 'NO_COLOR': '1', 'TERM': 'dumb'},
        )
        output = strip_ansi(result.stdout.strip()) if result.returncode == 0 else ''
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
        tw_cmd      = _settings.get('tw_web_cmd', '').strip()
        tw_terminal = _settings.get('tw_terminal', False)
        if tw_cmd and tw_terminal:
            tw_extra = {'twTerminalMode': True, 'twLaunchCmd': tw_cmd}
        elif tw_cmd:
            tw_h, tw_p = _parse_web_host_port(tw_cmd, 3000)
            tw_extra = {'twWebUrl': f'http://{tw_h}:{tw_p}'}
        else:
            tw_extra = {}
        return jsonify({'tasks': tasks, **tw_extra})
    except FileNotFoundError:
        return jsonify({'error': 'taskwarrior not found'}), 500
    except (json.JSONDecodeError, subprocess.TimeoutExpired) as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/task-action', methods=['POST'])
def api_task_action():
    """Perform a single-task action: done, start, or stop."""
    if not _cb_write_allowed('tw'):
        return jsonify({'error': 'Write access denied'}), 403
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


@app.route('/api/task-add', methods=['POST'])
def api_task_add():
    """Add a new task."""
    if not _cb_write_allowed('tw'):
        return jsonify({'error': 'Write access denied'}), 403
    data = request.get_json(silent=True) or {}
    desc = data.get('description', '').strip()
    if not desc:
        return jsonify({'error': 'description required'}), 400
    cmd = ['task', 'rc.confirmation=no', 'add', desc]
    if data.get('project'):
        cmd.append(f'project:{data["project"].strip()}')
    date_field = data.get('date_field', 'due').strip()
    date_value = data.get('date_value', '').strip()
    if date_value and date_field in ('due', 'scheduled', 'wait', 'until'):
        cmd.append(f'{date_field}:{date_value}')
    if data.get('priority'):
        cmd.append(f'priority:{data["priority"].strip()}')
    import re as _re
    for tag in _re.split(r'[\s,]+', data.get('tags') or ''):
        t = tag.strip().lstrip('+')
        if t:
            cmd.append(f'+{t}')
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True,
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
    'check','payees','notes','activity',
    'roi',
}

# Commands that produce plain text only — never append --output-format json.
_HLEDGER_TEXT_CMDS = {'check', 'stats', 'tags', 'commodities', 'files',
                      'accounts', 'acc', 'a', 'prices', 'payees', 'notes',
                      'activity'}

# Cache: (args_tuple, journal_mtime) → (stdout, stderr, returncode)
# Keyed on full arg list so different queries never collide.
# Invalidated automatically when journal mtime changes (e.g. after adding a transaction).
_hledger_cache: dict = {}

def _hledger_cached_run(cmd_args, journal_path=None):
    """Run hledger subprocess with mtime-keyed cache. Returns (stdout, stderr, returncode)."""
    mtime = 0.0
    if journal_path:
        try:
            mtime = journal_path.stat().st_mtime
        except OSError:
            pass

    key = (tuple(cmd_args), mtime)
    if key in _hledger_cache:
        return _hledger_cache[key]

    # Evict if cache grows large (shouldn't happen in practice — queries are finite)
    if len(_hledger_cache) > 500:
        _hledger_cache.clear()

    r = subprocess.run(
        ['hledger'] + list(cmd_args),
        capture_output=True, text=True,
        env={**os.environ, 'NO_COLOR': '1', 'TERM': 'dumb'},
        timeout=15,
    )
    _hledger_cache[key] = (r.stdout, r.stderr.strip(), r.returncode)
    return _hledger_cache[key]


def _hledger_resolve_file(path_str):
    """Resolve and validate a ledger file path; returns Path or raises ValueError."""
    resolved = Path(os.path.expanduser(path_str)).resolve()
    if not resolved.is_relative_to(Path.home()):
        raise ValueError('File path must be within home directory')
    return resolved


def _iq_strip(text):
    """Strip hledger output to inline-friendly plain text.
    Removes separator lines (----, ====), blank lines; joins with ' · '."""
    lines = []
    for ln in text.splitlines():
        s = ln.strip()
        if not s or re.match(r'^[-=]+$', s):
            continue
        lines.append(s)
    return ' · '.join(lines) if lines else ''


@app.route('/api/inline-query')
def api_inline_query():
    """Resolve a {{provider: query}} inline query; returns {result} or {error}."""
    provider = request.args.get('provider', '').strip().lower()
    query    = request.args.get('query',    '').strip()
    notebook = request.args.get('notebook', '').strip()

    if not provider or not query:
        return jsonify({'error': 'provider and query required'}), 400

    try:
        if provider == 'hledger':
            config  = _hledger_config_for_notebook(notebook)
            journal = _hledger_journal_path(config)
            if not journal or not journal.exists():
                return jsonify({'error': 'journal not found'}), 404
            args = shlex.split(query)
            if not args or args[0] not in (_HLEDGER_READ_CMDS | _HLEDGER_TEXT_CMDS):
                return jsonify({'error': f'hledger command not allowed: {args[0] if args else ""}'}), 400
            stdout, stderr, returncode = _hledger_cached_run(
                ['-f', str(journal)] + args, journal_path=journal
            )
            if returncode != 0:
                return jsonify({'error': stderr or 'hledger error'}), 500
            resp = {'result': _iq_strip(stdout)}
            regen = config.get('regen_script', '').strip()
            if regen and notebook:
                resp['regen'] = {'notebook': notebook, 'script': regen}
            return jsonify(resp)

        elif provider == 'tw':
            safe_cmds = {'count', 'ids', 'uuids'}
            args = shlex.split(query)
            if not args:
                return jsonify({'error': 'empty tw query'}), 400
            # bare filter with no subcommand → treat as count
            if args[0] not in safe_cmds:
                args = args + ['count']
            r = subprocess.run(
                ['task'] + args,
                capture_output=True, text=True, timeout=5,
                env={**os.environ, 'NO_COLOR': '1'},
            )
            return jsonify({'result': r.stdout.strip()})

        elif provider == 'nb':
            safe_cmds = {'count', 'list', 'notebooks', 'show'}
            args = shlex.split(query)
            if not args or args[0] not in safe_cmds:
                return jsonify({'error': f'nb command not allowed: {args[0] if args else ""}'}), 400
            r = run_nb(*args)
            if not nb_ok(r):
                return jsonify({'error': r['stderr'].strip() or 'nb error'}), 500
            return jsonify({'result': r['stdout'].strip()})

        elif provider == 'date':
            fmt = query.strip() or '%Y-%m-%d'
            from datetime import datetime
            return jsonify({'result': datetime.now().strftime(fmt)})

        else:
            return jsonify({'error': f'unknown provider: {provider}'}), 400

    except subprocess.TimeoutExpired:
        return jsonify({'error': f'{provider} timed out'}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/hledger-query')
def api_hledger_query():
    """Run a read-only hledger report and return JSON or plain text."""
    q        = request.args.get('q', '').strip()
    notebook = request.args.get('notebook', '').strip()
    args = shlex.split(q) if q else ['balance']

    # Positional file path: first token starting with ~ or / is the ledger file.
    file_path = None
    if args and (args[0].startswith('~') or args[0].startswith('/')):
        try:
            file_path = _hledger_resolve_file(args[0])
        except ValueError as e:
            return jsonify({'error': str(e)}), 403
        args = args[1:] or ['balance']

    # Notebook-scoped default: use .nb-hledger.json journal when no explicit file.
    if not file_path and notebook:
        cfg = _hledger_config_for_notebook(notebook)
        file_path = _hledger_journal_path(cfg) or file_path

    cmd = args[0].lower()
    if cmd not in _HLEDGER_READ_CMDS:
        return jsonify({'error': f'Command not allowed: {args[0]}'}), 400

    # Expand ~ in -f / --file args so codeblocks can reference home-dir paths.
    expanded = [args[0]]
    i = 1
    while i < len(args):
        a = args[i]
        if a in ('-f', '--file') and i + 1 < len(args):
            try:
                resolved = _hledger_resolve_file(args[i + 1])
            except ValueError as e:
                return jsonify({'error': str(e)}), 403
            expanded.append(a)
            expanded.append(str(resolved))
            i += 2
        elif a.startswith('--file='):
            try:
                resolved = _hledger_resolve_file(a[7:])
            except ValueError as e:
                return jsonify({'error': str(e)}), 403
            expanded.append(f'--file={resolved}')
            i += 1
        else:
            expanded.append(a)
            i += 1

    # Inject positional file path as -f (before other args, after command).
    if file_path:
        expanded = [expanded[0], '-f', str(file_path)] + expanded[1:]

    use_json_fmt = cmd not in _HLEDGER_TEXT_CMDS and request.args.get('format') != 'text'
    final_args = expanded + (['--output-format', 'json'] if use_json_fmt else [])
    # Derive journal path for cache invalidation from -f flag or positional file_path
    cache_journal = file_path
    if not cache_journal:
        for i, a in enumerate(expanded):
            if a in ('-f', '--file') and i + 1 < len(expanded):
                cache_journal = Path(expanded[i + 1])
                break
    try:
        stdout, stderr, returncode = _hledger_cached_run(final_args, cache_journal)
        if returncode != 0:
            return jsonify({'error': stderr or 'hledger error'}), 500
        _hl_cmd      = _settings.get('hledger_web_cmd', '').strip()
        _hl_terminal = _settings.get('hledger_terminal', False)
        if _hl_cmd and _hl_terminal:
            extra = {'terminalMode': True, 'launchCmd': _hl_cmd}
        elif _hl_cmd:
            _hl_h, _hl_p = _hledger_web_parse_host_port(_hl_cmd)
            web_url = os.environ.get('HLEDGER_WEB_URL', '').rstrip('/') or f'http://{_hl_h}:{_hl_p}'
            extra = {'webUrl': web_url}
        else:
            extra = {}
        if file_path:
            extra['file'] = str(file_path)
        # Always report which journal was used + nb selector if inside NB_DIR
        _jpath = file_path or Path('~/.hledger.journal').expanduser()
        extra['journal'] = str(_jpath)
        try:
            _jrel  = Path(_jpath).resolve().relative_to(NB_DIR)
            extra['journalSelector'] = _jrel.parts[0] + ':' + '/'.join(_jrel.parts[1:])
        except ValueError:
            extra['journalSelector'] = None
        try:
            data = json.loads(stdout or 'null')
            return jsonify({'cmd': cmd, 'data': data, **extra})
        except json.JSONDecodeError:
            return jsonify({'cmd': cmd, 'text': stdout.strip(), **extra})
    except FileNotFoundError:
        return jsonify({'error': 'hledger not found — is it installed?'}), 500
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'hledger timed out'}), 500


def _parse_web_host_port(cmd_str, default_port=5000):
    """Return (host, port) from a web-server launch command string."""
    try:
        tokens = shlex.split(cmd_str)
    except ValueError:
        tokens = cmd_str.split()
    host, port = 'localhost', default_port
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t == '--port' and i + 1 < len(tokens):
            try: port = int(tokens[i + 1]); i += 1
            except ValueError: pass
        elif t.startswith('--port='):
            try: port = int(t.split('=', 1)[1])
            except ValueError: pass
        elif t == '--host' and i + 1 < len(tokens):
            host = tokens[i + 1]; i += 1
        elif t.startswith('--host='):
            host = t.split('=', 1)[1]
        i += 1
    return host, port

def _hledger_web_parse_host_port(cmd_str):
    return _parse_web_host_port(cmd_str, default_port=5000)


@app.route('/api/hledger/regen', methods=['POST'])
def api_hledger_regen():
    """Run a .tools/*.py script in a notebook to regenerate a derived journal."""
    if not _cb_write_allowed('hledger'):
        return jsonify({'error': 'hledger write not permitted'}), 403
    data     = request.get_json() or {}
    notebook = data.get('notebook', '').strip()
    script   = data.get('script', '').strip()

    if not notebook or not script:
        return jsonify({'error': 'notebook and script required'}), 400

    # Script must live inside .tools/ and be a .py file — no path traversal.
    script_path = Path(script)
    if script_path.parent.name != '.tools' or script_path.suffix != '.py':
        return jsonify({'error': 'script must be a .tools/*.py file'}), 400

    nb_path     = NB_DIR / notebook
    full_script = nb_path / script_path
    if not full_script.exists():
        return jsonify({'error': f'{script} not found in {notebook}'}), 404

    try:
        _hledger_cache.clear()   # clear before run so stale entries can't be served
        r = subprocess.run(
            ['python3', str(full_script)],
            capture_output=True, text=True, timeout=30
        )
        if r.returncode != 0:
            return jsonify({'error': r.stderr.strip() or 'script error'}), 500
        _hledger_cache.clear()   # clear again after run to drop any entries added during script
        return jsonify({'message': r.stdout.strip().splitlines()[-1] if r.stdout.strip() else 'done'})
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'script timed out'}), 500


@app.route('/api/hledger/launch', methods=['POST'])
def api_hledger_launch():
    """Start hledger-web if not running, return its URL."""
    cmd_str = _settings.get('hledger_web_cmd', '').strip()
    if not cmd_str:
        return jsonify({'error': 'hledger_web_cmd not configured'}), 400

    host, port = _hledger_web_parse_host_port(cmd_str)
    url = f'http://{host}:{port}'

    def _is_up():
        with socket.socket() as s:
            s.settimeout(0.3)
            return s.connect_ex((host, port)) == 0

    if not _is_up():
        try:
            tokens = shlex.split(cmd_str)
        except ValueError:
            tokens = cmd_str.split()
        subprocess.Popen(tokens, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 6
        while time.time() < deadline:
            time.sleep(0.25)
            if _is_up():
                break

    return jsonify({'url': url})


@app.route('/api/tw/launch', methods=['POST'])
def api_tw_launch():
    """Start tw-web if not running, return its URL."""
    cmd_str = _settings.get('tw_web_cmd', '').strip()
    if not cmd_str:
        return jsonify({'error': 'tw_web_cmd not configured'}), 400

    host, port = _parse_web_host_port(cmd_str, default_port=3000)
    url = f'http://{host}:{port}'

    def _is_up():
        with socket.socket() as s:
            s.settimeout(0.3)
            return s.connect_ex((host, port)) == 0

    if not _is_up():
        try:
            tokens = shlex.split(cmd_str)
        except ValueError:
            tokens = cmd_str.split()
        subprocess.Popen(tokens, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 6
        while time.time() < deadline:
            time.sleep(0.25)
            if _is_up():
                break

    return jsonify({'url': url})


@app.route('/api/hledger-add', methods=['POST'])
def api_hledger_add():
    """Append a new transaction to the ledger file; validates and rolls back on error."""
    if not _cb_write_allowed('hledger'):
        return jsonify({'error': 'Write access denied'}), 403
    data      = request.get_json(silent=True) or {}
    date      = data.get('date', '').strip()
    desc      = data.get('description', '').strip()
    postings  = [p for p in data.get('postings', [])
                 if str(p.get('account', '')).strip()]

    if not date or not desc:
        return jsonify({'error': 'Date and description are required'}), 400
    if not postings:
        return jsonify({'error': 'At least one posting is required'}), 400

    # File resolution priority: codeblock path > LEDGER_FILE env > hledger default.
    file_param = data.get('file', '').strip()
    if file_param:
        try:
            ledger_path = _hledger_resolve_file(file_param)
        except ValueError as e:
            return jsonify({'error': str(e)}), 403
    else:
        ledger_env = os.environ.get('LEDGER_FILE', '')
        ledger_path = Path(os.path.expanduser(ledger_env)) if ledger_env \
                      else Path.home() / '.hledger.journal'
    if not ledger_path.exists():
        return jsonify({'error': f'Ledger file not found: {ledger_path}'}), 400

    comment = data.get('comment', '').strip()

    # Build journal entry text
    desc_line = f'{date} {desc}'
    if comment:
        desc_line += f'  ; {comment}'
    lines = [desc_line]
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


def _hledger_notebook_path(notebook):
    """Return Path to notebook dir, or None if invalid."""
    if not notebook or '/' in notebook or notebook.startswith('.'):
        return None
    p = Path.home() / '.nb' / notebook
    return p if p.is_dir() else None


def _hledger_config_for_notebook(notebook):
    """Return parsed .nb-hledger.json for notebook, or None."""
    nb_path = _hledger_notebook_path(notebook)
    if not nb_path:
        return None
    cfg_file = nb_path / '.nb-hledger.json'
    if not cfg_file.exists():
        return None
    try:
        return json.loads(cfg_file.read_text())
    except Exception:
        return None


def _hledger_journal_path(config):
    """Resolve the journal path from a hledger config dict."""
    journal = (config or {}).get('journal', '')
    if not journal:
        env = os.environ.get('LEDGER_FILE', '')
        journal = env if env else str(Path.home() / '.hledger.journal')
    try:
        return _hledger_resolve_file(journal)
    except ValueError:
        return None


@app.route('/api/hledger/config')
def api_hledger_config():
    """Return .nb-hledger.json for a notebook, plus resolved journal path."""
    notebook = request.args.get('notebook', '').strip()
    config   = _hledger_config_for_notebook(notebook)
    if config is None:
        return jsonify({'error': 'No hledger config found for notebook'}), 404
    journal_path = _hledger_journal_path(config)
    return jsonify({
        'config':     config,
        'journal':    str(journal_path) if journal_path else None,
        'journal_ok': journal_path is not None and journal_path.exists(),
    })


@app.route('/api/hledger/resolve-include')
def api_hledger_resolve_include():
    """Resolve an hledger include path relative to the current journal note.

    Returns {selector, exists} where selector is an nb selector string if the
    target file lives inside NB_DIR, or null if it's outside (e.g. absolute
    path to a system file).
    """
    selector = request.args.get('selector', '').strip()
    inc_path = request.args.get('path', '').strip()
    if not selector or not inc_path:
        return jsonify({'selector': None, 'exists': False})

    base_path = _resolve_to_nb_path(selector)
    if not base_path:
        return jsonify({'selector': None, 'exists': False})

    try:
        resolved = (base_path.parent / Path(inc_path).expanduser()).resolve()
        resolved.relative_to(NB_DIR)   # guard — must stay inside NB_DIR
    except (ValueError, OSError):
        return jsonify({'selector': None, 'exists': resolved.exists() if 'resolved' in dir() else False})

    parts = resolved.relative_to(NB_DIR).parts   # e.g. ('accts', 'accounts.journal')
    nb_sel = parts[0] + ':' + '/'.join(parts[1:])
    return jsonify({'selector': nb_sel, 'exists': resolved.exists()})


@app.route('/api/hledger/path-selector')
def api_hledger_path_selector():
    """Convert an absolute filesystem path to an nb selector if it lives inside NB_DIR."""
    path = request.args.get('path', '').strip()
    if not path:
        return jsonify({'selector': None, 'exists': False})
    try:
        p = Path(path).expanduser().resolve()
        rel = p.relative_to(NB_DIR)
        sel = rel.parts[0] + ':' + '/'.join(rel.parts[1:])
        return jsonify({'selector': sel, 'exists': p.exists()})
    except (ValueError, OSError):
        return jsonify({'selector': None, 'exists': Path(path).expanduser().exists()})


@app.route('/api/fs/list')
def api_fs_list():
    """List a directory that is inside NB_DIR (including hidden dirs like .test)."""
    path = request.args.get('path', '').strip()
    if not path:
        return jsonify({'error': 'no path'}), 400
    p = Path(path).expanduser().resolve()
    try:
        rel = p.relative_to(NB_DIR)
    except ValueError:
        return jsonify({'error': 'path outside NB_DIR'}), 403
    # Gate by destination — same logic as notebook/note access elsewhere
    parts = rel.parts
    user = session.get('user', {})
    if parts:
        top = parts[0]
        if top.startswith('.'):
            # Dotfolder: open set is world-readable; everything else is admin+
            if top not in _DOT_OPEN and not _level_gte(user.get('level', ''), 'admin'):
                return jsonify({'error': 'forbidden'}), 403
        elif _safe_notebook(top):
            # Regular notebook: check notebook config access:
            nb_meta = _notebook_config(top)
            required = str(nb_meta.get('access') or 'user')
            if not _level_gte(user.get('level', ''), required):
                return jsonify({'error': 'forbidden'}), 403
    if not p.is_dir():
        return jsonify({'error': 'not a directory'}), 404
    entries = sorted(
        [{'name': c.name, 'isDir': c.is_dir(), 'path': str(c)} for c in p.iterdir()],
        key=lambda e: (not e['isDir'], e['name'].lower()),
    )
    return jsonify({'entries': entries, 'path': str(p)})


@app.route('/api/hledger/accounts')
def api_hledger_accounts():
    """Return all account names from the notebook's journal (for autocomplete)."""
    notebook = request.args.get('notebook', '').strip()
    config   = _hledger_config_for_notebook(notebook)
    journal  = _hledger_journal_path(config)
    if not journal or not journal.exists():
        return jsonify({'accounts': []})
    try:
        result = subprocess.run(
            ['hledger', '-f', str(journal), 'accounts', '--flat'],
            capture_output=True, text=True, timeout=10,
            env={**os.environ, 'NO_COLOR': '1'},
        )
        accounts = [l.strip() for l in result.stdout.splitlines() if l.strip()]
        return jsonify({'accounts': accounts})
    except Exception as e:
        return jsonify({'error': str(e), 'accounts': []}), 500


_HLEDGER_TYPE_MAP = {'asset': 'A', 'liability': 'L', 'equity': 'E', 'income': 'R', 'expense': 'X'}


@app.route('/api/hledger/coa-generate', methods=['POST'])
def api_hledger_coa_generate():
    """Write accounts.journal next to the main journal from a provided account list."""
    data     = request.get_json(silent=True) or {}
    notebook = data.get('notebook', '').strip()
    accounts = data.get('accounts', [])   # [{account, type, desc, cra_t1, cra_t2125}]
    header   = data.get('header', '')

    if not notebook or not accounts:
        return jsonify({'error': 'notebook and accounts are required'}), 400

    config       = _hledger_config_for_notebook(notebook)
    journal_path = _hledger_journal_path(config)
    if not journal_path:
        return jsonify({'error': 'Could not resolve journal path'}), 400

    out_path = journal_path.parent / 'accounts.journal'
    lines = []
    if header:
        for line in header.splitlines():
            lines.append(f'; {line}' if line.strip() else ';')
        lines.append('')

    for entry in accounts:
        name = str(entry.get('account', '')).strip()
        if not name:
            continue
        acc_type  = str(entry.get('type', '')).strip().lower()
        desc = str(entry.get('desc', '')).strip()
        cra  = str(entry.get('cra_t1', '') or entry.get('cra_t2125', '')).strip()
        comment_parts = []
        if desc: comment_parts.append(desc)
        if cra:  comment_parts.append(f'CRA line {cra}')
        if comment_parts:
            lines.append(f'; {" — ".join(comment_parts)}')
        type_code  = _HLEDGER_TYPE_MAP.get(acc_type, '')
        is_toplevel = ':' not in name
        if type_code and is_toplevel:
            lines.append(f'account {name}  ; type:{type_code}')
        else:
            lines.append(f'account {name}')
        lines.append('')

    try:
        out_path.write_text('\n'.join(lines))
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    include_needed = True
    if journal_path.exists():
        if 'accounts.journal' in journal_path.read_text(errors='replace'):
            include_needed = False

    return jsonify({
        'ok':             True,
        'path':           str(out_path),
        'include_needed': include_needed,
        'include_line':   f'include {out_path.name}',
    })


@app.route('/api/hledger/aliases', methods=['GET'])
def api_hledger_aliases_get():
    """Return parsed alias directives from aliases.journal."""
    notebook = request.args.get('notebook', '').strip()
    if not notebook:
        return jsonify({'error': 'notebook required'}), 400
    config       = _hledger_config_for_notebook(notebook)
    journal_path = _hledger_journal_path(config)
    if not journal_path:
        return jsonify({'error': 'Could not resolve journal path'}), 400

    aliases_path = journal_path.parent / 'aliases.journal'
    aliases = []
    if aliases_path.exists():
        for line in aliases_path.read_text(errors='replace').splitlines():
            stripped = line.strip()
            if stripped.startswith('alias ') and '=' in stripped:
                rest = stripped[6:].strip()
                parts = rest.split('=', 1)
                aliases.append({'pattern': parts[0].strip(), 'account': parts[1].strip()})

    include_needed = True
    if journal_path.exists():
        if 'aliases.journal' in journal_path.read_text(errors='replace'):
            include_needed = False

    return jsonify({
        'aliases':        aliases,
        'path':           str(aliases_path),
        'include_needed': include_needed,
        'include_line':   'include aliases.journal',
    })


@app.route('/api/hledger/aliases', methods=['POST'])
def api_hledger_aliases_set():
    """Write alias directives to aliases.journal."""
    data     = request.get_json(silent=True) or {}
    notebook = data.get('notebook', '').strip()
    aliases  = data.get('aliases', [])   # [{pattern, account}]

    if not notebook:
        return jsonify({'error': 'notebook required'}), 400
    config       = _hledger_config_for_notebook(notebook)
    journal_path = _hledger_journal_path(config)
    if not journal_path:
        return jsonify({'error': 'Could not resolve journal path'}), 400

    aliases_path = journal_path.parent / 'aliases.journal'
    lines = ['; aliases.journal — payee / account pattern mappings for CSV import', '']
    for entry in aliases:
        pattern = str(entry.get('pattern', '')).strip()
        account = str(entry.get('account', '')).strip()
        if pattern and account:
            lines.append(f'alias {pattern} = {account}')
    lines.append('')

    try:
        aliases_path.write_text('\n'.join(lines))
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    include_needed = True
    if journal_path.exists():
        if 'aliases.journal' in journal_path.read_text(errors='replace'):
            include_needed = False

    return jsonify({
        'ok':             True,
        'path':           str(aliases_path),
        'include_needed': include_needed,
        'include_line':   'include aliases.journal',
    })


# ---------------------------------------------------------------------------
# API: t timeclock (time tracking)
# ---------------------------------------------------------------------------

def _t_tc_file() -> Path:
    """Return Path to the active timeclock file (from timelog.rc config)."""
    rc = Path.home() / '.task/config/timelog.rc'
    default = Path.home() / '.task/time/tw.timeclock'
    if not rc.exists():
        return default
    for line in rc.read_text().splitlines():
        if line.startswith('timelog.file'):
            val = line.split('=', 1)[1].strip()
            return Path(os.path.expanduser(val))
    return default


def _t_parse_status(tc_file: Path) -> dict:
    """Read timeclock file and return current state dict."""
    if not tc_file.exists():
        return {'state': 'none'}
    last_i = last_o = last_kind = None
    for line in tc_file.read_text().splitlines():
        if line.startswith('i '):
            last_i = line; last_kind = 'i'
        elif line.startswith('o '):
            last_o = line; last_kind = 'o'
    if last_kind is None:
        return {'state': 'none'}

    parts_i = (last_i or '').split()
    account = parts_i[3] if len(parts_i) > 3 else ''
    raw_desc = ' '.join(parts_i[4:]) if len(parts_i) > 4 else ''
    desc = raw_desc.split(';')[0].strip()

    if last_kind == 'i':
        try:
            dt_str = f"{parts_i[1]} {parts_i[2]}"
            start = datetime.strptime(dt_str, '%Y/%m/%d %H:%M:%S')
            elapsed = int((datetime.now() - start).total_seconds())
        except Exception:
            elapsed = 0
        return {'state': 'in', 'account': account, 'desc': desc,
                'since': parts_i[2] if len(parts_i) > 2 else '',
                'elapsed_seconds': max(0, elapsed)}
    else:
        out_parts = (last_o or '').split()
        return {'state': 'out', 'account': account,
                'last_out': out_parts[2] if len(out_parts) > 2 else ''}


def _t_parse_report(tc_file: Path, period: str) -> dict:
    """Parse timeclock entries and return seconds-by-account for the given period."""
    from datetime import datetime as _dt, date as _date, timedelta as _td
    if not tc_file.exists():
        return {'rows': [], 'total_seconds': 0}
    today = _date.today()
    if period in ('today', ''):
        cutoff = _dt(today.year, today.month, today.day)
    elif period in ('thisweek', 'week'):
        week_start = today - _td(days=today.weekday())
        cutoff = _dt(week_start.year, week_start.month, week_start.day)
    elif period in ('thismonth', 'month'):
        cutoff = _dt(today.year, today.month, 1)
    else:
        cutoff = _dt(today.year, today.month, today.day)

    by_account: dict = {}
    last_i: dict | None = None
    for line in tc_file.read_text().splitlines():
        if line.startswith('i '):
            parts = line.split()
            try:
                dt = _dt.strptime(f"{parts[1]} {parts[2]}", '%Y/%m/%d %H:%M:%S')
                last_i = {'dt': dt, 'account': parts[3] if len(parts) > 3 else 'unknown'}
            except Exception:
                last_i = None
        elif line.startswith('o ') and last_i:
            parts = line.split()
            try:
                dt_out = _dt.strptime(f"{parts[1]} {parts[2]}", '%Y/%m/%d %H:%M:%S')
                if last_i['dt'] >= cutoff or dt_out > cutoff:
                    # Clip to cutoff
                    start = max(last_i['dt'], cutoff)
                    secs  = max(0, int((dt_out - start).total_seconds()))
                    acct  = last_i['account']
                    by_account[acct] = by_account.get(acct, 0) + secs
                last_i = None
            except Exception:
                last_i = None
    # Add open entry
    if last_i and last_i['dt'] >= cutoff:
        start = max(last_i['dt'], cutoff)
        secs  = max(0, int((_dt.now() - start).total_seconds()))
        acct  = last_i['account']
        by_account[acct] = by_account.get(acct, 0) + secs

    rows = sorted([{'account': k, 'seconds': v} for k, v in by_account.items()],
                  key=lambda r: r['account'])
    return {'rows': rows, 'total_seconds': sum(r['seconds'] for r in rows)}


@app.route('/api/hledger/clear-account-notes', methods=['POST'])
def api_hledger_clear_account_notes():
    """Delete the accounts/ folder from a notebook (full rebuild target)."""
    data     = request.get_json(silent=True) or {}
    notebook = data.get('notebook', '').strip()
    if not notebook:
        return jsonify({'error': 'notebook required'}), 400
    nb_root = NB_DIR / notebook
    if not nb_root.is_dir():
        return jsonify({'error': f'notebook {notebook!r} not found'}), 404

    accounts_dir = nb_root / 'accounts'
    files = []
    if accounts_dir.is_dir():
        files = [f.name for f in accounts_dir.glob('*.md') if not f.name.startswith('.')]
        try:
            shutil.rmtree(str(accounts_dir))
        except OSError as e:
            return jsonify({'error': str(e)}), 500

    # Scrub any accounts/xxx.md entries the old buggy code left in the root .index
    root_index = nb_root / '.index'
    if root_index.exists():
        lines = root_index.read_text(errors='replace').splitlines()
        cleaned = [l for l in lines if not l.startswith('accounts/')]
        if len(cleaned) != len(lines):
            root_index.write_text('\n'.join(cleaned) + '\n')

    env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
    subprocess.run(['git', 'add', '-A'], cwd=str(nb_root), capture_output=True, env=env)
    subprocess.run(['git', 'commit', '-m', '[nb] Clear accounts/ for rebuild'],
                   cwd=str(nb_root), capture_output=True, env=env)

    return jsonify({'deleted': len(files), 'files': files})


# ---------------------------------------------------------------------------
# hledger daily-note import / export
# ---------------------------------------------------------------------------

def _parse_journal_by_date(content, date_from='', date_to=''):
    """Return {date_str: [txn_block, ...]} from hledger journal text."""
    date_re = re.compile(r'^(\d{4}[-/]\d{2}[-/]\d{2})\b')
    result  = {}
    for block in re.split(r'\n\s*\n', content):
        block = block.strip()
        if not block:
            continue
        m = date_re.match(block.split('\n')[0])
        if not m:
            continue
        ds = m.group(1).replace('/', '-')
        if date_from and ds < date_from:
            continue
        if date_to and ds > date_to:
            continue
        result.setdefault(ds, []).append(block)
    return result


@app.route('/api/hledger/export-daily', methods=['POST'])
def api_hledger_export_daily():
    """Extract hledger blocks from daily notes → journal file.

    Scans both flat YYYYMMDD.md (nb daily convention) and hierarchical
    YYYY-MM/YYYY-MM-DD.md (obsidian_hledger convention) layouts.
    """
    data      = request.get_json(silent=True) or {}
    notebook  = data.get('notebook', '').strip()
    date_from = data.get('from', '')
    date_to   = data.get('to', '')
    output    = data.get('output', '').strip()
    if not notebook:
        return jsonify({'error': 'notebook required'}), 400
    nb_path = NB_DIR / notebook
    if not nb_path.is_dir():
        return jsonify({'error': f'notebook {notebook!r} not found'}), 404

    fence_re = re.compile(r'```hledger\n(.*?)```', re.DOTALL)
    blocks   = []
    for fpath in sorted(nb_path.rglob('*.md')):
        stem = fpath.stem
        if re.match(r'^\d{8}$', stem):
            ds = f'{stem[:4]}-{stem[4:6]}-{stem[6:]}'
        elif re.match(r'^\d{4}-\d{2}-\d{2}$', stem):
            ds = stem
        else:
            continue
        if date_from and ds < date_from:
            continue
        if date_to and ds > date_to:
            continue
        _, body = parse_frontmatter(fpath.read_text(errors='replace'))
        for blk in fence_re.findall(body):
            stripped = blk.strip()
            if stripped:
                blocks.append(stripped)

    content = '\n\n'.join(blocks) + ('\n' if blocks else '')
    if output:
        try:
            out_path = Path(os.path.expanduser(output))
            out_path.parent.mkdir(parents=True, exist_ok=True)
            if out_path.exists():
                base, ext = out_path.stem, out_path.suffix
                i = 1
                while out_path.exists():
                    out_path = out_path.with_name(f'{base}_{i}{ext}')
                    i += 1
            out_path.write_text(content)
        except OSError as e:
            return jsonify({'error': str(e)}), 500
        return jsonify({'ok': True, 'path': str(out_path), 'blocks': len(blocks)})
    return jsonify({'ok': True, 'content': content, 'blocks': len(blocks)})


@app.route('/api/hledger/import-daily', methods=['POST'])
def api_hledger_import_daily():
    """Import hledger journal transactions into YYYYMMDD.md daily notes."""
    data      = request.get_json(silent=True) or {}
    notebook  = data.get('notebook', '').strip()
    file_path = data.get('file', '').strip()
    date_from = data.get('from', '')
    date_to   = data.get('to', '')
    if not notebook:
        return jsonify({'error': 'notebook required'}), 400
    if not file_path:
        return jsonify({'error': 'file required'}), 400
    nb_path = NB_DIR / notebook
    if not nb_path.is_dir():
        return jsonify({'error': f'notebook {notebook!r} not found'}), 404
    try:
        jpath = Path(os.path.expanduser(file_path))
        if not jpath.exists():
            return jsonify({'error': f'file not found: {file_path}'}), 404
        journal_text = jpath.read_text(errors='replace')
    except OSError as e:
        return jsonify({'error': str(e)}), 400

    txns    = _parse_journal_by_date(journal_text, date_from, date_to)
    created = updated = 0
    errors  = []
    _fence_re = re.compile(r'(```hledger\n)(.*?)(```)', re.DOTALL)
    for ds, blocks in sorted(txns.items()):
        stem      = ds.replace('-', '')
        note_path = nb_path / f'{stem}.md'
        new_txns  = '\n\n'.join(blocks)
        try:
            if note_path.exists():
                existing = note_path.read_text(errors='replace')
                m = _fence_re.search(existing)
                if m:
                    inner = m.group(2).rstrip('\n')
                    new_inner = inner + ('\n\n' if inner else '') + new_txns
                    note_path.write_text(
                        existing[:m.start()] + f'```hledger\n{new_inner}\n```' + existing[m.end():]
                    )
                else:
                    note_path.write_text(existing.rstrip() + '\n\n```hledger\n' + new_txns + '\n```\n')
                updated += 1
            else:
                note_path.write_text(f'---\ntitle: "{ds}"\ntype: note\n---\n\n# {ds}\n\n```hledger\n{new_txns}\n```\n')
                idx_path = nb_path / '.index'
                if idx_path.exists():
                    idx = idx_path.read_text().splitlines()
                    if note_path.name not in idx:
                        idx_path.write_text('\n'.join(idx + [note_path.name]) + '\n')
                created += 1
        except OSError as e:
            errors.append(f'{ds}: {e}')

    env_ = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
    subprocess.run(['git', 'add', '-A'], cwd=str(nb_path), capture_output=True, env=env_)
    subprocess.run(['git', 'commit', '-m',
                    f'[nb] Import hledger transactions ({created} created, {updated} updated)'],
                   cwd=str(nb_path), capture_output=True, env=env_)

    return jsonify({'ok': True, 'created': created, 'updated': updated, 'errors': errors})


def _parse_hl_amount(s):
    """Parse a hledger amount string like '£1,234.56' or '-5.00' to float."""
    if not s or s.strip() in ('', '0'):
        return 0.0
    cleaned = re.sub(r'[^\d.\-]', '', s.replace(',', ''))
    try:
        return float(cleaned) if cleaned not in ('', '-') else 0.0
    except ValueError:
        return 0.0


def _hl_bal_csv(text):
    """Parse hledger bal --output-format=csv output.

    Returns (month_labels, [(account, [float])]).
    Skips title rows, section markers, and the Total row.
    Handles both plain bal (no title row) and is/bs format (title row present).
    """
    reader = csv.reader(text.splitlines())
    header = None
    rows = []
    for row in reader:
        if not row:
            continue
        if all(v.strip() == '' for v in row[1:]):
            continue
        if header is None:
            header = row
            continue
        rows.append(row)

    if not header:
        return [], []

    month_indices = []
    month_labels  = []
    for i, col in enumerate(header[1:], 1):
        col = col.strip()
        if col.lower() == 'total':
            continue
        month_labels.append(col)
        month_indices.append(i)

    accounts = []
    for row in rows:
        account = row[0].strip()
        if account.lower() in ('total', ''):
            continue
        amounts = [_parse_hl_amount(row[i] if i < len(row) else '') for i in month_indices]
        accounts.append((account, amounts))

    return month_labels, accounts


def _sum_amounts(accounts, n):
    totals = [0.0] * n
    for _, amounts in accounts:
        for i, v in enumerate(amounts[:n]):
            totals[i] += v
    return totals


@app.route('/api/hledger/chart')
def api_hledger_chart():
    notebook = request.args.get('notebook', '').strip()
    report   = request.args.get('report', 'cashflow').strip()
    period   = request.args.get('period', 'thisyear').strip()

    config  = _hledger_config_for_notebook(notebook) if notebook else None
    jpath   = _hledger_journal_path(config)
    if not jpath:
        return jsonify({'error': 'no journal configured'}), 400

    depth = request.args.get('depth', '2').strip()

    def run_bal(type_code, extra_args='', monthly=True):
        cmd = ['hledger', '-f', str(jpath), 'bal', f'type:{type_code}',
               '-N', '--output-format=csv', '-p', period]
        if monthly:
            cmd.append('--monthly')
        if extra_args:
            cmd += shlex.split(extra_args)
        r = subprocess.run(cmd, capture_output=True, text=True)
        return r.stdout

    def run_pie(type_code):
        _, accts = _hl_bal_csv(run_bal(type_code, f'--depth {shlex.quote(depth)}', monthly=False))
        labels = [a for a, _ in accts]
        values = [round(abs(v[0]), 2) if v else 0.0 for _, v in accts]
        return labels, values

    try:
        if report == 'cashflow':
            rev_labels, rev_accts = _hl_bal_csv(run_bal('R'))
            exp_labels, exp_accts = _hl_bal_csv(run_bal('X'))
            labels = rev_labels or exp_labels
            n      = len(labels)
            income   = [-v for v in _sum_amounts(rev_accts, n)]
            expenses = _sum_amounts(exp_accts, n)
            cur = 0.0
            cumulative = []
            for inc, exp in zip(income, expenses):
                cur += inc - exp
                cumulative.append(round(cur, 2))
            return jsonify({
                'report': 'cashflow', 'labels': labels,
                'income':     [round(v, 2) for v in income],
                'expenses':   [round(v, 2) for v in expenses],
                'cumulative': cumulative,
            })

        elif report == 'networth':
            ast_labels, ast_accts = _hl_bal_csv(run_bal('A'))
            lib_labels, lib_accts = _hl_bal_csv(run_bal('L'))
            labels = ast_labels or lib_labels
            n      = len(labels)
            assets      = _sum_amounts(ast_accts, n)
            liabilities = _sum_amounts(lib_accts, n)
            networth    = [round(a - abs(l), 2) for a, l in zip(assets, liabilities)]
            return jsonify({
                'report': 'networth', 'labels': labels,
                'assets':      [round(v, 2) for v in assets],
                'liabilities': [round(abs(v), 2) for v in liabilities],
                'networth':    networth,
            })

        elif report == 'expenses':
            labels, accts = _hl_bal_csv(run_bal('X', f'--depth {shlex.quote(depth)}'))
            n = len(labels)
            series = [{'label': acct, 'data': [round(v, 2) for v in amounts[:n]]}
                      for acct, amounts in accts]
            return jsonify({'report': 'expenses', 'labels': labels, 'series': series})

        elif report == 'expenses-pie':
            labels, values = run_pie('X')
            return jsonify({'report': 'expenses-pie', 'labels': labels, 'values': values})

        elif report == 'assets-pie':
            labels, values = run_pie('A')
            return jsonify({'report': 'assets-pie', 'labels': labels, 'values': values})

        elif report == 'income-pie':
            labels, values = run_pie('R')
            return jsonify({'report': 'income-pie', 'labels': labels, 'values': values})

        else:
            return jsonify({'error': f'unknown report: {report}'}), 400

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/t/status')
def api_t_status():
    return jsonify(_t_parse_status(_t_tc_file()))


@app.route('/api/t/report')
def api_t_report():
    period = request.args.get('period', 'today').strip()
    return jsonify(_t_parse_report(_t_tc_file(), period))


@app.route('/api/t/accounts')
def api_t_accounts():
    tc = _t_tc_file()
    if not tc.exists():
        return jsonify({'accounts': []})
    accounts = sorted({l.split()[3] for l in tc.read_text().splitlines()
                       if l.startswith('i ') and len(l.split()) > 3})
    return jsonify({'accounts': accounts})


@app.route('/api/t/in', methods=['POST'])
def api_t_in():
    data    = request.get_json(silent=True) or {}
    account = data.get('account', '').strip()
    desc    = data.get('desc', '').strip()
    if not account:
        return jsonify({'success': False, 'error': 'account required'}), 400
    tc = _t_tc_file()
    tc.parent.mkdir(parents=True, exist_ok=True)
    if not tc.exists():
        tc.touch()
    # Check already clocked in to same account
    status = _t_parse_status(tc)
    if status['state'] == 'in':
        if status['account'] == account:
            return jsonify({'success': False, 'error': f'Already clocked in to {account}'}), 409
        # Clock out of current before clocking in to new
        now_str = datetime.now().strftime('%Y/%m/%d %H:%M:%S')
        with open(tc, 'a') as f:
            f.write(f'o {now_str}\n')
    now_str = datetime.now().strftime('%Y/%m/%d %H:%M:%S')
    entry = f'i {now_str} {account}'
    if desc:
        entry += f'  {desc}'
    with open(tc, 'a') as f:
        f.write(f'\n{entry}\n')
    return jsonify({'success': True})


@app.route('/api/t/out', methods=['POST'])
def api_t_out():
    tc = _t_tc_file()
    status = _t_parse_status(tc)
    if status['state'] != 'in':
        return jsonify({'success': False, 'error': 'Not clocked in'}), 409
    now_str = datetime.now().strftime('%Y/%m/%d %H:%M:%S')
    with open(tc, 'a') as f:
        f.write(f'o {now_str}\n')
    return jsonify({'success': True})


@app.route('/api/version')
def api_version():
    return jsonify({'started': _STARTED_AT, 'rev': _GIT_REV})


@sock.route('/ws/pty')
def ws_pty(ws):
    """WebSocket PTY: open a shell in the browser terminal panel."""
    import pty, select, fcntl, termios, struct

    # Reject connections from non-localhost origins (CSRF guard)
    origin = request.environ.get('HTTP_ORIGIN', '')
    if origin:
        from urllib.parse import urlparse
        parsed = urlparse(origin)
        if parsed.hostname not in ('localhost', '127.0.0.1', '::1'):
            ws.send('\r\n[pty] Connection rejected: cross-origin request\r\n')
            return

    first = ws.receive(timeout=10)
    if not first:
        return
    try:
        payload  = json.loads(first)
        cwd_str  = payload.get('cwd',  '').strip()
        cmd_str  = payload.get('cmd',  '').strip()   # direct spawn — no shell wrapper
        init_str = payload.get('init', '').strip()   # shell mode — typed into shell
        cols     = int(payload.get('cols', 80))
        rows     = int(payload.get('rows', 24))
    except Exception:
        cwd_str = cmd_str = init_str = ''
        cols, rows = 80, 24

    cwd = None
    if cwd_str:
        p = Path(cwd_str).expanduser()
        cwd = str(p) if p.is_dir() else None

    master_fd, slave_fd = pty.openpty()
    winsize = struct.pack('HHHH', rows, cols, 0, 0)
    fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, winsize)

    def _preexec():
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)

    if cmd_str:
        # Direct spawn: run the command itself as the PTY process (no shell, no race)
        try:
            args = shlex.split(cmd_str)
            # Expand ~ in the first path-like argument
            args = [os.path.expanduser(a) for a in args]
        except ValueError:
            args = cmd_str.split()
        try:
            proc = subprocess.Popen(
                args,
                stdin=slave_fd, stdout=slave_fd, stderr=slave_fd,
                close_fds=True, cwd=cwd,
                env={**os.environ, 'TERM': 'xterm-256color'},
                preexec_fn=_preexec,
            )
        except Exception as e:
            os.close(master_fd); os.close(slave_fd)
            ws.send(f'\r\n[pty] Failed to start {args[0]!r}: {e}\r\n')
            return
    else:
        # Shell mode: spawn a shell and optionally type an init command into it
        shell_bin = os.environ.get('SHELL') or shutil.which('bash') or 'sh'
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
    current_nb = 'home'
    try:
        cur_path = NB_DIR / '.current'
        if cur_path.exists():
            current_nb = cur_path.read_text().strip() or 'home'
    except Exception:
        pass
    notebook_prefs = _load_settings().get('notebook_prefs', {})
    user = session.get('user', {})
    user_level = user.get('level', '')
    names = [n for n in names
             if _level_gte(user_level, _effective_access({}, _notebook_config(n)))]
    if _level_gte(user_level, 'admin'):
        names += [d for d in DOTFOLDERS if (NB_DIR / d).is_dir()]
    return jsonify({'notebooks': names, 'current_notebook': current_nb,
                    'notebook_prefs': notebook_prefs})


def _list_folders_recursive(base, rel=''):
    """Return sorted list of relative folder paths (with .index) under base."""
    result = []
    try:
        children = sorted(base.iterdir(), key=lambda p: p.name)
    except PermissionError:
        return result
    for p in children:
        if p.is_dir() and not p.name.startswith('.') and (p / '.index').exists():
            path = f'{rel}/{p.name}' if rel else p.name
            result.append(path)
            result.extend(_list_folders_recursive(p, path))
    return result


@app.route('/api/folders')
def api_folders():
    notebook = request.args.get('notebook', 'home')
    nb_path  = nb_dir_for(notebook)
    folders  = _list_folders_recursive(nb_path) if nb_path.exists() else []
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
    if _is_dot_notebook(notebook):
        user = session.get('user', {})
        if not _level_gte(user.get('level', ''), 'admin'):
            return jsonify({'error': 'forbidden'}), 403
        return _list_dotfolder_notes(notebook, limit)

    if notebook != '_all' and not _safe_notebook(notebook):
        return jsonify({'error': 'invalid notebook'}), 400

    tags = request.args.get('tags', '').strip() or None
    if query:
        nb_arg = '' if notebook == '_all' else notebook
        return _search_notes(nb_arg, folder, query, limit, tags=tags)
    if tags:
        # Tags-only filter: use grep instead of nb search (much faster)
        nb_arg = '' if notebook == '_all' else notebook
        return _grep_tag_notes(nb_arg, tags, limit)
    if notebook == '_all':
        return _list_all_notes(limit)
    return _list_notes(notebook, folder, limit)


def _front_matches(meta: dict, filters: list) -> bool:
    """Return True if note meta satisfies all frontmatter filter conditions."""
    for f in filters:
        field = f.get('field', '')
        op    = f.get('op', 'eq')
        value = f.get('value', '')
        if op == 'exists':
            if field not in meta:
                return False
        elif op == 'empty':
            v = meta.get(field)
            if v is not None and str(v).strip():
                return False
        else:  # eq
            v = meta.get(field)
            if v is None:
                return False
            if str(v).lower() != str(value).lower():
                return False
    return True


@app.route('/api/front-query')
def api_front_query():
    """Return notes matching frontmatter field filters.

    notebooks: comma-separated notebook names; empty = search all notebooks.
    filters:   JSON array of {field, op, value} — op is 'eq'|'exists'|'empty'.
    """
    notebooks_raw = request.args.get('notebooks', '')
    folder        = request.args.get('folder', '')
    limit         = min(int(request.args.get('limit', 200)), 500)
    filters_raw   = request.args.get('filters', '[]')

    try:
        filters = json.loads(filters_raw)
    except Exception:
        return jsonify({'error': 'invalid filters'}), 400

    if notebooks_raw:
        nb_list = [n.strip() for n in notebooks_raw.split(',') if n.strip()]
        for nb in nb_list:
            if not _safe_notebook(nb):
                return jsonify({'error': f'invalid notebook: {nb}'}), 400
    else:
        nb_list = [d.name for d in sorted(NB_DIR.iterdir())
                   if d.is_dir() and not d.name.startswith('.')]

    results = []
    for notebook in nb_list:
        nb_dir = nb_dir_for(notebook)
        for dirpath_s, dirnames, filenames in os.walk(nb_dir):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith('.'))
            dirpath = Path(dirpath_s)
            for fname in sorted(filenames):
                if fname.startswith('.'):
                    continue
                fpath = dirpath / fname
                rel   = str(fpath.relative_to(nb_dir))
                itype = classify(fname, notebook)
                if itype in BINARY_TYPES:
                    continue
                try:
                    raw = fpath.read_text(errors='replace')
                except OSError:
                    continue
                meta, body = parse_frontmatter(raw)
                if not _front_matches(meta, filters):
                    continue
                title    = meta.get('title') or meta.get('name') or note_title(fname, body)
                selector = f'{notebook}:{rel}'
                results.append({'title': title, 'selector': selector, 'filename': fname,
                                'type': itype, 'notebook': notebook,
                                'meta': {k: str(v) for k, v in meta.items()}})
                if len(results) >= limit:
                    return jsonify(results)

    return jsonify(results)


_all_notes_cache: dict = {}   # {'sig': tuple, 'data': list[dict]}

def _index_sig() -> tuple:
    """Tuple of .index mtimes across all notebooks — changes when any note is added/removed."""
    sigs = []
    try:
        for nb_dir in sorted(NB_DIR.iterdir()):
            if not nb_dir.is_dir() or nb_dir.name.startswith('.'):
                continue
            idx = nb_dir / '.index'
            try:
                sigs.append(idx.stat().st_mtime)
            except OSError:
                sigs.append(0.0)
    except Exception:
        pass
    return tuple(sigs)


def _build_all_notes() -> list:
    """Read every notebook and return a sorted list of note dicts."""
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
                    'mtime': 0,
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
                itype = _apply_meta_type(itype, meta)
            title = meta.get('title') or meta.get('name') or note_title(fname, body)
            if '/items/' in str(fpath):
                parts = [str(meta[k]) for k in ('category', 'price', 'status') if meta.get(k)]
                excerpt = ' · '.join(parts)
            else:
                excerpt = _first_excerpt_line(body, meta)
            todo_status = None
            if itype == 'todo':
                first = next((l.strip() for l in body.splitlines() if l.strip()), '')
                todo_status = 'closed' if first.startswith('# [x]') else 'open'
            try:
                mtime = fpath.stat().st_mtime
            except OSError:
                mtime = 0
            all_items.append({
                'type':      itype,
                'indicator': _indicator(itype, todo_status),
                'mtime':     mtime,
                'filename':  fname,
                'title':     title,
                'selector':  f"{nb_name}:{fname}",
                'excerpt':   excerpt,
                'notebook':  nb_name,
                'updated':   '',
                'pinned':    False,
                'status':    todo_status,
            })
    # Sort non-folders by mtime using the already-fetched value (no extra stat())
    folders     = [i for i in all_items if i['type'] == 'folder']
    non_folders = [i for i in all_items if i['type'] != 'folder']
    non_folders.sort(key=lambda i: i.get('mtime', 0), reverse=True)
    return folders + non_folders


def _list_all_notes(limit):
    """Aggregate recent notes across all non-archived notebooks (index-sig-cached)."""
    sig = _index_sig()
    if _all_notes_cache.get('sig') == sig:
        combined = _all_notes_cache['data']
    else:
        combined = _build_all_notes()
        _all_notes_cache['sig']  = sig
        _all_notes_cache['data'] = combined
    sliced = combined[:limit]
    return jsonify({'notes': sliced, 'total': len(sliced)})


def _list_notes(notebook, folder, limit):
    """List notes by reading .index + file metadata directly."""
    nb_path = nb_dir_for(notebook)
    folder_path = nb_path / folder if folder else nb_path
    index = read_index(notebook, folder)
    total = len(index)   # position in index = ID (1-based)

    user    = session.get('user', {})
    nb_meta = _notebook_config(notebook)

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
                'locked': (fpath / '.nb-lock').exists(),
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
            itype = _apply_meta_type(itype, meta)
        if not _level_gte(user.get('level', ''), _effective_access(meta, nb_meta)):
            continue
        title = meta.get('title') or meta.get('name') or note_title(fname, body)
        excerpt = _first_excerpt_line(body, meta)
        todo_status = None
        if itype == 'todo':
            first = next((l.strip() for l in body.splitlines() if l.strip()), '')
            todo_status = 'closed' if first.startswith('# [x]') else 'open'
        sel_path = (folder + '/' if folder else '') + fname
        items.append({
            'type':       itype,
            'indicator':  _indicator(itype, todo_status),
            'id':         item_id,
            'mtime':      fpath.stat().st_mtime,
            'filename':   fname,
            'title':      title,
            'selector':   f"{notebook}:{sel_path}",
            'excerpt':    excerpt,
            'updated':    '',
            'pinned':     meta.get('pinned', '') == 'true',
            'status':     todo_status,
            'annotation': _read_annotation(str(fpath)),
        })
        if len(items) >= limit:
            break

    pinned   = [i for i in items if i.get('pinned')]
    unpinned = [i for i in items if not i.get('pinned')]
    return jsonify({'notes': pinned + unpinned, 'total': len(items)})


def _resolve_fname(nb_name, raw_id_or_sel):
    """Return (fname, fpath) for a note identified by id or selector, or (None, None).

    Handles both flat ids ('42') and subfolder paths ('hledger/32').
    """
    try:
        raw_str = str(raw_id_or_sel).split(':')[-1]  # strip notebook prefix if any
        folder  = ''
        raw_id  = raw_str
        if '/' in raw_str:
            # Subfolder path like 'hledger/32' — split into folder + id
            folder, raw_id = raw_str.rsplit('/', 1)
        if not raw_id.isdigit():
            return None, None
        idx    = read_index(nb_name, folder)
        id_num = int(raw_id)
        if not (1 <= id_num <= len(idx)):
            return None, None
        fname = idx[id_num - 1]
        if not fname:
            return None, None
        rel = Path(folder) / fname if folder else Path(fname)
        return fname, NB_DIR / nb_name / rel
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


def _grep_tag_notes(notebook: str, tag_query: str, limit: int):
    """Fast tag filter via grep — AND logic for positive tags, exclusion for -tag."""
    pos_tags, neg_tags = [], []
    for raw in re.split(r'[\s,]+', tag_query):
        raw = raw.strip()
        if not raw:
            continue
        if raw.startswith('-'):
            t = raw[1:]
            neg_tags.append(t if t.startswith('#') else '#' + t)
        else:
            pos_tags.append(raw if raw.startswith('#') else '#' + raw)

    if not pos_tags and not neg_tags:
        pos_tags = ['#' + tag_query.strip().lstrip('#')]

    search_root = NB_DIR / notebook if notebook else NB_DIR
    try:
        # Positive tags: intersect (file must contain ALL)
        if pos_tags:
            path_sets = []
            for tag in pos_tags:
                r = subprocess.run(
                    ['grep', '-rl', tag, str(search_root)],
                    capture_output=True, text=True, timeout=15
                )
                path_sets.append(set(r.stdout.splitlines()))
            matched_set = path_sets[0].intersection(*path_sets[1:])
        else:
            # Negative-only: start from all non-hidden files in the notebook
            r_all = subprocess.run(
                ['find', str(search_root), '-type', 'f',
                 '!', '-path', '*/.git/*', '!', '-name', '.*'],
                capture_output=True, text=True, timeout=15
            )
            matched_set = set(r_all.stdout.splitlines())

        # Negative tags: subtract (file must contain NONE)
        for tag in neg_tags:
            r = subprocess.run(
                ['grep', '-rl', tag, str(search_root)],
                capture_output=True, text=True, timeout=15
            )
            matched_set -= set(r.stdout.splitlines())

        matched = list(matched_set)
    except Exception:
        matched = []

    items      = []
    seen_sels  = set()

    for path_str in matched:
        if len(items) >= limit:
            break
        fpath = Path(path_str)
        fname = fpath.name
        try:
            rel = fpath.relative_to(NB_DIR)
        except ValueError:
            continue
        nb_name = rel.parts[0]
        # Skip files inside hidden subdirectories
        if any(p.startswith('.') for p in rel.parts[1:-1]):
            continue

        ann_match    = False
        parent_fname = _sidecar_parent(fname)
        if parent_fname:
            ann_match = True
            # Rebuild path_in_nb pointing at the parent file
            middle = rel.parts[1:-1]
            path_in_nb = '/'.join(middle + (parent_fname,)) if middle else parent_fname
            fname  = parent_fname
            fpath  = fpath.parent / parent_fname
        elif fname.startswith('.'):
            continue   # other hidden file (e.g. .index)
        else:
            path_in_nb = '/'.join(rel.parts[1:])

        sel = f"{nb_name}:{path_in_nb}"
        if sel in seen_sels:
            continue
        seen_sels.add(sel)

        if not fpath.exists():
            continue

        itype = classify(fname, nb_name)
        try:
            mtime = fpath.stat().st_mtime
        except OSError:
            mtime = 0

        slim = None
        if itype in BINARY_TYPES:
            title   = note_title(fname, '')
            excerpt = ''
            todo_status = None
        else:
            try:
                raw  = fpath.read_text(errors='replace')
                meta, body = parse_frontmatter(raw)
                itype = _apply_meta_type(itype, meta)
                title   = meta.get('title') or meta.get('name') or note_title(fname, body)
                if itype == 'shot':
                    excerpt = str(meta.get('desc', '')).strip()
                else:
                    excerpt = _first_excerpt_line(body, meta)
                todo_status = None
                if itype == 'todo':
                    first = next((l.strip() for l in body.splitlines() if l.strip()), '')
                    todo_status = 'closed' if first.startswith('# [x]') else 'open'
                slim = _slim_meta(meta) if itype in _FM_TYPES else None
            except Exception:
                title = note_title(fname, '')
                excerpt = ''
                todo_status = None
                slim = None

        items.append({
            'selector':         sel,
            'filename':         fname,
            'title':            title,
            'type':             itype,
            'status':           todo_status,
            'indicator':        _indicator(itype, todo_status),
            'mtime':            mtime,
            'excerpt':          excerpt,
            'notebook':         nb_name,
            'updated':          '',
            'pinned':           False,
            'annotation_match': ann_match,
            'annotation':       _read_annotation(str(fpath)),
            'meta':             slim,
        })

    return jsonify({'notes': items, 'total': len(items), 'query': tag_query})


_sidecar_scan_cache: dict = {}   # root_str -> (scan_time, [Path])
_SIDECAR_SCAN_TTL = 30           # re-scan at most every 30 s

def _scan_sidecars(root: Path) -> list:
    """Return cached list of annotation sidecar Paths under root."""
    key = str(root)
    now = time.time()
    hit = _sidecar_scan_cache.get(key)
    if hit and now - hit[0] < _SIDECAR_SCAN_TTL:
        return hit[1]
    paths = list(root.rglob('.*.annotations.md'))
    _sidecar_scan_cache[key] = (now, paths)
    return paths


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
        # Strip surrounding YAML quotes nb includes in search output ("Assets" → Assets)
        title   = title.strip('"\'')
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
        fname, fpath_r = _resolve_fname(nb_part, raw_sel)
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

        # Read file once to get both real title and excerpt.
        # nb search --list may emit the filename (with extension) instead of the H1 title
        # for filename-match results; reading the file directly avoids that.
        real_title = None
        excerpt    = ''
        ann_text   = None
        fmtime     = 0
        if fname and fpath_r:
            try:
                fmtime = fpath_r.stat().st_mtime
            except OSError:
                pass
            ann_text = _read_annotation(str(fpath_r))
            if itype not in BINARY_TYPES:
                try:
                    raw_f = fpath_r.read_text(errors='replace')
                    meta_f, body_f = parse_frontmatter(raw_f)
                    real_title = meta_f.get('title') or meta_f.get('name') or note_title(fname, body_f)
                    for ln in body_f.splitlines():
                        ln = ln.strip()
                        if ln and not _RE_HEADING.match(ln):
                            excerpt = ln[:120]
                            break
                except Exception:
                    pass
        items.append({
            'selector':         selector,
            'filename':         fname or raw_sel,
            'title':            real_title or title or raw_sel,
            'type':             itype,
            'status':           todo_status,
            'indicator':        _indicator(itype, todo_status),
            'mtime':            fmtime,
            'excerpt':          excerpt,
            'notebook':         nb_part,
            'updated':          '',
            'pinned':           False,
            'annotation_match': False,
            'annotation':       ann_text,
        })

    # --- Supplemental: grep annotation sidecars (hidden dotfiles nb search skips) ---
    if len(items) < limit:
        ann_root  = NB_DIR / notebook if notebook else NB_DIR
        q_lower   = query.lower()
        tag_lower = tags.lower() if tags else None
        try:
            for ann_path in _scan_sidecars(ann_root):
                if len(items) >= limit:
                    break
                try:
                    text = ann_path.read_text(errors='replace')
                    if q_lower not in text.lower():
                        continue
                    parent_fname = _sidecar_parent(ann_path.name)
                    if not parent_fname:
                        continue
                    try:
                        nb_name = ann_path.relative_to(NB_DIR).parts[0]
                    except ValueError:
                        continue
                    try:
                        idx    = read_index(nb_name)
                        id_num = idx.index(parent_fname) + 1
                    except (ValueError, Exception):
                        continue
                    sel = f"{nb_name}:{id_num}"
                    if sel in seen_sels:
                        continue
                    # Tag filter: must appear in tag_selectors OR in sidecar text
                    if tag_selectors is not None and sel not in tag_selectors:
                        if not (tag_lower and tag_lower in text.lower()):
                            continue
                    seen_sels.add(sel)
                    itype = classify(parent_fname, nb_name)
                    try:
                        fmtime = (NB_DIR / nb_name / parent_fname).stat().st_mtime
                    except OSError:
                        fmtime = 0
                    items.append({
                        'selector':         sel,
                        'filename':         parent_fname,
                        'title':            note_title(parent_fname, ''),
                        'type':             itype,
                        'status':           None,
                        'indicator':        _indicator(itype, None),
                        'mtime':            fmtime,
                        'excerpt':          text[:120],
                        'notebook':         nb_name,
                        'updated':          '',
                        'pinned':           False,
                        'annotation_match': True,
                        'annotation':       text.strip() or None,
                    })
                except Exception:
                    continue
        except Exception:
            pass

    return jsonify({'notes': items, 'total': len(items), 'query': query})


# ---------------------------------------------------------------------------
# API: Single note
# ---------------------------------------------------------------------------

@app.route('/api/note')
def api_note():
    selector = request.args.get('selector', '')
    if not selector:
        return jsonify({'error': 'selector required'}), 400

    note_notebook = None
    note_id       = None

    # Dotfolder selector — .users:djp.md etc.
    dot_path = _dot_selector_to_path(selector)
    if dot_path is not None:
        user = session.get('user', {})
        dot_nb = selector.partition(':')[0]
        if dot_nb not in _DOT_OPEN and not _level_gte(user.get('level', ''), 'admin'):
            return jsonify({'error': 'forbidden'}), 403
        # .lib files: filename suffix declares required level — e.g. user-mgmt-admin.html
        # serves empty body (silent) if user doesn't qualify; no error, no 403.
        if dot_nb == '.lib':
            stem = Path(dot_path.name).stem
            for lvl in LEVELS:
                if stem.endswith(f'-{lvl}'):
                    if not _level_gte(user.get('level', ''), lvl):
                        return jsonify({'body': '', 'meta': {}, 'selector': selector, 'title': ''})
                    break
        if not dot_path.exists():
            return jsonify({'error': 'not found'}), 404
        note_notebook = selector.partition(':')[0]
        fpath = str(dot_path)
    # Absolute path selector — any readable file on the local system
    elif selector.startswith('/'):
        fpath = selector
        if not Path(fpath).exists():
            return jsonify({'error': 'not found'}), 404
    else:
        # Resolve selector to a real path first (handles both filename and id selectors)
        path_r = run_nb('show', selector, '--path')
        if not nb_ok(path_r):
            return jsonify({'error': 'not found'}), 404
        fpath = path_r['stdout'].strip()

    # Determine notebook name and numeric id from filesystem path
    p = Path(fpath)
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

    # Annotation sidecar: .filename.annotations.md in same directory
    annotation_text = _read_annotation(fpath)

    # Don't read binary files as text — frontend fetches /api/file for those
    if itype in BINARY_TYPES:
        return jsonify({
            'selector': selector, 'notebook': note_notebook or '',
            'id': note_id, 'filename': filename,
            'title': note_title(filename, ''),
            'type': itype, 'binary': True,
            'raw': '', 'body': '', 'tags': [], 'meta': {},
            'annotation': annotation_text,
            'path': fpath,
        })

    try:
        raw = Path(fpath).read_text(errors='replace')
    except OSError:
        return jsonify({'error': 'could not read file'}), 404

    meta, body = parse_frontmatter(raw)
    itype = _apply_meta_type(itype, meta)

    nb_meta = _notebook_config(note_notebook) if note_notebook else {}
    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), _effective_access(meta, nb_meta)):
        if request.args.get('inline'):
            return jsonify({'body': '', 'meta': {}, 'selector': selector, 'title': ''})
        return jsonify({'error': 'Access denied'}), 403

    title = meta.get('title') or meta.get('name') or note_title(filename, body)

    tags = re.findall(r'#([\w/-]+)', body)
    if annotation_text:
        ann_tags = re.findall(r'#([\w/-]+)', annotation_text)
        tags = list(dict.fromkeys(tags + ann_tags))  # merge, dedupe, preserve order

    todo_status = None
    if itype == 'todo':
        first = body.lstrip().splitlines()[0] if body.strip() else ''
        todo_status = 'closed' if first.startswith('# [x]') else 'open'

    lk          = _find_nb_lock(fpath)
    locked      = lk is not None
    lock_reason = lk.read_text(errors='replace').strip() or None if locked else None

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
        'annotation': annotation_text,
        'size':     Path(fpath).stat().st_size,
        'mtime':    datetime.fromtimestamp(Path(fpath).stat().st_mtime).strftime('%Y-%m-%d'),
        'locked':   locked,
        'lock_reason': lock_reason,
    })


# ---------------------------------------------------------------------------
# Annotations (sidecar .filename.annotations.md)
# ---------------------------------------------------------------------------

_SIDECAR_RE = re.compile(r'^\.(.*?)\.annotations\.md$')

def _annotation_path(note_path: str) -> Path:
    p = Path(note_path)
    return p.parent / f'.{p.name}.annotations.md'

def _read_annotation(note_path: str) -> str | None:
    ap = _annotation_path(note_path)
    if ap.exists():
        return ap.read_text(errors='replace').strip() or None
    return None

def _find_nb_lock(path) -> 'Path | None':
    """Walk up from path (file or dir) to notebook root; return first .nb-lock found, or None."""
    p = Path(path)
    if p.is_file():
        p = p.parent
    try:
        rel = p.relative_to(NB_DIR)
        if not rel.parts:
            return None
        nb_root = NB_DIR / rel.parts[0]
    except ValueError:
        return None
    cur = p
    while True:
        lk = cur / '.nb-lock'
        if lk.exists():
            return lk
        if cur == nb_root:
            break
        cur = cur.parent
    return None


def _folder_selector_to_dir(selector: str) -> 'Path | None':
    """Convert folder selector (e.g. 'home:tutorial/') to filesystem Path, or None."""
    if ':' not in selector:
        return None
    nb_name, rel = selector.split(':', 1)
    if not _safe_notebook(nb_name):
        return None
    rel = rel.strip('/')
    p = NB_DIR / nb_name / rel if rel else NB_DIR / nb_name
    try:
        p.relative_to(NB_DIR)
    except ValueError:
        return None
    return p if p.is_dir() else None


def _sidecar_parent(fname: str) -> str | None:
    """If fname is an annotation sidecar, return the parent filename. Otherwise None."""
    m = _SIDECAR_RE.match(fname or '')
    return m.group(1) if m else None


@app.route('/api/note/annotation-template')
def api_annotation_template():
    selector = request.args.get('selector', '').strip()
    if not selector:
        return jsonify({'content': None})
    path_r = run_nb('show', selector, '--path')
    if not nb_ok(path_r):
        return jsonify({'content': None})
    fpath   = Path(path_r['stdout'].strip())
    tmpl    = fpath.parent / '.template-annotation.md'
    if not tmpl.exists():
        return jsonify({'content': None})
    raw = tmpl.read_text(errors='replace')
    # Resolve {{title}} from the note's own frontmatter
    title_m = re.search(r'^title:\s*(.+)$', fpath.read_text(errors='replace'), re.MULTILINE)
    title   = title_m.group(1).strip() if title_m else ''
    return jsonify({'content': _resolve_template_vars(raw, title=title)})


def _load_constraints(note_path: Path) -> dict:
    """Walk from note's folder up to its notebook root, merging .constraints.md files.

    Processes root-first so folder-level entries override notebook-level entries.
    Constraint values are always returned as strings (e.g. 'select a,b,c', 'bool').
    """
    dirs = []
    p = note_path.parent
    while True:
        dirs.append(p)
        try:
            rel = p.relative_to(NB_DIR)
            if len(rel.parts) <= 1:   # reached the notebook root
                break
        except ValueError:
            break
        p = p.parent

    merged = {}
    for d in reversed(dirs):   # root → folder; deeper entries win
        cf = d / '.constraints.md'
        if not cf.exists():
            continue
        meta, _ = parse_frontmatter(cf.read_text(errors='replace'))
        merged.update({k: str(v) for k, v in meta.items() if k and v is not None})
    return merged


@app.route('/api/note/constraints')
def api_note_constraints():
    selector = request.args.get('selector', '').strip()
    if not selector:
        return jsonify({'error': 'selector required'}), 400
    path_r = run_nb('show', selector, '--path')
    if not nb_ok(path_r):
        return jsonify({'error': 'not found'}), 404
    fpath = Path(path_r['stdout'].strip())
    return jsonify(_load_constraints(fpath))


@app.route('/api/note/annotate', methods=['POST', 'DELETE'])
def api_note_annotate():
    selector = request.args.get('selector', '').strip()
    if not selector:
        return jsonify({'error': 'selector required'}), 400

    path_r = run_nb('show', selector, '--path')
    if not nb_ok(path_r):
        return jsonify({'error': 'not found'}), 404
    fpath = path_r['stdout'].strip()
    ap    = _annotation_path(fpath)

    def _bust_sidecar_cache():
        _sidecar_scan_cache.clear()

    if request.method == 'DELETE':
        if ap.exists():
            ap.unlink()
            _bust_sidecar_cache()
        return jsonify({'ok': True})

    # POST — write annotation
    data    = request.get_json(silent=True) or {}
    content = data.get('content', '').strip()
    if not content:
        if ap.exists():
            ap.unlink()
            _bust_sidecar_cache()
        return jsonify({'ok': True, 'annotation': None})

    existed = ap.exists()
    ap.write_text(content + '\n')
    if not existed:
        _bust_sidecar_cache()   # new sidecar file; invalidate scan list
    return jsonify({'ok': True, 'annotation': content})


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

    if _is_dot_notebook(notebook):
        user = session.get('user', {})
        if not _level_gte(user.get('level', ''), 'admin'):
            return jsonify({'error': 'forbidden'}), 403
        filename = re.sub(r'[^\w\-.]', '_', title or 'note').strip('_') + '.md'
        fpath = NB_DIR / notebook / filename
        try:
            fpath.write_text(content or '')
        except OSError as e:
            return jsonify({'error': str(e)}), 500
        return jsonify({'success': True, 'selector': f'{notebook}:{filename}'})

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
        template_content = data.get('template_content', '').strip()
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
        elif template_content:
            note_content = _resolve_template_vars(
                template_content,
                title=title,
                tags=' '.join(f'#{t}' for t in tags) if tags else '',
                content=content or '',
            )

        using_template = bool(template_path or template_content)
        explicit_filename = data.get('filename', '').strip()
        if explicit_filename:
            # Caller supplies exact filename (e.g. cine Ctrl+[ shot creation)
            if not explicit_filename.endswith('.md'):
                explicit_filename += '.md'
            note_filename = explicit_filename
        else:
            slug = re.sub(r'[^\w]+', '_', title or 'note').strip('_').lower()
            # Clean slug when: subfolder note (items/ etc.) OR template-driven note.
            # Template = intentional structured content that needs a predictable URL.
            # Timestamp prefix reserved for casual root-level notes (no template).
            if folder or using_template:
                note_filename = f"{slug}.md"
        if not explicit_filename and not (folder or using_template):
            note_filename = f"{datetime.now().strftime('%Y%m%d%H%M%S')}_{slug}.md"

        # When content starts with YAML frontmatter, nb CLI's --content corrupts
        # it (strips <a href= tags, reorders blocks). Write directly to disk instead.
        if note_content.lstrip().startswith('---'):
            nb_root = NB_DIR / notebook
            note_dir = nb_root / folder if folder else nb_root
            note_dir.mkdir(parents=True, exist_ok=True)
            note_path = note_dir / note_filename
            note_path.write_text(note_content)
            rel_in_nb = note_path.relative_to(nb_root)
            # Write to the folder's own .index (not the root .index)
            index_path = note_dir / '.index'
            index_rel  = index_path.relative_to(nb_root)
            with open(index_path, 'a') as f:
                f.write(note_filename + '\n')
            env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
            subprocess.run(['git', 'add', str(rel_in_nb), str(index_rel)],
                           cwd=str(nb_root), capture_output=True, env=env)
            subprocess.run(['git', 'commit', '-m', f'[nb] Added: {note_filename}'],
                           cwd=str(nb_root), capture_output=True, env=env)
            rel = f'{folder}/{note_filename}' if folder else note_filename
            return jsonify({'success': True, 'output': f'Added: {note_filename}',
                            'selector': f'{notebook}:{rel}'})

        args = ['add', target]
        # Skip --title when a template is used: {{title}} is already substituted
        # into the content, and nb prepending "# Title\n\n" breaks YAML frontmatter.
        if title and not using_template:
            args += ['--title', title]
        args += ['--content', note_content]
        if tags:    args += ['--tags', ','.join(tags)]
        args += ['--filename', note_filename]
        r = run_nb(*args)
        if nb_ok(r):
            # We control the filename, so build the selector directly — avoids
            # parsing nb's ID-based output which won't match filename selectors in the list.
            rel = f'{folder}/{note_filename}' if folder else note_filename
            return jsonify({'success': True, 'output': strip_ansi(r['stdout']),
                            'selector': f'{notebook}:{rel}'})

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

    # Resolve dotfolder selectors to absolute paths so the existing path-write code handles them
    dot_path = _dot_selector_to_path(selector)
    if dot_path is not None:
        user = session.get('user', {})
        if not _level_gte(user.get('level', ''), 'admin'):
            return jsonify({'error': 'forbidden'}), 403
        selector = str(dot_path)

    if append is not None:
        if selector.startswith('/'):
            try:
                p = Path(selector)
                p.write_text(p.read_text() + '\n' + append)
                return jsonify({'success': True, 'stderr': ''})
            except OSError as e:
                return jsonify({'error': str(e)}), 500
        r = run_nb('edit', selector, '--content', append)
        return jsonify({'success': nb_ok(r), 'stderr': r['stderr']})

    if prepend is not None:
        if selector.startswith('/'):
            try:
                p = Path(selector)
                p.write_text(prepend + '\n' + p.read_text())
                return jsonify({'success': True, 'stderr': ''})
            except OSError as e:
                return jsonify({'error': str(e)}), 500
        r = run_nb('edit', selector, '--content', prepend, '--prepend')
        return jsonify({'success': nb_ok(r), 'stderr': r['stderr']})

    if content is None:
        return jsonify({'error': 'content, append, or prepend required'}), 400

    # Direct write — nb edit --content --overwrite silently truncates content that
    # starts with YAML frontmatter (---) due to an nb CLI bug. Write the file
    # directly and commit, exactly as api_create_note does for frontmatter notes.
    if selector.startswith('/'):
        note_path = Path(selector)
        if not note_path.is_file():
            return jsonify({'error': 'not found'}), 404
    else:
        path_r = run_nb('show', selector, '--path')
        if not nb_ok(path_r):
            return jsonify({'error': 'not found'}), 404
        note_path = Path(path_r['stdout'].strip())
        if not note_path.is_file():
            return jsonify({'error': 'not found'}), 404

    try:
        note_path.write_text(content)
    except OSError as e:
        return jsonify({'error': str(e)}), 500

    nb_root = note_path.parent
    # Walk up to find the notebook root (contains .git)
    p = note_path.parent
    while p != p.parent:
        if (p / '.git').is_dir():
            nb_root = p
            break
        p = p.parent

    env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
    rel = note_path.relative_to(nb_root)
    subprocess.run(['git', 'add', str(rel)], cwd=str(nb_root),
                   capture_output=True, env=env)
    subprocess.run(['git', 'commit', '-m', f'[nb] Edit: {note_path.name}'],
                   cwd=str(nb_root), capture_output=True, env=env)

    return jsonify({'success': True, 'stderr': ''})


# ---------------------------------------------------------------------------
# API: Decrypt / re-encrypt encrypted notes (openssl AES-256-CBC)
# ---------------------------------------------------------------------------

@app.route('/api/note/decrypt', methods=['POST'])
def api_decrypt_note():
    data     = request.get_json() or {}
    selector = data.get('selector', '')
    password = data.get('password', '')
    if not selector or not password:
        return jsonify({'error': 'selector and password required'}), 400
    fpath = _resolve_to_nb_path(selector)
    if not fpath or not fpath.is_file():
        return jsonify({'error': 'not found'}), 404
    if not fpath.name.endswith('.enc'):
        return jsonify({'error': 'not an encrypted file'}), 400
    for md in ('sha256', 'md5'):
        r = subprocess.run(
            ['openssl', 'enc', '-d', '-aes-256-cbc', '-md', md,
             '-pass', f'pass:{password}', '-in', str(fpath)],
            capture_output=True, timeout=10)
        if r.returncode == 0:
            return jsonify({'content': r.stdout.decode('utf-8', errors='replace')})
    return jsonify({'error': 'wrong password'}), 401


@app.route('/api/note/encrypted', methods=['PUT'])
def api_save_encrypted_note():
    data     = request.get_json() or {}
    selector = data.get('selector', '')
    password = data.get('password', '')
    content  = data.get('content', '')
    if not selector or not password:
        return jsonify({'error': 'selector and password required'}), 400
    fpath = _resolve_to_nb_path(selector)
    if not fpath or not fpath.is_file():
        return jsonify({'error': 'not found'}), 404
    if not fpath.name.endswith('.enc'):
        return jsonify({'error': 'not an encrypted file'}), 400
    tmp = Path(tempfile.mktemp(suffix='.enc.tmp', dir=str(fpath.parent)))
    try:
        r = subprocess.run(
            ['openssl', 'enc', '-aes-256-cbc', '-md', 'sha256',
             '-pass', f'pass:{password}', '-out', str(tmp)],
            input=content.encode('utf-8'),
            capture_output=True, timeout=10)
        if r.returncode != 0:
            return jsonify({'error': 'encryption failed',
                            'detail': r.stderr.decode(errors='replace')}), 500
        tmp.replace(fpath)
        rel      = fpath.relative_to(NB_DIR)
        nb_dir   = NB_DIR / rel.parts[0]
        rel_in_nb = fpath.relative_to(nb_dir)
        env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
        subprocess.run(['git', 'add', str(rel_in_nb)],
                       cwd=str(nb_dir), capture_output=True, env=env)
        subprocess.run(['git', 'commit', '-m', f'Updated {fpath.name}'],
                       cwd=str(nb_dir), capture_output=True, env=env)
        return jsonify({'success': True})
    except Exception as e:
        tmp.unlink(missing_ok=True)
        return jsonify({'error': str(e)}), 500


@app.route('/api/note/new-encrypted', methods=['POST'])
def api_create_encrypted_note():
    data     = request.get_json() or {}
    notebook = data.get('notebook', 'home')
    folder   = data.get('folder', '')
    title    = data.get('title', '') or 'Encrypted note'
    tags     = data.get('tags', [])
    content  = data.get('content', '')
    password = data.get('password', '')

    if not password:
        return jsonify({'error': 'password required'}), 400

    nb_root = NB_DIR / notebook
    if not nb_root.is_dir():
        return jsonify({'error': f'notebook {notebook!r} not found'}), 404

    note_dir = nb_root / folder if folder else nb_root
    note_dir.mkdir(parents=True, exist_ok=True)

    # Build markdown body same as nb add --title / --tags
    parts = [f'# {title}', '']
    if tags:
        parts.append(' '.join(f'#{t}' for t in tags))
        parts.append('')
    if content:
        parts.append(content)
    note_text = '\n'.join(parts)

    slug = re.sub(r'[^\w]+', '_', title).strip('_').lower()
    dated_filename = f"{datetime.now().strftime('%Y%m%d%H%M%S')}_{slug}.md.enc"
    fpath = note_dir / dated_filename
    tmp   = Path(tempfile.mktemp(suffix='.enc.tmp', dir=str(note_dir)))
    try:
        r = subprocess.run(
            ['openssl', 'enc', '-aes-256-cbc', '-md', 'sha256',
             '-pass', f'pass:{password}', '-out', str(tmp)],
            input=note_text.encode('utf-8'),
            capture_output=True, timeout=10)
        if r.returncode != 0:
            return jsonify({'error': 'encryption failed',
                            'detail': r.stderr.decode(errors='replace')}), 500
        tmp.replace(fpath)

        # Append to nb's .index so the file gets a numeric ID
        rel_in_nb = fpath.relative_to(nb_root)
        index_path = nb_root / '.index'
        with open(index_path, 'a') as f:
            f.write(str(rel_in_nb) + '\n')

        env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
        subprocess.run(['git', 'add', str(rel_in_nb), '.index'],
                       cwd=str(nb_root), capture_output=True, env=env)
        subprocess.run(['git', 'commit', '-m', f'Added {dated_filename}'],
                       cwd=str(nb_root), capture_output=True, env=env)

        return jsonify({'success': True, 'selector': f'{notebook}:{dated_filename}'})
    except Exception as e:
        tmp.unlink(missing_ok=True)
        return jsonify({'error': str(e)}), 500


# ---------------------------------------------------------------------------
# API: Delete note
# ---------------------------------------------------------------------------

@app.route('/api/note', methods=['DELETE'])
def api_delete_note():
    selector = request.args.get('selector', '')
    if not selector:
        return jsonify({'error': 'selector required'}), 400
    dot_path = _dot_selector_to_path(selector)
    if dot_path is not None:
        user = session.get('user', {})
        if not _level_gte(user.get('level', ''), 'admin'):
            return jsonify({'error': 'forbidden'}), 403
        try:
            dot_path.unlink()
            return jsonify({'success': True, 'stderr': ''})
        except OSError as e:
            return jsonify({'error': str(e)}), 500
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

@app.route('/api/git/show')
def api_git_show():
    """Look up a commit hash across known git repos and return formatted details."""
    h = request.args.get('hash', '').strip()
    if not re.match(r'^[0-9a-f]{7,40}$', h):
        return jsonify({'error': 'invalid hash'}), 400

    # Search: nb-web dir first, then each notebook (nb uses git for version control)
    search_dirs = [Path(__file__).parent]
    try:
        for d in NB_DIR.iterdir():
            if d.is_dir() and not d.name.startswith('.') and (d / '.git').exists():
                search_dirs.append(d)
    except Exception:
        pass

    for repo in search_dirs:
        try:
            r = subprocess.run(
                ['git', 'show', '-s',
                 '--format=commit %H%nauthor %an%ndate   %ad%n%n    %s%n%n%b',
                 '--date=short', h],
                capture_output=True, text=True, cwd=str(repo), timeout=5,
            )
            if r.returncode != 0 or not r.stdout.strip():
                continue
            # Append brief file-change stat
            stat_r = subprocess.run(
                ['git', 'show', '--stat', '--format=', h],
                capture_output=True, text=True, cwd=str(repo), timeout=5,
            )
            stat = stat_r.stdout.strip() if stat_r.returncode == 0 else ''
            text = r.stdout.strip()
            if stat:
                text += '\n\n' + stat
            return jsonify({'text': text, 'repo': repo.name})
        except Exception:
            continue

    return jsonify({'error': f'Commit {h} not found in known repos'}), 404


@app.route('/api/git/log')
def api_git_log():
    n = min(int(request.args.get('n', 8)), 20)
    try:
        result = subprocess.run(
            ['git', 'log', f'-{n}', '--format=%h\t%s\t%cd', '--date=short', '--abbrev=8'],
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

@app.route('/api/nb/sync/status')
def api_nb_sync_status():
    """Unpushed commits + dirty files for one nb notebook."""
    notebook = request.args.get('notebook', '').strip()
    if not notebook or notebook == '_all':
        return jsonify({'changes': 0, 'has_remote': False, 'unpushed': 0, 'files': []})
    nb_path = NB_DIR / notebook
    if not nb_path.is_dir() or not (nb_path / '.git').exists():
        return jsonify({'changes': 0, 'has_remote': False, 'unpushed': 0, 'files': []})
    env = {**os.environ, 'NO_COLOR': '1', 'GIT_TERMINAL_PROMPT': '0', 'GIT_PAGER': 'cat'}
    remote_r = subprocess.run(['git', 'remote'], capture_output=True, text=True,
                              cwd=str(nb_path), timeout=5, env=env)
    has_remote = bool(remote_r.stdout.strip())
    if not has_remote:
        default_remote = _load_settings().get('default_git_remote', '').strip()
        return jsonify({'changes': 0, 'has_remote': False, 'unpushed': 0, 'files': [],
                        'default_remote': default_remote})
    unpushed = 0
    # Use origin/<notebook> explicitly — tracking branch may point at master:master
    up_r = subprocess.run(['git', 'rev-list', f'origin/{notebook}..HEAD', '--count'],
                          capture_output=True, text=True, cwd=str(nb_path), timeout=5, env=env)
    if up_r.returncode == 0:
        try: unpushed = int(up_r.stdout.strip())
        except: pass
    pending_commits = []
    if unpushed:
        log_r = subprocess.run(
            ['git', 'log', f'origin/{notebook}..HEAD', '--format=%h\t%s\t%cr'],
            capture_output=True, text=True, cwd=str(nb_path), timeout=5, env=env)
        for line in log_r.stdout.splitlines():
            parts = line.split('\t', 2)
            if len(parts) == 3:
                pending_commits.append({'hash': parts[0], 'subject': parts[1], 'age': parts[2]})
    dirty_r = subprocess.run(['git', 'status', '--porcelain'],
                             capture_output=True, text=True, cwd=str(nb_path), timeout=5, env=env)
    files = [{'status': l[:2].strip(), 'path': l[3:].strip()}
             for l in dirty_r.stdout.splitlines() if l.strip()]
    return jsonify({'changes': unpushed + len(files), 'has_remote': has_remote,
                    'unpushed': unpushed, 'files': files, 'pending_commits': pending_commits})


@app.route('/api/sync', methods=['POST'])
def api_sync():
    """Sync one notebook: commit optional message, pull, push — all via explicit git."""
    data     = request.get_json() or {}
    notebook = data.get('notebook', '').strip()
    message  = data.get('message', '').strip()

    if not notebook or notebook == '_all':
        return jsonify({'success': False, 'output': 'Specify a single notebook to sync.'})
    try:
        _check_notebook(notebook)
    except ValueError as e:
        return jsonify({'success': False, 'output': str(e)}), 400

    nb_path = NB_DIR / notebook
    if not nb_path.is_dir() or not (nb_path / '.git').exists():
        return jsonify({'success': False, 'output': f'Notebook "{notebook}" not found.'})

    git_env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0',
               'GIT_ASKPASS': '/bin/true', 'NO_COLOR': '1', 'GIT_PAGER': 'cat'}

    remote_r = subprocess.run(['git', 'remote'], capture_output=True, text=True,
                              cwd=str(nb_path), timeout=5, env=git_env)
    if not remote_r.stdout.strip():
        return jsonify({
            'success': False, 'no_remote': True,
            'output': (
                f'No remote configured for notebook "{notebook}".\n\n'
                f'Notes are committed locally — nothing is lost.\n\n'
                f'To push to a remote, go to Settings → Git and run git-wire,\n'
                f'or run:  nb {notebook}:remote set <git-url>'
            )
        })

    lines = []
    git_push_ok = False

    # Optional pre-commit with user message
    if message:
        cr = subprocess.run(
            ['git', 'commit', '-a', '-m', message],
            capture_output=True, text=True, cwd=str(nb_path), env=git_env,
        )
        if cr.returncode == 0:
            lines.append(f'Committed: {message}')
        elif 'nothing to commit' not in cr.stdout + cr.stderr:
            lines.append(cr.stderr.strip() or cr.stdout.strip())

    # Pull remote notebook branch first
    try:
        pull_r = subprocess.run(
            ['git', 'pull', '--no-rebase', '--no-edit', 'origin', notebook],
            capture_output=True, text=True, cwd=str(nb_path), timeout=30, env=git_env,
        )
    except subprocess.TimeoutExpired:
        lines.append('Pull timed out after 30s')
        return jsonify({'success': False, 'output': '\n'.join(lines)})

    if pull_r.returncode != 0:
        pull_combined = pull_r.stderr + pull_r.stdout
        if 'refusing to merge unrelated histories' in pull_combined:
            # Orphan remote branch — local is authoritative, force push
            lines.append(
                f'Remote branch "{notebook}" has unrelated history — '
                f'force-pushing local commits (local is authoritative).'
            )
            try:
                fp_r = subprocess.run(
                    ['git', 'push', '--force', 'origin', f'HEAD:{notebook}'],
                    capture_output=True, text=True, cwd=str(nb_path), timeout=30, env=git_env,
                )
                git_push_ok = fp_r.returncode == 0
                msg = fp_r.stderr.strip() or fp_r.stdout.strip() or f'Force-pushed to origin/{notebook}'
                lines.append(msg if git_push_ok else f'Force-push failed: {msg}')
            except subprocess.TimeoutExpired:
                lines.append('Force-push timed out after 30s')
        else:
            lines.append(f'Pull failed: {pull_r.stderr.strip() or pull_r.stdout.strip()}')
        return jsonify({'success': git_push_ok, 'output': '\n'.join(lines)})

    pull_msg = pull_r.stdout.strip() or pull_r.stderr.strip()
    if pull_msg and pull_msg != 'Already up to date.':
        lines.append(pull_msg)

    # Push
    try:
        push_r = subprocess.run(
            ['git', 'push', 'origin', f'HEAD:{notebook}'],
            capture_output=True, text=True, cwd=str(nb_path), timeout=30, env=git_env,
        )
    except subprocess.TimeoutExpired:
        lines.append('Push timed out after 30s')
        return jsonify({'success': False, 'output': '\n'.join(lines)})

    if push_r.returncode == 0:
        git_push_ok = True
        lines.append(push_r.stderr.strip() or push_r.stdout.strip() or f'Pushed to origin/{notebook}')
    else:
        lines.append(f'Push failed: {push_r.stderr.strip()}')
        return jsonify({'success': False, 'output': '\n'.join(lines)})

    # Post-sync integrity check (C): verify no commits left unpushed
    try:
        behind_r = subprocess.run(
            ['git', 'rev-list', f'origin/{notebook}..HEAD', '--count'],
            capture_output=True, text=True, cwd=str(nb_path), timeout=5, env=git_env,
        )
        unpushed = int(behind_r.stdout.strip()) if behind_r.returncode == 0 else -1
        if unpushed > 0:
            lines.append(f'⚠ integrity check: {unpushed} commit(s) still unpushed after sync')
            git_push_ok = False
        elif unpushed == 0:
            local_files  = len([f for f in nb_path.iterdir()
                                 if not f.name.startswith('.')])
            lines.append(f'✓ verified: {local_files} files, 0 commits unpushed')
    except Exception:
        pass

    return jsonify({'success': git_push_ok, 'output': '\n'.join(lines)})


@app.route('/api/nb/sync/preview')
def api_nb_sync_preview():
    """Fetch from remote and show incoming/outgoing commits without changing anything."""
    notebook = request.args.get('notebook', '').strip()
    if not notebook:
        return jsonify({'error': 'Notebook required'})
    nb_path = NB_DIR / notebook
    if not nb_path.is_dir() or not (nb_path / '.git').exists():
        return jsonify({'error': f'Notebook "{notebook}" not found'})

    git_env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0',
               'GIT_ASKPASS': '/bin/true', 'NO_COLOR': '1', 'GIT_PAGER': 'cat'}

    remote_r = subprocess.run(['git', 'remote'], capture_output=True, text=True,
                              cwd=str(nb_path), timeout=5, env=git_env)
    if not remote_r.stdout.strip():
        return jsonify({'error': 'No remote configured for this notebook.'})

    try:
        subprocess.run(['git', 'fetch', 'origin'], capture_output=True,
                       cwd=str(nb_path), timeout=20, env=git_env)
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Fetch timed out after 20s'})

    fmt = '--format=%h  %s  (%cr)'
    incoming_r = subprocess.run(
        ['git', 'log', f'HEAD..origin/{notebook}', fmt],
        capture_output=True, text=True, cwd=str(nb_path), env=git_env)
    outgoing_r = subprocess.run(
        ['git', 'log', f'origin/{notebook}..HEAD', fmt],
        capture_output=True, text=True, cwd=str(nb_path), env=git_env)
    dirty_r = subprocess.run(
        ['git', 'status', '--porcelain'],
        capture_output=True, text=True, cwd=str(nb_path), env=git_env)

    incoming = incoming_r.stdout.strip()
    outgoing = outgoing_r.stdout.strip()
    dirty    = [l[3:].strip() for l in dirty_r.stdout.splitlines() if l.strip()]

    lines = []
    if incoming:
        n = len(incoming.splitlines())
        lines.append(f'↓ Incoming — {n} commit{"s" if n != 1 else ""} to pull:')
        lines.append(incoming)
    else:
        lines.append('↓ Incoming: none (already up to date)')

    lines.append('')

    if outgoing:
        n = len(outgoing.splitlines())
        lines.append(f'↑ Outgoing — {n} commit{"s" if n != 1 else ""} to push:')
        lines.append(outgoing)
    else:
        lines.append('↑ Outgoing: none')

    if dirty:
        lines.append('')
        lines.append(f'~ Uncommitted: {len(dirty)} file{"s" if len(dirty) != 1 else ""}  '
                     f'(will be committed with sync message if provided)')

    return jsonify({
        'output': '\n'.join(lines),
        'incoming_count': len(incoming.splitlines()) if incoming else 0,
        'outgoing_count': len(outgoing.splitlines()) if outgoing else 0,
    })


@app.route('/api/nb/git-log')
def api_nb_git_log():
    """Git log for a specific nb notebook."""
    notebook = request.args.get('notebook', '').strip()
    n        = min(int(request.args.get('n', 20)), 100)
    if not notebook or notebook == '_all':
        return jsonify({'error': 'Specify a notebook name'})
    nb_path = NB_DIR / notebook
    if not nb_path.is_dir() or not (nb_path / '.git').exists():
        return jsonify({'error': f'Notebook "{notebook}" not found or not a git repo'})
    try:
        env = {**os.environ, 'NO_COLOR': '1', 'GIT_PAGER': 'cat'}
        r = subprocess.run(
            ['git', 'log', f'-{n}', '--format=%h  %s  (%cr)'],
            capture_output=True, text=True, cwd=str(nb_path), timeout=10, env=env,
        )
        remote_r = subprocess.run(
            ['git', 'remote', '-v'], capture_output=True, text=True,
            cwd=str(nb_path), timeout=5, env=env,
        )
        remote_info = remote_r.stdout.strip() or '(no remote configured)'
        header = f'notebook: {notebook}  |  {remote_info}\n{"─" * 60}\n'
        return jsonify({'output': header + (r.stdout or '(no commits)'), 'notebook': notebook})
    except Exception as e:
        return jsonify({'error': str(e)})


@app.route('/api/nb/git-wire', methods=['POST'])
def api_nb_git_wire():
    """Configure default remote for all unremoted nb notebooks, branch = notebook name."""
    cfg = _load_settings()
    default_remote = cfg.get('default_git_remote', '').strip()
    if not default_remote:
        return jsonify({'error': 'No default_git_remote set. Add it in Settings → Git.'})

    env = {**os.environ, 'GIT_PAGER': 'cat', 'NO_COLOR': '1',
           'GIT_TERMINAL_PROMPT': '0', 'GIT_ASKPASS': '/bin/true'}
    try:
        notebooks = sorted(
            d for d in NB_DIR.iterdir()
            if d.is_dir()
            and not d.name.startswith('.')
            and not d.name.startswith('-')
            and (d / '.git').exists()
        )
    except Exception as e:
        return jsonify({'error': str(e)})

    results = []
    for nb_path in notebooks:
        name = nb_path.name
        remote_r = subprocess.run(['git', 'remote'], capture_output=True, text=True,
                                  cwd=str(nb_path), timeout=5, env=env)
        if remote_r.stdout.strip():
            url_r = subprocess.run(['git', 'remote', 'get-url', 'origin'],
                                   capture_output=True, text=True, cwd=str(nb_path), timeout=5, env=env)
            results.append({'notebook': name, 'status': 'skip',
                            'message': f'already configured → {url_r.stdout.strip()}'})
            continue

        add_r = subprocess.run(['git', 'remote', 'add', 'origin', default_remote],
                               capture_output=True, text=True, cwd=str(nb_path), timeout=10, env=env)
        if add_r.returncode != 0:
            results.append({'notebook': name, 'status': 'error', 'message': add_r.stderr.strip()})
            continue

        push_r = subprocess.run(
            ['git', 'push', '--set-upstream', 'origin', f'HEAD:{name}'],
            capture_output=True, text=True, cwd=str(nb_path), timeout=20, env=env,
        )
        if push_r.returncode == 0:
            # Fix the tracking branch so nb sync (and @{u}) uses origin/<name> not origin/master
            subprocess.run(['git', 'config', 'branch.master.merge', f'refs/heads/{name}'],
                           capture_output=True, cwd=str(nb_path), timeout=5, env=env)
            results.append({'notebook': name, 'status': 'ok',
                            'message': f'wired → {default_remote}  (branch: {name})'})
        else:
            subprocess.run(['git', 'remote', 'remove', 'origin'], capture_output=True,
                           cwd=str(nb_path), env=env)
            results.append({'notebook': name, 'status': 'error',
                            'message': (push_r.stderr or push_r.stdout).strip()})

    return jsonify({'results': results})


@app.route('/api/nb/wire-notebook', methods=['POST'])
def api_nb_wire_notebook():
    """Connect a single notebook to a remote: add origin, set tracking, push."""
    data       = request.get_json() or {}
    notebook   = data.get('notebook', '').strip()
    remote_url = data.get('remote_url', '').strip()

    if not notebook:
        return jsonify({'success': False, 'output': 'Notebook name required.'})
    try:
        _check_notebook(notebook)
    except ValueError as e:
        return jsonify({'success': False, 'output': str(e)}), 400

    nb_path = NB_DIR / notebook
    if not nb_path.is_dir() or not (nb_path / '.git').exists():
        return jsonify({'success': False, 'output': f'Notebook "{notebook}" not found.'})

    if not remote_url:
        remote_url = _load_settings().get('default_git_remote', '').strip()
    if not remote_url:
        return jsonify({'success': False,
                        'output': 'No remote URL provided and no default_git_remote set in Settings → Git.'})

    git_env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0',
               'GIT_ASKPASS': '/bin/true', 'NO_COLOR': '1', 'GIT_PAGER': 'cat'}
    lines = []

    remote_r = subprocess.run(['git', 'remote'], capture_output=True, text=True,
                              cwd=str(nb_path), timeout=5, env=git_env)
    already_had_remote = bool(remote_r.stdout.strip())

    if not already_had_remote:
        add_r = subprocess.run(['git', 'remote', 'add', 'origin', remote_url],
                               capture_output=True, text=True, cwd=str(nb_path),
                               timeout=5, env=git_env)
        if add_r.returncode != 0:
            return jsonify({'success': False,
                            'output': f'Failed to add remote: {add_r.stderr.strip()}'})
        lines.append(f'Remote added: {remote_url}')

    # Assert correct tracking config
    subprocess.run(['git', 'config', 'branch.master.merge', f'refs/heads/{notebook}'],
                   cwd=str(nb_path), timeout=5, env=git_env)
    subprocess.run(['git', 'config', 'branch.master.remote', 'origin'],
                   cwd=str(nb_path), timeout=5, env=git_env)

    try:
        push_r = subprocess.run(
            ['git', 'push', '--set-upstream', 'origin', f'HEAD:{notebook}'],
            capture_output=True, text=True, cwd=str(nb_path), timeout=30, env=git_env,
        )
    except subprocess.TimeoutExpired:
        if not already_had_remote:
            subprocess.run(['git', 'remote', 'remove', 'origin'], capture_output=True,
                           cwd=str(nb_path), env=git_env)
        return jsonify({'success': False, 'output': '\n'.join(lines) + '\nPush timed out after 30s'})

    if push_r.returncode == 0:
        lines.append(push_r.stderr.strip() or push_r.stdout.strip() or f'Pushed to origin/{notebook}')
        return jsonify({'success': True, 'output': '\n'.join(lines)})
    else:
        if not already_had_remote:
            subprocess.run(['git', 'remote', 'remove', 'origin'], capture_output=True,
                           cwd=str(nb_path), env=git_env)
        lines.append(f'Push failed: {push_r.stderr.strip()}')
        return jsonify({'success': False, 'output': '\n'.join(lines)})


@app.route('/api/nb/github-create', methods=['POST'])
def api_nb_github_create():
    """Create a new GitHub repo for a notebook via gh CLI, then add remote and push."""
    data       = request.get_json() or {}
    notebook   = data.get('notebook', '').strip()
    visibility = data.get('visibility', 'private')

    if not notebook:
        return jsonify({'success': False, 'output': 'Notebook name required.'})
    try:
        _check_notebook(notebook)
    except ValueError as e:
        return jsonify({'success': False, 'output': str(e)}), 400
    nb_path = NB_DIR / notebook
    if not nb_path.is_dir() or not (nb_path / '.git').exists():
        return jsonify({'success': False, 'output': f'Notebook "{notebook}" not found or has no git repo.'})

    env = {**os.environ, 'NO_COLOR': '1', 'GIT_TERMINAL_PROMPT': '0',
           'GIT_ASKPASS': '/bin/true', 'GIT_PAGER': 'cat'}
    lines = []

    # Get authenticated GitHub username
    user_r = subprocess.run(['gh', 'api', 'user', '--jq', '.login'],
                            capture_output=True, text=True, timeout=10, env=env)
    if user_r.returncode != 0:
        return jsonify({'success': False,
                        'output': 'gh auth check failed — run: gh auth login\n' + user_r.stderr.strip()})
    username = user_r.stdout.strip()
    full_name = f'{username}/{notebook}'

    # Create the repo
    vis_flag = '--private' if visibility == 'private' else '--public'
    create_r = subprocess.run(['gh', 'repo', 'create', full_name, vis_flag],
                              capture_output=True, text=True, timeout=30, env=env)
    if create_r.returncode != 0:
        return jsonify({'success': False,
                        'output': create_r.stderr.strip() or create_r.stdout.strip() or 'gh repo create failed'})
    lines.append(create_r.stdout.strip() or f'Created {full_name} ({visibility})')

    # Add remote (skip if already exists)
    remote_url = f'git@github.com:{full_name}.git'
    existing_r = subprocess.run(['git', 'remote'], capture_output=True, text=True,
                                cwd=str(nb_path), timeout=5, env=env)
    if not existing_r.stdout.strip():
        add_r = subprocess.run(['git', 'remote', 'add', 'origin', remote_url],
                               capture_output=True, text=True, cwd=str(nb_path), timeout=5, env=env)
        if add_r.returncode != 0:
            return jsonify({'success': False,
                            'output': '\n'.join(lines) + f'\nFailed to add remote: {add_r.stderr.strip()}'})
        lines.append(f'Remote: {remote_url}')

    # Set tracking config
    subprocess.run(['git', 'config', 'branch.master.merge', f'refs/heads/{notebook}'],
                   cwd=str(nb_path), timeout=5, env=env)
    subprocess.run(['git', 'config', 'branch.master.remote', 'origin'],
                   cwd=str(nb_path), timeout=5, env=env)

    # Push
    push_r = subprocess.run(['git', 'push', '--set-upstream', 'origin', f'HEAD:{notebook}'],
                            capture_output=True, text=True, cwd=str(nb_path), timeout=30, env=env)
    if push_r.returncode == 0:
        lines.append(push_r.stderr.strip() or f'Pushed → origin/{notebook}')
        # Set the notebook branch as the default so GitHub doesn't show an empty 'main'
        subprocess.run(
            ['gh', 'api', f'repos/{username}/{notebook}',
             '--method', 'PATCH', '--field', f'default_branch={notebook}'],
            capture_output=True, text=True, timeout=10, env=env)
        lines.append(f'Default branch set to {notebook}')
        return jsonify({'success': True, 'output': '\n'.join(lines)})
    else:
        lines.append(f'Push failed: {push_r.stderr.strip()}')
        # Roll back: remote remove so user can retry
        subprocess.run(['git', 'remote', 'remove', 'origin'], capture_output=True,
                       cwd=str(nb_path), env=env)
        return jsonify({'success': False, 'output': '\n'.join(lines)})


@app.route('/api/nb/delete-notebook', methods=['POST'])
def api_nb_delete_notebook():
    """Delete a notebook locally or its remote branch. Scope must be explicit."""
    data     = request.get_json() or {}
    notebook = data.get('notebook', '').strip()
    scope    = data.get('scope', '').strip()  # 'local' or 'remote'

    if not notebook or scope not in ('local', 'remote'):
        return jsonify({'success': False, 'output': 'notebook and scope (local|remote) required.'})
    try:
        _check_notebook(notebook)
    except ValueError as e:
        return jsonify({'success': False, 'output': str(e)}), 400

    nb_path = NB_DIR / notebook
    git_env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0',
               'GIT_ASKPASS': '/bin/true', 'NO_COLOR': '1', 'GIT_PAGER': 'cat'}

    if scope == 'remote':
        if not nb_path.is_dir() or not (nb_path / '.git').exists():
            return jsonify({'success': False, 'output': f'Notebook "{notebook}" not found locally.'})
        remote_r = subprocess.run(['git', 'remote'], capture_output=True, text=True,
                                  cwd=str(nb_path), timeout=5, env=git_env)
        if not remote_r.stdout.strip():
            return jsonify({'success': False, 'output': 'No remote configured for this notebook.'})
        try:
            r = subprocess.run(
                ['git', 'push', 'origin', '--delete', notebook],
                capture_output=True, text=True, cwd=str(nb_path), timeout=30, env=git_env,
            )
        except subprocess.TimeoutExpired:
            return jsonify({'success': False, 'output': 'Timed out after 30s'})
        msg = r.stderr.strip() or r.stdout.strip() or f'Remote branch "{notebook}" deleted.'
        return jsonify({'success': r.returncode == 0, 'output': msg})

    # scope == 'local'
    try:
        r = subprocess.run(
            [NB_BIN, 'notebooks', 'delete', notebook, '--force'],
            capture_output=True, text=True, timeout=15,
            env={**os.environ, 'NO_COLOR': '1'},
        )
        msg = r.stdout.strip() or r.stderr.strip() or f'Notebook "{notebook}" deleted.'
        return jsonify({'success': r.returncode == 0, 'output': msg})
    except subprocess.TimeoutExpired:
        return jsonify({'success': False, 'output': 'Timed out after 15s'})


# ---------------------------------------------------------------------------
# API: Notebook archive (.nbz)

_SKIP_NAMES = frozenset({'.DS_Store', 'Thumbs.db', 'desktop.ini'})
_SKIP_DIRS  = frozenset({'__pycache__', '.mypy_cache', '.ruff_cache'})


def _parse_version(v: str) -> tuple:
    """Parse 'x.y.z' → (x, y, z) for comparison; missing parts default to 0."""
    try:
        return tuple(int(x) for x in str(v).strip().split('.'))
    except Exception:
        return (0,)


def _read_plugin_meta_from_text(text: str) -> dict:
    """Like _read_plugin_meta but works on a string instead of a file."""
    meta = {'name': '', 'version': '', 'type': 'plugin', 'homepage': ''}
    for line in text.splitlines():
        if not line.startswith('//'):
            break
        m = _RE_PLUGIN_TAG.match(line)
        if m:
            tag, val = m.group(1), m.group(2)
            if tag in meta:
                meta[tag] = val
    return meta


def _installed_plugin_version(filename: str) -> str:
    """Return version string of an installed plugin JS file, or ''."""
    for search_dir in [Path(__file__).parent / 'plugins', WEB_PLUGINS_DIR]:
        path = search_dir / filename
        if path.exists():
            return _read_plugin_meta(path.resolve()).get('version', '') or ''
    return ''


def _gather_plugins_for_archive() -> list:
    """Return list of dicts: {real_path, meta} for all enabled plugins."""
    entries = []
    seen = set()
    for p in _settings.get('plugins', []):
        if not p.get('enabled', True):
            continue
        url = p.get('url', '')
        if url.startswith('/plugins/'):
            js_path = Path(__file__).parent / url.lstrip('/')
        elif url.startswith('/nb-web-plugins/'):
            js_path = WEB_PLUGINS_DIR / url.split('/')[-1]
        else:
            continue
        try:
            real_path = js_path.resolve(strict=True)
        except (OSError, RuntimeError):
            continue
        if not real_path.is_file() or real_path in seen:
            continue
        seen.add(real_path)
        entries.append({'real_path': real_path, 'meta': _read_plugin_meta(real_path)})
    return entries


def _encrypt_payload(data: bytes, password: str) -> tuple:
    """Encrypt bytes with AES-256-CBC. Returns (encrypted_bytes, None) or (None, error)."""
    proc = subprocess.run(
        ['openssl', 'enc', '-aes-256-cbc', '-pbkdf2', '-salt', '-pass', f'pass:{password}'],
        input=data, capture_output=True, timeout=60,
    )
    if proc.returncode != 0:
        return None, proc.stderr.decode(errors='replace').strip()
    return proc.stdout, None


def _decrypt_payload(data: bytes, password: str) -> tuple:
    """Decrypt AES-256-CBC bytes. Returns (decrypted_bytes, None) or (None, error)."""
    proc = subprocess.run(
        ['openssl', 'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-pass', f'pass:{password}'],
        input=data, capture_output=True, timeout=60,
    )
    if proc.returncode != 0:
        return None, 'Wrong password or corrupted archive.'
    return proc.stdout, None


def _open_nbz_inner(outer_zf: zipfile.ZipFile, password: str = '') -> tuple:
    """Return (inner_zipfile_or_None, error_str) for encrypted archives.

    For unencrypted archives the caller uses outer_zf directly — this is only
    called when meta['encrypted'] is True.  Returns (None, None) when the
    archive is encrypted but no password was provided (caller should prompt).
    """
    try:
        payload = outer_zf.read('payload.enc')
    except KeyError:
        return None, 'Encrypted archive is missing payload.enc.'
    if not password:
        return None, None   # signal: need password
    decrypted, err = _decrypt_payload(payload, password)
    if err:
        return None, err
    try:
        return zipfile.ZipFile(io.BytesIO(decrypted), 'r'), None
    except zipfile.BadZipFile:
        return None, 'Wrong password or corrupted archive.'


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def _sha256_file(path: Path) -> str | None:
    try:
        return _sha256_bytes(path.read_bytes())
    except Exception:
        return None

def _extra_action(archive_data: bytes, installed_path: Path) -> str:
    """Compare archive copy to installed copy. Returns 'new', 'current', or 'overwrite'."""
    if not installed_path.exists():
        return 'new'
    return 'current' if _sha256_bytes(archive_data) == _sha256_file(installed_path) else 'overwrite'


@app.route('/api/nb/archive', methods=['POST'])
def api_nb_archive():
    """Create a .nbz notebook archive (format 2) and stream it as a download.

    Format 2 adds optional sections alongside the notebook directory:
      plugins/       — JS plugin files for any enabled plugins
      test_scripts/  — scripts from ~/.nb/.test/
      templates/     — global templates from ~/.nb/.templates/
    """
    data              = request.get_json() or {}
    notebook          = data.get('notebook', '').strip()
    includes_git      = bool(data.get('includes_git', False))
    include_code      = bool(data.get('include_code', False))
    include_tests     = bool(data.get('include_tests', False))
    include_templates = bool(data.get('include_templates', False))
    description       = str(data.get('description', '')).strip()
    password          = str(data.get('password', '')).strip()

    try:
        _check_notebook(notebook)
    except ValueError as e:
        return jsonify({'ok': False, 'error': str(e)}), 400

    nb_path = NB_DIR / notebook
    if not nb_path.is_dir():
        return jsonify({'ok': False, 'error': f'Notebook "{notebook}" not found.'}), 404

    max_bytes = int(_settings.get('archive_max_file_mb', 50)) * 1024 * 1024

    try:
        vr = subprocess.run([NB_BIN, '--version'], capture_output=True, text=True, timeout=5)
        parts = vr.stdout.strip().split()
        nb_version = parts[-1] if vr.returncode == 0 and parts else ''
    except Exception:
        nb_version = ''

    note_count = sum(
        1 for p in nb_path.rglob('*.md')
        if p.is_file() and '.git' not in p.relative_to(nb_path).parts
    )

    # Gather extra sections before building the zip so they can go in the manifest
    plugin_entries  = _gather_plugins_for_archive() if include_code else []
    test_files      = sorted(TEST_DIR.glob('*.sh')) if include_tests and TEST_DIR.is_dir() else []
    template_files  = sorted(GLOBAL_TEMPLATES_DIR.glob('*.md')) if include_templates and GLOBAL_TEMPLATES_DIR.is_dir() else []
    # Also include notebook-local templates
    nb_tmpl_dir = nb_path / '.templates'
    if include_templates and nb_tmpl_dir.is_dir():
        seen_tmpl = {f.name for f in template_files}
        for t in sorted(nb_tmpl_dir.glob('*.md')):
            if t.name not in seen_tmpl:
                template_files.append(t)

    meta = {
        'format':            2,
        'name':              notebook,
        'archived_at':       datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'nb_version':        nb_version,
        'note_count':        note_count,
        'includes_git':      includes_git,
        'include_code':      include_code,
        'include_tests':     include_tests,
        'include_templates': include_templates,
        'encrypted':         bool(password),
        'description':       description,
        'plugins': [
            {'file': f'plugins/{e["real_path"].name}', **e['meta']}
            for e in plugin_entries
        ],
        'test_scripts': [f.name for f in test_files],
        'templates':    [f.name for f in template_files],
    }

    date_str = datetime.now().strftime('%Y%m%d')
    filename  = f'{notebook.replace(" ", "-")}-{date_str}.nbz'
    skipped   = []

    def _add_notebook_files(zf, skipped):
        for dirpath, dirnames, filenames in os.walk(str(nb_path)):
            dp      = Path(dirpath)
            rel_dir = dp.relative_to(nb_path)
            parts_d = rel_dir.parts
            if not includes_git and parts_d and parts_d[0] == '.git':
                dirnames.clear(); continue
            dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
            for fname in filenames:
                if fname in _SKIP_NAMES: continue
                fpath = dp / fname
                rel   = rel_dir / fname
                try:
                    if fpath.stat().st_size > max_bytes:
                        skipped.append(str(rel)); continue
                    zf.write(str(fpath), f'{notebook}/{rel}')
                except Exception:
                    skipped.append(str(rel))

    def _add_extras(zf, skipped):
        for entry in plugin_entries:
            try:   zf.write(str(entry['real_path']), f'plugins/{entry["real_path"].name}')
            except Exception as exc: skipped.append(f'plugins/{entry["real_path"].name}: {exc}')
        for sh in test_files:
            try:   zf.write(str(sh), f'test_scripts/{sh.name}')
            except Exception as exc: skipped.append(f'test_scripts/{sh.name}: {exc}')
        for tmpl in template_files:
            try:   zf.write(str(tmpl), f'templates/{tmpl.name}')
            except Exception as exc: skipped.append(f'templates/{tmpl.name}: {exc}')

    out_buf = io.BytesIO()
    if password:
        # Encrypted format: only the notebook notes are private.
        # plugins/, test_scripts/, templates/ stay plaintext — the archive
        # works as a full installer without the password; only note extraction needs it.
        inner_buf = io.BytesIO()
        with zipfile.ZipFile(inner_buf, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as inner_zf:
            _add_notebook_files(inner_zf, skipped)
        inner_buf.seek(0)
        encrypted_payload, enc_err = _encrypt_payload(inner_buf.read(), password)
        if enc_err:
            return jsonify({'ok': False, 'error': f'Encryption failed: {enc_err}'}), 500
        with zipfile.ZipFile(out_buf, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as ozf:
            ozf.writestr('.nb_archive', json.dumps(meta, indent=2))
            ozf.writestr('payload.enc', encrypted_payload)
            _add_extras(ozf, skipped)
    else:
        with zipfile.ZipFile(out_buf, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            zf.writestr(f'{notebook}/.nb_archive', json.dumps(meta, indent=2))
            _add_notebook_files(zf, skipped)
            _add_extras(zf, skipped)

    out_buf.seek(0)
    resp = send_file(out_buf, mimetype='application/zip',
                     as_attachment=True, download_name=filename)
    if skipped:
        resp.headers['X-Nb-Skipped'] = ','.join(skipped[:20])
    return resp


# ---------------------------------------------------------------------------
# API: Notebook import (.nbz)

@app.route('/api/nb/import-preview', methods=['POST'])
def api_nb_import_preview():
    """Read .nb_archive metadata from a .nbz upload without extracting.

    For format-2 archives, also returns plugin version comparisons,
    test script list, and template list so the UI can show install options.
    """
    f = request.files.get('archive')
    if not f:
        return jsonify({'ok': False, 'error': 'No file provided.'}), 400
    try:
        password = (request.form.get('password') or '').strip()
        buf = io.BytesIO(f.read())
        with zipfile.ZipFile(buf, 'r') as outer_zf:
            names = outer_zf.namelist()
            meta_name = next(
                (n for n in names if n.endswith('/.nb_archive') or n == '.nb_archive'),
                None,
            )
            if not meta_name:
                return jsonify({'ok': False, 'error': 'Not a valid .nbz archive (missing .nb_archive).'}), 400

            meta     = json.loads(outer_zf.read(meta_name))
            notebook = meta.get('name') or meta_name.split('/')[0]
            conflict = (NB_DIR / notebook).is_dir()

            # For encrypted archives plugins/scripts/templates are plaintext in the outer zip.
            # The password is only needed at import time to extract the notebook notes.
            zf = outer_zf

            # Enrich plugin list with installed-version comparison
            plugins_info = []
            for p in meta.get('plugins', []):
                fname     = p.get('file', '').split('/')[-1]
                inst_ver  = _installed_plugin_version(fname)
                arch_ver  = p.get('version', '')
                if not inst_ver:
                    action = 'install'
                elif _parse_version(arch_ver) > _parse_version(inst_ver):
                    action = 'upgrade'
                else:
                    action = 'current'
                plugins_info.append({**p, 'filename': fname,
                                     'installed_version': inst_ver, 'action': action})

            # Per-file comparison for test scripts and templates
            test_scripts = []
            for item in zf.infolist():
                if item.is_dir() or not item.filename.startswith('test_scripts/'): continue
                fname = item.filename.split('/')[-1]
                if not fname: continue
                data = zf.read(item.filename)
                test_scripts.append({'filename': fname,
                                     'action': _extra_action(data, TEST_DIR / fname)})
            templates = []
            for item in zf.infolist():
                if item.is_dir() or not item.filename.startswith('templates/'): continue
                fname = item.filename.split('/')[-1]
                if not fname: continue
                data = zf.read(item.filename)
                templates.append({'filename': fname,
                                  'action': _extra_action(data, GLOBAL_TEMPLATES_DIR / fname)})

            return jsonify({
                'ok':          True,
                'meta':        meta,
                'notebook':    notebook,
                'conflict':    conflict,
                'suggested':   (notebook + '-import') if conflict else notebook,
                'plugins':     plugins_info,
                'test_scripts': test_scripts,
                'templates':   templates,
            })
    except zipfile.BadZipFile:
        return jsonify({'ok': False, 'error': 'Not a valid zip file.'}), 400
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/api/nb/import-dry-run', methods=['POST'])
def api_nb_import_dry_run():
    """Simulate an import and return what would happen — no files written.

    Same parameters as /api/nb/import. Returns per-file action reports:
      notebook_files  — count + conflict check
      plugins         — install / upgrade / current / skipped
      test_scripts    — new / overwrite (per file)
      templates       — new / overwrite (per file)
    """
    f = request.files.get('archive')
    if not f:
        return jsonify({'ok': False, 'error': 'No file provided.'}), 400

    name_override = request.form.get('name', '').strip()
    password      = (request.form.get('password') or '').strip()
    try:
        install_plugins = json.loads(request.form.get('install_plugins', '[]'))
    except Exception:
        install_plugins = []
    try:
        install_tests     = json.loads(request.form.get('install_tests', '[]'))
    except Exception:
        install_tests     = []
    try:
        install_templates = json.loads(request.form.get('install_templates', '[]'))
    except Exception:
        install_templates = []

    try:
        buf = io.BytesIO(f.read())
        with zipfile.ZipFile(buf, 'r') as outer_zf:
            names     = outer_zf.namelist()
            meta_name = next(
                (n for n in names if n.endswith('/.nb_archive') or n == '.nb_archive'), None
            )
            if not meta_name:
                return jsonify({'ok': False, 'error': 'Not a valid .nbz archive.'}), 400

            meta     = json.loads(outer_zf.read(meta_name))
            src_name = meta.get('name') or meta_name.split('/')[0]
            notebook = name_override or src_name

            prefix      = src_name + '/'
            nb_dest     = NB_DIR / notebook
            nb_conflict = nb_dest.exists()

            # For encrypted archives, notebook files are in payload.enc.
            # Extras (plugins/scripts/templates) are plaintext in outer_zf either way.
            if meta.get('encrypted'):
                if password:
                    inner_zf, err = _open_nbz_inner(outer_zf, password)
                    if err:
                        return jsonify({'ok': False, 'encrypted': True, 'error': err}), 400
                    nb_names = inner_zf.namelist()
                else:
                    nb_names = []
            else:
                nb_names = [n for n in outer_zf.namelist() if n.startswith(prefix)]

            nb_files = [n for n in nb_names if n.startswith(prefix) and not n.endswith('/')]

            # Plugins
            plugins_out = []
            for p in meta.get('plugins', []):
                fname    = p.get('file', '').split('/')[-1]
                selected = (not install_plugins) or (fname in install_plugins)
                inst_ver = _installed_plugin_version(fname)
                arch_ver = p.get('version', '')
                if not selected:
                    action = 'skipped'
                elif not inst_ver:
                    action = 'install'
                elif _parse_version(arch_ver) > _parse_version(inst_ver):
                    action = 'upgrade'
                else:
                    action = 'current'
                plugins_out.append({
                    'filename':          fname,
                    'name':              p.get('name', fname),
                    'action':            action,
                    'archive_version':   arch_ver,
                    'installed_version': inst_ver,
                    'dest':              str(WEB_PLUGINS_DIR / fname) if action not in ('current', 'skipped') else '',
                })

            # Test scripts (always plaintext in outer_zf)
            scripts_out = []
            for item in outer_zf.infolist():
                if item.is_dir() or not item.filename.startswith('test_scripts/'): continue
                fname = item.filename.split('/')[-1]
                if not fname: continue
                selected = (not install_tests) or (fname in install_tests)
                data   = outer_zf.read(item.filename)
                action = _extra_action(data, TEST_DIR / fname) if selected else 'skipped'
                scripts_out.append({'filename': fname, 'action': action,
                                    'dest': str(TEST_DIR / fname)})

            # Templates (always plaintext in outer_zf)
            templates_out = []
            for item in outer_zf.infolist():
                if item.is_dir() or not item.filename.startswith('templates/'): continue
                fname = item.filename.split('/')[-1]
                if not fname: continue
                selected = (not install_templates) or (fname in install_templates)
                data   = outer_zf.read(item.filename)
                action = _extra_action(data, GLOBAL_TEMPLATES_DIR / fname) if selected else 'skipped'
                templates_out.append({'filename': fname, 'action': action,
                                      'dest': str(GLOBAL_TEMPLATES_DIR / fname)})

    except zipfile.BadZipFile:
        return jsonify({'ok': False, 'error': 'Not a valid zip file.'}), 400
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500

    return jsonify({
        'ok':                True,
        'notebook':          notebook,
        'notebook_conflict': nb_conflict,
        'notebook_dest':     str(nb_dest),
        'notebook_files':    len(nb_files),
        'plugins':           plugins_out,
        'test_scripts':      scripts_out,
        'templates':         templates_out,
    })


@app.route('/api/nb/import', methods=['POST'])
def api_nb_import():
    """Extract a .nbz archive into ~/.nb/ as a notebook.

    Format-2 extras (all optional, controlled by form fields):
      install_plugins   — JSON list of filenames, e.g. '["nbweb-hledger.js"]'
      install_tests     — 'true' to copy test_scripts/ to ~/.nb/.test/
      install_templates — 'true' to copy templates/ to ~/.nb/.templates/
    """
    global _settings
    f             = request.files.get('archive')
    name_override = request.form.get('name', '').strip()
    password      = (request.form.get('password') or '').strip()
    if not f:
        return jsonify({'ok': False, 'error': 'No file provided.'}), 400

    try:
        install_plugins   = json.loads(request.form.get('install_plugins', '[]'))
    except Exception:
        install_plugins   = []
    try:
        install_tests     = json.loads(request.form.get('install_tests', '[]'))
    except Exception:
        install_tests     = []
    try:
        install_templates = json.loads(request.form.get('install_templates', '[]'))
    except Exception:
        install_templates = []

    dest = None
    installed_plugins  = []
    copied_tests       = []
    copied_templates   = []

    try:
        buf = io.BytesIO(f.read())
        with zipfile.ZipFile(buf, 'r') as outer_zf:
            names     = outer_zf.namelist()
            meta_name = next(
                (n for n in names if n.endswith('/.nb_archive') or n == '.nb_archive'),
                None,
            )
            if not meta_name:
                return jsonify({'ok': False, 'error': 'Not a valid .nbz archive.'}), 400

            meta     = json.loads(outer_zf.read(meta_name))
            src_name = meta.get('name') or meta_name.split('/')[0]
            notebook = name_override or src_name

            try:
                _check_notebook(notebook)
            except ValueError as e:
                return jsonify({'ok': False, 'error': str(e)}), 400

            dest = NB_DIR / notebook
            if dest.exists():
                return jsonify({'ok': False, 'error': f'Notebook "{notebook}" already exists.', 'conflict': True}), 409

            prefix = src_name + '/'

            # Notebook extraction — encrypted archives use inner zip, unencrypted use outer
            if meta.get('encrypted'):
                if not password:
                    return jsonify({'ok': False, 'encrypted': True, 'error': 'Archive is encrypted — provide password.'}), 400
                nb_zf, err = _open_nbz_inner(outer_zf, password)
                if err:
                    return jsonify({'ok': False, 'encrypted': True, 'error': err}), 400
            else:
                nb_zf = outer_zf

            dest.mkdir(parents=True)
            for item in nb_zf.infolist():
                if item.is_dir() or not item.filename.startswith(prefix):
                    continue
                if item.filename == meta_name:
                    continue
                rel = item.filename[len(prefix):]
                if not rel or rel.startswith('/'):
                    continue
                target = dest / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(nb_zf.read(item.filename))

            # Install plugins — always plaintext in outer_zf
            if install_plugins:
                WEB_PLUGINS_DIR.mkdir(parents=True, exist_ok=True)
                current_plugins = list(_settings.get('plugins', []))
                for item in outer_zf.infolist():
                    if item.is_dir() or not item.filename.startswith('plugins/'):
                        continue
                    fname = item.filename.split('/')[-1]
                    if fname not in install_plugins:
                        continue
                    content    = outer_zf.read(item.filename)
                    pmeta      = _read_plugin_meta_from_text(content.decode('utf-8', errors='replace'))
                    stored_url = f'/nb-web-plugins/{fname}'
                    dest_file  = WEB_PLUGINS_DIR / fname
                    dest_file.write_bytes(content)
                    existing = next((p for p in current_plugins if p['url'] == stored_url), None)
                    if existing:
                        existing.update({'name': pmeta['name'] or fname[:-3], 'version': pmeta['version'],
                                         'type': pmeta['type'], 'homepage': pmeta['homepage']})
                    else:
                        current_plugins.append({
                            'url':      stored_url,
                            'name':     pmeta['name'] or fname[:-3],
                            'enabled':  True,
                            'type':     pmeta['type'] or 'plugin',
                            'homepage': pmeta['homepage'],
                        })
                    installed_plugins.append(fname)
                if installed_plugins:
                    _save_settings({'plugins': current_plugins})
                    _settings = _load_settings()

            # Copy test scripts — always plaintext in outer_zf
            if install_tests:
                TEST_DIR.mkdir(parents=True, exist_ok=True)
                for item in outer_zf.infolist():
                    if item.is_dir() or not item.filename.startswith('test_scripts/'): continue
                    fname = item.filename.split('/')[-1]
                    if not fname or fname not in install_tests: continue
                    target = TEST_DIR / fname
                    target.write_bytes(outer_zf.read(item.filename))
                    target.chmod(0o755)
                    copied_tests.append(fname)

            # Copy templates — always plaintext in outer_zf
            if install_templates:
                GLOBAL_TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
                for item in outer_zf.infolist():
                    if item.is_dir() or not item.filename.startswith('templates/'): continue
                    fname = item.filename.split('/')[-1]
                    if not fname or fname not in install_templates: continue
                    target = GLOBAL_TEMPLATES_DIR / fname
                    target.write_bytes(outer_zf.read(item.filename))
                    copied_templates.append(fname)

    except zipfile.BadZipFile:
        if dest and dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        return jsonify({'ok': False, 'error': 'Not a valid zip file.'}), 400
    except Exception as e:
        if dest and dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        return jsonify({'ok': False, 'error': str(e)}), 500

    # Write import-stamped metadata
    import_meta = {**meta, 'name': notebook,
                   'imported_at': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')}
    (dest / '.nb_archive').write_text(json.dumps(import_meta, indent=2))

    run_nb('index', 'reconcile', f'{notebook}:')

    if not (dest / '.git').exists():
        git_env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_ASKPASS': '/bin/true'}
        subprocess.run(['git', 'init'],      cwd=str(dest), capture_output=True, env=git_env)
        subprocess.run(['git', 'add', '-A'], cwd=str(dest), capture_output=True, env=git_env)
        subprocess.run(['git', 'commit', '-m', f'[nb] Import: {notebook}'],
                       cwd=str(dest), capture_output=True, env=git_env)

    return jsonify({
        'ok':                True,
        'notebook':          notebook,
        'note_count':        meta.get('note_count', '?'),
        'installed_plugins': installed_plugins,
        'copied_tests':      copied_tests,
        'copied_templates':  copied_templates,
    })


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

    if notebook and notebook != '_all' and not _safe_notebook(notebook):
        return jsonify({'error': 'invalid notebook'}), 400
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
        proc    = subprocess.run(rg_args, capture_output=True, text=True, timeout=30)
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
# API: nb-config — git repo at ~/.nb/ tracking dotfolders + global templates
# ---------------------------------------------------------------------------

_NB_CONFIG_ENV = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_ASKPASS': '/bin/true',
                  'GIT_PAGER': 'cat', 'NO_COLOR': '1'}

def _nb_config_git(*args, timeout=10):
    return subprocess.run(['git', *args], cwd=str(NB_DIR), capture_output=True,
                          text=True, timeout=timeout, env=_NB_CONFIG_ENV)

def _nb_config_level_check():
    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), 'admin'):
        return jsonify({'error': 'Admin access required'}), 403
    return None

@app.route('/api/nb-config/status')
def api_nb_config_status():
    err = _nb_config_level_check()
    if err: return err
    status_r  = _nb_config_git('status', '--porcelain')
    remote_r  = _nb_config_git('remote', 'get-url', 'origin')
    log_r     = _nb_config_git('log', '--oneline', '-1')
    unpushed_r = _nb_config_git('rev-list', 'origin/master..HEAD', '--count')
    files = []
    for line in status_r.stdout.splitlines():
        if line.strip():
            files.append({'status': line[:2].strip(), 'path': line[3:]})
    return jsonify({
        'files':      files,
        'has_remote': remote_r.returncode == 0,
        'remote':     remote_r.stdout.strip() if remote_r.returncode == 0 else '',
        'last_commit': log_r.stdout.strip(),
        'unpushed':   int(unpushed_r.stdout.strip()) if unpushed_r.returncode == 0 else 0,
    })

@app.route('/api/nb-config/commit', methods=['POST'])
def api_nb_config_commit():
    err = _nb_config_level_check()
    if err: return err
    msg = (request.get_json() or {}).get('message', '').strip() or '[nb-config] Update'
    _nb_config_git('add', '.users', '.tools', '.changes', '.images', '.rules', '.templates')
    r = _nb_config_git('commit', '-m', msg)
    return jsonify({'success': r.returncode == 0, 'output': r.stdout + r.stderr})

@app.route('/api/nb-config/sync', methods=['POST'])
def api_nb_config_sync():
    err = _nb_config_level_check()
    if err: return err
    remote_r = _nb_config_git('remote', 'get-url', 'origin')
    if remote_r.returncode != 0:
        return jsonify({'error': 'No remote configured'}), 400
    pull_r = _nb_config_git('pull', '--no-edit', 'origin', 'master', timeout=30)
    push_r = _nb_config_git('push', 'origin', 'HEAD:master', timeout=30)
    return jsonify({
        'success': push_r.returncode == 0,
        'output':  pull_r.stdout + pull_r.stderr + push_r.stdout + push_r.stderr,
    })

@app.route('/api/nb-config/remote', methods=['GET', 'POST'])
def api_nb_config_remote():
    err = _nb_config_level_check()
    if err: return err
    if request.method == 'GET':
        r = _nb_config_git('remote', 'get-url', 'origin')
        return jsonify({'remote': r.stdout.strip() if r.returncode == 0 else ''})
    url = (request.get_json() or {}).get('url', '').strip()
    if not url:
        return jsonify({'error': 'url required'}), 400
    # Replace or add remote
    _nb_config_git('remote', 'remove', 'origin')
    r = _nb_config_git('remote', 'add', 'origin', url)
    return jsonify({'success': r.returncode == 0, 'output': r.stderr})

@app.route('/api/nb-config/log')
def api_nb_config_log():
    err = _nb_config_level_check()
    if err: return err
    r = _nb_config_git('log', '--oneline', '-20')
    return jsonify({'log': r.stdout.strip()})


# ---------------------------------------------------------------------------
# API: Cal — return structured dated-note entries for a date range
# ---------------------------------------------------------------------------

@app.route('/api/nb/notebooks')
def api_nb_notebooks():
    """List all notebooks with note counts, mtimes, git sync status, and current marker."""
    notebooks = []
    env = {**os.environ, 'NO_COLOR': '1', 'GIT_TERMINAL_PROMPT': '0', 'GIT_PAGER': 'cat'}
    current_nb = 'home'
    try:
        cur_path = NB_DIR / '.current'
        if cur_path.exists():
            current_nb = cur_path.read_text().strip() or 'home'
    except Exception:
        pass
    try:
        for entry in sorted(NB_DIR.iterdir()):
            if not entry.is_dir() or entry.name.startswith('.'):
                continue
            index_path = entry / '.index'
            count = 0
            mtime = entry.stat().st_mtime
            if index_path.exists():
                lines = [l for l in index_path.read_text().splitlines() if l.strip()]
                count = len(lines)
                mtime = max(mtime, index_path.stat().st_mtime)

            folder_count = sum(1 for c in entry.iterdir()
                               if c.is_dir() and not c.name.startswith('.'))

            has_remote = False
            unpushed   = 0
            if (entry / '.git').exists():
                remote_r = subprocess.run(['git', 'remote'], capture_output=True, text=True,
                                          cwd=str(entry), timeout=3, env=env)
                has_remote = bool(remote_r.stdout.strip())
                if has_remote:
                    up_r = subprocess.run(
                        ['git', 'rev-list', f'origin/{entry.name}..HEAD', '--count'],
                        capture_output=True, text=True, cwd=str(entry), timeout=3, env=env)
                    if up_r.returncode == 0:
                        try: unpushed = int(up_r.stdout.strip())
                        except: pass

            website = None
            website_json = entry / '.nb-website.json'
            if website_json.exists():
                try:
                    website = json.loads(website_json.read_text())
                except Exception:
                    website = {}

            cine = None
            cine_json = entry / '.nb-cine.json'
            if cine_json.exists():
                try:
                    cine = json.loads(cine_json.read_text())
                except Exception:
                    cine = {}

            hledger = None
            hledger_json = entry / '.nb-hledger.json'
            if hledger_json.exists():
                try:
                    hledger = json.loads(hledger_json.read_text())
                except Exception:
                    hledger = {}

            notebooks.append({
                'name': entry.name, 'count': count, 'mtime': mtime,
                'folder_count': folder_count,
                'has_remote': has_remote, 'unpushed': unpushed,
                'is_current': entry.name == current_nb,
                'website': website,
                'cine': cine,
                'hledger': hledger,
                'locked': (entry / '.nb-lock').exists(),
            })
    except Exception as e:
        return jsonify({'error': str(e), 'notebooks': []})
    notebooks.sort(key=lambda n: n['mtime'], reverse=True)
    user = session.get('user', {})
    user_level = user.get('level', '')
    notebooks = [n for n in notebooks
                 if _level_gte(user_level, _effective_access({}, _notebook_config(n['name'])))]
    if _level_gte(user_level, 'admin'):
        for df in DOTFOLDERS:
            df_path = NB_DIR / df
            if not df_path.is_dir():
                continue
            count = sum(1 for f in df_path.iterdir()
                        if f.is_file() and not f.name.startswith('.'))
            mtime = df_path.stat().st_mtime
            notebooks.append({
                'name': df, 'count': count, 'mtime': mtime,
                'virtual': True, 'dot': True,
                'has_remote': False, 'unpushed': 0, 'folder_count': 0,
                'is_current': False, 'website': None, 'cine': None,
                'hledger': None, 'locked': False,
            })
    return jsonify({'notebooks': notebooks, 'current_notebook': current_nb})


@app.route('/api/website/config', methods=['GET', 'POST'])
def api_website_config():
    notebook = request.args.get('notebook') or (request.get_json() or {}).get('notebook', '')
    try:
        _check_notebook(notebook)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    nb_path = NB_DIR / notebook
    cfg_path = nb_path / '.nb-website.json'
    if request.method == 'GET':
        if cfg_path.exists():
            return jsonify(json.loads(cfg_path.read_text()))
        return jsonify({})
    data = {k: v for k, v in (request.get_json() or {}).items() if k != 'notebook'}
    cfg_path.write_text(json.dumps(data, indent=2) + '\n')
    env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
    subprocess.run(['git', '-C', str(nb_path), 'add', '.nb-website.json'],
                   capture_output=True, env=env)
    subprocess.run(['git', '-C', str(nb_path), 'commit', '-m', '[nb] Update .nb-website.json'],
                   capture_output=True, env=env)
    return jsonify({'ok': True})


@app.route('/api/website/deploy', methods=['POST'])
def api_website_deploy():
    data = request.get_json() or {}
    notebook = data.get('notebook', '')
    try:
        _check_notebook(notebook)
    except ValueError as e:
        return jsonify({'ok': False, 'output': str(e)}), 400
    cfg_path = NB_DIR / notebook / '.nb-website.json'
    if not cfg_path.exists():
        return jsonify({'ok': False, 'output': 'No .nb-website.json found for this notebook.'})
    try:
        cfg = json.loads(cfg_path.read_text())
    except Exception as e:
        return jsonify({'ok': False, 'output': f'Bad .nb-website.json: {e}'})
    quartz_path = Path(cfg.get('quartz_path', '')).expanduser()
    deploy_cmd  = cfg.get('deploy_command', 'npx quartz sync')
    if not quartz_path.is_dir():
        return jsonify({'ok': False, 'output': f'Quartz path not found: {quartz_path}'})
    # Prepend nvm's node bin so deploy commands (npx quartz) use node v22+
    nvm_node = Path.home() / '.nvm' / 'versions' / 'node'
    node_bins = sorted(nvm_node.glob('*/bin'), reverse=True)  # newest first
    extra_path = ':'.join(str(p) for p in node_bins)
    env = {**os.environ, 'NO_COLOR': '1', 'FORCE_COLOR': '0'}
    if extra_path:
        env['PATH'] = extra_path + ':' + env.get('PATH', '')
    try:
        r = subprocess.run(
            deploy_cmd, shell=True, capture_output=True, text=True,
            cwd=str(quartz_path), timeout=180, env=env
        )
        output = (r.stdout + r.stderr).strip()
        return jsonify({'ok': r.returncode == 0, 'output': output})
    except subprocess.TimeoutExpired:
        return jsonify({'ok': False, 'output': 'Deploy timed out after 3 minutes.'})
    except Exception as e:
        return jsonify({'ok': False, 'output': str(e)})


@app.route('/api/website/summary')
def api_website_summary():
    notebook  = request.args.get('notebook', '')
    summary_path = NB_DIR / notebook / '.nb-website-summary.md'
    if not summary_path.exists():
        return jsonify({'ok': False, 'markdown': ''})
    return jsonify({'ok': True, 'markdown': summary_path.read_text()})


@app.route('/api/nb/plugin-help')
def api_nb_plugin_help():
    """Extract comment-header help text from an installed nb CLI plugin."""
    import re as _re
    name = request.args.get('name', '')
    if not name or '/' in name or '..' in name:
        return jsonify({'ok': False, 'text': ''}), 400
    plugin_path = NB_DIR / '.plugins' / name
    if not plugin_path.exists():
        return jsonify({'ok': False, 'text': ''}), 404

    lines = plugin_path.read_text(errors='replace').splitlines()
    comment_lines = []
    started = False
    for line in lines:
        if line.startswith('#!'):
            continue
        if line.startswith('#'):
            started = True
            comment_lines.append(line)
        elif line.strip() == '' and started:
            comment_lines.append('')
        else:
            if started:
                break

    while comment_lines and comment_lines[-1] == '':
        comment_lines.pop()

    cleaned = []
    for line in comment_lines:
        if _re.match(r'^#{3,}\s*$', line):
            continue
        if line.startswith('# '):
            cleaned.append(line[2:])
        elif line == '#':
            cleaned.append('')
        else:
            cleaned.append(line.lstrip('#').lstrip())

    text = '\n'.join(cleaned).strip()
    return jsonify({'ok': True, 'text': text})


@app.route('/api/nb/file-exists')
def api_nb_file_exists():
    notebook = request.args.get('notebook', '')
    filename = request.args.get('filename', '')
    relpath  = request.args.get('relpath', '')   # full relative path from notebook root (may contain /)
    if not notebook:
        return jsonify({'exists': False}), 400
    nb_path = NB_DIR / notebook
    if relpath:
        path = nb_path / relpath
    elif filename:
        if '/' in filename or '..' in filename:
            return jsonify({'exists': False}), 400
        path = nb_path / filename
    else:
        return jsonify({'exists': False}), 400
    try:
        path.relative_to(nb_path)
    except ValueError:
        return jsonify({'exists': False}), 400
    return jsonify({'exists': path.exists()})


@app.route('/api/nb/create-from-template', methods=['POST'])
def api_nb_create_from_template():
    data     = request.get_json() or {}
    notebook = data.get('notebook', '')
    filename = data.get('filename', '')
    content  = data.get('content', '')
    scope    = data.get('scope', '')  # '' (singleton) | 'notebook' | 'folder:X'

    if not notebook or not filename or '/' in filename or '..' in filename:
        return jsonify({'ok': False, 'error': 'invalid parameters'}), 400
    try:
        _check_notebook(notebook)
    except ValueError as e:
        return jsonify({'ok': False, 'error': str(e)}), 400

    nb_path = NB_DIR / notebook
    if not nb_path.is_dir():
        return jsonify({'ok': False, 'error': f'notebook not found: {notebook}'}), 404

    # Compute target directory and git-relative path from scope
    if scope.startswith('folder:'):
        folder = scope.split(':', 1)[1].strip('/')
        if not folder or '..' in folder:
            return jsonify({'ok': False, 'error': 'invalid folder in scope'}), 400
        dest_dir  = nb_path / folder / '.templates'
        git_relp  = f'{folder}/.templates/{filename}'
        is_seed   = True
    elif scope == 'notebook':
        dest_dir  = nb_path / '.templates'
        git_relp  = f'.templates/{filename}'
        is_seed   = True
    else:
        dest_dir  = nb_path
        git_relp  = filename
        is_seed   = False

    dest = dest_dir / filename
    try:
        dest.relative_to(nb_path)
    except ValueError:
        return jsonify({'ok': False, 'error': 'path traversal rejected'}), 400

    if dest.exists():
        return jsonify({'ok': False, 'error': f'{filename} already exists'}), 409

    dest_dir.mkdir(parents=True, exist_ok=True)
    dest.write_text(content, encoding='utf-8')

    if not is_seed:
        # Singleton notes live in the notebook root — register with nb's index
        run_nb('index', 'add', filename, '--notebook', notebook)

    commit_msg = f'[nb] Seed template: {filename}' if is_seed else f'[nb] Add: {filename}'
    subprocess.run(['git', '-C', str(nb_path), 'add', git_relp], capture_output=True)
    subprocess.run(['git', '-C', str(nb_path), 'commit', '-m', commit_msg], capture_output=True)

    return jsonify({'ok': True, 'path': str(dest)})


@app.route('/api/website/publish', methods=['POST'])
def api_website_publish():
    import re as _re
    data     = request.get_json() or {}
    notebook = data.get('notebook', '')
    nb_path  = NB_DIR / notebook
    cfg_path = nb_path / '.nb-website.json'
    if not cfg_path.exists():
        return jsonify({'ok': False, 'output': 'No .nb-website.json found for this notebook.'})
    try:
        cfg = json.loads(cfg_path.read_text())
    except Exception as e:
        return jsonify({'ok': False, 'output': f'Bad .nb-website.json: {e}'})

    env   = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
    parts = []

    # Push nb notebook so GitHub has the latest content
    push = subprocess.run(
        ['git', '-C', str(nb_path), 'push', 'origin', f'HEAD:{notebook}'],
        capture_output=True, text=True, env=env, timeout=60,
    )
    push_out = (push.stdout + push.stderr).strip()
    parts.append('notebook push:\n' + (push_out or '(nothing to push)'))

    # Resolve quartz_path and github_repo
    quartz_path = Path(cfg.get('quartz_path', '')).expanduser()
    github_repo = cfg.get('github_repo', '').strip()
    if not github_repo and quartz_path.is_dir():
        r = subprocess.run(
            ['git', '-C', str(quartz_path), 'remote', 'get-url', 'origin'],
            capture_output=True, text=True,
        )
        m = _re.search(r'[:/]([^/:]+/[^/]+?)(?:\.git)?$', r.stdout.strip())
        if m:
            github_repo = m.group(1)

    if not github_repo:
        parts.append('Could not detect GitHub repo. Add a "github_repo" field in Settings.')
        return jsonify({'ok': False, 'output': '\n\n'.join(parts)})

    # Push Quartz config repo so the workflow builds from the latest components/CSS
    if quartz_path.is_dir():
        qpush = subprocess.run(
            ['git', '-C', str(quartz_path), 'push', 'origin', 'main'],
            capture_output=True, text=True, env=env, timeout=60,
        )
        qpush_out = (qpush.stdout + qpush.stderr).strip()
        parts.append('quartz config push:\n' + (qpush_out or '(nothing to push)'))
    else:
        parts.append('quartz config push:\n(quartz_path not set or not found — skipped)')

    # Trigger immediate workflow dispatch
    gh = subprocess.run(
        ['gh', 'workflow', 'run', 'deploy.yml', '--repo', github_repo],
        capture_output=True, text=True, timeout=30,
    )
    gh_out = (gh.stdout + gh.stderr).strip()
    parts.append(f'workflow dispatch ({github_repo}):\n' + (gh_out or 'triggered'))

    # Grab the run ID so the frontend can poll build status
    run_id = None
    if gh.returncode == 0:
        import time as _time
        _time.sleep(3)
        list_r = subprocess.run(
            ['gh', 'run', 'list', '--workflow', 'deploy.yml', '--repo', github_repo,
             '--limit', '3', '--json', 'databaseId,status'],
            capture_output=True, text=True, timeout=15,
        )
        if list_r.returncode == 0:
            runs = json.loads(list_r.stdout or '[]')
            if runs:
                run_id = str(runs[0]['databaseId'])

    ok = push.returncode == 0 and gh.returncode == 0
    return jsonify({'ok': ok, 'output': '\n\n'.join(parts),
                    'run_id': run_id, 'github_repo': github_repo})


@app.route('/api/website/build-status')
def api_website_build_status():
    run_id = request.args.get('run_id', '').strip()
    repo   = request.args.get('repo', '').strip()
    if not run_id or not repo:
        return jsonify({'error': 'run_id and repo required'}), 400
    r = subprocess.run(
        ['gh', 'run', 'view', run_id, '--repo', repo,
         '--json', 'status,conclusion,url'],
        capture_output=True, text=True, timeout=15,
    )
    if r.returncode != 0:
        return jsonify({'status': 'unknown', 'conclusion': None})
    data = json.loads(r.stdout)
    if data.get('conclusion') == 'failure':
        log_r = subprocess.run(
            ['gh', 'run', 'view', run_id, '--repo', repo, '--log-failed'],
            capture_output=True, text=True, timeout=30,
        )
        lines = log_r.stdout.splitlines()
        error_lines = [l for l in lines if 'ERROR' in l or 'Failed to process' in l or 'Error' in l]
        data['error_excerpt'] = '\n'.join(error_lines[-6:]) if error_lines else log_r.stdout[-600:]
    return jsonify(data)


@app.route('/api/nb/use', methods=['POST'])
def api_nb_use():
    """Call 'nb use <notebook>' to set nb's current notebook persistently."""
    data     = request.get_json() or {}
    notebook = data.get('notebook', '').strip()
    if not notebook:
        return jsonify({'success': False, 'error': 'notebook required'})
    nb_path = NB_DIR / notebook
    if not nb_path.is_dir():
        return jsonify({'success': False, 'error': f'Notebook "{notebook}" not found'})
    try:
        r = subprocess.run(
            ['nb', 'use', notebook],
            capture_output=True, text=True, timeout=10,
            env={**os.environ, 'NO_COLOR': '1'},
        )
        if r.returncode == 0:
            return jsonify({'success': True})
        return jsonify({'success': False, 'error': r.stderr.strip() or r.stdout.strip()})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/api/nb/notebook-detail')
def api_nb_notebook_detail():
    """Detailed info for one notebook: git status, note count, stored prefs."""
    notebook = request.args.get('notebook', '').strip()
    if not notebook:
        return jsonify({'error': 'notebook required'})
    nb_path = NB_DIR / notebook
    if not nb_path.is_dir():
        return jsonify({'error': f'Notebook "{notebook}" not found'})

    # Note count
    index_path = nb_path / '.index'
    count = 0
    mtime = nb_path.stat().st_mtime
    if index_path.exists():
        lines = [l for l in index_path.read_text().splitlines() if l.strip()]
        count = len(lines)
        mtime = max(mtime, index_path.stat().st_mtime)

    # Git info
    git_info = {'has_git': False, 'has_remote': False, 'remote_url': '',
                'branch': '', 'unpushed': 0, 'last_commit': None}
    if (nb_path / '.git').exists():
        git_info['has_git'] = True
        env = {**os.environ, 'NO_COLOR': '1', 'GIT_TERMINAL_PROMPT': '0', 'GIT_PAGER': 'cat'}

        remote_r = subprocess.run(['git', 'remote', 'get-url', 'origin'],
                                  capture_output=True, text=True, cwd=str(nb_path),
                                  timeout=5, env=env)
        if remote_r.returncode == 0:
            git_info['has_remote'] = True
            git_info['remote_url'] = remote_r.stdout.strip()

        branch_r = subprocess.run(['git', 'branch', '--show-current'],
                                  capture_output=True, text=True, cwd=str(nb_path),
                                  timeout=5, env=env)
        git_info['branch'] = branch_r.stdout.strip()

        if git_info['has_remote']:
            up_r = subprocess.run(
                ['git', 'rev-list', f'origin/{notebook}..HEAD', '--count'],
                capture_output=True, text=True, cwd=str(nb_path), timeout=5, env=env)
            if up_r.returncode == 0:
                try: git_info['unpushed'] = int(up_r.stdout.strip())
                except: pass

        log_r = subprocess.run(
            ['git', 'log', '-1', '--format=%h\t%s\t%cr'],
            capture_output=True, text=True, cwd=str(nb_path), timeout=5, env=env)
        if log_r.returncode == 0 and log_r.stdout.strip():
            parts = log_r.stdout.strip().split('\t', 2)
            if len(parts) == 3:
                git_info['last_commit'] = {'hash': parts[0], 'subject': parts[1], 'age': parts[2]}

    cfg = _load_settings()
    nb_prefs = cfg.get('notebook_prefs', {}).get(notebook, {})
    default_remote = cfg.get('default_git_remote', '').strip()

    lk_path = nb_path / '.nb-lock'
    nb_locked = lk_path.exists()
    nb_lock_reason = lk_path.read_text(errors='replace').strip() or None if nb_locked else None

    return jsonify({
        'name': notebook, 'count': count, 'mtime': mtime,
        'path': str(nb_path),
        'git': git_info,
        'prefs': nb_prefs,
        'default_remote': default_remote,
        'locked': nb_locked,
        'lock_reason': nb_lock_reason,
    })


@app.route('/api/nb/notebook-config', methods=['GET', 'PUT'])
def api_nb_notebook_config():
    """Read or write .<notebook>.md — the per-notebook config file."""
    if request.method == 'GET':
        notebook = request.args.get('notebook', '').strip()
    else:
        notebook = (request.get_json() or {}).get('notebook', '').strip()
    if not notebook or not _safe_notebook(notebook):
        return jsonify(error='invalid notebook'), 400
    config_path = NB_DIR / notebook / f'.{notebook}.md'
    if request.method == 'GET':
        if config_path.exists():
            raw = config_path.read_text(errors='replace')
            try:
                meta, _ = parse_frontmatter(raw)
            except Exception:
                meta = {}
            return jsonify(content=raw, exists=True, meta=meta)
        return jsonify(content='---\n# access: guest\n---\n', exists=False, meta={})
    # PUT — admin+ only
    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), 'admin'):
        return jsonify(error='forbidden'), 403
    content = (request.get_json() or {}).get('content', '')
    try:
        config_path.write_text(content)
        return jsonify(ok=True)
    except OSError as e:
        return jsonify(error=str(e)), 500


@app.route('/api/nb/notebook-prefs', methods=['POST'])
def api_nb_notebook_prefs():
    """Save per-notebook preferences."""
    data     = request.get_json() or {}
    notebook = data.get('notebook', '').strip()
    prefs    = data.get('prefs', {})
    if not notebook:
        return jsonify({'success': False, 'error': 'notebook required'})
    cfg = _load_settings()
    nb_prefs = dict(cfg.get('notebook_prefs', {}))
    nb_prefs[notebook] = {**nb_prefs.get(notebook, {}), **prefs}
    try:
        _save_settings({'notebook_prefs': nb_prefs})
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


_GIT_ALLOWED = {'log', 'status', 'diff', 'show', 'branch', 'shortlog',
                 'stash', 'tag', 'describe', 'ls-files', 'remote'}

@app.route('/api/nb/git')
def api_nb_git():
    """Run a read-only git command in a configured repo alias."""
    repo_alias = request.args.get('repo', '').strip()
    args_raw   = request.args.get('args', '').strip()
    cfg   = _load_settings()
    repos = cfg.get('git_repos', {})
    if not repo_alias:
        return jsonify({'error': 'No repo specified'})
    if repo_alias not in repos:
        known = ', '.join(repos.keys()) or 'none configured'
        return jsonify({'error': f'Unknown repo "{repo_alias}". Known: {known}. Add to git_repos in settings.'})
    repo_path = repos[repo_alias]
    if not Path(repo_path).is_dir():
        return jsonify({'error': f'Repo path not found: {repo_path}'})
    try:
        parts = shlex.split(args_raw) if args_raw else []
    except ValueError as e:
        return jsonify({'error': f'Bad arguments: {e}'})
    if not parts:
        return jsonify({'error': 'No git subcommand given (e.g. "log --oneline -10")'})
    subcmd = parts[0]
    if subcmd not in _GIT_ALLOWED:
        return jsonify({'error': f'git {subcmd} not allowed. Permitted: {", ".join(sorted(_GIT_ALLOWED))}'})
    try:
        env = {**os.environ, 'GIT_PAGER': 'cat', 'NO_COLOR': '1', 'TERM': 'dumb'}
        r = subprocess.run(
            ['git', '-C', repo_path] + parts,
            capture_output=True, text=True, timeout=10, env=env,
        )
        output = r.stdout or r.stderr or '(no output)'
        return jsonify({'output': output, 'repo': repo_alias, 'path': repo_path})
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'git command timed out'})
    except Exception as e:
        return jsonify({'error': str(e)})


@app.route('/api/nb/backlinks')
def api_nb_backlinks():
    """Find notes that wiki-link to the given title, using ripgrep for speed."""
    title    = request.args.get('title', '').strip()
    self_sel = request.args.get('selector', '').strip()
    limit    = min(int(request.args.get('limit', 20)), 100)
    if not title:
        return jsonify({'backlinks': []})

    pattern = f'[[{title}]]'
    try:
        proc = subprocess.run(
            ['rg', '--fixed-strings', '-l',
             '--glob=!.git', '--glob=!.index',
             '--glob=!*.{jpg,jpeg,png,gif,pdf,mp4,mp3,wav,zip}',
             pattern, str(NB_DIR)],
            capture_output=True, text=True, timeout=15,
        )
        files = proc.stdout.splitlines()
    except FileNotFoundError:
        # rg not available — fall back to nb search
        r = run_nb('search', pattern, '--all', '--list')
        sel_pat = re.compile(r'^\[([^\]]+)\]\s+(.+)$')
        backlinks, seen = [], set()
        for line in strip_ansi(r['stdout']).splitlines():
            m = sel_pat.match(line.strip())
            if not m: continue
            raw_sel   = m.group(1).strip()
            hit_title = m.group(2).strip()
            nb_part   = raw_sel.split(':')[0] if ':' in raw_sel else ''
            selector  = raw_sel
            if (self_sel and selector == self_sel) or selector in seen: continue
            seen.add(selector)
            backlinks.append({'selector': selector, 'notebook': nb_part, 'title': hit_title})
            if len(backlinks) >= limit: break
        return jsonify({'backlinks': backlinks})

    backlinks, seen = [], set()
    for filepath in files:
        if len(backlinks) >= limit:
            break
        p = Path(filepath)
        try:
            rel     = p.relative_to(NB_DIR)
            parts   = rel.parts
            if len(parts) < 2:
                continue
            nb_name = parts[0]
            fname   = parts[-1]
            if fname.startswith('.'):
                continue
            # Build selector via .index for numeric ID
            idx = read_index(nb_name)
            selector = f"{nb_name}:{idx.index(fname) + 1}" if fname in idx else f"{nb_name}:{fname}"
            if (self_sel and selector == self_sel) or selector in seen:
                continue
            seen.add(selector)
            # Derive title from file
            try:
                _, body = parse_frontmatter(p.read_text(errors='replace'))
                hit_title = note_title(fname, body)
            except Exception:
                hit_title = fname
            backlinks.append({'selector': selector, 'notebook': nb_name, 'title': hit_title})
        except Exception:
            continue

    return jsonify({'backlinks': backlinks})


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


@app.route('/api/toolbar-notes')
def api_toolbar_notes():
    """Scan a full notebook for notes with  toolbar: true  in frontmatter.

    Recurses into subfolders so toolbar shortcuts work regardless of which
    folder is currently open in the list pane.  Results are intentionally
    lightweight — just enough to render the shortcut button.
    """
    notebook = request.args.get('notebook', '').strip()
    if not notebook:
        return jsonify({'notes': []})
    nb_path = NB_DIR / notebook
    if not nb_path.is_dir():
        return jsonify({'notes': []})

    result = []
    for fpath in sorted(nb_path.rglob('*.md')):
        rel = fpath.relative_to(nb_path)
        if any(part.startswith('.') for part in rel.parts):
            continue
        try:
            raw  = fpath.read_text(errors='replace')
            meta, _ = parse_frontmatter(raw)
            if not bool(meta.get('toolbar')):
                continue
            fname = fpath.name
            itype = _apply_meta_type(classify(fname, notebook), meta)
            result.append({
                'selector':     f"{notebook}:{'/'.join(rel.parts)}",
                'title':        meta.get('title') or note_title(fname, ''),
                'toolbar_icon': str(meta.get('toolbar_icon') or '').strip(),
                'type':         itype,
                'indicator':    INDICATORS.get(itype, ''),
            })
        except Exception:
            continue

    return jsonify({'notes': result})


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

def _nb_notebook_dir(notebook):
    """Return the Path for a notebook's directory inside NB_DIR."""
    if notebook in ('home', ''):
        return NB_DIR / 'home'
    return NB_DIR / notebook


@app.route('/api/browse-path', methods=['POST'])
def api_browse_path():
    """Open a native OS file dialog and return selected paths."""
    data     = request.get_json(silent=True) or {}
    multiple = data.get('multiple', True)

    # Try zenity first (GNOME — GTK theme, looks native)
    try:
        cmd = ['zenity', '--file-selection', '--title=Select files']
        if multiple:
            cmd += ['--multiple', '--separator=\n']
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        paths = [p.strip() for p in r.stdout.strip().splitlines() if p.strip()] if r.returncode == 0 else []
        return jsonify({'paths': paths})
    except FileNotFoundError:
        pass
    except Exception:
        pass

    # Try kdialog (KDE)
    try:
        cmd = ['kdialog', '--getopenfilename', str(Path.home())]
        if multiple:
            cmd.append('--multiple')
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        paths = [p.strip() for p in r.stdout.strip().split() if p.strip()] if r.returncode == 0 else []
        return jsonify({'paths': paths})
    except FileNotFoundError:
        pass
    except Exception:
        pass

    # Fallback: tkinter (may look dated at HiDPI but works)
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.lift()
        root.attributes('-topmost', True)
        try:
            root.tk.call('tk', 'scaling', 2.0)   # HiDPI hint
        except Exception:
            pass
        if multiple:
            paths = list(filedialog.askopenfilenames(title='Select files', parent=root))
        else:
            p = filedialog.askopenfilename(title='Select file', parent=root)
            paths = [p] if p else []
        root.destroy()
        return jsonify({'paths': paths})
    except Exception:
        pass

    return jsonify({'paths': None, 'error': 'no native file dialog available'})


@app.route('/api/import', methods=['POST'])
def api_import():
    # ── Path-based import (native file browser) ──────────────
    if request.is_json:
        data     = request.get_json()
        paths    = data.get('paths', [])
        notebook = (data.get('notebook') or 'home').strip()
        folder   = (data.get('folder')   or '').strip().strip('/')
        if not _safe_notebook(notebook):
            return jsonify({'success': False, 'error': 'invalid notebook'}), 400
        if folder and ('..' in folder or folder.startswith('/')):
            return jsonify({'success': False, 'error': 'invalid folder'}), 400
        target = f'{notebook}:{folder}/' if folder else f'{notebook}:'
        lines = []; selectors = []
        for path_str in paths:
            p = Path(path_str)
            if not p.exists():
                lines.append(f'✗ {p.name}: not found')
                continue
            r = run_nb('import', str(p), target)
            if r['returncode'] == 0:
                lines.append(f'✓ {p.name}')
                m = re.search(r'\[(\d+)\]', strip_ansi(r['stdout']))
                if m:
                    selectors.append(f'{notebook}:{m.group(1)}')
            else:
                lines.append(f'✗ {p.name}: {r["stderr"].strip() or "failed"}')
        return jsonify({'success': True, 'lines': lines, 'selectors': selectors})

    # ── Upload-based import (browser file picker fallback) ───
    f        = request.files.get('file')
    notebook = request.form.get('notebook', 'home').strip() or 'home'
    folder   = request.form.get('folder', '').strip().strip('/')
    if not _safe_notebook(notebook):
        return jsonify({'success': False, 'error': 'invalid notebook'}), 400
    if folder and ('..' in folder or folder.startswith('/')):
        return jsonify({'success': False, 'error': 'invalid folder'}), 400
    if not f or not f.filename:
        return jsonify({'success': False, 'error': 'no file provided'}), 400

    cfg       = _load_settings()
    max_bytes = cfg['import_max_mb'] * 1024 * 1024
    safe_name = Path(f.filename).name.replace('/', '_').replace('..', '_')

    # Size check — read up to limit+1 bytes to detect overflow without loading all
    chunk = f.read(max_bytes + 1)
    if len(chunk) > max_bytes:
        return jsonify({'success': False,
                        'error': f'{safe_name} exceeds {cfg["import_max_mb"]} MB limit'}), 400
    f.stream.seek(0)  # reset for save()

    # Duplicate check — does this name already exist in the target notebook?
    nb_dir = _nb_notebook_dir(notebook)
    if nb_dir.exists():
        existing = {p.name for p in nb_dir.iterdir() if p.is_file() or p.is_symlink()}
        if safe_name in existing:
            return jsonify({'success': False,
                            'error': f'{safe_name} already exists in {notebook} — rename or delete it first'}), 409

    # vCard files → parse into contact notes
    if safe_name.lower().endswith('.vcf'):
        try:
            text     = chunk.decode('utf-8', errors='replace')
            contacts = _parse_vcard(text)
            created  = []
            for c in contacts:
                md   = _contact_to_md(c)
                slug = _contact_slug(c.get('name') or c.get('fn', 'contact'))
                fname = f"{slug}.md"
                dest  = NB_DIR / 'contacts' / fname
                dest.parent.mkdir(parents=True, exist_ok=True)
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

    tmp_dir  = Path(tempfile.mkdtemp())
    tmp_path = tmp_dir / safe_name
    try:
        f.save(str(tmp_path))
        target = f'{notebook}:{folder}/' if folder else f'{notebook}:'
        r = run_nb('import', str(tmp_path), target)
        success = r['returncode'] == 0
        selector = None
        if success:
            m = re.search(r'\[(\d+)\]', strip_ansi(r['stdout']))
            if m:
                selector = f'{notebook}:{m.group(1)}'
        return jsonify({'success': success, 'output': r['stdout'], 'stderr': r['stderr'],
                        'selector': selector,
                        'error': r['stderr'] if not success else None})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@app.route('/api/contacts/vcf')
def api_contacts_vcf():
    """Return parsed contacts from the configured VCF source file."""
    settings = _load_settings()
    vcf_path = Path(settings.get('vcf_source', '~/Downloads/contacts.vcf')).expanduser()
    if not vcf_path.exists():
        return jsonify({'error': f'VCF file not found: {vcf_path}', 'contacts': []}), 404
    text     = vcf_path.read_text(errors='replace')
    contacts = _parse_vcard(text)
    contacts.sort(key=lambda c: (c.get('name') or c.get('fn', '')).lower())
    return jsonify({'contacts': contacts, 'count': len(contacts)})


@app.route('/api/contacts/from-vcf', methods=['POST'])
def api_contact_from_vcf():
    """Create a contact note in the contacts notebook from a parsed vCard dict."""
    data    = request.get_json(silent=True) or {}
    contact = data.get('contact')
    if not contact or not isinstance(contact, dict):
        return jsonify({'error': 'contact dict required'}), 400

    settings    = _load_settings()
    contact_tag = settings.get('contact_tag', 'djp').strip().lstrip('#')
    if contact_tag:
        existing = contact.get('tags') or []
        if isinstance(existing, str):
            existing = [t.strip() for t in existing.replace(',', ' ').split() if t.strip()]
        if contact_tag not in existing:
            existing = [contact_tag] + existing
        contact = dict(contact, tags=existing)

    md    = _contact_to_md(contact)
    name  = contact.get('name') or contact.get('fn', 'contact')
    slug  = _contact_slug(name)
    fname = f'{slug}.md'

    contacts_dir = NB_DIR / 'contacts'
    contacts_dir.mkdir(parents=True, exist_ok=True)
    dest = contacts_dir / fname
    if dest.exists():
        import uuid as _uuid
        fname = f'{slug}_{_uuid.uuid4().hex[:4]}.md'
        dest  = contacts_dir / fname

    dest.write_text(md)
    run_nb('index', 'reconcile', 'contacts:')

    idx      = read_index('contacts')
    note_id  = (idx.index(fname) + 1) if fname in idx else None
    selector = f'contacts:{note_id}' if note_id else None
    return jsonify({'success': True, 'selector': selector, 'filename': fname, 'name': name})


@app.route('/api/link-file', methods=['POST'])
def api_link_file():
    """Create a symlink inside a notebook pointing to an existing filesystem path."""
    data     = request.get_json(silent=True) or {}
    src_str  = data.get('path', '').strip()
    notebook = data.get('notebook', 'home').strip() or 'home'

    if not _safe_notebook(notebook):
        return jsonify({'success': False, 'error': 'invalid notebook'}), 400
    if not src_str:
        return jsonify({'success': False, 'error': 'path is required'}), 400

    src = Path(os.path.expanduser(src_str)).resolve()
    if not src.exists():
        return jsonify({'success': False, 'error': f'Path not found: {src}'}), 404
    if not src.is_file():
        return jsonify({'success': False, 'error': f'Not a file: {src}'}), 400

    nb_dir = _nb_notebook_dir(notebook)
    nb_dir.mkdir(parents=True, exist_ok=True)
    dest = nb_dir / src.name

    if dest.exists() or dest.is_symlink():
        return jsonify({'success': False,
                        'error': f'{src.name} already exists in {notebook}'}), 409

    try:
        os.symlink(src, dest)
        run_nb('index', 'reconcile', f'{notebook}:')
        selector = None
        try:
            idx_lines = (nb_dir / '.index').read_text().splitlines()
            for i, line in enumerate(idx_lines, 1):
                if line.strip() == src.name:
                    selector = f'{notebook}:{i}'
                    break
        except Exception:
            pass
        return jsonify({'success': True, 'name': src.name, 'target': str(src), 'selector': selector})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


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
        tmp_fd, tmp_str = tempfile.mkstemp(suffix=suffix)
        os.close(tmp_fd)
        tmp = Path(tmp_str)
        r = subprocess.run(
            ['pandoc', str(fpath), '-t', fmt, '-o', str(tmp)] + extra,
            capture_output=True, timeout=30)
        if r.returncode != 0:
            tmp.unlink(missing_ok=True)
            return jsonify({'error': r.stderr.decode(errors='replace')}), 500
        data = tmp.read_bytes()
        tmp.unlink(missing_ok=True)
        return send_file(io.BytesIO(data), as_attachment=True,
                         download_name=f'{stem}{suffix}', mimetype=mimetype)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _inline_images(html: str) -> str:
    """Replace /api/file?selector=… img srcs with base64 data URIs for standalone export."""
    import base64, mimetypes
    from urllib.parse import urlparse, parse_qs
    def _replace(m):
        src = m.group(2)
        if not src.startswith('/api/file?'):
            return m.group(0)
        sel = parse_qs(urlparse(src).query).get('selector', [''])[0]
        if not sel:
            return m.group(0)
        fpath = _resolve_to_nb_path(sel)
        if not fpath or not fpath.exists():
            return m.group(0)
        mime = mimetypes.guess_type(str(fpath))[0] or 'image/png'
        data = base64.b64encode(fpath.read_bytes()).decode()
        return m.group(1) + f'data:{mime};base64,{data}' + m.group(3)
    return re.sub(r'(<img\b[^>]*?\bsrc=")([^"]+)(")', _replace, html)


@app.route('/api/export-html', methods=['POST'])
def api_export_html():
    """Export the rendered preview HTML (with codeblock output) to html/docx/odt."""
    import io, tempfile
    data     = request.get_json() or {}
    html     = data.get('html', '')
    fmt      = data.get('fmt', 'html').lower()
    filename = data.get('filename', 'export')
    title    = data.get('title', filename.rsplit('.', 1)[0] if '.' in filename else filename)
    notebook = data.get('notebook', '').strip()

    if not html:
        return jsonify({'error': 'html required'}), 400

    html = _inline_images(html)   # embed notebook images as base64 data URIs

    # Use .export.template.html if present, else built-in fallback
    tmpl = _find_export_template(notebook)
    if tmpl:
        full_html = tmpl.replace('{{content}}', html).replace('{{title}}', title)
    else:
        full_html = f'''<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>{title}</title>
<style>
  body {{ font-family: Georgia, serif; max-width: 800px; margin: 2cm auto; color: #000; font-size: 12pt; }}
  h1,h2,h3 {{ margin-top: 1.4em; }}
  pre, code {{ font-family: monospace; font-size: 0.88em; background: #f4f4f4; padding: 2px 4px; border-radius: 3px; }}
  pre {{ padding: 10px; overflow-x: auto; }}
  table {{ border-collapse: collapse; width: 100%; }}
  th, td {{ border: 1px solid #ccc; padding: 4px 8px; text-align: left; }}
  img {{ max-width: 100%; }}
  a {{ color: #2255aa; }}
</style></head><body>{html}</body></html>'''

    if fmt == 'html':
        buf = io.BytesIO(full_html.encode('utf-8'))
        return send_file(buf, as_attachment=True,
                         download_name=filename, mimetype='text/html')

    FORMAT_MAP = {
        'docx': ('.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
        'odt':  ('.odt',  'application/vnd.oasis.opendocument.text'),
    }
    if fmt not in FORMAT_MAP:
        return jsonify({'error': f'unsupported format: {fmt}'}), 400

    suffix, mimetype = FORMAT_MAP[fmt]
    tmp_in = tmp_out = None
    try:
        tmp_in_fd, tmp_in_str = tempfile.mkstemp(suffix='.html')
        with os.fdopen(tmp_in_fd, 'w', encoding='utf-8') as f:
            f.write(full_html)
        tmp_in = Path(tmp_in_str)

        tmp_out_fd, tmp_out_str = tempfile.mkstemp(suffix=suffix)
        os.close(tmp_out_fd)
        tmp_out = Path(tmp_out_str)

        r = subprocess.run(
            ['pandoc', str(tmp_in), '-f', 'html', '-t', fmt, '-o', str(tmp_out), '--standalone'],
            capture_output=True, timeout=30)
        if r.returncode != 0:
            return jsonify({'error': r.stderr.decode(errors='replace')}), 500

        data_bytes = tmp_out.read_bytes()
        return send_file(io.BytesIO(data_bytes), as_attachment=True,
                         download_name=filename, mimetype=mimetype)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        if tmp_in:  tmp_in.unlink(missing_ok=True)
        if tmp_out: tmp_out.unlink(missing_ok=True)


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

    body = c.get('note', '')
    return f"---\n{yaml_block}\n---\n\n{body}\n" if body else f"---\n{yaml_block}\n---\n"


# ---------------------------------------------------------------------------
# API: Run read-only nb command (daily, info, weather, notebooks)
# ---------------------------------------------------------------------------

@app.route('/api/which')
def api_which():
    """Check whether a command is available on PATH."""
    cmd = request.args.get('cmd', '').strip()
    if not cmd or re.search(r'[/\s]', cmd):
        return jsonify({'found': False, 'path': None}), 400
    path = shutil.which(cmd)
    return jsonify({'found': path is not None, 'path': path})


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
               'status', 'remote', 'plugins', 'import', 'export'}
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
# API: Test codeblock runner
# ---------------------------------------------------------------------------

@app.route('/api/test/run', methods=['POST'])
def api_test_run():
    """Run a script from ~/.nb/.test/ with note context env vars."""
    data        = request.get_json(force=True) or {}
    script_name = (data.get('script') or '').strip()
    selector    = (data.get('selector') or '').strip()
    force       = bool(data.get('force', False))

    if not script_name:
        return jsonify({'error': 'no script name', 'exit_code': 1}), 400
    if '/' in script_name or script_name.startswith('.'):
        return jsonify({'error': 'invalid script name', 'exit_code': 1}), 400

    script_path = TEST_DIR / script_name
    if not script_path.exists() and not script_name.endswith('.sh'):
        script_path = TEST_DIR / (script_name + '.sh')
    if not script_path.exists():
        return jsonify({'error': f'script not found: {script_name} (looked in {TEST_DIR})', 'exit_code': 1}), 404

    # Return cached result for auto-runs (force=False) within TTL
    cache_key = (script_name, selector)
    now = time.time()
    if not force:
        entry = _test_cache.get(cache_key)
        if entry and (now - entry['ts']) < _TEST_CACHE_TTL:
            return jsonify(entry['result'])

    notebook  = selector.split(':')[0] if ':' in selector else ''
    note_path = _resolve_to_nb_path(selector) if selector else None

    env = {
        **os.environ,
        'NB_DIR':           str(NB_DIR),
        'NB_NOTE_SELECTOR': selector,
        'NB_NOTEBOOK':      notebook,
        'NB_NOTE_PATH':     str(note_path) if note_path else '',
        'NO_COLOR':         '1',
    }
    try:
        result = subprocess.run(
            ['bash', str(script_path)],
            capture_output=True, text=True,
            env=env, timeout=30,
        )
        result_data = {
            'stdout':    result.stdout,
            'stderr':    result.stderr,
            'exit_code': result.returncode,
        }
        _test_cache[cache_key] = {'result': result_data, 'ts': now}
        return jsonify(result_data)
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'script timed out (30s)', 'exit_code': 1})
    except Exception as e:
        return jsonify({'error': str(e), 'exit_code': 1})


@app.route('/api/test/batch', methods=['POST'])
def api_test_batch():
    """Run multiple test scripts in parallel with a single round trip.

    Request:  { "scripts": ["hl-ok", "nb-dirty", ...], "selector": "accts:review.md" }
    Response: { "hl-ok": { "stdout": "", "exit_code": 0 }, ... }

    Scripts are deduplicated before running.  Cache is checked per-script
    using the same key/TTL as /api/test/run so results are shared.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    data     = request.get_json(force=True) or {}
    scripts  = [s for s in (data.get('scripts') or []) if isinstance(s, str)]
    selector = (data.get('selector') or '').strip()

    if not scripts:
        return jsonify({})

    # Resolve note context once — shared across all script invocations
    notebook  = selector.split(':')[0] if ':' in selector else ''
    note_path = _resolve_to_nb_path(selector) if selector else None
    env = {
        **os.environ,
        'NB_DIR':           str(NB_DIR),
        'NB_NOTE_SELECTOR': selector,
        'NB_NOTEBOOK':      notebook,
        'NB_NOTE_PATH':     str(note_path) if note_path else '',
        'NO_COLOR':         '1',
    }

    def run_one(script_name):
        if '/' in script_name or script_name.startswith('.'):
            return script_name, {'error': 'invalid script name', 'exit_code': 1, 'stdout': ''}
        cache_key = (script_name, selector)
        now = time.time()
        entry = _test_cache.get(cache_key)
        if entry and (now - entry['ts']) < _TEST_CACHE_TTL:
            return script_name, entry['result']
        script_path = TEST_DIR / script_name
        if not script_path.exists() and not script_name.endswith('.sh'):
            script_path = TEST_DIR / (script_name + '.sh')
        if not script_path.exists():
            return script_name, {'error': f'not found: {script_name}', 'exit_code': 1, 'stdout': ''}
        try:
            r = subprocess.run(['bash', str(script_path)],
                               capture_output=True, text=True, env=env, timeout=30)
            result = {'stdout': r.stdout, 'stderr': r.stderr, 'exit_code': r.returncode}
            _test_cache[cache_key] = {'result': result, 'ts': now}
            return script_name, result
        except subprocess.TimeoutExpired:
            return script_name, {'error': 'timed out (30s)', 'exit_code': 1, 'stdout': ''}
        except Exception as e:
            return script_name, {'error': str(e), 'exit_code': 1, 'stdout': ''}

    unique = list(dict.fromkeys(scripts))   # deduplicate, preserve order
    results = {}
    with ThreadPoolExecutor(max_workers=min(len(unique), 8)) as pool:
        for name, result in pool.map(run_one, unique):
            results[name] = result

    return jsonify(results)


# ---------------------------------------------------------------------------
# API: Rename / Move note
# ---------------------------------------------------------------------------

def _resolve_dest_dir(dest: str) -> Path:
    """Resolve nb move dest like 'work:folder/' to the filesystem directory."""
    if ':' in dest:
        nb_name, rest = dest.split(':', 1)
        folder = rest.strip('/')
    else:
        nb_name = dest.strip('/')
        folder = ''
    return (NB_DIR / nb_name / folder) if folder else (NB_DIR / nb_name)


@app.route('/api/note/rename', methods=['POST'])
def api_rename():
    """Rename the note file (and its annotation sidecar if present)."""
    data     = request.get_json() or {}
    selector = data.get('selector', '').strip()
    name     = data.get('name', '').strip()
    if not selector or not name:
        return jsonify({'error': 'selector and name required'}), 400

    path_r = run_nb('show', selector, '--path')
    if not nb_ok(path_r):
        return jsonify({'error': 'not found'}), 404
    fpath = Path(path_r['stdout'].strip())

    # Sanitize: allow word chars, hyphens, underscores, dots
    new_stem = re.sub(r'[^\w.-]+', '-', name).strip('-')
    if not new_stem:
        return jsonify({'error': 'invalid name'}), 400

    # Build new filename preserving the original extension
    if fpath.name.lower().endswith('.md.enc'):
        new_name = new_stem + '.md.enc'
    else:
        ext = fpath.suffix  # '.md', '.pdf', '.png', etc.
        new_name = new_stem + ext if not new_stem.lower().endswith(ext.lower()) else new_stem

    ann_path = _annotation_path(str(fpath))

    r = run_nb('rename', selector, new_name, '--force')
    if not nb_ok(r):
        return jsonify({'success': False, 'stderr': strip_ansi(r['stderr'])})

    # Rename annotation sidecar (non-fatal if missing or fails)
    ann_moved = False
    if ann_path.exists():
        new_ann = fpath.parent / f'.{new_name}.annotations.md'
        try:
            ann_path.rename(new_ann)
            ann_moved = True
        except OSError:
            pass

    _sidecar_scan_cache.clear()
    return jsonify({'success': True, 'ann_moved': ann_moved})


@app.route('/api/note/move', methods=['POST'])
def api_move():
    """Move a note (and its annotation sidecar) to a new notebook/folder."""
    data     = request.get_json() or {}
    selector = data.get('selector', '').strip()
    dest     = data.get('dest', '').strip()   # e.g. "work:" or "tasks:folder/"
    if not selector or not dest:
        return jsonify({'error': 'selector and dest required'}), 400

    # Capture annotation path before the move
    path_r   = run_nb('show', selector, '--path')
    fpath    = Path(path_r['stdout'].strip()) if nb_ok(path_r) else None
    ann_path = _annotation_path(str(fpath)) if fpath else None

    r = run_nb('move', selector, dest, '--force')
    if not nb_ok(r):
        return jsonify({'success': False, 'stderr': strip_ansi(r['stderr'])})

    # Move annotation sidecar to the destination directory (non-fatal)
    ann_moved = False
    if ann_path and ann_path.exists() and fpath:
        try:
            dest_dir = _resolve_dest_dir(dest)
            dest_dir.mkdir(parents=True, exist_ok=True)
            new_ann = dest_dir / f'.{fpath.name}.annotations.md'
            ann_path.rename(new_ann)
            ann_moved = True
        except OSError:
            pass

    _sidecar_scan_cache.clear()
    return jsonify({'success': True, 'ann_moved': ann_moved})


@app.route('/api/note/export-bulk', methods=['POST'])
def api_export_bulk():
    import io
    data      = request.get_json() or {}
    selectors = data.get('selectors', [])
    concat    = data.get('concat', False)
    if not selectors:
        return jsonify({'error': 'selectors required'}), 400

    parts = []
    for sel in selectors:
        fpath = _resolve_to_nb_path(sel)
        if fpath and fpath.exists():
            content = fpath.read_text(errors='replace').strip()
            title   = fpath.stem
        else:
            content = '*(not found)*'
            title   = sel
        parts.append(content if concat else f'# {title}\n\n{content}')

    compiled = '\n\n'.join(parts) if concat else '\n\n---\n\n'.join(parts)
    buf = io.BytesIO(compiled.encode('utf-8'))
    return send_file(buf, as_attachment=True,
                     download_name='nb-export.md',
                     mimetype='text/markdown')


# ---------------------------------------------------------------------------
# API: Folder operations
# ---------------------------------------------------------------------------

@app.route('/api/folder/rename', methods=['POST'])
def api_folder_rename():
    data     = request.get_json() or {}
    selector = data.get('selector', '').strip()
    name     = data.get('name', '').strip()
    if not selector or not name:
        return jsonify({'error': 'selector and name required'}), 400
    r = run_nb('move', selector, name, '--force')
    return jsonify({'success': nb_ok(r), 'stderr': strip_ansi(r['stderr'])})


@app.route('/api/folder/move', methods=['POST'])
def api_folder_move():
    data     = request.get_json() or {}
    selector = data.get('selector', '').strip()
    dest     = data.get('dest', '').strip()   # e.g. "work:"
    if not selector or not dest:
        return jsonify({'error': 'selector and dest required'}), 400
    r = run_nb('move', selector, dest, '--force')
    return jsonify({'success': nb_ok(r), 'stderr': strip_ansi(r['stderr'])})


@app.route('/api/folder', methods=['DELETE'])
def api_folder_delete():
    data     = request.get_json() or {}
    selector = data.get('selector', '').strip()
    if not selector:
        return jsonify({'error': 'selector required'}), 400
    r = run_nb('folders', 'delete', selector, '--force')
    return jsonify({'success': nb_ok(r), 'stderr': strip_ansi(r['stderr'])})


@app.route('/api/folder/lock', methods=['GET', 'POST', 'DELETE'])
def api_folder_lock():
    if request.method == 'GET':
        selector = request.args.get('selector', '').strip()
        if not selector:
            return jsonify({'error': 'selector required'}), 400
        folder_path = _folder_selector_to_dir(selector)
        if not folder_path:
            return jsonify({'error': 'folder not found'}), 404
        lk = folder_path / '.nb-lock'
        ul = folder_path / '.nb-unlock'
        if lk.exists():
            return jsonify({'locked': True,  'reason': lk.read_text(errors='replace').strip() or None})
        if ul.exists():
            return jsonify({'locked': False, 'reason': ul.read_text(errors='replace').strip() or None})
        return jsonify({'locked': False, 'reason': None})

    data     = request.get_json() or {}
    selector = data.get('selector', '').strip()
    if not selector:
        return jsonify({'error': 'selector required'}), 400
    folder_path = _folder_selector_to_dir(selector)
    if not folder_path:
        return jsonify({'error': 'folder not found'}), 404
    lk = folder_path / '.nb-lock'
    ul = folder_path / '.nb-unlock'
    if request.method == 'POST':
        reason = data.get('reason', '').strip()
        content = reason + '\n' if reason else ''
        if ul.exists():
            ul.rename(lk)          # .nb-unlock → .nb-lock (preserve existing content)
            if reason:             # only overwrite if a new reason was supplied
                lk.write_text(content)
        else:
            lk.write_text(content)
        return jsonify({'ok': True})
    else:
        if lk.exists():
            lk.rename(ul)          # .nb-lock → .nb-unlock (preserve reason for next time)
        return jsonify({'ok': True})


@app.route('/api/nb/lock', methods=['GET', 'POST', 'DELETE'])
def api_nb_lock():
    if request.method == 'GET':
        notebook = request.args.get('notebook', '').strip()
        if not notebook or not _safe_notebook(notebook):
            return jsonify({'error': 'notebook required'}), 400
        lk = nb_dir_for(notebook) / '.nb-lock'
        ul = nb_dir_for(notebook) / '.nb-unlock'
        if lk.exists():
            return jsonify({'locked': True,  'reason': lk.read_text(errors='replace').strip() or None})
        if ul.exists():
            return jsonify({'locked': False, 'reason': ul.read_text(errors='replace').strip() or None})
        return jsonify({'locked': False, 'reason': None})

    data     = request.get_json() or {}
    notebook = data.get('notebook', '').strip()
    if not notebook or not _safe_notebook(notebook):
        return jsonify({'error': 'notebook required'}), 400
    lk = nb_dir_for(notebook) / '.nb-lock'
    ul = nb_dir_for(notebook) / '.nb-unlock'
    if request.method == 'POST':
        reason = data.get('reason', '').strip()
        content = reason + '\n' if reason else ''
        if ul.exists():
            ul.rename(lk)
            if reason:
                lk.write_text(content)
        else:
            lk.write_text(content)
        return jsonify({'ok': True})
    else:
        if lk.exists():
            lk.rename(ul)
        return jsonify({'ok': True})


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
# Plugin manager
# ---------------------------------------------------------------------------

@app.route('/nb-web-plugins/<path:filename>')
def serve_web_plugin(filename):
    """Serve managed plugin JS files from ~/.nb/.web/plugins/."""
    return send_from_directory(str(WEB_PLUGINS_DIR), filename)


_RE_PLUGIN_TAG = re.compile(r'^//\s*@(\w+)\s*(.*?)\s*$')

def _read_plugin_meta(path: Path) -> dict:
    """Parse @tag comment header from a plugin JS file.

    Reads only the leading comment block (stops at the first non-comment line).
    Returns a dict with keys: name, version, type, homepage — empty strings for
    any tag that is absent or has no value.
    """
    meta = {'name': '', 'version': '', 'type': 'plugin', 'homepage': ''}
    try:
        with path.open(encoding='utf-8', errors='replace') as fh:
            for line in fh:
                line = line.rstrip('\n')
                if not line.startswith('//'):
                    break
                m = _RE_PLUGIN_TAG.match(line)
                if m:
                    tag, val = m.group(1), m.group(2)
                    if tag in meta:
                        meta[tag] = val
    except OSError:
        pass
    if not meta['name']:
        meta['name'] = path.stem
    return meta


def _plugin_filename_from_url(url: str) -> str:
    """Extract a safe filename from a URL or path."""
    from urllib.parse import urlparse
    name = urlparse(url).path.split('/')[-1] or 'plugin.js'
    name = re.sub(r'[^\w.\-]', '_', name)
    if not name.endswith('.js'):
        name += '.js'
    return name


@app.route('/api/plugins/install', methods=['POST'])
def api_plugin_install():
    """Download, copy, or upload a plugin JS file into WEB_PLUGINS_DIR, register in settings."""
    global _settings
    WEB_PLUGINS_DIR.mkdir(parents=True, exist_ok=True)

    ct = request.content_type or ''
    if 'multipart/form-data' in ct:
        # Browser file upload via Browse button
        f = request.files.get('file')
        if not f or not f.filename:
            return jsonify({'error': 'file required'}), 400
        filename = re.sub(r'[^\w.\-]', '_', f.filename)
        if not filename.endswith('.js'):
            return jsonify({'error': 'Plugin must be a .js file'}), 400
        name = request.form.get('name', '').strip() or filename[:-3]
        dest = WEB_PLUGINS_DIR / filename
        f.save(str(dest))
        stored_url = f'/nb-web-plugins/{filename}'
    else:
        body   = request.get_json(silent=True) or {}
        source = (body.get('url') or '').strip()
        name   = (body.get('name') or '').strip()
        if not source:
            return jsonify({'error': 'url required'}), 400

        if source.startswith(('http://', 'https://')):
            filename = _plugin_filename_from_url(source)
            dest = WEB_PLUGINS_DIR / filename
            try:
                import urllib.request
                req = urllib.request.Request(source, headers={'User-Agent': 'nb-web/1.0'})
                with urllib.request.urlopen(req, timeout=15) as resp:
                    dest.write_bytes(resp.read())
            except Exception as e:
                return jsonify({'error': f'Download failed: {e}'}), 502
            stored_url = f'/nb-web-plugins/{filename}'

        elif source.startswith('/nb-web-plugins/'):
            stored_url = source
            filename   = source.split('/')[-1]

        else:
            src_path = Path(os.path.expanduser(source))
            if not src_path.is_file():
                return jsonify({'error': f'File not found: {source}'}), 404
            filename = src_path.name
            if not filename.endswith('.js'):
                return jsonify({'error': 'Plugin must be a .js file'}), 400
            dest = WEB_PLUGINS_DIR / filename
            shutil.copy2(str(src_path), str(dest))
            stored_url = f'/nb-web-plugins/{filename}'

        if not name:
            name = filename[:-3] if filename.endswith('.js') else filename

    plugins = list(_settings.get('plugins', []))
    if any(p['url'] == stored_url for p in plugins):
        return jsonify({'error': f'Plugin already installed: {stored_url}'}), 409

    plugins.append({'url': stored_url, 'name': name, 'enabled': True, 'type': 'plugin', 'homepage': ''})
    _save_settings({'plugins': plugins})
    _settings = _load_settings()
    return jsonify({'ok': True, 'plugins': _settings['plugins']})


@app.route('/api/plugins/uninstall', methods=['DELETE'])
def api_plugin_uninstall():
    """Remove a plugin from settings; delete its file if managed."""
    global _settings
    url = (request.args.get('url') or '').strip()
    if not url:
        body = request.get_json(silent=True) or {}
        url = (body.get('url') or '').strip()
    if not url:
        return jsonify({'error': 'url required'}), 400

    current = _settings.get('plugins', [])
    target = next((p for p in current if p['url'] == url), None)
    if target is None:
        return jsonify({'error': 'Plugin not found'}), 404
    if target.get('type') in ('core', 'bundled'):
        return jsonify({'error': f'Cannot remove {target["type"]} plugin'}), 403

    plugins = [p for p in current if p['url'] != url]

    if url.startswith('/nb-web-plugins/'):
        filename = url.split('/')[-1]
        plugin_file = WEB_PLUGINS_DIR / filename
        if plugin_file.is_file():
            plugin_file.unlink()

    _save_settings({'plugins': plugins})
    _settings = _load_settings()
    return jsonify({'ok': True, 'plugins': _settings['plugins']})


@app.route('/api/plugins/toggle', methods=['PATCH'])
def api_plugin_toggle():
    """Enable or disable a plugin by URL. Core plugins cannot be toggled."""
    global _settings
    body = request.get_json(silent=True) or {}
    url     = (body.get('url') or '').strip()
    enabled = bool(body.get('enabled', True))
    if not url:
        return jsonify({'error': 'url required'}), 400

    plugins = list(_settings.get('plugins', []))
    for p in plugins:
        if p['url'] == url:
            if p.get('type') == 'core':
                return jsonify({'error': 'Cannot toggle a core plugin'}), 403
            p['enabled'] = enabled
            break
    else:
        return jsonify({'error': 'Plugin not found'}), 404

    _save_settings({'plugins': plugins})
    _settings = _load_settings()
    return jsonify({'ok': True, 'plugins': _settings['plugins']})


# ---------------------------------------------------------------------------
# NbWeb-cine: film production scheduling
# ---------------------------------------------------------------------------

def _cine_int(val, default=None):
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


def _expand_subfields(meta):
    """Second-pass YAML parse: any string value that is itself valid YAML dict/list
    becomes a nested structure.  Block scalars (|) are already plain strings after
    parse_frontmatter; this makes e.g. tech: {camera:…, sound:…, lights:…}.
    Falls back to the original string on parse failure or non-mapping/non-list result.
    """
    if not _YAML_OK:
        return meta
    out = {}
    for k, v in meta.items():
        if isinstance(v, str) and v.strip():
            try:
                parsed = _yaml.safe_load(v)
                if isinstance(parsed, (dict, list)):
                    out[k] = parsed
                    continue
            except Exception:
                pass
        out[k] = v
    return out


def _cine_csv(val):
    if not val:
        return []
    if isinstance(val, list):
        return [str(v).strip() for v in val if str(v).strip()]
    return [v.strip() for v in str(val).replace('\n', ',').split(',') if v.strip()]


@app.route('/api/cine/data')
def api_cine_data():
    """Return all shots + lookup maps + project config for a cine notebook.

    Response: { shots, actors (from cast/), locations, resources, config }
    Shots are sorted by day then seq.
    """
    notebook = request.args.get('notebook', '').strip()
    if not notebook:
        return jsonify({'error': 'notebook required'}), 400
    nb_path = NB_DIR / notebook
    if not nb_path.is_dir():
        return jsonify({'error': 'notebook not found'}), 404

    config = {}
    cine_json = nb_path / '.nb-cine.json'
    if cine_json.exists():
        try:
            config = json.loads(cine_json.read_text())
        except Exception:
            pass

    shots = []
    shots_dir = nb_path / 'shots'
    if shots_dir.is_dir():
        for f in sorted(f for f in shots_dir.glob('*.md') if not f.name.startswith('.')):
            try:
                meta, _ = parse_frontmatter(f.read_text(errors='replace'))
                expanded  = _expand_subfields(meta)

                # resources: block-scalar dict/list passes through; legacy CSV strings
                # are normalised to a list for backward-compat with the frontend counter.
                _res_raw = expanded.get('resources', '')
                resources = _res_raw if isinstance(_res_raw, (dict, list)) \
                            else _cine_csv(_res_raw)

                shots.append({
                    'selector':  f'{notebook}:shots/{f.name}',
                    'filename':  f.name,
                    'type':      meta.get('type', 'scene'),
                    'day':       _cine_int(meta.get('day')),
                    'seq':       _cine_int(meta.get('seq'), 999),
                    'scene':     str(meta.get('scene', '')),
                    'shot':      str(meta.get('shot', '')),
                    'alias':     str(meta.get('alias', '')),
                    'day_night': str(meta.get('day_night', '')).upper()[:1],
                    'int_ext':   str(meta.get('int_ext', '')).upper()[:1],
                    'desc':      str(meta.get('desc', '')).strip(),
                    'loc':       str(meta.get('loc', '')),
                    'cameras':   str(meta.get('cameras', '')),
                    'lens':      str(meta.get('lens', '')),
                    'platform':  str(meta.get('platform', '')),
                    'actors':    _cine_csv(
                                     meta.get('actors') or
                                     (expanded.get('cast') or {}).get('actors', '')
                                 ),
                    'resources': resources,
                    # expanded sub-block dicts
                    'tech':      expanded.get('tech', {}),
                    'art':       expanded.get('art', {}),
                    'cast':      expanded.get('cast', {}),
                    'locked':    bool(re.match(r'^(yes|on|true|1)$',
                                     str(meta.get('lock', '')).strip(), re.I)),
                })
            except Exception:
                pass
    shots.sort(key=lambda s: (s['day'] if s['day'] is not None else 0, s['seq']))

    def _scan_dir(subdir, code_field=None):
        """Scan a subfolder of .md files into a lookup dict.

        code_field=None keys by filename stem; otherwise by that frontmatter field.
        """
        out = {}
        d = nb_path / subdir
        if d.is_dir():
            for f in (x for x in d.glob('*.md') if not x.name.startswith('.')):
                try:
                    meta, _ = parse_frontmatter(f.read_text(errors='replace'))
                    code = f.stem if code_field is None \
                           else str(meta.get(code_field, '')).strip()
                    if code:
                        out[code] = {
                            'selector': f'{notebook}:{subdir}/{f.name}',
                            'meta': {k: str(v).strip() if v is not None else ''
                                     for k, v in meta.items()},
                        }
                except Exception:
                    pass
        return out

    # characters/ keyed by stem (BILL, AMY…); cast/ keyed by stem (jim_dandy…)
    characters = _scan_dir('characters')
    cast       = _scan_dir('cast')
    locations  = _scan_dir('locations', 'alias')
    resources  = _scan_dir('resources', 'code')

    scenes = []
    script_dir = nb_path / 'script'
    if script_dir.is_dir():
        for f in sorted(script_dir.glob('*.md')):
            try:
                meta, body = parse_frontmatter(f.read_text(errors='replace'))
                if meta.get('type') != 'scene':
                    continue  # skip cover page and non-scene files
                synopsis = next(
                    (l.strip() for l in body.splitlines() if l.strip() and not l.startswith('#')),
                    ''
                )
                scenes.append({
                    'selector':  f'{notebook}:script/{f.name}',
                    'alias':     str(meta.get('alias',    '')),
                    'int_ext':   str(meta.get('int_ext',  '')).upper()[:1],
                    'day_night': str(meta.get('day_night','N')).upper()[:1],
                    'loc':       str(meta.get('loc',      '')),
                    'synopsis':  synopsis[:120],
                })
            except Exception:
                pass
    def _scene_sort_key(s):
        v = s['alias']
        return (int(v) if v.isdigit() else 999, v)
    scenes.sort(key=_scene_sort_key)

    # Build a lookup for scene resolution: alias → selector, stem → selector
    _scene_lookup = {}
    for sc in scenes:
        if sc['alias']:
            _scene_lookup[sc['alias'].lower()] = sc['selector']
        stem = sc['selector'].rsplit('/', 1)[-1]
        if stem.endswith('.md'):
            stem = stem[:-3]
        _scene_lookup[stem.lower()] = sc['selector']

    def _resolve_scene_refs(raw):
        """Split a comma-separated scenes: field, resolve each to a selector."""
        resolved = []
        for token in re.split(r'[,\s]+', str(raw or '')):
            token = token.strip()
            if not token:
                continue
            sel = _scene_lookup.get(token.lower())
            resolved.append({'ref': token, 'selector': sel})
        return resolved

    storylines_dir = nb_path / 'storylines'
    lanes        = []
    _story_raws  = []   # collected before lane lookup is built
    if storylines_dir.is_dir():
        for f in sorted(storylines_dir.glob('*.md')):
            try:
                meta, _ = parse_frontmatter(f.read_text(errors='replace'))
                ftype = str(meta.get('type', '')).strip().lower()
                stem  = f.stem
                if ftype == 'storyline':
                    lanes.append({
                        'selector': f'{notebook}:storylines/{f.name}',
                        'filename': f.name,
                        'stem':     stem,
                        'title':    str(meta.get('title', stem)),
                        'color':    str(meta.get('color', '')),
                        'seq':      _cine_int(meta.get('seq'), 999),
                    })
                elif ftype == 'story':
                    _story_raws.append((f, meta, stem))
            except Exception:
                pass

    # Resolve storyline: by stem OR title (natural to write the title)
    _lane_lookup = {}
    for lane in lanes:
        _lane_lookup[lane['stem'].lower()]          = lane['stem']
        _lane_lookup[lane['title'].strip().lower()] = lane['stem']

    stories = []
    for f, meta, stem in _story_raws:
        raw_sl     = str(meta.get('storyline', '')).strip()
        storyline  = _lane_lookup.get(raw_sl.lower(), raw_sl)
        scenes_raw = meta.get('scenes', '')
        stories.append({
            'selector':   f'{notebook}:storylines/{f.name}',
            'filename':   f.name,
            'stem':       stem,
            'title':      str(meta.get('title', stem)).strip(),
            'storyline':  storyline,
            'seq':        _cine_int(meta.get('seq'), 999),
            'scenes':     _resolve_scene_refs(scenes_raw),
            'scenes_raw': str(scenes_raw),
            'color':      str(meta.get('color', '')),
            'meta':       {k: v for k, v in meta.items() if k != 'type'},
        })

    lanes.sort(key=lambda l: l['seq'])
    stories.sort(key=lambda s: (s['storyline'], s['seq']))

    # Scene coverage: which scene selectors are claimed by at least one story
    claimed = {ref['selector'] for st in stories for ref in st['scenes'] if ref['selector']}
    orphan_scenes = [sc for sc in scenes if sc['selector'] not in claimed]

    return jsonify({
        'shots':         shots,
        'scenes':        scenes,
        'characters':    characters,
        'cast':          cast,
        'locations':     locations,
        'resources':     resources,
        'config':        config,
        'lanes':         lanes,
        'stories':       stories,
        'orphan_scenes': orphan_scenes,
    })


def _patch_fm_fields(raw_text, **fields):
    """Update specific frontmatter fields in-place, preserving all other content.

    Processes line-by-line to avoid regex \s* consuming newlines into the key
    prefix, which caused blank-line corruption when writing empty values.
    Also drops orphaned bare-integer continuation lines (e.g. 'day:\\n1').
    """
    if not raw_text.startswith('---'):
        return raw_text
    end = raw_text.find('\n---', 3)
    if end == -1:
        return raw_text
    fm_text = raw_text[3:end]
    body    = raw_text[end + 4:]

    lines   = fm_text.split('\n')
    updated = set()
    result  = []
    skip_next = False
    key_pat = {k: re.compile(r'^' + re.escape(k) + r':[ \t]*') for k in fields}

    for i, line in enumerate(lines):
        if skip_next:
            skip_next = False
            continue
        matched = next((k for k, p in key_pat.items() if p.match(line)), None)
        if matched is not None:
            v = fields[matched]
            result.append(f'{matched}: {v}' if v != '' else f'{matched}:')
            updated.add(matched)
            # Drop an orphaned bare-integer on the very next line
            if i + 1 < len(lines) and re.match(r'^[ \t]*\d+[ \t]*$', lines[i + 1]):
                skip_next = True
        else:
            result.append(line)

    for key, value in fields.items():
        if key not in updated:
            result.append(f'{key}: {value}' if value != '' else f'{key}:')

    return f"---{chr(10).join(result)}\n---{body}"


@app.route('/api/cine/resequence', methods=['POST'])
def api_cine_resequence():
    """Batch-update day: and seq: frontmatter fields across a set of shots.

    Body: {
        "notebook": "Takeout",
        "moves": [{"selector": "Takeout:shots/1a.md", "day": 1, "seq": 1}, ...]
    }
    Returns: {"updated": [...selectors], "errors": [...{selector, error}]}
    """
    data  = request.get_json(silent=True) or {}
    moves = data.get('moves', [])
    if not moves:
        return jsonify({'error': 'moves required'}), 400

    notebook = data.get('notebook', '')
    updated  = []
    errors   = []

    for move in moves:
        selector = move.get('selector', '')
        try:
            day_raw = move.get('day')
            day = int(day_raw) if day_raw is not None else None
            seq = int(move['seq'])
        except (KeyError, TypeError, ValueError):
            errors.append({'selector': selector, 'error': 'day and seq must be integers'})
            continue

        fpath = _resolve_to_nb_path(selector)
        if not fpath or not fpath.is_file():
            errors.append({'selector': selector, 'error': 'not found'})
            continue

        if not notebook:
            try:
                notebook = fpath.relative_to(NB_DIR).parts[0]
            except ValueError:
                pass

        try:
            raw     = fpath.read_text(errors='replace')
            patched = _patch_fm_fields(raw, day=day if day is not None else '""', seq=seq)
            fpath.write_text(patched)
            updated.append(selector)
        except Exception as e:
            errors.append({'selector': selector, 'error': str(e)})

    if updated and notebook:
        nb_path = NB_DIR / notebook
        if nb_path.is_dir() and (nb_path / '.git').exists():
            try:
                subprocess.run(['git', 'add', '-A'], capture_output=True,
                               cwd=str(nb_path), timeout=10)
                subprocess.run(
                    ['git', 'commit', '-m',
                     f'[nb-web] Resequence {len(updated)} shot(s)'],
                    capture_output=True, cwd=str(nb_path), timeout=10)
            except Exception:
                pass  # git failure is non-fatal; files are already written

    return jsonify({'updated': updated, 'errors': errors})


@app.route('/api/cine/story/resequence', methods=['POST'])
def api_cine_story_resequence():
    """Batch-update storyline: and seq: frontmatter fields on story cards.

    Body: {
        "notebook": "Takeout",
        "moves": [{"selector": "Takeout:storylines/they-lose-the-car.md",
                   "storyline": "main-plot", "seq": 3}, ...]
    }
    Returns: {"updated": [...selectors], "errors": [...{selector, error}]}
    """
    data  = request.get_json(silent=True) or {}
    moves = data.get('moves', [])
    if not moves:
        return jsonify({'error': 'moves required'}), 400

    notebook = data.get('notebook', '')
    updated  = []
    errors   = []

    for move in moves:
        selector = move.get('selector', '')
        try:
            storyline = str(move['storyline'])
            seq       = int(move['seq'])
        except (KeyError, TypeError, ValueError):
            errors.append({'selector': selector, 'error': 'storyline and seq required'})
            continue

        fpath = _resolve_to_nb_path(selector)
        if not fpath or not fpath.is_file():
            errors.append({'selector': selector, 'error': 'not found'})
            continue

        if not notebook:
            try:
                notebook = fpath.relative_to(NB_DIR).parts[0]
            except ValueError:
                pass

        try:
            raw     = fpath.read_text(errors='replace')
            patched = _patch_fm_fields(raw, storyline=storyline, seq=seq)
            fpath.write_text(patched)
            updated.append(selector)
        except Exception as e:
            errors.append({'selector': selector, 'error': str(e)})

    if updated and notebook:
        nb_path = NB_DIR / notebook
        if nb_path.is_dir() and (nb_path / '.git').exists():
            try:
                subprocess.run(['git', 'add', '-A'], capture_output=True,
                               cwd=str(nb_path), timeout=10)
                subprocess.run(
                    ['git', 'commit', '-m',
                     f'[nb-web] Resequence {len(updated)} story card(s)'],
                    capture_output=True, cwd=str(nb_path), timeout=10)
            except Exception:
                pass

    return jsonify({'updated': updated, 'errors': errors})


@app.route('/api/cine/story/create', methods=['POST'])
def api_cine_story_create():
    """Create a new story card in storylines/.

    Body: {
        "notebook":  "Takeout",
        "title":     "They lose the car",
        "storyline": "main-plot",   # lane stem (already resolved)
        "seq":       4              # optional; auto-assigned if absent
    }
    Returns: {"selector": "Takeout:storylines/they-lose-the-car.md", "ok": true}
    """
    data      = request.get_json(silent=True) or {}
    notebook  = data.get('notebook', '').strip()
    title     = data.get('title', '').strip()
    storyline = data.get('storyline', '').strip()

    if not notebook or not title:
        return jsonify({'error': 'notebook and title required'}), 400

    nb_path        = NB_DIR / notebook
    storylines_dir = nb_path / 'storylines'
    if not nb_path.is_dir():
        return jsonify({'error': 'notebook not found'}), 404

    storylines_dir.mkdir(exist_ok=True)

    # Auto-assign seq: max existing seq in this lane + 1
    seq = data.get('seq')
    if seq is None:
        max_seq = 0
        if storylines_dir.is_dir():
            for f in storylines_dir.glob('*.md'):
                try:
                    m, _ = parse_frontmatter(f.read_text(errors='replace'))
                    if str(m.get('type', '')).strip().lower() == 'story' \
                            and str(m.get('storyline', '')).strip() == storyline:
                        max_seq = max(max_seq, int(m.get('seq') or 0))
                except Exception:
                    pass
        seq = max_seq + 1

    # Build filename from title — slugify
    slug = re.sub(r'[^a-z0-9]+', '_', title.lower()).strip('_')[:48]
    fpath = storylines_dir / f'{slug}.md'
    # Avoid collision
    counter = 1
    while fpath.exists():
        fpath = storylines_dir / f'{slug}_{counter}.md'
        counter += 1

    # Load template if it exists, otherwise use minimal scaffold
    tmpl_path = nb_path / '.templates' / 'story.md'
    global_tmpl = NB_DIR / '.templates' / 'story.md'
    if tmpl_path.exists():
        scaffold = tmpl_path.read_text(errors='replace')
        scaffold = _resolve_template_vars(scaffold, title=title)
        # Inject storyline + seq into the frontmatter
        scaffold = _patch_fm_fields(scaffold, storyline=storyline, seq=seq)
    elif global_tmpl.exists():
        scaffold = global_tmpl.read_text(errors='replace')
        scaffold = _resolve_template_vars(scaffold, title=title)
        scaffold = _patch_fm_fields(scaffold, storyline=storyline, seq=seq)
    else:
        # Minimal hardcoded scaffold — works before the template exists
        scaffold = (
            f'---\ntype: story\ntitle: {title}\nstoryline: {storyline}\n'
            f'seq: {seq}\nscenes:\ncharacters:\ndesc:\n---\n'
        )

    fpath.write_text(scaffold)

    # Update nb index and git commit
    selector = f'{notebook}:storylines/{fpath.name}'
    idx_path = storylines_dir / '.index'
    if idx_path.exists():
        existing = idx_path.read_text().splitlines()
        if fpath.name not in existing:
            idx_path.write_text('\n'.join(existing + [fpath.name]) + '\n')
    else:
        idx_path.write_text(fpath.name + '\n')

    if (nb_path / '.git').exists():
        try:
            subprocess.run(['git', 'add', '-A'], capture_output=True,
                           cwd=str(nb_path), timeout=10)
            subprocess.run(
                ['git', 'commit', '-m', f'[nb-web] Add story: {title}'],
                capture_output=True, cwd=str(nb_path), timeout=10)
        except Exception:
            pass

    return jsonify({'ok': True, 'selector': selector, 'filename': fpath.name})


@app.route('/api/cine/lock', methods=['POST'])
def api_cine_lock():
    """Set or remove the lock: field in a note's frontmatter.

    Body: {"selector": "Takeout:shots/1a.md", "locked": true|false}
    Returns: {"ok": true}
    """
    data     = request.get_json(silent=True) or {}
    selector = data.get('selector', '')
    locked   = bool(data.get('locked', False))
    if not selector:
        return jsonify({'error': 'selector required'}), 400

    try:
        fpath = _resolve_to_nb_path(selector)
        if not fpath or not fpath.is_file():
            return jsonify({'error': 'not found'}), 404
        raw = fpath.read_text(errors='replace')
        if locked:
            patched = _patch_fm_fields(raw, lock='yes')
        else:
            patched = _patch_fm_fields(raw, lock='')
        fpath.write_text(patched)
        try:
            notebook = fpath.relative_to(NB_DIR).parts[0]
            nb_path  = NB_DIR / notebook
            if (nb_path / '.git').exists():
                subprocess.run(['git', 'add', str(fpath)], capture_output=True,
                               cwd=str(nb_path), timeout=10)
                action = 'Lock' if locked else 'Unlock'
                subprocess.run(['git', 'commit', '-m',
                                f'[nb-web] {action}: {fpath.name}'],
                               capture_output=True, cwd=str(nb_path), timeout=10)
        except Exception:
            pass  # git failure is non-fatal
    except Exception as e:
        return jsonify({'error': str(e)}), 500

    return jsonify({'ok': True})


# ---------------------------------------------------------------------------
# Dev: restart server
# ---------------------------------------------------------------------------

@app.route('/restart')
def restart_page():
    """Emergency restart page — reachable from address bar when UI is broken."""
    return Response('''<!doctype html>
<html><head><meta charset="utf-8"><title>nb-web restart</title>
<style>body{font-family:monospace;padding:2em;background:#1a1a1a;color:#ccc}
button{padding:.5em 1.5em;background:#c66;color:#fff;border:none;border-radius:4px;
cursor:pointer;font-size:1em}button:hover{background:#e55}</style></head>
<body><h2>nb-web</h2>
<p>Click to restart the server and reload.</p>
<button onclick="fetch('/api/restart',{method:'POST'}).then(()=>{
  setTimeout(()=>location.href='/',1500)})">Restart Server</button>
<p id="s"></p>
<script>document.querySelector('button').addEventListener('click',function(){
  document.getElementById('s').textContent='Restarting…';this.disabled=true})</script>
</body></html>''', mimetype='text/html')


@app.route('/api/restart', methods=['POST'])
def api_restart():
    def _kill_zombies():
        my_pid = os.getpid()
        try:
            result = subprocess.run(['pgrep', '-f', 'app.py'],
                                    capture_output=True, text=True)
            for pid_str in result.stdout.strip().split():
                try:
                    pid = int(pid_str)
                    if pid != my_pid:
                        os.kill(pid, signal.SIGTERM)
                except (ValueError, ProcessLookupError):
                    pass
        except Exception:
            pass

    def _do_restart():
        time.sleep(0.3)
        _kill_zombies()
        time.sleep(0.5)  # let zombies die before we take the port
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


@app.route('/sw.js')
def serve_sw():
    """Serve sw.js with the current git hash as the cache key.
    Ensures every commit auto-invalidates the SW cache without manual bumps."""
    try:
        rev = subprocess.check_output(
            ['git', 'rev-parse', '--short', 'HEAD'],
            cwd=str(Path(__file__).parent), text=True
        ).strip()
    except Exception:
        rev = 'dev'
    content = (Path(__file__).parent / 'sw.js').read_text()
    content = re.sub(r"const CACHE = 'nb-web-[^']*'",
                     f"const CACHE = 'nb-web-{rev}'", content)
    return Response(content, mimetype='application/javascript',
                    headers={'Cache-Control': 'no-store'})


@app.errorhandler(404)
def not_found(_):
    return send_from_directory('.', 'index.html')


# ---------------------------------------------------------------------------
# Startup: assert correct git tracking for all notebooks
# ---------------------------------------------------------------------------

_PREPUSH_HOOK = """\
#!/bin/bash
# nb-web: block pushes to any branch other than this notebook's own branch.
# Prevents cross-notebook contamination from 'nb sync' or accidental git push.
NOTEBOOK=$(basename "$(git rev-parse --show-toplevel)")
while read local_ref local_sha remote_ref remote_sha; do
    [ "$remote_ref" = "refs/heads/$NOTEBOOK" ] && continue
    echo "[nb-web] BLOCKED: push to $remote_ref" >&2
    echo "[nb-web]   This notebook only pushes to refs/heads/$NOTEBOOK" >&2
    echo "[nb-web]   Use the nb-web sync dialog to push correctly." >&2
    exit 1
done
exit 0
"""

def _install_prepush_hooks():
    """Write a pre-push hook into every notebook git repo that has a remote.

    The hook blocks pushes to any branch other than the notebook's own branch,
    preventing 'nb sync' or stray git commands from causing cross-contamination.
    Idempotent — only writes if the file is missing or outdated.
    """
    installed, skipped = [], []
    try:
        notebooks = sorted(
            d for d in NB_DIR.iterdir()
            if d.is_dir() and not d.name.startswith('.')
            and not d.name.startswith('-') and (d / '.git').exists()
        )
    except Exception as e:
        print(f'[nb-web] pre-push hook install failed: {e}', flush=True)
        return

    for nb_path in notebooks:
        hook_path = nb_path / '.git' / 'hooks' / 'pre-push'
        try:
            if hook_path.exists() and hook_path.read_text() == _PREPUSH_HOOK:
                skipped.append(nb_path.name)
                continue
            hook_path.write_text(_PREPUSH_HOOK)
            hook_path.chmod(0o755)
            installed.append(nb_path.name)
        except Exception as e:
            print(f'[nb-web] pre-push hook failed for {nb_path.name}: {e}', flush=True)

    if installed:
        print(f'[nb-web] pre-push hook installed: {", ".join(installed)}', flush=True)
    print(f'[nb-web] pre-push hook OK ({len(skipped)} already set, {len(installed)} updated)', flush=True)


def _assert_notebook_tracking():
    """Ensure every nb notebook with a remote tracks origin/<name>, not origin/master.

    Safe and idempotent — read-only unless a config value is wrong.
    """
    env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_ASKPASS': '/bin/true'}
    fixed, checked = [], 0
    try:
        notebooks = sorted(
            d for d in NB_DIR.iterdir()
            if d.is_dir() and not d.name.startswith('.')
            and not d.name.startswith('-') and (d / '.git').exists()
        )
    except Exception as e:
        print(f'[nb-web] tracking check failed: {e}', flush=True)
        return

    for nb_path in notebooks:
        name = nb_path.name
        remote_r = subprocess.run(['git', 'remote'], capture_output=True, text=True,
                                  cwd=str(nb_path), timeout=5, env=env)
        if not remote_r.stdout.strip():
            continue  # no remote — nothing to assert
        checked += 1

        want_merge  = f'refs/heads/{name}'
        have_merge  = subprocess.run(
            ['git', 'config', 'branch.master.merge'],
            capture_output=True, text=True, cwd=str(nb_path), timeout=5, env=env
        ).stdout.strip()
        have_remote = subprocess.run(
            ['git', 'config', 'branch.master.remote'],
            capture_output=True, text=True, cwd=str(nb_path), timeout=5, env=env
        ).stdout.strip()

        if have_merge != want_merge:
            subprocess.run(['git', 'config', 'branch.master.merge', want_merge],
                           cwd=str(nb_path), timeout=5, env=env)
            fixed.append(f'{name}: merge {have_merge!r}→{want_merge!r}')
        if have_remote and have_remote != 'origin':
            subprocess.run(['git', 'config', 'branch.master.remote', 'origin'],
                           cwd=str(nb_path), timeout=5, env=env)
            fixed.append(f'{name}: remote {have_remote!r}→origin')

    if fixed:
        print(f'[nb-web] tracking corrected: {"; ".join(fixed)}', flush=True)
    else:
        print(f'[nb-web] tracking OK ({checked} notebooks checked)', flush=True)


def _assert_nb_auto_sync_off():
    """Force NB_AUTO_SYNC=0 on every startup.

    nb's auto-sync pulls from origin on every add/edit/delete. With per-notebook
    branches this causes silent cross-contamination. nb-web's sync dialog is the
    only intended sync mechanism.
    """
    try:
        r = subprocess.run([NB_BIN, 'set', 'auto_sync', '0'],
                           capture_output=True, text=True, timeout=5)
        if 'set to 0' in r.stdout + r.stderr:
            print('[nb-web] NB_AUTO_SYNC → 0 (was 1; prevented cross-notebook contamination)', flush=True)
        else:
            print('[nb-web] NB_AUTO_SYNC: OK (0)', flush=True)
    except Exception as e:
        print(f'[nb-web] NB_AUTO_SYNC check failed: {e}', flush=True)


if __name__ == '__main__':
    WEB_PLUGINS_DIR.mkdir(parents=True, exist_ok=True)
    _assert_nb_auto_sync_off()
    _assert_notebook_tracking()
    _install_prepush_hooks()
    os.environ.pop('WERKZEUG_RUN_MAIN', None)
    os.environ.pop('WERKZEUG_SERVER_FD', None)
    app.run(host=HOST, port=PORT, debug=DEBUG, use_reloader=False, threaded=True)

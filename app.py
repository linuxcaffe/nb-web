#!/usr/bin/env python3
"""nb-web — Flask backend for nb note-taking web interface."""

import fnmatch
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
import io
import secrets
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
CHECK_DIR             = NB_DIR / '.checks'
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


def _effective_setting(key, default=None):
    """Read a portable config key from ~/.nb/.nb.md."""
    val = _global_config().get(key)
    return val if val is not None else default


def _cb_write_allowed(block_type):
    """Return True if the current session user meets the write level for block_type."""
    level = (_effective_setting('codeblock_access') or {}).get(block_type, {}).get('write')
    if not level:
        return True
    user = session.get('user', {})
    return _level_gte(user.get('level', ''), level)


# ---------------------------------------------------------------------------
# Template variable resolution
# ---------------------------------------------------------------------------

_weather_cache: dict = {'value': None, 'ts': 0.0}
_check_cache:    dict = {}   # (script, selector) -> {'result': dict, 'ts': float}
_CHECK_CACHE_TTL = 30        # seconds; force=True bypasses

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
        '{{name}}':    title,   # alias used in notebook-scoped templates
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


def _nb_index_reconcile(path):
    """Run `nb index reconcile <path>` directly -- NOT via run_nb(), because
    run_nb()'s unconditional trailing `--no-color` breaks this specific
    subcommand: `_index()`'s reconcile arg-parser only recognizes
    `--ancestors`/`--commit`/`--checkpoint`, and treats any other trailing arg
    (including `--no-color`) as an override for the folder-path argument that
    came before it -- silently reconciling the wrong (nonexistent) path instead
    of `path`. NO_COLOR=1 in the env is sufficient for quiet output; verified
    against a scratch copy that this reconciles the intended folder and
    correctly de-duplicates .index (confirmed root cause of a real ~/.nb/djp
    corruption incident, 2026-07-07 -- see feedback_test_isolation_subprocess_env
    memory for the unrelated but similarly-shaped pytest bug found the same day).
    """
    subprocess.run([NB_BIN, 'index', 'reconcile', str(path)],
                   capture_output=True, text=True,
                   env={**os.environ, 'NO_COLOR': '1'})


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
    # Reject quotes, shell metacharacters, and path traversal
    if any(c in name for c in ('"', "'", '`', '$', '!', '?', '*', '&', '|', ';', '<', '>', '(', ')')):
        return None
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

from werkzeug.security import check_password_hash, generate_password_hash

USERS_DIR  = NB_DIR / '.users'
LEVELS     = ['guest', 'user', 'office', 'admin', 'tech']
DOTFOLDERS = ['.users', '.tools', '.changes', '.images', '.rules', '.lib', '.checks']

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

# Persistent local API token -- for standalone desktop scripts (nb-new-item,
# etc.) that call nb-web's HTTP API directly, outside any browser session.
# Same pattern as _get_secret_key(): generated once, stored 0600 next to
# app.py. Not a per-user credential -- scripts run as whoever is at the
# keyboard on this single-user machine, so the token maps to a fixed
# account (NB_WEB_API_USER, default 'djp') rather than being minted per login
# like the short-lived MCP token.
_API_TOKEN_FILE = Path(__file__).parent / '.api_token'
API_TOKEN_USER  = os.environ.get('NB_WEB_API_USER', 'djp')

def _get_api_token():
    if _API_TOKEN_FILE.exists():
        return _API_TOKEN_FILE.read_text().strip()
    key = secrets.token_hex(32)
    _API_TOKEN_FILE.write_text(key + '\n')
    _API_TOKEN_FILE.chmod(0o600)
    return key

API_TOKEN = _get_api_token()

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

def _load_user_by_name(display_name):
    """Find a user whose name: field matches display_name (case-insensitive)."""
    if not USERS_DIR.exists():
        return None
    needle = display_name.strip().lower()
    for path in USERS_DIR.glob('*.md'):
        stem = path.stem
        if not _RE_USERNAME.match(stem):
            continue
        try:
            meta, _ = parse_frontmatter(path.read_text())
            if str(meta.get('name', '')).lower() == needle:
                nbs = meta.get('notebooks')
                return {
                    'username':      stem,
                    'name':          str(meta.get('name', stem)),
                    'level':         str(meta.get('level', 'user')),
                    'notebooks':     list(nbs) if isinstance(nbs, (list, tuple)) else [],
                    'password_hash': str(meta.get('password_hash', '')),
                }
        except Exception:
            continue
    return None

def _level_gte(have, need):
    try:
        return LEVELS.index(have) >= LEVELS.index(need)
    except ValueError:
        return False

def _global_config():
    """Read ~/.nb/.nb.md and return its frontmatter dict."""
    cfg = NB_DIR / '.nb.md'
    if not cfg.exists():
        return {}
    try:
        meta, _ = parse_frontmatter(cfg.read_text())
        return meta
    except Exception:
        return {}


def _collect_cascading_tokens(key, notebook, note_path):
    """Union all `key`: values from global → notebook → folder configs.

    Shared by check_add: (accumulates additions to the effective check set)
    and check_skip: (accumulates exclusions from it) — both never override,
    always union across every level so more-specific configs extend rather
    than replace the base set. Returns a deduplicated space-separated
    string of prefixes/names.
    """
    def _read_raw(path):
        try:
            meta, _ = parse_frontmatter(Path(path).read_text())
            return meta
        except Exception:
            return {}

    def _extract(meta):
        val = meta.get(key)
        if not val:
            return []
        if isinstance(val, list):
            return [str(v).strip() for v in val if v]
        return str(val).strip().split()

    tokens = []
    tokens.extend(_extract(_read_raw(NB_DIR / '.nb.md')))

    nb_cfg = NB_DIR / notebook / f'.{notebook}.md'
    tokens.extend(_extract(_read_raw(nb_cfg)))

    nb_root = NB_DIR / notebook
    try:
        folder = Path(note_path)
        if folder.is_file():
            folder = folder.parent
        folder_layers = []
        current = folder
        while True:
            if not str(current).startswith(str(nb_root)) or current == nb_root:
                break
            cfg_file = current / f'.{current.name}.md'
            if cfg_file.exists():
                folder_layers.append(_extract(_read_raw(cfg_file)))
            current = current.parent
        for layer in reversed(folder_layers):
            tokens.extend(layer)
    except Exception:
        pass

    seen = {}
    for t in tokens:
        if t:
            seen[t] = None
    return ' '.join(seen.keys())


def _collect_check_add(notebook, note_path):
    """Union all check_add: values from global → notebook → folder configs.

    Unlike check: (which overrides), check_add: accumulates across every
    level so more-specific configs extend rather than replace the base set.
    """
    return _collect_cascading_tokens('check_add', notebook, note_path)


def _collect_check_skip(notebook, note_path):
    """Union all check_skip: values from global → notebook → folder configs.

    Subtracted from the resolved (check: ∪ check_add:) set at render time —
    see main.js _virtualTestPrefix. A skip entry ending in '-' excludes any
    token in that family (exact family-glob token, or any individual script
    name sharing the prefix); an exact entry excludes only that exact token.
    """
    return _collect_cascading_tokens('check_skip', notebook, note_path)


def _notebook_config(notebook):
    """Read ~/.nb/{notebook}/.{notebook}.md merged over global config."""
    base = _global_config()
    cfg = NB_DIR / notebook / f'.{notebook}.md'
    if not cfg.exists():
        return base
    try:
        meta, _ = parse_frontmatter(cfg.read_text())
        return _merge_configs(base, meta)
    except Exception:
        return base


def _merge_configs(base, override):
    """Merge two config dicts; override wins, recurse into nested dicts."""
    if not override:
        return base
    result = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(result.get(k), dict):
            result[k] = _merge_configs(result[k], v)
        else:
            result[k] = v
    return result


def _folder_config(notebook, note_path):
    """Return merged config for a note: notebook manifest + folder walk-up.

    Walks from note_path's directory up to the notebook root, collecting
    .{foldername}.md configs. Child folders win over parents, parents win
    over the notebook manifest.
    """
    nb_root = NB_DIR / notebook
    base = _notebook_config(notebook)
    try:
        folder = Path(note_path)
        if folder.is_file():
            folder = folder.parent
    except Exception:
        return base

    # Walk up collecting folder configs (innermost first)
    configs = []
    current = folder
    while True:
        if not str(current).startswith(str(nb_root)) or current == nb_root:
            break
        cfg_file = current / f'.{current.name}.md'
        if cfg_file.exists():
            try:
                meta, _ = parse_frontmatter(cfg_file.read_text())
                configs.append(meta)
            except Exception:
                pass
        current = current.parent

    # Apply outermost→innermost so innermost wins
    result = base
    for cfg in reversed(configs):
        result = _merge_configs(result, cfg)
    return result


def _folder_config_sources(notebook, note_path):
    """Like _folder_config but also returns a {key: nb-relative-path} sources dict."""
    nb_root = NB_DIR / notebook
    try:
        folder = Path(note_path)
        if folder.is_file():
            folder = folder.parent
    except Exception:
        return _notebook_config(notebook), {}

    # Notebook-level config: parent chain is global config only
    try:
        folder.relative_to(nb_root)
    except ValueError:
        base = _global_config()
        return base, {k: '.nb.md' for k in base}

    configs_with_paths = []
    current = folder
    while True:
        if not str(current).startswith(str(nb_root)) or current == nb_root:
            break
        cfg_file = current / f'.{current.name}.md'
        if cfg_file.exists():
            try:
                meta, _ = parse_frontmatter(cfg_file.read_text())
                configs_with_paths.append((meta, str(cfg_file.relative_to(nb_root))))
            except Exception:
                pass
        current = current.parent

    nb_cfg_file = nb_root / f'.{notebook}.md'
    nb_rel = str(nb_cfg_file.relative_to(nb_root)) if nb_cfg_file.exists() else f'.{notebook}.md'

    base = _notebook_config(notebook)
    sources = {k: nb_rel for k in base}
    result = dict(base)
    for meta, rel_path in reversed(configs_with_paths):
        for k, v in meta.items():
            if isinstance(v, dict) and isinstance(result.get(k), dict):
                result[k] = _merge_configs(result[k], v)
            else:
                result[k] = v
            sources[k] = rel_path
    return result, sources


def _effective_access(note_meta, nb_meta):
    """Return the access specifier for a note.

    Resolution order:
      note access:    → explicit override (level string or username), always wins
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

def _can_access(user, note_meta, nb_meta):
    """Return True if user can access a note/folder/notebook.

    Extends _effective_access to support username-specific access:
      access: djp  → only the user with username 'djp' can see it.
      tech level   → bypasses username-specific locks for recovery.
    """
    access = _effective_access(note_meta, nb_meta)
    if access not in LEVELS:
        return user.get('level') == 'tech' or user.get('username') == access
    return _level_gte(user.get('level', ''), access)


def _effective_claude(note_meta, nb_meta):
    """Return the claude: model/availability specifier for a note, or '' if
    unconfigured anywhere in the cascade (nbweb-claude's badge simply doesn't
    render on ''  — no fallback model, unlike _effective_access's 'user' default).

    Resolution order (nearest-wins, note+notebook only for now — deliberately
    matching _effective_access's own scope rather than the full folder-walk
    cascade _folder_config gives check_skip/etc.; widen only if a real need
    for folder-level override shows up):
      note claude:     → explicit override, always wins. Empty string is a
                         real value here, not "unset" — it's the documented
                         convention for turning availability off down a branch.
      notebook config  → claude: in .<notebook>.md
      unset            → '' (no badge)
    """
    if 'claude' in note_meta:
        return str(note_meta['claude'] or '')
    return str(nb_meta.get('claude') or '')


def _effective_claude_account(note_meta, nb_meta):
    """Return the claude_account: ledger-accounting label for a note, or ''
    if unconfigured anywhere in the cascade. Same nearest-wins resolution
    as _effective_claude -- a project's dashboard/notebook config can set a
    sensible default (e.g. claude_account: nb-web) that individual todos
    inherit unless they override with a more specific aspect
    (claude_account: nb-web:help). The ledger writer falls back to a
    model-based label when this resolves to '' -- deliberately not guessed
    here from the notebook name, since the notebook a todo lives in and the
    project it's about aren't reliably the same thing (a todo living in the
    claude notebook can account to nb-web:help, and often should).
    """
    if 'claude_account' in note_meta:
        return str(note_meta['claude_account'] or '')
    return str(nb_meta.get('claude_account') or '')


# Tokens ui_hide: is allowed to name, v1. Unknown tokens are silently
# dropped rather than erroring -- lets nav/opts (a separate, larger
# follow-up -- global chrome, not part of a note's own rendered content,
# unlike these two) be written into frontmatter ahead of time without
# breaking anything once that lands.
_UI_HIDE_TOKENS_V1 = {'fm', 'annotation'}

def _effective_ui_hide(note_meta, nb_meta):
    """Return the effective ui_hide: token list (comma-joined string) for
    a note -- note's own value wins if present, else cascades from
    folder/notebook/global config, same nearest-wins resolution as
    _effective_claude_account. Declarative default for the extras-toggle
    button (nb-extras-btn): a note/folder can decide its frontmatter
    and/or annotation foot start hidden without a manual per-session
    toggle. Not a security boundary -- purely a rendering default, same
    framing as the ui-hide-* access-level mechanism this reuses the
    cascade pattern from (see claude:nb-web_tier_4b_—_ui-access_hide_profiles_(design).md)
    -- that one gates action buttons by user level; this one is a
    content-authoring preference, independent of who's viewing.
    """
    raw = note_meta['ui_hide'] if 'ui_hide' in note_meta else nb_meta.get('ui_hide')
    if not raw:
        return ''
    tokens = [t.strip() for t in str(raw).split(',') if t.strip()]
    return ','.join(t for t in tokens if t in _UI_HIDE_TOKENS_V1)


def _resolve_claude_account(selector):
    """Resolve the claude_account: FM cascade for a selector, or '' if
    unconfigured anywhere. Mirrors _resolve_claude_model_flag exactly.
    """
    if ':' not in selector:
        return ''
    notebook = selector.split(':')[0]
    fpath = _resolve_to_nb_path(selector)
    if not fpath or not fpath.is_file():
        return ''
    try:
        raw = fpath.read_text(errors='replace')
    except OSError:
        return ''
    note_meta, _ = parse_frontmatter(raw)
    nb_meta = _folder_config(notebook, fpath)
    return _effective_claude_account(note_meta, nb_meta)


def _resolve_claude_model_flag(selector):
    """Resolve the claude: FM cascade to a --model value for the CLI, or ''
    if unconfigured. Values already match the CLI's own alias vocabulary
    ('opus', 'sonnet', 'fable', ...) verbatim -- no translation needed.
    Previously this cascade only drove the badge display; the CLI call
    ignored it entirely and always ran whatever the host's own claude
    account defaults to.
    """
    if ':' not in selector:
        return ''
    notebook = selector.split(':')[0]
    fpath = _resolve_to_nb_path(selector)
    if not fpath or not fpath.is_file():
        return ''
    try:
        raw = fpath.read_text(errors='replace')
    except OSError:
        return ''
    note_meta, _ = parse_frontmatter(raw)
    nb_meta = _folder_config(notebook, fpath)
    return _effective_claude(note_meta, nb_meta)


_MANIFEST_PATH = NB_DIR / '.manifest.md'


def _manifest_repo_paths():
    """Parse .manifest.md's Repos table (a fenced ```csv block under
    "## Repos") into {name: local_path}. Read fresh every call -- this
    file changes rarely and an ask/goal call is nowhere near a hot enough
    path to justify a cache-invalidation story. Distinguishes the Repos
    block from the earlier "## Notebooks" one (a different ```csv block,
    different columns) by its header row rather than assuming block order,
    since both are fenced the same way.
    """
    try:
        text = _MANIFEST_PATH.read_text(errors='replace')
    except OSError:
        return {}
    paths = {}
    for block in re.findall(r'```csv\n(.*?)\n```', text, re.DOTALL):
        lines = block.strip().splitlines()
        if not lines or not lines[0].startswith('name,type,local'):
            continue
        for row in csv.DictReader(lines):
            name  = (row.get('name') or '').strip()
            local = (row.get('local') or '').strip()
            if name and local and local != '-':
                paths[name] = local
    return paths


def _resolve_repo_cwd(selector):
    """Resolve the actual code repository a todo concerns, via
    claude_account:'s project-name portion (the part before any :aspect
    suffix) looked up against .manifest.md's own Repos registry -- so
    CLAUDE.md/.rules auto-load for the real codebase a task is about,
    not just the notes notebook the todo happens to live in. Confirmed
    real gap 2026-07-12: an ask/goal session on a `claude:`-notebook todo
    about nb-web internals had no way to find nb-web at all, cwd'd into
    ~/.nb/claude/ with nothing but markdown notes in it.

    Returns '' (caller keeps its existing notebook-based guess) when
    claude_account: isn't set, names something not in the registry, or
    the registered path doesn't actually exist on this host -- never
    raises, never guesses past what's actually configured.
    """
    account = _resolve_claude_account(selector)
    if not account:
        return ''
    project = account.split(':')[0].strip()
    if not project:
        return ''
    local = _manifest_repo_paths().get(project)
    if not local:
        return ''
    path = Path(local).expanduser()
    return str(path) if path.is_dir() else ''


_AGENT_RULES_PATH = NB_DIR / '.rules' / 'agent.md'


def _load_agent_orientation():
    """Curated excerpt of .rules/agent.md for injection into ask/goal
    system prompts: the orientation table (where things live) and the
    todo tag vocabulary (#agent/#discuss/#bug/... and what a
    resource-suggestion tag means) -- not the checkout/dispatch-sequence
    mechanics (about a not-yet-built automated dispatcher, irrelevant to
    a live human-clicked ask) or the hard invariants (CLAUDE.md-adjacent,
    already covered once _resolve_repo_cwd lands a session in the real
    repo). Read from the live file rather than duplicated by hand, so
    this can't silently drift out of sync with the real conventions;
    falls back to '' (guidance just omitted, not an error) if the
    expected headings ever change shape.
    """
    try:
        text = _AGENT_RULES_PATH.read_text(errors='replace')
    except OSError:
        return ''
    parts = []
    m = re.search(r'## Orientation: key locations\n(.*?)\n---', text, re.DOTALL)
    if m:
        parts.append('Orientation (.rules/agent.md):\n' + m.group(1).strip())
    m = re.search(r'## Todo queue protocol\n(.*?)\n\*\*Checkout mechanism', text, re.DOTALL)
    if m:
        parts.append('Todo tag vocabulary (.rules/agent.md):\n' + m.group(1).strip())
    return '\n\n'.join(parts)


def _agent_protocol_enabled(selector, notebook):
    """Whether the #agent/#discuss/etc. todo-tag protocol applies here --
    an opt-in `claude_agent: true` in a notebook's own `.{notebook}.md` (or
    a folder config nested under it), same cascade/override semantics
    _folder_config already gives every other per-notebook setting
    (nearest-wins, walk-up from the note to the notebook root). Declaring
    it in the root `.nb.md` instead makes it the system-wide default,
    inherited by every notebook that doesn't say otherwise -- not
    hardcoded to the `claude` notebook specifically, since a todo tagged
    `#agent #discuss` in any notebook (`work:`, `preciousfinds.ca:`, ...)
    means exactly the same thing wherever it lives.
    """
    if not notebook:
        return False
    fpath = _resolve_to_nb_path(selector)
    cfg = _folder_config(notebook, fpath) if fpath else _notebook_config(notebook)
    return bool(cfg.get('claude_agent'))


# Tool names whose `input` carries a file_path worth scope-checking --
# mutating file tools only, both using the same input.file_path shape
# (NotebookEdit's own field name was never confirmed live, left out rather
# than guessed). Read is deliberately excluded: reading outside the
# declared scope is normal and often necessary context-gathering, the risk
# this guards against is unexpected *writes*, exactly what the 2026-07-11
# goal-mode regression scare was about.
_SCOPE_CHECKED_TOOLS = {'Write', 'Edit'}


def _resolve_claude_goal_scope(selector):
    """Resolve claude_goal_scope: from the note's own FM -- comma-separated
    fnmatch patterns (matched against a tool call's file path, relative to
    the subprocess cwd) a goal-mode run is expected to stay within. Not
    cascaded through notebook config -- same posture as claude_permissions:,
    this is a per-task boundary, not a notebook-wide default. Empty/unset
    means no guardrail is enforced, opt-in like every other claude_* control.
    """
    if not selector:
        return []
    fpath = _resolve_to_nb_path(selector)
    if not fpath or not fpath.is_file():
        return []
    try:
        raw = fpath.read_text(errors='replace')
    except OSError:
        return []
    meta, _ = parse_frontmatter(raw)
    raw_scope = str(meta.get('claude_goal_scope', '') or '')
    return [s.strip() for s in raw_scope.split(',') if s.strip()]


def _path_in_scope(file_path, cwd, patterns):
    """True if file_path (absolute or relative, as the tool reported it)
    matches at least one fnmatch pattern. Deliberately does not depend on
    cwd resolution succeeding -- confirmed real 2026-07-12 (claude:69): a
    correctly-scoped, correctly-executing goal got killed because
    claude_account: wasn't set (so cwd fell back to the notes-notebook
    guess, unrelated to the real repo) and fnmatch('/home/djp/dev/nb-web/
    dialog.js', 'dialog.js') is False -- a bare pattern only ever matched
    a cwd-relative path, never a full absolute one, even though the
    pattern itself was perfectly reasonable. Retroactively fixing cwd via
    claude_account: was considered and rejected -- changing it on a note
    that already has an in-flight session breaks that session's --resume
    from the new cwd (the exact failure confirmed earlier the same day on
    claude:87), so scope-matching has to work independent of whether cwd
    ever resolves correctly, not lean on it.

    For each pattern, checked against: the raw path as given, the bare
    basename, the cwd-relative path when resolvable, and -- for a
    multi-component pattern like plugins/nbweb-codeblocks.js -- a
    same-depth suffix of the real path's own components, so a path
    pattern matches regardless of what cwd the tool call actually ran
    under.
    """
    fpath = Path(file_path)
    parts = fpath.parts
    try:
        rel = str(fpath.resolve().relative_to(Path(cwd).resolve()))
    except (ValueError, OSError):
        rel = None
    for pattern in patterns:
        candidates = {file_path, fpath.name}
        if rel:
            candidates.add(rel)
        depth = len(Path(pattern).parts)
        if 1 < depth <= len(parts):
            candidates.add(str(Path(*parts[-depth:])))
        if any(fnmatch.fnmatch(cand, pattern) for cand in candidates):
            return True
    return False


def _summarize_tool_input(name, tool_input):
    """Short, human-readable one-liner for a live tool_use event -- not a
    full audit record (the raw stream still has tool_result/structuredPatch
    if that's ever needed), just enough for a human watching the ask panel
    to see *what's* happening without reading raw JSON off the wire.
    """
    tool_input = tool_input or {}
    if name == 'Bash':
        cmd = tool_input.get('command', '')
        return cmd if len(cmd) <= 80 else cmd[:77] + '...'
    return tool_input.get('file_path', '') or tool_input.get('notebook_path', '')


def _can_write(user, selector, notebook=None):
    """Return True if user may write (edit/delete/rename/move) a note.

    Rules:
      - minimum level: 'user' (guests never write)
      - must pass _can_access read check for the resolved note
      - username-access notes (access: djp) only writable by that user (or tech)

    Pass selector=None and notebook=<name> to check create-in-notebook access.
    """
    if not _level_gte(user.get('level', ''), 'user'):
        return False
    if selector is None:
        # Create check: notebook must be accessible to this user
        nb_meta = _notebook_config(notebook) if notebook else {}
        return _can_access(user, {}, nb_meta)
    path = _resolve_to_nb_path(selector)
    if path is None:
        return False
    nb_name = selector.split(':')[0] if ':' in selector else (notebook or '')
    try:
        note_meta, _ = parse_frontmatter(path.read_text(errors='replace'))
    except OSError:
        note_meta = {}
    nb_meta = _notebook_config(nb_name) if nb_name else {}
    return _can_access(user, note_meta, nb_meta)


def _resolve_abs_selector(p):
    """Classify an absolute-path note selector (the `elif selector.startswith('/')`
    branches in api_note/api_edit_note/api_config_tree/api_note_constraints_full)
    so it can get the same access control a notebook:file selector for the same
    file would get, instead of a free pass just because it's a raw filesystem
    path -- test fixtures use this form deliberately (see test_api_note.py) to
    reach real notebook notes without shelling out to `nb`, so it must apply
    the *same* rules as the normal path, not skip them.

    Returns (kind, note_meta, nb_meta):
      'dotfolder' -- path lives under one of DOTFOLDERS; admin-only, same as
                     the existing notebook:file dotfolder selector form.
      'notebook'  -- path lives under a real notebook; normal _can_access rules.
      'outside'   -- outside NB_DIR entirely, or a loose top-level file; no
                     selector form reaches this legitimately, tech-only.
    """
    try:
        rel = p.relative_to(NB_DIR)
    except ValueError:
        return 'outside', {}, {}
    if not rel.parts:
        return 'outside', {}, {}
    top = rel.parts[0]
    if top in DOTFOLDERS:
        return 'dotfolder', {}, {}
    if _safe_notebook(top):
        try:
            note_meta, _ = parse_frontmatter(p.read_text(errors='replace'))
        except OSError:
            note_meta = {}
        return 'notebook', note_meta, _notebook_config(top)
    return 'outside', {}, {}


def _can_access_abs_path(user, p, write=False):
    """Access check for an absolute-path selector -- see _resolve_abs_selector."""
    if write and not _level_gte(user.get('level', ''), 'user'):
        return False
    kind, note_meta, nb_meta = _resolve_abs_selector(p)
    if kind == 'dotfolder':
        return _level_gte(user.get('level', ''), 'admin')
    if kind == 'notebook':
        return _can_access(user, note_meta, nb_meta)
    return _level_gte(user.get('level', ''), 'tech')


# ---------------------------------------------------------------------------
# MCP scoped tokens — minted per /api/claude/ask call, not the raw session
# cookie. The nbweb-claude MCP server subprocess authenticates its own HTTP
# calls back to this same process with one of these instead of a cookie, so
# a headless `claude -p` invocation sees exactly what the asking user could
# see -- _can_access, guest-invisible filtering, everything -- with zero new
# enforcement code. See claude:nbweb-claude v2 design doc, "Market 1".
# ---------------------------------------------------------------------------
_MCP_TOKENS = {}
_MCP_TOKEN_TTL = 420  # seconds -- must stay comfortably longer than the
# /api/claude/ask subprocess timeout (300s, see api_claude_ask), not just
# "one claude -p turn" in the abstract. Real bug, confirmed 2026-07-11: when
# the subprocess timeout was raised from 120s to 300s, this was left at 300s
# too -- identical durations started at nearly the same moment means a
# request running close to the wall has its own auth token expire in its
# final seconds, while still in flight, failing any late tool call with
# "invalid or expired MCP token" (a 502 or a floundering retry that then
# also hits the 504). Confirmed via real server log evidence (two 502s a
# minute apart on a genuine test todo) before concluding this was the cause.


def _mint_mcp_token(user):
    token = secrets.token_urlsafe(32)
    _MCP_TOKENS[token] = {'user': dict(user), 'expires': time.time() + _MCP_TOKEN_TTL, 'reload': False}
    return token


def _resolve_mcp_token(token):
    entry = _MCP_TOKENS.get(token)
    if not entry:
        return None
    if entry['expires'] < time.time():
        del _MCP_TOKENS[token]
        return None
    return entry['user']


def _notebook_in_scope(user, name):
    """True if `name` is visible to `user` given their notebooks: scope
    (empty/absent notebooks: means unrestricted). tech always sees
    everything, matching _notebook_scope_check's own bypass. Shared by the
    /api/notebooks and /api/nb/notebooks listing filters so a scoped
    user's notebook switcher only ever shows what they can actually open --
    without this, they'd see (and 403 on) notebooks outside their scope."""
    if user.get('level') == 'tech':
        return True
    restrict = user.get('notebooks') or []
    return not restrict or name in restrict


def _notebook_scope_check():
    """If the current user's account restricts them to specific notebooks
    (notebooks: non-empty), reject any request naming a notebook outside
    that list. tech level always bypasses -- the same recovery/owner
    escape hatch _can_access already grants for username-locked notes.

    Deliberately centralized here (2026-07-16) rather than patched into
    _can_access + its ~17 call sites: every notebook-scoped request across
    the whole codebase names the notebook via exactly one of two keys --
    `notebook` or `selector` (notebook:path form) -- as a query param, form
    field, or JSON body key (confirmed: 116 call sites, only those two key
    names, no URL-path-embedded notebook names exist). One chokepoint here
    covers all of them, present and future, instead of scattered patches
    that are easy to miss one of.

    Fails open for requests that don't name a specific notebook at all
    (global/meta endpoints like /api/notebooks itself, which already
    filters its returned list via _can_access separately) -- this is a
    hard boundary for the common request shapes, not a full capability
    system.
    """
    user = session.get('user') or {}
    if user.get('level') == 'tech':
        return None
    restrict = user.get('notebooks') or []
    if not restrict:
        return None
    json_body = request.get_json(silent=True) or {}
    for src in (request.values, json_body):
        nb = str(src.get('notebook') or '').strip()
        if nb and nb != '_all' and nb not in restrict:
            return jsonify(error='forbidden: notebook not in your account scope'), 403
        sel = str(src.get('selector') or '').strip()
        if sel and ':' in sel:
            sel_nb = sel.split(':', 1)[0].strip()
            if sel_nb and sel_nb != '_all' and sel_nb not in restrict:
                return jsonify(error='forbidden: notebook not in your account scope'), 403
    return None


@app.before_request
def _check_auth():
    if request.path in ('/login', '/logout', '/setup'):
        return
    mcp_token = request.headers.get('X-Nbweb-Mcp-Token')
    if mcp_token:
        mcp_user = _resolve_mcp_token(mcp_token)
        if mcp_user is None:
            return jsonify(error='invalid or expired MCP token'), 401
        session['user'] = mcp_user
        return _notebook_scope_check()
    api_token = request.headers.get('X-Nbweb-Api-Token')
    if api_token:
        if not secrets.compare_digest(api_token, API_TOKEN):
            return jsonify(error='invalid API token'), 401
        api_user = _load_user(API_TOKEN_USER)
        if api_user is None:
            return jsonify(error='API token user not found'), 401
        session['user'] = api_user
        return _notebook_scope_check()
    if not session.get('user'):
        if request.path.startswith('/api/') or request.path.startswith('/ws'):
            return jsonify(error='Authentication required'), 401
        return redirect('/login')
    return _notebook_scope_check()

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
  <form method="POST" action="/login" id="lf">
    <h2>nb-web</h2>
    {error}
    <label>Username or name</label>
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
    user = _load_user(username) or _load_user_by_name(username)
    if user and user.get('level') == 'guest':
        # Guest login disabled pending a more controlled environment (2026-07-29) —
        # fall through to the generic "invalid" response rather than a distinct error,
        # so the account's existence isn't disclosed.
        user = None
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
    data = dict(user)
    # Find matching contact by title: == user name (case-insensitive)
    contact_selector = None
    name_lower = (data.get('name') or '').strip().lower()
    if name_lower:
        contacts_dir = NB_DIR / 'contacts'
        if contacts_dir.is_dir():
            for md in contacts_dir.glob('*.md'):
                try:
                    meta, _ = parse_frontmatter(md.read_text(errors='replace'))
                    contact_name = str(meta.get('name') or meta.get('title', '')).strip().lower()
                    if contact_name == name_lower:
                        contact_selector = f'contacts:{md.name}'
                        break
                except Exception:
                    pass
    data['contact_selector'] = contact_selector
    return jsonify(data)


@app.route('/api/me', methods=['PUT'])
def api_me_update():
    user = session.get('user')
    if not user:
        return jsonify({'error': 'not authenticated'}), 401
    data = request.get_json() or {}
    username = user['username']
    path = USERS_DIR / f'{username}.md'
    if not path.exists():
        return jsonify({'error': 'user card not found'}), 404

    meta, body = parse_frontmatter(path.read_text(errors='replace'))

    new_name = data.get('name', '').strip()
    current_pw = data.get('current_password', '')
    new_pw = data.get('new_password', '')

    if new_pw:
        if not current_pw:
            return jsonify({'error': 'current password required'}), 400
        if not check_password_hash(meta.get('password_hash', ''), current_pw):
            return jsonify({'error': 'current password incorrect'}), 400
        meta['password_hash'] = generate_password_hash(new_pw)

    if new_name:
        meta['name'] = new_name

    fm_lines = '\n'.join(f'{k}: {_yaml.dump(v, default_flow_style=True).strip()}' for k, v in meta.items())
    path.write_text(f'---\n{fm_lines}\n---\n{body}', encoding='utf-8')

    # Refresh session
    fresh = _load_user(username)
    if fresh:
        s = dict(session['user'])
        s['name']  = fresh['name']
        s['level'] = fresh['level']
        session['user'] = s

    return jsonify({'success': True, 'name': meta.get('name', username)})


@app.route('/api/me/exclusive')
def api_me_exclusive():
    """Notes where access: <username> — visible only to this user."""
    user = session.get('user')
    if not user:
        return jsonify({'error': 'not authenticated'}), 401
    username = user['username']
    notebooks = user.get('notebooks') or []
    results = []
    for nb in notebooks:
        nb_dir = NB_DIR / nb
        if not nb_dir.is_dir():
            continue
        for md in nb_dir.rglob('*.md'):
            try:
                meta, _ = parse_frontmatter(md.read_text(errors='replace'))
                if str(meta.get('access', '')) == username:
                    rel = str(md.relative_to(nb_dir))
                    results.append({
                        'selector': f'{nb}:{rel}',
                        'title': meta.get('title') or md.stem,
                        'notebook': nb,
                    })
            except Exception:
                pass
    return jsonify({'notes': results})


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
    p = NB_DIR / nb / filename
    if not p.exists() and not filename.endswith('.md'):
        p = NB_DIR / nb / (filename + '.md')
    return p

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
            'indicator': _indicator(itype, None, fpath),
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
    if ext == '.timedot':                                return 'timedot'
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
    'journal':     '📒',
    'timedot':     '⏱️',
    'strip':       '🎞️',
    'script':      '🎬',
    'shot':        '🎬',
    'scene':       '📜',
    'storyline':   '🧵',   # main story lane (sits above plotlines)
    'plotline':    '🧵',
    'story':       '🃏',
    'actor':       '🧑',
    'location':    '📍',
    'day':         '📅',
    'resource':    '🎁',
    'tools':       '🔧',
    'materials':   '📦',
    'transport':   '🚗',
    'quote':       '📋',
    'budget':      '💰',
    'project':     '🏗️',
    'reports':     '📊',
    'invoice':     '🧾',
    'dashboard':   '🗂️',
    'note':        '',
    'dotfile':     '⚙',
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
#   plotline  — named lane in the storylines board   🧵  (NbWeb-cine plugin)
#   storyline — main story lane; floats above plotlines, cards promoted via story_seq:
#   story     — card on the storylines board         🃏  (NbWeb-cine plugin)
#   actor     — cast member / talent card            🧑  (NbWeb-cine plugin)
#   location  — shooting location card               📍  (NbWeb-cine plugin)
#   day       — shoot day record (date, hours)       📅  (NbWeb-cine plugin)
#   resource  — BTL line-item resource (rate, unit)  🎁  (NbWeb-cine plugin)
_FM_TYPES = frozenset({'strip', 'script', 'shot', 'scene', 'storyline', 'plotline', 'story', 'milestone', 'actor', 'location', 'day', 'resource', 'dotfile', 'journal',
                       'tools', 'materials', 'transport', 'quote', 'budget', 'project', 'reports', 'invoice', 'dashboard', 'item'})

# FM block keys: codeblock renderer langs that can appear in frontmatter and render as barblocks.
# Used to propagate inherited values from notebook/folder config via effective_fm.
_FM_BLOCK_KEYS = frozenset({'nav', 'toc', 'toc_min', 'fm', 'tw', 'hl', 'git', 'gallery', 'cfg', 't', 'nb', 'tabs', 'journal', 'timedot', 'timelog_file', 'timedot_file', 'csv', 'theme', 'claude_code'})

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

def _indicator(itype, todo_status=None, fpath=None):
    """List-item icon. A symlinked note (e.g. a plugin doc mirrored in via
    /api/link-file) always shows 🔗 regardless of type -- "this points
    somewhere else" is more useful at a glance than the type icon, since the
    content itself isn't actually stored here.
    """
    if fpath is not None:
        try:
            if Path(fpath).is_symlink():
                return '🔗'
        except OSError:
            pass
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


_GALLERY_IMAGE_EXTS = frozenset({'.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp'})

@app.route('/api/gallery')
def api_gallery():
    """Return sorted list of images from the nearest images/ folder.

    path param:
      absent  — walk up from note dir to find first images/ folder
      '.'     — look only in note_dir/images/; return [] if absent (vanish)
      selector — use that explicit path directly
    """
    selector = request.args.get('selector', '').strip()
    path_arg  = request.args.get('path', '').strip()

    def list_images(img_dir: Path) -> list[dict]:
        out = []
        for f in sorted(img_dir.iterdir()):
            if not f.is_file() or f.name.startswith('.'):
                continue
            if f.suffix.lower() not in _GALLERY_IMAGE_EXTS:
                continue
            try:
                rel   = f.relative_to(NB_DIR)
                parts = rel.parts
                sel   = f'{parts[0]}:{"/".join(parts[1:])}' if len(parts) >= 2 else str(f)
            except ValueError:
                continue
            out.append({'name': f.stem, 'filename': f.name,
                        'url': f'/api/file?selector={sel}'})
        return out

    note_dir: Path | None = None
    if selector:
        fpath = _resolve_to_nb_path(selector)
        if fpath:
            note_dir = fpath.parent if fpath.is_file() else fpath

    if path_arg == '.':
        if note_dir is None:
            return jsonify({'images': []})
        candidate = note_dir / 'images'
        return jsonify({'images': list_images(candidate) if candidate.is_dir() else []})

    if path_arg:
        if ':' in path_arg:
            nb_name, rel = path_arg.split(':', 1)
            p = (NB_DIR / nb_name / rel.strip('/')).resolve()
        else:
            p = Path(path_arg).expanduser().resolve()
        try:
            p.relative_to(NB_DIR)
        except ValueError:
            return jsonify({'error': 'path outside NB_DIR'}), 400
        return jsonify({'images': list_images(p) if p.is_dir() else []})

    # Walk up from note_dir; stop at NB_DIR boundary
    if note_dir is None:
        return jsonify({'images': []})
    for d in [note_dir, *note_dir.parents]:
        try:
            d.relative_to(NB_DIR)
        except ValueError:
            break
        candidate = d / 'images'
        if candidate.is_dir():
            return jsonify({'images': list_images(candidate)})
    return jsonify({'images': []})


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


@app.route('/api/xref/headings')
def api_xref_headings():
    """Heading-to-heading cross-reference: match query stems against headings in a specific file.
    Returns same shape as /api/xref: {stem: [{selector, title}]} where title is the heading text."""
    selector  = request.args.get('selector', '').strip()
    stems_raw = request.args.get('stems', '').strip()
    if not selector or not stems_raw:
        return jsonify({'error': 'selector and stems required'}), 400
    fpath = _resolve_to_nb_path(selector)
    if not fpath or not fpath.is_file():
        return jsonify({'error': f'selector {selector!r} not found'}), 404
    raw = fpath.read_text(errors='replace')
    _, body = parse_frontmatter(raw)
    query_stems = [s for s in stems_raw.split(',') if s]
    result: dict = {}
    for line in body.splitlines():
        m = re.match(r'^(#{1,6})\s+(.*)', line)
        if not m:
            continue
        heading_text = m.group(2).strip()
        heading_stems: set = set()
        for word in re.findall(r'[a-zA-Z][a-zA-Z0-9-]*', heading_text):
            stem = _stem_xref(word)
            if stem and len(stem) >= 3 and stem not in _XREF_STOP:
                heading_stems.add(stem)
        entry = {'selector': selector, 'title': heading_text}
        for qs in query_stems:
            for hs in heading_stems:
                plen = min(len(qs), len(hs))
                if hs == qs or (plen >= 5 and (hs.startswith(qs) or qs.startswith(hs))):
                    result.setdefault(qs, [])
                    if not any(r['title'] == heading_text for r in result[qs]):
                        result[qs].append(entry)
                    break
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
            ['task', 'rc.hooks=off', f'uuid.startswith:{uuid}', 'information'],
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
            ['task', 'rc.hooks=off', 'rc.confirmation=no', f'uuid:{uuid}', action],
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
    cmd = ['task', 'rc.hooks=off', 'rc.confirmation=no', 'add', desc]
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
    'balancesheetequity','bse',
    'cashflow','cf',
    'aregister','areg',
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
    selector = request.args.get('selector', '').strip()

    if not provider or not query:
        return jsonify({'error': 'provider and query required'}), 400

    try:
        if provider == 'hledger':
            # Note-level journal: FM key overrides notebook config when selector provided
            journal = None
            if selector:
                try:
                    _np = _resolve_to_nb_path(selector)
                    if _np and _np.exists():
                        _m, _ = parse_frontmatter(_np.read_text(errors='replace'))
                        _jkey = _m.get('journal', '').strip()
                        if _jkey:
                            journal = Path(os.path.expanduser(_jkey))
                except Exception:
                    pass
            if not journal or not journal.exists():
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

        elif provider == 'fm':
            args = query.strip().split(None, 1)
            if not args or args[0] != 'count':
                return jsonify({'error': (
                    "fm inline query only supports 'count' — e.g. "
                    '"count Takeout:storylines/film-school/ type:story"'
                )}), 400
            nb_list, folder_list, iq_filters = _parse_fm_scope(args[1] if len(args) > 1 else '')
            iq_user = session.get('user', {})
            results, err = _run_front_query(iq_user, nb_list, folder_list, iq_filters, limit=500)
            if err:
                message, status = err
                return jsonify({'error': message}), status
            return jsonify({'result': str(len(results))})

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


def _run_regen_script(notebook, script, args=None):
    """Shared core: run a .tools/*.py script in a notebook to regenerate
    whatever derived artifact it produces. Returns (message, error) -- exactly
    one is None. Caller owns auth/permission checks and any of its own
    cache invalidation; this function only validates the script path and
    runs it.

    `notebook` must already be `_safe_notebook`-validated by the caller --
    this function trusts it (both current callers validate before calling).
    `args`, if given, are passed through as plain positional CLI args (e.g.
    gen-org.py's own required `<name>`) -- subprocess.run's list form, never
    a shell string, so nothing here needs escaping."""
    # Script must live inside .tools/ and be a .py file — no path traversal.
    script_path = Path(script)
    if script_path.parent.name != '.tools' or script_path.suffix != '.py':
        return None, 'script must be a .tools/*.py file'

    nb_path     = NB_DIR / notebook
    full_script = nb_path / script_path
    if not full_script.exists():
        return None, f'{script} not found in {notebook}'

    try:
        r = subprocess.run(
            ['python3', str(full_script), *(args or [])],
            capture_output=True, text=True, timeout=30, cwd=str(nb_path),
        )
        if r.returncode != 0:
            return None, r.stderr.strip() or 'script error'
        return (r.stdout.strip().splitlines()[-1] if r.stdout.strip() else 'done'), None
    except subprocess.TimeoutExpired:
        return None, 'script timed out'


_ORG_SOURCE_RE = re.compile(r'^\.([\w-]+)-org\.md$')


def _maybe_auto_regen_org_source(note_path, nb_root):
    """Saving a `.{name}-org.md` file (the org-source dotfile `cine org` and
    any sibling plugin reads, per its own `org <name>` codeblock arg)
    re-runs `.tools/gen-org.py <name>` immediately, so the cache never sits
    stale between an edit and the next render. Keyed off the filename
    pattern itself, not an opt-in FM flag -- the naming convention is
    already the real signal here, nothing to remember to turn on. Returns
    the regenerated cache's relative path if one was produced (so the
    caller can fold it into the same git commit as the source edit), or
    None if this wasn't an org-source save or the regen script is missing/
    failed. Best-effort either way: a failed/missing regen just means the
    next render falls back to live per-node resolution, same as today."""
    if note_path.parent != nb_root:
        return None
    m = _ORG_SOURCE_RE.match(note_path.name)
    if not m:
        return None
    name = m.group(1)
    if not (nb_root / '.tools' / 'gen-org.py').is_file():
        return None
    _message, _error = _run_regen_script(nb_root.name, '.tools/gen-org.py', args=[name])
    cache_rel = f'.{name}-org-cache.json'
    return cache_rel if (nb_root / cache_rel).exists() else None


def _regen_error_status(error):
    """Map _run_regen_script's error strings to the same status codes this
    endpoint pair has always returned (400 bad script path, 404 script
    missing, 500 the script itself failed/timed out)."""
    if 'must be' in error:
        return 400
    if 'not found' in error:
        return 404
    return 500


@app.route('/api/regen', methods=['POST'])
def api_regen():
    """Generic sibling of /api/hledger/regen -- any plugin can point a manual
    regen button or an auto-on-save hook at this, not just hledger. Gate is
    real write access to the target notebook (its own configured `access:`,
    floor 'user' regardless -- running a script is more sensitive than plain
    content edits, same floor precedent as other routine content-generating
    endpoints), not a specific plugin's own codeblock_access gate.

    First consumer: nbweb-cine's `.{name}-org.md` cache (manual regen button
    + auto-regen on save of a matching filename)."""
    data     = request.get_json() or {}
    notebook = _safe_notebook(data.get('notebook', '').strip())
    script   = data.get('script', '').strip()
    args_raw = data.get('args') or []
    if not notebook or not script:
        return jsonify({'error': 'notebook and script required'}), 400
    if not isinstance(args_raw, list) or not all(isinstance(a, str) for a in args_raw):
        return jsonify({'error': 'args must be a list of strings'}), 400

    user = session.get('user') or {}
    if not _level_gte(user.get('level', ''), 'user') or not _can_access(user, {}, _notebook_config(notebook)):
        return jsonify({'error': 'not permitted'}), 403

    message, error = _run_regen_script(notebook, script, args=args_raw)
    if error:
        status = _regen_error_status(error)
        return jsonify({'error': error}), status
    return jsonify({'message': message})


@app.route('/api/hledger/regen', methods=['POST'])
def api_hledger_regen():
    """hledger's own regen button -- thin wrapper over the shared
    _run_regen_script, plus hledger's own report-cache invalidation (cached
    separately from the regen script's own file output, so a generic caller
    wouldn't know to clear it)."""
    if not _cb_write_allowed('hledger'):
        return jsonify({'error': 'hledger write not permitted'}), 403
    data     = request.get_json() or {}
    notebook = _safe_notebook(data.get('notebook', '').strip())
    script   = data.get('script', '').strip()
    if not notebook or not script:
        return jsonify({'error': 'notebook and script required'}), 400

    _hledger_cache.clear()   # clear before run so stale entries can't be served
    message, error = _run_regen_script(notebook, script)
    _hledger_cache.clear()   # clear again after run to drop any entries added during script
    if error:
        status = _regen_error_status(error)
        return jsonify({'error': error}), status
    return jsonify({'message': message})


# ── .lib barblock extras ──────────────────────────────────────────────────────
# Naming convention: help-block-{lang}-{access}.md  and  open-block-{lang}-{access}.sh
# {access} is the minimum access level required to see the button.
# Files are gated identically to other .lib files — non-qualifying users get no entry.

@app.route('/api/lib/block-extras')
def api_lib_block_extras():
    user       = session.get('user', {})
    user_level = user.get('level', 'guest')
    lib_dir    = NB_DIR / '.lib'
    result     = {'help': {}, 'open': {}}

    if not lib_dir.is_dir():
        return jsonify(result)

    # Parse help-block-{lang}-{access}.md
    for p in sorted(lib_dir.glob('help-block-*.md')):
        parts = p.stem.split('-')   # ['help', 'block', lang, access]
        if len(parts) < 3:
            continue
        lang   = parts[2]
        access = parts[3] if len(parts) > 3 else 'guest'
        if access not in LEVELS:
            continue
        if _level_gte(user_level, access):
            result['help'][lang] = f'.lib:{p.name}'

    # Parse open-block-{lang}-{access}.sh
    for p in sorted(lib_dir.glob('open-block-*.sh')):
        parts = p.stem.split('-')
        if len(parts) < 3:
            continue
        lang   = parts[2]
        access = parts[3] if len(parts) > 3 else 'guest'
        if access not in LEVELS:
            continue
        if _level_gte(user_level, access):
            result['open'][lang] = f'.lib:{p.name}'

    return jsonify(result)


@app.route('/api/lib/csv-template')
def api_lib_csv_template():
    name = request.args.get('name', '')
    if not re.match(r'^[\w-]+$', name):
        return jsonify({'error': 'invalid name'}), 400
    path = NB_DIR / '.lib' / f'{name}.csv'
    if not path.is_file():
        return jsonify({'error': f'template not found: {name}.csv'}), 404
    return jsonify({'content': path.read_text(errors='replace'), 'path': str(path)})

@app.route('/api/csv/source')
def api_csv_source():
    """Walk up the folder tree from notebook:folder looking for a note with type: <token>.
    Returns {found, selector} or {found: false}.
    Used by specialty note renderers to locate root-level catalog files (materials, tools, transport).
    """
    notebook = request.args.get('notebook', '').strip()
    folder   = request.args.get('folder', '').strip()
    token    = request.args.get('token', '').strip()
    if not _safe_notebook(notebook) or not re.match(r'^[\w-]+$', token):
        return jsonify({'error': 'invalid params'}), 400
    nb_path = nb_dir_for(notebook)
    parts = [p for p in folder.replace('\\', '/').split('/') if p and not p.startswith('.')]
    while True:
        current = nb_path.joinpath(*parts) if parts else nb_path
        if current.is_dir():
            for md in sorted(current.glob('*.md')):
                if md.name.startswith('.'):
                    continue
                try:
                    meta, _ = parse_frontmatter(md.read_text(errors='replace'))
                    if meta.get('type') == token:
                        rel = md.relative_to(nb_path).as_posix()
                        return jsonify({'found': True, 'selector': f'{notebook}:{rel}'})
                except Exception:
                    continue
        if not parts:
            break
        parts.pop()
    return jsonify({'found': False})

@app.route('/api/lib/block-open', methods=['POST'])
def api_lib_block_open():
    user       = session.get('user', {})
    user_level = user.get('level', 'guest')
    data       = request.get_json(silent=True) or {}
    lang       = data.get('lang', '').strip()
    notebook   = data.get('notebook', '').strip()
    journal    = data.get('journal', '').strip()
    if not lang or not re.match(r'^[a-z0-9_]+$', lang):
        return jsonify({'error': 'invalid lang'}), 400

    lib_dir = NB_DIR / '.lib'
    script  = None
    access  = 'guest'
    for p in sorted(lib_dir.glob(f'open-block-{lang}-*.sh')):
        parts = p.stem.split('-')
        lvl = parts[3] if len(parts) > 3 else 'guest'
        if lvl in LEVELS and _level_gte(user_level, lvl):
            script = p
            access = lvl
            break

    if not script or not script.exists():
        return jsonify({'error': 'not found'}), 404

    try:
        r = subprocess.run(
            [str(script)],
            capture_output=True, text=True, timeout=10,
            env={**os.environ, 'NB_DIR': str(NB_DIR),
                 'NB_NOTEBOOK': notebook, 'NB_JOURNAL': journal},
        )
        stdout = r.stdout.strip()
        return jsonify({'output': stdout,
                        'error': r.stderr.strip() if r.returncode else ''})
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'script timed out'}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500


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
    """Return hledger config for notebook.

    Checks in order:
      1. .nb-hledger.json  — legacy JSON file, takes precedence
      2. hledger: section in .<notebook>.md  — notebook manifest
    Relative journal paths in the manifest are resolved against notebook root.
    """
    nb_path = _hledger_notebook_path(notebook)
    if not nb_path:
        return None
    cfg_file = nb_path / '.nb-hledger.json'
    if cfg_file.exists():
        try:
            return json.loads(cfg_file.read_text())
        except Exception:
            pass
    # Fallback: hledger: section from notebook manifest
    nb_cfg = _notebook_config(notebook)
    hledger = nb_cfg.get('hledger')
    if hledger and isinstance(hledger, dict):
        hledger = dict(hledger)
        journal = hledger.get('journal', '')
        if journal and not os.path.isabs(journal) and not journal.startswith('~'):
            hledger['journal'] = str(nb_path / journal)
        return hledger
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
    """List a directory that is inside NB_DIR (including hidden dirs like .checks)."""
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

    # Resolve each `include` directive to an absolute path and compare against
    # out_path directly — a substring check on the literal text "accounts.journal"
    # false-positives whenever the main journal mentions a *different*
    # accounts.journal (e.g. a hand-written one at another location predating
    # a wizard regen), silently leaving the newly-generated file uncredited.
    include_needed = True
    if journal_path.exists():
        for line in journal_path.read_text(errors='replace').splitlines():
            m = re.match(r'\s*include\s+(\S+)', line)
            if not m:
                continue
            inc = Path(m.group(1).split(';')[0].strip()).expanduser()
            if not inc.is_absolute():
                inc = journal_path.parent / inc
            try:
                if inc.resolve() == out_path.resolve():
                    include_needed = False
                    break
            except OSError:
                continue

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

def _t_tc_file(override: str | None = None) -> Path:
    """Return Path to the active timeclock file (override > rc > default)."""
    if override:
        return Path(os.path.expanduser(override.strip()))
    rc = Path.home() / '.task/config/timelog.rc'
    default = Path.home() / '.task/time/tw.timeclock'
    if not rc.exists():
        return default
    for line in rc.read_text().splitlines():
        if line.startswith('timelog.file'):
            val = line.split('=', 1)[1].strip()
            return Path(os.path.expanduser(val))
    return default


def _t_td_file(override: str | None = None) -> Path:
    """Return Path to the active timedot file (override > rc > default)."""
    if override:
        return Path(os.path.expanduser(override.strip()))
    rc = Path.home() / '.task/config/timelog.rc'
    default = _t_tc_file().parent / 'tw.timedot'
    if not rc.exists():
        return default
    for line in rc.read_text().splitlines():
        if line.startswith('timelog.timedot_file'):
            val = line.split('=', 1)[1].strip()
            return Path(os.path.expanduser(val))
    return default


def _t_timedot_last(td_file: Path) -> dict:
    """Return last entry info from a timedot file."""
    if not td_file.exists():
        return {'state': 'none'}
    last_date = last_acct = last_time = None
    for line in td_file.read_text().splitlines():
        t = line.strip()
        if not t or t.startswith((';', '#', '*', '//')):
            continue
        dm = re.match(r'^(\d{4})[/-](\d{2})[/-](\d{2})', t)
        if dm:
            last_date = f'{dm.group(1)}-{dm.group(2)}-{dm.group(3)}'
            continue
        em = re.match(r'^(.+?)\s{2,}([.\s\d]+[hm]?)\s*(?:;.*)?$', t)
        if em:
            last_acct = em.group(1).rstrip()
            last_time = em.group(2).strip()
    if last_acct:
        return {'state': 'has_entries', 'account': last_acct,
                'time': last_time, 'date': last_date}
    return {'state': 'empty'}


def _t_timedot_parse_report(td_file: Path, period: str) -> dict:
    """Parse a timedot file and return hours-by-account for the period."""
    from datetime import date as _date, timedelta as _td
    if not td_file.exists():
        return {'rows': [], 'total_hours': 0}
    today = _date.today()
    if period in ('today', ''):
        cutoff = today
    elif period in ('thisweek', 'week'):
        cutoff = today - _td(days=today.weekday())
    elif period in ('thismonth', 'month'):
        cutoff = today.replace(day=1)
    else:
        cutoff = today

    by_account: dict = {}
    cur_date = None
    for line in td_file.read_text().splitlines():
        t = line.strip()
        if not t or t.startswith((';', '#', '*', '//')):
            continue
        dm = re.match(r'^(\d{4})[/-](\d{2})[/-](\d{2})', t)
        if dm:
            from datetime import date as _date2
            try:
                cur_date = _date2(int(dm.group(1)), int(dm.group(2)), int(dm.group(3)))
            except ValueError:
                cur_date = None
            continue
        if cur_date is None or cur_date < cutoff:
            continue
        em = re.match(r'^(.+?)\s{2,}([.\s\d]+[hm]?)\s*(?:;.*)?$', t)
        if not em:
            continue
        acct = em.group(1).rstrip()
        raw  = em.group(2).strip()
        # Parse time: dots=0.25h each, Nh, Nm, decimal
        if raw.endswith('h'):
            hrs = float(raw[:-1]) if raw[:-1] else 0
        elif raw.endswith('m'):
            hrs = float(raw[:-1]) / 60 if raw[:-1] else 0
        elif re.match(r'^\d+(\.\d+)?$', raw):
            hrs = float(raw)
        else:
            hrs = raw.count('.') * 0.25
        if hrs > 0:
            by_account[acct] = by_account.get(acct, 0) + hrs

    rows = sorted([{'account': k, 'hours': round(v, 4)} for k, v in by_account.items()],
                  key=lambda r: r['account'])
    return {'rows': rows, 'total_hours': round(sum(r['hours'] for r in rows), 4)}


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

    accounts_dir = nb_root / 'accounting' / 'accounts'
    files = []
    if accounts_dir.is_dir():
        files = [f.name for f in accounts_dir.glob('*.md') if not f.name.startswith('.')]
        try:
            for f in accounts_dir.glob('*.md'):
                if not f.name.startswith('.'):
                    f.unlink()
            index_path = accounts_dir / '.index'
            if index_path.exists():
                index_path.write_text('')
        except OSError as e:
            return jsonify({'error': str(e)}), 500

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


@app.route('/api/hledger/cbql-query', methods=['POST'])
def api_hledger_cbql_query():
    """Run a hledger query against timedot content extracted from a CBQL source note.

    Body: { timedot, query, rate, commodity }
      timedot   — raw timedot (pre-sliced to timeframe; accounts already expanded)
      query     — hledger command + args (e.g. 'bal' or 'reg --daily')
      rate      — hourly rate as float; 0 = no price conversion
      commodity — currency code (e.g. 'CAD')
    """
    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), 'guest'):
        return jsonify(error='forbidden'), 403

    data         = request.get_json(force=True) or {}
    journal_file = (data.get('journalFile') or '').strip()  # path to real journal (preferred)
    journal      = (data.get('journal') or '').strip()       # inline journal content
    timedot      = (data.get('timedot') or '').strip()       # inline timedot content
    query        = (data.get('query') or 'bal').strip()

    args = shlex.split(query)
    if not args or args[0] not in (_HLEDGER_READ_CMDS | _HLEDGER_TEXT_CMDS):
        return jsonify({'error': f'command not allowed: {args[0] if args else ""}'}), 400

    if journal_file:
        # Query a real journal file directly — no temp files, journals are complete records
        jpath = Path(os.path.expanduser(journal_file)).resolve()
        try:
            rel = jpath.relative_to(NB_DIR.resolve())
        except ValueError:
            return jsonify({'error': 'invalid journal path'}), 400
        if not jpath.exists():
            return jsonify({'error': f'journal not found: {journal_file}'}), 404
        notebook = rel.parts[0] if rel.parts else ''
        nb_meta = _notebook_config(notebook) if notebook else {}
        if not _can_access(user, {}, nb_meta):
            return jsonify({'error': 'Access denied'}), 403
        try:
            result = subprocess.run(
                ['hledger', '-f', str(jpath)] + args,
                capture_output=True, text=True, timeout=10
            )
            if result.returncode != 0:
                return jsonify({'error': result.stderr or 'hledger error'}), 500
            return jsonify({'result': result.stdout})
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    # Inline content path (timedot CBQL blocks, etc.)
    content = journal or timedot
    if not content:
        return jsonify({'result': ''}), 200

    suffix = '.journal' if journal else '.timedot'
    import tempfile as _tf, os as _os2
    tf_path = None
    try:
        with _tf.NamedTemporaryFile(mode='w', suffix=suffix, delete=False, prefix='nb-cbql-') as tf:
            tf.write(content + '\n')
            tf_path = tf.name
        result = subprocess.run(
            ['hledger', '-f', tf_path] + args,
            capture_output=True, text=True, timeout=10
        )
        if result.returncode != 0:
            return jsonify({'error': result.stderr or 'hledger error'}), 500
        return jsonify({'result': result.stdout})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        if tf_path:
            try: _os2.unlink(tf_path)
            except: pass


@app.route('/api/t/status')
def api_t_status():
    return jsonify(_t_parse_status(_t_tc_file(request.args.get('file'))))


@app.route('/api/t/report')
def api_t_report():
    period = request.args.get('period', 'today').strip()
    return jsonify(_t_parse_report(_t_tc_file(request.args.get('file')), period))


@app.route('/api/t/accounts')
def api_t_accounts():
    tc = _t_tc_file(request.args.get('file'))
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
    tc = _t_tc_file(data.get('file'))
    tc.parent.mkdir(parents=True, exist_ok=True)
    if not tc.exists():
        tc.touch()
    status = _t_parse_status(tc)
    if status['state'] == 'in':
        if status['account'] == account:
            return jsonify({'success': False, 'error': f'Already clocked in to {account}'}), 409
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
    data = request.get_json(silent=True) or {}
    tc = _t_tc_file(data.get('file'))
    status = _t_parse_status(tc)
    if status['state'] != 'in':
        return jsonify({'success': False, 'error': 'Not clocked in'}), 409
    now_str = datetime.now().strftime('%Y/%m/%d %H:%M:%S')
    with open(tc, 'a') as f:
        f.write(f'o {now_str}\n')
    return jsonify({'success': True})


@app.route('/api/t/timedot/status')
def api_t_timedot_status():
    return jsonify(_t_timedot_last(_t_td_file(request.args.get('file'))))


@app.route('/api/t/timedot/report')
def api_t_timedot_report():
    period = request.args.get('period', 'today').strip()
    return jsonify(_t_timedot_parse_report(_t_td_file(request.args.get('file')), period))


@app.route('/api/t/timedot/content')
def api_t_timedot_content():
    td = _t_td_file(request.args.get('file'))
    if not td.exists():
        return jsonify({'content': '', 'exists': False, 'path': str(td)})
    return jsonify({'content': td.read_text(), 'exists': True, 'path': str(td)})


@app.route('/api/t/timedot/append', methods=['POST'])
def api_t_timedot_append():
    data  = request.get_json(silent=True) or {}
    td    = _t_td_file(data.get('file'))
    lines = (data.get('lines') or '').strip()
    if not lines:
        return jsonify({'success': False, 'error': 'lines required'}), 400
    td.parent.mkdir(parents=True, exist_ok=True)
    with open(td, 'a') as f:
        f.write('\n' + lines + '\n')
    return jsonify({'success': True, 'path': str(td)})


def _nb_index_add(file_path: Path):
    """Add file_path to its notebook's .index if not already listed (walk-up search)."""
    p = Path(file_path).resolve()
    candidate = p.parent
    while candidate != candidate.parent:
        idx = candidate / '.index'
        if idx.exists():
            rel = str(p.relative_to(candidate))
            lines = idx.read_text(errors='replace').splitlines()
            if rel not in lines:
                with open(idx, 'a') as f:
                    f.write(rel + '\n')
            return
        candidate = candidate.parent


def _ensure_journal_stubs(journal_path: Path):
    """Touch any files named in include directives of journal_path that don't exist yet."""
    if not journal_path or not journal_path.exists():
        return
    import re as _re
    text = journal_path.read_text(errors='replace')
    for m in _re.finditer(r'^include\s+(\S+)', text, _re.MULTILINE):
        inc = (journal_path.parent / m.group(1)).resolve()
        if not inc.exists():
            inc.parent.mkdir(parents=True, exist_ok=True)
            inc.write_text('; stub — populated automatically on first block save\n')


@app.route('/api/t/timedot/write', methods=['POST'])
def api_t_timedot_write():
    data    = request.get_json(silent=True) or {}
    td      = _t_td_file(data.get('file'))
    content = data.get('content', '')
    td.parent.mkdir(parents=True, exist_ok=True)
    td.write_text(content)
    master_stem = td.stem.removesuffix('-gen')
    _ensure_journal_stubs(td.parent / f'{master_stem}.journal')
    _nb_index_add(td)
    _hledger_cache.clear()
    return jsonify({'success': True, 'path': str(td)})


@app.route('/api/t/journal/from-csv', methods=['POST'])
def api_t_journal_from_csv():
    """Generate a domain hledger journal from a named csv block in a note.

    Body: { selector, token }
    Reads journal: + project: + rate: from note FM.
    Derives journal path: dirname(journal:)/{stem}.{token}.journal
    Writes the file and returns { success, path }.
    """
    import csv as _csv, io as _io
    HST = 0.13
    PAD = 46

    data     = request.get_json(silent=True) or {}
    selector = data.get('selector', '').strip()
    token    = data.get('token', '').strip()
    if not selector or not token:
        return jsonify({'success': False, 'error': 'selector and token required'}), 400

    note_path = _resolve_to_nb_path(selector)
    if not note_path or not note_path.exists():
        return jsonify({'success': False, 'error': 'note not found'}), 404

    text          = note_path.read_text(errors='replace')
    meta, body    = parse_frontmatter(text)
    notebook      = selector.split(':')[0] if ':' in selector else 'home'
    _fcfg         = _folder_config(notebook, str(note_path))
    project       = meta.get('project', note_path.stem)
    journal_key   = str(meta.get('journal') or _fcfg.get('journal') or '').strip()
    if not journal_key:
        return jsonify({'success': False, 'error': 'journal: FM key not set'}), 400

    journal_path  = Path(os.path.expanduser(journal_key))
    out_path      = journal_path.with_name(f'{journal_path.stem}-gen.{token}.journal')

    # clear=true: block was removed from note — write empty stub so journal is blank
    if data.get('clear'):
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(f'; {project} {token} journal — cleared\n; DO NOT HAND EDIT — generated file\n')
        _hledger_cache.clear()
        return jsonify({'success': True, 'cleared': True, 'path': str(out_path)})

    mat_acct      = f'Expenses:{token.capitalize()}:{project}'
    bank_acct     = 'Assets:Bank:Business:Chequing'
    itc_acct      = 'Assets:HST:InputTaxCredits'

    from datetime import date as _date
    import re as _re

    # Each block's transaction date is the nearest preceding '## YYYY-MM-DD'
    # diary heading -- mirrors timedot's own date inheritance (_injectDateContext /
    # _timedotExtractFile). Falls back to started:/today only for a block with no
    # heading above it. Without this, every block's entries were dated from the
    # project's started: frontmatter regardless of which diary day they were
    # actually logged under -- so on any project invoiced more than once, a
    # materials block added after the first invoice landed *before* every
    # subsequent invoice's since-last-invoice cutoff and silently never billed.
    heading_re = _re.compile(r'^#{1,6}\s+(\d{4}-\d{2}-\d{2})', _re.MULTILINE)
    headings   = [(m.start(), m.group(1)) for m in heading_re.finditer(body)]
    default_date = meta.get('started') or str(_date.today())

    # Raw note text has no header row (headers come from .lib/ template); col[0]=name, col[4]=total.
    block_re = _re.compile(r'```csv ' + _re.escape(token) + r'\n([\s\S]*?)```')
    rows_by_date = {}
    for m in block_re.finditer(body):
        block_date = default_date
        for pos, d in headings:
            if pos <= m.start():
                block_date = d
            else:
                break
        for line in m.group(1).splitlines():
            s = line.strip()
            if s and s.lower() != 'contents':
                rows_by_date.setdefault(block_date, []).append(line)

    if not rows_by_date:
        return jsonify({'success': False, 'error': f'no csv {token} block found'}), 404

    jlines = [
        f'; {project} {token} journal — DO NOT HAND EDIT',
        f'; Auto-generated from csv block in note. Edit source blocks in nb-web.',
        f'',
        f'account {mat_acct}',
        f'',
    ]
    any_rows = False
    for txn_date in sorted(rows_by_date):
        reader = _csv.reader(_io.StringIO('\n'.join(rows_by_date[txn_date])))
        parsed = [r for r in reader if any(c.strip() for c in r)]

        total      = 0.0
        desc_lines = []
        for row in parsed:
            lt = 0.0
            # Try col[4] (total column) first
            if len(row) > 4:
                try: lt = float(row[4].replace(',', ''))
                except ValueError: pass
            # Fallback: formula cell — multiply all numeric values in the row (qty × rate)
            if not lt:
                nums = []
                for c in row:
                    c = c.strip()
                    if c and not c.startswith('='):
                        try: nums.append(float(c.replace(',', '')))
                        except ValueError: pass
                if len(nums) >= 2:
                    lt = nums[0]
                    for n in nums[1:]: lt *= n
                elif len(nums) == 1:
                    lt = nums[0]
            lt = round(lt, 2)
            if lt:
                total += lt
                item = row[0].strip() if row else '?'
                desc_lines.append(f'  ; {item}: ${lt:.2f}')

        if not desc_lines:
            continue
        any_rows = True
        total = round(total, 2)
        hst   = round(total * HST, 2)
        gross = round(total + hst, 2)
        jlines += [f'{txn_date} {project} — {token}'] + desc_lines + [
            f'    {mat_acct:<{PAD}} {total:.2f} CAD',
            f'    {itc_acct:<{PAD}} {hst:.2f} CAD',
            f'    {bank_acct:<{PAD}} {-gross:.2f} CAD',
            f'',
        ]

    if not any_rows:
        return jsonify({'success': False, 'error': f'csv {token} block has no data rows'}), 400

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text('\n'.join(jlines))
    _nb_index_add(out_path)
    _hledger_cache.clear()
    return jsonify({'success': True, 'path': str(out_path)})


def _last_invoice_cutoff(journal_key: str) -> str:
    """Read the project diary alongside the journal and return the date of the
    last INVOICED marker, or '' if none. Diary lives at ../name.md relative to
    the journals/ folder (e.g. journals/nathan.journal → ../nathan.md)."""
    if not journal_key:
        return ''
    jpath = Path(os.path.expanduser(journal_key))
    diary = jpath.parent.parent / f'{jpath.stem}.md'
    if not diary.exists():
        return ''
    for line in reversed(diary.read_text(errors='replace').splitlines()):
        m = re.search(r'INVOICED:\s+\S+\s+(\d{4}-\d{2}-\d{2})', line)
        if m:
            return m.group(1)
    return ''


def _scope_predicate(scope: str, cutoff: str, today: str):
    """Return fn(entry_date_str) -> bool for the given scope.
    'since_invoice' (default, billing): after the last INVOICED marker — the
    real invoicing behaviour, unchanged.
    'future' (quotes — 'what's left'): strictly after real wall-clock today.
    Never trust marker text for this, only real dates — see project-today-boundary.
    'all' (quotes — 'whole job'): everything, no filter."""
    if scope == 'future':
        return lambda d: d > today
    if scope == 'all':
        return lambda d: True
    return lambda d: (not cutoff) or d > cutoff


def _parse_labour_entries(journal_key: str, scope: str = 'since_invoice'):
    """Parse labour journal into per-entry dicts. Returns (entries, total_cad).
    Each entry: {date, hours, description, amount}
    scope: 'since_invoice' (default, invoicing) | 'future' | 'all' (quotes)."""
    if not journal_key:
        return [], 0.0
    jpath = Path(os.path.expanduser(journal_key))
    labour_j = jpath.with_name(jpath.stem + '-gen.labour.journal')
    if not labour_j.exists():
        return [], 0.0
    from datetime import date as _date
    cutoff  = _last_invoice_cutoff(journal_key) if scope == 'since_invoice' else ''
    include = _scope_predicate(scope, cutoff, str(_date.today()))
    entries, total, cur = [], 0.0, None
    for line in labour_j.read_text(errors='replace').splitlines():
        m = re.match(r'^(\d{4}-\d{2}-\d{2})\s+\S.*?—\s*([\d.]+)h\s*@\s*\$[\d.]+(?:\s*;\s*(.+))?', line)
        if m:
            entry_date = m.group(1)
            if not include(entry_date):
                cur = None
                continue
            cur = {'date': entry_date, 'hours': float(m.group(2)),
                   'description': (m.group(3) or '').strip(), 'amount': 0.0}
            entries.append(cur)
        elif cur:
            m2 = re.match(r'\s+Assets:AR:\S+\s+([\d.]+)\s+CAD', line)
            if m2:
                cur['amount'] = float(m2.group(1))
                total += cur['amount']
    return entries, round(total, 2)


def _invoice_journal_totals(journal_key: str, scope: str = 'since_invoice'):
    """Read labour + all csv-token expense journals.
    Returns (labour_total, expense_dict) where expense_dict = {token: (subtotal, gross)}.
    Discovers tokens by globbing {stem}.*.journal, skipping labour.
    scope: 'since_invoice' (default, invoicing) | 'future' | 'all' (quotes).

    NOTE — behaviour change 2026-07-13: expense (materials) entries previously had
    NO date filtering at all here, unlike labour — every invoice summed the entire
    historical materials total, unconditionally. That was latent double-counting
    (the same material purchase could appear on multiple invoices). Now scoped
    the same way labour already was, using each transaction's own date line."""
    _, labour_total = _parse_labour_entries(journal_key, scope)
    expense_dict = {}
    if journal_key:
        from datetime import date as _date
        cutoff  = _last_invoice_cutoff(journal_key) if scope == 'since_invoice' else ''
        include = _scope_predicate(scope, cutoff, str(_date.today()))
        jpath = Path(os.path.expanduser(journal_key))
        for p in sorted(jpath.parent.glob(f'{jpath.stem}-gen.*.journal')):
            token = p.name[len(jpath.stem) + 5:].removesuffix('.journal')  # skip '-gen.'
            if token == 'labour':
                continue
            sub = gross = 0.0
            txn_ok = True
            for line in p.read_text(errors='replace').splitlines():
                m0 = re.match(r'^(\d{4}-\d{2}-\d{2})\s+\S', line)
                if m0:
                    txn_ok = include(m0.group(1))
                    continue
                if not txn_ok:
                    continue
                m = re.match(r'\s+Expenses:\S+\s+([\d.]+)\s+CAD', line)
                if m: sub += float(m.group(1))
                m2 = re.match(r'\s+Assets:Bank:\S+\s+-([\d.]+)\s+CAD', line)
                if m2: gross += float(m2.group(1))
            if sub > 0:
                expense_dict[token] = (round(sub, 2), round(gross, 2))
    return round(labour_total, 2), expense_dict


def _lookup_contact(client_ref: str, project_str: str) -> str:
    """Build a To: block from a contacts notebook entry.
    Tries contacts/{stem}.md from client_ref first, then the project prefix."""
    def _try(stem):
        p = NB_DIR / 'contacts' / f'{stem}.md'
        if not p.exists():
            return None
        meta, _ = parse_frontmatter(p.read_text(errors='replace'))
        lines = []
        name = str(meta.get('name', '') or '').strip()
        given = str(meta.get('given', '') or '').strip()
        family = str(meta.get('family', '') or '').strip()
        full_name = name or ' '.join(filter(None, [given, family]))
        org = str(meta.get('org', '') or '').strip()
        addr = str(meta.get('address', '') or '').strip()
        if full_name and full_name.lower() != stem.lower():
            lines.append(full_name)
        if org:
            lines.append(org)
        if addr:
            lines.append(addr)
        return '\n'.join(lines) if lines else None

    # Try the contact ref stem
    ref_stem = client_ref.replace('contacts:', '').replace('.md', '').strip()
    result = _try(ref_stem) if ref_stem else None
    if not result:
        # Fall back to the project prefix (e.g. "gbct" from "gbct:nathan")
        proj_prefix = project_str.split(':')[0] if ':' in project_str else project_str
        result = _try(proj_prefix)
    return result or ref_stem or project_str


def _timedot_categories(timedot_path: str, project: str) -> list:
    """Extract unique sub-category labels from a timedot file.
    e.g. 'gbct:nathan:flooring' → 'flooring' (strips project prefix)."""
    if not timedot_path:
        return []
    p = Path(os.path.expanduser(timedot_path))
    if not p.exists():
        return []
    prefix = project.rstrip(':') + ':'
    seen, cats = set(), []
    for line in p.read_text(errors='replace').splitlines():
        line = line.strip()
        if not line or line[0].isdigit() or line.startswith(';'):
            continue
        acct = line.split()[0] if line.split() else ''
        if acct.startswith(prefix):
            sub = acct[len(prefix):]
            if sub and sub not in seen:
                seen.add(sub)
                cats.append(sub)
    return cats


def _find_invoice_template(notebook: str, btype: str) -> 'Path | None':
    """Look for invoice-{btype}.md then invoice.md in notebook then global templates.
    Normalises btype so 't&m' maps to filename 'invoice-tm.md'."""
    slug = btype.replace('&', '').replace(' ', '-').strip('-')
    for name in (f'invoice-{slug}.md', f'invoice-{btype}.md', 'invoice.md'):
        for base in (NB_DIR / notebook / '.templates', NB_DIR / '.templates'):
            p = base / name
            if p.exists():
                return p
    return None


@app.route('/api/t/invoice/preflight')
def api_t_invoice_preflight():
    import datetime as _dt
    selector = request.args.get('selector', '').strip()
    if not selector:
        return jsonify({'error': 'selector required'}), 400
    note_path = _resolve_to_nb_path(selector)
    if not note_path or not note_path.exists():
        return jsonify({'error': 'note not found'}), 404

    meta, _    = parse_frontmatter(note_path.read_text(errors='replace'))
    project    = str(meta.get('project', note_path.stem))
    rate       = float(meta.get('rate', 0) or 0)
    btype      = str(meta.get('billing_type', 't&m')).strip()
    client_raw = str(meta.get('client', '')).strip()
    client     = client_raw.replace('contacts:', '').replace('.md', '')
    journal_key = str(meta.get('journal', '')).strip()
    if not journal_key:
        _notebook = selector.split(':')[0] if ':' in selector else ''
        if _notebook:
            journal_key = str(_folder_config(_notebook, str(note_path)).get('journal', '')).strip()

    labour_total, expense_dict = _invoice_journal_totals(journal_key)
    entries, _ = _parse_labour_entries(journal_key)
    mat_sub   = sum(v[0] for v in expense_dict.values())
    mat_gross = sum(v[1] for v in expense_dict.values())
    # Real hours summed from entries, never back-computed from labour_total/rate —
    # those can disagree whenever the note's current rate differs from whatever
    # rate was actually baked into historical entries (see rate-drift finding,
    # claude:nbweb-hledger_plugin_design.md).
    labour_hours = round(sum(e['hours'] for e in entries), 2)
    # Blended, not the note's flat rate scalar — so hours × rate always equals
    # the total shown here, even when a > RATE: marker changed the rate mid-period.
    display_rate = round(labour_total / labour_hours, 2) if labour_hours else rate

    today = _dt.date.today()
    year  = today.year
    existing = sorted(f.stem for f in (note_path.parent.parent / 'invoices').glob(f'INV-{year}-*.md'))
    next_num = (int(existing[-1].split('-')[-1]) + 1) if existing else 1

    return jsonify({
        'suggested_num':     f'INV-{year}-{next_num:03d}',
        'date':              str(today),
        'due':               'on receipt' if btype == 'cash' else 'net 30',
        'billing_type':      btype,
        'project':           project,
        'client':            client,
        'client_raw':        client_raw,
        'rate':              display_rate,
        'labour_hours':      labour_hours,
        'labour_total':      labour_total,
        'expense_totals':    {t: {'subtotal': s, 'gross': g} for t, (s, g) in expense_dict.items()},
        'materials_subtotal': mat_sub,
        'materials_gross':   mat_gross,
    })


@app.route('/api/t/invoice/generate', methods=['POST'])
def api_t_invoice_generate():
    import datetime as _dt
    HST = 0.13

    data        = request.get_json(silent=True) or {}
    selector    = data.get('selector', '').strip()
    invoice_num = data.get('invoice_num', '').strip()
    inv_date    = data.get('date', str(_dt.date.today()))
    due         = data.get('due', 'on receipt')
    notes       = data.get('notes', '').strip()

    if not selector or not invoice_num:
        return jsonify({'error': 'selector and invoice_num required'}), 400

    note_path = _resolve_to_nb_path(selector)
    if not note_path or not note_path.exists():
        return jsonify({'error': 'note not found'}), 404

    meta, _    = parse_frontmatter(note_path.read_text(errors='replace'))
    notebook   = selector.split(':')[0] if ':' in selector else 'home'
    _fcfg      = _folder_config(notebook, str(note_path))
    project    = str(meta.get('project') or _fcfg.get('project') or note_path.stem)
    rate       = float(meta.get('rate') or _fcfg.get('rate') or 0)
    btype      = str(meta.get('billing_type') or _fcfg.get('billing_type') or 't&m').strip()
    client_raw = str(meta.get('client') or _fcfg.get('client') or '').strip()
    client     = client_raw.replace('contacts:', '').replace('.md', '')
    journal_key = str(meta.get('journal') or _fcfg.get('journal') or '').strip()
    timedot_key = str(meta.get('timedot_file') or _fcfg.get('timedot_file') or '').strip()
    if not timedot_key and journal_key:
        timedot_key = journal_key.replace('.journal', '-gen.timedot')

    labour_total, expense_dict = _invoice_journal_totals(journal_key)
    entries, _ = _parse_labour_entries(journal_key)
    mat_sub   = sum(v[0] for v in expense_dict.values())
    mat_gross = sum(v[1] for v in expense_dict.values())
    labour_hours = round(sum(e['hours'] for e in entries), 2)

    # Derive notebook + relative folder
    nb_root     = NB_DIR / notebook
    project_dir = note_path.parent
    rel_folder  = str(project_dir.relative_to(nb_root))
    reports_sel = f'{notebook}:{rel_folder}/{note_path.name}'

    # Contact lookup for To: block
    to_lines   = _lookup_contact(client_raw, project)
    to_block   = '**To:** ' + '  \n'.join(to_lines.splitlines()) if to_lines else f'**To:** {client}'

    # Re: line — project stem + timedot categories
    proj_stem  = project.split(':')[-1] if ':' in project else project
    categories = _timedot_categories(timedot_key, project)
    re_line    = f'project: {proj_stem} ({", ".join(categories)})' if categories else f'project: {proj_stem}'

    # Accounts
    ar_acct     = f'Assets:AR:{project}'
    income_acct = f'Income:Services:Hourly:{project}'
    hst_acct    = 'Liabilities:HST:Collected'
    W = 48  # column width for ledger alignment

    if btype == 'cash':
        # Cash: flat amount invoiced, no HST collected from client.
        # Full amount recorded as income; HST obligation handled at filing time.
        ar_total      = round(labour_total + mat_gross, 2)
        total_income  = ar_total
        total_hst     = 0.0
        hst_comment   = 'cash — HST at filing time'
        total_display = f'**Total: ${ar_total:.2f}** *(cash — no HST collected)*'
        payment_acct  = 'Assets:Cash'
        payment_label = 'cash received'
        ledger_block = f'''; {invoice_num} — {hst_comment}

{inv_date} {invoice_num} — {client} (due)
    {ar_acct:<{W}} {ar_total:.2f} CAD
    {income_acct:<{W}}-{ar_total:.2f} CAD

; ── Record payment when received: ──
; YYYY-MM-DD {invoice_num} — {payment_label}
;     {payment_acct:<{W-4}} {ar_total:.2f} CAD
;     {ar_acct:<{W-4}}-{ar_total:.2f} CAD'''
    else:
        # t&m: HST collected on top of subtotal
        subtotal      = round(labour_total + mat_sub, 2)
        total_hst     = round(subtotal * HST, 2)
        ar_total      = round(subtotal + total_hst, 2)
        total_income  = subtotal
        hst_comment   = f't&m — HST ${total_hst:.2f} collected'
        total_display = f'**Subtotal: ${subtotal:.2f} + HST ${total_hst:.2f} = Total: ${ar_total:.2f}**'
        payment_acct  = 'Assets:Bank:Business:Chequing'
        payment_label = 'payment received'
        ledger_block = f'''; {invoice_num} — {hst_comment}

{inv_date} {invoice_num} — {client} (due)
    {ar_acct:<{W}} {ar_total:.2f} CAD
    {income_acct:<{W}}-{total_income:.2f} CAD
    {hst_acct:<{W}}-{total_hst:.2f} CAD

; ── Record payment when received: ──
; YYYY-MM-DD {invoice_num} — {payment_label}
;     {payment_acct:<{W-4}} {ar_total:.2f} CAD
;     {ar_acct:<{W-4}}-{ar_total:.2f} CAD'''

    # Per-day labour rows (entries already computed above). Each row's rate is
    # derived from that entry's own already-correct amount/hours — never the note's
    # single current-rate scalar, which disagrees with older entries whenever a
    # > RATE: marker changed the rate mid-project (see rate-drift finding,
    # claude:nbweb-hledger_plugin_design.md). A "rate change to $X" row is inserted
    # wherever consecutive entries' derived rates differ — the same thing INV-2026-009
    # did by hand; this makes it automatic.
    rate_unit_abbrev = {'hour': 'hr', 'day': 'day'}.get(
        str(meta.get('rate_unit') or _fcfg.get('rate_unit') or 'hour').strip().lower(), 'hr')

    def _entry_rate(e):
        return round(e['amount'] / e['hours'], 2) if e['hours'] else rate

    def _labour_row(e):
        desc = (e['description'] or '—')[:60]
        return f"| {e['date']} | {desc} | {e['hours']:.1f} | ${_entry_rate(e):.2f} | ${e['amount']:.2f} |"

    labour_rows, prev_rate = [], None
    for e in entries:
        r = _entry_rate(e)
        if prev_rate is not None and r != prev_rate:
            labour_rows.append(f"| | rate change to ${r:.2f}/{rate_unit_abbrev} | | | |")
        labour_rows.append(_labour_row(e))
        prev_rate = r
    current_rate = prev_rate if prev_rate is not None else rate
    labour_lines = '\n'.join(labour_rows) if labour_rows else \
        f"| — | Labour | {labour_hours:.1f} | ${rate:.2f} | ${labour_total:.2f} |"
    expense_lines = '\n'.join(
        f"| — | {token.capitalize()} | — | cost | ${gross:.2f} |"
        for token, (_, gross) in expense_dict.items()
    )

    notes_section = f'\n\n**Notes:** {notes}' if notes else ''

    tmpl_path = _find_invoice_template(notebook, btype)
    if tmpl_path:
        content = tmpl_path.read_text(errors='replace')
        for k, v in {
            '{{invoice_num}}':      invoice_num,
            '{{client}}':           client,
            '{{client_raw}}':       client_raw,
            '{{project}}':          project,
            '{{reports_selector}}': reports_sel,
            '{{rate}}':             str(current_rate),
            '{{issued}}':           inv_date,
            '{{due}}':              due,
            '{{labour_lines}}':     labour_lines,
            '{{expense_lines}}':    expense_lines,
            '{{total_line}}':       total_display,
            '{{subtotal}}':         f'{round(labour_total + mat_sub, 2):.2f}',
            '{{hst}}':              f'{total_hst:.2f}',
            '{{ar_total}}':         f'{ar_total:.2f}',
            '{{ledger_block}}':     ledger_block,
            '{{notes_section}}':    notes_section,
            '{{to_block}}':         to_block,
            '{{re_line}}':          re_line,
        }.items():
            content = content.replace(k, v)
    else:
        # Fallback inline content (no template found). No per-row template here,
        # so this stays a single blended line — but blended (not the flat frontmatter
        # rate) so hours × rate still equals the total shown, same fix as preflight.
        display_rate = round(labour_total / labour_hours, 2) if labour_hours else rate
        notes_md   = f'\n**Notes:** {notes}\n' if notes else ''
        labour_row = f'| Labour | {labour_hours:.1f} h × ${display_rate:.2f} | ${labour_total:.2f} |\n'
        mat_row    = f'| Materials | cost + HST | ${mat_gross:.2f} |\n' if mat_gross > 0 else ''
        content = f'''---
title: "{invoice_num} — {client}"
type: invoice
project: {project}
client: "{client_raw}"
reports: "{reports_sel}"
billing_type: {btype}
rate: {current_rate}
issued: "{inv_date}"
due: "{due}"
status: due
invoice_num: {invoice_num}
---
# {invoice_num}

**Issued:** {inv_date} · **Due:** {due}

**Bill to:** {client}

---

## Services

| Description | Detail | Amount |
|---|---|---|
{labour_row}{mat_row}
{total_display}{notes_md}

---

```ledger
{ledger_block}
```
'''

    inv_filename = f'{invoice_num}.md'
    inv_dir      = project_dir.parent / 'invoices'
    inv_dir.mkdir(exist_ok=True)
    inv_path     = inv_dir / inv_filename
    if inv_path.exists():
        return jsonify({'error': f'{inv_filename} already exists'}), 409

    inv_path.write_text(content)

    # Ensure invoices/.index exists and contains this file
    index_path = inv_dir / '.index'
    existing   = index_path.read_text().splitlines() if index_path.exists() else []
    if inv_filename not in existing:
        with open(index_path, 'a') as f:
            f.write(inv_filename + '\n')

    # Append invoice marker to project diary — source of truth for billing cutoff.
    # Delete this line from the diary to regenerate the same invoice period.
    jpath      = Path(os.path.expanduser(journal_key))
    diary_path = jpath.parent.parent / f'{jpath.stem}.md'
    extra_files = []
    if diary_path.exists():
        with open(diary_path, 'a') as f:
            f.write(f'\n> INVOICED: {invoice_num}  {inv_date}  ${ar_total:.2f} {btype}\n')
        extra_files.append(str(diary_path.relative_to(nb_root)))

    rel_in_nb  = inv_path.relative_to(nb_root)
    index_rel  = index_path.relative_to(nb_root)
    env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
    subprocess.run(['git', 'add', str(rel_in_nb), str(index_rel)] + extra_files,
                   cwd=str(nb_root), capture_output=True, env=env)
    subprocess.run(['git', 'commit', '-m', f'[nb] Added: {inv_filename}'],
                   cwd=str(nb_root), capture_output=True, env=env)
    _hledger_cache.clear()

    inv_rel = inv_path.relative_to(nb_root)
    return jsonify({'success': True,
                    'selector': f'{notebook}:{inv_rel}',
                    'path': str(inv_path)})


def _find_quote_template(notebook: str, btype: str) -> 'Path | None':
    """Same lookup shape as _find_invoice_template, for quote-{btype}.md / quote.md."""
    slug = btype.replace('&', '').replace(' ', '-').strip('-')
    for name in (f'quote-{slug}.md', f'quote-{btype}.md', 'quote.md'):
        for base in (NB_DIR / notebook / '.templates', NB_DIR / '.templates'):
            p = base / name
            if p.exists():
                return p
    return None


@app.route('/api/t/quote/preflight')
def api_t_quote_preflight():
    """A quote is a report, not a billing event: no ledger block, no diary
    marker, no accounting implications — just a projection over guesstimated
    future/all-time diary content, calculated with the same tools as invoicing."""
    import datetime as _dt
    selector = request.args.get('selector', '').strip()
    scope    = request.args.get('scope', 'future').strip()
    if scope not in ('future', 'all'):
        return jsonify({'error': "scope must be 'future' or 'all'"}), 400
    if not selector:
        return jsonify({'error': 'selector required'}), 400
    note_path = _resolve_to_nb_path(selector)
    if not note_path or not note_path.exists():
        return jsonify({'error': 'note not found'}), 404

    meta, _    = parse_frontmatter(note_path.read_text(errors='replace'))
    notebook   = selector.split(':')[0] if ':' in selector else 'home'
    _fcfg      = _folder_config(notebook, str(note_path))
    project    = str(meta.get('project') or _fcfg.get('project') or note_path.stem)
    rate       = float(meta.get('rate') or _fcfg.get('rate') or 0)
    btype      = str(meta.get('billing_type') or _fcfg.get('billing_type') or 't&m').strip()
    client_raw = str(meta.get('client') or _fcfg.get('client') or '').strip()
    client     = client_raw.replace('contacts:', '').replace('.md', '')
    journal_key = str(meta.get('journal') or _fcfg.get('journal') or '').strip()

    labour_total, expense_dict = _invoice_journal_totals(journal_key, scope)
    entries, _ = _parse_labour_entries(journal_key, scope)
    mat_sub   = sum(v[0] for v in expense_dict.values())
    mat_gross = sum(v[1] for v in expense_dict.values())
    labour_hours = round(sum(e['hours'] for e in entries), 2)
    # Blended, not the note's flat rate scalar — see the same fix in invoice preflight.
    display_rate = round(labour_total / labour_hours, 2) if labour_hours else rate

    today = _dt.date.today()
    year  = today.year
    existing = sorted(f.stem for f in (note_path.parent.parent / 'quotes').glob(f'QUO-{year}-*.md'))
    next_num = (int(existing[-1].split('-')[-1]) + 1) if existing else 1

    return jsonify({
        'suggested_num':     f'QUO-{year}-{next_num:03d}',
        'date':              str(today),
        'scope':             scope,
        'billing_type':      btype,
        'project':           project,
        'client':            client,
        'client_raw':        client_raw,
        'rate':              display_rate,
        'labour_hours':      labour_hours,
        'labour_total':      labour_total,
        'expense_totals':    {t: {'subtotal': s, 'gross': g} for t, (s, g) in expense_dict.items()},
        'materials_subtotal': mat_sub,
        'materials_gross':   mat_gross,
        'empty':             labour_hours == 0 and mat_sub == 0,
    })


@app.route('/api/t/quote/generate', methods=['POST'])
def api_t_quote_generate():
    """Writes a type: quote note — a projection, not a transaction. No ledger
    block, no diary marker appended, no AR/Income posted. Guesstimated hours
    and materials come from the same timedot/csv blocks as real entries,
    just dated in the future/all-time scope rather than already-invoiced."""
    from datetime import date as _date
    HST = 0.13

    data       = request.get_json(silent=True) or {}
    selector   = data.get('selector', '').strip()
    quote_num  = data.get('quote_num', '').strip()
    scope      = data.get('scope', 'future').strip()
    q_date     = data.get('date', str(_date.today()))
    valid_until = data.get('valid_until', '').strip()
    notes      = data.get('notes', '').strip()

    if scope not in ('future', 'all'):
        return jsonify({'error': "scope must be 'future' or 'all'"}), 400
    if not selector or not quote_num:
        return jsonify({'error': 'selector and quote_num required'}), 400

    note_path = _resolve_to_nb_path(selector)
    if not note_path or not note_path.exists():
        return jsonify({'error': 'note not found'}), 404

    meta, _    = parse_frontmatter(note_path.read_text(errors='replace'))
    notebook   = selector.split(':')[0] if ':' in selector else 'home'
    _fcfg      = _folder_config(notebook, str(note_path))
    project    = str(meta.get('project') or _fcfg.get('project') or note_path.stem)
    rate       = float(meta.get('rate') or _fcfg.get('rate') or 0)
    btype      = str(meta.get('billing_type') or _fcfg.get('billing_type') or 't&m').strip()
    client_raw = str(meta.get('client') or _fcfg.get('client') or '').strip()
    client     = client_raw.replace('contacts:', '').replace('.md', '')
    journal_key = str(meta.get('journal') or _fcfg.get('journal') or '').strip()
    timedot_key = str(meta.get('timedot_file') or _fcfg.get('timedot_file') or '').strip()
    if not timedot_key and journal_key:
        timedot_key = journal_key.replace('.journal', '-gen.timedot')

    labour_total, expense_dict = _invoice_journal_totals(journal_key, scope)
    entries, _ = _parse_labour_entries(journal_key, scope)
    mat_sub   = sum(v[0] for v in expense_dict.values())
    mat_gross = sum(v[1] for v in expense_dict.values())
    labour_hours = round(sum(e['hours'] for e in entries), 2)

    nb_root     = NB_DIR / notebook
    project_dir = note_path.parent
    rel_folder  = str(project_dir.relative_to(nb_root))
    reports_sel = f'{notebook}:{rel_folder}/{note_path.name}'

    to_lines = _lookup_contact(client_raw, project)
    to_block = '**To:** ' + '  \n'.join(to_lines.splitlines()) if to_lines else f'**To:** {client}'

    proj_stem  = project.split(':')[-1] if ':' in project else project
    categories = _timedot_categories(timedot_key, project)
    re_line    = f'project: {proj_stem} ({", ".join(categories)})' if categories else f'project: {proj_stem}'

    if btype == 'cash':
        est_total     = round(labour_total + mat_gross, 2)
        total_display = f'**Estimated Total: ${est_total:.2f}** *(cash — no HST)*'
    else:
        subtotal      = round(labour_total + mat_sub, 2)
        total_hst     = round(subtotal * HST, 2)
        est_total     = round(subtotal + total_hst, 2)
        total_display = f'**Estimated Subtotal: ${subtotal:.2f} + HST ${total_hst:.2f} = Estimated Total: ${est_total:.2f}**'

    # Same rate-drift handling as api_t_invoice_generate — see comment there.
    rate_unit_abbrev = {'hour': 'hr', 'day': 'day'}.get(
        str(meta.get('rate_unit') or _fcfg.get('rate_unit') or 'hour').strip().lower(), 'hr')

    def _entry_rate(e):
        return round(e['amount'] / e['hours'], 2) if e['hours'] else rate

    def _labour_row(e):
        desc = (e['description'] or '—')[:60]
        return f"| {e['date']} | {desc} | {e['hours']:.1f} | ${_entry_rate(e):.2f} | ${e['amount']:.2f} |"

    labour_rows, prev_rate = [], None
    for e in entries:
        r = _entry_rate(e)
        if prev_rate is not None and r != prev_rate:
            labour_rows.append(f"| | rate change to ${r:.2f}/{rate_unit_abbrev} | | | |")
        labour_rows.append(_labour_row(e))
        prev_rate = r
    current_rate = prev_rate if prev_rate is not None else rate
    labour_lines = '\n'.join(labour_rows) if labour_rows else \
        f"| — | Labour | {labour_hours:.1f} | ${rate:.2f} | ${labour_total:.2f} |"
    expense_lines = '\n'.join(
        f"| — | {token.capitalize()} | — | cost | ${gross:.2f} |"
        for token, (_, gross) in expense_dict.items()
    )
    scope_label = 'remaining work (from tomorrow on)' if scope == 'future' else 'the whole job, start to finish'
    valid_line  = f' · **Valid until:** {valid_until}' if valid_until else ''
    notes_md    = f'\n**Notes:** {notes}\n' if notes else ''

    tmpl_path = _find_quote_template(notebook, btype)
    if tmpl_path:
        content = tmpl_path.read_text(errors='replace')
        for k, v in {
            '{{quote_num}}':        quote_num,
            '{{client}}':           client,
            '{{client_raw}}':       client_raw,
            '{{project}}':          project,
            '{{reports_selector}}': reports_sel,
            '{{rate}}':             str(current_rate),
            '{{issued}}':           q_date,
            '{{valid_until}}':      valid_until,
            '{{scope}}':            scope,
            '{{scope_label}}':      scope_label,
            '{{labour_lines}}':     labour_lines,
            '{{expense_lines}}':    expense_lines,
            '{{total_line}}':       total_display,
            '{{notes_section}}':    notes_md,
            '{{to_block}}':         to_block,
            '{{re_line}}':          re_line,
        }.items():
            content = content.replace(k, v)
    else:
        mat_row = f'| Materials (est.) | cost + HST | ${mat_gross:.2f} |\n' if mat_gross > 0 else ''
        content = f'''---
title: "{quote_num} — {client}"
type: quote
project: {project}
client: "{client_raw}"
reports: "{reports_sel}"
billing_type: {btype}
rate: {current_rate}
scope: {scope}
issued: "{q_date}"
valid_until: "{valid_until}"
status: draft
quote_num: {quote_num}
---
# {quote_num}

**Estimate** — a projection over {scope_label}, calculated with the same tools as
invoicing but not a billing event: no ledger entries, no accounts affected.
Actual amounts are determined when the work is done and invoiced separately.

**Issued:** {q_date}{valid_line}

{to_block}

**Re:** {re_line}

---

## Estimated services

| Date | Description | Hours | Rate | Amount |
|---|---|---|---|---|
{labour_lines}
{expense_lines}

{total_display}{notes_md}
'''

    quo_filename = f'{quote_num}.md'
    quo_dir      = project_dir.parent / 'quotes'
    quo_dir.mkdir(exist_ok=True)
    quo_path     = quo_dir / quo_filename
    if quo_path.exists():
        return jsonify({'error': f'{quo_filename} already exists'}), 409

    quo_path.write_text(content)

    index_path = quo_dir / '.index'
    existing   = index_path.read_text().splitlines() if index_path.exists() else []
    if quo_filename not in existing:
        with open(index_path, 'a') as f:
            f.write(quo_filename + '\n')

    rel_in_nb  = quo_path.relative_to(nb_root)
    index_rel  = index_path.relative_to(nb_root)
    env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
    subprocess.run(['git', 'add', str(rel_in_nb), str(index_rel)],
                   cwd=str(nb_root), capture_output=True, env=env)
    subprocess.run(['git', 'commit', '-m', f'[nb] Added: {quo_filename}'],
                   cwd=str(nb_root), capture_output=True, env=env)

    quo_rel = quo_path.relative_to(nb_root)
    return jsonify({'success': True,
                    'selector': f'{notebook}:{quo_rel}',
                    'path': str(quo_path)})


# Named permission groups for a claude_code terminal launch -- checkbox
# labels in the claude_ask barblock, not raw --allowedTools syntax, so the
# person picking a scope doesn't need to know Claude Code's own pattern
# grammar. 'push' deliberately excluded from any bundling with 'commit' --
# matches the "hard to reverse, affects shared state" caution elsewhere in
# this codebase; an agent shouldn't get that by default alongside commit.
_CLAUDE_PERMISSION_SCOPES = {
    'edit':   ['Read(**)', 'Edit(**)', 'Write(**)'],
    'commit': ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git add:*)', 'Bash(git commit:*)'],
    'push':   ['Bash(git push:*)'],
}

# Circuit-breaker ceilings for _stream_claude_ask -- module-level so the
# pre-flight config modal's spend/limits display (api_claude_session_cost)
# can surface the same numbers rather than a second hardcoded copy that
# could drift. A blunt safety net, not a calibrated budget system -- see
# _stream_claude_ask's own comment for how these were picked.
_CLAUDE_MAX_TURNS      = 100
_CLAUDE_MAX_NEW_TOKENS = 400_000


def _claude_permission_flags(selector):
    """Extra argv for a claude --resume launch, structurally enforcing the
    scope set via the checkbox row next to Ask (claude_permissions: FM
    field) -- not trusting whatever wrote the command string, model or
    human, to have included the right safety flags itself. Resolved fresh
    from the note's current FM at spawn time, so a checkbox change takes
    effect on the next launch without needing to touch an already-running
    session. No scope set anywhere -> dontAsk with an empty allow-list,
    which denies everything beyond the built-in read-only set rather than
    silently falling back to unrestricted access.
    """
    scopes = []
    if selector:
        fpath = _resolve_to_nb_path(selector)
        if fpath and fpath.is_file():
            try:
                raw = fpath.read_text(errors='replace')
                meta, _ = parse_frontmatter(raw)
                scopes = [s.strip() for s in str(meta.get('claude_permissions', '') or '').split(',') if s.strip()]
            except OSError:
                pass
    allowed = [pattern for scope in scopes for pattern in _CLAUDE_PERMISSION_SCOPES.get(scope, [])]
    flags = ['--permission-mode', 'dontAsk']
    if allowed:
        flags += ['--allowedTools'] + allowed
    return flags


@app.route('/api/version')
def api_version():
    return jsonify({'started': _STARTED_AT, 'rev': _GIT_REV})


@sock.route('/ws/pty')
def ws_pty(ws):
    """WebSocket PTY: open a shell in the browser terminal panel."""
    import pty, select, fcntl, termios, struct

    # Reject cross-origin connections (CSRF guard). Same-origin check
    # against the actual Host this request arrived on -- not a hardcoded
    # localhost allowlist, which broke real, legitimate access over
    # Tailscale (confirmed real: a phone reaching nb-web via its Tailscale
    # hostname/IP got an immediate "connection rejected" close on this
    # endpoint specifically, while /ws/claude-ask -- which has no such
    # guard -- already worked fine from the same phone). A genuine
    # cross-origin attempt (some other page's script opening this socket)
    # sends that page's own origin, which will never match request.host
    # regardless of what host nb-web itself is reached through.
    origin = request.environ.get('HTTP_ORIGIN', '')
    if origin:
        from urllib.parse import urlparse
        parsed = urlparse(origin)
        if parsed.netloc != request.host:
            ws.send('\r\n[pty] Connection rejected: cross-origin request\r\n')
            return

    first = ws.receive(timeout=10)
    if not first:
        return
    try:
        payload  = json.loads(first)
        cwd_str  = payload.get('cwd',  '').strip()
        selector = payload.get('selector', '').strip()   # "this note" cwd resolution
        cmd_str  = payload.get('cmd',  '').strip()   # direct spawn — no shell wrapper
        init_str = payload.get('init', '').strip()   # shell mode — typed into shell
        # Explicit flag, not inferred from init_str being empty -- init_str
        # is non-empty for a bare terminal open too whenever the user has a
        # configured default startup command, so "is init_str empty" can't
        # tell a generic terminal apart from a specific one-off launch.
        persist  = bool(payload.get('persist', False))
        cols     = int(payload.get('cols', 80))
        rows     = int(payload.get('rows', 24))
    except Exception:
        cwd_str = selector = cmd_str = init_str = ''
        persist = False
        cols, rows = 80, 24

    # "This note" resolution -- same cwd double-duty trick as /api/claude/ask:
    # a block that doesn't ask for an explicit cwd runs in its own note's
    # notebook dir, so CLAUDE.md/.rules auto-load for free. Explicit cwd
    # (from the codeblock body itself, e.g. --cwd or a leading `cd`) wins.
    if not cwd_str and ':' in selector:
        candidate = NB_DIR / selector.split(':')[0]
        if candidate.is_dir():
            cwd_str = str(candidate)

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

        # A claude --resume launch always gets a structurally-enforced
        # permission scope, regardless of what the command string itself
        # says -- this can't be skipped or forgotten by whatever wrote it.
        # '--permission-mode not in args' guard means an explicit override
        # already present in the codeblock body is never silently doubled.
        is_claude_resume = args and args[0] == 'claude' and '--resume' in args
        if is_claude_resume and '--permission-mode' not in args:
            args += _claude_permission_flags(selector)

        # Wrap in a named tmux session, keyed to the resumed session id --
        # 'new-session -A' attaches if that session already exists, else
        # creates it. This is what actually solves "navigating away kills
        # the session": the claude process runs as a child of the tmux
        # *server* (a persistent daemon), not of this websocket's own
        # subprocess, so it keeps running with zero client attached --
        # confirmed directly (a real backgrounded tmux session kept
        # producing output for 6+ seconds with nothing ever attached to
        # it), not assumed from tmux's reputation. Navigating back just
        # re-attaches to the same live process, full scrollback intact,
        # instead of cold-starting claude again.
        if is_claude_resume and shutil.which('tmux'):
            resume_idx = args.index('--resume')
            session_id = args[resume_idx + 1] if resume_idx + 1 < len(args) else ''
            tmux_name = 'claude-' + re.sub(r'[^a-zA-Z0-9_-]', '', session_id)
            if tmux_name != 'claude-':
                args = ['tmux', 'new-session', '-A', '-s', tmux_name] + args
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
        # Shell mode: spawn a shell and optionally type an init command into it.
        #
        # A generic open (persist:true from the frontend -- the Menu
        # "Terminal" item / 'T' shortcut / a bare NbTerminal.open() call,
        # no specific command requested) is wrapped in a stable, well-known
        # tmux session so it persists across disconnects: confirmed real
        # 2026-07-12, a mobile connection over Tailscale drops the
        # websocket far more readily than a stable desktop one, and
        # without this a dropped shell-mode session was just gone -- no
        # tmux wrapping existed for this path at all, unlike the
        # claude_code:/cmd_str branch above. Same 'new-session -A'
        # attach-or-create tmux already uses there.
        #
        # A launch with a specific command (a codeblock's `term:` open,
        # NbTerminal.run(cmd) -- persist:false) deliberately stays a plain
        # one-off shell, unwrapped -- it's a purpose-built launch for one
        # task, not "the" persistent terminal, and sharing one tmux name
        # across both would let one collide with the other's input
        # mid-command. Deliberately keyed off the explicit persist flag,
        # not "is init_str empty" -- init_str is also non-empty for a
        # bare open whenever the user has a configured default startup
        # command, so that alone can't tell the two cases apart.
        shell_bin = os.environ.get('SHELL') or shutil.which('bash') or 'sh'
        args = [shell_bin]
        if persist and shutil.which('tmux'):
            args = ['tmux', 'new-session', '-A', '-s', 'nb-web-shell', shell_bin]
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
             if _can_access(user, {}, _notebook_config(n)) and _notebook_in_scope(user, n)]
    if _level_gte(user_level, 'admin'):
        names += [d for d in DOTFOLDERS if (NB_DIR / d).is_dir() and _notebook_in_scope(user, d)]
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


def _fm_compare(a, b, op) -> bool:
    """a <op> b for fm's '>'/'<' filter ops. Tries numeric comparison first
    (seq, wordcount, budget, or any other numeric FM field); falls back to
    string comparison, which is correct for ISO dates (mtime: YYYY-MM-DD) since
    lexicographic order matches chronological order for that format."""
    try:
        a_val, b_val = float(a), float(b)
    except (TypeError, ValueError):
        a_val, b_val = str(a), str(b)
    return a_val > b_val if op == '>' else a_val < b_val


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
        elif op in ('>', '<'):
            v = meta.get(field)
            if v is None:
                return False
            if not _fm_compare(str(v), str(value), op):
                return False
        else:  # eq
            v = meta.get(field)
            if v is None:
                return False
            if str(v).lower() != str(value).lower():
                return False
    return True


@app.route('/api/fm/keys')
def api_fm_keys():
    """Aggregate FM keys across a notebook.

    notebook: notebook name
    keys:     optional repeated param — if present, only include these keys
    Returns {keys: {name: {count, count_empty, samples[]}}}
    """
    notebook  = request.args.get('notebook', '')
    scope_set = set(request.args.getlist('keys')) or None
    nb_path   = Path(NB_DIR) / notebook if notebook else Path(NB_DIR)
    if not nb_path.is_dir():
        return jsonify({'error': 'notebook not found'}), 404

    key_data = {}
    for root, dirs, files in os.walk(nb_path):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.'))
        for fname in files:
            if not fname.endswith('.md'):
                continue
            try:
                text = (Path(root) / fname).read_text(errors='replace')
                meta, _ = parse_frontmatter(text)
            except Exception:
                continue
            for k, v in meta.items():
                if scope_set and k not in scope_set:
                    continue
                entry = key_data.setdefault(k, {'count': 0, 'count_empty': 0, 'samples': []})
                entry['count'] += 1
                sv = str(v).strip() if v is not None else ''
                if not sv:
                    entry['count_empty'] += 1
                elif sv not in entry['samples'] and len(entry['samples']) < 4:
                    entry['samples'].append(sv)

    return jsonify({'keys': key_data})


def _run_front_query(user, nb_list_in, folder_list_in, filters, limit=200):
    """Shared scan for frontmatter queries — used by /api/front-query (the fm
    codeblock) and the 'fm' inline-query provider. Returns (results, error);
    error is a (message, status) pair on failure, results is a list on success.

    nb_list_in:     notebook names; empty list = search all notebooks.
    folder_list_in: folder paths, same order/length as nb_list_in; '' (or a
                     missing/short entry) = no folder scope for that notebook
                     (whole notebook, recursive).
    filters:        list of {field, op, value} dicts — op is 'eq'|'exists'|'empty'.
    """
    limit = min(limit, 500)

    if nb_list_in:
        nb_list = [n.strip() for n in nb_list_in if n.strip()]
        for nb in nb_list:
            if not _safe_notebook(nb):
                return None, (f'invalid notebook: {nb}', 400)
        # folders is positionally aligned with nb_list — '' entries are fine and
        # common (a scope token with no folder qualifier); pad defensively so a
        # length mismatch can't ever raise instead of just meaning "no folder".
        folder_list = list(folder_list_in) + [''] * (len(nb_list) - len(folder_list_in))
        nb_folders = dict(zip(nb_list, folder_list))
        for nb, folder in nb_folders.items():
            if not folder:
                continue
            try:
                resolved = (nb_dir_for(nb) / folder).resolve()
                resolved.relative_to(nb_dir_for(nb).resolve())
            except (ValueError, OSError):
                return None, (f'invalid folder: {folder}', 400)
    else:
        nb_list    = [d.name for d in sorted(NB_DIR.iterdir())
                      if d.is_dir() and not d.name.startswith('.')]
        nb_folders = {}

    def _scan_file(fpath, selector, notebook=None, nb_cfg=None):
        itype = classify(fpath.name, notebook)
        if itype in BINARY_TYPES:
            return None
        try:
            raw = fpath.read_text(errors='replace')
        except OSError:
            return None
        meta, body = parse_frontmatter(raw)
        # Destination check — same floor /api/note already enforces per-note. Was
        # missing entirely before 2026-08-04: any authenticated session (any level)
        # could read frontmatter from any notebook regardless of its configured
        # access:, including office/admin-gated ones. nb_cfg is None only for the
        # root-dotfiles branch below, which has its own admin gate instead.
        # Checked against real meta only — before pseudo-fields are added below,
        # so a synthetic field can never influence an access decision.
        if nb_cfg is not None and not _can_access(user, meta, nb_cfg):
            return None
        # Pseudo-fields: computed metadata, not stored in YAML, queryable/filterable/
        # groupable with the exact same field:value grammar as real frontmatter (the
        # fm query language plan's unifying idea — one namespace, no second syntax).
        # Always overrides a same-named real FM field: an actual note setting e.g.
        # "wordcount:" itself would be a naming collision to avoid, not something
        # that should silently shadow the computed metric.
        try:
            mtime_str = datetime.fromtimestamp(fpath.stat().st_mtime).strftime('%Y-%m-%d')
        except OSError:
            mtime_str = ''
        meta = {**meta, 'mtime': mtime_str,
                'wordcount': str(len(body.split())),
                'linecount': str(len(body.splitlines()))}
        if not _front_matches(meta, filters):
            return None
        title = meta.get('title') or meta.get('name') or note_title(fpath.name, body)
        return {'title': title, 'selector': selector, 'filename': fpath.name,
                'type': itype, 'notebook': notebook or '',
                'meta': {k: str(v) for k, v in meta.items()}}

    results = []

    # Scan NB_DIR root dotfiles (.nb.md etc.) when no notebook filter is set.
    # These are global config, not notebook-scoped content — admin floor matches
    # the existing .nb:.nb.md special case in api_note.
    if not nb_list_in and _level_gte(user.get('level', ''), 'admin'):
        for fpath in sorted(NB_DIR.iterdir()):
            if fpath.is_file() and fpath.name.startswith('.'):
                r = _scan_file(fpath, str(fpath))
                if r:
                    results.append(r)
                    if len(results) >= limit:
                        return results, None

    for notebook in nb_list:
        nb_dir    = nb_dir_for(notebook)
        nb_cfg    = _notebook_config(notebook)
        walk_root = (nb_dir / nb_folders[notebook]) if nb_folders.get(notebook) else nb_dir
        for dirpath_s, dirnames, filenames in os.walk(walk_root):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith('.'))
            dirpath = Path(dirpath_s)
            for fname in sorted(filenames):
                fpath = dirpath / fname
                rel   = str(fpath.relative_to(nb_dir))
                selector = f'{notebook}:{rel}'
                r = _scan_file(fpath, selector, notebook, nb_cfg)
                if r:
                    results.append(r)
                    if len(results) >= limit:
                        return results, None

    return results, None


def _parse_fm_scope(qpart):
    """Parse fm query grammar into (notebooks, folders, filters) — scope tokens
    (bare notebook name, or 'notebook:folder/path/' with a required trailing
    slash) followed by field:value filters. Mirrors _frontParseQuery in
    nbweb-codeblocks.js; kept in sync by hand since one runs in the browser
    (building a fm codeblock's request) and this one runs server-side (the fm
    inline-query provider has no client-side parse step at all — main.js just
    forwards the raw query string to /api/inline-query)."""
    tokens = qpart.split()
    notebooks, folders = [], []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if ':' not in tok:
            notebooks.append(tok)
            folders.append('')
            i += 1
        elif tok.split(':', 1)[1].endswith('/'):
            nb, _, folder = tok.partition(':')
            notebooks.append(nb)
            folders.append(folder)
            i += 1
        else:
            break
    filter_part = ' '.join(tokens[i:])
    filters = []
    for m in re.finditer(r'(\w[\w.-]*):"([^"]*)"|(\w[\w.-]*):(\S*)', filter_part):
        if m.group(1) is not None:
            filters.append({'field': m.group(1), 'op': 'empty' if m.group(2) == '' else 'eq', 'value': m.group(2)})
        else:
            field, value = m.group(3), m.group(4)
            if value[:1] in ('>', '<'):
                filters.append({'field': field, 'op': value[0], 'value': value[1:]})
            else:
                filters.append({'field': field, 'op': 'exists' if value == '' else 'eq', 'value': value})
    return notebooks, folders, filters


@app.route('/api/front-query')
def api_front_query():
    """Return notes matching frontmatter field filters — backs the fm codeblock.

    notebooks: comma-separated notebook names; empty = search all notebooks.
    folders:   comma-separated folder paths, same order/length as notebooks;
               '' for a notebook with no folder scope (whole notebook, recursive).
    filters:   JSON array of {field, op, value} — op is 'eq'|'exists'|'empty'.
    """
    notebooks_raw = request.args.get('notebooks', '')
    folders_raw   = request.args.get('folders', '')
    limit         = int(request.args.get('limit', 200))
    filters_raw   = request.args.get('filters', '[]')
    user          = session.get('user', {})

    try:
        filters = json.loads(filters_raw)
    except Exception:
        return jsonify({'error': 'invalid filters'}), 400

    nb_list_in     = [n.strip() for n in notebooks_raw.split(',') if n.strip()] if notebooks_raw else []
    folder_list_in = folders_raw.split(',') if folders_raw else []
    results, err   = _run_front_query(user, nb_list_in, folder_list_in, filters, limit)
    if err:
        message, status = err
        return jsonify({'error': message}), status
    return jsonify(results)


@app.route('/api/config-tree')
def api_config_tree():
    """Return the config inheritance chain from root to a target notebook/folder.

    Query params:
      notebook  — target notebook name (required)
      folder    — path within notebook, e.g. 'shots' or 'storylines/film-school'
      key       — if given, only include this field in each node's 'contributes'

    Response: ordered array of nodes from global root → target, each:
      { level, path, selector, exists, contributes }

    'contributes' holds only what that config file itself sets — not inherited
    values.  Position in the array implies inheritance; consumers should not
    repeat inherited values in the UI.
    """
    notebook = request.args.get('notebook', '').strip()
    folder   = request.args.get('folder',   '').strip().strip('/')
    key      = request.args.get('key',      '').strip()
    selector = request.args.get('selector', '').strip()

    if not notebook or not _safe_notebook(notebook):
        return jsonify({'error': 'invalid notebook'}), 400

    user = session.get('user', {})
    nb_cfg = _notebook_config(notebook)
    required = str(nb_cfg.get('access') or 'user')
    if not _level_gte(user.get('level', ''), required):
        return jsonify({'error': 'forbidden'}), 403

    nb_root = NB_DIR / notebook

    def _read_contributes(cfg_path):
        """Parse a config file and return its own frontmatter (not merged)."""
        if not cfg_path.exists():
            return {}
        try:
            meta, _ = parse_frontmatter(cfg_path.read_text())
            return meta
        except Exception:
            return {}

    def _filter(meta):
        """Apply key filter if requested."""
        if not key or not meta:
            return meta
        v = meta.get(key)
        return {key: v} if v is not None else {}

    def _node(level, cfg_path):
        raw = _read_contributes(cfg_path)
        try:
            rel = cfg_path.relative_to(nb_root)
            sel = f"{notebook}:{rel}"
        except ValueError:
            sel = str(cfg_path)
        return {
            'level':       level,
            'path':        str(cfg_path),
            'selector':    sel,
            'exists':      cfg_path.exists(),
            'contributes': _filter(raw),
        }

    nodes = []

    # 1. Global — ~/.nb/.nb.md
    nodes.append(_node('global', NB_DIR / '.nb.md'))

    # 2. Notebook manifest — ~/.nb/{notebook}/.{notebook}.md
    nodes.append(_node('notebook', nb_root / f'.{notebook}.md'))

    # 3. Folder chain — each segment of the requested folder path
    if folder:
        parts = folder.split('/')
        current = nb_root
        for part in parts:
            current = current / part
            cfg_path = current / f'.{part}.md'
            level = 'subfolder' if current.parent != nb_root else 'folder'
            nodes.append(_node(level, cfg_path))

    # 4. Note — the note itself (highest priority; wins if it sets the key)
    if selector:
        note_path = None
        if selector.startswith('/'):
            # Absolute path selector — the `notebook` param's own access floor
            # checked above doesn't bound this; apply the same per-note rules
            # api_note's absolute-path branch does. See _can_access_abs_path.
            p = Path(selector)
            if _can_access_abs_path(user, p):
                try:
                    p.relative_to(NB_DIR)
                    note_path = p
                except ValueError:
                    pass
        else:
            note_path = _resolve_to_nb_path(selector)
        if note_path and note_path.exists():
            raw = _read_contributes(note_path)
            nodes.append({
                'level':       'note',
                'path':        str(note_path),
                'selector':    selector,
                'exists':      True,
                'contributes': _filter(raw),
            })

    return jsonify(nodes)


def _config_walk_notebook(notebook, attribute='', folder='', max_depth=0):
    """Walk one notebook's folder tree; return root node dict (with _active keys).

    max_depth: 0 = unlimited; N = stop after N levels (0=notebook root, 1=first folders…)
    """
    nb_root = NB_DIR / notebook
    root    = nb_root / folder if folder else nb_root

    def _cfg_meta(dir_path):
        name     = dir_path.name
        cfg_file = dir_path / f'.{name}.md'
        if cfg_file.exists():
            try:
                rel_cfg = cfg_file.relative_to(nb_root)
                cfg_sel = f"{notebook}:{rel_cfg}"
            except ValueError:
                cfg_sel = str(cfg_file)
            try:
                meta, _ = parse_frontmatter(cfg_file.read_text())
                return True, meta, cfg_sel
            except Exception:
                return True, {}, cfg_sel
        return False, {}, None

    def _walk(dir_path, rel, depth):
        has_cfg, meta, cfg_path = _cfg_meta(dir_path)
        has_attr = bool(attribute and meta.get(attribute) is not None)
        skipped  = bool(has_cfg and meta.get('cfg_skip'))
        children = []
        if not skipped and (not max_depth or depth < max_depth):
            try:
                entries = sorted(dir_path.iterdir(), key=lambda p: p.name)
            except PermissionError:
                entries = []
            for entry in entries:
                if entry.name.startswith('.'):
                    continue
                if entry.is_dir() and (entry / '.index').exists():
                    child_rel = f"{rel}/{entry.name}" if rel else entry.name
                    children.append(_walk(entry, child_rel, depth + 1))
        if attribute:
            children = [c for c in children if c.get('_active')]
        active = has_attr or any(c.get('_active') for c in children)
        contrib = {}
        if attribute and attribute in meta:
            contrib[attribute] = meta[attribute]
        elif not attribute:
            contrib = {k: v for k, v in meta.items() if not k.startswith('password')}
        level = 'notebook' if dir_path == nb_root else ('folder' if depth == 1 else 'subfolder')
        sel   = f"{notebook}:{rel}/" if rel else f"{notebook}:"
        return {
            'name':        dir_path.name,
            'notebook':    notebook,
            'rel_path':    rel,
            'selector':    sel,
            'cfg_path':    cfg_path,
            'level':       level,
            'has_config':  has_cfg,
            'skipped':     skipped,
            'contributes': contrib,
            'has_attr':    has_attr,
            '_active':     active,
            'children':    children,
        }

    tree = _walk(root, folder, 0 if not folder else folder.count('/') + 1)

    def _clean(node):
        node.pop('_active', None)
        for c in node.get('children', []):
            _clean(c)
    _clean(tree)
    return tree


@app.route('/api/config-tree-walk')
def api_config_tree_walk():
    """Walk a notebook's folder tree and return every config node found.

    Query params:
      notebook  — required
      attribute — optional key to filter; only nodes that set it are 'active',
                  others become dim pass-through nodes on the path between them
      folder    — optional subtree root (restricts walk to this folder and below)

    Each node:
      { name, notebook, rel_path, selector, level, has_config, contributes, children[] }

    level: 'notebook' | 'folder' | 'subfolder' | 'note'
    """
    notebook    = request.args.get('notebook',    '').strip()
    attribute   = request.args.get('attribute',   '').strip()
    folder      = request.args.get('folder',      '').strip().strip('/')
    with_global = request.args.get('with_global', '')
    max_depth   = int(request.args.get('max_depth', 0) or 0)

    if not notebook or not _safe_notebook(notebook):
        return jsonify({'error': 'invalid notebook'}), 400

    user = session.get('user', {})
    nb_cfg = _notebook_config(notebook)
    if not _level_gte(user.get('level', ''), str(nb_cfg.get('access') or 'user')):
        return jsonify({'error': 'forbidden'}), 403

    tree = _config_walk_notebook(notebook, attribute, folder, max_depth)

    # Optionally wrap with a global root node (.nb.md above the notebook)
    if with_global and not folder:
        global_cfg = NB_DIR / '.nb.md'
        g_exists   = global_cfg.exists()
        g_meta     = {}
        if g_exists:
            try:
                g_meta, _ = parse_frontmatter(global_cfg.read_text())
            except Exception:
                pass
        g_has_attr  = bool(attribute and g_meta.get(attribute) is not None)
        g_contrib   = {attribute: g_meta[attribute]} if (attribute and attribute in g_meta) \
                      else ({k: v for k, v in g_meta.items() if not k.startswith('password')} if not attribute else {})
        tree = {
            'name':        '.nb',
            'rel_path':    '',
            'selector':    '.nb:.nb.md',
            'cfg_path':    '.nb:.nb.md',
            'level':       'global',
            'has_config':  g_exists,
            'contributes': g_contrib,
            'has_attr':    g_has_attr,
            'children':    [tree],
        }

    return jsonify(tree)


@app.route('/api/config-global-walk')
def api_config_global_walk():
    """Walk ALL notebooks and return one composite config tree rooted at .nb.md.

    Admin-only. Used by cfg:org when rendered inside the global .nb.md dotfile.

    Query params:
      attribute — optional key to filter (same semantics as config-tree-walk)

    Returns the same node shape as config-tree-walk; root level='global',
    children are notebook-level nodes each carrying their own subtree.
    Each node includes a `notebook` field so the frontend knows which
    notebook owns it (needed for the ○ create-config click handler).
    """
    attribute = request.args.get('attribute', '').strip()
    max_depth = int(request.args.get('max_depth', 0) or 0)

    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), 'admin'):
        return jsonify({'error': 'forbidden'}), 403

    # Global root: .nb.md
    global_cfg = NB_DIR / '.nb.md'
    g_meta = {}
    if global_cfg.exists():
        try:
            g_meta, _ = parse_frontmatter(global_cfg.read_text())
        except Exception:
            pass
    g_contrib = ({attribute: g_meta[attribute]} if (attribute and attribute in g_meta)
                 else {k: v for k, v in g_meta.items() if not k.startswith('password')})

    # Walk every regular (non-dot) notebook the user can access
    nb_nodes = []
    for nb_dir in sorted(NB_DIR.iterdir()):
        if not nb_dir.is_dir() or nb_dir.name.startswith('.'):
            continue
        if not _safe_notebook(nb_dir.name):
            continue
        if not (nb_dir / '.git').exists() and not (nb_dir / '.index').exists():
            continue
        nb_cfg = _notebook_config(nb_dir.name)
        if not _level_gte(user.get('level', ''), str(nb_cfg.get('access') or 'user')):
            continue
        nb_nodes.append(_config_walk_notebook(nb_dir.name, attribute, max_depth=max_depth))

    root = {
        'name':        '.nb',
        'notebook':    '.nb',
        'rel_path':    '',
        'selector':    '.nb:.nb.md',
        'cfg_path':    '.nb:.nb.md',
        'level':       'global',
        'has_config':  global_cfg.exists(),
        'contributes': g_contrib,
        'has_attr':    bool(attribute and g_meta.get(attribute) is not None),
        'children':    nb_nodes,
    }
    return jsonify(root)


@app.route('/api/config-create', methods=['POST'])
def api_config_create():
    """Create a dotfile config at the requested level from the global template.

    Body: { notebook, folder? }
      folder — path within notebook (e.g. 'shots'); omit for notebook-level config

    Writes:
      folder  → ~/.nb/{notebook}/{folder}/.{leafname}.md
      notebook→ ~/.nb/{notebook}/.{notebook}.md

    Returns: { selector } — absolute path usable by /api/note
    """
    data     = request.get_json(force=True) or {}
    notebook = data.get('notebook', '').strip()
    folder   = data.get('folder',   '').strip().strip('/')

    if not notebook or not _safe_notebook(notebook):
        return jsonify({'error': 'invalid notebook'}), 400
    if notebook in DOTFOLDERS:
        # DOTFOLDERS (.checks, .templates, .rules, .users, etc.) are listed
        # alongside real notebooks in /api/notebooks for admin+ users, with
        # no visual distinction -- an easy, unintentional pick. They're
        # system config areas, never designed to carry a dashboard/dotfile
        # of their own the way a real notebook does. Found 2026-07-16: a
        # dashboard/dotfile accidentally created against .checks this way.
        return jsonify({'error': f'{notebook} is a system config folder, not a notebook -- '
                                  f'dashboards/dotfiles can\'t be created inside it'}), 400

    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), 'user'):
        return jsonify({'error': 'forbidden'}), 403

    nb_root = NB_DIR / notebook

    if folder:
        parts    = folder.split('/')
        leaf     = parts[-1]
        cfg_path = nb_root / folder / f'.{leaf}.md'
    else:
        leaf     = notebook
        cfg_path = nb_root / f'.{notebook}.md'

    try:
        cfg_sel = f"{notebook}:{cfg_path.relative_to(nb_root)}"
    except ValueError:
        cfg_sel = str(cfg_path)

    if cfg_path.exists():
        return jsonify({'selector': cfg_sel, 'created': False})

    # Load template
    tpl_path = NB_DIR / '.templates' / 'dotfile.md'
    if tpl_path.exists():
        tpl = tpl_path.read_text()
    else:
        tpl = '---\ntype: dotfile\ntitle: {{title}}\ndate: {{date}}\n---\n\n<!-- {{title}} — describe this folder here -->\n'

    folder_path = f"{notebook}/{folder}" if folder else notebook
    content = _resolve_template_vars(tpl, title=folder_path)
    content = (content
               .replace('{{folder}}',      leaf)
               .replace('{{notebook}}',    notebook)
               .replace('{{folder_path}}', folder_path))

    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(content)

    return jsonify({'selector': cfg_sel, 'created': True})


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
                'indicator': _indicator(itype, todo_status, fpath),
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

    # Read the current folder's own config for folder-level pinned: setting
    folder_pinned = ''
    if folder:
        leaf = folder.split('/')[-1]
        fcfg_path = folder_path / f'.{leaf}.md'
    else:
        fcfg_path = nb_path / f'.{notebook}.md'
    if fcfg_path.exists():
        try:
            fcfg_meta, _ = parse_frontmatter(fcfg_path.read_text())
            folder_pinned = str(fcfg_meta.get('pinned', '') or '').strip()
        except Exception:
            pass

    nb_tag_color = nb_meta.get('tag_color') or None

    items = []
    for pos, fname in enumerate(reversed(index)):   # newest first
        item_id = total - pos                        # ID: last entry = total
        if not fname:                                # blank line = gap in index
            continue
        fpath = folder_path / fname
        if not fpath.exists() or fname.startswith('.'):
            continue
        if fpath.is_dir():
            fcfg = fpath / f'.{fname}.md'
            fmeta = {}
            if fcfg.exists():
                try: fmeta, _ = parse_frontmatter(fcfg.read_text())
                except Exception: pass
            if not _can_access(user, fmeta, nb_meta):
                continue
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
        meta  = _merged_meta(str(fpath), meta)
        itype = _apply_meta_type(itype, meta)
        if not _can_access(user, meta, nb_meta):
            continue
        title = meta.get('title') or meta.get('name') or note_title(fname, body)
        excerpt = _first_excerpt_line(body, meta)
        todo_status = None
        if itype == 'todo':
            first = next((l.strip() for l in body.splitlines() if l.strip()), '')
            todo_status = 'closed' if first.startswith('# [x]') else 'open'
        sel_path = (folder + '/' if folder else '') + fname
        item = {
            'type':       itype,
            'indicator':  _indicator(itype, todo_status, fpath),
            'id':         item_id,
            'mtime':      fpath.stat().st_mtime,
            'filename':   fname,
            'title':      title,
            'selector':   f"{notebook}:{sel_path}",
            'excerpt':    excerpt,
            'updated':    '',
            'pinned':     str(meta.get('pinned', '')).strip().lower() == 'true' or bool(folder_pinned and fname in (folder_pinned, folder_pinned if folder_pinned.endswith('.md') else folder_pinned + '.md')),
            'status':     todo_status,
            'annotation': _read_annotation(str(fpath)),
        }
        if meta.get('claude_status'):
            item['claude_status'] = meta['claude_status']
        if meta.get('claude_context') is not None:
            try:
                item['claude_context'] = float(meta['claude_context'])
            except (TypeError, ValueError):
                pass
        tag_color_src = meta.get('tag_color') or nb_tag_color
        if tag_color_src:
            item['tag_color'] = tag_color_src
            fm_tags_raw = meta.get('tags', '')
            if isinstance(fm_tags_raw, list):
                fm_tags = [t.lstrip('#') for t in fm_tags_raw if t]
            else:
                fm_tags = [t.strip().lstrip('#')
                           for t in str(fm_tags_raw).split() if t.strip()]
            body_tags = re.findall(r'#([\w/-]+)', body)
            item['tags'] = list(dict.fromkeys(fm_tags + body_tags))
        items.append(item)
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
            'indicator':        _indicator(itype, todo_status, fpath),
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
            'indicator':        _indicator(itype, todo_status, fpath_r),
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
                    parent_fpath = NB_DIR / nb_name / parent_fname
                    try:
                        fmtime = parent_fpath.stat().st_mtime
                    except OSError:
                        fmtime = 0
                    items.append({
                        'selector':         sel,
                        'filename':         parent_fname,
                        'title':            note_title(parent_fname, ''),
                        'type':             itype,
                        'status':           None,
                        'indicator':        _indicator(itype, None, parent_fpath),
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

    # --- Supplemental: dotfile glob (nb search never indexes dotfiles) ---
    if query.startswith('.') and notebook and len(items) < limit:
        nb_root = NB_DIR / notebook
        if nb_root.is_dir():
            # Accept bare stem (.shots) or explicit name (.shots.md)
            patterns = [query + '.md', query] if '.' not in query[1:] else [query]
            for pat in patterns:
                for dotfile in sorted(nb_root.rglob(pat)):
                    if len(items) >= limit:
                        break
                    rel = str(dotfile.relative_to(nb_root))
                    sel = f"{notebook}:{rel}"
                    if sel in seen_sels:
                        continue
                    seen_sels.add(sel)
                    try:
                        raw_f = dotfile.read_text(errors='replace')
                        meta_f, body_f = parse_frontmatter(raw_f)
                        dtitle  = meta_f.get('title') or note_title(dotfile.name, body_f)
                        excerpt = next((ln.strip()[:120] for ln in body_f.splitlines()
                                        if ln.strip() and not _RE_HEADING.match(ln.strip())), '')
                        itype   = _apply_meta_type(classify(dotfile.name, notebook), meta_f)
                        fmtime  = dotfile.stat().st_mtime
                    except Exception:
                        dtitle, excerpt, itype, fmtime = dotfile.name, '', 'note', 0
                    items.append({
                        'selector':         sel,
                        'filename':         dotfile.name,
                        'title':            dtitle,
                        'type':             itype,
                        'status':           None,
                        'indicator':        _indicator(itype, None, dotfile),
                        'mtime':            fmtime,
                        'excerpt':          excerpt,
                        'notebook':         notebook,
                        'updated':          '',
                        'pinned':           False,
                        'annotation_match': False,
                        'annotation':       None,
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

    note_notebook = None
    note_id       = None
    fpath         = None

    # Special case: .nb:.nb.md → global config file (canonical selector)
    _global_md = NB_DIR / '.nb.md'
    if selector == '.nb:.nb.md':
        user = session.get('user', {})
        if not _level_gte(user.get('level', ''), 'admin'):
            return jsonify({'error': 'forbidden'}), 403
        if not _global_md.exists():
            return jsonify({'error': 'not found'}), 404
        fpath         = str(_global_md)
        note_notebook = '.nb'

    if fpath is None:
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
        # Absolute path selector — same access rules a notebook:file selector
        # for this file would get (regular note → _can_access; dotfolder →
        # admin; outside NB_DIR entirely, e.g. sysadmin config_files links
        # that live at NB_DIR root → tech). See _resolve_abs_selector.
        elif selector.startswith('/'):
            user = session.get('user', {})
            if not _can_access_abs_path(user, Path(selector)):
                return jsonify({'error': 'forbidden'}), 403
            fpath = selector
            if not Path(fpath).exists():
                return jsonify({'error': 'not found'}), 404
        else:
            # Resolve selector to a real path first (handles both filename and id selectors)
            path_r = run_nb('show', selector, '--path')
            if not nb_ok(path_r):
                # Fallback: direct filesystem lookup for dotfiles not indexed by nb.
                # Handles Takeout:.Takeout.md, Takeout:shots/.shots.md, etc.
                if ':' in selector:
                    _nb, _, _rel = selector.partition(':')
                    try:
                        _p = (NB_DIR / _nb / _rel).resolve()
                        _p.relative_to(NB_DIR)  # must stay within NB_DIR
                        if _p.is_file():
                            fpath = str(_p)
                        else:
                            return jsonify({'error': 'not found'}), 404
                    except (ValueError, OSError):
                        return jsonify({'error': 'not found'}), 404
                else:
                    return jsonify({'error': 'not found'}), 404
            else:
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
        bin_meta  = _merged_meta(fpath, {})
        bin_itype = _apply_meta_type(itype, bin_meta)
        bin_title = bin_meta.get('title') or bin_meta.get('name') or note_title(filename, '')
        return jsonify({
            'selector': selector, 'notebook': note_notebook or '',
            'id': note_id, 'filename': filename,
            'title': bin_title,
            'type': bin_itype, 'binary': True,
            'raw': '', 'body': '', 'tags': [], 'meta': bin_meta,
            'annotation': annotation_text,
            'path': fpath,
        })

    try:
        raw = Path(fpath).read_text(errors='replace')
    except OSError:
        return jsonify({'error': 'could not read file'}), 404

    meta, body = parse_frontmatter(raw)
    meta  = _merged_meta(fpath, meta)
    itype = _apply_meta_type(itype, meta)

    full_meta = _folder_config(note_notebook, fpath) if note_notebook else {}
    nb_meta   = full_meta  # includes global → notebook → folder walk-up
    user = session.get('user', {})
    if not _can_access(user, meta, nb_meta):
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

    parent_meta = {}
    parent_meta_sources = {}

    return jsonify({
        'selector': selector,
        'notebook': note_notebook or '',
        'id':       note_id,
        'filename': filename,
        'title':    title,
        'type':     itype,
        'status':   todo_status,
        'indicator': _indicator(itype, todo_status, fpath),
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
        'effective_access': _effective_access(meta, nb_meta),
        'effective_claude': _effective_claude(meta, nb_meta),
        'effective_checks':     nb_meta.get('check') if nb_meta.get('check') is not None else nb_meta.get('checks'),
        'effective_check_add':  _collect_check_add(note_notebook, fpath) if note_notebook else '',
        'effective_check_skip': _collect_check_skip(note_notebook, fpath) if note_notebook else '',
        'effective_xref':    (nb_meta['xref'] or '') if 'xref' in nb_meta else None,
        'effective_fm':      {k: nb_meta[k] for k in _FM_BLOCK_KEYS if k in nb_meta and k not in meta},
        'effective_ui_hide': _effective_ui_hide(meta, nb_meta),
        'parent_meta': parent_meta,
        'parent_meta_sources': parent_meta_sources,
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
    if not ap.exists():
        return None
    raw = ap.read_text(errors='replace').strip()
    return raw or None  # None = no sidecar / completely empty file

def _merged_meta(note_path: str, note_meta: dict) -> dict:
    """Return effective meta: annotation FM as base, note FM wins on collision.

    For files that cannot carry frontmatter (images, binaries, .journal, etc.)
    the annotation sidecar FM is the sole metadata source. For .md notes the
    note's own FM takes precedence; the annotation fills any gaps.
    """
    ap = _annotation_path(note_path)
    if not ap.exists():
        return note_meta
    try:
        ann_meta, _ = parse_frontmatter(ap.read_text(errors='replace'))
    except Exception:
        return note_meta
    if not ann_meta:
        return note_meta
    return {**ann_meta, **note_meta}  # note_meta keys win

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


def _rebuild_dir_indexes(root: Path):
    """Write .index files throughout root from filesystem state (tmp+rename to avoid inode glitch)."""
    for dirpath, dirnames, filenames in os.walk(root):
        dp = Path(dirpath)
        dirnames[:] = sorted(d for d in dirnames if not d.startswith('.'))
        children = list(dirnames) + sorted(f for f in filenames if not f.startswith('.'))
        content = '\n'.join(children) + '\n' if children else ''
        tmp = dp / '.index.tmp'
        tmp.write_text(content)
        tmp.rename(dp / '.index')


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


def _normalize_constraint(val) -> str:
    """Normalise a constraint value to the string format expected by the JS widget renderer.

    Accepts:
      Legacy strings:  'select a,b,c' | 'bool' | 'area' | 'date' | 'text'
      Inheritance ref: 'scene.loc' — dot-notation reference to a parent note field;
                       passed through as-is; JS and nb-constraints.sh handle it
      Rich dicts:      {widget: select, values: [...]}  or  {type: enum, values: [...]}
                       {type: multiline}  →  'area'
                       {type: integer|string}  →  'text'
    """
    if isinstance(val, str):
        return val.strip()   # 'scene.loc', 'select D,N', 'bool' — all pass through
    if isinstance(val, dict):
        widget = str(val.get('widget') or val.get('type') or 'text').strip()
        if widget in ('select', 'enum'):
            values = val.get('values', [])
            return 'select ' + ','.join(str(v) for v in values)
        if widget == 'multiline':
            return 'area'
        if widget in ('integer', 'string'):
            return 'text'
        return widget   # 'bool', 'date', 'area', 'text' pass through
    return 'text'


def _load_constraints(note_path: Path) -> dict:
    """Return constraint map for a note, normalised to JS widget string format.

    Two sources, merged in priority order (higher priority wins):
      1. Legacy .constraints.md files — walk from notebook root down to note folder
      2. constraints: section in folder config (.{foldername}.md) — via _folder_config()

    This allows gradual migration: add constraints: to folder configs and they
    automatically override the corresponding .constraints.md entries.
    Constraint values are always returned as strings (e.g. 'select a,b,c', 'bool').
    """
    # ── Step 1: legacy .constraints.md walk-up (lower priority) ──────────────
    dirs = []
    p = note_path.parent
    while True:
        dirs.append(p)
        try:
            rel = p.relative_to(NB_DIR)
            if len(rel.parts) <= 1:
                break
        except ValueError:
            break
        p = p.parent

    merged = {}
    for d in reversed(dirs):   # root → folder; deeper entries win
        cf = d / '.constraints.md'
        if not cf.exists():
            continue
        try:
            meta, _ = parse_frontmatter(cf.read_text(errors='replace'))
            merged.update({k: str(v) for k, v in meta.items() if k and v is not None})
        except Exception:
            pass

    # ── Step 2: folder config constraints: section (higher priority) ─────────
    try:
        notebook = note_path.relative_to(NB_DIR).parts[0]
        cfg = _folder_config(notebook, note_path)
        for k, v in (cfg.get('constraints') or {}).items():
            if v is not None:
                merged[k] = _normalize_constraint(v)
    except Exception:
        pass

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


@app.route('/api/note/constraints-full')
def api_note_constraints_full():
    """Constraints from a note's own folder's .{foldername}.md, normalized to
    the same widget-type string /api/note/constraints already produces (reuses
    _normalize_constraint -- same select/area/bool/date/text handling, so this
    can't drift from what the Frontmatter Changes panel renders), but paired
    with required: alongside each one instead of dropping it. Consumers that
    need more than widget typing -- e.g. a fill-in-all-fields modal that has
    to know which fields are required to show even when blank -- use this;
    /api/note/constraints (unchanged) still serves the existing FM panel.

    Deliberately reads only the immediate folder's own dotfile, not the full
    cascade _folder_config/_load_constraints merge -- constraints: is
    dict-valued and merges key-by-key across levels, which pulled in
    unrelated inherited fields (a service-pack client:/billing_type: schema)
    when tried against _folder_config. A folder-specific schema like
    items/.items.md should show exactly what it declares, nothing inherited.
    """
    selector = request.args.get('selector', '').strip()
    if not selector:
        return jsonify({'error': 'selector required'}), 400
    if selector.startswith('/'):
        # Absolute path selector — same per-note rules api_note's own
        # absolute-path branch applies (this mirrors it deliberately, so it
        # needs the same access check, not a blanket floor). See
        # _can_access_abs_path.
        user = session.get('user', {})
        if not _can_access_abs_path(user, Path(selector)):
            return jsonify({'error': 'forbidden'}), 403
        fpath = Path(selector)
        if not fpath.exists():
            return jsonify({'error': 'not found'}), 404
    else:
        path_r = run_nb('show', selector, '--path')
        if not nb_ok(path_r):
            return jsonify({'error': 'not found'}), 404
        fpath = Path(path_r['stdout'].strip())
    folder_cfg_path = fpath.parent / f'.{fpath.parent.name}.md'
    if not folder_cfg_path.exists():
        return jsonify({})
    try:
        meta, _ = parse_frontmatter(folder_cfg_path.read_text(errors='replace'))
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    raw = meta.get('constraints') or {}
    result = {}
    for k, v in raw.items():
        required = bool(v.get('required')) if isinstance(v, dict) else False
        result[k] = {'widget': _normalize_constraint(v), 'required': required}
    return jsonify(result)


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

    user = session.get('user', {})
    if _is_dot_notebook(notebook):
        if not _level_gte(user.get('level', ''), 'admin'):
            return jsonify({'error': 'forbidden'}), 403
        filename = re.sub(r'[^\w\-.]', '_', title or 'note').strip('_') + '.md'
        fpath = NB_DIR / notebook / filename
        try:
            fpath.write_text(content or '')
        except OSError as e:
            return jsonify({'error': str(e)}), 500
        return jsonify({'success': True, 'selector': f'{notebook}:{filename}'})

    if not _can_write(user, None, notebook=notebook):
        return jsonify({'error': 'forbidden'}), 403

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
        # target already carries notebook + folder (see above) — pass it
        # ahead of 'todo add' the same way note/bookmark/folder do, so the
        # todo lands in the current folder instead of at notebook root.
        args = [target, 'todo', 'add', title or 'New todo']
        if tags:  args += ['--tags', ','.join(tags)]
        r = run_nb(*args)
    elif ntype == 'folder':
        folder_name = (title or 'newfolder').strip().strip('/')
        r = run_nb('folders', 'add', target + folder_name)
    elif ntype == 'notebook':
        user = session.get('user', {})
        if not _level_gte(user.get('level', ''), 'admin'):
            return jsonify({'error': 'forbidden'}), 403
        nb_name = re.sub(r'[^\w\-]', '_', (title or 'notebook').strip()).strip('_')
        r = run_nb('notebooks', 'add', nb_name)
        if nb_ok(r):
            nb_root = NB_DIR / nb_name
            env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
            seed_files = []
            index_path = nb_root / '.index'
            for tpl_name, fname in [
                ('dashboard.md', f'{nb_name}.md'),
                ('dotfile.md',   f'.{nb_name}.md'),
            ]:
                tpl_path = NB_DIR / '.templates' / tpl_name
                if tpl_path.exists():
                    seeded = _resolve_template_vars(
                        tpl_path.read_text(errors='replace'), title=nb_name)
                    (nb_root / fname).write_text(seeded)
                    with open(index_path, 'a') as f:
                        f.write(fname + '\n')
                    seed_files.append(fname)
            if seed_files:
                subprocess.run(['git', 'add', '.index'] + seed_files,
                               cwd=str(nb_root), capture_output=True, env=env)
                subprocess.run(['git', 'commit', '-m', f'[nb] Seed: {", ".join(seed_files)}'],
                               cwd=str(nb_root), capture_output=True, env=env)
            return jsonify({'success': True, 'output': strip_ansi(r['stdout']),
                            'selector': f'{nb_name}:{nb_name}.md'})
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

        # Read prepend_date from config chain (notebook → folder)
        _cfg = _notebook_config(notebook)
        if folder:
            _leaf = folder.split('/')[-1]
            _fcfg_path = NB_DIR / notebook / folder / f'.{_leaf}.md'
            if _fcfg_path.exists():
                try:
                    _fcfg_meta, _ = parse_frontmatter(_fcfg_path.read_text())
                    _cfg = _merge_configs(_cfg, _fcfg_meta)
                except Exception:
                    pass
        _pd = _cfg.get('prepend_date', True)
        prepend_date = str(_pd).lower() not in ('false', '0', 'no', 'off')

        explicit_filename = data.get('filename', '').strip()
        if explicit_filename:
            # Caller supplies exact filename (e.g. cine Ctrl+[ shot creation)
            if not explicit_filename.endswith('.md'):
                explicit_filename += '.md'
            note_filename = explicit_filename
        else:
            slug = re.sub(r'[^\w]+', '_', title or 'note').strip('_').lower()
            # Detect dotfile templates: type: dotfile in FM → prepend '.' to filename
            dot_prefix = ''
            if note_content.lstrip().startswith('---'):
                try:
                    _tpl_meta, _ = parse_frontmatter(note_content)
                    if _tpl_meta.get('type') == 'dotfile':
                        dot_prefix = '.'
                except Exception:
                    pass
            # Timestamp prefix for casual root-level notes; suppressed by config,
            # folder context, or template (template = structured, needs stable URL).
            if folder or using_template or not prepend_date:
                if dot_prefix:
                    # Dotfile convention: .{ScopeName}.md — case-preserved from scope
                    scope_name = folder.split('/')[-1] if folder else notebook
                    note_filename = f'.{scope_name}.md'
                else:
                    note_filename = f"{slug}.md"
            else:
                note_filename = f"{datetime.now().strftime('%Y%m%d%H%M%S')}_{slug}.md"

        # When content starts with YAML frontmatter, nb CLI's --content corrupts
        # it (strips <a href= tags, reorders blocks). Write directly to disk instead.
        if note_content.lstrip().startswith('---'):
            nb_root = NB_DIR / notebook
            note_dir = nb_root / folder if folder else nb_root
            note_dir.mkdir(parents=True, exist_ok=True)
            note_path = note_dir / note_filename
            if note_path.exists():
                return jsonify({'error': f'A note named {note_filename!r} already exists in this location'}), 409
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

    user = session.get('user', {})

    # Special case: .nb:.nb.md → global config file (mirrors api_note GET handling)
    if selector == '.nb:.nb.md':
        if not _level_gte(user.get('level', ''), 'admin'):
            return jsonify({'error': 'forbidden'}), 403
        selector = str(NB_DIR / '.nb.md')

    # Resolve dotfolder selectors to absolute paths so the existing path-write code handles them
    dot_path = _dot_selector_to_path(selector)
    if dot_path is not None:
        if not _level_gte(user.get('level', ''), 'admin'):
            return jsonify({'error': 'forbidden'}), 403
        selector = str(dot_path)
    elif selector.startswith('/'):
        # Absolute path selector — same access rules the GET side (api_note)
        # now applies via _can_access_abs_path, at the 'write' floor. Without
        # this, any authenticated user could overwrite an existing file
        # anywhere the process can write, e.g. their own .users/<username>.md
        # (privilege escalation) or a .checks/*.sh script, regardless of
        # whose notebook it actually belongs to.
        if not _can_access_abs_path(user, Path(selector), write=True):
            return jsonify({'error': 'forbidden'}), 403
    else:
        # Regular note — enforce per-note access
        if not _can_write(user, selector):
            return jsonify({'error': 'forbidden'}), 403

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

    regen_cache_rel = _maybe_auto_regen_org_source(note_path, nb_root)

    env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
    rel = note_path.relative_to(nb_root)
    subprocess.run(['git', 'add', str(rel)], cwd=str(nb_root),
                   capture_output=True, env=env)
    if regen_cache_rel:
        subprocess.run(['git', 'add', regen_cache_rel], cwd=str(nb_root),
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
    decrypted, err = _decrypt_note_payload(fpath.read_bytes(), password)
    if err:
        return jsonify({'error': 'wrong password'}), 401
    return jsonify({'content': decrypted.decode('utf-8', errors='replace')})


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
        encrypted, enc_err = _encrypt_payload(content.encode('utf-8'), password)
        if enc_err:
            return jsonify({'error': 'encryption failed', 'detail': enc_err}), 500
        tmp.write_bytes(encrypted)
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

    # Filename must not reveal the title — the whole point of encrypting the
    # note is that its subject isn't disclosed. Use an opaque timestamp +
    # random suffix rather than a slug of the title (which used to leak into
    # git history, .index, and every file listing even though the body was
    # encrypted).
    dated_filename = f"{datetime.now().strftime('%Y%m%d%H%M%S')}_{secrets.token_hex(3)}.md.enc"
    fpath = note_dir / dated_filename
    tmp   = Path(tempfile.mktemp(suffix='.enc.tmp', dir=str(note_dir)))
    try:
        encrypted, enc_err = _encrypt_payload(note_text.encode('utf-8'), password)
        if enc_err:
            return jsonify({'error': 'encryption failed', 'detail': enc_err}), 500
        tmp.write_bytes(encrypted)
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
    user = session.get('user', {})
    dot_path = _dot_selector_to_path(selector)
    if dot_path is not None:
        if not _level_gte(user.get('level', ''), 'admin'):
            return jsonify({'error': 'forbidden'}), 403
        try:
            dot_path.unlink()
            return jsonify({'success': True, 'stderr': ''})
        except OSError as e:
            return jsonify({'error': str(e)}), 500
    if not _can_write(user, selector):
        return jsonify({'error': 'forbidden'}), 403
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
    user = session.get('user', {})
    if not _can_write(user, selector):
        return jsonify({'error': 'forbidden'}), 403
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
        default_remote = (_effective_setting('default_git_remote') or '').strip()
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


def _git_run_killable(args, cwd, timeout, env):
    """subprocess.run-alike for git pull/push specifically: on timeout, kills
    the whole process group, not just the immediate `git` PID.

    subprocess.run(..., timeout=N) only ever kills the direct child -- but
    `git push`/`pull` over SSH spawns `ssh` as ITS OWN child to handle the
    network transport, and a hung/slow connection means the timeout fires on
    `git` while `ssh` is orphaned and keeps running, invisible to the caller.
    Found live, 2026-07-19: a single Codeberg SSH hiccup (rare but real --
    the same class of transient network blip that also briefly failed one
    manual `git push` earlier tonight) turned a normal notebook sync into a
    30s hang, and the gunicorn *worker itself* crashed (SIGPIPE) shortly
    after -- most plausibly the orphaned `ssh` eventually writing to a pipe
    Python had already closed. `start_new_session=True` makes the child (and
    anything it spawns) its own process group, so `os.killpg` on timeout
    actually reaches `ssh` too, not just `git`.
    """
    proc = subprocess.Popen(args, cwd=cwd, env=env, start_new_session=True,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
        return subprocess.CompletedProcess(args, proc.returncode, stdout, stderr)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.communicate()  # reap, avoid a zombie
        raise


def _sync_one_notebook(notebook, message=''):
    """Core sync logic for one notebook: commit optional message, pull, push,
    verify. Returns (success, no_remote, output_str). Factored out of
    api_sync so /api/sync's notebook='_all' path (and anything else that
    wants to sync a notebook programmatically) can reuse it directly rather
    than looping HTTP calls back into the same process."""
    nb_path = NB_DIR / notebook
    if not nb_path.is_dir() or not (nb_path / '.git').exists():
        return False, False, f'Notebook "{notebook}" not found.'

    git_env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0',
               'GIT_ASKPASS': '/bin/true', 'NO_COLOR': '1', 'GIT_PAGER': 'cat'}

    remote_r = subprocess.run(['git', 'remote'], capture_output=True, text=True,
                              cwd=str(nb_path), timeout=5, env=git_env)
    if not remote_r.stdout.strip():
        return False, True, (
            f'No remote configured for notebook "{notebook}".\n\n'
            f'Notes are committed locally — nothing is lost.\n\n'
            f'To push to a remote, go to Settings → Git and run git-wire,\n'
            f'or run:  nb {notebook}:remote set <git-url>'
        )

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
        pull_r = _git_run_killable(
            ['git', 'pull', '--no-rebase', '--no-edit', 'origin', notebook],
            cwd=str(nb_path), timeout=30, env=git_env,
        )
    except subprocess.TimeoutExpired:
        lines.append('Pull timed out after 30s')
        return False, False, '\n'.join(lines)

    if pull_r.returncode != 0:
        pull_combined = pull_r.stderr + pull_r.stdout
        if 'refusing to merge unrelated histories' in pull_combined:
            # Orphan remote branch — local is authoritative, force push
            lines.append(
                f'Remote branch "{notebook}" has unrelated history — '
                f'force-pushing local commits (local is authoritative).'
            )
            try:
                fp_r = _git_run_killable(
                    ['git', 'push', '--force', 'origin', f'HEAD:{notebook}'],
                    cwd=str(nb_path), timeout=30, env=git_env,
                )
                git_push_ok = fp_r.returncode == 0
                msg = fp_r.stderr.strip() or fp_r.stdout.strip() or f'Force-pushed to origin/{notebook}'
                lines.append(msg if git_push_ok else f'Force-push failed: {msg}')
            except subprocess.TimeoutExpired:
                lines.append('Force-push timed out after 30s')
        else:
            lines.append(f'Pull failed: {pull_r.stderr.strip() or pull_r.stdout.strip()}')
        return git_push_ok, False, '\n'.join(lines)

    pull_msg = pull_r.stdout.strip() or pull_r.stderr.strip()
    if pull_msg and pull_msg != 'Already up to date.':
        lines.append(pull_msg)

    # Push
    try:
        push_r = _git_run_killable(
            ['git', 'push', 'origin', f'HEAD:{notebook}'],
            cwd=str(nb_path), timeout=30, env=git_env,
        )
    except subprocess.TimeoutExpired:
        lines.append('Push timed out after 30s')
        return False, False, '\n'.join(lines)

    if push_r.returncode == 0:
        git_push_ok = True
        lines.append(push_r.stderr.strip() or push_r.stdout.strip() or f'Pushed to origin/{notebook}')
    else:
        lines.append(f'Push failed: {push_r.stderr.strip()}')
        return False, False, '\n'.join(lines)

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

    return git_push_ok, False, '\n'.join(lines)


@app.route('/api/sync', methods=['POST'])
def api_sync():
    """Sync one notebook, or every notebook (notebook='_all') — commit
    optional message, pull, push, verify per notebook via explicit git."""
    data     = request.get_json() or {}
    notebook = data.get('notebook', '').strip()
    message  = data.get('message', '').strip()

    if not notebook:
        return jsonify({'success': False, 'output': 'Specify a notebook to sync.'})

    if notebook == '_all':
        results = []
        for entry in sorted(NB_DIR.iterdir()):
            if not entry.is_dir() or entry.name.startswith('.') or not (entry / '.git').exists():
                continue
            nb_name = entry.name
            try:
                _check_notebook(nb_name)
            except ValueError:
                continue  # not a real notebook (scope-restricted or otherwise invalid) — skip silently
            ok, no_remote, output = _sync_one_notebook(nb_name, message='')
            if no_remote:
                continue  # no remote configured — not a failure, just nothing to sync
            results.append({'notebook': nb_name, 'success': ok, 'output': output})
        all_ok = all(r['success'] for r in results) if results else True
        return jsonify({'success': all_ok, 'results': results})

    try:
        _check_notebook(notebook)
    except ValueError as e:
        return jsonify({'success': False, 'output': str(e)}), 400

    ok, no_remote, output = _sync_one_notebook(notebook, message)
    return jsonify({'success': ok, 'no_remote': no_remote, 'output': output})


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
    user = session.get('user') or {}
    if not _level_gte(user.get('level', ''), 'admin'):
        return jsonify({'error': 'forbidden'}), 403

    default_remote = (_effective_setting('default_git_remote') or '').strip()
    if not default_remote:
        return jsonify({'error': 'No default_git_remote set. Add it in Settings → Git or .nb.md.'})

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
        # This endpoint has no per-notebook target -- it sweeps every
        # un-remoted notebook on the instance to a single shared
        # default_git_remote, so unlike the single-notebook siblings there's
        # no `notebook` request key for _notebook_scope_check to ever see
        # (it fails open for this whole endpoint). Filter here instead: an
        # admin-but-not-tech account shouldn't bulk-push a notebook it
        # couldn't itself open.
        if not _can_access(user, {}, _notebook_config(name)):
            results.append({'notebook': name, 'status': 'skip', 'message': 'access-restricted'})
            continue
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


_RE_GIT_REMOTE_URL = re.compile(
    r'^(https://[\w.\-]+(?::\d+)?/[\w.\-~]+(?:/[\w.\-~]+)*|'   # https://host[:port]/path
    r'ssh://[\w.\-]+@[\w.\-]+(?::\d+)?/[\w.\-~]+(?:/[\w.\-~]+)*|'  # ssh://user@host[:port]/path
    r'[\w.\-]+@[\w.\-]+:[\w.\-~/]+)$'                          # scp-like git@host:path
)

def _valid_git_remote_url(url: str) -> bool:
    """Reject anything but plain https://, ssh://, or scp-like (user@host:path) forms.

    Blocks git transport-helper schemes (ext::, file://, etc.) that would let a
    supplied remote_url run an arbitrary command as the transport for `git push`.
    """
    return bool(_RE_GIT_REMOTE_URL.match(url))


@app.route('/api/nb/wire-notebook', methods=['POST'])
def api_nb_wire_notebook():
    """Connect a single notebook to a remote: add origin, set tracking, push."""
    user = session.get('user') or {}
    if not _level_gte(user.get('level', ''), 'admin'):
        return jsonify({'success': False, 'output': 'Forbidden — admin access required.'}), 403

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

    default_remote = (_effective_setting('default_git_remote') or '').strip()

    # Below 'tech', remote_url is a fixed use-the-configured-default-only
    # contract, not a free-text field -- a supplied value that doesn't match
    # is rejected outright rather than silently swapped for the default,
    # since accepting an arbitrary URL here means `git push` (full history,
    # ignores nb-web's own access: locks) to wherever the caller names.
    if (remote_url and remote_url != default_remote
            and not _level_gte(user.get('level', ''), 'tech')):
        return jsonify({'success': False,
                        'output': 'Only the configured default remote is allowed for your account level.'}), 403

    if not remote_url:
        remote_url = default_remote
    if not remote_url:
        return jsonify({'success': False,
                        'output': 'No remote URL provided and no default_git_remote set in Settings → Git or .nb.md.'})

    if not _valid_git_remote_url(remote_url):
        return jsonify({'success': False,
                        'output': 'Remote URL rejected — only https://, ssh://, or git@host:path forms are allowed.'}), 400

    git_env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_ASKPASS': '/bin/true',
               'NO_COLOR': '1', 'GIT_PAGER': 'cat', 'GIT_PROTOCOL_FROM_USER': '0'}
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
    user = session.get('user') or {}
    if not _level_gte(user.get('level', ''), 'admin'):
        return jsonify({'success': False, 'output': 'Forbidden — admin access required.'}), 403

    data       = request.get_json() or {}
    notebook   = data.get('notebook', '').strip()
    visibility = data.get('visibility', 'private')

    if not notebook:
        return jsonify({'success': False, 'output': 'Notebook name required.'})
    try:
        _check_notebook(notebook)
    except ValueError as e:
        return jsonify({'success': False, 'output': str(e)}), 400

    if not _can_access(user, {}, _notebook_config(notebook)):
        return jsonify({'success': False, 'output': f'Notebook "{notebook}" is access-restricted.'}), 403

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
    user = session.get('user') or {}
    if not _level_gte(user.get('level', ''), 'admin'):
        return jsonify({'success': False, 'output': 'Forbidden — admin access required.'}), 403

    data     = request.get_json() or {}
    notebook = data.get('notebook', '').strip()
    scope    = data.get('scope', '').strip()  # 'local' or 'remote'

    if not notebook or scope not in ('local', 'remote'):
        return jsonify({'success': False, 'output': 'notebook and scope (local|remote) required.'})
    try:
        _check_notebook(notebook)
    except ValueError as e:
        return jsonify({'success': False, 'output': str(e)}), 400

    # An admin-but-not-tech account can be 'admin' level yet still be locked
    # out of this specific notebook by its own access: config (username lock,
    # or an access: level this account doesn't meet) -- the level gate above
    # only says "admin enough to delete *some* notebook," not this one.
    if not _can_access(user, {}, _notebook_config(notebook)):
        return jsonify({'success': False, 'output': f'Notebook "{notebook}" is access-restricted.'}), 403

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


def _decrypt_note_payload(data: bytes, password: str) -> tuple:
    """Decrypt a per-note .md.enc payload. Tries the current -pbkdf2 scheme
    first (same as archive encryption, see _encrypt_payload), then falls
    back to the legacy -md sha256 / -md md5 schemes used by notes encrypted
    before the KDF unification (2026-07-14) so old notes stay readable.
    Returns (decrypted_bytes, None) or (None, error)."""
    decrypted, err = _decrypt_payload(data, password)
    if not err:
        return decrypted, None
    for md in ('sha256', 'md5'):
        proc = subprocess.run(
            ['openssl', 'enc', '-d', '-aes-256-cbc', '-md', md, '-pass', f'pass:{password}'],
            input=data, capture_output=True, timeout=10,
        )
        if proc.returncode == 0:
            return proc.stdout, None
    return None, 'Wrong password or corrupted note.'


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


@app.route('/api/nb/archive', methods=['POST'])
def api_nb_archive():
    """Create a .nbz notebook archive (notebook content only) and stream it as a download.

    Earlier versions could also bundle plugin JS / check scripts / global templates
    into the archive as an install-time payload. Removed 2026-07-29: those bundles
    were never scoped to the requester and doubled as an executable-file delivery
    path via the matching import options (see the isolation-hardening design doc).
    An archive is notebook content, nothing else.
    """
    user = session.get('user') or {}
    if not _level_gte(user.get('level', ''), 'user'):
        return jsonify({'ok': False, 'error': 'forbidden'}), 403

    data              = request.get_json() or {}
    notebook          = data.get('notebook', '').strip()
    includes_git      = bool(data.get('includes_git', False))
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

    meta = {
        'format':            2,
        'name':              notebook,
        'archived_at':       datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        'nb_version':        nb_version,
        'note_count':        note_count,
        'includes_git':      includes_git,
        'encrypted':         bool(password),
        'description':       description,
    }

    date_str = datetime.now().strftime('%Y%m%d')
    filename  = f'{notebook.replace(" ", "-")}-{date_str}.nbz'
    skipped   = []
    nb_meta   = _notebook_config(notebook)

    def _add_notebook_files(zf, skipped):
        # Per-file _can_access check -- a whole-notebook archive previously
        # bypassed individual note access: locks entirely (only OS-housekeeping
        # names were filtered), so any account cleared to archive the notebook
        # at all got every note inside it, including ones locked to a single
        # other username that same account couldn't even open in the UI.
        # .md files carry their own frontmatter (checked against it directly,
        # falling back through _effective_access's own chain to the notebook's
        # access: default); non-.md files (attachments, etc.) have no
        # frontmatter of their own, so they're checked against the notebook
        # default only ({} note_meta).
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
                note_meta = {}
                if fname.endswith('.md'):
                    try:
                        note_meta, _ = parse_frontmatter(fpath.read_text(errors='replace'))
                    except Exception:
                        note_meta = {}
                if not _can_access(user, note_meta, nb_meta):
                    skipped.append(str(rel)); continue
                try:
                    if fpath.stat().st_size > max_bytes:
                        skipped.append(str(rel)); continue
                    zf.write(str(fpath), f'{notebook}/{rel}')
                except Exception:
                    skipped.append(str(rel))

    out_buf = io.BytesIO()
    if password:
        # Encrypted format: only the notebook notes are private.
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
    else:
        with zipfile.ZipFile(out_buf, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            zf.writestr(f'{notebook}/.nb_archive', json.dumps(meta, indent=2))
            _add_notebook_files(zf, skipped)

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
    """Read .nb_archive metadata from a .nbz upload without extracting."""
    f = request.files.get('archive')
    if not f:
        return jsonify({'ok': False, 'error': 'No file provided.'}), 400
    try:
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

            return jsonify({
                'ok':        True,
                'meta':      meta,
                'notebook':  notebook,
                'conflict':  conflict,
                'suggested': (notebook + '-import') if conflict else notebook,
            })
    except zipfile.BadZipFile:
        return jsonify({'ok': False, 'error': 'Not a valid zip file.'}), 400
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/api/nb/import-dry-run', methods=['POST'])
def api_nb_import_dry_run():
    """Simulate a notebook import and return what would happen — no files written."""
    f = request.files.get('archive')
    if not f:
        return jsonify({'ok': False, 'error': 'No file provided.'}), 400

    name_override = request.form.get('name', '').strip()
    password      = (request.form.get('password') or '').strip()

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
    })


@app.route('/api/nb/import', methods=['POST'])
def api_nb_import():
    """Extract a .nbz archive into ~/.nb/ as a notebook — notebook content only.

    Earlier versions accepted install_plugins/install_checks/install_templates
    form fields that copied archive-bundled files into ~/.nb/.checks/,
    ~/.nb/.templates/, and the plugins directory — including chmod'd-executable
    check scripts. Removed 2026-07-29: that was an arbitrary-file-write (and,
    via /api/check/run, arbitrary-command-execution) primitive available to any
    authenticated account. See the isolation-hardening design doc. Import now
    only ever writes into the new notebook's own directory.
    """
    user = session.get('user') or {}
    if not _level_gte(user.get('level', ''), 'user'):
        return jsonify({'ok': False, 'error': 'forbidden'}), 403

    f             = request.files.get('archive')
    name_override = request.form.get('name', '').strip()
    password      = (request.form.get('password') or '').strip()
    if not f:
        return jsonify({'ok': False, 'error': 'No file provided.'}), 400

    dest = None

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

            dest_resolved = dest.resolve()
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
                try:
                    target.resolve().relative_to(dest_resolved)
                except ValueError:
                    # Archive member path (e.g. containing "..") would land outside
                    # the notebook's own directory — skip it (Zip Slip containment).
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(nb_zf.read(item.filename))

    except zipfile.BadZipFile:
        if dest and dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        return jsonify({'ok': False, 'error': 'Not a valid zip file.'}), 400
    except Exception as e:
        if dest and dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        return jsonify({'ok': False, 'error': str(e)}), 500

    # Ownership + scope hand-off — only for accounts already scope-restricted
    # (non-empty notebooks:). An unrestricted account (djp, Lena — empty
    # notebooks:) already sees every notebook via _notebook_scope_check's
    # fail-open path; stamping access: on the notebook would lock non-tech
    # admins out of an import they didn't personally make, and appending to
    # notebooks: would newly *restrict* an until-now-unrestricted account
    # rather than grant it anything. For a scope-restricted importer (the
    # actual self-service beta case) both are required: without the access:
    # stamp, any other unrestricted account can see the import (bystander
    # leak); without the notebooks: entry, the importer's own next request
    # 403s on _notebook_scope_check before ever reaching _can_access.
    if user.get('notebooks'):
        nb_cfg_path = dest / f'.{notebook}.md'
        nb_meta, nb_body = {}, ''
        if nb_cfg_path.exists():
            try:
                nb_meta, nb_body = parse_frontmatter(nb_cfg_path.read_text())
            except Exception:
                nb_meta, nb_body = {}, ''
        nb_meta['access'] = user['username']
        fm_lines = '\n'.join(f'{k}: {_yaml.dump(v, default_flow_style=True).strip()}' for k, v in nb_meta.items())
        nb_cfg_path.write_text(f'---\n{fm_lines}\n---\n{nb_body}', encoding='utf-8')

        user_path = USERS_DIR / f"{user['username']}.md"
        if user_path.exists():
            try:
                u_meta, u_body = parse_frontmatter(user_path.read_text(errors='replace'))
                nbs = list(u_meta.get('notebooks') or [])
                if notebook not in nbs:
                    nbs.append(notebook)
                    u_meta['notebooks'] = nbs
                    u_fm_lines = '\n'.join(f'{k}: {_yaml.dump(v, default_flow_style=True).strip()}' for k, v in u_meta.items())
                    user_path.write_text(f'---\n{u_fm_lines}\n---\n{u_body}', encoding='utf-8')
                    s = dict(session['user'])
                    s['notebooks'] = nbs
                    session['user'] = s
            except Exception:
                pass

    # Write import-stamped metadata
    import_meta = {**meta, 'name': notebook,
                   'imported_at': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')}
    (dest / '.nb_archive').write_text(json.dumps(import_meta, indent=2))

    _nb_index_reconcile(dest)

    if not (dest / '.git').exists():
        git_env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_ASKPASS': '/bin/true'}
        subprocess.run(['git', 'init'],      cwd=str(dest), capture_output=True, env=git_env)
        subprocess.run(['git', 'add', '-A'], cwd=str(dest), capture_output=True, env=git_env)
        subprocess.run(['git', 'commit', '-m', f'[nb] Import: {notebook}'],
                       cwd=str(dest), capture_output=True, env=git_env)

    return jsonify({
        'ok':         True,
        'notebook':   notebook,
        'note_count': meta.get('note_count', '?'),
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
            'indicator': _indicator(itype, todo_status, fpath),
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
    pull_r = _nb_config_git('pull', '--no-edit', 'origin', 'nb-config', timeout=30)
    push_r = _nb_config_git('push', 'origin', 'HEAD:nb-config', timeout=30)
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
# API: System repos — .manifest.md app/plugin/upstream repos, local git
# hygiene only (status + sync). Not a diff/log viewer — every repo already
# has a real remote (github/codeberg); link out to it for anything deeper.
# ---------------------------------------------------------------------------

_REPO_GIT_ENV = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_ASKPASS': '/bin/true',
                 'GIT_PAGER': 'cat', 'NO_COLOR': '1'}

def _repo_git(path, *args, timeout=10):
    return subprocess.run(['git', *args], cwd=str(path), capture_output=True,
                          text=True, timeout=timeout, env=_REPO_GIT_ENV)

def _repo_level_check():
    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), 'tech'):
        return jsonify({'error': 'Tech access required'}), 403
    return None

def _manifest_repos():
    """Parse .manifest.md's ## Repos CSV section, excluding type=config
    (nb-notes / ~/.nb root has its own section — see api_nb_config_*)."""
    manifest = NB_DIR / '.manifest.md'
    if not manifest.is_file():
        return []
    m = re.search(r'^## Repos\s*$.*?```csv\s*\n(.*?)```', manifest.read_text(), re.S | re.M)
    if not m:
        return []
    lines = [l for l in m.group(1).splitlines() if l.strip()]
    if not lines:
        return []
    return [row for row in csv.DictReader(lines) if row.get('type') != 'config']

# Files graphify may emit into a repo's graphify-out/ dir, keyed by the
# query-string `report=` value the frontend requests. Each generated HTML
# hardcodes a CDN <script src> for its one JS dependency (graphify's own
# templates, not ours to edit at the source) -- _GRAPHIFY_CDN_REWRITES maps
# each report to the exact substring to replace with a local vendored path,
# applied at serve time so it survives every `graphify update`/`label`
# regeneration without needing to re-patch the file itself.
_GRAPHIFY_REPORTS = {
    'graph': 'graph.html',
    'tree': 'GRAPH_TREE.html',
    'callflow': None,  # filename varies by repo (graphify uses the repo's own name) — resolved via glob
}
_GRAPHIFY_CDN_REWRITES = {
    'graph':    [('https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js', '/vendor/vis-network.min.js')],
    'tree':     [('https://d3js.org/d3.v7.min.js', '/vendor/d3.v7.min.js')],
    'callflow': [('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js', '/vendor/mermaid.min.js')],
}

def _graphify_out_dir(repo_path):
    d = repo_path / 'graphify-out'
    return d if d.is_dir() else None

def _graphify_report_path(repo_path, report):
    d = _graphify_out_dir(repo_path)
    if not d:
        return None
    if report == 'callflow':
        matches = sorted(d.glob('*-callflow.html'))
        return matches[0] if matches else None
    fname = _GRAPHIFY_REPORTS.get(report)
    if not fname:
        return None
    f = d / fname
    return f if f.is_file() else None

@app.route('/api/system/repos')
def api_system_repos():
    err = _repo_level_check()
    if err: return err
    repos = []
    for row in _manifest_repos():
        path = Path(os.path.expanduser(row['local']))
        entry = {'name': row['name'], 'type': row['type'], 'local': str(path),
                  'primary': row['primary'], 'mirror': row['mirror'],
                  'upstream': row['upstream'], 'notes': row['notes'],
                  'exists': (path / '.git').is_dir()}
        gdir = _graphify_out_dir(path)
        if gdir:
            entry['graphify'] = {report: _graphify_report_path(path, report) is not None
                                  for report in _GRAPHIFY_REPORTS}
        if entry['exists']:
            status_r = _repo_git(path, 'status', '--porcelain')
            entry['files'] = [{'status': l[:2].strip(), 'path': l[3:]}
                               for l in status_r.stdout.splitlines() if l.strip()]
            branch = _repo_git(path, 'branch', '--show-current').stdout.strip()
            entry['branch'] = branch
            entry['ahead'] = entry['behind'] = 0
            if branch:
                ab_r = _repo_git(path, 'rev-list', '--left-right', '--count',
                                  f'origin/{branch}...HEAD')
                parts = ab_r.stdout.split()
                if ab_r.returncode == 0 and len(parts) == 2:
                    entry['behind'], entry['ahead'] = int(parts[0]), int(parts[1])
        repos.append(entry)
    return jsonify({'repos': repos})

@app.route('/api/system/repos/graphify-view')
def api_system_repos_graphify_view():
    err = _repo_level_check()
    if err: return err
    name = (request.args.get('name') or '').strip()
    report = (request.args.get('report') or '').strip()
    if report not in _GRAPHIFY_REPORTS:
        return jsonify({'error': 'Unknown report'}), 400
    match = next((r for r in _manifest_repos() if r['name'] == name), None)
    if not match:
        return jsonify({'error': 'Unknown repo'}), 404
    repo_path = Path(os.path.expanduser(match['local']))
    report_path = _graphify_report_path(repo_path, report)
    if not report_path:
        return jsonify({'error': 'Report not generated for this repo'}), 404
    html = report_path.read_text()
    for needle, replacement in _GRAPHIFY_CDN_REWRITES.get(report, []):
        html = html.replace(needle, replacement)
    return Response(html, mimetype='text/html')

@app.route('/api/system/repos/sync', methods=['POST'])
def api_system_repos_sync():
    err = _repo_level_check()
    if err: return err
    name = (request.get_json() or {}).get('name', '').strip()
    match = next((r for r in _manifest_repos() if r['name'] == name), None)
    if not match:
        return jsonify({'error': 'Unknown repo'}), 404
    path = Path(os.path.expanduser(match['local']))
    if not (path / '.git').is_dir():
        return jsonify({'error': 'Not a git repo on disk'}), 400
    branch = _repo_git(path, 'branch', '--show-current').stdout.strip()
    if not branch:
        return jsonify({'error': 'Could not determine current branch'}), 400
    pull_r = _repo_git(path, 'pull', '--no-rebase', '--no-edit', 'origin', branch, timeout=30)
    push_r = _repo_git(path, 'push', 'origin', f'HEAD:{branch}', timeout=30)
    return jsonify({
        'success': push_r.returncode == 0,
        'output':  pull_r.stdout + pull_r.stderr + push_r.stdout + push_r.stderr,
    })


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

            cine_json    = entry / '.nb-cine.json'
            hledger_json = entry / '.nb-hledger.json'
            _manifest    = None   # lazy-loaded once if either JSON file is absent

            cine = None
            if cine_json.exists():
                try:
                    cine = json.loads(cine_json.read_text())
                except Exception:
                    cine = {}
            else:
                _manifest = _notebook_config(entry.name)
                cine = _manifest.get('cine') or None

            hledger = None
            if hledger_json.exists():
                try:
                    hledger = json.loads(hledger_json.read_text())
                except Exception:
                    hledger = {}
            else:
                if _manifest is None:
                    _manifest = _notebook_config(entry.name)
                hledger = _manifest.get('hledger') or None

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
                 if _can_access(user, {}, _notebook_config(n['name']))
                 and _notebook_in_scope(user, n['name'])]
    if _level_gte(user_level, 'admin'):
        for df in DOTFOLDERS:
            df_path = NB_DIR / df
            if not df_path.is_dir() or not _notebook_in_scope(user, df):
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
    user = session.get('user') or {}
    if not _level_gte(user.get('level', ''), 'admin'):
        return jsonify({'ok': False, 'output': 'Forbidden — admin access required.'}), 403

    data     = request.get_json() or {}
    notebook = data.get('notebook', '')
    # Unlike every sibling git/publish endpoint, this one never validated
    # `notebook` at all -- a plain, unchecked Path join with an unvalidated
    # string can walk out of NB_DIR via '../' (the OS resolves '..' in the
    # path string itself; Python does nothing to stop it), the same class of
    # bug as the absolute-path-selector bypass fixed 2026-07-30, just via a
    # different field. Belt-and-suspenders: _check_notebook rejects that
    # shape outright.
    try:
        _check_notebook(notebook)
    except ValueError as e:
        return jsonify({'ok': False, 'output': str(e)}), 400

    if not _can_access(user, {}, _notebook_config(notebook)):
        return jsonify({'ok': False, 'output': f'Notebook "{notebook}" is access-restricted.'}), 403

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

    # Trigger immediate workflow dispatch. Wrapped, matching sibling
    # endpoints (api_website_deploy): an unhandled FileNotFoundError here
    # (gh missing or misconfigured) previously 500'd the whole request
    # instead of degrading to a normal {'ok': False, 'output': ...} JSON
    # response -- found live, 2026-07-19, before gh was installed at all.
    try:
        gh = subprocess.run(
            ['gh', 'workflow', 'run', 'deploy.yml', '--repo', github_repo],
            capture_output=True, text=True, timeout=30,
        )
        gh_out = (gh.stdout + gh.stderr).strip()
        parts.append(f'workflow dispatch ({github_repo}):\n' + (gh_out or 'triggered'))
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        parts.append(f'workflow dispatch ({github_repo}):\nFAILED — {e}')
        return jsonify({'ok': False, 'output': '\n\n'.join(parts)})

    # Grab the run ID so the frontend can poll build status
    run_id = None
    if gh.returncode == 0:
        import time as _time
        _time.sleep(3)
        try:
            list_r = subprocess.run(
                ['gh', 'run', 'list', '--workflow', 'deploy.yml', '--repo', github_repo,
                 '--limit', '3', '--json', 'databaseId,status'],
                capture_output=True, text=True, timeout=15,
            )
            if list_r.returncode == 0:
                runs = json.loads(list_r.stdout or '[]')
                if runs:
                    run_id = str(runs[0]['databaseId'])
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass  # run_id stays None; frontend just won't get build-status polling

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
    default_remote = (_effective_setting('default_git_remote') or '').strip()

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
        merged_meta = _notebook_config(notebook)   # global + notebook merged
        if config_path.exists():
            raw = config_path.read_text(errors='replace')
            return jsonify(content=raw, exists=True, meta=merged_meta)
        return jsonify(content='---\n# access: guest\n---\n', exists=False, meta=merged_meta)
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
                _nb_index_reconcile(dest.parent)
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


@app.route('/api/item/new', methods=['POST'])
def api_item_new():
    """Create one shop item, with one or more images, from an upload -- the
    nb-web-native equivalent of the nb-new-item desktop script (Caja
    right-click -> Add New Item), triggered instead from the item specialty
    header's "+ New" button.

    One item per call, not one item per file: `code` (filename/accounting
    reference, e.g. ABC123 -- convention, not enforced) and `title`
    (descriptive text) are distinct and both required. The first uploaded
    file becomes the primary image (`{code}.ext`); any further files are
    supplemental images of the *same* item, auto-suffixed `{code}-1.ext`,
    `{code}-2.ext`, ... so multi-select maps to "one item, several photos",
    not several items. images/ and items/ are fixed targets (matching
    nb-new-item; there's no folder picker there either), so this only needs
    `notebook`, not a folder param.

    `tags` is optional, a comma-separated string (e.g. from Pix's embedded
    IPTC/XMP Keywords) -- pre-fills the item's `tags:` list instead of
    leaving it empty for the user to fill in later.
    """
    notebook = request.form.get('notebook', '').strip()
    if not _safe_notebook(notebook):
        return jsonify({'success': False, 'error': 'invalid notebook'}), 400

    code  = request.form.get('code', '').strip()
    title = request.form.get('title', '').strip()
    if not code:
        return jsonify({'success': False, 'error': 'item code required'}), 400
    if not title:
        return jsonify({'success': False, 'error': 'title required'}), 400

    # Optional, comma-separated -- e.g. tags read off the source images'
    # embedded IPTC/XMP Keywords by the calling script (Pix carries tags
    # this way when "store metadata in files" is on).
    raw_tags = request.form.get('tags', '')
    tags     = [t.strip() for t in raw_tags.split(',') if t.strip()]

    files = request.files.getlist('files')
    if not files:
        return jsonify({'success': False, 'error': 'no files provided'}), 400

    safe_code = re.sub(r'[^A-Za-z0-9_-]', '_', code)

    nb_path    = NB_DIR / notebook
    images_dir = nb_path / 'images'
    items_dir  = nb_path / 'items'
    images_dir.mkdir(parents=True, exist_ok=True)
    items_dir.mkdir(parents=True, exist_ok=True)

    template_path = items_dir / '.templates' / 'item.md'
    template_text = template_path.read_text(errors='replace') if template_path.exists() else None

    cfg       = _load_settings()
    max_bytes = cfg['import_max_mb'] * 1024 * 1024
    today     = datetime.now().strftime('%Y-%m-%d')

    existing_items  = {p.stem for p in items_dir.glob('*.md') if not p.name.startswith('.')}
    existing_images = {p.name for p in images_dir.iterdir() if p.is_file()} if images_dir.is_dir() else set()

    # Auto-suffix the item code itself on collision -- against existing item
    # notes on disk and against any existing image already using that stem.
    base = safe_code
    n = 2
    while base in existing_items or any(Path(name).stem == base for name in existing_images):
        base = f'{safe_code}_{n}'
        n += 1

    image_names   = []
    failures      = []

    for f in files:
        if not f or not f.filename:
            continue
        safe_name = Path(f.filename).name.replace('/', '_').replace('..', '_')
        chunk = f.read(max_bytes + 1)
        if len(chunk) > max_bytes:
            failures.append({'file': safe_name, 'error': f'exceeds {cfg["import_max_mb"]} MB limit'})
            continue

        ext      = Path(safe_name).suffix
        img_name = f'{base}{ext}' if not image_names else f'{base}-{len(image_names)}{ext}'
        try:
            (images_dir / img_name).write_bytes(chunk)
        except OSError as e:
            failures.append({'file': safe_name, 'error': str(e)})
            continue
        image_names.append(img_name)

    if not image_names:
        return jsonify({'success': False, 'error': 'no images could be saved', 'failures': failures}), 400

    item_name = f'{base}.md'
    # Comma-separated, not a YAML list -- matches nbweb-quartz.js's existing
    # (m.image || '').split(',') convention for multi-image items.
    image_fm = ', '.join(image_names)
    tags_fm  = '[' + ', '.join(tags) + ']'

    if template_text:
        item_text = (template_text
                     .replace('{{title}}', title)
                     .replace('{{date}}', today))
        item_text = re.sub(r'^image:.*$', f'image: {image_fm}', item_text, count=1, flags=re.MULTILINE)
        if tags:
            item_text = re.sub(r'^tags:.*$', f'tags: {tags_fm}', item_text, count=1, flags=re.MULTILINE)
    else:
        item_text = (
            f'---\ntitle: {title}\ntype: item\ndate: {today}\nstatus: available\n'
            f'category:\ncaption:\ndescription:\nprice:\nqtty:\nimage: {image_fm}\n'
            f'condition:\nplatform:\nlisting:\ntags: {tags_fm}\n---\n'
        )
    (items_dir / item_name).write_text(item_text)

    _nb_index_reconcile(images_dir)
    _nb_index_reconcile(items_dir)

    created_paths = [f'images/{n}' for n in image_names] + [f'items/{item_name}']
    env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
    subprocess.run(['git', 'add'] + created_paths + ['images/.index', 'items/.index'],
                   cwd=str(nb_path), capture_output=True, env=env)
    subprocess.run(['git', 'commit', '-m', f'[nb] New item: {base} ({len(image_names)} image(s))'],
                   cwd=str(nb_path), capture_output=True, env=env)

    return jsonify({
        'success':  True,
        'item':     base,
        'selector': f'{notebook}:items/{item_name}',
        'images':   image_names,
        'failures': failures,
    })


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
    _nb_index_reconcile(contacts_dir)

    idx      = read_index('contacts')
    note_id  = (idx.index(fname) + 1) if fname in idx else None
    selector = f'contacts:{note_id}' if note_id else None
    return jsonify({'success': True, 'selector': selector, 'filename': fname, 'name': name})


def _find_project_name(dir_path):
    """Best-effort project name for a suggested link destination -- walks up
    from the file's directory looking for a git repo root (.git), since
    that's a much better proxy for "which project is this" than the
    immediate parent folder (often just a subdirectory like docs/ or
    frontend/, not the project itself). Falls back to the immediate parent
    directory name if no repo root turns up within a few levels (e.g. a
    file that isn't inside any git repo).
    """
    home = Path.home()
    current = dir_path
    for _ in range(8):
        if (current / '.git').exists():
            return current.name
        if current == current.parent or current == home:
            break
        current = current.parent
    return dir_path.name


@app.route('/api/link-file/suggest-name', methods=['GET'])
def api_link_file_suggest_name():
    """Suggested destination name for the Link-file dialog -- read-only, no
    side effects, safe to call on every keystroke while the path is still
    being typed. Server-side because the git-repo-root walk needs real
    filesystem access the browser doesn't have.
    """
    src_str = (request.args.get('path') or '').strip()
    if not src_str:
        return jsonify({'name': ''})
    src = Path(os.path.expanduser(src_str))
    if not src.is_absolute() or not src.exists() or not src.is_file():
        return jsonify({'name': ''})
    src = src.resolve()
    project = _find_project_name(src.parent)
    return jsonify({'name': f'{project}-{src.name}' if project else src.name})


@app.route('/api/link-file', methods=['POST'])
def api_link_file():
    """Create a symlink inside a notebook (optionally a subfolder) pointing
    to an existing filesystem path. Collision/dedup checks are scoped to the
    exact target folder, not the whole notebook -- each folder has its own
    .index (see read_index), and there's no actual notebook-wide filename
    constraint anywhere in nb-web's own note-creation path (api_add_note
    checks the same way), so two same-named files (e.g. two plugins each
    with their own README.md) coexist fine in sibling folders without
    needing a disambiguating prefix.
    """
    data     = request.get_json(silent=True) or {}
    src_str  = data.get('path', '').strip()
    notebook = data.get('notebook', 'home').strip() or 'home'
    name_str = (data.get('name') or '').strip()
    folder   = (data.get('folder') or '').strip().strip('/')

    if not _safe_notebook(notebook):
        return jsonify({'success': False, 'error': 'invalid notebook'}), 400
    if not src_str:
        return jsonify({'success': False, 'error': 'path is required'}), 400
    if folder and ('..' in folder or folder.startswith('/')):
        return jsonify({'success': False, 'error': 'invalid folder'}), 400

    src = Path(os.path.expanduser(src_str)).resolve()
    if not src.exists():
        return jsonify({'success': False, 'error': f'Path not found: {src}'}), 404
    if not src.is_file():
        return jsonify({'success': False, 'error': f'Not a file: {src}'}), 400

    # Path(name_str).name strips any directory components a caller sent --
    # defensive, this is a filename, never a path.
    base_name = Path(name_str).name if name_str else src.name
    if not base_name:
        return jsonify({'success': False, 'error': 'invalid name'}), 400

    nb_dir     = _nb_notebook_dir(notebook)
    target_dir = (nb_dir / folder) if folder else nb_dir
    target_dir.mkdir(parents=True, exist_ok=True)

    # Reconcile every intermediate folder level, not just the leaf --
    # api/folders' recursive walker (_list_folders_recursive) requires an
    # .index at every level to descend, so a freshly created nested folder
    # (mkdir parents=True can create several levels at once) needs each
    # ancestor indexed too, or everything under the un-indexed one is
    # invisible in the UI even though the files and their own .index exist.
    # The leaf (target_dir) is reconciled again below, after the symlink is
    # actually created, so it picks up the new file.
    if folder:
        cur = nb_dir
        for part in Path(folder).parts[:-1]:
            cur = cur / part
            _nb_index_reconcile(cur)

    def _selector(filename):
        rel = f'{folder}/{filename}' if folder else filename
        return f'{notebook}:{rel}'

    # Re-linking a file already linked into this exact folder is a no-op,
    # not a duplicate -- common when a project's README (same basename as
    # dozens of other projects') gets linked again after forgetting it's
    # already there.
    for existing in target_dir.iterdir():
        if existing.is_symlink():
            try:
                if existing.resolve() == src:
                    return jsonify({'success': True, 'name': existing.name,
                                    'target': str(src), 'selector': _selector(existing.name),
                                    'already_linked': True})
            except OSError:
                pass  # broken symlink -- not a match, fall through

    # Collision on the chosen (or default) name -- auto-suffix as a fallback
    # rather than failing outright; the dialog already lets the user pick a
    # disambiguated name up front (e.g. <project>-<filename>), so this only
    # fires when that still wasn't enough.
    dest = target_dir / base_name
    if dest.exists() or dest.is_symlink():
        stem, suffix = Path(base_name).stem, Path(base_name).suffix
        for n in range(2, 100):
            candidate = target_dir / f'{stem}-{n}{suffix}'
            if not candidate.exists() and not candidate.is_symlink():
                dest = candidate
                break
        else:
            return jsonify({'success': False,
                            'error': f'too many existing files named like {base_name} in {notebook}'}), 409

    try:
        os.symlink(src, dest)
        _nb_index_reconcile(target_dir)
        # Explicit, scoped commit -- same pattern api_add_note's direct-write
        # path uses -- rather than leaving the symlink + .index change
        # sitting uncommitted for some other process to eventually pick up.
        rel_link  = dest.relative_to(nb_dir)
        rel_index = (target_dir / '.index').relative_to(nb_dir)
        env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
        subprocess.run(['git', 'add', str(rel_link), str(rel_index)],
                       cwd=str(nb_dir), capture_output=True, env=env)
        subprocess.run(['git', 'commit', '-m', f'[nb] Linked: {dest.name}'],
                       cwd=str(nb_dir), capture_output=True, env=env)
        return jsonify({'success': True, 'name': dest.name, 'target': str(src), 'selector': _selector(dest.name)})
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
# API: Check codeblock runner
# ---------------------------------------------------------------------------

@app.route('/api/check/run', methods=['POST'])
def api_check_run():
    """Run a script from ~/.nb/.checks/ with note context env vars."""
    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), 'user'):
        return jsonify({'error': 'forbidden', 'exit_code': 1}), 403
    data        = request.get_json(force=True) or {}
    script_name = (data.get('script') or '').strip()
    selector    = (data.get('selector') or '').strip()
    force       = bool(data.get('force', False))
    demo        = bool(data.get('demo', False))

    if not script_name:
        return jsonify({'error': 'no script name', 'exit_code': 1}), 400
    if '/' in script_name or script_name.startswith('.'):
        return jsonify({'error': 'invalid script name', 'exit_code': 1}), 400

    script_path = CHECK_DIR / script_name
    if not script_path.exists() and not script_name.endswith('.sh'):
        script_path = CHECK_DIR / (script_name + '.sh')
    if not script_path.exists():
        return jsonify({'error': f'script not found: {script_name} (looked in {CHECK_DIR})', 'exit_code': 1}), 404

    # Return cached result for auto-runs (force=False) within TTL
    cache_key = (script_name, selector)
    now = time.time()
    if not force:
        entry = _check_cache.get(cache_key)
        if entry and (now - entry['ts']) < _CHECK_CACHE_TTL:
            return jsonify(entry['result'])

    notebook  = selector.split(':')[0] if ':' in selector else ''
    note_path = _resolve_to_nb_path(selector) if selector else None

    fm_lines = 0
    if note_path:
        try:
            raw = Path(note_path).read_text(errors='replace')
            if raw.startswith('---'):
                parts = raw.split('---', 2)
                if len(parts) >= 3:
                    fm_lines = len(('---' + parts[1] + '---').splitlines())
        except OSError:
            pass

    env = {
        **os.environ,
        'NB_DIR':           str(NB_DIR),
        'NB_APP_DIR':       str(Path(__file__).parent),
        'NB_NOTE_SELECTOR': selector,
        'NB_NOTEBOOK':      notebook,
        'NB_NOTE_PATH':     str(note_path) if note_path else '',
        'NB_FM_LINES':      str(fm_lines),
        'NO_COLOR':         '1',
    }
    try:
        cmd = ['bash', str(script_path)]
        if demo:
            cmd.append('--demo')
        result = subprocess.run(
            cmd,
            capture_output=True, text=True,
            env=env, timeout=30,
        )
        result_data = {
            'stdout':    result.stdout,
            'stderr':    result.stderr,
            'exit_code': result.returncode,
        }
        _check_cache[cache_key] = {'result': result_data, 'ts': now}
        return jsonify(result_data)
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'script timed out (30s)', 'exit_code': 1})
    except Exception as e:
        return jsonify({'error': str(e), 'exit_code': 1})


@app.route('/api/check/glob')
def api_check_glob():
    """List check scripts matching a prefix, e.g. ?prefix=nb-schem- returns
    ['nb-schem-fields.sh', 'nb-schem-values.sh', ...] sorted alphabetically.

    The prefix must end with '-' (dangling dash convention) and contain only
    safe characters — no path separators or dots beyond the .sh extension.
    """
    prefix = request.args.get('prefix', '').strip()
    if prefix and not prefix.endswith('-'):
        return jsonify({'error': 'prefix must end with -'}), 400
    if '/' in prefix or '\\' in prefix or prefix.startswith('.'):
        return jsonify({'error': 'invalid prefix'}), 400
    if not CHECK_DIR.is_dir():
        return jsonify([])
    matches = sorted(p.name for p in CHECK_DIR.glob(f'{prefix}*.sh'))
    return jsonify(matches)


@app.route('/api/check/batch', methods=['POST'])
def api_check_batch():
    """Run multiple check scripts in parallel with a single round trip.

    Request:  { "scripts": ["hl-ok", "nb-dirty", ...], "selector": "accts:review.md", "force": false }
    Response: { "hl-ok": { "stdout": "", "exit_code": 0 }, ... }

    Scripts are deduplicated before running.  Cache is checked per-script
    using the same key/TTL as /api/check/run so results are shared -- and,
    same as /api/check/run, "force": true bypasses it for a guaranteed-fresh
    run (a sweep/cron caller checking current state shouldn't silently get a
    stale pass from an unrelated UI view within the last 30s).
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    data     = request.get_json(force=True) or {}
    scripts  = [s for s in (data.get('scripts') or []) if isinstance(s, str)]
    selector = (data.get('selector') or '').strip()
    force    = bool(data.get('force', False))

    if not scripts:
        return jsonify({})

    # Resolve note context once — shared across all script invocations
    notebook  = selector.split(':')[0] if ':' in selector else ''
    note_path = _resolve_to_nb_path(selector) if selector else None
    env = {
        **os.environ,
        'NB_DIR':           str(NB_DIR),
        'NB_APP_DIR':       str(Path(__file__).parent),
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
        if not force:
            entry = _check_cache.get(cache_key)
            if entry and (now - entry['ts']) < _CHECK_CACHE_TTL:
                return script_name, entry['result']
        script_path = CHECK_DIR / script_name
        if not script_path.exists() and not script_name.endswith('.sh'):
            script_path = CHECK_DIR / (script_name + '.sh')
        if not script_path.exists():
            return script_name, {'error': f'not found: {script_name}', 'exit_code': 1, 'stdout': ''}
        try:
            r = subprocess.run(['bash', str(script_path)],
                               capture_output=True, text=True, env=env, timeout=30)
            result = {'stdout': r.stdout, 'stderr': r.stderr, 'exit_code': r.returncode}
            _check_cache[cache_key] = {'result': result, 'ts': now}
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


@app.route('/api/project/write-marker', methods=['POST'])
def api_write_marker():
    """Insert a state-transition marker into a project note.

    Body: { selector, marker, ref, position }
      marker   — ALLCAPS name, e.g. PAUSED, CLOSED, DELIVERED
      ref      — optional reason/label appended after the colon
      position — 'before_today' (default) | 'today_section' | 'end'

    before_today: inserts the line immediately before > TODAY:
    today_section: appends to today's ## YYYY-MM-DD section (creates it if absent)
    end: appends at end of file
    """
    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), 'user'):
        return jsonify(error='forbidden'), 403

    data     = request.get_json(force=True) or {}
    selector = (data.get('selector') or '').strip()
    marker   = (data.get('marker') or '').strip().upper()
    ref      = (data.get('ref') or '').strip()
    position = (data.get('position') or 'before_today').strip()

    if not selector:
        return jsonify(error='selector required'), 400
    if not re.match(r'^[A-Z]{2,20}$', marker):
        return jsonify(error='invalid marker name'), 400

    note_path = _resolve_to_nb_path(selector)
    if not note_path or not Path(note_path).exists():
        return jsonify(error='note not found'), 404

    note_path = Path(note_path)
    text      = note_path.read_text(errors='replace')
    line      = f'> {marker}: {ref}' if ref else f'> {marker}:'

    if position == 'before_today':
        if '> TODAY:' in text:
            text = text.replace('> TODAY:', f'{line}\n\n> TODAY:', 1)
        else:
            text = text.rstrip('\n') + f'\n\n{line}\n'
    elif position == 'today_section':
        today   = datetime.now().strftime('%Y-%m-%d')
        heading = f'## {today}'
        if heading in text:
            idx  = text.index(heading) + len(heading)
            text = text[:idx] + f'\n\n{line}' + text[idx:]
        elif '> TODAY:' in text:
            text = text.replace('> TODAY:', f'{heading}\n\n{line}\n\n> TODAY:', 1)
        else:
            text = text.rstrip('\n') + f'\n\n{line}\n'
    else:  # 'end'
        text = text.rstrip('\n') + f'\n\n{line}\n'

    note_path.write_text(text)

    notebook = selector.split(':')[0]
    nb_root  = NB_DIR / notebook
    rel      = note_path.relative_to(nb_root)
    env      = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
    subprocess.run(['git', 'add', str(rel)], cwd=str(nb_root), capture_output=True, env=env)
    subprocess.run(['git', 'commit', '-m', f'[nb] {marker}: {ref or selector}'],
                   cwd=str(nb_root), capture_output=True, env=env)

    return jsonify(ok=True, line=line)


@app.route('/api/sysadmin')
def api_sysadmin():
    """Return sysadmin dashboard data: notebook inventory, plugin list, config file status."""
    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), 'tech'):
        return jsonify(error='forbidden'), 403

    # ── Notebook inventory ────────────────────────────────────────────────────
    notebooks = []
    for entry in sorted(NB_DIR.iterdir()):
        if not entry.is_dir() or entry.name.startswith('.'):
            continue
        dotfile = entry / f'.{entry.name}.md'
        has_dot = dotfile.exists()
        plugins_list = []
        wired = False
        remote = ''
        branch = ''
        if has_dot:
            try:
                meta, _ = parse_frontmatter(dotfile.read_text())
                plugins_list = meta.get('plugins') or []
                if isinstance(plugins_list, str):
                    plugins_list = [plugins_list]
            except Exception:
                pass
        git_dir = entry / '.git'
        if git_dir.exists():
            try:
                r = subprocess.run(['git', 'remote', 'get-url', 'origin'],
                                   cwd=str(entry), capture_output=True, text=True, timeout=5)
                if r.returncode == 0:
                    wired = True
                    remote = r.stdout.strip().split('/')[-1].replace('.git', '')
            except Exception:
                pass
            try:
                r = subprocess.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
                                   cwd=str(entry), capture_output=True, text=True, timeout=5)
                branch = r.stdout.strip()
            except Exception:
                pass
        has_checks = (entry / '.checks').is_dir()
        try:
            count = len([f for f in entry.rglob('*.md')
                         if not f.name.startswith('.') and f.is_file()])
        except Exception:
            count = 0
        notebooks.append({
            'name':       entry.name,
            'has_dotfile': has_dot,
            'wired':      wired,
            'remote':     remote,
            'branch':     branch,
            'plugins':    plugins_list,
            'has_checks': has_checks,
            'note_count': count,
            'selector':   f'{entry.name}:.{entry.name}.md' if has_dot else None,
        })

    # ── Plugin list ───────────────────────────────────────────────────────────
    settings_path = Path(__file__).parent / 'nb-settings.json'
    plugins = []
    if settings_path.exists():
        try:
            settings = json.loads(settings_path.read_text())
            plugins = settings.get('plugins') or []
        except Exception:
            pass

    # ── Key config files ──────────────────────────────────────────────────────
    # Note: 'Global dotfile' keeps the special-cased '.nb:.nb.md' selector (see
    # api_note()'s admin-gated special case above) rather than an absolute path --
    # the other four never had a real selector form (no notebook is ever named
    # '.nb', and '/api/note' rejects any dotfolder filename containing '/'), so
    # they resolve as plain absolute paths instead.
    config_files = [
        {'label': 'Global dotfile',  'selector': '.nb:.nb.md',           'exists': (NB_DIR / '.nb.md').exists()},
        {'label': 'Manifest',        'selector': str(NB_DIR / '.manifest.md'),               'exists': (NB_DIR / '.manifest.md').exists()},
        {'label': 'Checks index',    'selector': str(NB_DIR / '.checks' / 'check-index.md'), 'exists': (NB_DIR / '.checks' / 'check-index.md').exists()},
        {'label': 'Guards rule',     'selector': str(NB_DIR / '.rules' / 'guards.md'),       'exists': (NB_DIR / '.rules' / 'guards.md').exists()},
        {'label': 'Tools index',     'selector': str(NB_DIR / '.tools' / 'tools.md'),        'exists': (NB_DIR / '.tools' / 'tools.md').exists()},
        {'label': 'nb-settings',     'path': str(settings_path),         'exists': settings_path.exists()},
    ]

    return jsonify({
        'notebooks':    notebooks,
        'plugins':      plugins,
        'config_files': config_files,
        'check_count':  len(list(CHECK_DIR.glob('*.sh'))) if CHECK_DIR.is_dir() else 0,
    })


@app.route('/api/sysadmin/crontab')
def api_sysadmin_crontab():
    """Return the current user's crontab, parsed into schedule/command/description.

    A `#`-comment line (or contiguous run of them) immediately above an entry
    is taken as that entry's description -- the convention already used for
    the publish-sweep entry (see nb-sweep-log/check-sweep.py). No crontab at
    all (crontab -l exits 1) is a normal, valid state, not an error.
    """
    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), 'tech'):
        return jsonify(error='forbidden'), 403

    try:
        r = subprocess.run(['crontab', '-l'], capture_output=True, text=True, timeout=5)
    except Exception as e:
        return jsonify({'entries': [], 'error': str(e)})

    entries = []
    pending_desc = []
    if r.returncode == 0:
        for line in r.stdout.splitlines():
            line = line.rstrip()
            if not line.strip():
                pending_desc = []
                continue
            if line.lstrip().startswith('#'):
                pending_desc.append(line.lstrip('#').strip())
                continue
            m = re.match(r'^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$', line)
            if m:
                entries.append({
                    'schedule':    m.group(1),
                    'command':     m.group(2),
                    'description': ' '.join(pending_desc),
                })
            pending_desc = []

    return jsonify({'entries': entries})


# ---------------------------------------------------------------------------
# API: User management (admin+)
# ---------------------------------------------------------------------------

def _admin_check():
    """Return error response or None. Requires admin+ level."""
    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), 'admin'):
        return jsonify(error='forbidden'), 403
    return None

def _read_all_users():
    """Return sorted list of user dicts (no password_hash)."""
    users = []
    if not USERS_DIR.exists():
        return users
    for path in sorted(USERS_DIR.glob('*.md')):
        stem = path.stem
        if not _RE_USERNAME.match(stem):
            continue
        try:
            meta, _ = parse_frontmatter(path.read_text())
            nbs = meta.get('notebooks')
            users.append({
                'username':  stem,
                'name':      str(meta.get('name', stem)),
                'level':     str(meta.get('level', 'user')),
                'notebooks': list(nbs) if isinstance(nbs, (list, tuple)) else [],
                'selector':  f'.users:{stem}.md',
            })
        except Exception:
            continue
    users.sort(key=lambda u: (LEVELS.index(u['level']) if u['level'] in LEVELS else 0, u['username']), reverse=True)
    return users

@app.route('/api/users')
def api_list_users():
    err = _admin_check()
    if err: return err
    return jsonify({'users': _read_all_users()})

@app.route('/api/users', methods=['POST'])
def api_create_user():
    err = _admin_check()
    if err: return err
    data     = request.get_json(force=True) or {}
    username = (data.get('username') or '').strip().lower()
    name     = (data.get('name') or '').strip()
    level    = (data.get('level') or 'user').strip()
    password = (data.get('password') or '').strip()
    notebooks = data.get('notebooks') or []

    if not username or not _RE_USERNAME.match(username):
        return jsonify(error='Invalid username'), 400
    if level not in LEVELS:
        return jsonify(error='Invalid level'), 400
    if not password:
        return jsonify(error='Password required'), 400

    # Prevent privilege escalation: can't create user with higher level than yourself
    caller = session.get('user', {})
    if LEVELS.index(level) > LEVELS.index(caller.get('level', 'guest')):
        return jsonify(error='Cannot create user with higher level than your own'), 403
    # notebooks: is a hard access-scope boundary (enforced in _notebook_scope_check) --
    # only tech may set it, at creation or later, same as editing an existing user.
    if notebooks and caller.get('level') != 'tech':
        return jsonify(error='Only tech can set notebooks scope'), 403

    path = USERS_DIR / f'{username}.md'
    if path.exists():
        return jsonify(error=f'User {username!r} already exists'), 409

    pw_hash = generate_password_hash(password)
    nb_yaml = '\n'.join(f'  - {nb}' for nb in notebooks) if notebooks else ''
    nb_line  = f'notebooks:\n{nb_yaml}' if nb_yaml else 'notebooks: []'
    content  = f'---\nname: {name or username}\nlevel: {level}\n{nb_line}\npassword_hash: "{pw_hash}"\n---\n'
    USERS_DIR.mkdir(exist_ok=True)
    path.write_text(content)
    return jsonify({'success': True, 'selector': f'.users:{username}.md'})

@app.route('/api/users/<username>', methods=['PUT'])
def api_update_user(username):
    err = _admin_check()
    if err: return err
    if not _RE_USERNAME.match(username):
        return jsonify(error='Invalid username'), 400

    path = USERS_DIR / f'{username}.md'
    if not path.exists():
        return jsonify(error='User not found'), 404

    data     = request.get_json(force=True) or {}
    caller   = session.get('user', {})

    try:
        meta, body = parse_frontmatter(path.read_text())
    except Exception:
        return jsonify(error='Could not read user card'), 500

    if 'name' in data:
        meta['name'] = str(data['name']).strip()
    if 'level' in data:
        new_level = str(data['level']).strip()
        if new_level not in LEVELS:
            return jsonify(error='Invalid level'), 400
        if LEVELS.index(new_level) > LEVELS.index(caller.get('level', 'guest')):
            return jsonify(error='Cannot elevate user above your own level'), 403
        meta['level'] = new_level
    if 'notebooks' in data:
        # notebooks: is a hard access-scope boundary (enforced in
        # _notebook_scope_check), not an ordinary profile field -- only
        # tech may change it, in either direction (setting OR clearing a
        # restriction), so an admin-level caller can't quietly widen their
        # own or another account's scope back open.
        if caller.get('level') != 'tech':
            return jsonify(error='Only tech can edit notebooks scope'), 403
        meta['notebooks'] = list(data['notebooks'])
    if 'password' in data and data['password']:
        meta['password_hash'] = generate_password_hash(str(data['password']))

    # Reconstruct YAML frontmatter preserving password_hash
    nbs = meta.get('notebooks', [])
    nb_yaml = '\n'.join(f'  - {nb}' for nb in nbs) if nbs else ''
    nb_line  = f'notebooks:\n{nb_yaml}' if nb_yaml else 'notebooks: []'
    content  = (f'---\nname: {meta.get("name", username)}\nlevel: {meta.get("level", "user")}\n'
                f'{nb_line}\npassword_hash: "{meta.get("password_hash", "")}"\n---\n{body}')
    path.write_text(content)
    return jsonify({'success': True})

@app.route('/api/users/<username>', methods=['DELETE'])
def api_delete_user(username):
    err = _admin_check()
    if err: return err
    if not _RE_USERNAME.match(username):
        return jsonify(error='Invalid username'), 400
    caller = session.get('user', {})
    if caller.get('username') == username:
        return jsonify(error='Cannot delete your own account'), 400
    path = USERS_DIR / f'{username}.md'
    if not path.exists():
        return jsonify(error='User not found'), 404
    path.unlink()
    return jsonify({'success': True})


# ---------------------------------------------------------------------------
# API: Rename / Move note
# ---------------------------------------------------------------------------

def _resolve_dest_dir(dest: str) -> Path:
    """Resolve nb move dest like 'work:folder/file.md' or 'work:folder/' to the directory."""
    if ':' in dest:
        nb_name, rest = dest.split(':', 1)
        folder = rest.strip('/')
    else:
        nb_name = dest.strip('/')
        folder = ''
    p = (NB_DIR / nb_name / folder) if folder else (NB_DIR / nb_name)
    # If dest included a filename (has an extension), return its parent directory
    return p.parent if p.suffix else p


@app.route('/api/note/rename', methods=['POST'])
def api_rename():
    """Rename the note file (and its annotation sidecar if present)."""
    data     = request.get_json() or {}
    selector = data.get('selector', '').strip()
    name     = data.get('name', '').strip()
    if not selector or not name:
        return jsonify({'error': 'selector and name required'}), 400

    user = session.get('user', {})
    if not _can_write(user, selector):
        return jsonify({'error': 'forbidden'}), 403

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

    user = session.get('user', {})
    if not _can_write(user, selector):
        return jsonify({'error': 'forbidden'}), 403

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


@app.route('/api/note/copy', methods=['POST'])
def api_copy():
    """Copy a note (and its annotation sidecar) to a new notebook/folder."""
    data     = request.get_json() or {}
    selector = data.get('selector', '').strip()
    dest     = data.get('dest', '').strip()   # e.g. "work:" or "tasks:folder/"
    if not selector or not dest:
        return jsonify({'error': 'selector and dest required'}), 400

    user = session.get('user', {})
    if not _can_write(user, selector):
        return jsonify({'error': 'forbidden'}), 403

    fpath_r  = run_nb('show', selector, '--path')
    fpath    = Path(fpath_r['stdout'].strip()) if nb_ok(fpath_r) else None
    ann_path = _annotation_path(str(fpath)) if fpath else None

    r = run_nb('copy', selector, dest)
    if not nb_ok(r):
        return jsonify({'success': False, 'stderr': strip_ansi(r['stderr'])})

    # Copy annotation sidecar to the destination directory (non-fatal; source copy stays)
    ann_copied = False
    if ann_path and ann_path.exists() and fpath:
        try:
            import shutil as _shutil
            dest_dir = _resolve_dest_dir(dest)
            dest_dir.mkdir(parents=True, exist_ok=True)
            new_ann = dest_dir / f'.{fpath.name}.annotations.md'
            _shutil.copy2(ann_path, new_ann)
            ann_copied = True
        except OSError:
            pass

    _sidecar_scan_cache.clear()
    return jsonify({'success': True, 'ann_copied': ann_copied})


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
    dest     = data.get('dest', '').strip()
    if not selector or not dest:
        return jsonify({'error': 'selector and dest required'}), 400

    src_dir = _folder_selector_to_dir(selector)
    if not src_dir:
        return jsonify({'error': 'source folder not found'}), 404

    dest_parent = _resolve_dest_dir(dest)
    dest_dir    = dest_parent / src_dir.name
    if dest_dir.exists():
        return jsonify({'success': False, 'stderr': f'"{src_dir.name}" already exists at the destination.'}), 400

    try:
        shutil.move(str(src_dir), str(dest_dir))
        _rebuild_dir_indexes(dest_dir)

        # Remove from source parent's .index
        src_index = src_dir.parent / '.index'
        if src_index.exists():
            lines = [l for l in src_index.read_text().splitlines() if l != src_dir.name]
            src_index.write_text('\n'.join(lines) + '\n' if lines else '')

        # Add to dest parent's .index
        dest_index = dest_parent / '.index'
        if dest_index.exists():
            existing = dest_index.read_text().splitlines()
            if src_dir.name not in existing:
                dest_index.write_text('\n'.join(existing + [src_dir.name]) + '\n')

        env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
        src_nb  = selector.split(':')[0]
        dest_nb = dest.split(':')[0]
        subprocess.run(['git', 'add', '-A'], cwd=str(NB_DIR / src_nb), capture_output=True, env=env)
        subprocess.run(['git', 'commit', '-m', f'[nb] Move {selector} → {dest}'],
                       cwd=str(NB_DIR / src_nb), capture_output=True, env=env)
        if dest_nb != src_nb:
            subprocess.run(['git', 'add', '-A'], cwd=str(NB_DIR / dest_nb), capture_output=True, env=env)
            subprocess.run(['git', 'commit', '-m', f'[nb] Move {selector} → {dest}'],
                           cwd=str(NB_DIR / dest_nb), capture_output=True, env=env)

        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'stderr': str(e)})


@app.route('/api/folder/copy', methods=['POST'])
def api_folder_copy():
    """Copy an entire folder tree to a new location, rebuilding indexes properly."""
    data     = request.get_json() or {}
    selector = data.get('selector', '').strip()   # e.g. "acct_ref:hledger/"
    dest     = data.get('dest', '').strip()        # e.g. "home:" or "home:reference/"
    if not selector or not dest:
        return jsonify({'error': 'selector and dest required'}), 400

    src_dir = _folder_selector_to_dir(selector)
    if not src_dir:
        return jsonify({'error': 'source folder not found'}), 404

    dest_parent = _resolve_dest_dir(dest)
    dest_copy   = dest_parent / src_dir.name
    if dest_copy.exists():
        return jsonify({'success': False, 'stderr': f'"{src_dir.name}" already exists at the destination.'}), 400

    try:
        shutil.copytree(src_dir, dest_copy, ignore=shutil.ignore_patterns('.git'))
        _rebuild_dir_indexes(dest_copy)

        # Also add the new folder to the parent's .index
        parent_index = dest_parent / '.index'
        if parent_index.exists():
            existing = parent_index.read_text().splitlines()
            if src_dir.name not in existing:
                parent_index.write_text('\n'.join(existing + [src_dir.name]) + '\n')

        dest_nb    = dest.split(':')[0]
        dest_nb_dir = NB_DIR / dest_nb
        import subprocess as _sp
        _sp.run(['git', 'add', '-A'], cwd=dest_nb_dir, capture_output=True)
        _sp.run(['git', 'commit', '-m', f'[nb] Copy {selector} → {dest}'],
                cwd=dest_nb_dir, capture_output=True)

        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'stderr': str(e)})


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
    # codeblock_access isn't a settings.json key (see _SETTINGS_SCHEMA) -- it
    # lives in ~/.nb/.nb.md's frontmatter, resolved via _effective_setting().
    # Merged in read-only here so the frontend's _cbAccess gate (nbweb-codeblocks.js)
    # has something real to read; a PATCH naming it still 400s as an unknown setting.
    resp = dict(_settings)
    resp['codeblock_access'] = _effective_setting('codeblock_access') or {}
    return jsonify(resp)


@app.route('/api/locale')
def api_locale():
    lang = (_effective_setting('lang') or 'en')
    locale_path = Path(__file__).parent / 'locales' / f'{lang}.json'
    if not locale_path.exists():
        locale_path = Path(__file__).parent / 'locales' / 'en.json'
    try:
        return app.response_class(
            response=locale_path.read_text(encoding='utf-8'),
            mimetype='application/json'
        )
    except Exception:
        return jsonify({}), 500


# ---------------------------------------------------------------------------
# Plugin manager
# ---------------------------------------------------------------------------

@app.route('/nb-web-plugins/<path:filename>')
def serve_web_plugin(filename):
    """Serve managed plugin JS files from ~/.nb/.web/plugins/."""
    return send_from_directory(str(WEB_PLUGINS_DIR), filename)


_COURIER_PRIME_DIR = WEB_DIR / 'external' / 'nbweb-cine-fonts'
_COURIER_PRIME_ALLOWED = {
    'Courier Prime.otf', 'Courier Prime Bold.otf',
    'Courier Prime Italic.otf', 'Courier Prime Bold Italic.otf',
}

@app.route('/fonts/courier-prime/<path:filename>')
def serve_courier_prime(filename):
    """Serve Courier Prime OTF files bundled with the nbweb-cine plugin."""
    if filename not in _COURIER_PRIME_ALLOWED or not _COURIER_PRIME_DIR.is_dir():
        return '', 404
    return send_from_directory(str(_COURIER_PRIME_DIR), filename)


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


@app.route('/api/nb/plugin-activate', methods=['POST'])
def api_nb_plugin_activate():
    """Write a plugin config file into a notebook directory to activate that plugin."""
    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), 'admin'):
        return jsonify({'error': 'Admin access required'}), 403
    body        = request.get_json(silent=True) or {}
    notebook    = (body.get('notebook') or '').strip()
    config_file = (body.get('config_file') or '').strip()
    default_cfg = body.get('default_config', {})
    if not notebook or not config_file:
        return jsonify({'error': 'notebook and config_file required'}), 400
    if not re.match(r'^\.nb-[\w-]+\.json$', config_file):
        return jsonify({'error': 'config_file must match .nb-<name>.json'}), 400
    nb_path = NB_DIR / notebook
    if not nb_path.is_dir() or not (nb_path / '.index').exists():
        return jsonify({'error': f'Notebook not found: {notebook}'}), 404
    dest = nb_path / config_file
    if dest.exists():
        return jsonify({'error': f'{config_file} already exists in {notebook}'}), 409
    try:
        content = json.dumps(default_cfg, indent=2) if isinstance(default_cfg, dict) else '{}'
        dest.write_text(content + '\n', encoding='utf-8')
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    return jsonify({'ok': True, 'path': str(dest)})


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
    else:
        nb_cfg = _notebook_config(notebook)
        config = nb_cfg.get('cine') or {}

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

    _project = request.args.get('project', '').strip()
    storylines_dir = nb_path / 'storylines'
    if _project:
        storylines_dir = storylines_dir / _project
    lanes           = []
    _story_raws     = []   # collected before lane lookup is built
    _milestone_raws = []

    # New convention: master storyline note may live at storylines/{project}.md
    # (one level above the project subfolder) rather than inside the subfolder.
    # Check for it first so it gets an is_storyline lane even when not in the glob below.
    if _project:
        _master = nb_path / 'storylines' / f'{_project}.md'
        if _master.is_file():
            try:
                _mraw = _master.read_text(errors='replace')
                _mmeta, _ = parse_frontmatter(_mraw)
                if str(_mmeta.get('type', '')).strip().lower() in ('plotline', 'storyline'):
                    _morders = {k[len('order_'):]: v for k, v in _mmeta.items()
                                if k.startswith('order_') and str(v).strip()}
                    lanes.append({
                        'selector':     f'{notebook}:storylines/{_master.name}',
                        'filename':     _master.name,
                        'stem':         _master.stem,
                        'title':        str(_mmeta.get('title', _master.stem)),
                        'color':        str(_mmeta.get('color', '')),
                        'seq':          _cine_int(_mmeta.get('seq'), 999),
                        'is_storyline': True,
                        'orders':       _morders,
                    })
            except Exception:
                pass

    if storylines_dir.is_dir():
        for f in sorted(storylines_dir.glob('*.md')):
            try:
                raw_text = f.read_text(errors='replace')
                meta, body = parse_frontmatter(raw_text)
                ftype = str(meta.get('type', '')).strip().lower()
                stem  = f.stem
                _sl_rel = f'storylines/{_project + "/" if _project else ""}{f.name}'
                if ftype in ('plotline', 'storyline'):
                    orders = {k[len('order_'):]: v
                              for k, v in meta.items()
                              if k.startswith('order_') and str(v).strip()}
                    lanes.append({
                        'selector':     f'{notebook}:{_sl_rel}',
                        'filename':     f.name,
                        'stem':         stem,
                        'title':        str(meta.get('title', stem)),
                        'color':        str(meta.get('color', '')),
                        'seq':          _cine_int(meta.get('seq'), 999),
                        'is_storyline': ftype == 'storyline',
                        'orders':       orders,
                    })
                elif ftype == 'story':
                    _story_raws.append((f, meta, stem, body))
                elif ftype == 'milestone':
                    _milestone_raws.append((f, meta, stem, body))
            except Exception:
                pass

    # Resolve storyline: by stem OR title (natural to write the title)
    _lane_lookup = {}
    for lane in lanes:
        _lane_lookup[lane['stem'].lower()]          = lane['stem']
        _lane_lookup[lane['title'].strip().lower()] = lane['stem']

    stories = []
    for f, meta, stem, body in _story_raws:
        raw_sl     = str(meta.get('plotline', '') or meta.get('storyline', '')).strip()
        storyline  = _lane_lookup.get(raw_sl.lower(), raw_sl)
        scenes_raw = meta.get('scenes', '')
        stories.append({
            'selector':     f'{notebook}:storylines/{_project + "/" if _project else ""}{f.name}',
            'filename':     f.name,
            'stem':         stem,
            'title':        str(meta.get('title', stem)).strip(),
            'plotline':     storyline,
            'seq':          _cine_int(meta.get('seq'), 999),
            'story_seq':    _cine_int(meta.get('story_seq')),   # None when unset
            'scenes':       _resolve_scene_refs(scenes_raw),
            'scenes_raw':   str(scenes_raw),
            'color':        str(meta.get('color', '')),
            'body_preview': body.strip()[:280] if body else '',
            'meta':         {k: v for k, v in meta.items() if k != 'type'},
        })

    milestones = []
    for f, meta, stem, body in _milestone_raws:
        milestones.append({
            'selector':      f'{notebook}:storylines/{_project + "/" if _project else ""}{f.name}',
            'filename':      f.name,
            'stem':          stem,
            'title':         str(meta.get('title', stem)).strip(),
            'milestone_seq': _cine_int(meta.get('milestone_seq')),
            'story_seq':     _cine_int(meta.get('story_seq')),
            'body_preview':  body.strip()[:280] if body else '',
            'meta':          {k: v for k, v in meta.items() if k != 'type'},
        })
    milestones.sort(key=lambda m: (m['milestone_seq'] is None, m['milestone_seq'] or 0))

    lanes.sort(key=lambda l: (0 if l['is_storyline'] else 1, l['seq']))
    stories.sort(key=lambda s: (s['plotline'], s['seq']))

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
        'milestones':    milestones,
        'orphan_scenes': orphan_scenes,
    })


def _patch_fm_fields(raw_text, **fields):
    """Update specific frontmatter fields in-place, preserving all other content.

    Processes line-by-line to avoid regex \s* consuming newlines into the key
    prefix, which caused blank-line corruption when writing empty values.
    Also drops orphaned bare-integer continuation lines (e.g. 'day:\\n1').

    A note with no frontmatter block at all (e.g. a plain `nb todo add`
    note -- just `# [ ] Title`, no `---`) gets one created, rather than
    silently no-op'ing. Confirmed real 2026-07-10: every #agent todo is
    exactly this shape, so refusing to add fields here meant tokens:/
    status:/claude_ask: never landed on the single most common target for
    them -- "doesn't have FM yet" is the reason to add it, not a reason
    to refuse.
    """
    if not raw_text.startswith('---'):
        new_fm = '\n'.join(f'{k}: {v}' if v != '' else f'{k}:' for k, v in fields.items())
        return f"---\n{new_fm}\n---\n{raw_text}"
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
            storyline = str(move.get('plotline') or move.get('storyline', ''))
            seq       = int(move.get('seq', 0))
        except (TypeError, ValueError):
            errors.append({'selector': selector, 'error': 'invalid seq'})
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

        # story_seq / milestone_seq: absent = don't touch; null = clear; integer = set
        patch = {}
        if storyline:
            patch['plotline'] = storyline
        if seq:
            patch['seq'] = seq
        if 'story_seq' in move:
            ss = move['story_seq']
            patch['story_seq'] = '' if ss is None else int(ss)
        if 'milestone_seq' in move:
            ms = move['milestone_seq']
            patch['milestone_seq'] = '' if ms is None else int(ms)

        try:
            raw     = fpath.read_text(errors='replace')
            patched = _patch_fm_fields(raw, **patch)
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


@app.route('/api/cine/storyline/order', methods=['POST'])
def api_cine_storyline_order():
    """Save a named storyline order to the storyline note's frontmatter.

    Body: {notebook, selector, name, order}
      selector — the storyline note (type:storyline)
      name     — order name (alphanumeric/underscore/hyphen)
      order    — comma-separated filename stems; empty string to delete
    """
    data     = request.get_json(silent=True) or {}
    selector = data.get('selector', '').strip()
    name     = data.get('name', '').strip()
    order    = str(data.get('order', ''))

    if not selector or not name:
        return jsonify({'error': 'selector and name required'}), 400
    if not re.match(r'^[a-z0-9_-]+$', name, re.I):
        return jsonify({'error': 'name must be alphanumeric, underscore, or hyphen'}), 400

    fpath = _resolve_to_nb_path(selector)
    if not fpath or not fpath.is_file():
        return jsonify({'error': 'storyline note not found'}), 404

    notebook = data.get('notebook', '')
    if not notebook:
        try:
            notebook = str(fpath.relative_to(NB_DIR).parts[0])
        except ValueError:
            pass

    raw     = fpath.read_text(errors='replace')
    key     = f'order_{name}'
    if order:
        patched = _patch_fm_fields(raw, **{key: order})
    else:
        # Delete: strip the key line from frontmatter
        patched = _patch_fm_fields(raw, **{key: ''})

    fpath.write_text(patched)

    nb_path = NB_DIR / notebook
    if nb_path.is_dir() and (nb_path / '.git').exists():
        try:
            subprocess.run(['git', 'add', '-A'], capture_output=True,
                           cwd=str(nb_path), timeout=10)
            subprocess.run(
                ['git', 'commit', '-m', f'[nb-web] Save storyline order "{name}"'],
                capture_output=True, cwd=str(nb_path), timeout=10)
        except Exception:
            pass

    return jsonify({'ok': True, 'name': name, 'order': order})


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
    storyline = (data.get('plotline', '') or data.get('storyline', '')).strip()
    _project  = data.get('project', '').strip()

    if not notebook or not title:
        return jsonify({'error': 'notebook and title required'}), 400

    nb_path        = NB_DIR / notebook
    storylines_dir = nb_path / 'storylines'
    if _project:
        storylines_dir = storylines_dir / _project
    if not nb_path.is_dir():
        return jsonify({'error': 'notebook not found'}), 404

    storylines_dir.mkdir(parents=True, exist_ok=True)

    # Auto-assign seq: max existing seq in this lane + 1
    seq = data.get('seq')
    if seq is None:
        max_seq = 0
        if storylines_dir.is_dir():
            for f in storylines_dir.glob('*.md'):
                try:
                    m, _ = parse_frontmatter(f.read_text(errors='replace'))
                    if str(m.get('type', '')).strip().lower() == 'story' \
                            and (str(m.get('plotline', '') or m.get('storyline', '')).strip()) == storyline:
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
        scaffold = _patch_fm_fields(scaffold, plotline=storyline, seq=seq)
    elif global_tmpl.exists():
        scaffold = global_tmpl.read_text(errors='replace')
        scaffold = _resolve_template_vars(scaffold, title=title)
        scaffold = _patch_fm_fields(scaffold, plotline=storyline, seq=seq)
    else:
        # Minimal hardcoded scaffold — works before the template exists
        scaffold = (
            f'---\ntype: story\ntitle: {title}\nplotline: {storyline}\n'
            f'seq: {seq}\nscenes:\ncharacters:\ndesc:\n---\n'
        )

    fpath.write_text(scaffold)

    # Update nb index and git commit
    selector = f'{notebook}:storylines/{_project + "/" if _project else ""}{fpath.name}'
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


@app.route('/api/cine/milestone/create', methods=['POST'])
def api_cine_milestone_create():
    """Create a new milestone note in storylines/<project>/.

    Body: {"notebook": "Takeout", "title": "Picture Lock", "project": "makemovies",
           "milestone_seq": 1}
    Returns: {"selector": "...", "ok": true}
    """
    data         = request.get_json(silent=True) or {}
    notebook     = data.get('notebook', '').strip()
    title        = data.get('title', '').strip()
    _project     = data.get('project', '').strip()
    milestone_seq = data.get('milestone_seq')

    if not notebook or not title:
        return jsonify({'error': 'notebook and title required'}), 400

    nb_path        = NB_DIR / notebook
    storylines_dir = nb_path / 'storylines'
    if _project:
        storylines_dir = storylines_dir / _project
    if not nb_path.is_dir():
        return jsonify({'error': 'notebook not found'}), 404

    storylines_dir.mkdir(parents=True, exist_ok=True)

    if milestone_seq is None:
        max_seq = 0
        for f in storylines_dir.glob('*.md'):
            try:
                m, _ = parse_frontmatter(f.read_text(errors='replace'))
                if str(m.get('type', '')).strip().lower() == 'milestone':
                    max_seq = max(max_seq, int(m.get('milestone_seq') or 0))
            except Exception:
                pass
        milestone_seq = max_seq + 1

    slug  = re.sub(r'[^a-z0-9]+', '_', title.lower()).strip('_')[:48]
    fpath = storylines_dir / f'{slug}.md'
    counter = 1
    while fpath.exists():
        fpath = storylines_dir / f'{slug}_{counter}.md'
        counter += 1

    scaffold = (
        f'---\ntype: milestone\ntitle: {title}\n'
        f'milestone_seq: {milestone_seq}\n---\n'
    )
    fpath.write_text(scaffold)

    rel_stem = f'storylines/{_project + "/" if _project else ""}{fpath.name}'
    selector = f'{notebook}:{rel_stem}'

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
                ['git', 'commit', '-m', f'[nb-web] Add milestone: {title}'],
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


_AW_BIN = Path(__file__).parent / 'node_modules' / '.bin' / 'afterwriting'


def _build_fountain(notebook):
    """Return (fountain_text, title_slug) for all script/ scenes in alias order.

    Reads cover note (type: script) for title-page FM. Skips non-numeric aliases.
    Raises ValueError with a message on structural errors.
    """
    nb_path    = NB_DIR / notebook
    script_dir = nb_path / 'script'
    if not nb_path.is_dir():
        raise ValueError('notebook not found')
    if not script_dir.is_dir():
        raise ValueError('no script/ folder')

    cover_meta = {}
    for f in script_dir.glob('*.md'):
        if f.name.startswith('.'):
            continue
        try:
            meta, _ = parse_frontmatter(f.read_text(errors='replace'))
            if str(meta.get('type', '')) == 'script':
                cover_meta = meta
                break
        except Exception:
            pass

    parts = []
    if cover_meta:
        for key, val in [('Title',      cover_meta.get('title')),
                         ('Credit',     cover_meta.get('credit', 'Written by') if cover_meta.get('author') else None),
                         ('Author',     cover_meta.get('author')),
                         ('Source',     cover_meta.get('source')),
                         ('Draft Date', cover_meta.get('draft')),
                         ('Copyright',  f"© {cover_meta['copyright']}" if cover_meta.get('copyright') else None),
                         ('Contact',    cover_meta.get('contact'))]:
            if val:
                parts.append(f'{key}: {val}')
    if parts:
        parts.append('')
        parts.append('')

    scenes = []
    for f in script_dir.glob('*.md'):
        if f.name.startswith('.'):
            continue
        try:
            meta, body = parse_frontmatter(f.read_text(errors='replace'))
            alias = str(meta.get('alias', ''))
            if not alias.isdigit():
                continue
            scenes.append((int(alias), meta, body.strip()))
        except Exception:
            pass
    scenes.sort(key=lambda x: x[0])

    for _, meta, body in scenes:
        ie  = 'INT.' if str(meta.get('int_ext',   '')).upper().startswith('I') else 'EXT.'
        dn  = 'DAY'  if str(meta.get('day_night', '')).upper().startswith('D') else 'NIGHT'
        loc = str(meta.get('loc', '')).upper()
        parts.append(f'{ie} {loc} - {dn}')
        parts.append('')
        parts.append(body)
        parts.append('')
        parts.append('')

    title = str(cover_meta.get('title', notebook))
    slug  = re.sub(r'[^\w\s-]', '', title).strip()
    slug  = re.sub(r'\s+', '-', slug).lower() or 'script'
    return '\n'.join(parts), slug, cover_meta


@app.route('/api/cine/export-fountain')
def api_cine_export_fountain():
    """Download all script/ scenes as a .fountain file."""
    notebook = request.args.get('notebook', '').strip()
    if not notebook:
        return jsonify({'error': 'notebook required'}), 400
    try:
        content, slug, _ = _build_fountain(notebook)
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    return Response(
        content,
        mimetype='text/plain; charset=utf-8',
        headers={'Content-Disposition': f'attachment; filename="{slug}.fountain"'}
    )


@app.route('/api/cine/export-pdf')
def api_cine_export_pdf():
    """Generate a WGA-format PDF via afterwriting and return it as a download."""
    notebook = request.args.get('notebook', '').strip()
    if not notebook:
        return jsonify({'error': 'notebook required'}), 400
    if not _AW_BIN.exists():
        return jsonify({'error': 'afterwriting not installed (run: npm install afterwriting)'}), 503
    try:
        content, slug, cover_meta = _build_fountain(notebook)
    except ValueError as e:
        return jsonify({'error': str(e)}), 404

    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / f'{slug}.fountain'
        out = Path(tmp) / f'{slug}.pdf'
        src.write_text(content, encoding='utf-8')
        paper   = str(cover_meta.get('paper', 'usletter')).lower().replace(' ', '')
        profile = 'usletter' if paper in ('usletter', 'letter', 'us') else 'a4'
        result = subprocess.run(
            [str(_AW_BIN), '--source', str(src), '--pdf', str(out), '--overwrite',
             '--setting', f'print_profile={profile}'],
            capture_output=True, timeout=60
        )
        if not out.exists():
            err = result.stderr.decode(errors='replace') or result.stdout.decode(errors='replace')
            return jsonify({'error': f'afterwriting failed: {err[:200]}'}), 500
        pdf_bytes = out.read_bytes()

    return Response(
        pdf_bytes,
        mimetype='application/pdf',
        headers={'Content-Disposition': f'attachment; filename="{slug}.pdf"'}
    )


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
    # Under gunicorn, os.execv-ing *this worker* would re-exec the Python
    # interpreter with gunicorn's own argv (not app.py's) -- nonsensical,
    # and a real incident: it crashed the worker (exit 127) every time,
    # 2026-07-19. Detected via SERVER_SOFTWARE (WSGI environ, set by
    # gunicorn) while still inside request context -- request is a
    # context-local proxy, unusable from the background thread below, so
    # capture the bool now rather than reading it in _do_restart.
    is_gunicorn = 'gunicorn' in request.environ.get('SERVER_SOFTWARE', '').lower()

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
        if is_gunicorn:
            # SIGHUP to the arbiter (our parent process) is gunicorn's own
            # graceful reload: re-imports app.py, replaces workers one at a
            # time, never drops the listening socket.
            os.kill(os.getppid(), signal.SIGHUP)
            return
        _kill_zombies()
        time.sleep(0.5)  # let zombies die before we take the port
        for fd in range(3, 256):
            try: os.close(fd)
            except OSError: pass
        os.execv(sys.executable, [sys.executable] + sys.argv)
    threading.Thread(target=_do_restart, daemon=True).start()
    return jsonify({'ok': True})


# ---------------------------------------------------------------------------
# Themes
# ---------------------------------------------------------------------------

THEMES_DIR = NB_DIR / '.themes'

@app.route('/api/themes')
def api_themes():
    themes = []
    if THEMES_DIR.exists():
        for f in sorted(THEMES_DIR.glob('*.md')):
            try:
                meta, _ = parse_frontmatter(f.read_text())
                themes.append({
                    'name':  meta.get('name', f.stem),
                    'slug':  f.stem,
                    'dark':  meta.get('dark', {}),
                    'light': meta.get('light', {}),
                })
            except Exception:
                pass
    return jsonify(themes)

@app.route('/api/theme/<slug>')
def api_theme(slug):
    if '/' in slug or slug.startswith('.'):
        return jsonify({'error': 'invalid'}), 400
    path = THEMES_DIR / f'{slug}.md'
    if not path.exists():
        return jsonify({'error': 'not found'}), 404
    try:
        meta, _ = parse_frontmatter(path.read_text())
        return jsonify({
            'name':  meta.get('name', slug),
            'slug':  slug,
            'dark':  meta.get('dark',  {}),
            'light': meta.get('light', {}),
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/theme-set-key', methods=['POST'])
def api_theme_set_key():
    """Write a single FM key into a notebook or folder dotfile."""
    data     = request.json or {}
    notebook = data.get('notebook', '')
    folder   = data.get('folder', '')
    key      = data.get('key', '')
    value    = data.get('value', '')
    if not notebook or not key:
        return jsonify({'error': 'notebook and key required'}), 400
    nb_path = NB_DIR / notebook
    if not nb_path.is_dir():
        return jsonify({'error': 'notebook not found'}), 404
    if folder:
        cfg_path = nb_path / folder / f'.{folder.split("/")[-1]}.md'
    else:
        cfg_path = nb_path / '.notebook'
    try:
        text = cfg_path.read_text() if cfg_path.exists() else '---\ntype: dotfile\n---\n'
        meta, body = parse_frontmatter(text)
        meta[key] = value
        import yaml
        new_fm   = yaml.dump(meta, default_flow_style=False, allow_unicode=True).strip()
        new_text = f'---\n{new_fm}\n---\n{body}'
        cfg_path.write_text(new_text)
        return jsonify({'ok': True, 'path': str(cfg_path)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/theme-save', methods=['POST'])
def api_theme_save():
    data = request.json or {}
    name = (data.get('name') or '').strip() or 'Untitled'
    slug = (data.get('slug') or '').strip().lower()
    if not slug:
        slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-') or 'theme'
    slug = re.sub(r'[^a-z0-9-]', '', slug)
    if not slug or slug.startswith('.') or '/' in slug:
        return jsonify({'error': 'invalid slug'}), 400
    desc  = (data.get('desc') or '').strip()
    dark  = data.get('dark',  {})
    light = data.get('light', {})
    import yaml
    meta    = {'type': 'theme', 'name': name, 'dark': dark, 'light': light}
    body    = f'\n{desc}' if desc else ''
    content = f"---\n{yaml.dump(meta, default_flow_style=False, allow_unicode=True).strip()}\n---\n{body}"
    THEMES_DIR.mkdir(exist_ok=True)
    (THEMES_DIR / f'{slug}.md').write_text(content)
    return jsonify({'ok': True, 'slug': slug})


@app.route('/api/theme-delete/<slug>', methods=['DELETE'])
def api_theme_delete(slug):
    if '/' in slug or slug.startswith('.') or slug == 'default':
        return jsonify({'error': 'cannot delete'}), 400
    path = THEMES_DIR / f'{slug}.md'
    if not path.exists():
        return jsonify({'error': 'not found'}), 404
    path.unlink()
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

    Persisting via `nb set auto_sync 0` writes ~/.nbrc, which is not writable
    under this image's --read-only root filesystem -- confirmed live
    2026-07-20 the write silently failed there for months (masked by this
    function's own success-check, which only looked for "set to 0" in output
    and printed the same reassuring message on failure as on success) while
    nb's auto_sync quietly ran at its own built-in default on every `nb`
    invocation inside the container. The real fix is the Containerfile's own
    `ENV NB_AUTO_SYNC=0` (wins over .nbrc's file default per nb's own
    `${NB_AUTO_SYNC:-0}` convention, no write required) -- this function now
    just verifies that actually took effect, rather than trying to re-persist
    it, and fails loudly instead of masking the gap a second way.
    """
    try:
        r = subprocess.run([NB_BIN, 'settings', 'get', 'auto_sync'],
                           capture_output=True, text=True, timeout=5)
        value = r.stdout.strip()
        if value == '0':
            print('[nb-web] NB_AUTO_SYNC: OK (0)', flush=True)
        else:
            print(f'[nb-web] NB_AUTO_SYNC IS NOT 0 (got {value!r}) -- cross-notebook '
                  f'contamination risk is live. Check ENV NB_AUTO_SYNC=0 in the '
                  f'Containerfile and that it actually reached this process.', flush=True)
    except Exception as e:
        print(f'[nb-web] NB_AUTO_SYNC check failed: {e}', flush=True)


# ---------------------------------------------------------------------------
# API: nbweb-claude Rung 1 — headless claude CLI shell-out
# ---------------------------------------------------------------------------
# tech-gated deliberately, not the full per-level access this will eventually
# need: shells out to the HOST MACHINE's own authenticated `claude` CLI, so
# every click uses the same one Anthropic account regardless of who's asking.
# That's fine today (single real user, djp, on his own laptop) but doesn't
# generalize past one self-hosted operator -- a real per-user auth story
# (MCP wrapper + per-session credentials, or a vendor-key SaaS mode) is a
# known, deferred gap, not an oversight. See claude:nbweb-claude v2 design
# doc's "Deferred/future" section and the security-architecture thread.
#
# The MCP wrapper piece IS built (nbweb-claude's mcp_server.py, sibling repo):
# a scoped token minted below rides in an env var into that subprocess, so
# its own calls back to /api/* run as the asking user, not the host operator.
# That closes the "zero tool access" gap in the shell-out, but not the
# whose-Anthropic-account-pays gap above -- still one CLI, one host.

_NBWEB_CLAUDE_MCP_SERVER = WEB_DIR / 'external' / 'nbweb-claude' / 'mcp_server.py'


def _build_context_prompt(selector, context):
    """One-line 'what is the user currently looking at' blurb for
    --append-system-prompt. Purely informational -- never touches an access
    decision, so client-supplied values need no validation here; MCP tool
    calls still independently re-check _can_access on every real data pull.
    """
    parts = []
    if selector:
        parts.append(f"note {selector}")
    notebook = (context.get('notebook') or '').strip()
    if notebook:
        parts.append(f"notebook '{notebook}'")
    folder = (context.get('folder') or '').strip()
    if folder:
        parts.append(f"folder '{folder}'")
    active_cmd = (context.get('activeCmd') or '').strip()
    if active_cmd:
        parts.append(f"view '{active_cmd}'")
    sort_mode = (context.get('sortMode') or '').strip()
    if sort_mode and sort_mode != 'default':
        parts.append(f"sort '{sort_mode}'")
    search_query = (context.get('searchQuery') or '').strip()
    if search_query:
        parts.append(f'search "{search_query}"')
    tags_query = (context.get('tagsQuery') or '').strip()
    if tags_query:
        parts.append(f'tags "{tags_query}"')
    note_type = (context.get('noteType') or '').strip()
    if note_type:
        parts.append(f"type '{note_type}'")
    note_help = (context.get('noteHelp') or '').strip()
    if note_help:
        parts.append(f"help topic '{note_help}' available via .lib/help-type-{note_help}.md")
    if not parts:
        return ''
    return 'Current nb-web view: ' + ', '.join(parts) + '.'


def _build_note_text_block(context):
    """The focused note's own body text, handed over directly rather than
    requiring a get_note round-trip for content the user is already looking
    at. Capped client-side (nbweb-claude.js) before it ever reaches here;
    this is just presentation, not the size limit itself.
    """
    text = (context.get('noteText') or '').strip()
    if not text:
        return ''
    return 'Full text of the note currently open (read this before deciding to look anything up):\n\n' + text


_AGENT_SESSIONS_PATH = NB_DIR / 'claude' / 'accounting' / 'agent_sessions.md'


_MODEL_CONTEXT_WINDOWS = {
    'sonnet': 1_000_000, 'opus': 1_000_000, 'fable': 1_000_000, 'haiku': 200_000,
}


def _extract_usage(payload, model=None):
    """Real, measured values only (duration_ms, usage, total_cost_usd from
    the claude -p JSON response) -- shared by the ledger write and the
    note's own claude_context: update so both agree on the same numbers,
    never a self-reported estimate either place.

    context_pct is the input side only (input + cache_creation +
    cache_read, not output) -- that's what the model actually had to hold
    to generate this turn's response, which is the "how close to the wall
    was this" question, not "how much did this turn cost total" (that's
    what `tokens` is for). Each turn's own usage already reflects the
    accumulated conversation history at that point in a --resume'd
    session, so this is a real, current snapshot, not something that
    needs to be summed across turns.
    """
    usage      = payload.get('usage') or {}
    input_side = (usage.get('input_tokens', 0) + usage.get('cache_creation_input_tokens', 0)
                  + usage.get('cache_read_input_tokens', 0))
    tokens      = input_side + usage.get('output_tokens', 0)
    cost        = payload.get('total_cost_usd', 0) or 0
    hours       = round(payload.get('duration_ms', 0) / 1000 / 3600, 4)
    window      = _MODEL_CONTEXT_WINDOWS.get(model, 1_000_000)
    context_pct = round(input_side / window * 100, 1) if window else 0
    return tokens, cost, hours, context_pct


def _log_agent_session(model, notebook, selector, session_id, tokens, cost, hours,
                        context_pct, account=''):
    """Append one timedot entry per /api/claude/ask call to
    claude:accounting/agent_sessions.md -- the single source of truth for
    token/cost accounting (a note's own FM only ever gets a cheap current
    snapshot, claude_context:, never a cumulative total -- querying this
    ledger is how you get a real total, not a second bookkeeping system
    tracking the same fact). context_pct logged per-entry so a future
    richer view (a segmented history bar, one color per turn) can be
    reconstructed from these entries directly -- not built yet, this is
    just making sure the data needed for it exists from day one.

    Account is the resolved claude_account: cascade when a note/notebook
    actually set one (e.g. nb-web:help) -- real project/aspect accounting,
    matching the same convention dev_timelog.md already uses by hand.
    Falls back to a model-based label (claude-modal:<model>) for anything
    untagged, so every entry still has *some* account rather than a guess.
    Model is always logged in the comment either way, so per-model cost
    stays queryable (grep) even when the account itself is project-based.

    Pure append, never rewrites existing content -- same file-safety
    reasoning as everywhere else in this repo that avoids --overwrite-
    shaped bugs: nothing here can ever corrupt a prior entry, worst case
    is a missing one if this itself throws.
    """
    try:
        date    = datetime.now().strftime('%Y-%m-%d')
        account = account or f'claude-modal:{model or "default"}'
        comment = (f'session: {session_id} · notebook: {notebook} · '
                   f'selector: {selector} · model: {model or "default"} · '
                   f'tokens: {tokens} · cost: ${cost:.4f} · context: {context_pct}%')
        block = (f'\n## {date}\n```timedot\n{date}\n'
                 f'{account}  {hours}  ; {comment}\n```\n')
        with open(_AGENT_SESSIONS_PATH, 'a') as f:
            f.write(block)
        env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
        nb_root = NB_DIR / 'claude'
        subprocess.run(['git', 'add', 'accounting/agent_sessions.md'],
                       cwd=str(nb_root), capture_output=True, env=env)
        subprocess.run(['git', 'commit', '-m', f'[nb] Log agent session: {model or "default"}'],
                       cwd=str(nb_root), capture_output=True, env=env)
    except Exception:
        pass  # logging must never break the actual answer path


def _ensure_note_ai_stats_baseline(selector):
    """Write claude_status: the moment an ask starts, before the (possibly
    slow, possibly abandoned) claude -p call even runs -- confirmed real
    2026-07-10: a slow response or an abandoned tab shouldn't mean the note
    never shows any trace that something was asked. 'initiated' is a floor
    marker, not a claim of progress -- safe to (re)write unconditionally.
    Namespaced claude_status:/claude_context: (not the generic status:) --
    status: is already a core nb-web FM key with its own, different
    meaning (a project's own lifecycle, e.g. status: active/draft);
    writing the bare key would have silently clobbered that on any note
    that already used it, confirmed real risk 2026-07-10, caught before
    shipping. claude_ask: and claude_context: aren't written here -- the
    session id and context level genuinely aren't known until the call
    completes, and the client's own fresh-start block already gives
    instant visual feedback regardless of FM state.
    """
    try:
        fpath = _resolve_to_nb_path(selector)
        if not fpath or not fpath.is_file():
            return
        raw = fpath.read_text(errors='replace')
        fields = {'claude_status': 'initiated'}
        # Stamp type: todo the first time a session touches a plain todo --
        # never overrides an existing type (a type:project note asked a
        # question stays type:project), and only for notes that actually
        # look like a todo (# [ ] / # [x] body) so an ordinary note never
        # gets mislabeled. classify() already infers 'todo' from filename
        # regardless of this -- the point of stamping it into FM is making
        # it a real, visible fact on the note once a real session exists,
        # not just an internal classification.
        meta, body = parse_frontmatter(raw)
        if 'type' not in meta and body.lstrip().startswith(('# [ ]', '# [x]')):
            fields['type'] = 'todo'
        patched = _patch_fm_fields(raw, **fields)
        if patched == raw:
            return  # nothing to change -- skip a no-op commit
        fpath.write_text(patched)
        notebook = fpath.relative_to(NB_DIR).parts[0]
        nb_path  = NB_DIR / notebook
        if (nb_path / '.git').exists():
            env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
            subprocess.run(['git', 'add', str(fpath)], capture_output=True, cwd=str(nb_path), env=env)
            subprocess.run(['git', 'commit', '-m', f'[nb-web] AI stats: {fpath.name} (started)'],
                           capture_output=True, cwd=str(nb_path), env=env)
    except Exception:
        pass  # never break the ask path


def _update_note_ai_stats(selector, context_pct, session_id='', status=None):
    """claude_context: (current window-fill snapshot, overwritten each
    call -- not cumulative, there's nothing to sum: it's "how full is the
    window right now") and, when known, claude_ask: session id -- written
    at the same checkpoint as the accounting ledger entry, one
    read-patch-write-commit pass, not two. Token/cost totals live only in
    the ledger (claude:accounting/agent_sessions.md, _log_agent_session)
    -- deliberately no cumulative token counter here, that would be a
    second bookkeeping system tracking the same fact the ledger already
    tracks correctly. claude_ask: <session_id> is what lets the claude_ask
    barblock (nbweb-claude.js) resume the same conversation next time the
    note is opened, instead of only remembering it for as long as the
    browser tab stays on that page.

    status, when given, overrides claude_status -- used only by the
    circuit-breaker/timeout path (status='waiting', the same "stopped,
    needs feedback" red-bar meaning the list-row visual spec already
    defines) so a tripped run is visibly distinct from one still quietly
    sitting at its 'initiated' baseline. A normal completion passes
    nothing here and leaves claude_status untouched, same as before.
    """
    try:
        fpath = _resolve_to_nb_path(selector)
        if not fpath or not fpath.is_file():
            return
        raw = fpath.read_text(errors='replace')
        fields = {'claude_context': context_pct}
        if session_id:
            fields['claude_ask'] = session_id
        if status:
            fields['claude_status'] = status
        patched = _patch_fm_fields(raw, **fields)
        fpath.write_text(patched)
        notebook = fpath.relative_to(NB_DIR).parts[0]
        nb_path  = NB_DIR / notebook
        if (nb_path / '.git').exists():
            env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
            subprocess.run(['git', 'add', str(fpath)], capture_output=True, cwd=str(nb_path), env=env)
            subprocess.run(['git', 'commit', '-m', f'[nb-web] AI stats: {fpath.name}'],
                           capture_output=True, cwd=str(nb_path), env=env)
    except Exception:
        pass  # never break the answer path


_CLAUDE_SESSION_PLACEHOLDER = '__NBWEB_SESSION__'

_CLAUDE_WRITE_GUIDANCE = (
    "You have an append_to_note MCP tool that appends content to the current "
    "note's body. This is a firm rule, not a judgment call: whenever your "
    "response involves writing or describing an actual code change -- not "
    "just answering a question in prose -- always append a fenced "
    "```claude_code codeblock via append_to_note, every single time, even if "
    "your prose answer is itself complete and correct. The person on the "
    "other end wants to watch the real work happen (commits landing, files "
    "changing) and be able to interrupt if something goes sideways -- an "
    "accurate description of a change is not a substitute for showing it "
    "happen live. Do not decide the work 'doesn't count' as commands just "
    "because you reached it through MCP tools rather than a shell -- if code "
    "changed or will change, open the terminal. Write the command as exactly "
    f"\"claude --resume {_CLAUDE_SESSION_PLACEHOLDER}\" -- {_CLAUDE_SESSION_PLACEHOLDER} "
    "is a literal placeholder token (copy it verbatim, do not invent a "
    "session id yourself); the server substitutes the real session id in "
    "after your response, once it's known. Do not add a `|label` suffix -- no "
    "pipe character at all -- or the block sits as a pending click-to-launch "
    "widget instead of starting immediately; the whole point is that it's "
    "already running by the time the person looks at the note. Use "
    "append_to_note for anything that should persist in the note itself "
    "(codeblocks, timedot entries, working notes); keep your direct answer "
    "for conversation. After using "
    "append_to_note, call the reload_note tool once so the note refreshes "
    "in the user's browser -- otherwise they won't see the change until "
    "they refresh it themselves. When referring to a note in your reply, use "
    "the numeric selector (e.g. docs:29) internally for tool calls and links, "
    "but when describing it in prose use notebook:Title (the exact title the "
    "tool returned) instead -- an id number means nothing to the person "
    "reading the answer. You also have create_note, toggle_todo, and "
    "set_annotation -- each wraps the same endpoint the UI itself uses for "
    "that action (see .rules/mcp-tools.md). Prefer these over append_to_note "
    "when the request actually matches one of them (creating a new note, "
    "closing a todo, setting an annotation) -- append_to_note is for content "
    "that belongs inside an existing note's body (codeblocks, timedot "
    "entries, working notes), not a substitute for the more specific tool. "
    "Before calling create_note, always call list_templates first -- if a "
    "template matches the note's intended type, pass its path as "
    "template_path rather than hand-writing the note's shape yourself."
)

_CLAUDE_GOAL_GUIDANCE = (
    "This note may carry a /goal-mode setup, written via the set_goal_fields "
    "tool: claude_goal: (a completion condition), claude_goal_bound: (a turn "
    "count), and claude_goal_scope: (comma-separated file patterns the work "
    "must stay within). Only call set_goal_fields when the user explicitly "
    "asks you to draft, propose, or revise a goal for this note -- never "
    "propose one unprompted, and never invoke /goal yourself; a human "
    "reviews and launches it separately (the Run Goal button), which is "
    "the whole point of writing the proposal to FM instead of just saying "
    "it in chat. "
    "A good condition names one measurable end state and how to prove it "
    "-- 'grep confirms zero hardcoded colors remain in styles.css', not "
    "'make the CSS better'. Whatever must actually happen has to be *in* "
    "the condition text itself: the evaluator that checks a running goal "
    "only judges the stated condition against what you've surfaced in the "
    "conversation, never anything from a todo's surrounding prose or your "
    "own chat reply -- confirmed real, a goal that completed correctly "
    "still skipped an unstated 'also bump sw.js' instruction because it was "
    "only ever in the note's body text, not the condition. Do not fold a "
    "turn or time limit into the condition text (no 'or stop after N "
    "turns' inside claude_goal: itself) -- that belongs in claude_goal_bound: "
    "as a plain integer, appended automatically only when the goal is "
    "actually launched. Propose claude_goal_scope: whenever the task's "
    "file footprint is inferable (a single file, a directory, or a glob) "
    "-- it's a real safety guardrail the server enforces externally, not "
    "just documentation of intent. After calling set_goal_fields, call "
    "reload_note so the proposal is visible immediately, and still explain "
    "what you proposed and why in your own reply -- the FM write is the "
    "durable, editable record; the chat explanation is what the human "
    "actually reads to decide whether to launch it. "
    "Before drafting a goal, check this note's current FM for "
    "claude_account: -- if it's missing, say so in your reply (don't "
    "silently proceed). Without it, this session's working directory "
    "falls back to the notes notebook instead of the actual code repo, "
    "so CLAUDE.md and other project context never get a chance to "
    "auto-load. Suggest a value if the todo's own content makes the "
    "project obvious (e.g. mentions of app.py/main.js -> nb-web), but "
    "never set it yourself -- there's no tool for that, and it's a "
    "deliberate human decision: setting claude_account: on a note that "
    "already has an active claude_ask: session breaks that session's "
    "ability to --resume from a different working directory than it "
    "originally started in (confirmed real 2026-07-12) -- safe to add "
    "before a session exists, never to 'fix' one already in progress."
)

_HAIKU_RULES_PATH = Path.home() / '.nb' / '.rules' / 'haiku.md'


def _load_haiku_guidance():
    """Assistant-mode system prompt for haiku-tier sessions, replacing
    _CLAUDE_WRITE_GUIDANCE entirely rather than combining with it -- the
    dev-oriented write/codeblock instructions don't apply to this tier.
    Read fresh every call (not cached) so edits to haiku.md take effect on
    the next question, no server restart needed -- it's just a file read,
    not a code change. Empty string (not an exception) if the file is
    missing, so a not-yet-written rules file degrades to "no special
    guidance" rather than a 500.
    """
    try:
        return _HAIKU_RULES_PATH.read_text(errors='replace')
    except OSError:
        return ''


def _substitute_session_placeholder(selector, session_id):
    """Fill in the real session_id after the fact -- Claude can't know its
    own session_id while still generating the answer that contains it (only
    surfaces in the JSON envelope after the CLI process exits), so it writes
    a literal placeholder via append_to_note and this closes the loop in the
    same request, right after the id becomes known. No-ops if the
    placeholder isn't present (most answers don't use it).
    """
    fpath = _resolve_to_nb_path(selector)
    if not fpath or not fpath.is_file():
        return
    try:
        text = fpath.read_text(errors='replace')
    except OSError:
        return
    if _CLAUDE_SESSION_PLACEHOLDER not in text:
        return
    fpath.write_text(text.replace(_CLAUDE_SESSION_PLACEHOLDER, session_id))
    nb_root = NB_DIR / selector.split(':')[0]
    env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
    try:
        rel = fpath.relative_to(nb_root)
        subprocess.run(['git', 'add', str(rel)], cwd=str(nb_root), capture_output=True, env=env)
        subprocess.run(['git', 'commit', '-m', '[nb] Edit: fill in claude session id'],
                        cwd=str(nb_root), capture_output=True, env=env)
    except ValueError:
        pass


@app.route('/api/claude/mark-reload', methods=['POST'])
def api_claude_mark_reload():
    """Called by the reload_note MCP tool, immediately after append_to_note.
    Flips a per-token flag that api_claude_ask checks once the CLI process
    exits, so the *same* general-purpose refresh action a human triggers via
    the toolbar button also fires for Claude -- one mechanism, two callers,
    not a Claude-only side channel."""
    token = request.headers.get('X-Nbweb-Mcp-Token')
    entry = _MCP_TOKENS.get(token)
    if not entry:
        return jsonify({'error': 'invalid or expired MCP token'}), 401
    entry['reload'] = True
    return jsonify({'ok': True})


@app.route('/api/claude/set-permissions', methods=['POST'])
def api_claude_set_permissions():
    """Set the claude_permissions: scope for a note -- the checkbox row
    next to Ask in the claude_ask barblock calls this on every change.
    Read fresh by _claude_permission_flags() at the moment a claude_code
    terminal actually spawns, so a checkbox change takes effect on the
    next launch without needing to touch an already-running session.
    """
    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), 'tech'):
        return jsonify({'error': 'forbidden'}), 403
    data     = request.get_json(silent=True) or {}
    selector = (data.get('selector') or '').strip()
    perms    = data.get('permissions') or []
    if not selector:
        return jsonify({'error': 'selector required'}), 400
    valid = [p for p in perms if p in _CLAUDE_PERMISSION_SCOPES]
    try:
        fpath = _resolve_to_nb_path(selector)
        if not fpath or not fpath.is_file():
            return jsonify({'error': 'not found'}), 404
        raw = fpath.read_text(errors='replace')
        patched = _patch_fm_fields(raw, claude_permissions=','.join(valid))
        fpath.write_text(patched)
        notebook = fpath.relative_to(NB_DIR).parts[0]
        nb_path  = NB_DIR / notebook
        if (nb_path / '.git').exists():
            env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
            subprocess.run(['git', 'add', str(fpath)], capture_output=True, cwd=str(nb_path), env=env)
            subprocess.run(['git', 'commit', '-m', f'[nb-web] Claude permissions: {fpath.name}'],
                           capture_output=True, cwd=str(nb_path), env=env)
        return jsonify({'success': True, 'permissions': valid})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/claude/set-account', methods=['POST'])
def api_claude_set_account():
    """Set claude_account: on a note -- the pre-flight config modal's
    Account field. Same shape as /api/claude/set-permissions exactly
    (_patch_fm_fields + scoped commit). No validation against
    .manifest.md's own repo list here -- the field's <datalist> already
    steers toward real names, but a value naming an aspect
    (nb-web:help) or a not-yet-registered project is still a legitimate
    thing to type, same tolerance _resolve_repo_cwd itself already has.
    """
    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), 'tech'):
        return jsonify({'error': 'forbidden'}), 403
    data     = request.get_json(silent=True) or {}
    selector = (data.get('selector') or '').strip()
    account  = str(data.get('account') or '').strip()
    if not selector:
        return jsonify({'error': 'selector required'}), 400
    try:
        fpath = _resolve_to_nb_path(selector)
        if not fpath or not fpath.is_file():
            return jsonify({'error': 'not found'}), 404
        raw = fpath.read_text(errors='replace')
        patched = _patch_fm_fields(raw, claude_account=account)
        fpath.write_text(patched)
        notebook = fpath.relative_to(NB_DIR).parts[0]
        nb_path  = NB_DIR / notebook
        if (nb_path / '.git').exists():
            env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
            subprocess.run(['git', 'add', str(fpath)], capture_output=True, cwd=str(nb_path), env=env)
            subprocess.run(['git', 'commit', '-m', f'[nb-web] Claude account: {fpath.name}'],
                           capture_output=True, cwd=str(nb_path), env=env)
        return jsonify({'success': True, 'account': account})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/claude/repo-files')
def api_claude_repo_files():
    """Real filenames for the pre-flight config modal's File scope
    <datalist> -- git ls-files against the repo a selector (or an
    explicit, possibly-unsaved account override) resolves to, so scope
    patterns can be picked from what's actually there instead of typed
    blind. Capped well short of anything that would make the datalist
    unwieldy; not meant to replace a real file browser.
    """
    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), 'tech'):
        return jsonify({'error': 'forbidden'}), 403
    selector = (request.args.get('selector') or '').strip()
    account  = (request.args.get('account') or '').strip()
    if account:
        project = account.split(':')[0].strip()
        local = _manifest_repo_paths().get(project)
        path = Path(local).expanduser() if local else None
        cwd = str(path) if path and path.is_dir() else ''
    else:
        cwd = _resolve_repo_cwd(selector) if selector else ''
    if not cwd:
        return jsonify({'files': []})
    result = _repo_git(Path(cwd), 'ls-files')
    if result.returncode != 0:
        return jsonify({'files': []})
    files = [f for f in result.stdout.splitlines() if f.strip()][:300]
    return jsonify({'files': files})


@app.route('/api/claude/set-goal', methods=['POST'])
def api_claude_set_goal():
    """Write claude_goal:/claude_goal_bound:/claude_goal_scope: onto a note
    -- the backing endpoint for the set_goal_fields MCP tool, the mechanism
    that turns "draft me a goal" into a durable, editable, reviewable fact
    on the note instead of just chat prose the human would have to
    transcribe into FM by hand before the Run Goal button has anything to
    read. Only a field actually present in the request body is touched --
    the tool only sends the ones it means to set/revise, so calling this
    to fix just the bound doesn't clobber an already-good condition or
    scope back to empty.
    """
    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), 'tech'):
        return jsonify({'error': 'forbidden'}), 403
    data     = request.get_json(silent=True) or {}
    selector = (data.get('selector') or '').strip()
    if not selector:
        return jsonify({'error': 'selector required'}), 400

    fields = {}
    if 'goal' in data:
        fields['claude_goal'] = str(data.get('goal') or '')
    if 'scope' in data:
        fields['claude_goal_scope'] = str(data.get('scope') or '')
    if 'bound' in data:
        bound = data.get('bound')
        if bound in (None, ''):
            fields['claude_goal_bound'] = ''
        else:
            try:
                fields['claude_goal_bound'] = str(int(bound))
            except (TypeError, ValueError):
                return jsonify({'error': 'bound must be an integer'}), 400
    if not fields:
        return jsonify({'error': 'nothing to set'}), 400

    try:
        fpath = _resolve_to_nb_path(selector)
        if not fpath or not fpath.is_file():
            return jsonify({'error': 'not found'}), 404
        raw = fpath.read_text(errors='replace')
        patched = _patch_fm_fields(raw, **fields)
        fpath.write_text(patched)
        notebook = fpath.relative_to(NB_DIR).parts[0]
        nb_path  = NB_DIR / notebook
        if (nb_path / '.git').exists():
            env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
            subprocess.run(['git', 'add', str(fpath)], capture_output=True, cwd=str(nb_path), env=env)
            subprocess.run(['git', 'commit', '-m', f'[nb-web] Claude goal proposed: {fpath.name}'],
                           capture_output=True, cwd=str(nb_path), env=env)
        return jsonify({'success': True, **fields})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/claude/end-session', methods=['POST'])
def api_claude_end_session():
    """Explicit session-end action -- kills the tmux session backing any
    claude_code terminal for this note (best-effort, fine if none is
    running) and marks claude_status: stopped, so an ended session
    actually stops looking like something still in flight instead of
    persisting in whatever state it was last left in. Deliberately not
    claude_status: done -- "done" reads as the task finished
    successfully, which a human-initiated stop never claims; falls
    through to the default grey the same as any other unrecognized
    status (working/waiting/done are the only colored ones), correctly
    distinct from a genuine successful completion. This is the piece that
    was missing before tmux persistence shipped -- sessions could run
    forever with nothing to explicitly close them.
    """
    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), 'tech'):
        return jsonify({'error': 'forbidden'}), 403
    data     = request.get_json(silent=True) or {}
    selector = (data.get('selector') or '').strip()
    if not selector:
        return jsonify({'error': 'selector required'}), 400
    try:
        fpath = _resolve_to_nb_path(selector)
        if not fpath or not fpath.is_file():
            return jsonify({'error': 'not found'}), 404
        raw = fpath.read_text(errors='replace')
        meta, _ = parse_frontmatter(raw)
        session_id = str(meta.get('claude_ask', '') or '')
        if session_id and shutil.which('tmux'):
            tmux_name = 'claude-' + re.sub(r'[^a-zA-Z0-9_-]', '', session_id)
            subprocess.run(['tmux', 'kill-session', '-t', tmux_name], capture_output=True)
        patched = _patch_fm_fields(raw, claude_status='stopped')
        fpath.write_text(patched)
        notebook = fpath.relative_to(NB_DIR).parts[0]
        nb_path  = NB_DIR / notebook
        if (nb_path / '.git').exists():
            env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0'}
            subprocess.run(['git', 'add', str(fpath)], capture_output=True, cwd=str(nb_path), env=env)
            subprocess.run(['git', 'commit', '-m', f'[nb-web] Claude session ended: {fpath.name}'],
                           capture_output=True, cwd=str(nb_path), env=env)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _ledger_cost_for_selector(selector):
    """Sum tokens/cost from claude:accounting/agent_sessions.md for a given
    selector -- the ledger is the single source of truth (_log_agent_session),
    this queries it fresh rather than trusting any cached total. Read-only,
    tolerant of any parse issue (returns zeros rather than erroring the page).
    """
    total_tokens, total_cost, entries = 0, 0.0, 0
    try:
        text = _AGENT_SESSIONS_PATH.read_text(errors='replace')
    except OSError:
        return {'tokens': 0, 'cost': 0.0, 'entries': 0}
    needle = f'selector: {selector} ·'
    for line in text.splitlines():
        if needle not in line:
            continue
        m_tok  = re.search(r'tokens:\s*(\d+)', line)
        m_cost = re.search(r'cost:\s*\$([\d.]+)', line)
        if m_tok:
            total_tokens += int(m_tok.group(1))
        if m_cost:
            total_cost += float(m_cost.group(1))
        entries += 1
    return {'tokens': total_tokens, 'cost': round(total_cost, 4), 'entries': entries}


@app.route('/api/claude/session-cost')
def api_claude_session_cost():
    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), 'tech'):
        return jsonify({'error': 'forbidden'}), 403
    selector = (request.args.get('selector') or '').strip()
    if not selector:
        return jsonify({'error': 'selector required'}), 400
    result = _ledger_cost_for_selector(selector)
    # The pre-flight config modal's spend/limits display reads these --
    # same module constants _stream_claude_ask's circuit breaker actually
    # enforces, not a second hardcoded copy that could drift.
    result['max_turns']      = _CLAUDE_MAX_TURNS
    result['max_new_tokens'] = _CLAUDE_MAX_NEW_TOKENS
    return jsonify(result)


def _stream_claude_ask(user, selector, question, context, resume):
    """Core claude -p / --resume runner -- shared by the synchronous POST
    endpoint (api_claude_ask) and the live websocket one (ws_claude_ask),
    so the circuit breaker, scope guardrail, rate-limit tracking, ledger
    logging, and FM updates all happen in exactly one place regardless of
    which transport a caller uses, rather than risking two copies drifting
    apart. A generator: yields live progress events as the stream arrives
    (kind: 'text' | 'tool_use' | 'rate_limit'), then exactly one final
    event (kind: 'done' with the full response dict shaped exactly like
    the old single-shot /api/claude/ask response, or kind: 'error' with a
    message + http status) once everything is finished -- normal
    completion, a circuit-breaker/scope trip, or a timeout, all the same
    as before this was split out. The POST endpoint drains this and
    returns only the final event, reproducing prior behavior unchanged;
    the websocket endpoint pushes every intermediate event live as it's
    yielded, then the same final one.
    """
    # cwd double-duty (design doc §4): run inside the note's notebook dir so
    # CLAUDE.md/.rules auto-load for free, same trick the real dev sessions use.
    # This is the fallback, not the first choice -- a todo living in the
    # `claude` notes notebook is very often actually *about* a different
    # codebase entirely (nb-web, tw-web, ...), and the notes notebook
    # itself never has that codebase's own CLAUDE.md in it. Confirmed real
    # 2026-07-12 (claude:87): an ask session cwd'd into ~/.nb/claude/ had
    # no way to discover nb-web existed at all.
    notebook = selector.split(':')[0] if ':' in selector else ''
    cwd = NB_DIR
    if notebook:
        candidate = NB_DIR / notebook
        if candidate.is_dir():
            cwd = candidate
    repo_cwd = _resolve_repo_cwd(selector) if selector else ''
    if repo_cwd:
        cwd = Path(repo_cwd)

    if selector:
        _ensure_note_ai_stats_baseline(selector)

    cmd = ['claude', '-p', question, '--output-format', 'stream-json', '--verbose']
    model = _resolve_claude_model_flag(selector)
    if model:
        cmd += ['--model', model]
    if resume:
        cmd += ['--resume', resume]
    scope_patterns = _resolve_claude_goal_scope(selector) if selector else []
    mcp_config_path = None
    token = None
    has_mcp = _NBWEB_CLAUDE_MCP_SERVER.exists()
    prompt_parts = []
    context_prompt = _build_context_prompt(selector, context)
    if context_prompt:
        prompt_parts.append(context_prompt)
    note_text_block = _build_note_text_block(context)
    if note_text_block:
        prompt_parts.append(note_text_block)
    if model == 'haiku':
        # Assistant mode: haiku.md replaces the dev-oriented write guidance
        # entirely -- not additive. Tool access is unchanged for now
        # (deliberately not narrowed yet), only the instructions are.
        haiku_guidance = _load_haiku_guidance()
        if haiku_guidance:
            prompt_parts.append(haiku_guidance)
    elif has_mcp:
        prompt_parts.append(_CLAUDE_WRITE_GUIDANCE)
        prompt_parts.append(_CLAUDE_GOAL_GUIDANCE)
        if _agent_protocol_enabled(selector, notebook):
            # Opt-in per notebook (or system-wide from root .nb.md) via
            # claude_agent: true -- not hardcoded to the `claude` notebook,
            # since a todo tagged #agent #discuss means the same thing
            # anywhere. An ask on a notebook that never opted in has no
            # use for this vocabulary, no reason to tax the call with it.
            agent_orientation = _load_agent_orientation()
            if agent_orientation:
                prompt_parts.append(agent_orientation)
    if prompt_parts:
        cmd += ['--append-system-prompt', '\n\n'.join(prompt_parts)]
    if has_mcp:
        token = _mint_mcp_token(user)
        mcp_config = {
            'mcpServers': {
                'nbweb': {
                    'command': 'python3',
                    'args':    [str(_NBWEB_CLAUDE_MCP_SERVER)],
                    'env': {
                        'NBWEB_MCP_TOKEN': token,
                        'NBWEB_MCP_BASE':  f'http://127.0.0.1:{PORT}',
                        'NBWEB_MCP_TIER':  'haiku' if model == 'haiku' else 'dev',
                    },
                },
            },
        }
        # Live queryable graph access alongside the static CLAUDE.md nudge --
        # confirmed 2026-07-12 that two independently-named servers under one
        # --strict-mcp-config both load and are both independently callable
        # (see claude:nbweb-claude_—_graphify_integration_2026-07-12.md #4).
        # Only added when the resolved cwd actually has a graph to serve --
        # graphify-mcp errors out immediately on a missing/empty graph.json,
        # so this must never be added speculatively.
        graphify_graph = Path(cwd) / 'graphify-out' / 'graph.json'
        if shutil.which('graphify-mcp') and graphify_graph.is_file():
            mcp_config['mcpServers']['graphify'] = {
                'command': 'graphify-mcp',
                'args':    [str(graphify_graph)],
            }
        fd, mcp_config_path = tempfile.mkstemp(prefix='nbweb-mcp-', suffix='.json')
        with os.fdopen(fd, 'w') as f:
            json.dump(mcp_config, f)
        cmd += ['--mcp-config', mcp_config_path, '--strict-mcp-config']

    # 300s, not 120s -- profiled 2026-07-10: a genuine multi-hop MCP task
    # isn't slow because of round-trip latency (measured ~10-150ms per
    # call, nowhere near enough to explain 120s on its own), it's slow
    # because a deep task legitimately needs many sequential reasoning
    # turns and each one takes real generation time. 120s was an arbitrary
    # wall a sufficiently complex task would always eventually hit; this
    # just moves the wall further out.
    #
    # Streaming Popen, not a single blocking subprocess.run() -- confirmed
    # live 2026-07-11/12 (see claude:nbweb-claude_—_goal_mode_exploration_
    # 2026-07-11.md): --output-format stream-json emits one JSON event per
    # line as the CLI works (system/init, assistant messages including
    # tool_use, tool_result, rate_limit_event, and a final type:result
    # event carrying exactly the same fields plain `json` mode used to
    # hand back in one shot -- so parsing that last event reproduces the
    # old behavior exactly). This is the foundation goal-mode's turn/cost
    # circuit-breaker, scope guardrail, and live UX all need -- none of
    # those are wired up here yet, none are buildable on a single blocking
    # call either. --verbose is not optional: the CLI refuses stream-json
    # under --print without it (confirmed by trying).
    #
    # stderr goes to a real tempfile, not PIPE -- reading two live pipes
    # concurrently without a dedicated drain thread risks the classic
    # subprocess deadlock the moment either OS pipe buffer fills; a
    # tempfile sidesteps that entirely since stderr's content is only
    # needed once, after the process has already exited.
    #
    # Circuit breaker -- confirmed real 2026-07-11/12 (see
    # claude:nbweb-claude_—_goal_mode_exploration_2026-07-11.md): a stated
    # "or stop after N turns" bound inside a /goal condition is prose the
    # model may or may not honor, not a mechanical limit -- a real test ran
    # 51 turns against a stated 15, and there's no --max-turns flag in this
    # CLI to lean on instead. This is the external enforcement that has to
    # exist regardless of what the condition text says. Tracks *token*
    # count, not a hardcoded dollar figure -- Anthropic's per-token pricing
    # already lives only in the `claude` CLI's own final response, never
    # duplicated here, and a hand-maintained price table would silently
    # drift stale. new_tokens deliberately excludes cache_read_input_tokens:
    # a resumed session's cache-read cost is cheap and mostly reflects
    # carrying forward existing history, not new work happening right now
    # -- counting it would penalize long, legitimate --resume'd
    # conversations for their own accumulated context. Thresholds are a
    # blunt safety net, not a calibrated budget system -- picked from the
    # one real data point so far (a genuine 51-turn/~93k-new-token Menu CSS
    # fix), generous enough not to interrupt real work like that, tight
    # enough to stop something an order of magnitude worse. Revisit once
    # more real usage exists, same posture as this doc's other budget
    # questions.
    stderr_fd, stderr_path = tempfile.mkstemp(prefix='nbweb-claude-stderr-', suffix='.log')
    stderr_file = os.fdopen(stderr_fd, 'w')
    stop_reason           = None   # None | 'timeout' | 'max_turns' | 'max_tokens' | 'scope'
    scope_breach          = ''
    proc                  = None
    timer                 = None
    init_session_id       = ''
    last_assistant_text   = ''
    last_usage            = {}
    turn_count            = 0
    new_tokens            = 0
    rate_limits           = {}   # rateLimitType -> latest rate_limit_info seen
    final_payload         = None
    try:
        try:
            proc = subprocess.Popen(
                cmd, cwd=str(cwd), stdout=subprocess.PIPE, stderr=stderr_file,
                text=True, bufsize=1,
            )
        except FileNotFoundError:
            yield {'kind': 'error', 'message': 'claude CLI not found on this host', 'status': 502}
            return

        def _on_timeout():
            nonlocal stop_reason
            stop_reason = stop_reason or 'timeout'
            proc.kill()

        timer = threading.Timer(300, _on_timeout)
        timer.start()

        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                evt = json.loads(line)
            except json.JSONDecodeError:
                continue
            etype = evt.get('type')
            if etype == 'system' and evt.get('subtype') == 'init':
                init_session_id = evt.get('session_id') or init_session_id
            elif etype == 'rate_limit_event':
                info = evt.get('rate_limit_info') or {}
                rl_type = info.get('rateLimitType', 'unknown')
                rate_limits[rl_type] = info
                yield {'kind': 'rate_limit', 'rate_limits': list(rate_limits.values())}
            elif etype == 'assistant':
                msg = evt.get('message') or {}
                for block in msg.get('content', []):
                    if block.get('type') == 'text' and block.get('text'):
                        last_assistant_text = block['text']
                        yield {'kind': 'text', 'text': block['text']}
                    elif block.get('type') == 'tool_use':
                        tool_name  = block.get('name', '')
                        tool_input = block.get('input') or {}
                        yield {'kind': 'tool_use', 'name': tool_name,
                               'summary': _summarize_tool_input(tool_name, tool_input)}
                        if scope_patterns and tool_name in _SCOPE_CHECKED_TOOLS:
                            touched = tool_input.get('file_path', '')
                            if touched and not _path_in_scope(touched, cwd, scope_patterns):
                                stop_reason  = 'scope'
                                scope_breach = touched
                usage = msg.get('usage') or {}
                if usage:
                    last_usage  = usage
                    new_tokens += (usage.get('input_tokens', 0)
                                   + usage.get('cache_creation_input_tokens', 0)
                                   + usage.get('output_tokens', 0))
                turn_count += 1
                if stop_reason == 'scope':
                    proc.kill()
                    break
                if turn_count >= _CLAUDE_MAX_TURNS:
                    stop_reason = 'max_turns'
                    proc.kill()
                    break
                if new_tokens >= _CLAUDE_MAX_NEW_TOKENS:
                    stop_reason = 'max_tokens'
                    proc.kill()
                    break
            elif etype == 'result':
                final_payload = evt
        proc.wait()
    finally:
        if timer:
            timer.cancel()
        stderr_file.close()
        if mcp_config_path:
            try:
                os.unlink(mcp_config_path)
            except OSError:
                pass

    try:
        stderr_text = Path(stderr_path).read_text(errors='replace').strip()
    except OSError:
        stderr_text = ''
    try:
        os.unlink(stderr_path)
    except OSError:
        pass

    # Stopped early (timeout or circuit breaker) -- still real, spent
    # tokens, so still logged to the ledger and reflected on the note, not
    # silently dropped the way a plain subprocess.run timeout always used
    # to be (no partial visibility existed before the streaming switch).
    # claude_status: waiting reuses the existing "stopped/needs feedback"
    # red-bar meaning the list-row visual spec already defines -- no new
    # status vocabulary needed. Session id is still known (from system/init,
    # captured before the kill), so the note stays --resume-able.
    if stop_reason:
        reason_text = {
            'timeout':    'the CLI call timed out (300s)',
            'max_turns':  f'turn limit reached ({_CLAUDE_MAX_TURNS} turns)',
            'max_tokens': f'token limit reached ({_CLAUDE_MAX_NEW_TOKENS:,} new tokens)',
            'scope':      f'tried to write outside the declared scope ({scope_breach})',
        }[stop_reason]
        payload    = {'usage': last_usage}
        session_id = init_session_id
        answer     = ((last_assistant_text + '\n\n') if last_assistant_text else '') + \
                     f'⚠ Stopped early: {reason_text}. Session is still resumable.'
    elif final_payload is None:
        if proc.returncode != 0:
            yield {'kind': 'error', 'message': stderr_text or 'claude exited non-zero', 'status': 502}
            return
        payload    = {}
        answer     = last_assistant_text
        session_id = init_session_id
    else:
        payload    = final_payload
        answer     = payload.get('result') or last_assistant_text or ''
        session_id = payload.get('session_id') or init_session_id

    account  = _resolve_claude_account(selector) if selector else ''
    tokens, cost, hours, context_pct = _extract_usage(payload, model)
    _log_agent_session(model, notebook, selector, session_id, tokens, cost, hours,
                        context_pct, account)
    if selector:
        _update_note_ai_stats(selector, context_pct, session_id,
                               status='waiting' if stop_reason else None)

    if session_id and selector:
        _substitute_session_placeholder(selector, session_id)

    # Read back the note's current FM state so the client can refresh its
    # claude_ask header (status dot, context%, account) straight from this
    # response -- a plain conversational turn doesn't set reload_flag (that
    # only fires when Claude wrote to the note body), so without this the
    # header would otherwise show stale data until the next full note load.
    header_fields = {'claude_status': '', 'claude_context': '', 'claude_account': ''}
    if selector:
        try:
            fpath = _resolve_to_nb_path(selector)
            if fpath and fpath.is_file():
                meta, _ = parse_frontmatter(fpath.read_text(errors='replace'))
                header_fields['claude_status']  = meta.get('claude_status', '')
                header_fields['claude_context'] = meta.get('claude_context', '')
                header_fields['claude_account'] = _resolve_claude_account(selector)
        except Exception:
            pass

    reload_flag = bool(token and _MCP_TOKENS.get(token, {}).get('reload'))
    yield {'kind': 'done', 'response': {
        'answer': answer, 'reload': reload_flag, 'session_id': session_id,
        'rate_limits': list(rate_limits.values()),
        **header_fields,
    }}


@app.route('/api/claude/ask', methods=['POST'])
def api_claude_ask():
    """Synchronous wrapper around _stream_claude_ask -- drains the
    generator, discarding intermediate progress events (nothing here
    needs them), and returns exactly its final 'done'/'error' event.
    Same request/response shape as before this was split out. Prefer
    ws_claude_ask (below) for anything that wants live progress.
    """
    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), 'tech'):
        return jsonify({'error': 'forbidden'}), 403

    data     = request.get_json(silent=True) or {}
    selector = (data.get('selector') or '').strip()
    question = (data.get('question') or '').strip()
    context  = data.get('context') or {}
    resume   = (data.get('resume') or '').strip()
    if not question:
        return jsonify({'error': 'question required'}), 400

    for evt in _stream_claude_ask(user, selector, question, context, resume):
        if evt['kind'] == 'error':
            return jsonify({'error': evt['message']}), evt['status']
        if evt['kind'] == 'done':
            return jsonify(evt['response'])
    return jsonify({'error': 'no response from claude'}), 502  # defensive; shouldn't happen


@sock.route('/ws/claude-ask')
def ws_claude_ask(ws):
    """Live-streaming counterpart to /api/claude/ask -- same tech-level
    gate, same core runner (_stream_claude_ask), but pushes every
    intermediate event (assistant text, tool calls, rate-limit updates)
    to the browser the moment it's yielded instead of blocking until the
    whole call finishes. The synchronous POST endpoint is untouched and
    still exists for anything that doesn't need live progress.

    If the client goes away mid-stream, sends just stop being attempted
    (client_gone) -- the generator is still drained to exhaustion
    regardless, because its own tail (ledger logging, FM update) has to
    run either way, same as a plain HTTP request whose browser tab closed
    mid-request doesn't stop the server-side handler from finishing.
    """
    user = session.get('user', {})
    if not _level_gte(user.get('level', ''), 'tech'):
        try:
            ws.send(json.dumps({'kind': 'error', 'message': 'forbidden', 'status': 403}))
        except Exception:
            pass
        return

    first = ws.receive(timeout=10)
    if not first:
        return
    try:
        data = json.loads(first)
    except json.JSONDecodeError:
        try:
            ws.send(json.dumps({'kind': 'error', 'message': 'invalid request', 'status': 400}))
        except Exception:
            pass
        return

    selector = (data.get('selector') or '').strip()
    question = (data.get('question') or '').strip()
    context  = data.get('context') or {}
    resume   = (data.get('resume') or '').strip()
    if not question:
        try:
            ws.send(json.dumps({'kind': 'error', 'message': 'question required', 'status': 400}))
        except Exception:
            pass
        return

    client_gone = False
    for evt in _stream_claude_ask(user, selector, question, context, resume):
        if client_gone:
            continue
        try:
            ws.send(json.dumps(evt))
        except Exception:
            client_gone = True


if __name__ == '__main__':
    WEB_PLUGINS_DIR.mkdir(parents=True, exist_ok=True)
    _assert_nb_auto_sync_off()
    _assert_notebook_tracking()
    _install_prepush_hooks()
    os.environ.pop('WERKZEUG_RUN_MAIN', None)
    os.environ.pop('WERKZEUG_SERVER_FD', None)
    app.run(host=HOST, port=PORT, debug=DEBUG, use_reloader=False, threaded=True)

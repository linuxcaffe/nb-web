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

import shlex
import shutil
import socket

from flask import Flask, Response, jsonify, request, send_file, send_from_directory
from flask_sock import Sock

app = Flask(__name__, static_folder='.', static_url_path='')
sock = Sock(app)

NB_BIN  = os.environ.get('NB_BIN', 'nb')
NB_DIR  = Path(os.environ.get('NB_DIR', Path.home() / '.nb'))
HOST    = os.environ.get('NB_WEB_HOST', '127.0.0.1')
PORT    = int(os.environ.get('NB_WEB_PORT', 5001))

GLOBAL_TEMPLATES_DIR = NB_DIR / '.templates'
CMDS_FILE            = Path(__file__).parent / 'cmds.txt'

_RE_HEADING  = re.compile(r'^#{1,6}(\s|$)')   # true MD heading; bare #tag is not a heading
_RE_FENCE    = re.compile(r'^```')            # fenced code block opening/closing line

def _first_excerpt_line(body: str, meta: dict) -> str:
    """Return the best single-line excerpt for a note body.

    Priority: caption field → first non-heading, non-comment, non-fence body line.
    Entire fenced blocks are skipped so ` ```csv ` doesn't show as an excerpt.
    """
    if meta.get('caption'):
        return str(meta['caption'])[:120]
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
}

def _hledger_resolve_file(path_str):
    """Resolve and validate a ledger file path; returns Path or raises ValueError."""
    resolved = Path(os.path.expanduser(path_str)).resolve()
    if not resolved.is_relative_to(Path.home()):
        raise ValueError('File path must be within home directory')
    return resolved


@app.route('/api/hledger-query')
def api_hledger_query():
    """Run a read-only hledger report and return JSON or plain text."""
    q    = request.args.get('q', '').strip()
    args = q.split() if q else ['balance']

    # Positional file path: first token starting with ~ or / is the ledger file.
    file_path = None
    if args and (args[0].startswith('~') or args[0].startswith('/')):
        try:
            file_path = _hledger_resolve_file(args[0])
        except ValueError as e:
            return jsonify({'error': str(e)}), 403
        args = args[1:] or ['balance']

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
        try:
            data = json.loads(result.stdout or 'null')
            return jsonify({'cmd': cmd, 'data': data, **extra})
        except json.JSONDecodeError:
            return jsonify({'cmd': cmd, 'text': result.stdout.strip(), **extra})
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
    current_nb = 'home'
    try:
        cur_path = NB_DIR / '.current'
        if cur_path.exists():
            current_nb = cur_path.read_text().strip() or 'home'
    except Exception:
        pass
    notebook_prefs = _load_settings().get('notebook_prefs', {})
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

        if itype in BINARY_TYPES:
            title   = note_title(fname, '')
            excerpt = ''
            todo_status = None
        else:
            try:
                raw  = fpath.read_text(errors='replace')
                meta, body = parse_frontmatter(raw)
                title   = meta.get('title') or meta.get('name') or note_title(fname, body)
                excerpt = _first_excerpt_line(body, meta)
                todo_status = None
                if itype == 'todo':
                    first = next((l.strip() for l in body.splitlines() if l.strip()), '')
                    todo_status = 'closed' if first.startswith('# [x]') else 'open'
            except Exception:
                title = note_title(fname, '')
                excerpt = ''
                todo_status = None

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
    title = meta.get('title') or meta.get('name') or note_title(filename, body)

    tags = re.findall(r'#([\w/-]+)', body)
    if annotation_text:
        ann_tags = re.findall(r'#([\w/-]+)', annotation_text)
        tags = list(dict.fromkeys(tags + ann_tags))  # merge, dedupe, preserve order

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
        'annotation': annotation_text,
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

def _sidecar_parent(fname: str) -> str | None:
    """If fname is an annotation sidecar, return the parent filename. Otherwise None."""
    m = _SIDECAR_RE.match(fname or '')
    return m.group(1) if m else None


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
        slug = re.sub(r'[^\w]+', '_', title or 'note').strip('_').lower()
        # Clean slug when: subfolder note (items/ etc.) OR template-driven note.
        # Template = intentional structured content that needs a predictable URL.
        # Timestamp prefix reserved for casual root-level notes (no template).
        if folder or template_path:
            note_filename = f"{slug}.md"
        else:
            note_filename = f"{datetime.now().strftime('%Y%m%d%H%M%S')}_{slug}.md"
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

            notebooks.append({
                'name': entry.name, 'count': count, 'mtime': mtime,
                'folder_count': folder_count,
                'has_remote': has_remote, 'unpushed': unpushed,
                'is_current': entry.name == current_nb,
                'website': website,
            })
    except Exception as e:
        return jsonify({'error': str(e), 'notebooks': []})
    notebooks.sort(key=lambda n: n['mtime'], reverse=True)
    return jsonify({'notebooks': notebooks, 'current_notebook': current_nb})


@app.route('/api/website/config', methods=['GET', 'POST'])
def api_website_config():
    notebook = request.args.get('notebook') or (request.get_json() or {}).get('notebook', '')
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

    return jsonify({
        'name': notebook, 'count': count, 'mtime': mtime,
        'path': str(nb_path),
        'git': git_info,
        'prefs': nb_prefs,
        'default_remote': default_remote,
    })


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
# API: Rename / Move note
# ---------------------------------------------------------------------------

@app.route('/api/note/rename', methods=['POST'])
def api_rename():
    data     = request.get_json() or {}
    selector = data.get('selector', '').strip()
    name     = data.get('name', '').strip()
    if not selector or not name:
        return jsonify({'error': 'selector and name required'}), 400

    path_r = run_nb('show', selector, '--path')
    if not nb_ok(path_r):
        return jsonify({'error': 'not found'}), 404
    fpath = Path(path_r['stdout'].strip())

    # Encrypted notes: title is filename-only; preserve .enc by slugifying the new name
    if fpath.name.lower().endswith('.enc'):
        slug     = re.sub(r'[^\w]+', '_', name).strip('_').lower()
        new_name = f"{slug}.md.enc"
        r = run_nb('rename', selector, new_name, '--force')
        return jsonify({'success': nb_ok(r), 'stderr': strip_ansi(r['stderr'])})

    # Read current content so we can update the title-bearing element in place.
    # nb rename only changes the filename; if the title comes from an H1 or
    # frontmatter, the displayed title would not change after a plain rename.
    try:
        raw = fpath.read_text(errors='replace')
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
    _assert_nb_auto_sync_off()
    _assert_notebook_tracking()
    _install_prepush_hooks()
    os.environ.pop('WERKZEUG_RUN_MAIN', None)
    os.environ.pop('WERKZEUG_SERVER_FD', None)
    app.run(host=HOST, port=PORT, debug=True, use_reloader=False)

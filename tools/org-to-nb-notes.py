#!/usr/bin/env python3
"""
Convert an .org tutorial file into nb-formatted markdown notes.

Usage:
    python3 tools/org-to-nb-notes.py <source.org> <notebook-path> [notebook-name]

Example:
    python3 tools/org-to-nb-notes.py \
        ~/dev/awesome-hledger/contrib-resources/hledger-beginner-tutorial.org \
        ~/.nb/accts/tutorial \
        accts

Each level-2 heading becomes a note. Preamble → 00_overview.md.

Transformations applied:
  - #+BEGIN_SRC ledger  →  ```ledger  (Prism display only, not executed)
  - ; prose comment     →  stripped (org comment marker removed)
  - ; $ hledger cmd     →  [cmd](term:cmd)  clickable terminal link
  - ';' inside fences   →  preserved (hledger comment syntax)
  - cross-section refs  →  [[wikilinks]] to sibling notes
"""

import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote as _urlquote


def pandoc_convert(org_file: Path) -> str:
    # commonmark: no {.lang} attributes (outputs ``` ledger directly),
    # $ sign preserved (not escaped like markdown does).
    r = subprocess.run(
        ['pandoc', '-f', 'org', '-t', 'commonmark', '--wrap=none', str(org_file)],
        capture_output=True, text=True, check=True
    )
    return r.stdout


def clean_body(text: str, section_index: dict[str, str]) -> str:
    """
    section_index: {title_lower → note_filename_stem}
    Used to turn mentions of other section titles into wikilinks.
    """
    lines = text.split('\n')
    out = []
    in_fence = False

    for line in lines:
        # Track code fence open/close (any line starting with ```)
        if re.match(r'^```', line):
            in_fence = not in_fence

        if in_fence:
            out.append(line)
            continue

        # Outside code fences: org prose comment → strip '; ' prefix
        if line.startswith('; '):
            line = line[2:]
        elif line == ';':
            line = ''

        out.append(line)

    text = '\n'.join(out)

    # ── Code fence languages ──────────────────────────────────────────────────
    # commonmark outputs "``` ledger" (space before lang) — remove the space
    text = re.sub(r'^``` (\w+)', r'```\1', text, flags=re.MULTILINE)
    # Any remaining {.lang} attribute fences (fallback) → plain
    text = re.sub(r'``` \{[^}]+\}', '```', text)

    # ── Shell command examples → term: links ──────────────────────────────────
    # Lines that look like:   $ hledger bal Assets --depth 2   # explanation
    # or:                     $ hledger balance  <-- sum is zero
    # Becomes: [hledger bal Assets --depth 2](term:hledger bal Assets --depth 2) — explanation
    def _term_link(m: re.Match) -> str:
        raw = m.group(1).strip()
        # Restore pandoc smart-typography: -- → – and --- → —
        raw = raw.replace('–', '--').replace('—', '---')
        # Unescape pandoc-escaped chars that appear in commands
        raw = re.sub(r'\\([<>!#])', r'\1', raw)
        # Split command from trailing inline comment (# or <--)
        comment_m = re.search(r'\s+(?:#|<--)\s*(.+)$', raw)
        cmd = re.sub(r'\s+(?:#|<--).*$', '', raw).strip()
        suffix = f'  — *{comment_m.group(1).strip()}*' if comment_m else ''
        # URL-encode the href: CommonMark disallows spaces in unbracketed URLs
        cmd_url = _urlquote(cmd, safe=':&/-+=.,@#!?;')
        return f'[{cmd}](term:{cmd_url}){suffix}'

    text = re.sub(r'^\$ (hledger\b.+)$', _term_link, text, flags=re.MULTILINE)

    # ── Cross-section wikilinks ───────────────────────────────────────────────
    # Only applied outside code fences (second pass, simpler since fences are
    # now clean markdown without {.} attributes).
    if section_index:
        text = _add_section_wikilinks(text, section_index)

    # ── Cleanup ───────────────────────────────────────────────────────────────
    # Unescape pandoc-escaped chars: \# \* \' \` \! \< \>
    text = re.sub(r"\\([#*'`!<>])", r'\1', text)
    # H3 → H2 within the note (sub-sections stay sub-sections)
    text = re.sub(r'^### ', '## ', text, flags=re.MULTILINE)

    return text.strip()


def _add_section_wikilinks(text: str, section_index: dict[str, str]) -> str:
    """Replace mentions of other section titles with wikilinks, outside fences."""
    lines = text.split('\n')
    out = []
    in_fence = False
    # Sort by length descending so longer titles match before shorter substrings
    titles_sorted = sorted(section_index.keys(), key=len, reverse=True)

    for line in lines:
        if re.match(r'^```', line):
            in_fence = not in_fence
        if in_fence or line.startswith('#'):
            out.append(line)
            continue
        for title_lower in titles_sorted:
            title_orig = section_index[title_lower]['title']
            filename   = section_index[title_lower]['filename']
            stem       = filename.replace('.md', '')
            # Only link if not already a wikilink or URL
            pattern = re.compile(
                r'(?<!\[\[)(?<!\w)(' + re.escape(title_orig) + r')(?!\w)(?!\]\])',
                re.IGNORECASE
            )
            if pattern.search(line):
                line = pattern.sub(
                    lambda m: f'[[{stem}|{m.group(1)}]]', line, count=1
                )
        out.append(line)
    return '\n'.join(out)


def split_sections(md: str) -> list[tuple[str | None, str]]:
    """Split on ATX H2 headings (## Title). Returns [(title, body), ...]."""
    lines = md.split('\n')
    sections: list[tuple[str | None, str]] = []
    cur_title: str | None = None
    cur_lines: list[str] = []

    for line in lines:
        if re.match(r'^# ', line):
            # H1 — document title, skip
            pass
        elif re.match(r'^## ', line):
            # H2 — start new section
            sections.append((cur_title, '\n'.join(cur_lines).strip()))
            cur_title = line[3:].strip()
            cur_lines = []
        else:
            cur_lines.append(line)

    sections.append((cur_title, '\n'.join(cur_lines).strip()))
    return sections


def slugify(title: str) -> str:
    return re.sub(r'[^\w]+', '_', title.lower()).strip('_') if title else 'overview'


def make_note(title: str | None, body: str, tags: list[str]) -> str:
    t = title or 'Overview'
    tag_str = ', '.join(tags)
    heading = f'# {t}\n\n'
    return f'---\ntitle: "{t}"\ntype: tutorial\ntags: [{tag_str}]\n---\n\n{heading}{body}\n'


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    org_file = Path(sys.argv[1]).expanduser()
    nb_dir   = Path(sys.argv[2]).expanduser()
    tags     = ['hledger', 'tutorial']

    if not org_file.exists():
        print(f'Error: {org_file} not found')
        sys.exit(1)

    print(f'Converting {org_file.name} ...')
    raw_md   = pandoc_convert(org_file)
    sections = split_sections(raw_md)

    # Build section index for cross-wikilinks (title → {title, filename})
    section_index: dict[str, dict] = {}
    filenames = []
    for seq, (title, _) in enumerate(sections):
        if not title and seq == 0:
            fname = '00_overview.md'
        elif title:
            fname = f'{seq:02d}_{slugify(title)}.md'
        else:
            continue
        filenames.append(fname)
        if title:
            section_index[title.lower()] = {'title': title, 'filename': fname}

    nb_dir.mkdir(parents=True, exist_ok=True)

    index_entries = []
    fname_iter = iter(filenames)
    for seq, (title, raw_body) in enumerate(sections):
        fname = next(fname_iter, None)
        if not fname:
            continue
        body = clean_body(raw_body, section_index)
        if not title and not body:
            continue
        content = make_note(title, body, tags)
        (nb_dir / fname).write_text(content)
        index_entries.append(fname)
        print(f'  {fname}  {title or "(overview)"}')

    (nb_dir / '.index').write_text('\n'.join(index_entries) + '\n')
    print(f'\n{len(index_entries)} notes → {nb_dir}')

    nb_root  = nb_dir.parent
    env_     = __import__('os').environ.copy()
    env_['GIT_TERMINAL_PROMPT'] = '0'
    subprocess.run(['git', 'add', '-A'], cwd=str(nb_root), capture_output=True, env=env_)
    r = subprocess.run(
        ['git', 'commit', '-m', f'[nb] Import hledger tutorial ({len(index_entries)} notes)'],
        cwd=str(nb_root), capture_output=True, text=True, env=env_
    )
    print('git commit: ok' if r.returncode == 0 else f'git: {r.stderr.strip() or r.stdout.strip()}')


if __name__ == '__main__':
    main()

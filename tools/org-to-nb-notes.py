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

Each level-2 heading in the org file becomes a separate note with nb frontmatter.
Preamble text before the first heading becomes note 00_overview.md.
"""

import re
import subprocess
import sys
from pathlib import Path


def pandoc_convert(org_file: Path) -> str:
    r = subprocess.run(
        ['pandoc', '-f', 'org', '-t', 'markdown-smart', '--wrap=none', str(org_file)],
        capture_output=True, text=True, check=True
    )
    return r.stdout


def clean_body(text: str) -> str:
    lines = text.split('\n')
    out = []
    for line in lines:
        # Org comment lines ("; text") become prose — strip the prefix
        if line.startswith('; '):
            out.append(line[2:])
        elif line == ';':
            out.append('')
        else:
            out.append(line)
    text = '\n'.join(out)

    # ``` {.ledger} → ```hledger  (Prism-compatible)
    text = re.sub(r'``` \{\.ledger\}', '```hledger', text)
    # ``` {.org} → ```  (org src blocks → plain)
    text = re.sub(r'``` \{[^}]*\}', '```', text)
    # Unescape pandoc-escaped special chars: \# \* \' → # * '
    text = re.sub(r"\\([#*'`])", r'\1', text)
    # H3 → H2 within the note (sub-sections stay sub-sections)
    text = re.sub(r'^### ', '## ', text, flags=re.MULTILINE)

    return text.strip()


def split_sections(md: str) -> list[tuple[str, str]]:
    """Split on setext H2 headings (heading text followed by a '---...' line)."""
    lines = md.split('\n')
    sections: list[tuple[str, str]] = []  # (title, body)
    cur_title: str | None = None
    cur_lines: list[str] = []

    i = 0
    while i < len(lines):
        next_line = lines[i + 1] if i + 1 < len(lines) else ''
        is_setext_h1 = bool(re.match(r'^={3,}$', next_line)) and lines[i].strip()
        is_setext_h2 = bool(re.match(r'^-{3,}$', next_line)) and lines[i].strip()

        if is_setext_h1:
            # Skip the document-level H1 title — not a note
            i += 2
        elif is_setext_h2:
            sections.append((cur_title, '\n'.join(cur_lines).strip()))
            cur_title = lines[i].strip()
            cur_lines = []
            i += 2
        else:
            cur_lines.append(lines[i])
            i += 1

    # Flush last section
    sections.append((cur_title, '\n'.join(cur_lines).strip()))
    return sections


def slugify(title: str) -> str:
    return re.sub(r'[^\w]+', '_', title.lower()).strip('_') if title else 'overview'


def make_note(title: str, body: str, tags: list[str]) -> str:
    tag_str = ', '.join(tags)   # YAML list value — no # prefix (that starts a comment)
    heading = f'# {title}\n\n' if title else ''
    return f'---\ntitle: "{title or "Overview"}"\ntags: [{tag_str}]\n---\n\n{heading}{body}\n'


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    org_file   = Path(sys.argv[1]).expanduser()
    nb_dir     = Path(sys.argv[2]).expanduser()
    nb_name    = sys.argv[3] if len(sys.argv) > 3 else nb_dir.parent.name
    tags       = ['hledger', 'tutorial']

    if not org_file.exists():
        print(f'Error: {org_file} not found')
        sys.exit(1)

    print(f'Converting {org_file.name} ...')
    md = pandoc_convert(org_file)
    sections = split_sections(md)

    nb_dir.mkdir(parents=True, exist_ok=True)

    index_entries = []
    for seq, (title, raw_body) in enumerate(sections):
        body = clean_body(raw_body)
        if not title and not body:
            continue
        prefix = f'{seq:02d}_' if seq > 0 else '00_'
        filename = f'{prefix}{slugify(title)}.md'
        content  = make_note(title, body, tags)
        dest = nb_dir / filename
        dest.write_text(content)
        index_entries.append(filename)
        label = title or '(overview)'
        print(f'  {filename}  {label}')

    (nb_dir / '.index').write_text('\n'.join(index_entries) + '\n')
    print(f'\n{len(index_entries)} notes → {nb_dir}')

    # Git commit
    nb_root = nb_dir.parent
    env_clean = __import__('os').environ.copy()
    env_clean['GIT_TERMINAL_PROMPT'] = '0'
    subprocess.run(['git', 'add', '-A'], cwd=str(nb_root), capture_output=True, env=env_clean)
    r = subprocess.run(
        ['git', 'commit', '-m', f'[nb] Import hledger tutorial ({len(index_entries)} notes)'],
        cwd=str(nb_root), capture_output=True, text=True, env=env_clean
    )
    if r.returncode == 0:
        print('git commit: ok')
    else:
        print(f'git commit: {r.stderr.strip() or r.stdout.strip()}')


if __name__ == '__main__':
    main()

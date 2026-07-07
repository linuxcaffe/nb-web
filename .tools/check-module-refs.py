#!/usr/bin/env python3
"""check-module-refs.py — catch the two bug classes that broke tier-2d of
the main.js modularization, twice, in one afternoon (2026-07-06):

  1. Deleted function body, dangling reference kept: an extraction script
     removes a function's definition but a return-object entry still
     references it by name.
  2. Order-sensitive bare cross-module reference: NbMain's return object
     holds a bare `Module.method` value (e.g. `runCmd: NbSync.runCmd`).
     JS evaluates that property access the instant the return-object
     literal is constructed -- synchronously, while the enclosing IIFE
     runs -- NOT deferred like a function body. If `Module`'s defining
     <script> tag loads AFTER the referencing file's tag in index.html,
     `Module` doesn't exist yet and the whole enclosing IIFE throws.

Neither bug is a syntax error (`node --check` passes both times) and
neither is something `.guards` can catch (it verifies an identifier
exists somewhere in a file, not that it's wired correctly). Both were
only caught, in tier-2d, by manually running the full Playwright suite
in a real browser. This script is the automated version of that manual
catch -- cheap, fast, no browser needed -- run at pre-commit time.

Scope, auto-discovered (no hardcoded file list to go stale as new
satellites are extracted): every *.js file directly under the repo root
matching `^const \w+ = \(\(\) =>` at column 0 -- the IIFE-module
convention this codebase already uses everywhere (main.js + every
tier-1/2 satellite + nav.js/nbweb.js/theme.js). Vendor/minified files
never match this pattern, so nothing needs excluding by name.

What's checked, for every entry in each discovered module's own
`return { ... };` object literal:
  - bare shorthand (`foo,`) or `key: identifier` where identifier has NO
    dot -> a LOCAL closure reference. Must find a matching
    `function identifier`/`async function identifier`/`const identifier =`/
    `let identifier =` somewhere in the SAME file. (Check 1: existence.)
  - `key: Module.method` where identifier HAS a dot -> a CROSS-MODULE
    reference. Must find `Module` defined by exactly one discovered file,
    and that file's OWN return object must expose `method`. (Check 1,
    extended.) Then: `Module`'s defining file's <script> tag in
    index.html must NOT appear after the referencing file's tag.
    (Check 2: order.)

Anything else (arrow-function values, ES6 method-shorthand bodies) is
intentionally NOT verified -- those are function bodies, evaluated
lazily at call time, never order-sensitive, and out of scope for the
two bug classes this script exists to catch.

Exit 0 = clean. Exit 1 = one or more real findings, printed below.
"""
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
INDEX_HTML = REPO / "index.html"

MODULE_DECL_RE = re.compile(r'^const\s+(\w+)\s*=\s*\(\(\)\s*=>', re.MULTILINE)


def discover_modules():
    """Return {module_name: Path} for every *.js file at repo root whose
    top-level IIFE-module declaration matches the codebase's own convention."""
    modules = {}
    for js_file in sorted(REPO.glob("*.js")):
        text = js_file.read_text(encoding="utf-8", errors="replace")
        m = MODULE_DECL_RE.search(text)
        if m:
            modules[m.group(1)] = js_file
    return modules


def extract_return_object_text(text, filename):
    """Find the module's own return statement text (between `return {`
    and the matching top-level `};` that's immediately followed by the
    IIFE's closing `})();`). Returns the inner text (without the outer
    braces), or None with a reason if the shape isn't found."""
    lines = text.splitlines()
    close_idx = None
    for i, line in enumerate(lines):
        if line.strip() == "})();":
            close_idx = i
    if close_idx is None:
        return None, f"{filename}: no top-level `}})();` found -- not this module convention?"

    # The return object's closing brace is the line immediately before close_idx.
    end_idx = close_idx - 1
    if end_idx < 0 or "};" not in lines[end_idx]:
        return None, f"{filename}: line before `}})();` doesn't end the return object as expected"

    # Scan upward for the line starting the return statement.
    start_idx = None
    for i in range(end_idx, -1, -1):
        if re.match(r'^\s*return\s*\{', lines[i]):
            start_idx = i
            break
    if start_idx is None:
        return None, f"{filename}: found closing `}});` but no matching `return {{` above it"

    block = "\n".join(lines[start_idx:end_idx + 1])
    # Strip the leading `return {` and the trailing final `};`.
    block = re.sub(r'^\s*return\s*\{', '', block, count=1)
    block = re.sub(r'\};?\s*$', '', block)
    return block, None


def split_top_level(text):
    """Split an object-literal body on commas at bracket-depth 0.

    Comment-aware: `//` outside a string skips to end of line. This matters
    because comment prose in this codebase routinely contains contraction
    apostrophes ("doesn't", "they're") -- without skipping comments first,
    those get misread as unterminated string-literal delimiters, which
    throws off bracket-depth tracking for everything after them and
    silently merges unrelated entries together (caught by red-then-green
    testing against a simulated dangling-reference bug -- the checker
    passed when it should have failed, because the entry it needed to see
    had been swallowed into a much earlier one)."""
    entries = []
    depth = 0
    current = []
    in_string = None
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if in_string:
            current.append(ch)
            if ch == '\\' and i + 1 < n:
                current.append(text[i + 1])
                i += 2
                continue
            if ch == in_string:
                in_string = None
            i += 1
            continue
        if ch == '/' and i + 1 < n and text[i + 1] == '/':
            nl = text.find('\n', i)
            if nl == -1:
                break
            i = nl  # leave the newline itself to be appended normally
            continue
        if ch in ("'", '"', '`'):
            in_string = ch
            current.append(ch)
        elif ch in '{([':
            depth += 1
            current.append(ch)
        elif ch in '})]':
            depth -= 1
            current.append(ch)
        elif ch == ',' and depth == 0:
            entries.append(''.join(current))
            current = []
        else:
            current.append(ch)
        i += 1
    tail = ''.join(current).strip()
    if tail:
        entries.append(tail)
    return [e.strip() for e in entries if e.strip()]


BARE_RE = re.compile(r'^(\w+)$')
KEY_REF_RE = re.compile(r'^(\w+)\s*:\s*([\w.]+)$')


def classify_entries(entries):
    """Return list of (kind, key, identifier) for entries we can verify.
    kind is 'local' (no dot) or 'cross' (has a dot). Anything not matching
    (arrow functions, method-shorthand, computed values) is skipped --
    those are function bodies, not order-sensitive, out of scope."""
    out = []
    for e in entries:
        # Strip trailing line comments that split_top_level may have swept in whole.
        e = re.sub(r'//.*$', '', e, flags=re.MULTILINE).strip()
        if not e:
            continue
        m = BARE_RE.match(e)
        if m:
            name = m.group(1)
            out.append(('local' if '.' not in name else 'cross', name, name))
            continue
        m = KEY_REF_RE.match(e)
        if m:
            key, ident = m.group(1), m.group(2)
            out.append(('cross' if '.' in ident else 'local', key, ident))
            continue
        # Not a simple bare/key:identifier shape -- arrow fn, method
        # shorthand, or a nested object. Intentionally not verified.
    return out


def local_definition_exists(name, text):
    pat = re.compile(
        r'\b(?:async\s+)?function\s+' + re.escape(name) + r'\s*\(' +
        r'|\b(?:const|let)\s+' + re.escape(name) + r'\s*='
    )
    return bool(pat.search(text))


def script_order(index_html_text):
    """Return {filename: position} for every <script src="...local.js">
    tag, in document order. Only same-directory local files (no leading
    '/') are tracked -- absolute-path/plugin scripts aren't part of this
    module system and are out of scope for the order check."""
    order = {}
    for i, m in enumerate(re.finditer(r'<script\s+src="([^"/][^"]*\.js)"', index_html_text)):
        order[m.group(1)] = i
    return order


def main():
    modules = discover_modules()
    if not modules:
        print("check-module-refs: no modules discovered -- nothing to check.")
        return 0

    file_text = {path: path.read_text(encoding="utf-8", errors="replace")
                 for path in modules.values()}
    return_blocks = {}
    exposed = {}  # module_name -> set of keys it exposes
    findings = []

    for name, path in modules.items():
        block, err = extract_return_object_text(file_text[path], path.name)
        if err:
            findings.append(f"WARN  {err}")
            continue
        return_blocks[name] = block
        entries = classify_entries(split_top_level(block))
        exposed[name] = {key for _, key, _ in entries}

    index_html_text = INDEX_HTML.read_text(encoding="utf-8", errors="replace") \
        if INDEX_HTML.exists() else ""
    order = script_order(index_html_text)

    for name, path in modules.items():
        if name not in return_blocks:
            continue
        entries = classify_entries(split_top_level(return_blocks[name]))
        for kind, key, ident in entries:
            if kind == 'local':
                if not local_definition_exists(ident, file_text[path]):
                    findings.append(
                        f"FAIL  {path.name}: `{key}` in {name}'s return object "
                        f"references `{ident}`, but no `function {ident}` / "
                        f"`const {ident}` / `let {ident}` is defined anywhere "
                        f"in {path.name}. (dangling reference -- was the "
                        f"definition deleted?)"
                    )
                continue

            # Cross-module: Module.method
            target_mod, _, target_method = ident.partition('.')
            target_path = modules.get(target_mod)
            if target_path is None:
                findings.append(
                    f"FAIL  {path.name}: `{key}` in {name}'s return object "
                    f"references `{ident}`, but no module named `{target_mod}` "
                    f"is defined by any discovered file. (typo, or that module "
                    f"was renamed/removed?)"
                )
                continue

            if target_mod in exposed and target_method not in exposed[target_mod]:
                findings.append(
                    f"FAIL  {path.name}: `{key}` in {name}'s return object "
                    f"references `{ident}`, but {target_path.name}'s own "
                    f"return object does not expose `{target_method}`. "
                    f"(wrong method name, or it was removed from {target_path.name}?)"
                )
                continue

            # Order check: target_path's script tag must not come after path's.
            src_pos = order.get(path.name)
            target_pos = order.get(target_path.name)
            if src_pos is None or target_pos is None:
                continue  # not a plain-relative <script> tag we can order-check
            if target_pos > src_pos:
                findings.append(
                    f"FAIL  {path.name}: `{key}` in {name}'s return object is a "
                    f"BARE reference to `{ident}` -- evaluated the instant "
                    f"{name}'s return-object literal is constructed, not "
                    f"deferred like a function body. But {target_path.name} "
                    f"(defines `{target_mod}`) loads AFTER {path.name} in "
                    f"index.html. Move {target_path.name}'s <script> tag "
                    f"before {path.name}'s, or wrap the reference in a "
                    f"call-time arrow function."
                )

    real_findings = [f for f in findings if f.startswith("FAIL")]
    warnings = [f for f in findings if f.startswith("WARN")]

    for w in warnings:
        print(w)
    if real_findings:
        print(f"\ncheck-module-refs: {len(real_findings)} problem(s) found:\n")
        for f in real_findings:
            print(f"  {f}\n")
        return 1

    print(f"check-module-refs: OK ({len(modules)} modules checked, "
          f"{sum(len(classify_entries(split_top_level(b))) for b in return_blocks.values())} "
          f"return-object references verified)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

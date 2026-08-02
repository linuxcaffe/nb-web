#!/usr/bin/env python3
"""diag-render-cache.py — inspect whether a cache: true note's render-cache
snapshot (__cachedRenderHtml, see _maybeCaptureRenderCache in main.js) is
actually getting captured after a real page settle, and dump the browser
console around it.

Built 2026-08-02 while chasing a real bug in the check-notification-row
redesign: _deferCheckBlocks called _maybeCaptureRenderCache exactly once,
right after the check pass settled -- but a note whose check *results*
themselves embed a further-async nested widget (e.g. the interactive
hledger "add a receipt" nudge inside hl-entry-day/hl-entry-week's failure
card) could still have a stray .nb-spin at that exact instant, causing the
one-shot capture to bail permanently. Fixed by giving the capture attempt
its own bounded retry (same shape as the pre-check wait). This script is
what found it -- keep it for the next time render-cache silently stops
working on some note.

Requires NBWEB_TEST_USER / NBWEB_TEST_PASS in the environment (see the
`claude` test account -- ask whoever ran the last verification session, or
check Claude's own memory under reference_nbweb_claude_login if you're an
agent with access to it). Never hardcode real credentials in this file --
it's committed to a public repo.

Usage:
    NBWEB_TEST_USER=Claude NBWEB_TEST_PASS=... \\
        python3 .tools/diag-render-cache.py [base_url] [selector]

Defaults: base_url=http://localhost:5002, selector=djp:sysadmin.md
"""
import asyncio
import json
import os
import sys
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5002"
SELECTOR = sys.argv[2] if len(sys.argv) > 2 else "djp:sysadmin.md"
USER = os.environ.get("NBWEB_TEST_USER")
PASS = os.environ.get("NBWEB_TEST_PASS")

if not USER or not PASS:
    print("Set NBWEB_TEST_USER and NBWEB_TEST_PASS in the environment first.", file=sys.stderr)
    sys.exit(1)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context()
        page = await ctx.new_page()
        console = []
        page.on("console", lambda m: console.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: console.append(f"[pageerror] {e}"))

        await page.goto(f"{BASE}/login")
        await page.fill('input[name="username"]', USER)
        await page.fill('input[name="password"]', PASS)
        await page.click('button[type="submit"]')
        await page.wait_for_load_state("networkidle")

        await page.evaluate("sel => NbMain.openNote(sel)", SELECTOR)
        await page.wait_for_timeout(8000)  # generous, well past known settle + capture-retry time

        diag = await page.evaluate("""
            () => {
                const note = NbMain.activeNote();
                const rendered = document.querySelector('.nb-rendered');
                const stray = rendered ? [...rendered.querySelectorAll('.nb-inline-query, .nb-spin')] : [];
                return {
                    selector: note && note.selector,
                    meta_cache: note && note.meta && note.meta.cache,
                    has_cachedRenderHtml: !!(note && note.__cachedRenderHtml),
                    stray_count: stray.length,
                    stray_html: stray.slice(0, 5).map(el => el.outerHTML.slice(0, 200)),
                    test_block_count: document.querySelectorAll('.nb-test-block').length,
                };
            }
        """)
        print(json.dumps(diag, indent=2))
        print("CONSOLE:")
        print("\n".join(console))
        await browser.close()


asyncio.run(main())

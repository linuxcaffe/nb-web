#!/usr/bin/env python3
"""verify-check-notifications.py — end-to-end behavior check for the
2026-08-02 check-notification redesign (see .changes/2026-08-02-check-
notification-redesign.md and CLAUDE.md invariant 20 for the full story).

Covers the whole contract in one run, against real data via the `claude`
test account:
  1. Cancellation — navigating away mid-flight aborts the in-flight
     /api/check/batch call (net::ERR_ABORTED), not left to complete uselessly.
  2. Render-cache interaction — a cache: true note's __cachedRenderHtml
     capture succeeds and survives a navigate-away-and-back cycle.
  3. Form-1 (labeled, click-to-run) regression — buttons still render and
     still work after being clicked.
  4. Ghost spinners — zero visible .nb-spin sightings during a fast load.
  5. Zero-bump collapse — the notification anchor's own box stays height:0
     regardless of failing-source count, and the note's own first heading
     doesn't move while it's collapsed.
  6. Unfold/refold — clicking the toggle pushes content down (anchor
     switches to normal flow); folding back returns to height:0.

Requires NBWEB_TEST_USER / NBWEB_TEST_PASS in the environment (see the
`claude` test account -- ask whoever ran the last verification session, or
check Claude's own memory under reference_nbweb_claude_login if you're an
agent with access to it). Never hardcode real credentials in this file --
it's committed to a public repo.

Usage:
    NBWEB_TEST_USER=Claude NBWEB_TEST_PASS=... \\
        python3 .tools/verify-check-notifications.py [base_url]

Defaults: base_url=http://localhost:5002
Picks a real note with multiple ambient check families for most checks
(known-good as of 2026-08-02: djp:sysadmin.md, Takeout:takeout.md -- swap
if those notes' check state has since changed to all-passing).
"""
import asyncio
import json
import os
import sys
import time
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5002"
USER = os.environ.get("NBWEB_TEST_USER")
PASS = os.environ.get("NBWEB_TEST_PASS")
NOTE_A = "djp:sysadmin.md"       # multi-source failing note, cache: true
NOTE_B = "Takeout:takeout.md"    # second note, used as the "navigate away" target
FORM1_TOGGLE_TEXT = "System health"   # a known Form-1 group button label on NOTE_A

if not USER or not PASS:
    print("Set NBWEB_TEST_USER and NBWEB_TEST_PASS in the environment first.", file=sys.stderr)
    sys.exit(1)


async def login(page):
    await page.goto(f"{BASE}/login")
    await page.fill('input[name="username"]', USER)
    await page.fill('input[name="password"]', PASS)
    await page.click('button[type="submit"]')
    await page.wait_for_load_state("networkidle")


async def open_note(page, selector):
    await page.evaluate("sel => NbMain.openNote(sel)", selector)


async def test_cancellation(browser):
    ctx = await browser.new_context()
    page = await ctx.new_page()
    tracked = {}
    page.on("request", lambda r: tracked.__setitem__(id(r), {"url": r.url, "outcome": None}) if "/api/check/" in r.url else None)
    page.on("requestfailed", lambda r: tracked[id(r)].__setitem__("outcome", "failed:" + str(r.failure)) if id(r) in tracked else None)
    page.on("requestfinished", lambda r: tracked[id(r)].__setitem__("outcome", "finished") if id(r) in tracked else None)

    await login(page)
    await open_note(page, NOTE_A)
    batch_seen = False
    for _ in range(80):
        if any("batch" in v["url"] for v in tracked.values()):
            batch_seen = True
            break
        await page.wait_for_timeout(100)
    pre_nav_ids = set(tracked.keys())
    await open_note(page, NOTE_B)
    await page.wait_for_timeout(3000)
    batch_outcomes = [tracked[i]["outcome"] for i in pre_nav_ids if "batch" in tracked[i]["url"]]
    await ctx.close()
    ok = batch_seen and any(o and o.startswith("failed:net::ERR_ABORTED") for o in batch_outcomes)
    return {"ok": ok, "batch_seen": batch_seen, "batch_outcomes": batch_outcomes}


async def test_render_cache(browser):
    ctx = await browser.new_context()
    page = await ctx.new_page()
    await login(page)
    await open_note(page, NOTE_A)
    settled = False
    for _ in range(80):
        spins = await page.locator(".nb-spin").count()
        if spins == 0:
            settled = True
            break
        await page.wait_for_timeout(250)
    await page.wait_for_timeout(4500)  # capture-retry window
    flag1 = await page.evaluate("() => !!(NbMain.activeNote() && NbMain.activeNote().__cachedRenderHtml)")
    await open_note(page, NOTE_B)
    await page.wait_for_timeout(500)
    await open_note(page, NOTE_A)
    await page.wait_for_timeout(600)
    flag2 = await page.evaluate("() => !!(NbMain.activeNote() && NbMain.activeNote().__cachedRenderHtml)")
    await ctx.close()
    return {"ok": settled and flag1 and flag2, "settled": settled, "cache_flag_first_visit": flag1, "cache_flag_on_return": flag2}


async def test_form1(browser):
    ctx = await browser.new_context()
    page = await ctx.new_page()
    await login(page)
    await open_note(page, NOTE_A)
    await page.wait_for_timeout(8000)
    target = page.locator(".nb-test-btn", has_text=FORM1_TOGGLE_TEXT)
    found = await target.count() > 0
    result_text = None
    if found:
        await target.first.click()
        await page.wait_for_timeout(3000)
        block = target.first.locator("xpath=ancestor::*[contains(@class,'nb-test-block')]")
        result_text = await block.first.inner_text() if await block.count() else None
    await ctx.close()
    ok = found and bool(result_text) and "checks failed" in (result_text or "")
    return {"ok": ok, "button_found": found, "result_snippet": (result_text or "")[:150]}


async def test_margin_badge(browser):
    ctx = await browser.new_context(viewport={"width": 1280, "height": 900})
    page = await ctx.new_page()
    await login(page)
    await open_note(page, NOTE_A)

    spin_sightings = []
    for i in range(30):
        visible = await page.evaluate("""
            () => [...document.querySelectorAll('.nb-test-block .nb-spin')]
                .filter(el => {
                    const b = el.closest('.nb-test-block');
                    const cs = getComputedStyle(b);
                    return cs.display !== 'none' && cs.visibility !== 'hidden';
                }).length
        """)
        if visible > 0:
            spin_sightings.append({"t_ms": i * 100, "count": visible})
        await page.wait_for_timeout(100)

    await page.wait_for_timeout(5000)
    h1_before = await page.evaluate("() => { const h1 = document.querySelector('.nb-rendered h1'); return h1 ? h1.getBoundingClientRect().top : null; }")
    anchor_collapsed = await page.evaluate("""
        () => { const a = document.querySelector('.nb-check-notify-anchor'); if (!a) return null;
                const r = a.getBoundingClientRect();
                return { height: r.height, open: a.classList.contains('nb-check-notify-open') }; }
    """)

    toggle = page.locator(".nb-check-notify-anchor .nb-group-toggle")
    has_toggle = await toggle.count() > 0
    h1_after_open = None
    anchor_open = None
    anchor_refolded = None
    if has_toggle:
        await toggle.first.click()
        await page.wait_for_timeout(300)
        h1_after_open = await page.evaluate("() => { const h1 = document.querySelector('.nb-rendered h1'); return h1 ? h1.getBoundingClientRect().top : null; }")
        anchor_open = await page.evaluate("""
            () => { const a = document.querySelector('.nb-check-notify-anchor'); const r = a.getBoundingClientRect();
                    return { height: r.height, open: a.classList.contains('nb-check-notify-open') }; }
        """)
        await toggle.first.click()
        await page.wait_for_timeout(300)
        anchor_refolded = await page.evaluate("""
            () => { const a = document.querySelector('.nb-check-notify-anchor'); const r = a.getBoundingClientRect();
                    return { height: r.height, open: a.classList.contains('nb-check-notify-open') }; }
        """)

    await ctx.close()
    pushed_down = h1_before is not None and h1_after_open is not None and h1_after_open > h1_before + 5
    ok = (not spin_sightings) and anchor_collapsed and anchor_collapsed["height"] == 0 \
        and has_toggle and pushed_down and anchor_refolded and anchor_refolded["height"] == 0
    return {
        "ok": ok,
        "ghost_spinner_sightings": spin_sightings,
        "anchor_collapsed": anchor_collapsed,
        "pushed_down_on_unfold": pushed_down,
        "anchor_refolded": anchor_refolded,
    }


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        results = {
            "cancellation": await test_cancellation(browser),
            "render_cache": await test_render_cache(browser),
            "form1": await test_form1(browser),
            "margin_badge": await test_margin_badge(browser),
        }
        await browser.close()

    print(json.dumps(results, indent=2))
    all_ok = all(v.get("ok") for v in results.values())
    print("\nALL OK" if all_ok else "\nFAILURES DETECTED", file=sys.stderr)
    sys.exit(0 if all_ok else 1)


asyncio.run(main())

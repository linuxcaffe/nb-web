<!-- Generated from docs:ASK-CLAUDE.md by .tools/readme-export.py. Edit the source, not this file. -->

# ASK CLAUDE

[screenshot: 💬 badge next to a note's access badge, and the expanded claude_ask chat block below it]

If a notebook or note has AI assistance turned on, a 💬 badge appears next to the note's access badge. Tap it to ask a question about whatever you're looking at — no need to explain your setup first, it already knows what notebook, note, and type you're in.

---

## Asking a question

Tap the 💬 badge. A chat panel opens (or reopens, if you've already asked something on this note) right below the note's header — not a popup, not a separate page. Type your question, press **Ask** (or `Ctrl+Enter`), and the answer appears in the same panel. Ask a follow-up and it remembers the conversation, the same way it would if you were talking to a person.

Tap the panel's header to fold it out of the way once you're done — it stays collapsed until you tap the badge again or come back to a question already in progress.

---

## What it can (and can't) do

For most people, this is a documentation and reference assistant: it looks up real answers from nb-web's own docs and the notebook's own configuration, and hands them over — sourced, not guessed. It won't write code, explore the codebase, or make changes on your behalf; if a question needs that kind of work, it'll say so and point you toward whoever maintains your nb-web instance instead of attempting it.

---

## Turning it on (notebook owners / admins)

Availability is controlled by a `claude:` field in frontmatter — set on a note, a folder, or a whole notebook's config, same cascading rule every other config field in nb-web follows (nearest setting wins; an empty `claude:` turns it off for everything below that point). The value also picks which model answers: a plain, general-purpose tier for most notebooks, or a more capable one for notebooks where deeper questions come up. If you don't see the badge anywhere, it hasn't been turned on for that notebook yet.

---

## Related

→ [PLUGINS](PLUGINS.md) — nb-web's plugin system, of which this is one
→ [claude integration](dev/dev-claude-integration.md) — developer/architecture reference, if you're extending or debugging this yourself

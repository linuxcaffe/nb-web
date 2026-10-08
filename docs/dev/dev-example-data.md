<!-- Generated from docs:dev/dev-example-data.md by .tools/readme-export.py. Edit the source, not this file. -->

# Example data — the cast

Docs, tour pages, tests and screenshots use one fictional cast, so examples hang together and
nothing real ever leaks into a published file. Use these names; don't invent new ones, and never
copy a name, path or amount from your own notebooks.

| Who | Name | Used as |
|---|---|---|
| The user, the "you" in examples | **Pat Smith** | username `pat`, `.users/pat.md`, Pat's notebooks |
| Pat's partner, the second account | **Sam Smith** | `sam.md`, level `office`, scoped to one notebook ("Sam's vintage finds") |
| Pat's client, a company | **Acme** (Acme Construction) | `contacts:acme.md`, `projects/acme/`, `Income:…:acme` |
| Acme's contact | **Kim Lee** | the invoice's To: block (`kim@acme.ca`) |
| Acme's project, a homeowner job | **Jones** | `projects/acme/jones/`, `jones.md` diary, `jones-reports.md`, `acme:jones` |

**The backstory.** Pat and Sam are a couple. Pat runs a small renovation business from nb-web;
Acme Construction subcontracts work to Pat, such as the job at the Joneses' house. Sam keeps the
household books and a small vintage shop, with an account limited to that notebook. As a couple,
they're the natural example for joint tax returns and transfers between their accounts.

**Pronouns.** Examples rarely need one: address the reader as "you" and use names. When one is
needed, use **they/them** for Pat, Sam and Kim.

**Other placeholders.** Paths start with `~/.nb/` (never a real home directory); amounts are
round and invented; addresses are `123 Main St, Anytown`; email domains are `acme.ca` or
`example.com`.

**The safety net.** `~/.nb/.rules/private-names.txt` (private, never published) lists real names,
addresses and accounts. `.tools/readme-export.py` refuses to export a file containing one, and
`--check` (the `sys-readme-stale` badge) lists every hit. Found a real name somewhere? Add it to
that list, then replace it with someone from the cast.

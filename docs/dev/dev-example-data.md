<!-- Generated from docs:dev/dev-example-data.md by .tools/readme-export.py. Edit the source, not this file. -->

# Example data — the cast

Docs, tour pages, tests and screenshots use one fictional cast, so examples hang together and
nothing real ever leaks into a published file. Use these names, and never copy a name, path or
amount from your own notebooks. A new person goes in this table first, then gets a profile.

| Who | Name | Used as |
|---|---|---|
| The user, the "you" in examples | **Pat Smith**, owner of Smith Renovations | username `pat` (tech), `.users/pat.md`; notebooks `jobs`, `accts`, `tasks`, `contacts` |
| Pat's partner, the second account | **Sam Smith**, owner of Sam's Vintage | `sam`, level `office`, scoped to the `vintage` notebook |
| Pat's client, a company | **Acme** (Acme Construction) | `contacts:acme.md`, `projects/acme/`, `Income:…:acme` |
| Acme's contact | **Kim Lee** | the invoice's To: block (`kim@acme.ca`); `kim`, level `guest`, scoped to the `acme` notebook |
| Acme's project, a homeowner job | **Jones** | `projects/acme/jones/`, `jones.md` diary, `jones-reports.md`, `acme:jones` |
| Pat and Sam's kid | **Alex Smith**, film student | `alex`, level `user`, scoped to the `film` notebook (the cine plugin's examples) |

**The backstory.** Pat and Sam are a couple in Anytown. Pat runs Smith Renovations, a
one-person renovation business, from nb-web; Acme Construction subcontracts work to Pat, such as
the job at the Joneses' house, and Kim Lee follows Acme's jobs on Pat's install with a read-only
account. Sam keeps the household books and runs Sam's Vintage, a small online shop, with an
account limited to that notebook. As a couple, they're the natural example for joint tax returns
and transfers between their accounts. Their kid Alex is making a short film for school.

**Where they live.** `features:examples/` is their data: a profile each in
`features:examples/people/` (who they are and how they use nb-web), Pat's jobs in
`examples/jobs/`, and Smith Renovations' books in `examples/example.journal`. Keep the profiles,
this table and the data telling one story: a profile only claims features that exist.

**Fair game** (djp, 2026-10-13). The examples are a sandbox: embellish the people's stories in
example scenarios, and use their data freely for testing and experiments: edit it, break it,
run checks and new features against it. It's safe because `features/.tools/reset.sh` puts any
part back from the git tag `pristine`, and the README export reads only that tag. So the one
rule: move `pristine` only for changes meant to ship (look at `git -C ~/.nb/features diff
pristine HEAD` first), never for an experiment, and reset when an experiment is done.

**Pronouns.** Examples rarely need one: address the reader as "you" and use names. When one is
needed, use **they/them** for Pat, Sam, Kim and Alex.

**Other placeholders.** Paths start with `~/.nb/` (never a real home directory); amounts are
round and invented; addresses are `123 Main St, Anytown`; email domains are `acme.ca` or
`example.com`.

**The safety net.** `~/.nb/.rules/private-names.txt` (private, never published) lists real names,
addresses and accounts. `.tools/readme-export.py` refuses to export a file containing one, and
`--check` (the `sys-readme-stale` badge) lists every hit. Found a real name somewhere? Add it to
that list, then replace it with someone from the cast.

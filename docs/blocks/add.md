<!-- Generated from docs:blocks/add.md by .tools/readme-export.py. Edit the source, not this file. -->

# add — Create Wizards

## Summary

An `add` block shows a wizard as a small chart: the steps to create something new, such as a
project with its folder, diary, reports page and config. Click a step and a form asks for the
names and choices its templates need, shows what it will make, and creates it all in one go.
The same wizard opens from the **[+]** in a project's (or other typed note's) header. A wizard is
a note you write; see [writing a wizard](add/wizards.md).

## How it works

````markdown
```add
org new-job
```
````

`org new-job` draws the wizard in the note `.new-job-org.md` at the top of this notebook. Try
Pat's on the Job board: its **Add a job** section has this
block, and the **[+]** in its header opens the same wizard.

**The chart.** The wizard's title is the root; each step is a box. Hover a box for its
description.

**Clicking a step** that creates something opens a form:

- one field per thing its templates ask for (`{{job_title}}`), a dropdown where the template
  offers choices (`{{client:acme|smith|none}}`);
- a preview of what will be made, updated as you type;
- **Create** makes it, then opens the main new note. Anything that already exists is left alone
  and reused.

A step with nothing to ask (adding today's heading, say) runs straight away. Clicking a heading
that only groups other steps runs all of them, in order. A step that links to a note
(`## [[Projects]]`) just opens it.

**The [+] button** appears on a typed note's header when a wizard fits it: the one named by the
note's `add_org:`, or its notebook's `types: <type>: add_org:`, or `.<type>-org.md` if it exists.
Folders and notebooks can add more with `add_org_add:`. It lists each wizard's steps; pick one.

## Reference

- In frontmatter, `add: org new-job` shows the chart in the header strip.
- Names you type become file and folder names: anything but letters, digits, `_` and `-` turns
  into `_`.
- No access level of its own: you can only create what your account could create by hand.
- Writing wizards, the `[+]` settings and the step kinds: [writing a wizard](add/wizards.md).

## For developers

`_loadAddOrgBlock` (`plugins/nbweb-codeblocks.js`) reads `<notebook>:.<name>-org.md`, parses it
with `_parseAddOrgSource` and draws it with `_addOrgRender`; a click opens `_openAddOrgModal`,
which scans the steps' templates for fields (`_addOrgScanForm`) and runs them
(`_addOrgExecuteBranch`/`_addOrgExecuteLeaf`). The [+] is `NbWeb.openAddOrgPicker`, its target
`effective_add_org` (`app.py`, nb-web `CLAUDE.md` invariants 40 and 43); the design narrative is the
`add_org_scaffolding_wizard_design_2026-08-16` note in the `claude` notebook.

<!-- Generated from docs:blocks/add/wizards.md by .tools/readme-export.py. Edit the source, not this file. -->

# Writing a wizard

## Summary

A wizard is a note named `.<name>-org.md` at the top of a notebook. Its headings are the steps
(nested headings are sub-steps), and lines starting `>` under a heading say what that step does:
`> KIND:` what to make, `> TEMPLATE:` which template fills it, `> AT:` where it goes, `> IF:`
when to skip it. Placeholders like `{{job_slug}}` in those lines and in the templates become the
form's fields.

## How it works

Pat's New job wizard:

```markdown
# New job

## Job
> KIND: note
> TEMPLATE: job
> AT: examples/jobs/{{job_slug}}
The job's note in the jobs folder, filled in from the job template.
- job_slug becomes the file name; the template asks for the rest.

## Site visit
> KIND: note
> TEMPLATE: site-visit
> AT: examples/jobs/{{job_slug}}-visit
> IF: visit_date
A note for the first site visit, made only if you give a visit date.
```

### The lines under a heading

| Line | Means |
|---|---|
| `> KIND: note` | what this step makes (below) |
| `> TEMPLATE: job` | the template that fills the note: `.templates/job.md` in this notebook (the notebook's own, or one of its folders'). Global templates aren't found here. |
| `> AT: path/{{field}}` | where it goes, inside the notebook; `.md` can be left off |
| `> IF: field` | skip this step if `field` is left empty |
| other text, or `> text` | the step's description (hover the box) |
| `- text` | a comment for whoever edits the wizard; never shown |

A heading without `KIND` groups the steps under it; clicking it runs them all. A heading that is a
link (`## [[Projects]]`) opens that note instead.

### Kinds

| `KIND` | Makes |
|---|---|
| `note` | a note at `AT`, from `TEMPLATE` (a dotfile like `.{{slug}}.md` is fine) |
| `folder` | the folder at `AT`, and any missing folders above it |
| `contact` | a note in the `contacts` notebook |
| `notebook` | a new notebook named by `AT` |
| `today` | adds today's date heading to the note you're on (above `> TODAY:` if it has one) |

An existing note or folder is never overwritten: it's reused.

### The form's fields

Every `{{field}}` in the steps' `AT` lines and in their templates becomes one field, asked once
even if used in several places:

- `{{field}}`: a text box;
- `{{field|default}}`: a text box, with `default` used when it's left empty;
- `{{field:a|b|c}}` (in a template): a dropdown of `a`, `b`, `c`;
- an `IF:` field is asked for too.

Built-in values are filled in for you and never asked: `{{date}}`, `{{day}}`, `{{time}}`,
`{{weather}}`, `{{title}}`, `{{tags}}` and the like. What you type is made safe for a file name
in `AT` paths (anything but letters, digits, `_`, `-` becomes `_`); in the template text it's
used as typed.

### Which wizard the [+] opens

For a note of type `<type>`, the first of:

1. the note's own `add_org: <name>`;
2. the notebook config's `types: <type>: add_org: <name>`;
3. `.<type>-org.md`, if it exists.

`add_org_add: [<name>, …]` in a folder or notebook config (or global config) adds more wizards to
the [+] list; these add up from the top down. Pat's Job board sets `add_org: new-job`.

## Reference

- The wizard file is a plain note (`type: dotfile` is usual): edit it like any other. In the [+]
  list, **✎ edit source** opens it (for developers).
- A wizard only creates in its own notebook, except `contact` (the `contacts` notebook) and
  `notebook` (a new one).
- Nothing is created until **Create**; a step that fails shows in the result, and the others
  still run.

## For developers

Grammar: `_ADD_ORG_FIELD_RE`/`_parseAddOrgSource`; fields: `_addOrgPlaceholderFields`,
`_ADD_ORG_BUILTIN_VARS`; templates: `_addOrgFetchTemplate` (this notebook's only); values into
paths: `_addOrgResolveText`; server-side template filling: `_resolve_template_vars`'s `extra_vars`
(`app.py`). The [+]: `_effective_add_org`/`_resolve_add_org_list` (`app.py`, invariant 43).

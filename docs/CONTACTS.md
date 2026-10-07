<!-- Generated from docs:CONTACTS.md by .tools/readme-export.py. Edit the source, not this file. -->

# Contacts

[The Contacts Notebook](#the-contacts-notebook) · [Contact Note Format](#contact-note-format) · [VCF Browser](#vcf-browser) · [Sort and Filter](#sort-and-filter)

---

Contact management in nb-web is provided by the **NbWeb-contacts** plugin, which activates automatically when a notebook named `contacts` is present. The plugin appears in **Menu → Plugins → NbWeb-contacts**.

---

## The Contacts Notebook

Create a notebook called `contacts` and nb-web treats it as a contacts directory:

```bash
nb notebooks add contacts
```

All `.md` files in the `contacts` notebook are auto-typed as `contact`. The plugin renders them as structured cards rather than plain Markdown previews.

---

## Contact Note Format

Contact notes are Markdown files with YAML frontmatter. Create one via **Add** (the notebook default template pre-applies if set) or import from a VCF file.

```yaml
---
name: Firstname Lastname
title: Job Title
org: Organisation
email:
  home: person@example.com
  work: work@example.com
phone:
  mobile: "+1 555 000 0000"
address: 123 Main St, City, Country
url: https://example.com
birthday: 1980-01-15
tags: [friend, local]
---

Optional notes in Markdown below the frontmatter.
```

**Clickable fields:** `email` (mailto:), `phone` (tel:), `address` (Google Maps), `url`.

Both flat strings and keyed objects are accepted for `email` and `phone` — the key becomes the label:

```yaml
phone: "+1 555 000 0000"          # flat — no label
phone:
  mobile: "+1 555 000 0000"       # keyed — shows "mobile"
  work:   "+1 555 111 1111"
```

---

## VCF Browser

The **📇** toolbar button opens a browser for a `.vcf` (vCard) file — useful for bulk-importing contacts from a phone export or address book backup.

Configure the VCF source path in `nb-settings.json`:

```json
{ "vcf_source": "~/Downloads/contacts.vcf" }
```

The browser lets you search and inspect contacts from the file. **Create Contact Note** imports the selected contact into the `contacts` notebook as a structured Markdown note.

---

## Sort and Filter

When the `contacts` notebook is active, the sort dropdown gains a **Last name** option — sorts by the final word of the `name` field, falling back to the first word for single-name contacts.

Filter contacts by tag using the tags field (`#` to focus it) — e.g. `#friend` or `#local`.

See [IMPORT/EXPORT](import-export.md) → Contact Import for importing contacts from VCF files.

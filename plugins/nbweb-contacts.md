---
title: NbWeb-contacts
caption: Contact card renderer and VCF importer for the contacts notebook
---

# NbWeb-contacts

Renders contact notes as structured cards and provides a VCF browser for importing contacts from `.vcf` files.

Activates when a notebook named `contacts` is present.

---

## Contact note format

Contact notes live in the `contacts` notebook as Markdown files with YAML frontmatter. The plugin renders any note whose type is `contact` (all `.md` files in the contacts notebook are auto-typed as contacts by nb-web).

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

Optional notes in Markdown.
```

Fields rendered as clickable links: `email` (mailto:), `phone` (tel:), `address` (Google Maps), `url`.

Both flat strings and keyed objects are accepted for `email` and `phone` — the key becomes the label.

---

## Sort options

The sort dropdown adds **Last name** when the contacts notebook is active — sorts by the final word of the `name` (or `fn`, or note title) field, falling back to the first word for single-name contacts.

---

## VCF browser

The 📇 toolbar button opens a contact browser that reads from the VCF source file configured in `nb-settings.json`:

```json
{ "vcf_source": "~/Downloads/contacts.vcf" }
```

The browser lets you search, browse, and inspect contacts from the VCF. **Create Contact Note** imports a single contact into the `contacts` notebook as a structured Markdown note.

---

## Templates

No templates are provided — contact notes are typically created via VCF import or by adding a note manually in the contacts notebook.

<!-- Generated from docs:ACCOUNT.md by .tools/readme-export.py. Edit the source, not this file. -->

# Account Wikilinks

[Your Profile](#your-profile) · [Access Level](#access-level) · [Edit Name](#edit-name) · [Change Password](#change-password) · [Exclusive Notes](#exclusive-notes)

---

The Account page is reached via **Menu → Account**. It shows your current user profile and lets you update your display name and password.

---

## Your Profile

The top of the page shows your **display name** and **access level**. If a contact note in the `contacts` notebook has a `name:` field matching your username, a **→ contact** link appears next to your name — clicking it opens that contact note.

---

## Access Level

nb-web uses five access levels, from least to most privileged:

| Level | Description |
|-------|-------------|
| `guest` | Read-only access to public content; 15-minute session |
| `user` | Standard note author — read and write own notebooks |
| `office` | Shared workspace access |
| `admin` | Full notebook management, Add Notebook, user admin |
| `tech` | System configuration, plugin management, server access |

Your level is set by the site administrator and cannot be changed here.

Notes and codeblocks can declare a minimum access level using the `access:` frontmatter key — notes gated above your level are hidden or read-only depending on context.

---

## Edit Name

Click **Edit** next to your display name to change it. Type the new name and press **Save** or hit Enter. The name is stored in your user card and appears in the header on all pages.

---

## Change Password

The **Change password** section requires your **current password** before accepting a new one. Both fields must be filled. Leave both blank to make no change.

Passwords are stored as bcrypt hashes in your user card — the plaintext is never saved.

---

## Exclusive Notes

The **Exclusive notes** section lists any notes across your notebooks that are gated specifically to your username — notes where `access: <your-username>` is set in frontmatter. These are notes that only you can see, regardless of the notebook's general access level.

Click any note in the list to open it.

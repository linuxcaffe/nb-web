# Setting up NbWeb-hledger

To use the hledger plugin, you need two things:

1. **hledger installed** on your system
2. **A notebook with a `.nb-hledger.json` anchor file**

---

## Install hledger

**Ubuntu / Debian:**
```bash
sudo apt install hledger
```

**Arch / Manjaro:**
```bash
sudo pacman -S hledger
```

**macOS (Homebrew):**
```bash
brew install hledger
```

**Any platform (official binary):**
Download from <https://hledger.org/install.html>

Verify: `hledger --version`

---

## Create a notebook for accounting

```bash
nb notebooks add finances
```

Or use an existing notebook.

---

## Create the anchor file

In your notebook directory (`~/.nb/<notebook>/`), create `.nb-hledger.json`:

```json
{
  "journal": "/home/yourname/finances/main.journal",
  "province": "ON",
  "commodity": "CAD",
  "entity": "personal"
}
```

Replace `journal` with the path to your main hledger journal file. If you don't have one yet, use the Chart of Accounts wizard — it will create `accounts.journal` and tell you what to put in your main journal.

**Province codes:** `AB BC MB NB NL NS NT NU ON PE QC SK YT`

---

## Or: start from scratch with the CoA wizard

If you don't have any journals yet:

1. Create the anchor file with any journal path (the file doesn't need to exist yet)
2. Open the notebook in nb-web — the plugin panel will appear
3. Use the **Chart of Accounts** wizard to generate a complete account structure
4. Create a `main.journal` that includes the generated file:

```
; main.journal
include accounts.journal

; Your transactions go below:

```

---

## Journal path resolution

The plugin looks for your journal in this order:

1. `journal` field in `.nb-hledger.json`
2. `LEDGER_FILE` environment variable
3. `~/.hledger.journal` (hledger default)

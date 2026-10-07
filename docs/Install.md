<!-- Generated from docs:Install.md by .tools/readme-export.py. Edit the source, not this file. -->

## Requirements

### Required

| Dependency | Version | Install |
|---|---|---|
| [nb](https://github.com/xwmx/nb) | any recent | `brew install nb` / see nb docs |
| Python | 3.8+ | usually pre-installed |
| pip | any | usually pre-installed |
| git | any | usually pre-installed |

### Python packages

```
pip3 install flask flask-sock
```

`pyyaml` is optional — install it if your notes use YAML frontmatter and you want nb-web to read it:

```
pip3 install pyyaml
```

### Optional tools

These extend what nb-web can do but are not required to run:

| Tool | What it enables |
|---|---|
| `pandoc` | Preview and export of .docx, .odt, .epub, .rst, .tex |
| `gh` | **Create & Wire** — create a GitHub repo for a notebook in one click |
| Epiphany (GNOME Web) | PWA mode with its own window, icon, and service worker |

Install pandoc via your package manager (`apt install pandoc`, `brew install pandoc`).  
Install gh via `apt install gh` or https://cli.github.com, then run `gh auth login`.

---

## Get nb-web

```bash
git clone https://github.com/linuxcaffe/nb-web.git
cd nb-web
```

---

## Start the server

```bash
python3 app.py
```

Open `http://localhost:5001` in any browser. Your nb notebooks appear immediately.

The server runs on port 5001 by default. It does not need internet access — it shells out to your local nb and git installations.

To stop: `Ctrl-C` in the terminal, or use the Restart button in **Menu → Settings → Server**.

---

## PWA mode (Linux / GNOME, recommended)

nb-web works best as a Progressive Web App in [Epiphany (GNOME Web)](https://apps.gnome.org/Epiphany/). This gives it its own window, taskbar icon, and isolated service worker cache.

**First-time setup:**

1. Start the server (`python3 app.py`)
2. Open Epiphany and navigate to `http://localhost:5001`
3. Click ⋮ → **Install as Web App**
4. Accept the defaults (name: nb-web, icon: nb logo)
5. The app now has its own launcher — use that from now on

**Using the launch script (recommended):**

Copy `nb-web-launch.sh` somewhere on your PATH (e.g. `~/.local/bin/`):

```bash
cp nb-web-launch.sh ~/.local/bin/nb-web-launch
chmod +x ~/.local/bin/nb-web-launch
```

Then:

```bash
nb-web-launch          # start server if needed, open PWA
nb-web-launch --clean  # wipe stale caches and restart (use when UI is stuck)
nb-web-launch --stop   # stop the Flask server
```

The launch script auto-detects your Epiphany PWA profile, manages the Flask PID, and kills the `nb browse` daemon if running (it conflicts with nb-web's sync model).

---

## Service worker and caching

nb-web uses a service worker to cache the frontend for offline use. The cache key is the git commit hash of nb-web itself — so after pulling new code, **commit it** and the browser will pick up the new version automatically on next load.

If the UI looks stale after an update:

```bash
nb-web-launch --clean
```

This wipes the Epiphany service worker registration and all WebKit caches, then restarts Flask and opens a fresh window.

> **Note for Epiphany users:** If Epiphany crashes on launch, stale service worker SQLite files are usually the cause. `--clean` fixes this. Do not try to edit the session XML file manually — delete it instead.

---

## First run checklist

- [ ] `nb list` works in the terminal (nb is installed and has at least one notebook)
- [ ] `python3 app.py` starts without errors
- [ ] `http://localhost:5001` shows your notes
- [ ] (Optional) PWA installed in Epiphany
- [ ] (Optional) `nb-web-launch` script on PATH
- [ ] (Optional) `gh auth login` for Create & Wire support

---

## Updating

```bash
cd ~/dev/nb-web
git pull
# no rebuild step needed — restart the server and the new code is live
python3 app.py
```

The service worker cache updates automatically on next page load after the server restarts with a new git commit.

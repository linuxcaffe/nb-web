## NbWeb-quartz setup

The NbWeb-quartz plugin publishes nb notebooks as static websites via GitHub Actions.
Two things are needed before the Publish button works:

### 1. GitHub CLI (`gh`)

The plugin uses `gh workflow run` to trigger builds. Install it:

**Debian / Ubuntu**
```bash
sudo apt install gh
```

**Arch**
```bash
sudo pacman -S github-cli
```

**macOS**
```bash
brew install gh
```

Then authenticate:
```bash
gh auth login
```

### 2. Configure a notebook with `nb-website`

[nb-website](https://github.com/linuxcaffe/nb-website) wires a notebook to a Quartz static site.
Run the setup script inside the nb-website repo:

```bash
cd ~/dev/nb-website
./setup.sh <notebook-name>
```

This writes `.nb-website.json` into the notebook with the `quartz_path` and `github_repo`
fields the plugin needs. Reload nb-web and the plugin will activate for that notebook.

---

Once set up, the notebook toolbar gains:
- **Publish** — push content and trigger a GitHub Pages build
- **Local preview** — run `npx quartz build --serve` in the terminal
- **Open site** — open the live URL in a new tab

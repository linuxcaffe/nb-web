## Quartz not configured

The NbWeb-quartz plugin publishes nb notebooks as static websites using [Quartz](https://quartz.jzhao.xyz/).
No notebooks are configured yet.

### Set up nb-website

[nb-website](https://github.com/linuxcaffe/nb-website) is the companion tool that wires a notebook to a Quartz site.

```bash
git clone https://github.com/linuxcaffe/nb-website.git
cd nb-website
./setup.sh <notebook-name>
```

This creates a `.nb-website.json` in your notebook with the `quartz_path` and `github_repo` fields
that the plugin needs.

### What it gives you

- Render and preview your notebook as a Quartz site before publishing
- **Publish** button in the notebook toolbar — one click pushes content and triggers a GitHub Pages build
- Per-note quartz metadata fields visible in the preview pane
- Shop-item rendering for `preciousfinds`-style notebooks

Once `setup.sh` completes and you reload nb-web, this plugin will activate automatically for the
configured notebook.

// nb-web plugin host — NbWeb.registerModule() API
const NbWeb = (() => {
    const _modules = new Map(); // name → { spec, enabled, activeNotebooks, error }

    // ── Plugin loading ─────────────────────────────────────────────────────────

    async function _loadScript(url) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = url;
            s.onload = resolve;
            s.onerror = () => reject(new Error(`Failed to load: ${url}`));
            document.head.appendChild(s);
        });
    }

    async function _loadPlugins() {
        let plugins = [];
        try {
            const r = await fetch('/api/nb-settings');
            plugins = (await r.json()).plugins || [];
        } catch (e) {
            console.warn('NbWeb: could not read plugin list from settings', e);
        }
        for (const p of plugins) {
            if (p.enabled === false) continue;
            try {
                await _loadScript(p.url);
            } catch (e) {
                console.error(`NbWeb: failed to load plugin "${p.url}":`, e);
            }
        }
    }

    // ── Registration ───────────────────────────────────────────────────────────

    function registerModule(name, spec) {
        if (_modules.has(name)) {
            console.warn(`NbWeb: module "${name}" already registered — skipping`);
            return;
        }
        _modules.set(name, { spec, enabled: true, activeNotebooks: [], error: null });
    }

    // ── Initialisation (called after plugins are loaded) ───────────────────────

    let _notebooks = []; // full notebook objects from /api/nb/notebooks

    async function _init() {
        try {
            const r = await fetch('/api/nb/notebooks');
            _notebooks = (await r.json()).notebooks || [];
        } catch (e) {
            console.warn('NbWeb: could not load notebooks for plugin detection', e);
        }
        for (const [name, mod] of _modules) {
            if (!mod.enabled) continue;
            try {
                mod.activeNotebooks = mod.spec.detect
                    ? ((await mod.spec.detect(_notebooks)) ?? [])
                    : _notebooks;
            } catch (e) {
                console.error(`NbWeb: detect() failed for module "${name}":`, e);
                mod.activeNotebooks = [];
                mod.error = e.message;
            }
        }
    }

    function notebooks() { return _notebooks; }

    // ── Extension point queries ────────────────────────────────────────────────

    function _activeFor(notebookName) {
        const out = [];
        for (const [name, mod] of _modules) {
            if (!mod.enabled) continue;
            if (mod.activeNotebooks.some(nb => nb.name === notebookName))
                out.push({ name, ...mod.spec });
        }
        return out;
    }

    function getPreviewRenderer(notebook) {
        return _activeFor(notebook).find(m => m.previewRenderer)?.previewRenderer ?? null;
    }

    function getListExcerpt(notebook) {
        return _activeFor(notebook).find(m => m.listExcerpt)?.listExcerpt ?? null;
    }

    // listButtons — notebook-specific, injected into the List panel toolbar
    function getListButtons(notebook) {
        return _activeFor(notebook).flatMap(m => m.listButtons ?? m.toolbarButtons ?? []);
    }

    // navButtons — global, injected into the main nav (#nb-cmds-plugins)
    function getNavButtons() {
        const seen = new Set();
        return [..._modules.values()]
            .filter(mod => mod.enabled)
            .flatMap(mod => mod.spec.navButtons ?? [])
            .filter(btn => seen.has(btn.id) ? false : seen.add(btn.id));
    }

    function getAddFormExtras(notebook) {
        return _activeFor(notebook).find(m => m.addFormExtras)?.addFormExtras ?? null;
    }

    // notebookSection — appended to the Notebooks detail panel for each active plugin
    function getNotebookSections(notebookObj) {
        return _activeFor(notebookObj.name).flatMap(m => {
            if (!m.notebookSection) return [];
            try {
                const s = m.notebookSection(notebookObj);
                return s ? [{ moduleName: m.name, ...s }] : [];
            } catch (e) {
                console.error(`NbWeb: notebookSection() failed for module "${m.name}":`, e);
                return [];
            }
        });
    }

    // ── Shared publish helper (used by toolbar buttons + settings panel) ──────────

    async function publishWebsite(notebook, btn) {
        const origText   = btn.textContent;
        const origTitle  = btn.title;
        btn.disabled     = true;
        btn.textContent  = '⏳';
        btn.title        = 'Publishing…';

        const chip = document.createElement('span');
        chip.className   = 'nbweb-publish-chip';
        chip.textContent = 'pushing…';
        btn.insertAdjacentElement('afterend', chip);

        const finish = (text, ms = 5000) => {
            chip.textContent = text;
            setTimeout(() => {
                chip.remove();
                btn.textContent = origText;
                btn.title       = origTitle;
                btn.disabled    = false;
            }, ms);
        };

        try {
            const r = await fetch('/api/website/publish', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ notebook }),
            }).then(x => x.json());

            if (!r.ok) { finish(`✗ ${r.output?.split('\n')[0] ?? 'failed'}`, 8000); return; }
            if (!r.run_id) { finish('✓ triggered'); return; }

            chip.textContent = '⏳ building…';
            btn.title        = 'Building…';
            const start = Date.now();
            const repo  = encodeURIComponent(r.github_repo);
            const timer = setInterval(async () => {
                const elapsed = Math.round((Date.now() - start) / 1000);
                if (elapsed > 300) {
                    clearInterval(timer);
                    finish('⚠ timed out', 8000);
                    return;
                }
                try {
                    const s = await fetch(
                        `/api/website/build-status?run_id=${r.run_id}&repo=${repo}`
                    ).then(x => x.json());
                    if (s.status !== 'completed') {
                        chip.textContent = `⏳ ${elapsed}s`;
                        return;
                    }
                    clearInterval(timer);
                    finish(s.conclusion === 'success'
                        ? `✓ built in ${elapsed}s`
                        : `✗ build failed`, s.conclusion === 'success' ? 5000 : 10000);
                } catch (_) { /* transient, keep polling */ }
            }, 6000);
        } catch (e) {
            finish('✗ ' + e.message, 8000);
        }
    }

    // ── Plugin manager API (for the Plugins page UI) ───────────────────────────

    function list() {
        return [..._modules.entries()].map(([name, mod]) => ({
            name,
            enabled: mod.enabled,
            activeNotebooks: mod.activeNotebooks.map(nb => nb.name),
            error: mod.error,
        }));
    }

    function setEnabled(name, enabled) {
        if (_modules.has(name)) _modules.get(name).enabled = enabled;
    }

    function unregister(name) {
        _modules.delete(name);
    }

    return {
        registerModule,
        publishWebsite,
        notebooks,
        _loadPlugins,
        _init,
        getPreviewRenderer,
        getListExcerpt,
        getListButtons,
        getNavButtons,
        getToolbarButtons: getListButtons, // backward-compat alias
        getAddFormExtras,
        getNotebookSections,
        list,
        setEnabled,
        unregister,
    };
})();

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

    async function _init() {
        let notebooks = [];
        try {
            const r = await fetch('/api/nb/notebooks');
            notebooks = (await r.json()).notebooks || [];
        } catch (e) {
            console.warn('NbWeb: could not load notebooks for plugin detection', e);
        }
        for (const [name, mod] of _modules) {
            if (!mod.enabled) continue;
            try {
                mod.activeNotebooks = mod.spec.detect
                    ? ((await mod.spec.detect(notebooks)) ?? [])
                    : notebooks;
            } catch (e) {
                console.error(`NbWeb: detect() failed for module "${name}":`, e);
                mod.activeNotebooks = [];
                mod.error = e.message;
            }
        }
    }

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

    function getToolbarButtons(notebook) {
        return _activeFor(notebook).flatMap(m => m.toolbarButtons ?? []);
    }

    function getAddFormExtras(notebook) {
        return _activeFor(notebook).find(m => m.addFormExtras)?.addFormExtras ?? null;
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
        _loadPlugins,
        _init,
        getPreviewRenderer,
        getListExcerpt,
        getToolbarButtons,
        getAddFormExtras,
        list,
        setEnabled,
        unregister,
    };
})();

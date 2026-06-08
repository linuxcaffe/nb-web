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

    // Returns all custom sort options from plugins active for this notebook.
    // Each entry: { id, label, sort(notes) → notes[] }
    function getSortOptions(notebookName) {
        return _activeFor(notebookName).flatMap(m => m.sortOptions ?? []);
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

    // ── Template API ──────────────────────────────────────────────────────────────

    // Returns ALL plugin templates from every enabled module, always.
    // scope is context (default placement), not a visibility gate.
    // activeForNotebook:true when the module's detect() matched this notebook.
    function getTemplatesForNotebook(notebookName) {
        const out = [];
        for (const [name, mod] of _modules) {
            if (!mod.enabled || !mod.spec.templates?.length) continue;
            const isActive    = mod.activeNotebooks.some(nb => nb.name === notebookName);
            const moduleLabel = mod.spec.label ?? name;
            mod.spec.templates.forEach(t => {
                out.push({ moduleName: name, moduleLabel, activeForNotebook: isActive, ...t });
            });
        }
        return out;
    }

    // Returns non-singleton templates with scope:'notebook' from modules active for this notebook.
    // Used to populate the DEFAULTS section in the Notebooks panel.
    function getScopedTemplatesForNotebook(notebookName) {
        return _activeFor(notebookName).flatMap(m => {
            if (!m.templates?.length) return [];
            return m.templates
                .filter(t => t.scope === 'notebook' && !t.singleton)
                .map(t => ({ moduleName: m.name, moduleLabel: m.label ?? m.name, ...t }));
        });
    }

    // Compute the path relative to the notebook root where a template is written.
    // Singletons land in the root; scoped templates land in .templates/ subdirectories.
    function templateRelPath(template) {
        const fname = template.filename
            || (template.name.toLowerCase().replace(/\s+/g, '_') + '.md');
        const scope = template.scope || '';
        if (scope.startsWith('folder:')) return `${scope.slice(7)}/.templates/${fname}`;
        if (scope === 'notebook')        return `.templates/${fname}`;
        return fname;
    }

    // Write a template to disk. Scope determines the target directory:
    //   ''          → notebook root (singleton note, indexed by nb)
    //   'notebook'  → notebook/.templates/
    //   'folder:X'  → notebook/X/.templates/
    // 409 = already exists — safe, never overwrites.
    async function createFromTemplate(template, notebookObj) {
        const filename = template.filename
            || (template.name.toLowerCase().replace(/\s+/g, '_') + '.md');
        if (!filename) {
            console.error('NbWeb.createFromTemplate: could not derive filename');
            return { ok: false, error: 'no filename' };
        }
        const content = typeof template.content === 'function'
            ? template.content(notebookObj)
            : template.content;
        try {
            const r = await fetch('/api/nb/create-from-template', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    notebook: notebookObj.name,
                    filename,
                    content,
                    scope: template.scope || '',
                }),
            });
            return await r.json(); // { ok, error? }
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    // Check whether a singleton file exists in a notebook root.
    async function singletonExists(notebookName, filename) {
        try {
            const r = await fetch(
                `/api/nb/file-exists?notebook=${encodeURIComponent(notebookName)}&filename=${encodeURIComponent(filename)}`
            );
            return (await r.json()).exists === true;
        } catch (_) {
            return false;
        }
    }

    // Check whether any template (singleton or scoped) has been written for a notebook.
    async function templateSeeded(notebookName, template) {
        const relpath = templateRelPath(template);
        try {
            const r = await fetch(
                `/api/nb/file-exists?notebook=${encodeURIComponent(notebookName)}&relpath=${encodeURIComponent(relpath)}`
            );
            return (await r.json()).exists === true;
        } catch (_) {
            return false;
        }
    }

    // ── Requirements checking ─────────────────────────────────────────────────────

    const _whichCache = new Map();

    async function checkWhich(cmd) {
        if (_whichCache.has(cmd)) return _whichCache.get(cmd);
        try {
            const r = await fetch(`/api/which?cmd=${encodeURIComponent(cmd)}`).then(x => x.json());
            _whichCache.set(cmd, r);
            return r;
        } catch (_) {
            const result = { found: false, path: null };
            _whichCache.set(cmd, result);
            return result;
        }
    }

    async function renderRequirementsCard(container, mdOrPath) {
        let md = mdOrPath;
        if (typeof mdOrPath === 'string' && (mdOrPath.startsWith('/') || mdOrPath.endsWith('.md'))) {
            try {
                const r = await fetch(mdOrPath);
                md = r.ok ? await r.text() : `# Requirements not met\n\nCould not load: \`${mdOrPath}\``;
            } catch (_) {
                md = `# Requirements not met\n\nCould not load: \`${mdOrPath}\``;
            }
        }
        const html = typeof marked !== 'undefined' ? marked.parse(md) : `<pre>${md.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</pre>`;
        container.innerHTML = `<div class="nb-requirements-card">${html}</div>`;
    }

    // ── Codeblock renderer API ────────────────────────────────────────────────────

    // Returns the renderer spec { html(text), render(container) } for a fence language, or null.
    function getCodeblockRenderer(lang) {
        for (const [, mod] of _modules) {
            if (!mod.enabled) continue;
            const r = mod.spec.codeblockRenderers?.find(r => r.lang === lang);
            if (r) return r;
        }
        return null;
    }

    // Runs all registered render(container) functions for all enabled codeblock plugins.
    async function renderCodeblocks(container) {
        for (const [, mod] of _modules) {
            if (!mod.enabled || !mod.spec.codeblockRenderers?.length) continue;
            for (const r of mod.spec.codeblockRenderers) {
                if (r.render) await r.render(container);
            }
        }
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
            enabled:        mod.enabled,
            global:         !mod.spec.detect,
            activeNotebooks: mod.activeNotebooks.map(nb => nb.name),
            error:          mod.error,
            spec:           mod.spec,
        }));
    }

    function setEnabled(name, enabled) {
        if (_modules.has(name)) _modules.get(name).enabled = enabled;
    }

    function unregister(name) {
        _modules.delete(name);
    }

    // ── Terminal API ──────────────────────────────────────────────────────────────
    // Delegates to NbTerminal (defined in main.js). Plugins should always call
    // NbWeb.runInTerminal() rather than NbTerminal directly — this indirection
    // keeps NbTerminal an implementation detail and gives a stable plugin API.

    function runInTerminal(cmd) {
        if (typeof NbTerminal !== 'undefined') return NbTerminal.run(cmd);
        console.warn('NbWeb.runInTerminal: NbTerminal not available');
    }

    function openTerminal() {
        if (typeof NbTerminal !== 'undefined') return NbTerminal.open();
        console.warn('NbWeb.openTerminal: NbTerminal not available');
    }

    return {
        registerModule,
        publishWebsite,
        notebooks,
        _loadPlugins,
        _init,
        getPreviewRenderer,
        getSortOptions,
        getListExcerpt,
        getListButtons,
        getNavButtons,
        getToolbarButtons: getListButtons, // backward-compat alias
        getAddFormExtras,
        getTemplatesForNotebook,
        getScopedTemplatesForNotebook,
        templateRelPath,
        createFromTemplate,
        singletonExists,
        templateSeeded,
        checkWhich,
        renderRequirementsCard,
        runInTerminal,
        openTerminal,
        getCodeblockRenderer,
        renderCodeblocks,
        getNotebookSections,
        list,
        setEnabled,
        unregister,
    };
})();

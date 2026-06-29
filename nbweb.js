// nb-web plugin host — NbWeb.registerModule() API
const NbWeb = (() => {
    const _modules = new Map(); // name → { spec, enabled, activeNotebooks, error }

    // FM keys declared by core and by plugins (scope → [keys]).
    // 'core' is built-in; plugin names added via registerModule spec.fmKeys.
    const _FM_KEYS_CORE = ['title', 'type', 'status', 'tags', 'access', 'alias',
        'date', 'due', 'started', 'completed', 'project', 'draft', 'pinned',
        'color', 'icon', 'template', 'renderer', 'related', 'description'];
    const _fmKeysByScope = new Map([['core', _FM_KEYS_CORE]]);

    // Per-notebook config cache: notebook → parsed meta dict from .<notebook>.md.
    // Populated lazily by loadNotebookConfig(); stays warm until explicitly busted.
    const _notebookTypeConfigs = new Map();

    // Flat renderer registry — populated by registerRenderer() and auto-populated
    // by registerModule() from previewRenderers[]/previewRenderer entries.
    // id → { id, label, icon, types, detect, render, pluginName }
    //   types:  string[] of note type values this renderer handles, or null for
    //           detect-only renderers (quartz items, path-based detection, etc.)
    //   detect: note → bool predicate kept for backward compat; used by
    //           getPreviewRenderers() runtime filtering.  Not used by getRenderers().
    const _rendererRegistry = new Map();

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

    // Explicit renderer registration — plugins may call this directly instead of
    // embedding renderers inside registerModule().  Auto-registration from
    // registerModule() calls this internally, so duplicate IDs are silently skipped.
    function registerRenderer(id, spec) {
        if (_rendererRegistry.has(id)) {
            console.warn(`NbWeb: renderer "${id}" already registered — skipping`);
            return;
        }
        _rendererRegistry.set(id, { id, ...spec });
    }

    function registerModule(name, spec) {
        if (_modules.has(name)) {
            console.warn(`NbWeb: module "${name}" already registered — skipping`);
            return;
        }
        _modules.set(name, { spec, enabled: true, activeNotebooks: [], error: null });
        if (spec.fmKeys?.length) _fmKeysByScope.set(name, spec.fmKeys);
        if (spec.hideExtrasCSS) {
            const style = document.createElement('style');
            style.dataset.nbModule = name;
            style.textContent = spec.hideExtrasCSS;
            document.head.appendChild(style);
        }
        // Auto-register named previewRenderers into the flat registry.
        for (const r of spec.previewRenderers ?? []) {
            if (r.id) registerRenderer(r.id, { pluginName: name, ...r });
        }
        // Auto-register single previewRenderer as '<module>-preview'.
        // Module spec may declare previewTypes: ['account'] to make the type
        // association queryable; otherwise the renderer is detect-only.
        if (spec.previewRenderer && !spec.previewRenderers?.length) {
            registerRenderer(`${name}-preview`, {
                label:      spec.label ?? name,
                icon:       spec.icon  ?? null,
                pluginName: name,
                types:      spec.previewTypes ?? null,
                detect:     spec.previewRendererDetect ?? null,
                render:     spec.previewRenderer,
            });
        }
    }

    // ── i18n ─────────────────────────────────────────────────────────────────

    let _locale = {};
    let _localePromise = null;

    async function loadLocale() {
        if (_localePromise) return _localePromise;
        _localePromise = fetch('/api/locale')
            .then(r => r.json())
            .then(data => { _locale = data; return data; })
            .catch(() => { _locale = {}; return {}; });
        return _localePromise;
    }

    // Translate key → locale string, falling back to the key itself.
    function t(key) { return _locale[key] ?? key; }

    // Apply data-i18n="key" translations to DOM; call after loadLocale().
    // Handles text content and placeholder/title attributes.
    function applyI18n(root) {
        root = root || document;
        root.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.dataset.i18n;
            if (!key) return;
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                if (el.placeholder) el.placeholder = t(key);
            } else {
                el.textContent = t(key);
            }
        });
        root.querySelectorAll('[data-i18n-title]').forEach(el => {
            el.title = t(el.dataset.i18nTitle);
        });
        // Set <html lang=""> from locale meta
        if (_locale._lang) document.documentElement.lang = _locale._lang;
        if (_locale._dir)  document.documentElement.dir  = _locale._dir;
    }

    // ── Extras-hidden API ─────────────────────────────────────────────────────

    // Returns true when the 👁 extras toggle is active (class on #nb-preview-content).
    function isExtrasHidden() {
        return document.getElementById('nb-preview-content')
            ?.classList.contains('nb-extras-hidden') ?? false;
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
        const active = _activeFor(notebook);
        // new multi-renderer API: return first renderer's render fn as a backward-compat shim
        const multi = active.find(m => m.previewRenderers?.length);
        if (multi) return note => {
            const r = multi.previewRenderers.find(pr => !pr.detect || pr.detect(note));
            return r ? r.render(note) : null;
        };
        return active.find(m => m.previewRenderer)?.previewRenderer ?? null;
    }

    // Fetch and cache the parsed meta from .<notebook>.md.
    // Safe to call every render — resolves immediately on cache hit.
    async function loadNotebookConfig(notebook) {
        if (!notebook || _notebookTypeConfigs.has(notebook))
            return _notebookTypeConfigs.get(notebook) || {};
        try {
            const r = await fetch(`/api/nb/notebook-config?notebook=${encodeURIComponent(notebook)}`);
            const d = await r.json();
            const cfg = d.meta || {};
            _notebookTypeConfigs.set(notebook, cfg);
            return cfg;
        } catch (_) {
            _notebookTypeConfigs.set(notebook, {});
            return {};
        }
    }

    // Synchronous read from the already-primed cache; returns {} if not loaded.
    // Always call loadNotebookConfig first to warm the cache.
    function getCachedNotebookConfig(notebook) {
        return _notebookTypeConfigs.get(notebook) || {};
    }

    // Bust the cache for a notebook — call after saving type config so the next
    // render re-fetches.
    function bustNotebookConfigCache(notebook) {
        _notebookTypeConfigs.delete(notebook);
    }

    // Returns all renderers from the first active module that has previewRenderers,
    // filtered to those whose detect(note) returns true.
    // If the notebook config has a types[note.type].renderer preference, that
    // renderer is promoted to first (becoming the toggle default) without hiding
    // the others — the user can still switch per-session via the toolbar toggle.
    function getPreviewRenderers(notebook, note) {
        const spec = _activeFor(notebook).find(m => m.previewRenderers?.length);
        if (!spec) return [];
        const renderers = spec.previewRenderers.filter(r => !r.detect || r.detect(note));
        if (!renderers.length) return renderers;

        const preferredId = _notebookTypeConfigs.get(notebook)?.types?.[note?.type]?.renderer;
        if (preferredId) {
            const preferred = renderers.find(r => r.id === preferredId);
            if (preferred)
                return [preferred, ...renderers.filter(r => r.id !== preferredId)];
        }
        return renderers;
    }

    // Returns registered renderers from the flat registry, optionally filtered by
    // note type.  type=undefined → all renderers.  type='shot' → renderers whose
    // types[] includes 'shot' (detect-only renderers with types:null are excluded
    // from typed queries but appear in the full list).
    // Used by the Configure Notebook UI to populate type→renderer dropdowns.
    function getRenderers(type) {
        const all = [..._rendererRegistry.values()];
        if (type === undefined) return all;
        return all.filter(r => Array.isArray(r.types) && r.types.includes(type));
    }

    // Returns every type string declared across all registered renderers.
    // Useful for building the full type list in the config UI.
    function getRendererTypes() {
        const types = new Set();
        for (const r of _rendererRegistry.values()) {
            if (Array.isArray(r.types)) r.types.forEach(t => types.add(t));
        }
        return [...types].sort();
    }

    // Returns only type strings from renderers whose plugin is active for this notebook.
    // Used by the Configure Notebook types table so cine types don't appear in non-cine notebooks.
    function getRendererTypesForNotebook(notebookName) {
        const activePlugins = new Set(_activeFor(notebookName).map(m => m.name ?? ''));
        // Always include global plugins (no detect) — they have no pluginName restriction
        const types = new Set();
        for (const r of _rendererRegistry.values()) {
            if (!Array.isArray(r.types)) continue;
            if (!r.pluginName || activePlugins.has(r.pluginName)) {
                r.types.forEach(t => types.add(t));
            }
        }
        return [...types].sort();
    }

    // Returns all custom sort options from plugins active for this notebook.
    // Each entry: { id, label, sort(notes) → notes[] }
    function getSortOptions(notebookName) {
        return _activeFor(notebookName).flatMap(m => m.sortOptions ?? []);
    }

    function getListExcerpt(notebook) {
        return _activeFor(notebook).find(m => m.listExcerpt)?.listExcerpt ?? null;
    }

    // listItemIcon(notebook) → fn(note) → string|null — plugin icon override per note
    function getListItemIcon(notebook) {
        return _activeFor(notebook).find(m => m.listItemIcon)?.listItemIcon ?? null;
    }

    // listTitle — notebook-specific fn(note) → string|null for custom list display titles
    function getListTitle(notebookName) {
        return _activeFor(notebookName).find(m => m.listTitle)?.listTitle ?? null;
    }

    // listButtons — notebook-specific, injected into the List panel toolbar
    function getListButtons(notebook) {
        return _activeFor(notebook).flatMap(m => m.listButtons ?? m.toolbarButtons ?? []);
    }

    // pluginContentModules — active modules that have a pluginContent fn (for panel toggle)
    function getPluginContentModules(notebook) {
        return _activeFor(notebook).filter(m => m.pluginContent);
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

    // ── Editor keybinding API ─────────────────────────────────────────────────────

    // Returns keybinding specs from all modules active for the note's notebook.
    // Each spec: { key, ctrl, shift, alt, label, action(textarea, note) }
    function getEditorKeybindings(note) {
        const nb = note?.notebook || '';
        const out = [];
        for (const mod of _activeFor(nb)) {
            const kb = mod.editorKeybindings;
            if (typeof kb === 'function') out.push(...(kb(note) || []));
            else if (Array.isArray(kb))   out.push(...kb);
        }
        return out;
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

    // Returns key list for a scope name, or null meaning "no filter / show all".
    function getFmKeysForScope(scope) {
        if (!scope || scope === 'all') return null;
        return _fmKeysByScope.has(scope) ? [..._fmKeysByScope.get(scope)] : [];
    }

    function openTerminal() {
        if (typeof NbTerminal !== 'undefined') return NbTerminal.open();
        console.warn('NbWeb.openTerminal: NbTerminal not available');
    }

    return {
        t,
        loadLocale,
        applyI18n,
        registerModule,
        registerRenderer,
        publishWebsite,
        notebooks,
        _loadPlugins,
        _init,
        getPreviewRenderer,
        getPreviewRenderers,
        loadNotebookConfig,
        getCachedNotebookConfig,
        bustNotebookConfigCache,
        getRenderers,
        getRendererTypes,
        getRendererTypesForNotebook,
        getFmKeysForScope,
        getSortOptions,
        getListExcerpt,
        getListItemIcon,
        getListTitle,
        getListButtons,
        getNavButtons,
        getPluginContentModules,
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
        getEditorKeybindings,
        getCodeblockRenderer,
        renderCodeblocks,
        getNotebookSections,
        isExtrasHidden,
        list,
        setEnabled,
        unregister,
    };
})();

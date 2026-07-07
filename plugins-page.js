// nb-web plugins-page.js — extracted from main.js (tier-2e modularization, 2026-07-06).
// NbPluginsPage: the Plugins settings page (list + detail panels for both
// NbWeb-registered plugins and plain `nb` CLI plugins), install/uninstall flows.
//
// Cross-references rewritten during extraction (all other lines verbatim):
//   _esc(...)              -> local copy (matches dialog.js/note-actions.js/search.js precedent)
//   _t(...)                -> local copy (trivial NbWeb.t wrapper, same precedent)
//   _parseMarkdownStatic() -> NbMain.parseMarkdownStatic() (new bare-reference exposure
//                             of an existing kernel utility -- a LOCAL closure function
//                             reference in main.js's return object, not a cross-module
//                             namespace reference, so it is NOT order-sensitive per the
//                             tier-2d amendment: safe regardless of index.html script order)
//
// No shared mutable state: confirmed via full-repo grep that nothing in this
// module reads/writes any NbMain closure variable (_activeSelector, _listSeq,
// etc.) -- genuinely self-contained, unlike the Notebooks-settings block that
// sits right next to this one in main.js (which touches _nbSortMode/_lastNbList
// from kernel code and needs its own, separate, more careful extraction).

const NbPluginsPage = (() => {
    const _t = key => NbWeb.t(key);
    function _esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    async function runPlugins() {
        document.getElementById('nb-preview-toolbar').hidden = true;
        document.getElementById('nb-preview-content').innerHTML =
            '<div id="nb-welcome"><h2>Plugins</h2><p>Loading…</p></div>';
        document.getElementById('nb-list-empty').hidden = true;
        document.getElementById('nb-count').textContent = '…';
        document.getElementById('nb-type-breakdown').textContent = '';

        // Merge NbWeb.list() with settings so each plugin entry carries its url + type
        const [rawPlugins, settings] = await Promise.all([
            Promise.resolve(NbWeb.list()),
            fetch('/api/nb-settings').then(r => r.json()).catch(() => ({})),
        ]);
        const settingsList = settings.plugins || [];
        const nbwebPlugins = rawPlugins.map(p => {
            const entry = settingsList.find(s =>
                s.url?.toLowerCase().includes(p.name.toLowerCase()) ||
                s.name?.toLowerCase().includes(p.name.toLowerCase()));
            return { ...p, url: entry?.url || '', pluginType: entry?.type || 'plugin' };
        });

        let nbPlugins = [];
        try {
            const r = await fetch('/api/run?cmd=plugins');
            const txt = ((await r.json()).output || '').trim();
            const names = txt.split('\n')
                .map(l => l.trim()).filter(l => l && !l.startsWith('[nb]') && !l.startsWith('Plugins'));
            nbPlugins = await Promise.all(names.map(async name => {
                let helpText = '';
                try {
                    const hr = await fetch(`/api/nb/plugin-help?name=${encodeURIComponent(name)}`);
                    if (hr.ok) helpText = (await hr.json()).text || '';
                } catch(_) {}
                const firstDesc = helpText.split('\n').find(l => {
                    const t = l.trim();
                    return t && !t.endsWith('.nb-plugin') && !t.startsWith('#!') &&
                        !/^#*\s*$/.test(t) && !t.toLowerCase().startsWith('install') &&
                        !t.toLowerCase().startsWith('version') && !t.match(/^\s*https?:\/\//) &&
                        !t.match(/^[A-Z][a-z]+:\/\/\//);
                }) || '';
                return { name, helpText, description: firstDesc.trim() };
            }));
        } catch(_) {}

        const total = nbwebPlugins.length + nbPlugins.length;
        document.getElementById('nb-count').textContent =
            `${total} plugin${total !== 1 ? 's' : ''}`;

        _renderPluginPageList(nbwebPlugins, nbPlugins);

        // Auto-select first NbWeb plugin
        const first = document.querySelector('#nb-list .nb-list-item');
        if (first) first.click();
    }

    function _renderPluginPageList(nbwebPlugins, nbPlugins) {
        const list = document.getElementById('nb-list');
        list.innerHTML = '';

        const _addItem = (label, excerpt, icon, cls, onClick) => {
            const li = document.createElement('li');
            li.className = 'nb-list-item ' + cls;
            li.setAttribute('role', 'option');

            const iconEl = document.createElement('span');
            iconEl.className = 'nb-list-icon';
            iconEl.textContent = icon;

            const body = document.createElement('div');
            body.className = 'nb-list-body';

            const titleRow = document.createElement('div');
            titleRow.className = 'nb-list-title-row';
            const titleEl = document.createElement('span');
            titleEl.className = 'nb-list-title';
            titleEl.textContent = label;
            titleRow.appendChild(titleEl);
            body.appendChild(titleRow);

            if (excerpt) {
                const exc = document.createElement('div');
                exc.className = 'nb-list-excerpt';
                exc.textContent = excerpt;
                body.appendChild(exc);
            }

            li.append(iconEl, body);
            li.addEventListener('click', () => {
                list.querySelectorAll('.nb-list-item').forEach(el => el.classList.remove('active'));
                li.classList.add('active');
                onClick();
            });
            list.appendChild(li);
            return li;
        };

        if (nbwebPlugins.length) {
            const hdr = document.createElement('li');
            hdr.className = 'nb-list-section-header';
            hdr.textContent = _t('label_plugins');
            list.appendChild(hdr);

            nbwebPlugins.forEach(p => {
                const activeFor = p.global ? 'all notebooks'
                    : p.activeNotebooks.length ? p.activeNotebooks.join(', ')
                    : p.enabled ? 'none detected' : 'disabled';
                const status = !p.enabled ? '◌ disabled' : p.error ? '✗ error' : '● active';
                _addItem(
                    p.spec?.label || p.name,
                    `${status} · ${activeFor}`,
                    '🔌',
                    'nb-plugin-nbweb' + (p.enabled ? '' : ' nb-plugin-disabled'),
                    () => _openNbwebPlugin(p)
                );
            });

            _addItem('+ Add plugin', 'Install from URL, path, or file', '➕',
                'nb-plugin-add', () => _openInstallPlugin());
        }

        if (nbPlugins.length) {
            const hdr = document.createElement('li');
            hdr.className = 'nb-list-section-header';
            hdr.textContent = 'nb CLI Plugins';
            list.appendChild(hdr);

            nbPlugins.forEach(p => {
                _addItem(p.name, p.description || 'nb CLI plugin', '📦', 'nb-plugin-nb',
                    () => _openNbPlugin(p));
            });
        }
    }

    async function _openNbwebPlugin(p) {
        const content = document.getElementById('nb-preview-content');
        content.innerHTML = '<div style="padding:40px;color:var(--text-muted)">Loading…</div>';

        // Load settings for persisted plugin_prefs
        let pluginPrefs = {};
        try {
            const s = await fetch('/api/nb-settings').then(r => r.json());
            pluginPrefs = (s.plugin_prefs || {})[p.name] || {};
        } catch(_) {}

        // Fetch help markdown if available
        let helpHtml = '';
        if (p.spec?.helpUrl) {
            try {
                const r = await fetch(p.spec.helpUrl);
                const ct = r.headers.get('content-type') || '';
                if (r.ok && ct.includes('text/markdown') || ct.includes('text/plain') || p.spec.helpUrl.endsWith('.md')) {
                    const md = await r.text();
                    if (!md.includes('nb-preview-content')) {
                        helpHtml = `<div class="nb-plugin-help nb-markdown">${NbMain.parseMarkdownStatic(md)}</div>`;
                    }
                }
            } catch(_) {}
        }

        const activeFor = p.global ? 'all notebooks'
            : p.activeNotebooks.length ? p.activeNotebooks.join(', ') : 'none detected';
        const statusColor = p.error ? 'var(--red)' : p.enabled ? 'var(--green,#2ecc71)' : 'var(--text-dim)';
        const statusText  = p.error ? '✗ error' : p.enabled ? '● active' : '◌ disabled';

        // Notebooks section — for plugins with notebookSetup, show active list + activate picker
        let notebooksHtml = '';
        const ns = p.spec?.notebookSetup;
        if (ns && !p.global) {
            const allNbs = NbWeb.notebooks();
            const activeSet = new Set(p.activeNotebooks);
            const inactive  = allNbs.filter(nb => !activeSet.has(nb.name));
            const activeChips = p.activeNotebooks.length
                ? p.activeNotebooks.map(n => `<span class="nb-plug-nb-chip nb-plug-nb-active">● ${_esc(n)}</span>`).join('')
                : '<span style="color:var(--text-dim);font-size:12px">none yet</span>';
            const nbOpts = inactive.map(nb => `<option value="${_esc(nb.name)}">${_esc(nb.name)}</option>`).join('');
            notebooksHtml = `
            <div class="nb-plugin-section nb-plug-notebooks">
                <div class="nb-plugin-section-title">Notebooks</div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">${activeChips}</div>
                ${inactive.length ? `
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                    <select id="nbplug-nb-select" class="nb-scope-select" style="min-width:120px">${nbOpts}</select>
                    <button id="nbplug-nb-activate" class="nb-tool-btn nb-btn-primary">+ Activate</button>
                    <span id="nbplug-nb-msg" style="font-size:11px;color:var(--text-dim)"></span>
                </div>` : '<span style="font-size:11px;color:var(--text-dim)">Active in all notebooks</span>'}
            </div>`;
        }

        const ld = p.spec?.listDefaults;
        let listDefaultsHtml = '';
        if (ld) {
            const curSort = pluginPrefs.sortOrder ?? ld.sortOrder ?? 'default';
            const curType = pluginPrefs.listType  ?? ld.listType  ?? 'all';
            const _builtinSorts = ['default','az','za','newest','oldest'];
            const _pluginSortSpecs = p.spec.sortOptions || [];
            const sortOpts = [
                ..._builtinSorts,
                ...(_pluginSortSpecs.length ? ['---'] : []),
                ..._pluginSortSpecs.map(s => s.id),
            ].map(v => {
                if (v === '---') return `<option disabled>──────────</option>`;
                const label = _pluginSortSpecs.find(s => s.id === v)?.label ?? v;
                return `<option value="${v}"${curSort === v ? ' selected' : ''}>${_esc(label)}</option>`;
            }).join('');
            const typeOpts = ['all','note','bookmark','todo','contact','folder','image']
                .map(v => `<option value="${v}"${curType === v ? ' selected' : ''}>${v}</option>`).join('');
            listDefaultsHtml = `
            <div class="nb-plugin-section">
                <div class="nb-plugin-section-title">List defaults</div>
                <div style="display:grid;gap:8px;grid-template-columns:max-content 1fr;align-items:center;font-size:12px">
                    <label style="color:var(--text-dim)">Sort</label>
                    <select id="nbplug-sort" class="nb-scope-select">${sortOpts}</select>
                    <label style="color:var(--text-dim)">Type</label>
                    <select id="nbplug-type" class="nb-scope-select">${typeOpts}</select>
                </div>
                <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
                    <button id="nbplug-save" class="nb-tool-btn nb-btn-primary">Save defaults</button>
                    <span id="nbplug-save-status" style="font-size:11px;color:var(--text-dim)"></span>
                </div>
            </div>`;
        }

        const isCoreType = p.pluginType === 'core' || p.pluginType === 'bundled';
        content.innerHTML = `
            <div class="nb-plugin-header">
                <span style="font-size:18px">🔌</span>
                <strong style="font-size:14px;color:var(--text)">${_esc(p.spec?.label || p.name)}</strong>
                <span style="color:${statusColor};font-size:12px">${statusText}</span>
                <span class="nb-plugin-active-for">${_esc(activeFor)}</span>
            </div>
            ${p.spec?.description ? `<div class="nb-plugin-desc">${_esc(p.spec.description)}</div>` : ''}
            ${notebooksHtml}
            ${helpHtml}
            ${listDefaultsHtml}
            <div id="nbplug-custom-content"></div>
            <div class="nb-plugin-section" style="display:flex;gap:8px;flex-wrap:wrap">
                ${!isCoreType ? `<button id="nbplug-toggle" class="nb-tool-btn">${p.enabled ? 'Disable' : 'Enable'}</button>` : ''}
                ${!isCoreType && NbAuth?.is('tech') ? `<button id="nbplug-remove" class="nb-tool-btn" style="color:var(--red)">Remove</button>` : ''}
                ${isCoreType ? `<span style="font-size:11px;color:var(--text-dim)">Core plugin — cannot be removed</span>` : ''}
            </div>`;

        if (p.spec?.pluginContent) {
            const el = document.getElementById('nbplug-custom-content');
            if (el) {
                if (p.spec.requirementCheck) {
                    const req = await p.spec.requirementCheck();
                    if (req && !req.ok) {
                        await NbWeb.renderRequirementsCard(el, req.markdownFile || req.markdown || '# Requirements not met');
                    } else {
                        p.spec.pluginContent(el);
                    }
                } else {
                    p.spec.pluginContent(el);
                }
            }
        }

        // Notebook activate button
        document.getElementById('nbplug-nb-activate')?.addEventListener('click', async () => {
            const nb  = document.getElementById('nbplug-nb-select')?.value;
            const msg = document.getElementById('nbplug-nb-msg');
            if (!nb || !ns) return;
            msg.textContent = 'Activating…';
            msg.style.color = 'var(--text-dim)';
            try {
                const r = await fetch('/api/nb/plugin-activate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ notebook: nb, config_file: ns.configFile, default_config: ns.defaultConfig || {} }),
                });
                const d = await r.json();
                if (!r.ok) throw new Error(d.error || r.statusText);
                msg.textContent = `✓ activated for ${nb}`;
                msg.style.color = 'var(--green,#2ecc71)';
                await NbWeb._init();
                setTimeout(runPlugins, 800);
            } catch(e) {
                msg.textContent = '✗ ' + e.message;
                msg.style.color = 'var(--red)';
            }
        });

        document.getElementById('nbplug-save')?.addEventListener('click', async () => {
            const sort = document.getElementById('nbplug-sort').value;
            const type = document.getElementById('nbplug-type').value;
            const statusEl = document.getElementById('nbplug-save-status');
            try {
                const s = await fetch('/api/nb-settings').then(r => r.json());
                const prefs = s.plugin_prefs || {};
                prefs[p.name] = { sortOrder: sort, listType: type };
                await fetch('/api/nb-settings', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ plugin_prefs: prefs }),
                });
                statusEl.textContent = '✓ saved';
                setTimeout(() => statusEl.textContent = '', 2000);
            } catch(e) {
                statusEl.textContent = '✗ ' + e.message;
            }
        });

        document.getElementById('nbplug-toggle')?.addEventListener('click', async () => {
            if (!p.url) return;
            NbWeb.setEnabled(p.name, !p.enabled);
            await fetch('/api/plugins/toggle', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: p.url, enabled: !p.enabled }),
            });
            runPlugins();
        });

        document.getElementById('nbplug-remove')?.addEventListener('click', async () => {
            if (!p.url) return;
            if (!confirm(`Remove plugin "${p.spec?.label || p.name}"?`)) return;
            NbWeb.unregister(p.name);
            await fetch('/api/plugins/uninstall', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: p.url }),
            });
            runPlugins();
        });
    }

    async function _openNbPlugin(p) {
        const content = document.getElementById('nb-preview-content');

        const helpHtml = p.helpText
            ? `<pre class="nb-plugin-help-pre">${_esc(p.helpText)}</pre>`
            : `<div style="color:var(--text-dim);font-size:12px">No help text found in plugin file.</div>`;

        content.innerHTML = `
            <div class="nb-plugin-header">
                <span style="font-size:18px">📦</span>
                <strong style="font-size:14px;color:var(--text)">${_esc(p.name)}</strong>
                <span class="nb-plugin-nb-badge">nb CLI</span>
            </div>
            <div class="nb-plugin-section nb-plugin-help">
                ${helpHtml}
            </div>
            <div class="nb-plugin-section" style="display:flex;gap:8px;align-items:center">
                <button id="nbplug-nb-uninstall" class="nb-tool-btn" style="color:var(--red)">Uninstall</button>
                <span style="font-size:11px;color:var(--text-dim)">or: <code>nb plugins uninstall ${_esc(p.name)}</code></span>
            </div>`;

        document.getElementById('nbplug-nb-uninstall').addEventListener('click', async () => {
            if (!confirm(`Uninstall nb plugin "${p.name}"?`)) return;
            document.getElementById('nb-preview-content').innerHTML +=
                `<div style="padding:8px 28px;font-size:12px;color:var(--text-dim)">
                    Run in terminal: <code>nb plugins uninstall ${_esc(p.name)}</code>
                </div>`;
        });
    }

    function _openInstallPlugin() {
        const content = document.getElementById('nb-preview-content');
        content.innerHTML = `
            <div style="padding:28px 32px;max-width:520px">
                <h2 style="margin:0 0 6px;font-size:16px">Install Plugin</h2>
                <p style="margin:0 0 20px;font-size:12px;color:var(--text-dim)">
                    Enter a URL, local path (<code>~/dev/myplugin/myplugin.js</code>), or use
                    the file picker. The plugin file is copied to the managed plugins directory
                    and registered in <code>nb-settings.json</code>.
                </p>

                <div class="nb-plugin-section">
                    <div class="nb-plugin-section-title">URL or path</div>
                    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                        <input id="nbplug-install-url" type="text"
                               placeholder="https://... or ~/dev/myplugin/myplugin.js"
                               style="flex:1;min-width:200px;padding:5px 8px;font-size:12px;
                                      border:1px solid var(--border);border-radius:4px;
                                      background:var(--bg-input,var(--bg));color:var(--text)">
                        <button id="nbplug-install-go" class="nb-tool-btn nb-btn-primary">Install</button>
                    </div>
                    <div style="margin-top:8px;display:flex;gap:6px;align-items:center">
                        <label class="nb-tool-btn" style="cursor:pointer">
                            Browse…<input id="nbplug-install-file" type="file" accept=".js" style="display:none">
                        </label>
                        <span style="font-size:11px;color:var(--text-dim)">Upload a .js file directly</span>
                    </div>
                    <div id="nbplug-install-msg" style="margin-top:10px;font-size:12px;min-height:16px"></div>
                </div>
            </div>`;

        const msg = content.querySelector('#nbplug-install-msg');

        const _doInstall = async (body, isFormData = false) => {
            msg.textContent = 'Installing…';
            msg.style.color = 'var(--text-dim)';
            try {
                const r = await fetch('/api/plugins/install', {
                    method: 'POST',
                    ...(isFormData ? { body } : {
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                    }),
                });
                const d = await r.json();
                if (!r.ok) throw new Error(d.error || r.statusText);
                msg.textContent = `✓ Installed — reload to activate`;
                msg.style.color = 'var(--green,#2ecc71)';
                await NbWeb._init();
                setTimeout(runPlugins, 1000);
            } catch(e) {
                msg.textContent = '✗ ' + e.message;
                msg.style.color = 'var(--red)';
            }
        };

        content.querySelector('#nbplug-install-go').addEventListener('click', () => {
            const url = content.querySelector('#nbplug-install-url').value.trim();
            if (!url) { msg.textContent = 'Enter a URL or path.'; msg.style.color = 'var(--red)'; return; }
            _doInstall({ url });
        });

        content.querySelector('#nbplug-install-url').addEventListener('keydown', e => {
            if (e.key === 'Enter') content.querySelector('#nbplug-install-go').click();
        });

        content.querySelector('#nbplug-install-file').addEventListener('change', e => {
            const file = e.target.files?.[0];
            if (!file) return;
            const fd = new FormData();
            fd.append('file', file);
            _doInstall(fd, true);
        });
    }

    return { runPlugins };
})();

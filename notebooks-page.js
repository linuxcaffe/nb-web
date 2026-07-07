// nb-web notebooks-page.js — extracted from main.js (tier-2f modularization, 2026-07-07).
// NbNotebooksPage: the Notebooks settings view (list of notebooks, sync
// status, per-notebook detail panel: git wire/sync, lock, config, type
// renderers & access, defaults, danger zone).
//
// Cross-references rewritten during extraction (all other lines verbatim):
//   _esc(...)/_t(...)   -> local copies (matches sync.js/plugins-page.js/etc precedent)
//   _nbSortMode (read)  -> NbMain.getNbSortMode() -- kernel-owned: kernel's own
//                          _bindSortBtn (Panel menus section, main.js) also reads it
//                          to mark the active item in the shared #nb-sort-btn dropdown,
//                          which serves the plain note-list sort too.
//   _lastNbList         -> privatized: a full-repo grep confirmed the ONLY kernel-side
//                          use was _applyNbSort passing it straight through to this
//                          module's own renderNbList() with no other kernel consumption
//                          -- moved to a local `let` in this closure, no accessor needed
//                          (an earlier draft of this tier exposed getLastNbList/
//                          setLastNbList on NbMain, caught as an unjustified context-
//                          object-shaped leak during review and corrected before commit)
//   _sortNbList(...)    -> moved in verbatim as a local function: a full-repo grep
//                          confirmed its only caller anywhere was this module's own
//                          renderNbList() -- no kernel code calls it, so "expose from
//                          the kernel, don't move" (the showCmdOutput/parseMarkdownStatic
//                          precedent) did not actually apply here, unlike an earlier
//                          draft of this tier assumed
//   _lastNbCurrent      -> privatized: confirmed via full-repo grep that no kernel code
//                          reads or writes it outside this block -- moved to a local
//                          `let` in this closure, no accessor needed
//
// Reverse cross-reference: kernel's _applyNbSort (Panel menus, main.js) calls
// `NbNotebooksPage.renderNbList()` (no args) after a sort-mode change -- a call
// inside a function body (deferred, call-time), not a return-object bare reference,
// so it is NOT order-sensitive regardless of index.html script position. renderNbList
// defaults its `notebooks` param to this module's own remembered `_lastNbList` so the
// kernel doesn't need to hold or pass the array itself.

const NbNotebooksPage = (() => {
    const _t = key => NbWeb.t(key);
    function _esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    let _lastNbCurrent = 'home';  // nb's actual current notebook (from ~/.nb/.current) -- privatized, no kernel reader
    let _lastNbList     = [];     // last fetched notebooks array -- privatized, no kernel reader (see header note)

    function _sortNbList(notebooks) {
        const sorted = [...notebooks];
        const mode = NbMain.getNbSortMode();
        if (mode === 'az')          sorted.sort((a, b) => a.name.localeCompare(b.name));
        else if (mode === 'za')     sorted.sort((a, b) => b.name.localeCompare(a.name));
        else if (mode === 'most')   sorted.sort((a, b) => b.count - a.count);
        else if (mode === 'fewest') sorted.sort((a, b) => a.count - b.count);
        else { // current-first: nb's current notebook on top, rest by mtime desc
            sorted.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
            const idx = sorted.findIndex(n => n.is_current);
            if (idx > 0) { const [nb] = sorted.splice(idx, 1); sorted.unshift(nb); }
        }
        return sorted;
    }

    async function runNbNotebooks() {
        const countEl = document.getElementById('nb-count');
        document.getElementById('nb-type-breakdown').textContent = '';
        document.getElementById('nb-preview-toolbar').hidden = true;
        document.getElementById('nb-preview-content').innerHTML =
            '<div id="nb-welcome"><h2>Notebooks</h2><p>Loading…</p></div>';
        document.getElementById('nb-list-empty').hidden = true;
        countEl.textContent = '…';

        // Reset sort button indicator
        const sortBtn = document.getElementById('nb-sort-btn');
        if (sortBtn) sortBtn.classList.toggle('nb-sort-active', NbMain.getNbSortMode() !== 'active-first');

        try {
            const r = await fetch('/api/nb/notebooks');
            const d = await r.json();
            _lastNbList    = d.notebooks || [];
            _lastNbCurrent = d.current_notebook || 'home';

            countEl.textContent = `${_lastNbList.length} notebook${_lastNbList.length !== 1 ? 's' : ''}`;

            if (!_lastNbList.length) {
                document.getElementById('nb-list-empty').hidden = false;
                document.getElementById('nb-list-empty').textContent = _t('msg_no_notebooks');
                return;
            }

            _renderNbList(_lastNbList);

            // Auto-open the active notebook
            const active = NbNav.notebook === '_all' ? 'home' : NbNav.notebook;
            const activeItem = document.querySelector(`#nb-list .nb-list-item[data-nb="${CSS.escape(active)}"]`);
            if (activeItem) activeItem.click();

        } catch(e) {
            countEl.textContent = 'error';
            console.error('runNbNotebooks:', e);
        }
    }

    function _renderNbList(notebooks = _lastNbList) {
        const list   = document.getElementById('nb-list');
        const sorted = _sortNbList(notebooks);
        const prevSelected = list.querySelector('.nb-list-item.active')?.dataset.nb;

        // Update type-breakdown with total notes across all notebooks
        const total = notebooks.reduce((s, n) => s + n.count, 0);
        document.getElementById('nb-type-breakdown').textContent =
            `${total} note${total !== 1 ? 's' : ''} total`;

        list.innerHTML = '';
        sorted.forEach(nb => {
            const isCurrent = nb.is_current;
            const li = document.createElement('li');
            li.className = 'nb-list-item' + (nb.name === (prevSelected || _lastNbCurrent) ? ' active' : '');
            li.setAttribute('role', 'option');
            li.dataset.nb = nb.name;

            // Sync status dot: yellow=unpushed, grey=no remote, green=synced
            const dot = document.createElement('span');
            dot.style.cssText = 'width:7px;height:7px;border-radius:50%;flex-shrink:0;margin-right:2px;align-self:center';
            if (!nb.has_remote)      { dot.style.background = 'var(--text-dim)'; dot.title = _t('tip_no_remote'); }
            else if (nb.unpushed > 0){ dot.style.background = 'var(--yellow,#f0b429)'; dot.title = `${nb.unpushed} unpushed`; }
            else                     { dot.style.background = 'var(--green,#2ecc71)';  dot.title = _t('tip_synced'); }

            const icon = document.createElement('span');
            icon.className = 'nb-list-icon';
            icon.textContent = isCurrent ? '📖' : '📒';
            icon.title = isCurrent ? 'Current notebook (nb use)' : '';

            const body = document.createElement('div');
            body.className = 'nb-list-body';

            const titleRow = document.createElement('div');
            titleRow.className = 'nb-list-title-row';

            const titleEl = document.createElement('span');
            titleEl.className = 'nb-list-title';
            titleEl.textContent = nb.name;
            if (isCurrent) titleEl.style.fontWeight = '600';
            titleRow.appendChild(titleEl);

            if (isCurrent) {
                const badge = document.createElement('span');
                badge.className = 'nb-list-ann-badge';
                badge.textContent = 'current';
                badge.title = 'Set as current with nb use';
                badge.style.cssText = 'font-size:9px;padding:1px 4px;border-radius:3px;' +
                    'background:var(--accent,#2980b9);color:#fff;margin-left:4px;font-weight:600;letter-spacing:0.04em';
                titleRow.appendChild(badge);
            }

            if (nb.folder_count > 0) {
                const folderBadge = document.createElement('span');
                folderBadge.className = 'nb-list-id';
                folderBadge.textContent = `📂${nb.folder_count}`;
                folderBadge.title = `${nb.folder_count} folder${nb.folder_count !== 1 ? 's' : ''}`;
                folderBadge.style.cssText = 'font-size:10px;';
                titleRow.appendChild(folderBadge);
            }

            const countBadge = document.createElement('span');
            countBadge.className = 'nb-list-id';
            countBadge.textContent = nb.count;
            countBadge.title = `${nb.count} note${nb.count !== 1 ? 's' : ''}`;
            titleRow.appendChild(countBadge);

            if (nb.locked) {
                const lockBadge = document.createElement('span');
                lockBadge.textContent = '🔒';
                lockBadge.title = 'Notebook locked';
                lockBadge.style.cssText = 'font-size:10px;opacity:0.8;';
                titleRow.appendChild(lockBadge);
            }

            body.appendChild(titleRow);

            if (nb.unpushed > 0) {
                const exc = document.createElement('div');
                exc.className = 'nb-list-excerpt';
                exc.style.color = 'var(--yellow,#f0b429)';
                exc.textContent = `${nb.unpushed} unpushed commit${nb.unpushed !== 1 ? 's' : ''}`;
                body.appendChild(exc);
            }

            li.append(dot, icon, body);
            li.addEventListener('click', () => {
                list.querySelectorAll('.nb-list-item').forEach(el => el.classList.remove('active'));
                li.classList.add('active');
                _openNbNotebook(nb.name);
                NbNav.pollSyncStatus(nb.name);
            });
            list.appendChild(li);
        });
    }

    function _renderNotebookSection(section, nbObj) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'padding:0 28px 14px;border-top:1px solid var(--border);margin-top:4px';

        const lbl = document.createElement('div');
        lbl.style.cssText = 'font-size:11px;color:var(--text-dim);margin:12px 0 8px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase';
        lbl.textContent = section.label;
        wrap.appendChild(lbl);

        if (section.rows?.length) {
            const grid = document.createElement('div');
            grid.style.cssText = 'display:grid;gap:4px 12px;grid-template-columns:max-content 1fr;align-items:baseline;font-size:12px;margin-bottom:10px';
            section.rows.forEach(row => {
                const k = document.createElement('span');
                k.style.color = 'var(--text-dim)';
                k.textContent = row.key;
                grid.appendChild(k);

                const v = document.createElement('span');
                v.style.cssText = 'color:var(--text);font-family:var(--font-mono);font-size:11px;word-break:break-all';
                if (row.link) {
                    const a = document.createElement('a');
                    a.href = row.link;
                    a.target = '_blank';
                    a.rel = 'noopener';
                    a.style.cssText = 'color:var(--accent,var(--text));text-decoration:none';
                    a.textContent = row.value || row.link;
                    v.appendChild(a);
                } else {
                    v.textContent = row.value || '—';
                }
                if (row.action) {
                    const ab = document.createElement('button');
                    ab.className = 'nb-tool-btn';
                    ab.style.marginLeft = '8px';
                    ab.textContent = row.action.label;
                    ab.addEventListener('click', () => row.action.fn(nbObj, ab));
                    v.appendChild(ab);
                }
                grid.appendChild(v);
            });
            wrap.appendChild(grid);
        }

        // Singleton + folder-scoped template rows — async ✓/seed status
        const seedable = NbWeb.getTemplatesForNotebook(nbObj.name)
            .filter(t => t.moduleName === section.moduleName &&
                         ((t.singleton && t.filename) || t.scope?.startsWith('folder:')));

        if (seedable.length) {
            const tmplGrid = document.createElement('div');
            tmplGrid.style.cssText = 'display:grid;gap:5px 12px;grid-template-columns:max-content 1fr;align-items:center;font-size:12px;margin-bottom:10px';

            seedable.forEach(t => {
                const relpath   = NbWeb.templateRelPath(t);
                const isSeed    = !!t.scope;
                const btnLabel  = isSeed ? '+ Seed' : '+ Create';

                const k = document.createElement('span');
                k.style.cssText = 'color:var(--text-dim);font-family:var(--font-mono);font-size:11px';
                k.textContent = relpath;
                tmplGrid.appendChild(k);

                const v = document.createElement('span');
                v.style.cssText = 'font-size:11px;color:var(--text-dim)';
                v.textContent = '…';
                tmplGrid.appendChild(v);

                NbWeb.templateSeeded(nbObj.name, t).then(exists => {
                    if (exists) {
                        v.style.color = 'var(--green,#2ecc71)';
                        v.textContent = '✓';
                    } else {
                        v.textContent = '';
                        const btn = document.createElement('button');
                        btn.className = 'nb-tool-btn';
                        btn.style.cssText = 'font-size:11px;padding:1px 7px';
                        btn.textContent = btnLabel;
                        btn.addEventListener('click', async () => {
                            btn.disabled = true;
                            btn.textContent = '…';
                            const result = await NbWeb.createFromTemplate(t, nbObj);
                            if (result.ok) {
                                btn.remove();
                                v.style.color = 'var(--green,#2ecc71)';
                                v.textContent = '✓';
                            } else {
                                btn.disabled = false;
                                btn.textContent = btnLabel;
                                btn.title = result.error || 'failed';
                            }
                        });
                        v.appendChild(btn);
                    }
                });
            });

            wrap.appendChild(tmplGrid);
        }

        if (section.actions?.length) {
            const actRow = document.createElement('div');
            actRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
            section.actions.forEach(act => {
                const btn = document.createElement('button');
                btn.id = act.id;
                btn.className = 'nb-tool-btn' + (act.primary ? ' nb-btn-primary' : '');
                btn.title = act.title || act.label || '';
                btn.textContent = (act.icon ? act.icon + ' ' : '') + (act.label || '');
                btn.addEventListener('click', () => act.fn(nbObj, btn));
                actRow.appendChild(btn);
            });
            wrap.appendChild(actRow);
        }

        return wrap;
    }

    async function _openNbNotebook(name) {
        const content = document.getElementById('nb-preview-content');
        content.innerHTML = '<div style="padding:40px;color:var(--text-muted)">Loading…</div>';
        document.getElementById('nb-preview-toolbar').hidden = true;

        try {
            const r = await fetch('/api/nb/notebook-detail?notebook=' + encodeURIComponent(name));
            const d = await r.json();
            if (d.error) { content.innerHTML = `<div style="padding:40px;color:var(--text-danger)">${_esc(d.error)}</div>`; return; }

            const g = d.git;
            const syncStatus = !g.has_git ? 'no git'
                             : !g.has_remote ? 'not wired'
                             : g.unpushed > 0 ? `${g.unpushed} unpushed`
                             : 'synced';
            const syncColor = !g.has_git || !g.has_remote ? 'var(--text-dim)'
                            : g.unpushed > 0 ? 'var(--yellow)' : 'var(--green,#2ecc71)';

            const prefs = d.prefs || {};
            const sortOpts = ['default','az','za','newest','oldest']
                .map(v => `<option value="${v}"${prefs.default_sort === v ? ' selected' : ''}>${v}</option>`)
                .join('');
            const typeOpts = ['all','note','bookmark','todo','contact','folder','image']
                .map(v => `<option value="${v}"${prefs.default_list_type === v ? ' selected' : ''}>${v}</option>`)
                .join('');

            content.innerHTML = `
                <div style="padding:10px 28px 8px;border-bottom:1px solid var(--border);
                            font-size:11px;color:var(--text-dim);font-family:var(--font-mono);
                            display:flex;align-items:center;gap:10px">
                    <span style="font-size:15px">📒</span>
                    <strong style="font-size:13px;color:var(--text)">${_esc(name)}</strong>
                    <span style="color:${syncColor}">${_esc(syncStatus)}</span>
                </div>
                <div style="padding:18px 28px 0;display:grid;gap:6px;font-size:12px;
                            grid-template-columns:max-content 1fr;align-items:baseline;
                            color:var(--text-dim)">
                    <span>Notes</span>
                    <span style="color:var(--text)">${d.count}</span>
                    <span>Path</span>
                    <span style="color:var(--text);font-family:var(--font-mono);font-size:11px;
                                word-break:break-all">${_esc(d.path)}</span>
                    ${g.has_git ? `
                    <span>Branch</span>
                    <span style="color:var(--text)">${_esc(g.branch || '—')}</span>
                    <span>Remote</span>
                    <span style="color:var(--text);font-family:var(--font-mono);font-size:11px;
                                word-break:break-all">${g.remote_url ? _esc(g.remote_url) : '<em style="color:var(--text-dim)">not wired</em>'}</span>
                    <span>Last commit</span>
                    <span style="color:var(--text)">${g.last_commit ? `${_esc(g.last_commit.hash)} · ${_esc(g.last_commit.subject)} · ${_esc(g.last_commit.age)}` : '—'}</span>
                    ` : `
                    <span>Git</span><span style="color:var(--text-dim)">no git repo</span>
                    `}
                </div>
                <div id="nb-nb-actions" style="padding:14px 28px 8px;display:flex;gap:8px;flex-wrap:wrap;border-top:1px solid var(--border);margin-top:14px">
                    ${!g.has_remote && g.has_git ? `<button id="nb-nb-wire" class="nb-tool-btn">Wire remote</button>` : ''}
                    ${g.has_remote ? `<button id="nb-nb-sync" class="nb-tool-btn nb-btn-primary">Sync</button>` : ''}
                </div>
                <div id="nb-nb-wire-area" style="display:${!g.has_remote && g.has_git ? 'block' : 'none'};padding:8px 28px 14px;border-top:1px solid var(--border)">
                    <div style="font-size:11px;color:var(--text-dim);margin-bottom:6px">
                        Wire to remote — adds a new branch to an existing repo
                    </div>
                    <div style="display:flex;gap:6px">
                        <input id="nb-nb-wire-url" type="text" class="nb-opt-input"
                               placeholder="${d.default_remote ? _esc(d.default_remote) + '  (default)' : 'git@github.com:user/nb-notes.git'}"
                               style="flex:1">
                        <button id="nb-nb-wire-go" class="nb-tool-btn nb-btn-primary">Wire</button>
                    </div>
                    ${d.default_remote ? `<div style="font-size:10px;color:var(--text-dim);margin-top:4px">Leave blank to use default: <code>${_esc(d.default_remote)}</code></div>` : `<div style="font-size:10px;color:var(--text-dim);margin-top:4px">Set a default remote in <strong>Settings → Git</strong> to skip typing this each time.</div>`}
                    <details style="margin-top:10px">
                        <summary style="font-size:11px;color:var(--text-dim);cursor:pointer">Create a new separate GitHub repo instead…</summary>
                        <div style="padding-top:8px;display:flex;gap:6px;align-items:center">
                            <label style="font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer">
                                <input type="radio" name="nb-gh-vis" value="private" checked> Private
                            </label>
                            <label style="font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer">
                                <input type="radio" name="nb-gh-vis" value="public"> Public
                            </label>
                            <button id="nb-nb-gh-create" class="nb-tool-btn" style="margin-left:4px">Create &amp; Wire</button>
                        </div>
                    </details>
                    <pre id="nb-nb-wire-out" style="margin-top:8px;font-size:11px;white-space:pre-wrap;display:none"></pre>
                </div>
                <div id="nb-nb-plugin-sections"></div>
                <div style="padding:6px 28px 12px;border-top:1px solid var(--border);display:flex;align-items:center;gap:10px">
                    <button id="nb-nb-use" class="nb-tool-btn">Use this notebook</button>
                    <span style="font-size:11px;color:var(--text-dim)">Set as the active scope for List, Add, and other commands.</span>
                </div>
                <div style="padding:6px 28px 12px;border-top:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                    <button id="nb-nb-lock-btn" class="nb-tool-btn${d.locked ? ' nb-btn-danger' : ''}">${d.locked ? '🔒 Unlock notebook' : '🔒 Lock notebook'}</button>
                    <span style="font-size:11px;color:var(--text-dim)">${d.locked ? (d.lock_reason ? _esc(d.lock_reason) : 'Notebook is read-only — all notes locked.') : 'Prevent edits to all notes in this notebook.'}</span>
                </div>
                ${!name.startsWith('.') ? `
                <div style="padding:6px 28px 12px;border-top:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                    <button id="nb-nb-config-btn" class="nb-tool-btn">⚙ Configure notebook</button>
                    <span style="font-size:11px;color:var(--text-dim)">Set notebook-wide access level and other config (<code style="font-size:10px">.${name}.md</code>).</span>
                </div>
                <div id="nb-nb-config-area" style="display:none;padding:8px 28px 14px;border-top:1px solid var(--border)">
                    <textarea id="nb-nb-config-text" class="nb-opt-input"
                              style="width:100%;min-height:80px;font-family:var(--font-mono);font-size:12px;resize:vertical;box-sizing:border-box"></textarea>
                    <div style="display:flex;gap:6px;margin-top:6px;align-items:center">
                        <button id="nb-nb-config-save" class="nb-tool-btn nb-btn-primary">Save</button>
                        <span id="nb-nb-config-status" style="font-size:11px;color:var(--text-dim)"></span>
                    </div>
                    <div style="font-size:10px;color:var(--text-dim);margin-top:6px">
                        Changes take effect immediately — no restart needed.
                    </div>
                </div>
                <div style="padding:6px 28px 14px;border-top:1px solid var(--border)">
                    <div style="font-size:11px;color:var(--text-dim);margin:8px 0 6px;font-weight:600;
                                letter-spacing:0.05em;text-transform:uppercase">Type renderers & access</div>
                    <div id="nb-nb-types-wrap" style="font-size:11px;color:var(--text-dim)">Loading…</div>
                    <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
                        <button id="nb-nb-types-save" class="nb-tool-btn nb-btn-primary">Save type config</button>
                        <span id="nb-nb-types-status" style="font-size:11px;color:var(--text-dim)"></span>
                    </div>
                </div>` : ''}
                <div style="padding:0 28px 14px;border-top:1px solid var(--border);margin-top:4px">
                    <div style="font-size:11px;color:var(--text-dim);margin:12px 0 8px;font-weight:600;
                                letter-spacing:0.05em;text-transform:uppercase">Defaults</div>
                    <div style="display:grid;gap:8px;grid-template-columns:max-content 1fr;align-items:center;font-size:12px">
                        <label style="color:var(--text-dim)" for="nb-nb-sort">Sort</label>
                        <select id="nb-nb-sort" class="nb-scope-select">${sortOpts}</select>
                        <label style="color:var(--text-dim)" for="nb-nb-type">Type</label>
                        <select id="nb-nb-type" class="nb-scope-select">${typeOpts}</select>
                        <label style="color:var(--text-dim)" for="nb-nb-template">Template</label>
                        <div style="display:flex;gap:6px;align-items:center">
                            <span id="nb-nb-tmpl-name" style="font-size:11px;font-family:var(--font-mono);
                                  color:var(--text-dim)">${prefs.default_template ? _esc(prefs.default_template) : '(none)'}</span>
                            <button id="nb-nb-tmpl-clear" class="nb-tool-btn" style="font-size:10px;padding:1px 6px"
                                    ${!prefs.default_template ? 'hidden' : ''}>Clear</button>
                        </div>
                        <div id="nb-nb-plugin-defaults" style="display:contents"></div>
                    </div>
                    <div style="margin-top:12px;display:flex;gap:8px">
                        <button id="nb-nb-save-prefs" class="nb-tool-btn nb-btn-primary">Save defaults</button>
                        <span id="nb-nb-prefs-status" style="font-size:11px;color:var(--text-dim);align-self:center"></span>
                    </div>
                </div>`;

            // Plugin sections — one per active NbWeb module for this notebook
            const nbObj = NbWeb.notebooks().find(nb => nb.name === name);
            const pluginSectionsEl = content.querySelector('#nb-nb-plugin-sections');
            if (nbObj && pluginSectionsEl) {
                NbWeb.getNotebookSections(nbObj).forEach(section => {
                    pluginSectionsEl.appendChild(_renderNotebookSection(section, nbObj));
                });
            }

            // Plugin scoped templates — injected into the DEFAULTS grid
            const pluginDefaultsEl = content.querySelector('#nb-nb-plugin-defaults');
            if (pluginDefaultsEl) {
                const scopedTmpls = NbWeb.getScopedTemplatesForNotebook(name);
                scopedTmpls.forEach(t => {
                    const k = document.createElement('span');
                    k.style.cssText = 'color:var(--text-dim)';
                    k.textContent = t.name;
                    const v = document.createElement('span');
                    v.style.cssText = 'font-size:11px;color:var(--text-dim)';
                    v.textContent = `${t.description || ''}${t.description ? ' · ' : ''}${t.moduleLabel}`;
                    pluginDefaultsEl.appendChild(k);
                    pluginDefaultsEl.appendChild(v);
                });
            }

            // Folders — async-fetched and injected into the info grid
            fetch(`/api/folders?notebook=${encodeURIComponent(name)}`).then(r => r.json()).then(fd => {
                const folders = fd.folders || [];
                if (!folders.length) return;
                const grid = content.querySelector('[style*="grid-template-columns"]');
                if (!grid) return;
                const lbl = document.createElement('span');
                lbl.style.cssText = 'color:var(--text-dim)';
                lbl.textContent = _t('label_folders');
                const val = document.createElement('span');
                val.style.cssText = 'color:var(--text);font-family:var(--font-mono);font-size:11px';
                val.textContent = folders.join('  ·  ');
                grid.appendChild(lbl);
                grid.appendChild(val);
            }).catch(() => {});

            // Wire remote toggle
            const wireBtn = document.getElementById('nb-nb-wire');
            const wireArea = document.getElementById('nb-nb-wire-area');
            if (wireBtn) {
                wireBtn.addEventListener('click', () => {
                    wireArea.style.display = wireArea.style.display === 'none' ? 'block' : 'none';
                });
            }
            const wireGoBtn = document.getElementById('nb-nb-wire-go');
            if (wireGoBtn) {
                wireGoBtn.addEventListener('click', async () => {
                    const url = document.getElementById('nb-nb-wire-url').value.trim();
                    const out = document.getElementById('nb-nb-wire-out');
                    wireGoBtn.textContent = 'Wiring…'; wireGoBtn.disabled = true;
                    out.style.display = 'block';
                    out.textContent = 'Working…';
                    try {
                        const wr = await fetch('/api/nb/wire-notebook', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ notebook: name, remote_url: url }),
                        });
                        const wd = await wr.json();
                        out.textContent = wd.output || (wd.success ? '✓ Done' : '✗ Failed');
                        out.style.color = wd.success ? 'var(--green,#2ecc71)' : 'var(--red,#e74c3c)';
                        if (wd.success) setTimeout(() => _openNbNotebook(name), 1500);
                    } catch(e) {
                        out.textContent = 'Error: ' + e;
                    } finally {
                        wireGoBtn.textContent = 'Wire'; wireGoBtn.disabled = false;
                    }
                });
            }

            // Create & Wire on GitHub
            const ghCreateBtn = document.getElementById('nb-nb-gh-create');
            if (ghCreateBtn) {
                ghCreateBtn.addEventListener('click', async () => {
                    const out = document.getElementById('nb-nb-wire-out');
                    const vis = document.querySelector('input[name="nb-gh-vis"]:checked')?.value || 'private';
                    ghCreateBtn.textContent = 'Creating…'; ghCreateBtn.disabled = true;
                    out.style.display = 'block';
                    out.textContent = 'Creating GitHub repo and pushing…';
                    out.style.color = 'var(--text-dim)';
                    try {
                        const wr = await fetch('/api/nb/github-create', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ notebook: name, visibility: vis }),
                        });
                        const wd = await wr.json();
                        out.textContent = wd.output || (wd.success ? '✓ Done' : '✗ Failed');
                        out.style.color = wd.success ? 'var(--green,#2ecc71)' : 'var(--red,#e74c3c)';
                        if (wd.success) setTimeout(() => _openNbNotebook(name), 1500);
                    } catch(e) {
                        out.textContent = 'Error: ' + e;
                        out.style.color = 'var(--red,#e74c3c)';
                    } finally {
                        ghCreateBtn.textContent = 'Create & Wire'; ghCreateBtn.disabled = false;
                    }
                });
            }

            // Sync button
            const syncBtn = document.getElementById('nb-nb-sync');
            if (syncBtn) {
                syncBtn.addEventListener('click', async () => {
                    syncBtn.textContent = 'Syncing…'; syncBtn.disabled = true;
                    try {
                        const sr = await fetch('/api/sync', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ notebook: name, message: '' }),
                        });
                        const sd = await sr.json();
                        const out = document.createElement('pre');
                        out.style.cssText = 'margin:8px 28px;font-size:11px;color:var(--text-dim);white-space:pre-wrap';
                        out.textContent = sd.output || sd.error || '(no output)';
                        document.getElementById('nb-nb-actions').after(out);
                        setTimeout(() => _openNbNotebook(name), 3000);
                    } catch(e) {
                        syncBtn.textContent = 'Sync'; syncBtn.disabled = false;
                    }
                });
            }

            // ── Type renderers & access ────────────────────────────────────────
            const _typesWrap   = document.getElementById('nb-nb-types-wrap');
            const _typesSave   = document.getElementById('nb-nb-types-save');
            const _typesStatus = document.getElementById('nb-nb-types-status');

            function _buildTypesYaml(typesObj) {
                const entries = Object.entries(typesObj).filter(([, v]) => v.renderer || v.access);
                if (!entries.length) return '';
                return ['types:', ...entries.flatMap(([t, cfg]) => {
                    const lines = [`  ${t}:`];
                    if (cfg.renderer) lines.push(`    renderer: ${cfg.renderer}`);
                    if (cfg.access)   lines.push(`    access: ${cfg.access}`);
                    return lines;
                })].join('\n') + '\n';
            }

            function _mergeTypesIntoConfig(content, typesObj) {
                const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
                if (!fmMatch) return `---\n${_buildTypesYaml(typesObj)}---\n${content}`;
                const filtered = [];
                let inTypes = false;
                for (const line of fmMatch[1].split('\n')) {
                    if (/^types:/.test(line)) { inTypes = true; continue; }
                    if (inTypes && /^\s/.test(line)) continue;
                    inTypes = false;
                    filtered.push(line);
                }
                const typesYaml = _buildTypesYaml(typesObj);
                const newFm = [...filtered, ...(typesYaml ? typesYaml.trimEnd().split('\n') : [])].join('\n');
                return `---\n${newFm}\n---${content.slice(fmMatch[0].length)}`;
            }

            function _renderTypesTable(typeCfg) {
                const types = NbWeb.getRendererTypesForNotebook(name);
                if (!types.length) {
                    if (_typesWrap) _typesWrap.innerHTML =
                        '<span style="color:var(--text-dim)">No typed renderers registered.</span>';
                    return;
                }
                const LEVELS = ['', 'guest', 'user', 'office', 'admin'];
                const rows = types.map(t => {
                    const renderers  = NbWeb.getRenderers(t);
                    const curRenderer = typeCfg[t]?.renderer || '';
                    const curAccess   = typeCfg[t]?.access   || '';
                    const rendOpts = `<option value="">— default —</option>` +
                        renderers.map(r =>
                            `<option value="${_esc(r.id)}"${r.id === curRenderer ? ' selected' : ''}>${_esc(r.label || r.id)}</option>`
                        ).join('');
                    const accOpts = LEVELS.map(l =>
                        `<option value="${l}"${l === curAccess ? ' selected' : ''}>${l || '— inherit —'}</option>`
                    ).join('');
                    return `<tr data-type="${_esc(t)}">
                        <td style="padding:3px 12px 3px 0;white-space:nowrap;color:var(--text-dim)">${_esc(t)}</td>
                        <td style="padding:3px 6px 3px 0"><select class="nb-scope-select nb-nt-renderer" style="font-size:11px">${rendOpts}</select></td>
                        <td style="padding:3px 0"><select class="nb-scope-select nb-nt-access" style="font-size:11px">${accOpts}</select></td>
                    </tr>`;
                });
                if (_typesWrap) _typesWrap.innerHTML =
                    `<table style="border-collapse:collapse;width:100%;font-size:12px">
                        <thead><tr>
                            <th style="text-align:left;font-size:10px;color:var(--text-dim);font-weight:normal;padding-bottom:4px">Type</th>
                            <th style="text-align:left;font-size:10px;color:var(--text-dim);font-weight:normal;padding-bottom:4px">Renderer</th>
                            <th style="text-align:left;font-size:10px;color:var(--text-dim);font-weight:normal;padding-bottom:4px">Access</th>
                        </tr></thead>
                        <tbody>${rows.join('')}</tbody>
                    </table>`;
            }

            fetch('/api/nb/notebook-config?notebook=' + encodeURIComponent(name))
                .then(r => r.json())
                .then(d => _renderTypesTable(d.meta?.types || {}))
                .catch(() => { if (_typesWrap) _typesWrap.textContent = 'Could not load config.'; });

            if (_typesSave) {
                _typesSave.addEventListener('click', async () => {
                    _typesStatus.textContent = 'Saving…';
                    const typesObj = {};
                    _typesWrap.querySelectorAll('tr[data-type]').forEach(row => {
                        const t = row.dataset.type;
                        const r = row.querySelector('.nb-nt-renderer')?.value || '';
                        const a = row.querySelector('.nb-nt-access')?.value   || '';
                        if (r || a) { typesObj[t] = {}; if (r) typesObj[t].renderer = r; if (a) typesObj[t].access = a; }
                    });
                    try {
                        const cr = await fetch('/api/nb/notebook-config?notebook=' + encodeURIComponent(name));
                        const cd = await cr.json();
                        const newContent = _mergeTypesIntoConfig(cd.content || '---\n---\n', typesObj);
                        const sr = await fetch('/api/nb/notebook-config', {
                            method: 'PUT',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ notebook: name, content: newContent }),
                        });
                        const sd = await sr.json();
                        if (sd.ok) NbWeb.bustNotebookConfigCache(name);
                        _typesStatus.textContent = sd.ok ? 'Saved.' : (sd.error || 'Error saving');
                        setTimeout(() => { _typesStatus.textContent = ''; }, 2000);
                    } catch(e) { _typesStatus.textContent = 'Error'; }
                });
            }

            // Notebook lock toggle
            document.getElementById('nb-nb-lock-btn').addEventListener('click', async () => {
                const btn = document.getElementById('nb-nb-lock-btn');
                const wasLocked = d.locked;
                btn.textContent = '…'; btn.disabled = true;
                try {
                    await fetch('/api/nb/lock', {
                        method: wasLocked ? 'DELETE' : 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ notebook: name }),
                    });
                    await _openNbNotebook(name);
                } catch(_) { btn.textContent = wasLocked ? '🔒 Unlock notebook' : '🔒 Lock notebook'; btn.disabled = false; }
            });

            // Configure notebook — edit .<name>.md config file inline
            const _cfgBtn    = document.getElementById('nb-nb-config-btn');
            const _cfgArea   = document.getElementById('nb-nb-config-area');
            const _cfgText   = document.getElementById('nb-nb-config-text');
            const _cfgSave   = document.getElementById('nb-nb-config-save');
            const _cfgStatus = document.getElementById('nb-nb-config-status');
            if (_cfgBtn) {
                _cfgBtn.addEventListener('click', async () => {
                    const open = _cfgArea.style.display !== 'none';
                    _cfgArea.style.display = open ? 'none' : 'block';
                    _cfgBtn.textContent = open ? '⚙ Configure notebook' : '⚙ Configure notebook ▲';
                    if (!open && !_cfgText.value) {
                        try {
                            const r = await fetch('/api/nb/notebook-config?notebook=' + encodeURIComponent(name));
                            const cd = await r.json();
                            _cfgText.value = cd.content || '';
                        } catch(_) {}
                    }
                });
                _cfgSave.addEventListener('click', async () => {
                    _cfgStatus.textContent = 'Saving…';
                    try {
                        const r = await fetch('/api/nb/notebook-config', {
                            method: 'PUT',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ notebook: name, content: _cfgText.value }),
                        });
                        const sd = await r.json();
                        _cfgStatus.textContent = sd.ok ? 'Saved.' : (sd.error || 'Error saving');
                        setTimeout(() => { _cfgStatus.textContent = ''; }, 2000);
                    } catch(e) { _cfgStatus.textContent = 'Error'; }
                });
            }

            // Use this notebook — calls `nb use <name>` to set nb's current notebook
            document.getElementById('nb-nb-use').addEventListener('click', async () => {
                const btn = document.getElementById('nb-nb-use');
                btn.textContent = 'Setting…'; btn.disabled = true;
                try {
                    const r = await fetch('/api/nb/use', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ notebook: name }),
                    });
                    const d = await r.json();
                    if (d.success) {
                        _lastNbCurrent = name;
                        // Persist the updated is_current flags, not just a throwaway
                        // render copy -- otherwise a later sort-dropdown change would
                        // re-render from the stale array and revert the current-
                        // notebook badge to whichever notebook was current before this
                        // click (caught during tier-2f's review: pre-existing behavior,
                        // fixed here while already touching this code).
                        _lastNbList = _lastNbList.map(n => ({ ...n, is_current: n.name === name }));
                        _renderNbList(_lastNbList);
                        btn.textContent = '✓ Current';
                        setTimeout(() => { btn.textContent = 'Use this notebook'; btn.disabled = false; }, 1500);
                    } else {
                        btn.textContent = 'Failed'; btn.disabled = false;
                        setTimeout(() => { btn.textContent = 'Use this notebook'; }, 1500);
                    }
                } catch(e) {
                    btn.textContent = 'Use this notebook'; btn.disabled = false;
                }
            });

            // Save prefs
            document.getElementById('nb-nb-save-prefs').addEventListener('click', async () => {
                const btn = document.getElementById('nb-nb-save-prefs');
                const status = document.getElementById('nb-nb-prefs-status');
                const sort = document.getElementById('nb-nb-sort').value;
                const listType = document.getElementById('nb-nb-type').value;
                btn.textContent = 'Saving…'; btn.disabled = true;
                try {
                    const pr = await fetch('/api/nb/notebook-prefs', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ notebook: name, prefs: { default_sort: sort, default_list_type: listType } }),
                    });
                    const pd = await pr.json();
                    status.textContent = pd.success ? '✓ Saved' : ('Error: ' + (pd.error || '?'));
                    if (pd.success) NbNav.applyNotebookPrefs(name, { default_sort: sort, default_list_type: listType });
                    setTimeout(() => { status.textContent = ''; }, 2000);
                } finally {
                    btn.textContent = 'Save defaults'; btn.disabled = false;
                }
            });

            // Clear template pref
            const tmplClear = document.getElementById('nb-nb-tmpl-clear');
            if (tmplClear) {
                tmplClear.addEventListener('click', async () => {
                    await fetch('/api/nb/notebook-prefs', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ notebook: name, prefs: { default_template: '' } }),
                    });
                    document.getElementById('nb-nb-tmpl-name').textContent = '(none)';
                    tmplClear.hidden = true;
                });
            }

            // Danger zone
            const dangerSection = document.createElement('details');
            dangerSection.style.cssText = 'margin-top:4px;border-top:1px solid var(--border)';
            dangerSection.innerHTML = `
                <summary style="padding:10px 28px;font-size:11px;font-weight:600;letter-spacing:0.05em;
                                text-transform:uppercase;color:var(--text-danger,#e74c3c);cursor:pointer;
                                user-select:none">Danger Zone</summary>
                <div id="nb-nb-danger-body" style="padding:4px 28px 16px;display:flex;gap:8px;flex-wrap:wrap">
                    <button class="nb-tool-btn nb-btn-danger" id="nb-nb-del-local">Delete local notebook</button>
                    <button class="nb-tool-btn nb-btn-danger" id="nb-nb-del-remote">Delete remote branch</button>
                </div>`;
            content.appendChild(dangerSection);

            const _nbDangerConfirm = (scope, warning) => {
                const body = document.getElementById('nb-nb-danger-body');
                const orig = body.innerHTML;
                body.innerHTML = `
                    <div style="width:100%">
                        <p style="font-size:12px;color:var(--text-danger,#e74c3c);margin:0 0 8px">${warning}</p>
                        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
                            <input id="nb-nb-danger-input" class="nb-opt-input" style="flex:1;min-width:120px"
                                   placeholder='type "${_esc(name)}" to confirm'>
                            <button id="nb-nb-danger-ok" class="nb-tool-btn nb-btn-danger">Confirm</button>
                            <button id="nb-nb-danger-cancel" class="nb-tool-btn">Cancel</button>
                        </div>
                    </div>`;
                document.getElementById('nb-nb-danger-cancel').onclick = () => {
                    body.innerHTML = orig;
                    _wireDanger();
                };
                const input = document.getElementById('nb-nb-danger-input');
                const okBtn = document.getElementById('nb-nb-danger-ok');
                okBtn.onclick = async () => {
                    if (input.value.trim() !== name) {
                        input.style.outline = '2px solid var(--text-danger,#e74c3c)';
                        setTimeout(() => { input.style.outline = ''; }, 800);
                        return;
                    }
                    okBtn.disabled = true; okBtn.textContent = 'Deleting…';
                    try {
                        const r = await fetch('/api/nb/delete-notebook', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ notebook: name, scope }),
                        });
                        const rd = await r.json();
                        if (rd.success && scope === 'local') {
                            // Notebook gone — refresh the list, show welcome
                            await runNbNotebooks();
                        } else if (rd.success) {
                            setTimeout(() => _openNbNotebook(name), 800);
                        } else {
                            body.innerHTML = `<p style="color:var(--text-danger,#e74c3c);font-size:12px">${_esc(rd.output || 'Failed.')}</p>`;
                            setTimeout(() => { body.innerHTML = orig; _wireDanger(); }, 3000);
                        }
                    } catch(e) {
                        body.innerHTML = orig; _wireDanger();
                    }
                };
                input.focus();
            };

            const _wireDanger = () => {
                const dl = document.getElementById('nb-nb-del-local');
                const dr = document.getElementById('nb-nb-del-remote');
                if (dl) dl.onclick = () => _nbDangerConfirm('local',
                    `Permanently removes <strong>${_esc(name)}</strong> from this machine. Remote branch unaffected.`);
                if (dr) dr.onclick = () => _nbDangerConfirm('remote',
                    `Permanently deletes the <strong>${_esc(name)}</strong> branch on the remote. Local files unaffected.`);
            };
            _wireDanger();

        } catch(e) {
            content.innerHTML = `<div style="padding:40px;color:var(--text-danger)">Error: ${_esc(String(e))}</div>`;
        }
    }

    return { runNbNotebooks, renderNbList: _renderNbList };
})();

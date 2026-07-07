// nb-web templates.js — extracted from main.js (tier-2g modularization, 2026-07-07).
// NbTemplates: the Templates view (list of note/annotation/export templates,
// preview panel, edit/duplicate/delete detail flows) and Add-mode's
// template-picker list (loadTemplatesForAdd).
//
// Cross-references rewritten during extraction (all other lines verbatim):
//   _esc(...)/_t(...)      -> local copies (matches sync.js/plugins-page.js/etc precedent)
//   _parseMarkdownStatic() -> NbMain.parseMarkdownStatic() -- an existing kernel
//                             utility's bare-reference exposure (tier-2e), a LOCAL
//                             closure reference in main.js's return object, so NOT
//                             order-sensitive regardless of index.html script order
//   ++_listSeq / seq!==_listSeq
//                          -> NbMain.bumpListSeq()/NbMain.isStaleListSeq(seq) --
//                             _listSeq is genuinely cross-cutting (also incremented/
//                             read by kernel loadNotes/search, and by not-yet-
//                             extracted runCal/runGrep), so it stays a private kernel
//                             counter behind two narrow intent-named operations rather
//                             than a raw get/set pair -- the lesson from tier-2f's
//                             near-miss (don't expose raw state when nothing outside
//                             the kernel needs to read/write the value itself, only
//                             perform the increment-and-compare operation on it)
//
// No other cross-references: a full-repo grep confirmed _previewTemplate,
// _previewVirtualTemplate, _openTemplate, _openExportTemplate, and
// _renderFrontmatterFields have zero callers outside this block -- only
// runTemplates and loadTemplatesForAdd are called from nav.js (via
// NbMain.runTemplates()/NbMain.loadTemplatesForAdd()), so those two are this
// module's only exposed surface. This tier turned out far cleaner than the
// original inventory estimate: Notebooks-settings and Plugins-page used to sit
// physically between this block's two halves (~1400 lines apart); with both
// already extracted, the whole cluster was already contiguous before this move.

const NbTemplates = (() => {
    const _t = key => NbWeb.t(key);
    function _esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── Templates view ─────────────────────────────────────────────

    // Preview-only: shows template content without a create form (used by Add mode)
    async function _previewTemplate(path, name, scope) {
        const content = document.getElementById('nb-preview-content');
        document.getElementById('nb-preview-toolbar').hidden = true;
        content.innerHTML = '<div style="padding:40px;color:var(--text-muted)">Loading…</div>';
        try {
            const r = await fetch('/api/template?path=' + encodeURIComponent(path));
            const d = await r.json();
            const raw = d.content || '';
            const scopeLabel = scope === 'local' ? '📒 notebook' : '🌐 global';
            const fmHtml  = _renderFrontmatterFields(raw);
            const bodyRaw = raw.replace(/^---[\s\S]*?---\r?\n?/, '');
            const bodyHtml = bodyRaw.trim()
                ? `<div class="nb-rendered" style="margin-top:12px">${NbMain.parseMarkdownStatic(bodyRaw)}</div>` : '';
            content.innerHTML = `
                <div style="padding:10px 32px 8px;font-size:11px;color:var(--text-dim);
                            font-family:var(--font-mono);border-bottom:1px solid var(--border);
                            display:flex;align-items:center;gap:12px">
                    <span>📋 <strong>${_esc(name)}</strong></span>
                    <span style="opacity:0.6">${scopeLabel}</span>
                </div>
                <div style="padding:16px 32px 24px;opacity:0.85">${fmHtml}${bodyHtml}</div>`;
        } catch(e) {
            content.innerHTML = '<div style="padding:40px;color:var(--text-muted)">Could not load template.</div>';
        }
    }

    function _previewVirtualTemplate(raw, name, moduleLabel) {
        const el = document.getElementById('nb-preview-content');
        document.getElementById('nb-preview-toolbar').hidden = true;
        const fmHtml  = _renderFrontmatterFields(raw);
        const bodyRaw = raw.replace(/^---[\s\S]*?---\r?\n?/, '');
        const bodyHtml = bodyRaw.trim()
            ? `<div class="nb-rendered" style="margin-top:12px">${NbMain.parseMarkdownStatic(bodyRaw)}</div>` : '';
        el.innerHTML = `
            <div style="padding:10px 32px 8px;font-size:11px;color:var(--text-dim);
                        font-family:var(--font-mono);border-bottom:1px solid var(--border);
                        display:flex;align-items:center;gap:12px">
                <span>🔌 <strong>${_esc(name)}</strong></span>
                <span style="opacity:0.6">${_esc(moduleLabel || 'plugin template')}</span>
            </div>
            <div style="padding:16px 32px 24px;opacity:0.85">${fmHtml}${bodyHtml}</div>`;
    }

    // Populate list pane with available templates when in Add mode
    async function loadTemplatesForAdd() {
        const nb = NbNav.notebook === '_all' ? 'home' : NbNav.notebook;
        const list    = document.getElementById('nb-list');
        const empty   = document.getElementById('nb-list-empty');
        const countEl = document.getElementById('nb-count');

        list.innerHTML = '';
        empty.hidden = true;
        document.getElementById('nb-type-breakdown').textContent = '';
        document.getElementById('nb-preview-toolbar').hidden = true;
        document.getElementById('nb-preview-content').innerHTML =
            '<div id="nb-welcome"><h2>Add note</h2><p>Choose a template below, or select (blank).</p></div>';

        try {
            const r = await fetch(`/api/templates?notebook=${encodeURIComponent(nb)}`);
            const d = await r.json();
            const templates = d.templates || [];
            const curTemplate = NbNav.addTemplate;

            countEl.textContent = templates.length
                ? `${templates.length} template${templates.length !== 1 ? 's' : ''}`
                : 'no templates';

            function makeTmplItem(iconText, titleText, excerptText, isActive, onSelect) {
                const li = document.createElement('li');
                li.className = 'nb-list-item' + (isActive ? ' active' : '');
                li.setAttribute('role', 'option');
                const icon = document.createElement('span');
                icon.className = 'nb-list-icon';
                icon.textContent = iconText;
                const title = document.createElement('span');
                title.className = 'nb-list-title';
                title.textContent = titleText;
                li.append(icon, title);
                if (excerptText) {
                    const ex = document.createElement('span');
                    ex.className = 'nb-list-excerpt';
                    ex.textContent = excerptText;
                    li.appendChild(ex);
                }
                li.addEventListener('click', () => {
                    list.querySelectorAll('.nb-list-item').forEach(el => el.classList.remove('active'));
                    li.classList.add('active');
                    onSelect();
                });
                return li;
            }

            // Blank note — always first
            list.appendChild(makeTmplItem('📝', '(blank note)', '', !curTemplate, () => {
                NbNav.setAddTemplate(null);
                document.getElementById('nb-preview-toolbar').hidden = true;
                document.getElementById('nb-preview-content').innerHTML =
                    '<div id="nb-welcome"><h2>Add note</h2><p>Choose a template below, or select (blank).</p></div>';
            }));

            templates.forEach(t => {
                const scopeLabel = t.notebook || 'global';
                const item = makeTmplItem(
                    t.notebook ? '📒' : '🌐',
                    t.name,
                    scopeLabel,
                    t.path === curTemplate,
                    () => {
                        NbNav.setAddTemplate(t.path, t.name, t.subfolder || '');
                        _previewTemplate(t.path, t.name, t.scope);
                    }
                );
                item.dataset.templatePath = t.path;
                list.appendChild(item);
            });

            // Re-show preview if a template was already selected (e.g. after scope change)
            if (curTemplate) {
                const found = templates.find(t => t.path === curTemplate);
                if (found) _previewTemplate(found.path, found.name, found.scope);
            }

            // Plugin templates — only from modules active for this notebook
            const nbObj = NbWeb.notebooks().find(n => n.name === nb) || { name: nb };
            const pluginTemplates = NbWeb.getTemplatesForNotebook(nb).filter(t => t.activeForNotebook);
            if (pluginTemplates.length) {
                // Group by module
                const byModule = new Map();
                pluginTemplates.forEach(t => {
                    if (!byModule.has(t.moduleName)) byModule.set(t.moduleName, []);
                    byModule.get(t.moduleName).push(t);
                });

                for (const [, tmplGroup] of byModule) {
                    const moduleLabel = tmplGroup[0].moduleLabel;

                    const hdr = document.createElement('li');
                    hdr.className = 'nb-list-section-header';
                    hdr.textContent = moduleLabel;
                    list.appendChild(hdr);

                    for (const t of tmplGroup) {
                        const content = typeof t.content === 'function' ? t.content(nbObj) : t.content;

                        if (t.singleton) {
                            // Render placeholder, fill async
                            const li = makeTmplItem('🔌', t.name, '…', false, () => {});
                            li.style.opacity = '0.5';
                            li.style.pointerEvents = 'none';
                            list.appendChild(li);
                            const excEl = li.querySelector('.nb-list-excerpt');

                            NbWeb.templateSeeded(nb, t).then(exists => {
                                if (exists) {
                                    li.style.opacity = '0.45';
                                    if (excEl) excEl.textContent = '✓ exists — edit in Notebooks';
                                } else {
                                    li.style.opacity = '';
                                    li.style.pointerEvents = '';
                                    if (excEl) excEl.textContent = t.description || 'create once';
                                    li.addEventListener('click', async () => {
                                        list.querySelectorAll('.nb-list-item').forEach(el => el.classList.remove('active'));
                                        li.classList.add('active');
                                        NbNav.setVirtualTemplate(content, t.name);
                                        _previewVirtualTemplate(content, t.name, moduleLabel);
                                    });
                                }
                            });
                        } else {
                            const item = makeTmplItem('🔌', t.name, t.description || '', false, () => {
                                NbNav.setVirtualTemplate(content, t.name);
                                _previewVirtualTemplate(content, t.name, moduleLabel);
                            });
                            list.appendChild(item);
                        }
                    }
                }

                const pluginCount = pluginTemplates.length;
                countEl.textContent = `${templates.length + pluginCount} template${templates.length + pluginCount !== 1 ? 's' : ''}`;
            }
        } catch(e) {
            countEl.textContent = 'error';
            console.error('loadTemplatesForAdd:', e);
        }
    }

    async function runTemplates() {
        const nb  = NbNav.notebook === '_all' ? 'home' : NbNav.notebook;
        const seq = NbMain.bumpListSeq();
        const list   = document.getElementById('nb-list');
        const empty  = document.getElementById('nb-list-empty');
        const countEl = document.getElementById('nb-count');

        list.innerHTML = '';
        countEl.textContent = '…';
        document.getElementById('nb-type-breakdown').textContent = '';
        document.getElementById('nb-preview-toolbar').hidden = true;
        document.getElementById('nb-preview-content').innerHTML =
            '<div id="nb-welcome"><h2>Templates</h2><p>Click a template to preview it.</p></div>';

        try {
            const r = await fetch(`/api/templates?notebook=${encodeURIComponent(nb)}`);
            if (NbMain.isStaleListSeq(seq)) return;
            const d = await r.json();
            if (NbMain.isStaleListSeq(seq)) return;
            const templates = d.templates || [];

            countEl.textContent = `${templates.length} template${templates.length !== 1 ? 's' : ''}`;

            if (!templates.length) {
                empty.hidden = false;
                empty.textContent = _t('msg_no_templates');
                return;
            }
            empty.hidden = true;

            templates.forEach(t => {
                const li = document.createElement('li');
                li.className = 'nb-list-item';
                li.setAttribute('role', 'option');

                const icon = document.createElement('span');
                icon.className = 'nb-list-icon';
                if (t.template_type === 'export_html') {
                    icon.textContent = '🖨';
                    icon.title = t.notebook ? 'Notebook export template' : 'Global export template';
                } else if (t.template_type === 'annotation') {
                    icon.textContent = '📌';
                    icon.title = t.notebook ? 'Annotation template' : 'Global annotation template';
                } else {
                    icon.textContent = t.notebook ? '📒' : '🌐';
                    icon.title = t.notebook ? 'Notebook template' : 'Global template';
                }

                const title = document.createElement('span');
                title.className = 'nb-list-title';
                if (t.template_type === 'export_html') {
                    title.textContent = 'HTML export template';
                } else if (t.template_type === 'annotation') {
                    title.textContent = 'Annotation template';
                } else {
                    title.textContent = t.name;
                }

                const excerpt = document.createElement('span');
                excerpt.className = 'nb-list-excerpt';
                if (t.template_type === 'export_html') {
                    excerpt.textContent = t.notebook ? `${t.notebook}: export` : 'global export';
                } else if (t.template_type === 'annotation') {
                    const parts = [t.notebook || 'global'];
                    if (t.subfolder) parts.push(t.subfolder);
                    excerpt.textContent = parts.join('/') + ': annotation';
                } else {
                    excerpt.textContent = t.notebook || 'global';
                }

                li.append(icon, title, excerpt);
                li.addEventListener('click', () => {
                    list.querySelectorAll('.nb-list-item').forEach(el => el.classList.remove('active'));
                    li.classList.add('active');
                    if (t.template_type === 'export_html') {
                        _openExportTemplate(t.path, t.name, t.scope);
                    } else {
                        _openTemplate(t.path, t.name, t.scope, t.subfolder || '', t.template_type || 'regular', t.notebook || '');
                    }
                });
                list.appendChild(li);
            });

            // Plugin templates (read-only preview — only from modules active for this notebook)
            const pluginTemplates = NbWeb.getTemplatesForNotebook(nb).filter(t => t.activeForNotebook);
            if (pluginTemplates.length) {
                const byModule = new Map();
                pluginTemplates.forEach(t => {
                    if (!byModule.has(t.moduleName)) byModule.set(t.moduleName, []);
                    byModule.get(t.moduleName).push(t);
                });
                for (const [, tmplGroup] of byModule) {
                    const moduleLabel = tmplGroup[0].moduleLabel;
                    const hdr = document.createElement('li');
                    hdr.className = 'nb-list-section-header';
                    hdr.textContent = moduleLabel;
                    list.appendChild(hdr);

                    for (const t of tmplGroup) {
                        const content = typeof t.content === 'function' ? t.content({ name: nb }) : t.content;
                        const li = document.createElement('li');
                        li.className = 'nb-list-item';
                        li.setAttribute('role', 'option');
                        li.innerHTML = `<span class="nb-list-icon">🔌</span>
                            <span class="nb-list-title">${_esc(t.name)}</span>
                            <span class="nb-list-excerpt">${_esc(t.description || 'plugin template')}</span>`;
                        li.addEventListener('click', () => {
                            list.querySelectorAll('.nb-list-item').forEach(el => el.classList.remove('active'));
                            li.classList.add('active');
                            _previewVirtualTemplate(content, t.name, moduleLabel);
                        });
                        list.appendChild(li);
                    }
                }
                countEl.textContent = `${templates.length + pluginTemplates.length} template${templates.length + pluginTemplates.length !== 1 ? 's' : ''}`;
            }

            // "New export template" button if none exist yet
            const hasExportTmpl = templates.some(t => t.template_type === 'export_html');
            if (!hasExportTmpl) {
                const newBtn = document.createElement('button');
                newBtn.className = 'nb-tool-btn';
                newBtn.style.cssText = 'margin:12px 12px 4px;font-size:12px';
                newBtn.textContent = '+ New HTML export template';
                newBtn.addEventListener('click', async () => {
                    newBtn.disabled = true; newBtn.textContent = 'Creating…';
                    const r = await fetch('/api/export-template', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ scope: 'global' }),
                    });
                    const d = await r.json();
                    if (d.success || d.error === 'already exists') runTemplates();
                    else { alert('Failed: ' + (d.error || 'unknown')); newBtn.disabled = false; newBtn.textContent = '+ New HTML export template'; }
                });
                list.appendChild(newBtn);
            }
        } catch(e) {
            countEl.textContent = 'error';
            console.error('runTemplates:', e);
        }
    }

    // ── Template detail helpers ──────────────────────────────────────

    function _renderFrontmatterFields(raw) {
        const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        if (!match) return ''
        const rows = match[1].split(/\r?\n/).flatMap(line => {
            const colonIdx = line.indexOf(':')
            if (colonIdx < 1) return []
            const key = line.slice(0, colonIdx).trim()
            const val = line.slice(colonIdx + 1).trim()
            return [`<div class="nb-contact-row">` +
                `<span class="nb-contact-label">${_esc(key)}</span>` +
                `<span class="nb-contact-value">${val ? _esc(val) : '<em style="opacity:0.35">—</em>'}</span>` +
                `</div>`]
        })
        return rows.length ? `<div class="nb-contact-fields">${rows.join('')}</div>` : ''
    }

    async function _openTemplate(path, name, scope, subfolder = '', templateType = 'regular', notebook = '') {
        const content = document.getElementById('nb-preview-content');
        content.innerHTML = '<div style="padding:40px;color:var(--text-muted)">Loading…</div>';
        document.getElementById('nb-preview-toolbar').hidden = true;

        try {
            const r = await fetch('/api/template?path=' + encodeURIComponent(path));
            const d = await r.json();
            const raw = d.content || '';
            const isAnnotation = templateType === 'annotation';
            const scopeLabel = isAnnotation
                ? (subfolder ? `${notebook}/${subfolder}` : notebook) + ': annotation'
                : scope === 'local' ? `📒 ${notebook || 'notebook'}` : '🌐 global';
            const headerIcon = isAnnotation ? '📌' : '📋';
            const headerName = isAnnotation ? 'Annotation template' : name;
            const HDR = `<div style="padding:10px 32px 8px;font-size:11px;color:var(--text-dim);
                font-family:var(--font-mono);border-bottom:1px solid var(--border);
                display:flex;align-items:center;gap:12px">
                <span>${headerIcon} <strong>${_esc(headerName)}</strong></span>
                <span style="opacity:0.6">${_esc(scopeLabel)}</span></div>`;
            let latestRaw = raw;

            const showPreview = () => {
                const fmHtml  = isAnnotation ? '' : _renderFrontmatterFields(latestRaw);
                const bodyRaw = latestRaw.replace(/^---[\s\S]*?---\r?\n?/, '');
                const bodyHtml = bodyRaw.trim()
                    ? `<div class="nb-rendered" style="margin-top:12px;opacity:0.85">${NbMain.parseMarkdownStatic(bodyRaw)}</div>` : '';
                content.innerHTML = `${HDR}<div style="padding:16px 32px 8px;opacity:0.85">${fmHtml}${bodyHtml}</div>`;
                const ssb = document.getElementById('nb-sheet-save-btn');
                if (ssb) { ssb.hidden = true; ssb.onclick = null; }

                const footer = document.createElement('div');
                footer.id = 'nb-tmpl-footer';
                footer.style.cssText = 'padding:10px 32px 14px;border-top:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap';
                footer.innerHTML = `
                    <button id="nb-tmpl-edit"      class="nb-tool-btn">Edit</button>
                    <button id="nb-tmpl-duplicate" class="nb-tool-btn">Duplicate</button>
                    <button id="nb-tmpl-delete"    class="nb-tool-btn nb-btn-danger">Delete</button>`;
                content.appendChild(footer);

                footer.querySelector('#nb-tmpl-edit').addEventListener('click', showEditor);

                footer.querySelector('#nb-tmpl-duplicate').addEventListener('click', async () => {
                    const dupBtn = footer.querySelector('#nb-tmpl-duplicate');
                    if (footer.querySelector('#nb-tmpl-dup-row')) return; // already open
                    dupBtn.disabled = true;
                    const dupRow = document.createElement('div');
                    dupRow.id = 'nb-tmpl-dup-row';
                    dupRow.style.cssText = 'width:100%;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:8px;border-top:1px solid var(--border);margin-top:4px';
                    const lbl = document.createElement('span');
                    lbl.style.cssText = 'font-size:11px;color:var(--text-dim);white-space:nowrap';
                    lbl.textContent = 'Duplicate to:';
                    const loadEl = document.createElement('span');
                    loadEl.style.cssText = 'font-size:11px;color:var(--text-dim)';
                    loadEl.textContent = '…';
                    dupRow.append(lbl, loadEl);
                    footer.appendChild(dupRow);
                    try {
                        const defaultNb = notebook || (NbNav.notebook === '_all' ? 'home' : NbNav.notebook);
                        const nbSel  = await NbDialog.buildNbPicker(defaultNb);
                        let fldSel   = await NbDialog.buildFolderPicker(defaultNb);
                        nbSel.addEventListener('change', async () => {
                            const next = await NbDialog.buildFolderPicker(nbSel.value);
                            fldSel.replaceWith(next); fldSel = next;
                        });
                        const copyBtn = document.createElement('button');
                        copyBtn.className = 'nb-tool-btn nb-btn-primary';
                        copyBtn.textContent = 'Copy';
                        const cancelBtn = document.createElement('button');
                        cancelBtn.className = 'nb-tool-btn';
                        cancelBtn.textContent = '×';
                        loadEl.remove();
                        dupRow.append(nbSel, fldSel, copyBtn, cancelBtn);
                        cancelBtn.addEventListener('click', () => { dupRow.remove(); dupBtn.disabled = false; });
                        copyBtn.addEventListener('click', async () => {
                            const targetNb  = nbSel.value;
                            const targetFld = fldSel.value;
                            copyBtn.textContent = 'Copying…'; copyBtn.disabled = true;
                            try {
                                const body = isAnnotation
                                    ? { scope: 'annotation', notebook: targetNb, folder: targetFld, content: latestRaw }
                                    : { scope: 'local', name, notebook: targetNb, subfolder: targetFld, content: latestRaw };
                                const sr = await fetch('/api/templates', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify(body),
                                });
                                const sd = await sr.json();
                                if (sd.success) {
                                    copyBtn.textContent = '✓ Copied';
                                    setTimeout(runTemplates, 900);
                                } else {
                                    alert('Duplicate failed: ' + (sd.error || 'unknown'));
                                    copyBtn.textContent = 'Copy'; copyBtn.disabled = false;
                                }
                            } catch(e) {
                                alert('Error: ' + e);
                                copyBtn.textContent = 'Copy'; copyBtn.disabled = false;
                            }
                        });
                    } catch(e) {
                        loadEl.textContent = '✗ ' + e.message;
                        loadEl.style.color = 'var(--red)';
                        dupBtn.disabled = false;
                    }
                });

                footer.querySelector('#nb-tmpl-delete').addEventListener('click', async () => {
                    const label = isAnnotation ? 'Annotation template' : `template "${name}"`;
                    if (!confirm(`Delete ${label}?`)) return;
                    const dr = await fetch('/api/template?path=' + encodeURIComponent(path), { method: 'DELETE' });
                    const dd = await dr.json();
                    if (dd.success) runTemplates();
                    else alert('Delete failed: ' + (dd.error || 'unknown'));
                });
            };

            const showEditor = () => {
                content.innerHTML = `${HDR}
                    <textarea id="nb-tmpl-editor" spellcheck="false"
                        style="flex:1;width:100%;box-sizing:border-box;padding:16px 32px;
                               border:none;outline:none;resize:none;font-family:var(--font-mono);
                               font-size:13px;background:var(--bg);color:var(--text);
                               min-height:260px">${_esc(latestRaw)}</textarea>
                    <div style="padding:10px 32px 14px;border-top:1px solid var(--border);display:flex;gap:8px">
                        <button id="nb-tmpl-save"   class="nb-tool-btn nb-btn-primary">Save</button>
                        <button id="nb-tmpl-cancel" class="nb-tool-btn">Cancel</button>
                    </div>`;

                const ta = document.getElementById('nb-tmpl-editor');
                ta.focus();
                ta.addEventListener('keydown', e => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        document.getElementById('nb-tmpl-save')?.click();
                    }
                    if (e.key === 'Escape') showPreview();
                });

                document.getElementById('nb-tmpl-save').addEventListener('click', async () => {
                    const newContent = ta.value;
                    const btn = document.getElementById('nb-tmpl-save');
                    btn.textContent = 'Saving…'; btn.disabled = true;
                    try {
                        const sr = await fetch('/api/template', {
                            method: 'PUT',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ path, content: newContent }),
                        });
                        const sd = await sr.json();
                        if (sd.success) { latestRaw = newContent; showPreview(); }
                        else alert('Save failed: ' + (sd.error || 'unknown'));
                    } finally { btn.textContent = 'Save'; btn.disabled = false; }
                });

                document.getElementById('nb-tmpl-cancel').addEventListener('click', showPreview);
            };

            showPreview();
        } catch(e) {
            content.innerHTML = '<div style="padding:40px;color:var(--text-muted)">Could not load template.</div>';
        }
    }

    // ── HTML export template view ───────────────────────────────────
    async function _openExportTemplate(path, name, scope) {
        const content = document.getElementById('nb-preview-content');
        content.innerHTML = '<div style="padding:40px;color:var(--text-muted)">Loading…</div>';
        document.getElementById('nb-preview-toolbar').hidden = true;
        try {
            const r = await fetch('/api/template?path=' + encodeURIComponent(path));
            const d = await r.json();
            let latestRaw = d.content || '';
            const scopeLabel = scope === 'local' ? '📒 notebook' : '🌐 global';
            const HDR = `<div style="padding:10px 32px 8px;font-size:11px;color:var(--text-dim);
                font-family:var(--font-mono);border-bottom:1px solid var(--border);
                display:flex;align-items:center;gap:12px">
                <span>🖨 <strong>${_esc(name)}</strong></span>
                <span style="opacity:0.6">${scopeLabel}</span>
                <span style="opacity:0.5;font-size:10px">{{content}} → rendered note body &nbsp;|&nbsp; {{title}} → note title</span>
            </div>`;
            const FOOTER_HTML = `<div style="padding:10px 32px 14px;border-top:1px solid var(--border);display:flex;gap:8px">
                <button id="nb-etmpl-edit"   class="nb-tool-btn">Edit</button>
                <button id="nb-etmpl-delete" class="nb-tool-btn nb-btn-danger">Delete</button>
            </div>`;

            const showPreview = () => {
                content.innerHTML = HDR +
                    `<pre style="padding:20px 32px;overflow-x:auto;font-size:12px;line-height:1.5;
                        margin:0;background:var(--bg);color:var(--text)">${_esc(latestRaw)}</pre>` +
                    FOOTER_HTML;
                wireFooter();
            };

            const showEditor = () => {
                content.innerHTML = HDR +
                    `<textarea id="nb-etmpl-ta" spellcheck="false"
                        style="flex:1;width:100%;box-sizing:border-box;padding:16px 32px;border:none;
                               outline:none;resize:none;font-family:var(--font-mono);font-size:12px;
                               background:var(--bg);color:var(--text);min-height:320px">${_esc(latestRaw)}</textarea>
                    <div style="padding:10px 32px 14px;border-top:1px solid var(--border);display:flex;gap:8px">
                        <button id="nb-etmpl-save"   class="nb-tool-btn nb-btn-primary">Save</button>
                        <button id="nb-etmpl-cancel" class="nb-tool-btn">Cancel</button>
                    </div>`;
                const ta = document.getElementById('nb-etmpl-ta');
                ta.focus();
                ta.addEventListener('keydown', e => {
                    if (e.key === 'Escape') showPreview();
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault(); document.getElementById('nb-etmpl-save')?.click();
                    }
                });
                document.getElementById('nb-etmpl-save').addEventListener('click', async () => {
                    const btn = document.getElementById('nb-etmpl-save');
                    const newContent = ta.value;
                    btn.textContent = 'Saving…'; btn.disabled = true;
                    try {
                        const sr = await fetch('/api/template', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ path, content: newContent }),
                        });
                        const sd = await sr.json();
                        if (sd.success) { latestRaw = newContent; showPreview(); }
                        else alert('Save failed: ' + (sd.error || 'unknown'));
                    } finally { btn.textContent = 'Save'; btn.disabled = false; }
                });
                document.getElementById('nb-etmpl-cancel').addEventListener('click', showPreview);
            };

            function wireFooter() {
                document.getElementById('nb-etmpl-edit').addEventListener('click', showEditor);
                document.getElementById('nb-etmpl-delete').addEventListener('click', async () => {
                    if (!confirm(`Delete export template "${name}"?`)) return;
                    const dr = await fetch('/api/template?path=' + encodeURIComponent(path), { method: 'DELETE' });
                    const dd = await dr.json();
                    if (dd.success) runTemplates();
                    else alert('Delete failed: ' + (dd.error || 'unknown'));
                });
            }

            showPreview();
        } catch(e) {
            content.innerHTML = '<div style="padding:40px;color:var(--text-muted)">Could not load template.</div>';
        }
    }


    return { runTemplates, loadTemplatesForAdd };
})();

// NbWeb-specialty — typed note headers for service/project/business FM types.
// Global plugin — no detect(), active for all notebooks.
// Plugins extend this via window.NbSpecialty.register() and .getActions().
// @name     NbWeb Specialty
// @version  0.1.0
// @type     core

(() => {

    const _esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    // Core type registry — plugins may add entries via NbSpecialty.register()
    const _cfg = {
        tools:     { icon: '🔧', label: 'Tool Inventory' },
        materials: { icon: '📦', label: 'Materials Catalog' },
        transport: { icon: '🚗', label: 'Transport' },
        quote:     { icon: '📋', label: 'Quote' },
        budget:    { icon: '💰', label: 'Budget' },
        project:   { icon: '🏗️', label: 'Project' },
        reports:   { icon: '📊', label: 'Reports' },
        invoice:   { icon: '🧾', label: 'Invoice' },
        dashboard: { icon: '🗂️', label: 'Dashboard' },
        dotfile:   { icon: '⚙️', label: 'Config'    },
    };

    // Inject the nearest preceding date heading into timedot blocks that have no date line.
    function _injectDateContext(body) {
        const lines = body.split('\n');
        let currentDate = null;
        const result = [];
        let inBlock = false, blockHeader = '', blockLines = [];
        for (const line of lines) {
            if (!inBlock) {
                const m = line.match(/^#{1,6}\s+(\d{4}-\d{2}-\d{2})/);
                if (m) currentDate = m[1];
                if (/^```timedot/.test(line)) { inBlock = true; blockHeader = line; blockLines = []; }
                else result.push(line);
            } else {
                if (line.startsWith('```')) {
                    const hasDate = blockLines.some(l => /^\d{4}[-/]\d{2}[-/]\d{2}/.test(l.trim()));
                    result.push(blockHeader);
                    if (!hasDate && currentDate) result.push(currentDate);
                    result.push(...blockLines, line);
                    inBlock = false;
                } else {
                    blockLines.push(line);
                }
            }
        }
        return result.join('\n');
    }

    async function _appendTodayAndEdit(note) {
        const today = new Date().toISOString().slice(0, 10);
        const heading = `## ${today}`;
        if (!(note.body || '').includes(heading)) {
            const newBody = (note.body || '').trimEnd() + `\n\n${heading}\n\n`;
            await fetch('/api/note', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ selector: note.selector, content: newBody }),
            });
        }
        NbMain.openEditor(note.selector);
    }

    function _renderSpecialtyNote(note) {
        const { icon, label } = _cfg[note.type] || { icon: '📋', label: note.type };
        let pills = [], pillsHtml = '';
        if (note.type === 'invoice') {
            const statusCls = note.meta?.status === 'paid' ? ' nb-pill-paid' : ' nb-pill-due';
            if (note.meta?.invoice_num) pills.push(`<span class="nb-specialty-pill">${_esc(note.meta.invoice_num)}</span>`);
            if (note.meta?.due)         pills.push(`<span class="nb-specialty-pill">due: ${_esc(note.meta.due)}</span>`);
            if (note.meta?.status)      pills.push(`<span class="nb-specialty-pill${statusCls}">${_esc(note.meta.status)}</span>`);
            pillsHtml = pills.join('');
        } else {
            if (note.meta?.status)       pills.push(note.meta.status);
            if (note.meta?.billing_type) pills.push(note.meta.billing_type);
            if (note.meta?.client)       pills.push(String(note.meta.client).replace(/^contacts:/, '').replace(/\.md$/, ''));
            pillsHtml = pills.map(p => `<span class="nb-specialty-pill">${_esc(p)}</span>`).join('');
        }
        const todayBtn     = note.type === 'project'
            ? `<button class="nb-specialty-today" title="Append today's entry and edit">+ Today</button>`
            : '';
        const extraActions = window.NbSpecialty?.getActions?.(note) ?? '';
        let body = note.type === 'project' ? _injectDateContext(note.body || '') : (note.body || '');
        body = body.replace(/^> (INVOICED:.+)$/gm, '<div class="nb-invoiced-marker">$1</div>');
        return `<div class="nb-specialty-header" data-selector="${_esc(note.selector || '')}">
            <span class="nb-specialty-icon">${icon}</span>
            <span class="nb-specialty-label">${_esc(label)}</span>
            ${pillsHtml}${todayBtn}${extraActions}
        </div>` + NbMain.renderMarkdown(body, note.selector);
    }

    function _renderDotfileNote(note) {
        const filename = note.filename || '';
        const path     = note.path    || '';

        // Scope: count path components after .nb/
        // global=1 (.nb/.nb.md), notebook=2 (.nb/djp/.djp.md), folder=3+ (.nb/djp/sub/.sub.md)
        const parts = path.replace(/^.*\/\.nb\//, '').split('/').filter(Boolean);
        const depth  = parts.length;
        const scope  = depth <= 1 ? 'global' : depth === 2 ? 'notebook' : 'folder';
        const parent = depth >= 2 ? parts[depth - 2] : '';

        const label   = note.meta?.title
            || filename.replace(/^\./, '').replace(/\.md$/i, '') + (scope === 'global' ? ' (global)' : '');
        const keyCount = note.meta
            ? Object.keys(note.meta).filter(k => k !== 'type' && k !== 'title').length
            : 0;

        // Dashboard pair: remove leading dot from selector filename to get the front-of-house note
        const dashSel = note.selector ? note.selector.replace(/(:|\/)\.([\w.-]+\.md)$/, '$1$2') : '';
        const dashLink = dashSel
            ? `<a class="nb-specialty-link" href="#" data-open="${_esc(dashSel)}">dashboard</a>`
            : '';

        const scopePill  = `<span class="nb-specialty-pill">${scope}</span>`;
        const parentPill = parent ? `<span class="nb-specialty-pill">${_esc(parent)}</span>` : '';
        const keysPill   = keyCount ? `<span class="nb-specialty-pill">${keyCount} keys</span>` : '';

        return `<div class="nb-specialty-header" data-selector="${_esc(note.selector || '')}">
            <span class="nb-specialty-icon">⚙️</span>
            <span class="nb-specialty-label">${_esc(label)}</span>
            ${dashLink}
            ${scopePill}${parentPill}${keysPill}
        </div>` + NbMain.renderMarkdown(note.body || '', note.selector);
    }

    async function _renderDashboardNote(note) {
        const nb     = note.notebook || '';
        const domain = note.meta?.domain || nb;
        const access = note.effective_access || note.meta?.access || '';

        const [listData, syncData] = await Promise.all([
            fetch(`/api/notes?notebook=${encodeURIComponent(nb)}`).then(r => r.json()).catch(() => ({})),
            nb ? fetch(`/api/nb/sync/status?notebook=${encodeURIComponent(nb)}`).then(r => r.json()).catch(() => ({}))
               : Promise.resolve({}),
        ]);

        const items       = listData.notes || [];
        const fileCount   = items.filter(n => n.type !== 'folder').length;
        const folderCount = items.filter(n => n.type === 'folder').length;

        const changes  = syncData.changes  ?? 0;
        const unpushed = syncData.unpushed ?? 0;
        const dirty    = changes - unpushed;
        let syncLabel, syncCls;
        if (!syncData.has_remote) {
            syncLabel = 'local';  syncCls = '';
        } else if (changes === 0) {
            syncLabel = 'synced'; syncCls = ' nb-pill-synced';
        } else {
            const parts = [];
            if (unpushed) parts.push(`↑${unpushed}`);
            if (dirty)    parts.push(`${dirty} unsaved`);
            syncLabel = parts.join(' '); syncCls = ' nb-pill-dirty';
        }

        // Config file: prepend "." to the selector filename (e.g. djp:djp.md → djp:.djp.md)
        const configSel = note.selector
            ? note.selector.replace(/(:|\/)([\w.-]+\.md)$/, '$1.$2')
            : '';
        const configLink = configSel
            ? `<a class="nb-specialty-link" href="#" data-open="${_esc(configSel)}">config</a>`
            : '';

        // Sync + access right-justified
        // TODO: sync click is basic; needs progress feedback, error handling, conflict UI
        const syncPill = `<span class="nb-specialty-pill nb-sync-pill${syncCls}" data-notebook="${_esc(nb)}" title="Click to sync">${_esc(syncLabel)}</span>`;
        const accessBadge = access
            ? `<span class="nb-specialty-pill nb-pill-access nb-pill-access-${_esc(access)}">${_esc(access)}</span>`
            : '';

        return `<div class="nb-specialty-header" data-selector="${_esc(note.selector || '')}">
            <span class="nb-specialty-icon">🗂️</span>
            <span class="nb-specialty-label">${_esc(domain)}</span>
            ${configLink}
            <span class="nb-specialty-pill">${fileCount} files</span>
            <span class="nb-specialty-pill">${folderCount} folders</span>
            <span class="nb-specialty-right">
                <button class="nb-specialty-theme-btn" data-notebook="${_esc(nb)}" title="Choose theme">🎨</button>
                ${syncPill}${accessBadge}
            </span>
        </div>` + NbMain.renderMarkdown(note.body || '', note.selector);
    }

    NbWeb.registerModule('specialty', {
        label:        'NbWeb Specialty',
        description:  'Typed note headers for project, invoice, quote, budget and related FM types.',
        previewRenderer: note => {
            if (note.type === 'dashboard') return _renderDashboardNote(note);
            if (note.type === 'dotfile')   return _renderDotfileNote(note);
            return _cfg[note.type] ? _renderSpecialtyNote(note) : null;
        },
        previewTypes: Object.keys(_cfg),
    });

    document.addEventListener('click', e => {
        if (!e.target.closest('.nb-specialty-today')) return;
        e.preventDefault();
        const note = NbMain.activeNote();
        if (note) _appendTodayAndEdit(note);
    });

    document.addEventListener('click', e => {
        const link = e.target.closest('.nb-specialty-link[data-open]');
        if (!link) return;
        e.preventDefault();
        NbMain.openNote(link.dataset.open);
    });

    document.addEventListener('click', async e => {
        const pill = e.target.closest('.nb-sync-pill[data-notebook]');
        if (!pill) return;
        e.preventDefault();
        const nb = pill.dataset.notebook;
        if (!nb) return;
        const prev = pill.textContent;
        pill.textContent = '⟳ syncing…';
        pill.classList.remove('nb-pill-synced', 'nb-pill-dirty');
        try {
            const r = await fetch('/api/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notebook: nb }),
            });
            const d = await r.json();
            pill.textContent = d.success ? 'synced' : (d.error || 'error');
            pill.classList.toggle('nb-pill-synced', !!d.success);
            pill.classList.toggle('nb-pill-dirty',  !d.success);
        } catch(_) {
            pill.textContent = 'error';
            pill.classList.add('nb-pill-dirty');
        }
    });

    // Theme picker popup
    let _themePopup = null;

    function _closeThemePopup() {
        _themePopup?.remove();
        _themePopup = null;
    }

    async function _openThemePicker(btn, notebook) {
        _closeThemePopup();
        const themes = await NbTheme.listThemes();
        const current = NbTheme.getSlug();
        const mode    = NbTheme.getMode();

        const popup = document.createElement('div');
        popup.className = 'nb-theme-popup';
        popup.innerHTML = `
            <div class="nb-theme-popup-toolbar">
                <span class="nb-theme-popup-title">Theme</span>
                <button class="nb-theme-mode-toggle" title="Toggle light/dark">${mode === 'dark' ? '☀ Light' : '☾ Dark'}</button>
            </div>
            <div class="nb-theme-cards"></div>`;

        const cards = popup.querySelector('.nb-theme-cards');
        for (const t of themes) {
            const vars = t[mode] || {};
            const card = document.createElement('button');
            card.className = 'nb-theme-card' + (t.slug === current ? ' nb-theme-card-active' : '');
            card.dataset.slug = t.slug;
            card.innerHTML = `
                <span class="nb-theme-swatches">
                    <span style="background:${vars.bg     || '#000'}"></span>
                    <span style="background:${vars.bg2    || '#111'}"></span>
                    <span style="background:${vars.accent || '#48f'}"></span>
                    <span style="background:${vars.green  || '#4a4'}"></span>
                    <span style="background:${vars.red    || '#a44'}"></span>
                </span>
                <span class="nb-theme-card-name">${_esc(t.name)}</span>`;
            card.addEventListener('click', async () => {
                await NbTheme.apply(t.slug, NbTheme.getMode());
                await NbTheme.saveToNotebook(t.slug, notebook);
                _closeThemePopup();
            });
            cards.appendChild(card);
        }

        popup.querySelector('.nb-theme-mode-toggle').addEventListener('click', async () => {
            await NbTheme.toggleMode();
            _closeThemePopup();
            _openThemePicker(btn, notebook);
        });

        // Stop ALL clicks inside the popup from reaching document-level handlers
        popup.addEventListener('click', e => e.stopPropagation());

        document.body.appendChild(popup);
        _themePopup = popup;   // set before positioning so any stray event finds it set
        const r = btn.getBoundingClientRect();
        popup.style.top  = `${r.bottom + 6}px`;
        popup.style.left = `${Math.min(r.left, window.innerWidth - popup.offsetWidth - 8)}px`;
    }

    document.addEventListener('click', e => {
        const btn = e.target.closest('.nb-specialty-theme-btn');
        if (btn) {
            e.stopPropagation();
            if (_themePopup) { _closeThemePopup(); return; }
            _openThemePicker(btn, btn.dataset.notebook);
            return;
        }
        if (_themePopup && !_themePopup.contains(e.target)) _closeThemePopup();
    });

    document.addEventListener('nb-theme-changed', () => {
        // Refresh active-card highlight if popup is open
        if (!_themePopup) return;
        _themePopup.querySelectorAll('.nb-theme-card').forEach(c => {
            c.classList.toggle('nb-theme-card-active', c.dataset.slug === NbTheme.getSlug());
        });
    });

    // Public API — plugins call these after this script loads
    window.NbSpecialty = {
        cfg: _cfg,
        register(type, config) { _cfg[type] = config; },
        getActions: () => '',   // overridable: fn(note) => HTML string
    };

})();

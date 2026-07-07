// nb-web dialog.js — NbDialog: import/export/move/copy/rename + folder ops panel
// Extracted from main.js (tier-1 modularization, 2026-07-06) — verbatim move, no logic changes.

// ── Import / Export / Move panel ──────────────────────────────
const NbDialog = (() => {
    let _tab = 'import';
    let _bulkSelectors  = null; // null = single-note mode, array = bulk mode
    let _folderSelector = null; // non-null = folder mode
    let _folderName     = '';   // display name for folder being operated on

    function _esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function _panel() { return document.getElementById('nb-action-panel'); }
    function _body()  { return _panel()?.querySelector('.nb-dlg-body'); }

    function open(tab, bulkSelectors = null) {
        _tab = tab || 'import';
        _bulkSelectors = bulkSelectors?.length ? bulkSelectors : null;
        _panel()?.remove();

        const toolbar = document.getElementById('nb-preview-toolbar');
        const pane    = document.getElementById('nb-preview-pane');
        if (!pane) return;

        const panel = document.createElement('div');
        panel.id = 'nb-action-panel';

        const header = document.createElement('div');
        header.className = 'nb-dlg-header';
        const tabsEl = document.createElement('div');
        tabsEl.className = 'nb-dlg-tabs';
        const allTabs = [['import','📥 Import'], ['export','⬇ Export'], ['move','→ Move'], ['copy','⎘ Copy'], ['rename','✏ Rename']];
        const tabDefs = _bulkSelectors ? allTabs.filter(([id]) => id === 'export' || id === 'move' || id === 'copy') : allTabs;
        tabDefs.forEach(([id, label]) => {
            const btn = document.createElement('button');
            btn.className = 'nb-dlg-tab' + (id === _tab ? ' active' : '');
            btn.dataset.tab = id; btn.textContent = label;
            btn.addEventListener('click', () => { _tab = id; _updateTabs(); _renderTab(); });
            tabsEl.appendChild(btn);
        });
        const closeBtn = document.createElement('button');
        closeBtn.className = 'nb-dlg-close'; closeBtn.textContent = '✕';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.addEventListener('click', close);
        header.append(tabsEl, closeBtn);

        const body = document.createElement('div');
        body.className = 'nb-dlg-body';
        panel.append(header, body);

        // Sibling of preview-content — toolbar stays, content shows below
        toolbar.insertAdjacentElement('afterend', panel);
        toolbar.hidden = false;
        _renderTab();
    }

    function close() { _bulkSelectors = null; _folderSelector = null; _folderName = ''; _panel()?.remove(); }

    function _updateTabs() {
        _panel()?.querySelectorAll('.nb-dlg-tab').forEach(btn =>
            btn.classList.toggle('active', btn.dataset.tab === _tab));
    }

    function _renderTab() {
        const body = _body();
        if (!body) return;
        body.innerHTML = '';
        if (_tab === 'import')          _renderImport();
        else if (_tab === 'export')     _renderExport();
        else if (_tab === 'move')       _renderMove();
        else if (_tab === 'copy')       _renderCopy();
        else if (_tab === 'rename')     _renderRename();
        else if (_tab === 'f-rename')   _renderFolderRename();
        else if (_tab === 'f-move')     _renderFolderMove();
        else if (_tab === 'f-copy')     _renderFolderCopy();
        else if (_tab === 'f-delete')   _renderFolderDelete();
        else if (_tab === 'f-lock')     _renderFolderLock();
    }

    // ── Folder dialog ──────────────────────────────────────────
    function openFolder(selector, name, initialLocked) {
        _folderSelector = selector;
        _folderName     = name || selector;
        _bulkSelectors  = null;
        _tab = initialLocked ? 'f-lock' : 'f-rename';
        _panel()?.remove();

        const toolbar = document.getElementById('nb-preview-toolbar');
        const pane    = document.getElementById('nb-preview-pane');
        if (!pane) return;

        const panel = document.createElement('div');
        panel.id = 'nb-action-panel';

        const header = document.createElement('div');
        header.className = 'nb-dlg-header';
        const tabsEl = document.createElement('div');
        tabsEl.className = 'nb-dlg-tabs';
        [['f-rename','✏ Rename'], ['f-move','→ Move'], ['f-copy','⎘ Copy'], ['f-delete','🗑 Delete'], ['f-lock','🔒 Lock']].forEach(([id, label]) => {
            const btn = document.createElement('button');
            btn.className = 'nb-dlg-tab' + (id === _tab ? ' active' : '');
            btn.dataset.tab = id; btn.textContent = label;
            btn.addEventListener('click', () => { _tab = id; _updateTabs(); _renderTab(); });
            tabsEl.appendChild(btn);
        });
        const closeBtn = document.createElement('button');
        closeBtn.className = 'nb-dlg-close'; closeBtn.textContent = '✕';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.addEventListener('click', close);
        header.append(tabsEl, closeBtn);

        const body = document.createElement('div');
        body.className = 'nb-dlg-body';
        panel.append(header, body);
        toolbar.insertAdjacentElement('afterend', panel);
        toolbar.hidden = false;
        _renderTab();
    }

    function _renderFolderRename() {
        const body = _body();
        const nameInput = document.createElement('input');
        nameInput.type = 'text'; nameInput.className = 'nb-rename-input'; nameInput.style.flex = '1';
        nameInput.value = _folderName;
        const nameRow = _row('Name:', nameInput);

        const saveBtn = document.createElement('button');
        saveBtn.className = 'nb-tool-btn nb-btn-primary'; saveBtn.textContent = 'Rename';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'nb-tool-btn'; cancelBtn.textContent = 'Cancel';
        const btnRow = document.createElement('div');
        btnRow.className = 'nb-dlg-row nb-dlg-btn-row';
        btnRow.append(saveBtn, cancelBtn);
        cancelBtn.addEventListener('click', close);

        async function commit() {
            const newName = nameInput.value.trim();
            if (!newName || newName === _folderName) { nameInput.focus(); return; }
            saveBtn.textContent = 'Renaming…'; saveBtn.disabled = true;
            try {
                const r = await fetch('/api/folder/rename', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ selector: _folderSelector, name: newName }),
                });
                const d = await r.json();
                if (d.success) {
                    close();
                    NbNav.reexecute();
                } else {
                    alert('Rename failed: ' + (d.stderr || 'unknown'));
                    saveBtn.textContent = 'Rename'; saveBtn.disabled = false;
                }
            } catch { saveBtn.textContent = 'Rename'; saveBtn.disabled = false; }
        }
        saveBtn.addEventListener('click', commit);
        nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); });
        body.append(nameRow, btnRow);
        nameInput.focus(); nameInput.select();
    }

    async function _renderFolderMove() {
        const body   = _body();
        const curNb  = _folderSelector.split(':')[0];
        const selfNm = _folderName; // exclude from folder picker when same notebook

        body.innerHTML = '<p class="nb-dlg-loading">Loading…</p>';
        const nbSel = await _buildNbPicker(curNb);
        let folderSel = await _buildFolderPicker(curNb, selfNm);
        body.innerHTML = '';

        const destRow = _row('Into:', nbSel, folderSel);
        nbSel.addEventListener('change', async () => {
            const exclude = nbSel.value === curNb ? selfNm : null;
            const next = await _buildFolderPicker(nbSel.value, exclude);
            destRow.replaceChild(next, folderSel);
            folderSel = next;
        });

        const moveBtn = document.createElement('button');
        moveBtn.className = 'nb-tool-btn nb-btn-primary'; moveBtn.textContent = 'Move folder';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'nb-tool-btn'; cancelBtn.textContent = 'Cancel';
        const btnRow = document.createElement('div');
        btnRow.className = 'nb-dlg-row nb-dlg-btn-row';
        btnRow.append(moveBtn, cancelBtn);
        cancelBtn.addEventListener('click', close);

        moveBtn.addEventListener('click', async () => {
            const dest = folderSel.value ? `${nbSel.value}:${folderSel.value}/` : `${nbSel.value}:`;
            moveBtn.textContent = 'Moving…'; moveBtn.disabled = true;
            try {
                const r = await fetch('/api/folder/move', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ selector: _folderSelector, dest }),
                });
                const d = await r.json();
                if (d.success) {
                    close();
                    document.querySelector(`#nb-list .nb-list-item[data-selector="${CSS.escape(_folderSelector)}"]`)?.remove();
                    NbMain.clearNote('Folder moved.');
                    NbNav.reexecute();
                } else {
                    alert('Move failed: ' + (d.stderr || 'unknown'));
                    moveBtn.textContent = 'Move folder'; moveBtn.disabled = false;
                }
            } catch { moveBtn.textContent = 'Move folder'; moveBtn.disabled = false; }
        });

        body.append(destRow, btnRow);
        nbSel.focus();
    }

    async function _renderFolderCopy() {
        const body  = _body();
        const curNb = _folderSelector.split(':')[0];

        body.innerHTML = '<p class="nb-dlg-loading">Loading…</p>';
        const nbSel = await _buildNbPicker(curNb);
        let folderSel = await _buildFolderPicker(curNb, _folderName);
        body.innerHTML = '';

        const info = document.createElement('p');
        info.className = 'nb-dlg-info';
        info.textContent = `Copy "${_folderName}" and all its contents to:`;
        const destRow = _row('Into:', nbSel, folderSel);
        nbSel.addEventListener('change', async () => {
            const exclude = nbSel.value === curNb ? _folderName : null;
            const next = await _buildFolderPicker(nbSel.value, exclude);
            destRow.replaceChild(next, folderSel);
            folderSel = next;
        });

        const copyBtn = document.createElement('button');
        copyBtn.className = 'nb-tool-btn nb-btn-primary'; copyBtn.textContent = 'Copy folder';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'nb-tool-btn'; cancelBtn.textContent = 'Cancel';
        const btnRow = document.createElement('div');
        btnRow.className = 'nb-dlg-row nb-dlg-btn-row';
        btnRow.append(copyBtn, cancelBtn);
        cancelBtn.addEventListener('click', close);

        copyBtn.addEventListener('click', async () => {
            const dest = folderSel.value ? `${nbSel.value}:${folderSel.value}/` : `${nbSel.value}:`;
            copyBtn.textContent = 'Copying…'; copyBtn.disabled = true;
            try {
                const r = await fetch('/api/folder/copy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ selector: _folderSelector, dest }),
                });
                const d = await r.json();
                if (d.success) {
                    close();
                    NbNav.reexecute();
                } else {
                    alert('Copy failed: ' + (d.stderr || 'unknown'));
                    copyBtn.textContent = 'Copy folder'; copyBtn.disabled = false;
                }
            } catch { copyBtn.textContent = 'Copy folder'; copyBtn.disabled = false; }
        });

        body.append(info, destRow, btnRow);
        nbSel.focus();
    }

    function _renderFolderDelete() {
        const body = _body();
        const warn = document.createElement('p');
        warn.className = 'nb-dlg-info';
        warn.style.color = 'var(--red, #f87171)';
        warn.textContent = `Delete "${_folderName}" and all its contents? This cannot be undone.`;

        const delBtn = document.createElement('button');
        delBtn.className = 'nb-tool-btn nb-btn-danger'; delBtn.textContent = `Delete "${_folderName}"`;
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'nb-tool-btn'; cancelBtn.textContent = 'Cancel';
        const btnRow = document.createElement('div');
        btnRow.className = 'nb-dlg-row nb-dlg-btn-row';
        btnRow.append(delBtn, cancelBtn);
        cancelBtn.addEventListener('click', close);

        delBtn.addEventListener('click', async () => {
            delBtn.textContent = 'Deleting…'; delBtn.disabled = true;
            try {
                const r = await fetch('/api/folder', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ selector: _folderSelector }),
                });
                const d = await r.json();
                if (d.success) {
                    close();
                    document.querySelector(`#nb-list .nb-list-item[data-selector="${CSS.escape(_folderSelector)}"]`)?.remove();
                    NbMain.clearNote('Folder deleted.');
                    NbNav.reexecute();
                } else {
                    alert('Delete failed: ' + (d.stderr || 'unknown'));
                    delBtn.textContent = `Delete "${_folderName}"`; delBtn.disabled = false;
                }
            } catch { delBtn.textContent = `Delete "${_folderName}"`; delBtn.disabled = false; }
        });

        body.append(warn, btnRow);
        delBtn.focus();
    }

    async function _renderFolderLock() {
        const body = _body();
        body.innerHTML = '<p class="nb-dlg-loading">Loading…</p>';

        let isLocked = false, lockReason = '';
        try {
            const r = await fetch('/api/folder/lock?selector=' + encodeURIComponent(_folderSelector));
            if (r.ok) {
                const d = await r.json();
                isLocked   = d.locked || false;
                lockReason = d.reason || '';
            }
        } catch(_) {}

        body.innerHTML = '';

        const statusEl = document.createElement('p');
        statusEl.className = 'nb-dlg-info';
        statusEl.innerHTML = isLocked
            ? `<strong>🔒 Locked</strong> — notes in this folder are read-only.${lockReason ? `<br><em>${_esc(lockReason)}</em>` : ''}`
            : `Unlocked — notes in this folder are editable.`;

        const reasonInput = document.createElement('input');
        reasonInput.type = 'text';
        reasonInput.className = 'nb-rename-input';
        reasonInput.style.flex = '1';
        reasonInput.placeholder = 'Reason (optional)…';
        reasonInput.value = lockReason;  // preserved across lock/unlock cycles
        const reasonRow = _row('Reason:', reasonInput);

        const lockBtn = document.createElement('button');
        lockBtn.className = isLocked ? 'nb-tool-btn nb-btn-danger' : 'nb-tool-btn nb-btn-primary';
        lockBtn.textContent = isLocked ? 'Unlock folder' : 'Lock folder';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'nb-tool-btn'; cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', close);
        const btnRow = document.createElement('div');
        btnRow.className = 'nb-dlg-row nb-dlg-btn-row';
        btnRow.append(lockBtn, cancelBtn);

        lockBtn.addEventListener('click', async () => {
            lockBtn.disabled = true; lockBtn.textContent = '…';
            try {
                await fetch('/api/folder/lock', {
                    method: isLocked ? 'DELETE' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ selector: _folderSelector, reason: reasonInput.value.trim() }),
                });
                close();
                NbNav.reexecute();
            } catch(_) { lockBtn.disabled = false; lockBtn.textContent = isLocked ? 'Unlock folder' : 'Lock folder'; }
        });

        body.append(statusEl, ...(!isLocked ? [reasonRow] : []), btnRow);
    }

    // ── Shared pickers ─────────────────────────────────────────
    async function _buildNbPicker(defaultNb) {
        const { notebooks } = await fetch('/api/notebooks').then(r => r.json());
        const sel = document.createElement('select');
        sel.className = 'nb-scope-select';
        (notebooks || []).forEach(nb => {
            const opt = document.createElement('option');
            opt.value = nb; opt.textContent = nb;
            if (nb === defaultNb) opt.selected = true;
            sel.appendChild(opt);
        });
        return sel;
    }

    async function _buildFolderPicker(nb, exclude = null) {
        const { folders } = await fetch(`/api/folders?notebook=${encodeURIComponent(nb)}`).then(r => r.json());
        const sel = document.createElement('select');
        sel.className = 'nb-scope-select';
        const none = document.createElement('option');
        none.value = ''; none.textContent = '(root)';
        sel.appendChild(none);
        const available = (folders || []).filter(f =>
            f !== exclude && !(exclude && f.startsWith(exclude + '/')));
        available.forEach(f => {
            const depth = (f.match(/\//g) || []).length;
            const name  = f.split('/').pop();
            const opt   = document.createElement('option');
            opt.value   = f;
            opt.textContent = '  '.repeat(depth) + name + '/';
            sel.appendChild(opt);
        });
        return sel;
    }

    // ── Native file picker helper ───────────────────────────────
    async function _browseNative(multiple = true) {
        try {
            const r = await fetch('/api/browse-path', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ multiple }),
            });
            const d = await r.json();
            return Array.isArray(d.paths) ? d.paths : null; // null = unavailable
        } catch(e) { return null; }
    }

    // ── Import tab ─────────────────────────────────────────────
    async function _renderImport() {
        const body = _body();
        body.innerHTML = '<p class="nb-dlg-loading">Loading…</p>';
        const currentNb = NbNav.notebook === '_all' ? 'home' : NbNav.notebook;
        const nbSel = await _buildNbPicker(currentNb);
        let folderSel = await _buildFolderPicker(currentNb);
        body.innerHTML = '';

        let _selPaths = [], _selFiles = [], _linkMode = false;

        // Row 1: destination
        const destRow = _row('Into:', nbSel, folderSel);
        nbSel.addEventListener('change', async () => {
            const next = await _buildFolderPicker(nbSel.value);
            destRow.replaceChild(next, folderSel);
            folderSel = next;
        });

        // File list — appears after picker returns files
        const fileListEl = document.createElement('div');
        fileListEl.className = 'nb-dlg-file-list';
        fileListEl.hidden = true;

        // Annotation row — appears alongside file list
        const annInput = document.createElement('input');
        annInput.type = 'text'; annInput.className = 'nb-rename-input';
        annInput.placeholder = 'Annotation…'; annInput.style.flex = '1';
        const annRow = _row('Note:', annInput);
        annRow.hidden = true;

        // Link mode: path input row
        const pathInput = document.createElement('input');
        pathInput.type = 'text'; pathInput.className = 'nb-rename-input';
        pathInput.placeholder = '/path/to/file'; pathInput.style.flex = '1';
        const pathBrowseBtn = document.createElement('button');
        pathBrowseBtn.className = 'nb-tool-btn'; pathBrowseBtn.textContent = '📂';
        pathBrowseBtn.type = 'button'; pathBrowseBtn.title = 'Browse…';
        pathBrowseBtn.addEventListener('click', async () => {
            pathBrowseBtn.disabled = true;
            const paths = await _browseNative(false);
            pathBrowseBtn.disabled = false;
            if (paths && paths.length) pathInput.value = paths[0];
            pathInput.focus();
        });
        const pathRow = _row('Path:', pathInput, pathBrowseBtn);
        pathRow.hidden = true;

        // Hidden browser file input fallback
        const fileInput = document.createElement('input');
        fileInput.type = 'file'; fileInput.multiple = true; fileInput.style.display = 'none';
        fileInput.addEventListener('change', () => {
            _selFiles = [...fileInput.files];
            _selPaths = [];
            _showSelected(_selFiles.map(f => f.name));
        });

        function _showSelected(names) {
            fileListEl.innerHTML = '';
            names.forEach(n => {
                const s = document.createElement('span');
                s.className = 'nb-dlg-file-item';
                s.textContent = '✓ ' + n;
                fileListEl.appendChild(s);
            });
            fileListEl.hidden = false;
            annRow.hidden = false;
            importBtn.disabled = false;
            browseBtn.textContent = 'Change…';
            annInput.focus();
        }

        // Buttons
        const importBtn = document.createElement('button');
        importBtn.className = 'nb-tool-btn nb-btn-primary'; importBtn.textContent = 'Import';
        importBtn.type = 'button'; importBtn.disabled = true;

        const linkActionBtn = document.createElement('button');
        linkActionBtn.className = 'nb-tool-btn nb-btn-primary'; linkActionBtn.textContent = 'Link file';
        linkActionBtn.type = 'button'; linkActionBtn.hidden = true;

        const browseBtn = document.createElement('button');
        browseBtn.className = 'nb-tool-btn'; browseBtn.textContent = 'Browse…';
        browseBtn.type = 'button';

        const linkBtn = document.createElement('button');
        linkBtn.className = 'nb-tool-btn'; linkBtn.textContent = '🔗';
        linkBtn.type = 'button'; linkBtn.title = 'Switch to symlink mode';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'nb-tool-btn'; cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', close);

        const btnRow = document.createElement('div');
        btnRow.className = 'nb-dlg-row nb-dlg-btn-row';
        btnRow.append(importBtn, linkActionBtn, browseBtn, linkBtn, cancelBtn);

        browseBtn.addEventListener('click', async () => {
            browseBtn.disabled = true;
            const prev = browseBtn.textContent;
            browseBtn.textContent = 'Choosing…';
            const paths = await _browseNative(true);
            browseBtn.disabled = false; browseBtn.textContent = prev;
            if (paths === null) { fileInput.click(); }
            else if (paths.length) {
                _selPaths = paths; _selFiles = [];
                _showSelected(paths.map(p => p.split('/').pop()));
            }
        });

        importBtn.addEventListener('click', async () => {
            const ann = annInput.value.trim();
            importBtn.disabled = true; importBtn.textContent = 'Importing…';
            try {
                if (_selPaths.length) {
                    const resp = await fetch('/api/import', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ paths: _selPaths, notebook: nbSel.value, folder: folderSel.value }),
                    });
                    const d = await resp.json();
                    if (d.success) {
                        if (ann && d.selectors?.length) {
                            await Promise.all(d.selectors.map(sel =>
                                fetch(`/api/note/annotate?selector=${encodeURIComponent(sel)}`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ content: ann }),
                                }).catch(() => {})
                            ));
                        }
                        close(); NbNav.reexecute();
                    } else {
                        alert('Import failed');
                        importBtn.disabled = false; importBtn.textContent = 'Import';
                    }
                } else if (_selFiles.length) {
                    importBtn.textContent = 'Importing…';
                    const nb = nbSel.value, folder = folderSel.value;
                    const lines = [], selectors = [];
                    for (const file of _selFiles) {
                        const fd = new FormData();
                        fd.append('file', file);
                        fd.append('notebook', nb);
                        if (folder) fd.append('folder', folder);
                        try {
                            const r = await fetch('/api/import', { method: 'POST', body: fd });
                            const d = await r.json();
                            lines.push(d.success ? `✓ ${file.name}` : `✗ ${file.name}: ${d.error || d.stderr || 'failed'}`);
                            if (d.success && d.selector) selectors.push(d.selector);
                        } catch(e) { lines.push(`✗ ${file.name}: ${e}`); }
                    }
                    if (ann && selectors.length) {
                        await Promise.all(selectors.map(sel =>
                            fetch(`/api/note/annotate?selector=${encodeURIComponent(sel)}`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ content: ann }),
                            }).catch(() => {})
                        ));
                    }
                    close();
                    NbNav.reexecute();
                }
            } catch(e) { importBtn.disabled = false; importBtn.textContent = 'Import'; }
        });
        annInput.addEventListener('keydown', e => { if (e.key === 'Enter') importBtn.click(); });

        linkActionBtn.addEventListener('click', async () => {
            const path = pathInput.value.trim();
            if (!path) { pathInput.focus(); return; }
            const ann = annInput.value.trim();
            linkActionBtn.textContent = 'Linking…'; linkActionBtn.disabled = true;
            try {
                const r = await fetch('/api/link-file', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path, notebook: nbSel.value }),
                });
                const d = await r.json();
                if (d.success) {
                    if (ann && d.selector) {
                        await fetch(`/api/note/annotate?selector=${encodeURIComponent(d.selector)}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ content: ann }),
                        }).catch(() => {});
                    }
                    close(); NbNav.reexecute();
                } else {
                    alert('Link failed: ' + (d.error || 'unknown'));
                    linkActionBtn.textContent = 'Link file'; linkActionBtn.disabled = false;
                }
            } catch(e) { linkActionBtn.textContent = 'Link file'; linkActionBtn.disabled = false; }
        });
        pathInput.addEventListener('keydown', e => { if (e.key === 'Enter') linkActionBtn.click(); });

        linkBtn.addEventListener('click', () => {
            _linkMode = !_linkMode;
            linkBtn.classList.toggle('active', _linkMode);
            linkBtn.title        = _linkMode ? 'Switch to import (copy) mode' : 'Switch to symlink mode';
            pathRow.hidden       = !_linkMode;
            fileListEl.hidden    = _linkMode;
            annRow.hidden        = !_linkMode && !_selFiles.length;
            importBtn.hidden     = _linkMode;
            linkActionBtn.hidden = !_linkMode;
            browseBtn.hidden     = _linkMode;
            (_linkMode ? pathInput : annInput).focus();
        });

        body.append(fileInput, destRow, fileListEl, annRow, pathRow, btnRow);
    }

    // Capture the rendered preview DOM, stripping interactive controls
    // (buttons, forms, spinners) that don't belong in an exported document.
    function _captureRenderedHtml() {
        const src = document.getElementById('nb-preview-content');
        if (!src) return '';
        const clone = src.cloneNode(true);
        clone.querySelectorAll('button, form, .nb-spin').forEach(el => el.remove());
        return clone.innerHTML;
    }

    // ── Export tab ─────────────────────────────────────────────
    function _renderExport() {
        if (_bulkSelectors?.length) { _renderExportBulk(); return; }
        const body     = _body();
        const selector = NbMain.activeSelector();
        if (!selector) {
            body.innerHTML = '<p class="nb-dlg-empty">No note selected — open a note first.</p>';
            return;
        }

        // Row 1: Filename (full width)
        const nameInput = document.createElement('input');
        nameInput.type = 'text'; nameInput.className = 'nb-rename-input'; nameInput.style.flex = '1';
        const nameRow = _row('Filename:', nameInput);

        // Row 2: Format (left) — Save + Cancel (right)
        const fmtSel = document.createElement('select');
        fmtSel.className = 'nb-scope-select';
        NbMain.exportFormats(NbMain.activeType()).forEach(f => {
            const opt = document.createElement('option');
            opt.value = f.value; opt.textContent = f.label;
            fmtSel.appendChild(opt);
        });
        const saveBtn = document.createElement('button');
        saveBtn.className = 'nb-tool-btn nb-btn-primary'; saveBtn.textContent = 'Save';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'nb-tool-btn'; cancelBtn.textContent = 'Cancel';
        const spacer = document.createElement('span');
        spacer.className = 'nb-spacer';
        const fmtRow = document.createElement('div');
        fmtRow.className = 'nb-dlg-row';
        fmtRow.append(fmtSel, spacer, saveBtn, cancelBtn);

        const EXT = { md: '.md', html: '.html', docx: '.docx', odt: '.odt' };
        function updateName() {
            const fmt  = fmtSel.value;
            const base = (document.getElementById('nb-preview-title')?.textContent || 'note')
                .replace(/[^\w\s\-]/g, '').trim().replace(/\s+/g, '_') || 'note';
            nameInput.disabled = fmt === 'print';
            nameInput.value = fmt === 'raw'   ? (NbMain.activeFilename() || base)
                            : fmt === 'print' ? base + '.pdf'
                            :                   base + (EXT[fmt] || '');
        }
        fmtSel.addEventListener('change', updateName);
        updateName();
        cancelBtn.addEventListener('click', close);

        async function commit() {
            const fmt = fmtSel.value;
            if (fmt === 'print') { close(); NbMain.doPrint(); return; }
            const filename = nameInput.value.trim() || 'export';

            // html/docx/odt: export the rendered preview DOM so codeblock
            // output (tw tables, hledger reports, etc.) is included, not the
            // raw codeblock source. md/raw use the file on disk unchanged.
            if (['html', 'docx', 'odt'].includes(fmt)) {
                const title   = document.getElementById('nb-preview-title')?.textContent || filename;
                const html     = _captureRenderedHtml();
                const notebook = selector?.split(':')[0] || '';
                const payload  = JSON.stringify({ html, fmt, filename, title, notebook });
                const headers = { 'Content-Type': 'application/json' };
                const ACCEPT  = {
                    html: { 'text/html': ['.html'] },
                    docx: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] },
                    odt:  { 'application/vnd.oasis.opendocument.text': ['.odt'] },
                };
                if (window.showSaveFilePicker) {
                    try {
                        const handle = await window.showSaveFilePicker({
                            suggestedName: filename,
                            types: [{ description: filename, accept: ACCEPT[fmt] }],
                        });
                        saveBtn.textContent = 'Saving…'; saveBtn.disabled = true;
                        const resp = await fetch('/api/export-html', { method: 'POST', headers, body: payload });
                        if (!resp.ok) throw new Error(await resp.text());
                        const writable = await handle.createWritable();
                        await resp.body.pipeTo(writable);
                        await writable.close();
                        close(); return;
                    } catch (e) { if (e.name === 'AbortError') return; }
                }
                saveBtn.textContent = 'Saving…'; saveBtn.disabled = true;
                const resp = await fetch('/api/export-html', { method: 'POST', headers, body: payload });
                const blob = await resp.blob();
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob); a.download = filename;
                document.body.appendChild(a); a.click();
                document.body.removeChild(a); URL.revokeObjectURL(a.href);
                close(); return;
            }

            // md / raw: stream the file straight from disk
            const url = fmt === 'raw'
                ? `/api/file?selector=${encodeURIComponent(selector)}`
                : `/api/export?selector=${encodeURIComponent(selector)}&fmt=${fmt}`;
            if (window.showSaveFilePicker) {
                const ACCEPT = { md: { 'text/markdown': ['.md'] } };
                try {
                    const types = ACCEPT[fmt] ? [{ description: filename, accept: ACCEPT[fmt] }] : [];
                    const handle = await window.showSaveFilePicker({ suggestedName: filename, ...(types.length && { types }) });
                    saveBtn.textContent = 'Saving…'; saveBtn.disabled = true;
                    const resp = await fetch(url);
                    if (!resp.ok) throw new Error(await resp.text());
                    const writable = await handle.createWritable();
                    await resp.body.pipeTo(writable);
                    await writable.close();
                    close(); return;
                } catch (e) { if (e.name === 'AbortError') return; }
            }
            const a = document.createElement('a');
            a.href = url; a.download = filename;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            close();
        }

        saveBtn.addEventListener('click', commit);
        nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); });

        body.append(nameRow, fmtRow);
        if (!nameInput.disabled) { nameInput.focus(); nameInput.select(); }
    }

    // ── Bulk export ────────────────────────────────────────────
    function _renderExportBulk() {
        const body  = _body();
        const count = _bulkSelectors.length;

        const infoEl = document.createElement('p');
        infoEl.className = 'nb-dlg-info';
        infoEl.textContent = `${count} note${count !== 1 ? 's' : ''} compiled into one document.`;

        // Row 1: Filename
        const nameInput = document.createElement('input');
        nameInput.type = 'text'; nameInput.className = 'nb-rename-input'; nameInput.style.flex = '1';
        nameInput.value = 'nb-export.md';
        const nameRow = _row('Filename:', nameInput);

        // Row 2: Format + Export + Cancel
        const fmtSel = document.createElement('select');
        fmtSel.className = 'nb-scope-select';
        [['md','Markdown (.md)'], ['html','HTML (.html)'], ['docx','Word (.docx)'], ['odt','ODT (.odt)']].forEach(([v, l]) => {
            const opt = document.createElement('option'); opt.value = v; opt.textContent = l;
            fmtSel.appendChild(opt);
        });
        const EXT = { md: '.md', html: '.html', docx: '.docx', odt: '.odt' };
        fmtSel.addEventListener('change', () => {
            const base = nameInput.value.replace(/\.[^.]+$/, '');
            nameInput.value = base + EXT[fmtSel.value];
        });

        // Concat checkbox — join without dividers or section titles
        const concatChk = document.createElement('input');
        concatChk.type = 'checkbox'; concatChk.id = 'nb-export-concat';
        const concatLbl = document.createElement('label');
        concatLbl.htmlFor = 'nb-export-concat';
        concatLbl.textContent = 'Page assembly — join without dividers or section titles';
        concatLbl.style.cssText = 'font-size:0.9em;cursor:pointer;user-select:none';
        const concatRow = document.createElement('div');
        concatRow.className = 'nb-dlg-row'; concatRow.style.gap = '8px';
        concatRow.append(concatChk, concatLbl);

        const saveBtn = document.createElement('button');
        saveBtn.className = 'nb-tool-btn nb-btn-primary'; saveBtn.textContent = `Export ${count}`;
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'nb-tool-btn'; cancelBtn.textContent = 'Cancel';
        const spacer = document.createElement('span'); spacer.className = 'nb-spacer';
        const fmtRow = document.createElement('div');
        fmtRow.className = 'nb-dlg-row';
        fmtRow.append(fmtSel, spacer, saveBtn, cancelBtn);
        cancelBtn.addEventListener('click', close);

        saveBtn.addEventListener('click', async () => {
            const fmt      = fmtSel.value;
            const filename = nameInput.value.trim() || ('nb-export' + EXT[fmt]);
            const headers  = { 'Content-Type': 'application/json' };

            if (fmt === 'md') {
                // Server-side raw-file compilation (existing path)
                const payload = JSON.stringify({ selectors: _bulkSelectors, concat: concatChk.checked });
                const ACCEPT  = { 'text/markdown': ['.md'] };
                if (window.showSaveFilePicker) {
                    try {
                        const handle = await window.showSaveFilePicker({
                            suggestedName: filename,
                            types: [{ description: 'Markdown', accept: ACCEPT }],
                        });
                        saveBtn.textContent = 'Exporting…'; saveBtn.disabled = true;
                        const resp = await fetch('/api/note/export-bulk', { method: 'POST', headers, body: payload });
                        if (!resp.ok) throw new Error(await resp.text());
                        const writable = await handle.createWritable();
                        await resp.body.pipeTo(writable);
                        await writable.close();
                        close(); return;
                    } catch (e) { if (e.name === 'AbortError') return; }
                }
                saveBtn.textContent = 'Exporting…'; saveBtn.disabled = true;
                const resp = await fetch('/api/note/export-bulk', { method: 'POST', headers, body: payload });
                const blob = await resp.blob();
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob); a.download = filename;
                document.body.appendChild(a); a.click();
                document.body.removeChild(a); URL.revokeObjectURL(a.href);
                close(); return;
            }

            // html / docx / odt: render each note client-side (fires tw/hl/csv queries)
            // then compile into one HTML document and convert via /api/export-html
            saveBtn.disabled = true;
            const selectors = _bulkSelectors;
            const parts = [];
            for (let i = 0; i < selectors.length; i++) {
                saveBtn.textContent = `Rendering ${i + 1} / ${selectors.length}…`;
                const result = await NbMain.renderNoteHtml(selectors[i]);
                if (result) {
                    parts.push(result.html);
                }
            }

            if (!parts.length) {
                alert('Nothing to export.'); saveBtn.textContent = `Export ${count}`; saveBtn.disabled = false; return;
            }

            const compiledHtml = parts.join(concatChk.checked ? '\n' : '\n<hr>\n');
            const title    = filename.replace(/\.[^.]+$/, '');
            const notebook = _bulkSelectors[0]?.split(':')[0] || '';
            const payload  = JSON.stringify({ html: compiledHtml, fmt, filename, title, notebook });

            const ACCEPT = {
                html: { 'text/html': ['.html'] },
                docx: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] },
                odt:  { 'application/vnd.oasis.opendocument.text': ['.odt'] },
            };
            if (window.showSaveFilePicker) {
                try {
                    const handle = await window.showSaveFilePicker({
                        suggestedName: filename,
                        types: [{ description: filename, accept: ACCEPT[fmt] }],
                    });
                    saveBtn.textContent = 'Converting…';
                    const resp = await fetch('/api/export-html', { method: 'POST', headers, body: payload });
                    if (!resp.ok) throw new Error(await resp.text());
                    const writable = await handle.createWritable();
                    await resp.body.pipeTo(writable);
                    await writable.close();
                    close(); return;
                } catch (e) { if (e.name === 'AbortError') { saveBtn.textContent = `Export ${count}`; saveBtn.disabled = false; return; } }
            }
            saveBtn.textContent = 'Converting…';
            const resp = await fetch('/api/export-html', { method: 'POST', headers, body: payload });
            const blob = await resp.blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob); a.download = filename;
            document.body.appendChild(a); a.click();
            document.body.removeChild(a); URL.revokeObjectURL(a.href);
            close();
        });

        body.append(infoEl, nameRow, concatRow, fmtRow);
        nameInput.focus(); nameInput.select();
    }

    // ── Move tab ───────────────────────────────────────────────
    async function _renderMove() {
        const body      = _body();
        const selectors = _bulkSelectors?.length ? _bulkSelectors
                        : NbMain.activeSelector()  ? [NbMain.activeSelector()]
                        : null;
        if (!selectors) {
            body.innerHTML = '<p class="nb-dlg-empty">No note selected — open a note first.</p>';
            return;
        }
        const isBulk = selectors.length > 1;
        const count  = selectors.length;

        body.innerHTML = '<p class="nb-dlg-loading">Loading…</p>';
        const curNb = selectors[0].split(':')[0];
        const nbSel = await _buildNbPicker(curNb);
        let folderSel = await _buildFolderPicker(curNb);
        body.innerHTML = '';

        // Row 1: notebook + folder
        const destRow = _row('Into:', nbSel, folderSel);
        nbSel.addEventListener('change', async () => {
            const next = await _buildFolderPicker(nbSel.value);
            destRow.replaceChild(next, folderSel);
            folderSel = next;
        });

        // Row 2: Move + Cancel
        const moveBtn = document.createElement('button');
        moveBtn.className = 'nb-tool-btn nb-btn-primary';
        moveBtn.textContent = isBulk ? `Move ${count} items` : 'Move';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'nb-tool-btn'; cancelBtn.textContent = 'Cancel';
        const btnRow = document.createElement('div');
        btnRow.className = 'nb-dlg-row nb-dlg-btn-row';
        btnRow.append(moveBtn, cancelBtn);
        cancelBtn.addEventListener('click', close);

        moveBtn.addEventListener('click', async () => {
            const destPrefix = folderSel.value ? `${nbSel.value}:${folderSel.value}/` : `${nbSel.value}:`;
            moveBtn.textContent = 'Moving…'; moveBtn.disabled = true;
            let failed = 0;
            const failReasons = [];
            for (const sel of selectors) {
                // Include the filename so nb doesn't preserve the source folder structure
                const filename = sel.split(':').slice(1).join(':').split('/').pop();
                const dest = destPrefix + filename;
                if (dest === sel) continue; // already at destination
                try {
                    const resp = await fetch('/api/note/move', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ selector: sel, dest }),
                    });
                    const rd = await resp.json();
                    if (!rd.success) {
                        failed++;
                        const msg = rd.stderr || '';
                        failReasons.push(msg.includes('already exists')
                            ? `A note named "${dest.split('/').pop()}" already exists at that destination.`
                            : (msg || 'unknown error'));
                    } else {
                        NbMain.bustNoteCache(sel);
                        document.querySelector(`#nb-list .nb-list-item[data-selector="${CSS.escape(sel)}"]`)?.remove();
                    }
                } catch(e) { failed++; failReasons.push(String(e)); }
            }
            if (failed) {
                alert(failReasons.join('\n') || `${failed} move${failed !== 1 ? 's' : ''} failed.`);
                moveBtn.textContent = isBulk ? `Move ${count} items` : 'Move';
                moveBtn.disabled = false;
            } else {
                close();
                NbMain.clearSelection?.();
                NbMain.clearNote(isBulk ? `${count} items moved.` : 'Note moved.');
                NbNav.reexecute();
            }
        });

        body.append(destRow, btnRow);
        nbSel.focus();
    }

    // ── Copy tab ───────────────────────────────────────────────
    async function _renderCopy() {
        const body      = _body();
        const selectors = _bulkSelectors?.length ? _bulkSelectors
                        : NbMain.activeSelector()  ? [NbMain.activeSelector()]
                        : null;
        if (!selectors) {
            body.innerHTML = '<p class="nb-dlg-empty">No note selected — open a note first.</p>';
            return;
        }
        const isBulk = selectors.length > 1;
        const count  = selectors.length;

        body.innerHTML = '<p class="nb-dlg-loading">Loading…</p>';
        const curNb = selectors[0].split(':')[0];
        const nbSel = await _buildNbPicker(curNb);
        let folderSel = await _buildFolderPicker(curNb);
        body.innerHTML = '';

        const destRow = _row('Into:', nbSel, folderSel);
        nbSel.addEventListener('change', async () => {
            const next = await _buildFolderPicker(nbSel.value);
            destRow.replaceChild(next, folderSel);
            folderSel = next;
        });

        const copyBtn = document.createElement('button');
        copyBtn.className = 'nb-tool-btn nb-btn-primary';
        copyBtn.textContent = isBulk ? `Copy ${count} items` : 'Copy';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'nb-tool-btn'; cancelBtn.textContent = 'Cancel';
        const btnRow = document.createElement('div');
        btnRow.className = 'nb-dlg-row nb-dlg-btn-row';
        btnRow.append(copyBtn, cancelBtn);
        cancelBtn.addEventListener('click', close);

        copyBtn.addEventListener('click', async () => {
            const destPrefix = folderSel.value ? `${nbSel.value}:${folderSel.value}/` : `${nbSel.value}:`;
            copyBtn.textContent = 'Copying…'; copyBtn.disabled = true;
            let failed = 0;
            const failReasons = [];
            for (const sel of selectors) {
                const filename = sel.split(':').slice(1).join(':').split('/').pop();
                const dest = destPrefix + filename;
                if (dest === sel) { failed++; failReasons.push('Source and destination are the same.'); continue; }
                try {
                    const resp = await fetch('/api/note/copy', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ selector: sel, dest }),
                    });
                    const rd = await resp.json();
                    if (!rd.success) {
                        failed++;
                        const msg = rd.stderr || '';
                        failReasons.push(msg.includes('already exists')
                            ? `A note named "${filename}" already exists at that destination.`
                            : (msg || 'unknown error'));
                    }
                } catch(e) { failed++; failReasons.push(String(e)); }
            }
            if (failed) {
                alert(failReasons.join('\n') || `${failed} copy${failed !== 1 ? 's' : ''} failed.`);
                copyBtn.textContent = isBulk ? `Copy ${count} items` : 'Copy';
                copyBtn.disabled = false;
            } else {
                close();
                NbNav.reexecute();
            }
        });

        body.append(destRow, btnRow);
        nbSel.focus();
    }

    // ── Rename tab ─────────────────────────────────────────────
    function _renderRename() {
        const body     = _body();
        const selector = NbMain.activeSelector();
        if (!selector) {
            body.innerHTML = '<p class="nb-dlg-empty">No note selected — open a note first.</p>';
            return;
        }

        // Pre-fill with the current filename stem (not the display title)
        const curFilename = NbMain.activeFilename() || '';
        const curStem     = curFilename.replace(/\.[^.]+$/, ''); // strip extension

        const nameInput = document.createElement('input');
        nameInput.type = 'text'; nameInput.className = 'nb-rename-input'; nameInput.style.flex = '1';
        nameInput.value = curStem;
        const nameRow = _row('Filename:', nameInput);

        const hint = document.createElement('p');
        hint.style.cssText = 'margin:2px 0 6px;font-size:11px;color:var(--text-dim)';
        hint.textContent = 'Renames the file and re-indexes it. Annotation renamed automatically.';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'nb-tool-btn nb-btn-primary'; saveBtn.textContent = 'Rename';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'nb-tool-btn'; cancelBtn.textContent = 'Cancel';
        const btnRow = document.createElement('div');
        btnRow.className = 'nb-dlg-row nb-dlg-btn-row';
        btnRow.append(saveBtn, cancelBtn);
        cancelBtn.addEventListener('click', close);

        async function commit() {
            const newName = nameInput.value.trim();
            if (!newName) { nameInput.focus(); return; }
            saveBtn.textContent = 'Renaming…'; saveBtn.disabled = true;
            try {
                const r = await fetch('/api/note/rename', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ selector, name: newName }),
                });
                const d = await r.json();
                if (d.success) {
                    NbMain.bustNoteCache(selector);
                    close();
                    NbNav.reexecute();
                } else {
                    alert('Rename failed: ' + (d.stderr || d.error || 'unknown'));
                    saveBtn.textContent = 'Rename'; saveBtn.disabled = false;
                }
            } catch(e) { saveBtn.textContent = 'Rename'; saveBtn.disabled = false; }
        }

        saveBtn.addEventListener('click', commit);
        nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); });

        body.append(nameRow, hint, btnRow);
        nameInput.focus(); nameInput.select();
    }

    // ── DOM helpers ────────────────────────────────────────────
    function _row(label, ...els) {
        const row = document.createElement('div');
        row.className = 'nb-dlg-row';
        const lbl = document.createElement('span');
        lbl.className = 'nb-dlg-lbl'; lbl.textContent = label;
        row.append(lbl, ...els);
        return row;
    }

    function isOpen() { return !!_panel(); }

    function refresh() {
        if (_tab === 'export' || _tab === 'move' || _tab === 'rename') _renderTab();
    }

    function init() {
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && _panel()) {
                e.preventDefault(); e.stopPropagation(); close();
            }
        }, true);
    }

    return { open, openFolder, close, isOpen, refresh, init, buildNbPicker: _buildNbPicker, buildFolderPicker: _buildFolderPicker };
})();


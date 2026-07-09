// nb-web ui-chrome.js — extracted from main.js (tier-4 modularization, 2026-07-08).
// NbUiChrome: panel menus (list/sort dropdowns), extras toggle, preview-toolbar
// menu + its dispatch targets (pin, fullscreen, undo, history, save-as-template),
// multi-select, keyboard navigation.
//
// Organized by what each group of functions actually does, not by the stale
// section headers they physically sat under in main.js (that file's "Extras
// toggle" section also held the entire preview-toolbar menu + actions, and its
// "Multi-select" section also held clearNote (stayed in kernel) and
// _doSaveAsTemplate). clearNote stayed in the kernel — only touches
// _activeSelector, already Tier-A public. _applySort/_applyNbSort also stayed —
// thin kernel-state mutators tightly coupled to kernel-only renderList/
// _getSortedNotes/_updateSortBtn/NbNotebooksPage, reached here via
// NbMain.applySort()/applyNbSort() instead of being moved.
//
// _selectedSelectors/_lastClickedIdx/_isFullscreen are fully privatized here —
// zero kernel code touches them. _pinnedSelectors/_undoBuffer/_pendingDeletes/
// _listDisplayMode/_sortMode/_nbSortMode/_kbPane stay kernel-declared (kernel
// code elsewhere reads or writes them too) and are reached via NbMain accessors.
//
// Loads immediately before main.js (order-sensitive — NbMain's return object
// holds bare NbUiChrome.* references, same rule as every other pre-main.js
// satellite; see index.html's load-order comment).

const NbUiChrome = (() => {
    const _t   = key => NbWeb.t(key);
    function _esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // Satellite-exclusive state (design doc confirmed zero outside-range usage).
    const _selectedSelectors = new Set(); // multi-select
    let _lastClickedIdx = -1;             // anchor for shift-click range
    let _isFullscreen    = false;

    // ── Panel menus ────────────────────────────────────────────────

    // Reusable floating dropdown.
    // items: array of { label, action, active?, disabled? } or the string 'sep'
    function _showDropdown(anchor, items) {
        const existing = document.querySelector('.nb-panel-dropdown');
        if (existing) {
            const wasThisAnchor = existing.dataset.anchorId === anchor.id;
            existing.remove();
            if (wasThisAnchor) return;   // toggle off
        }

        const drop = document.createElement('div');
        drop.className     = 'nb-panel-dropdown';
        drop.dataset.anchorId = anchor.id;

        items.forEach(item => {
            if (item === 'sep') {
                const s = document.createElement('div');
                s.className = 'nb-panel-dropdown-sep';
                drop.appendChild(s);
                return;
            }
            const btn = document.createElement('button');
            btn.className   = 'nb-panel-dropdown-item' + (item.active ? ' active' : '');
            btn.textContent = item.label;
            btn.disabled    = !!item.disabled;
            btn.addEventListener('click', () => { drop.remove(); item.action(); });
            drop.appendChild(btn);
        });

        // Initial position: below anchor, left-aligned
        const rect = anchor.getBoundingClientRect();
        drop.style.top  = (rect.bottom + 4) + 'px';
        drop.style.left = rect.left + 'px';
        document.body.appendChild(drop);

        // Nudge left if it overflows the right edge
        const dRect = drop.getBoundingClientRect();
        if (dRect.right > window.innerWidth - 8)
            drop.style.left = Math.max(4, rect.right - dRect.width) + 'px';

        // Dismiss on outside click
        function dismiss(e) {
            if (!drop.contains(e.target) && e.target !== anchor) {
                drop.remove();
                document.removeEventListener('click', dismiss, true);
            }
        }
        setTimeout(() => document.addEventListener('click', dismiss, true), 0);
    }

    function _bindListMenu() {
        const btn = document.getElementById('nb-list-menu-btn');
        if (!btn) return;
        btn.addEventListener('click', () => {
            if (NbNav.activeCmd === 'nb-notebooks') {
                _showDropdown(btn, [
                    // Placeholder for future notebook management actions
                    { label: 'Notebooks', active: false, action: () => {} },
                ]);
                return;
            }
            _showDropdown(btn, [
                { label: NbMain.getListDisplayMode() === 'filename' ? '🏷 Show titles' : '📄 Show filenames',
                  action: () => {
                      NbMain.setListDisplayMode(NbMain.getListDisplayMode() === 'filename' ? 'title' : 'filename');
                      NbMain.reRenderList();
                  }},
                'sep',
                { label: NbTheme.getMode() === 'light' ? '☾ Dark mode' : '☀ Light mode',
                  action: () => NbTheme.toggleMode() },
                'sep',
                { label: '📥 Import files…', action: () => NbDialog.open('import') },
                { label: '🔗 Link file…',   action: NbMain.doLinkFile },
            ]);
        });
    }

    function _bindSortBtn() {
        const btn = document.getElementById('nb-sort-btn');
        if (!btn) return;
        btn.addEventListener('click', () => {
            if (NbNav.activeCmd === 'nb-notebooks') {
                const nbSortMode = NbMain.getNbSortMode();
                _showDropdown(btn, [
                    { label: 'Active first', active: nbSortMode === 'active-first',
                      action: () => NbMain.applyNbSort('active-first') },
                    { label: 'A → Z',        active: nbSortMode === 'az',
                      action: () => NbMain.applyNbSort('az') },
                    { label: 'Z → A',        active: nbSortMode === 'za',
                      action: () => NbMain.applyNbSort('za') },
                    'sep',
                    { label: 'Most notes',   active: nbSortMode === 'most',
                      action: () => NbMain.applyNbSort('most') },
                    { label: 'Fewest notes', active: nbSortMode === 'fewest',
                      action: () => NbMain.applyNbSort('fewest') },
                ]);
                return;
            }
            const sortMode = NbMain.getSortMode();
            const _pluginSorts = NbWeb.getSortOptions(NbNav.notebook).map(s => ({
                label: s.label, active: sortMode === s.id, action: () => NbMain.applySort(s.id),
            }));
            _showDropdown(btn, [
                { label: 'Default',      active: sortMode === 'default', action: () => NbMain.applySort('default') },
                { label: 'A → Z',        active: sortMode === 'az',      action: () => NbMain.applySort('az') },
                { label: 'Z → A',        active: sortMode === 'za',      action: () => NbMain.applySort('za') },
                'sep',
                { label: 'Newest first', active: sortMode === 'newest',  action: () => NbMain.applySort('newest') },
                { label: 'Oldest first', active: sortMode === 'oldest',  action: () => NbMain.applySort('oldest') },
                ...(_pluginSorts.length ? ['sep', ..._pluginSorts] : []),
            ]);
        });
    }

    // ── Extras toggle (👁) ─────────────────────────────────────────────
    // #nb-extras-btn is flagged by djp as to-be-rewritten later -- moved
    // verbatim, not this tier's concern to polish.
    const _EXTRAS_KEY = 'nb-extras-hidden';

    function _bindExtrasToggle() {
        const btn     = document.getElementById('nb-extras-btn');
        const content = document.getElementById('nb-preview-content');
        const pane    = document.getElementById('nb-preview-pane');
        if (!btn || !content) return;

        const _apply = hidden => {
            content.classList.toggle('nb-extras-hidden', hidden);
            pane?.classList.toggle('nb-extras-hidden', hidden);
            btn.classList.toggle('nb-active', hidden);
            btn.textContent = hidden ? '○' : '◉';
            if (hidden) {
                const panel = document.getElementById('nb-changes-panel');
                if (panel) panel.hidden = true;
            }
        };
        _apply(localStorage.getItem(_EXTRAS_KEY) === '1');

        btn.addEventListener('click', () => {
            const hidden = !content.classList.contains('nb-extras-hidden');
            localStorage.setItem(_EXTRAS_KEY, hidden ? '1' : '0');
            _apply(hidden);
        });
    }

    const _FM_EMPTY_KEY = 'nb-fm-show-empty'; // must match kernel's _FM_EMPTY_KEY

    function _bindFmEmptyToggle() {
        const content = document.getElementById('nb-preview-content');
        if (!content) return;
        content.addEventListener('click', e => {
            const btn = e.target.closest('.nb-fm-empty-toggle');
            if (!btn) return;
            const block  = btn.closest('[data-fm-fallback]');
            if (!block) return;
            const show   = !block.classList.contains('nb-fm-show-empty');
            block.classList.toggle('nb-fm-show-empty', show);
            btn.textContent = show ? 'Hide empty' : 'Show empty';
            localStorage.setItem(_FM_EMPTY_KEY, show ? '1' : '0');
        });
    }

    // ── Preview toolbar menu & actions ──────────────────────────────
    // Access-gated (client-side display only, tier 4a -- see ui-access.js):
    // pin/unpin (group 'pin'), save-as-template (group 'template'), undo/
    // history restore (group 'edit'). No server-side enforcement yet.

    function _togglePin() {
        const sel = NbMain.activeSelector();
        if (!sel) return;
        const pinned = NbMain.pinnedSelectors();
        if (pinned.has(sel)) {
            pinned.delete(sel);
            const note = NbMain.activeNote();
            if (note?.meta?.pinned) {
                const newRaw = note.raw.replace(/^pinned:[ \t]*\S.*\n?/m, '');
                fetch('/api/note', { method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({selector: sel, content: newRaw}) });
                // Bypasses NbMain.saveNote entirely -- flagged design smell, not
                // fixed this pass (see claude:mainjs-split-design.md § Tier 4).
                NbMain.setActiveNote({...note, meta: {...note.meta, pinned: undefined}});
            }
        } else {
            pinned.add(sel);
        }
        localStorage.setItem('nb-pinned', JSON.stringify([...pinned]));
        document.getElementById('nb-pin-indicator').hidden = !pinned.has(sel);
        NbMain.reRenderList();
    }

    function _toggleFullscreen() {
        _isFullscreen = !_isFullscreen;
        document.body.classList.toggle('nb-fullscreen', _isFullscreen);
    }

    function _bindPreviewMenu() {
        const btn = document.getElementById('nb-preview-menu-btn');
        if (!btn) return;
        btn.addEventListener('click', () => {
            const sel     = NbMain.activeSelector();
            const hasNote = !!sel;
            _showDropdown(btn, [
                { label: NbMain.pinnedSelectors().has(sel) ? '📌 Unpin from list' : '📌 Pin to list top',
                  disabled: !hasNote || !NbUiAccess.can(btn, 'pin', 'use'),
                  action: _togglePin },
                { label: _isFullscreen ? '⛶ Exit full screen' : '⛶ Full screen',
                  disabled: !hasNote,
                  action: _toggleFullscreen },
                'sep',
                { label: 'Rename…',              disabled: !hasNote, action: () => NbDialog.open('rename') },
                { label: 'Move to…',             disabled: !hasNote, action: () => NbDialog.open('move') },
                { label: 'Copy to…',             disabled: !hasNote, action: () => NbDialog.open('copy') },
                { label: '📋 Save as template…', disabled: !hasNote || !NbUiAccess.can(btn, 'template', 'use'), action: _doSaveAsTemplate },
                'sep',
                { label: '↩ Undo last edit',
                  disabled: !hasNote || !NbMain.undoBuffer()[sel] || !NbUiAccess.can(btn, 'edit', 'use'),
                  action: _doUndoLastEdit },
                { label: '🕓 History…',   disabled: !hasNote || !NbUiAccess.can(btn, 'edit', 'use'), action: _showHistoryBar },
                'sep',
                { label: '⬇ Save as…', disabled: !hasNote, action: () => NbDialog.open('export') },
            ]);
        });
    }

    async function _doUndoLastEdit() {
        const sel = NbMain.activeSelector();
        const raw = NbMain.undoBuffer()[sel];
        if (!raw || !sel) return;
        if (!confirm('Restore note to its state before the last edit?')) return;
        const r = await fetch('/api/note', {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({selector: sel, content: raw}),
        });
        const d = await r.json();
        if (d.success) {
            NbMain.bustNoteCache(sel);
            delete NbMain.undoBuffer()[sel];
            NbNav.reexecute();
            NbMain.openNote(sel);
        } else {
            alert('Undo failed: ' + (d.stderr || 'unknown'));
        }
    }

    async function _showHistoryBar() {
        const activeSel = NbMain.activeSelector();
        if (!activeSel) return;
        document.getElementById('nb-history-bar')?.remove();

        const toolbar = document.getElementById('nb-preview-toolbar');
        const bar     = document.createElement('div');
        bar.id        = 'nb-history-bar';
        bar.className = 'nb-move-bar';

        const lbl = document.createElement('span');
        lbl.className   = 'nb-move-label';
        lbl.textContent = _t('label_history');

        const sel = document.createElement('select');
        sel.className = 'nb-scope-select';
        sel.style.colorScheme = 'dark';
        sel.style.flex = '1';
        sel.style.maxWidth = '480px';

        const loadingOpt = document.createElement('option');
        loadingOpt.textContent = _t('status_loading');
        sel.appendChild(loadingOpt);
        sel.disabled = true;

        const restoreBtn = document.createElement('button');
        restoreBtn.className   = 'nb-tool-btn nb-btn-primary';
        restoreBtn.textContent = _t('btn_restore');
        restoreBtn.disabled    = true;

        const cancelBtn = document.createElement('button');
        cancelBtn.className   = 'nb-tool-btn';
        cancelBtn.textContent = '✕';

        bar.append(lbl, sel, restoreBtn, cancelBtn);
        toolbar.parentNode.insertBefore(bar, toolbar.nextSibling);

        // Show a visual indicator in the ref area
        const refEl = document.getElementById('nb-preview-ref');
        const origRef = refEl?.textContent || '';

        function exitHistory() {
            bar.remove();
            if (refEl) refEl.textContent = origRef;
            NbMain.openNote(activeSel);
        }
        cancelBtn.addEventListener('click', exitHistory);

        // Fetch commit list
        let commits = [];
        try {
            const r = await fetch('/api/note/history?selector=' + encodeURIComponent(activeSel));
            const d = await r.json();
            commits = d.commits || [];
        } catch(e) {
            sel.options[0].textContent = _t('msg_err_history');
            return;
        }

        sel.innerHTML = '';
        if (!commits.length) {
            const o = document.createElement('option');
            o.textContent = _t('msg_no_history');
            sel.appendChild(o);
            return;
        }

        commits.forEach((c, i) => {
            const o = document.createElement('option');
            const subj = c.subject.replace(/^\[nb\]\s*/i, '');
            o.value       = c.hash;
            o.textContent = `${c.date}  ${c.hash.slice(0,7)}  ${subj}`;
            if (i === 0) o.selected = true;
            sel.appendChild(o);
        });
        sel.disabled = false;

        // Preview selected version immediately
        async function previewVersion(hash) {
            restoreBtn.disabled = true;
            if (refEl) refEl.textContent = hash.slice(0, 7);
            const content = document.getElementById('nb-preview-content');
            content.innerHTML = '<div style="padding:40px;color:var(--text-muted)">Loading version…</div>';
            try {
                const r = await fetch(`/api/note/version?selector=${encodeURIComponent(activeSel)}&hash=${hash}`);
                const d = await r.json();
                if (d.error) { content.innerHTML = `<div style="padding:40px;color:var(--red)">${_esc(d.error)}</div>`; return; }
                const html = NbMain.parseMarkdownStatic(d.body || '');
                content.innerHTML = `<div class="nb-prose">${html}</div>`;
                NbMain.resolveWikilinks(content);
                restoreBtn.disabled = !NbUiAccess.can(restoreBtn, 'edit', 'use');
            } catch(e) {
                content.innerHTML = `<div style="padding:40px;color:var(--red)">Error: ${_esc(String(e))}</div>`;
            }
        }

        sel.addEventListener('change', () => previewVersion(sel.value));
        previewVersion(commits[0].hash);

        restoreBtn.addEventListener('click', async () => {
            const hash = sel.value;
            if (!hash) return;
            const subj = sel.options[sel.selectedIndex]?.textContent || hash;
            if (!confirm(`Restore note to version: ${subj}?`)) return;
            restoreBtn.textContent = _t('btn_restoring'); restoreBtn.disabled = true;
            try {
                const r = await fetch('/api/note/restore', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({selector: activeSel, hash}),
                });
                const d = await r.json();
                if (d.success) {
                    delete NbMain.undoBuffer()[activeSel];
                    exitHistory();
                    NbNav.reexecute();
                } else {
                    alert('Restore failed: ' + (d.error || 'unknown'));
                    restoreBtn.textContent = _t('btn_restore'); restoreBtn.disabled = false;
                }
            } catch(e) {
                alert('Restore error: ' + e);
                restoreBtn.textContent = _t('btn_restore'); restoreBtn.disabled = false;
            }
        });
    }

    function _exportFormats(type) {
        const mdTypes = ['note', 'todo', 'contact', 'journal', 'template'];
        if (mdTypes.includes(type)) return [
            { value: 'md',    label: 'Markdown (.md)' },
            { value: 'html',  label: 'HTML (.html)' },
            { value: 'docx',  label: 'Word (.docx)' },
            { value: 'odt',   label: 'ODT (.odt)' },
            { value: 'print', label: 'Print / PDF…' },
        ];
        if (type === 'sheet') return [
            { value: 'raw',   label: 'CSV (.csv)' },
            { value: 'print', label: 'Print spreadsheet…' },
        ];
        if (type === 'html') return [
            { value: 'raw',   label: 'HTML (.html)' },
            { value: 'print', label: 'Print / PDF…' },
        ];
        return [
            { value: 'raw',   label: 'Download original' },
            { value: 'print', label: 'Print / PDF…' },
        ];
    }

    function _doPrint() {
        const content = document.getElementById('nb-preview-content')?.innerHTML || '';
        const title   = document.getElementById('nb-preview-title')?.textContent  || '';
        const win = window.open('', '_blank');
        win.document.write(`<!DOCTYPE html><html><head>
<meta charset="UTF-8"><title>${_esc(title)}</title>
<style>
  body { font-family: Georgia, serif; max-width: 800px; margin: 2cm auto; color: #000; font-size: 12pt; }
  h1,h2,h3 { margin-top: 1.4em; }
  pre, code { font-family: monospace; font-size: 0.88em; background: #f4f4f4; padding: 2px 4px; border-radius: 3px; }
  pre { padding: 10px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 4px 8px; text-align: left; }
  img { max-width: 100%; }
  a { color: #2255aa; }
  @media print { body { margin: 0; } }
</style></head><body>${content}</body></html>`);
        win.document.close();
        win.focus();
        setTimeout(() => win.print(), 400);
    }

    async function _doSaveAsTemplate() {
        if (!NbMain.activeSelector()) return;
        document.getElementById('nb-tmpl-save-bar')?.remove();

        const toolbar = document.getElementById('nb-preview-toolbar');
        const bar = document.createElement('div');
        bar.id = 'nb-tmpl-save-bar';
        bar.className = 'nb-move-bar';

        const lbl = document.createElement('span');
        lbl.className = 'nb-move-label';
        lbl.textContent = 'Save as template:';

        const typeSel = document.createElement('select');
        typeSel.className = 'nb-scope-select';
        [['regular', 'Regular'], ['annotation', 'Annotation']].forEach(([v, t]) => {
            const opt = document.createElement('option');
            opt.value = v; opt.textContent = t;
            typeSel.appendChild(opt);
        });

        const dynWrap = document.createElement('span');
        dynWrap.style.cssText = 'display:flex;gap:4px;align-items:center;flex:1;min-width:0';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'nb-tool-btn nb-btn-primary';
        saveBtn.textContent = 'Save';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'nb-tool-btn';
        cancelBtn.textContent = 'Cancel';

        bar.append(lbl, typeSel, dynWrap, saveBtn, cancelBtn);
        toolbar.parentNode.insertBefore(bar, toolbar.nextSibling);

        const curNb     = NbMain.activeSelector().includes(':') ? NbMain.activeSelector().split(':')[0] : 'home';
        const titleText = document.getElementById('nb-preview-title')?.textContent || '';

        let _mode = 'regular';
        let _nameInput = null, _scopeSel = null, _nbSel = null, _folderSel = null;

        function buildRegular() {
            dynWrap.innerHTML = '';
            const nameInput = document.createElement('input');
            nameInput.type = 'text'; nameInput.className = 'nb-rename-input';
            nameInput.placeholder = 'template-name'; nameInput.style.width = '12em';
            nameInput.value = titleText.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
            const scopeSel = document.createElement('select');
            scopeSel.className = 'nb-scope-select';
            [['local', 'Notebook'], ['global', 'Global']].forEach(([v, t]) => {
                const opt = document.createElement('option');
                opt.value = v; opt.textContent = t;
                scopeSel.appendChild(opt);
            });
            dynWrap.append(nameInput, scopeSel);
            _nameInput = nameInput; _scopeSel = scopeSel; _nbSel = null; _folderSel = null;
            nameInput.addEventListener('keydown', e => {
                if (e.key === 'Enter')  { e.preventDefault(); commit(); }
                if (e.key === 'Escape') bar.remove();
            });
            nameInput.select(); nameInput.focus();
        }

        async function buildAnnotation() {
            dynWrap.innerHTML = '';
            const hint = document.createElement('span');
            hint.className = 'nb-move-label';
            hint.style.cssText = 'font-size:0.8em;opacity:0.55;white-space:nowrap';
            hint.textContent = '.template-annotation.md →';
            dynWrap.appendChild(hint);
            saveBtn.disabled = true;
            try {
                const nbSel = await NbDialog.buildNbPicker(curNb);
                let folderSel = await NbDialog.buildFolderPicker(curNb);
                nbSel.addEventListener('change', async () => {
                    const next = await NbDialog.buildFolderPicker(nbSel.value);
                    folderSel.replaceWith(next);
                    folderSel = next; _folderSel = next;
                });
                dynWrap.append(nbSel, folderSel);
                _nameInput = null; _scopeSel = null; _nbSel = nbSel; _folderSel = folderSel;
                saveBtn.disabled = false;
                nbSel.focus();
            } catch(e) {
                hint.textContent = '✗ Failed to load notebooks: ' + e.message;
                hint.style.color = 'var(--red)';
            }
        }

        async function commit() {
            saveBtn.textContent = 'Saving…'; saveBtn.disabled = true;
            try {
                const noteResp = await fetch('/api/note?selector=' + encodeURIComponent(NbMain.activeSelector()));
                const noteData = await noteResp.json();
                const content  = noteData.raw ?? noteData.body ?? '';
                let payload;
                if (_mode === 'annotation') {
                    payload = { scope: 'annotation', notebook: _nbSel?.value || curNb,
                                folder: _folderSel?.value || '', content };
                } else {
                    const name = _nameInput?.value.trim();
                    if (!name) { _nameInput?.focus(); saveBtn.textContent = 'Save'; saveBtn.disabled = false; return; }
                    payload = { name, content, scope: _scopeSel.value, notebook: curNb };
                }
                const resp = await fetch('/api/templates', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(payload),
                });
                const rd = await resp.json();
                if (rd.success) {
                    bar.remove();
                    const ref = document.getElementById('nb-preview-ref');
                    if (ref) { const orig = ref.textContent; ref.textContent = '✓ saved'; setTimeout(() => ref.textContent = orig, 2000); }
                } else {
                    alert('Save failed: ' + (rd.error || 'unknown'));
                    saveBtn.textContent = 'Save'; saveBtn.disabled = false;
                }
            } catch(e) { alert('Save error: ' + e); saveBtn.textContent = 'Save'; saveBtn.disabled = false; }
        }

        typeSel.addEventListener('change', async () => {
            _mode = typeSel.value;
            if (_mode === 'annotation') await buildAnnotation();
            else buildRegular();
        });

        cancelBtn.addEventListener('click', () => bar.remove());
        saveBtn.addEventListener('click', commit);
        buildRegular();
    }

    // ── Multi-select ───────────────────────────────────────────────

    function _clearSelection() {
        if (!_selectedSelectors.size) return;
        _selectedSelectors.clear();
        _lastClickedIdx = -1;
        document.querySelectorAll('#nb-list .nb-list-item.selected')
            .forEach(el => el.classList.remove('selected'));
        const actions   = document.getElementById('nb-preview-actions');
        const activeSel = NbMain.activeSelector();
        if (actions) actions.hidden = !activeSel;
        if (activeSel) NbMain.openNote(activeSel, false);
        else NbMain.clearNote();
        NbNav.updateOutputBar?.();
    }

    function _toggleSelection(selector, idx) {
        if (_selectedSelectors.has(selector)) _selectedSelectors.delete(selector);
        else _selectedSelectors.add(selector);
        _lastClickedIdx = idx;
        _updateSelectionUI();
    }

    function _rangeSelection(toIdx, notes) {
        const from = _lastClickedIdx < 0 ? toIdx : Math.min(_lastClickedIdx, toIdx);
        const to   = _lastClickedIdx < 0 ? toIdx : Math.max(_lastClickedIdx, toIdx);
        for (let i = from; i <= to; i++) {
            if (notes[i]?.type !== 'folder') _selectedSelectors.add(notes[i].selector);
        }
        _updateSelectionUI();
    }

    function _updateSelectionUI() {
        document.querySelectorAll('#nb-list .nb-list-item').forEach(el =>
            el.classList.toggle('selected', _selectedSelectors.has(el.dataset.selector)));
        if (_selectedSelectors.size > 0) _renderMultiSelectView();
        else {
            document.getElementById('nb-preview-actions')?.removeAttribute('hidden');
            const activeSel = NbMain.activeSelector();
            if (activeSel) NbMain.openNote(activeSel, false);
        }
        NbNav.updateOutputBar?.();
    }

    function _renderMultiSelectView() {
        const toolbar = document.getElementById('nb-preview-toolbar');
        const content = document.getElementById('nb-preview-content');
        const count   = _selectedSelectors.size;

        toolbar.hidden = false;
        document.getElementById('nb-preview-title').textContent =
            `${count} item${count !== 1 ? 's' : ''} selected`;
        document.getElementById('nb-pin-indicator').hidden = true;
        document.getElementById('nb-preview-actions').hidden = true;

        const wrap = document.createElement('div');
        wrap.className = 'nb-multisel-wrap';

        const actRow = document.createElement('div');
        actRow.className = 'nb-multisel-actions';
        const moveBtn = document.createElement('button');
        moveBtn.className = 'nb-tool-btn';
        moveBtn.textContent = `Move ${count}`;
        moveBtn.addEventListener('click', () => NbDialog.open('move', [..._selectedSelectors]));
        const exportBtn = document.createElement('button');
        exportBtn.className = 'nb-tool-btn';
        exportBtn.textContent = `Export ${count}`;
        exportBtn.addEventListener('click', () => NbDialog.open('export', [..._selectedSelectors]));
        const delBtn = document.createElement('button');
        delBtn.className = 'nb-tool-btn nb-btn-danger';
        delBtn.textContent = `Delete ${count}`;
        delBtn.disabled = !NbUiAccess.can(delBtn, 'delete', 'use');
        const clrBtn = document.createElement('button');
        clrBtn.className = 'nb-tool-btn'; clrBtn.textContent = '✕ Clear';
        actRow.append(moveBtn, exportBtn, delBtn, clrBtn);
        delBtn.addEventListener('click', _bulkDelete);
        clrBtn.addEventListener('click', _clearSelection);
        wrap.appendChild(actRow);

        [..._selectedSelectors].forEach(sel => {
            const note = NbMain.getLastNotes().find(n => n.selector === sel);
            const row  = document.createElement('div');
            row.className = 'nb-multisel-item';
            const rmBtn = document.createElement('button');
            rmBtn.className = 'nb-multisel-rm'; rmBtn.textContent = '×';
            rmBtn.title = 'Remove from selection';
            rmBtn.addEventListener('click', () => { _selectedSelectors.delete(sel); _updateSelectionUI(); });
            const titleEl = document.createElement('span');
            titleEl.className = 'nb-multisel-title';
            titleEl.textContent = note?.title || note?.filename || sel;
            const selEl = document.createElement('span');
            selEl.className = 'nb-multisel-sel'; selEl.textContent = sel;
            row.append(rmBtn, titleEl, selEl);
            wrap.appendChild(row);
        });

        content.hidden = false;
        content.innerHTML = '';
        content.appendChild(wrap);
    }

    async function _bulkDelete() {
        const count = _selectedSelectors.size;
        if (!confirm(`Delete ${count} item${count !== 1 ? 's' : ''}? This cannot be undone.`)) return;
        const selectors = [..._selectedSelectors];

        // Clear selection state without calling openNote (active note may be one being deleted)
        _selectedSelectors.clear();
        _lastClickedIdx = -1;
        document.querySelectorAll('#nb-list .nb-list-item.selected').forEach(el => el.classList.remove('selected'));
        NbMain.clearNote('Deleting…');
        NbNav.updateOutputBar?.();

        let failed = 0;
        for (const sel of selectors) {
            try {
                const r = await fetch('/api/note?selector=' + encodeURIComponent(sel), { method: 'DELETE' });
                const d = await r.json();
                if (!d.success) failed++;
                else {
                    NbMain.bustNoteCache(sel);
                    NbMain.pendingDeletes().add(sel);
                    // Remove from DOM immediately — don't wait for reexecute
                    document.querySelector(`#nb-list .nb-list-item[data-selector="${CSS.escape(sel)}"]`)?.remove();
                }
            } catch { failed++; }
        }
        if (failed) alert(`${failed} deletion${failed !== 1 ? 's' : ''} failed.`);
        NbMain.clearNote(failed === 0 ? `${count} items deleted.` : 'Some deletions failed.');
        NbNav.reexecute();
    }

    // ── Keyboard navigation ────────────────────────────────────────

    function _bindKeyboard() {
        const previewContent = document.getElementById('nb-preview-content');
        NbMain.setKbPane('list');

        // Mouse clicks transfer keyboard focus
        document.getElementById('nb-list').addEventListener('mousedown',
            () => NbMain.setKbPane('list'));
        previewContent.addEventListener('mousedown',
            () => NbMain.setKbPane('preview'));

        function _visibleItems() {
            return [...document.querySelectorAll('#nb-list .nb-list-item')];
        }

        function _activeIdx(items) {
            return items.findIndex(el => el.classList.contains('active'));
        }

        function _selectItem(item) {
            if (!item) return;
            item.scrollIntoView({ block: 'nearest' });
            // Update visual selection immediately
            _visibleItems().forEach(el => el.classList.remove('active'));
            item.classList.add('active');
            // Load preview (or drill folder)
            if (item.dataset.type === 'folder') {
                // folders: don't auto-drill; stay in list, let → or Enter drill in
            } else if (item.dataset.selector) {
                NbMain.openNote(item.dataset.selector);
            }
        }

        document.getElementById('nb-cmd-bar')?.addEventListener('click', () => {
            if (_isFullscreen) _toggleFullscreen();
        });

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && _isFullscreen) { _toggleFullscreen(); return; }

            // Ctrl+Enter: save while editing (before input guard)
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && NbMain.isEditing()) {
                e.preventDefault();
                document.getElementById('nb-save-btn')?.click();
                return;
            }

            // Escape from inputs: blur, click Cancel if visible, park focus on logo
            if (e.key === 'Escape' && ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) {
                e.preventDefault();
                document.activeElement.blur();
                const cancelBtn = [...document.querySelectorAll('button')].find(
                    b => b.textContent.trim() === 'Cancel' && !b.hidden && b.offsetParent !== null
                );
                if (cancelBtn) { cancelBtn.click(); return; }
                document.getElementById('nb-logo-btn')?.focus();
                return;
            }

            // Let inputs handle their own keys
            const tag = document.activeElement?.tagName;
            if (['INPUT','TEXTAREA','SELECT'].includes(tag)) return;
            if (e.ctrlKey || e.metaKey) return;

            const items = _visibleItems();
            const idx   = _activeIdx(items);
            const PAGE  = 8;

            if (NbMain.getKbPane() === 'list') {
                switch (e.key) {
                    case 'ArrowUp': {
                        e.preventDefault();
                        _selectItem(items[idx <= 0 ? 0 : idx - 1]);
                        break;
                    }
                    case 'ArrowDown': {
                        e.preventDefault();
                        _selectItem(items[idx < 0 ? 0 : Math.min(items.length - 1, idx + 1)]);
                        break;
                    }
                    case 'PageUp': {
                        e.preventDefault();
                        _selectItem(items[Math.max(0, idx - PAGE)]);
                        break;
                    }
                    case 'PageDown': {
                        e.preventDefault();
                        _selectItem(items[Math.min(items.length - 1, Math.max(0, idx) + PAGE)]);
                        break;
                    }
                    case 'ArrowRight':
                    case 'Enter': {
                        e.preventDefault();
                        const cur = items[idx];
                        if (cur?.dataset.type === 'folder') {
                            cur.click();    // drill into folder
                        } else {
                            NbMain.setKbPane('preview');
                        }
                        break;
                    }
                    case 'ArrowLeft': {
                        e.preventDefault();
                        if (NbNav.folder) NbNav.goUpFolder();
                        break;
                    }
                }
            } else {
                // Preview pane — scroll with arrows, ← returns to list
                const step = 72;
                switch (e.key) {
                    case 'ArrowUp':   e.preventDefault(); previewContent.scrollBy(0, -step); break;
                    case 'ArrowDown': e.preventDefault(); previewContent.scrollBy(0,  step); break;
                    case 'PageUp':    e.preventDefault(); previewContent.scrollBy(0, -previewContent.clientHeight * 0.85); break;
                    case 'PageDown':  e.preventDefault(); previewContent.scrollBy(0,  previewContent.clientHeight * 0.85); break;
                    case 'Home':      e.preventDefault(); previewContent.scrollTo(0, 0); break;
                    case 'End':       e.preventDefault(); previewContent.scrollTo(0, previewContent.scrollHeight); break;
                    case 'ArrowLeft': e.preventDefault(); NbMain.setKbPane('list'); break;
                    case 'Enter': {
                        const doneBtn = document.getElementById('nb-done-btn');
                        if (doneBtn && !doneBtn.hidden) { e.preventDefault(); doneBtn.click(); }
                        break;
                    }
                }
            }

            // Global shortcuts — skip while editing or when an inline bar has focus
            if (NbMain.isEditing()) return;
            if (e.target.closest('#nb-done-bar, .nb-move-bar, #nb-action-panel')) return;
            switch (e.key) {
                case 'Escape': {
                    e.preventDefault();
                    if (_selectedSelectors.size) { _clearSelection(); break; }
                    const menu = document.getElementById('nb-side-menu');
                    if (menu?.classList.contains('open')) { document.getElementById('nb-logo-btn')?.click(); break; }
                    const cancelBtn = [...document.querySelectorAll('button')].find(
                        b => b.textContent.trim() === 'Cancel' && !b.hidden && b.offsetParent !== null
                    );
                    if (cancelBtn) { cancelBtn.click(); break; }
                    document.getElementById('nb-logo-btn')?.focus();
                    break;
                }
                case 'Backspace': {
                    e.preventDefault();
                    document.getElementById('nb-back-btn')?.click();
                    break;
                }
                case 'Delete': {
                    if (NbMain.getKbPane() === 'list' && NbMain.activeSelector()) { e.preventDefault(); NbMain.deleteNote(); }
                    break;
                }
                case 'a': e.preventDefault(); NbNav.activateCmd('add');       break;
                case 'l': e.preventDefault(); NbNav.activateCmd('list');      break;
                case 'c': e.preventDefault(); document.getElementById('nb-cal-icon')?.click(); break;
                case 'C': e.preventDefault(); NbNav.activateCmd('contacts');  break;
                case 's':
                case '/': e.preventDefault(); document.getElementById('nb-search')?.focus();   break;
                case '#': e.preventDefault(); document.getElementById('nb-tags')?.focus();      break;
                case 'n': e.preventDefault(); document.querySelector('.nb-scope-select')?.focus(); break;
                case 'p': e.preventDefault(); NbMain.setKbPane('preview');          break;
                case 'e': if (NbMain.activeSelector()) { e.preventDefault(); NbMain.openEditor(); } break;
                case 'T': e.preventDefault(); NbTerminal.open();               break;
                case ',': e.preventDefault(); NbTerminal.openSettings();       break;
                case '.': e.preventDefault(); document.getElementById('nb-extras-btn')?.click(); break;
            }
        });
    }

    // ── Init & public surface ───────────────────────────────────────

    function init() {
        _bindListMenu();
        _bindSortBtn();
        _bindPreviewMenu();
        _bindExtrasToggle();
        _bindFmEmptyToggle();
        _bindKeyboard();
    }

    return {
        init,
        togglePin: _togglePin,
        exportFormats: _exportFormats,
        doPrint: _doPrint,
        clearSelection: _clearSelection,
        toggleSelection: _toggleSelection,
        rangeSelection: _rangeSelection,
        setSelectionAnchor: idx => { _lastClickedIdx = idx; },
        deselect: sel => { _selectedSelectors.delete(sel); _updateSelectionUI(); },
        selectedSelectors: () => _selectedSelectors,
    };
})();

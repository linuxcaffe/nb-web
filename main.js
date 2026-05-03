// nb-web main.js — list, preview, editor, today, add, sync

const NbMain = (() => {
    let _activeSelector = null;
    let _editing        = false;
    let _searchTimer    = null;
    let _todayInfo      = null;
    let _lastNotes      = [];       // original load order, for client-side sort
    let _sortMode       = 'default';
    let _foldersFirst   = false;
    let _pinned         = false;
    const _history      = [];       // back-stack
    const _future       = [];       // forward-stack (cleared on any new navigation)

    // ── Boot ───────────────────────────────────────────────────────

    function init() {
        NbNav.init();
        _bindSearch();
        _bindSync();
        _bindAppend();
        _bindPreviewActions();
        _bindListMenu();
        _bindPreviewMenu();
        _bindKeyboard();
        initDragHandle();
        loadNotes();
    }

    // ── Notes list ─────────────────────────────────────────────────

    async function loadNotes(typeFilter) {
        const nb     = NbNav.notebook;
        const folder = NbNav.folder;
        const params = new URLSearchParams({ notebook: nb });
        if (folder) params.set('folder', folder);

        try {
            const r = await fetch('/api/notes?' + params);
            const d = await r.json();
            let notes = d.notes || [];
            if (typeFilter) notes = notes.filter(n => n.type === typeFilter.replace('--type ', ''));
            renderList(notes);
        } catch (e) {
            console.error('loadNotes:', e);
        }
    }

    async function search(query) {
        if (!query.trim()) { loadNotes(); return; }
        const nb     = NbNav.notebook;
        const params = new URLSearchParams({ notebook: nb, q: query });
        try {
            const r = await fetch('/api/notes?' + params);
            const d = await r.json();
            renderList(d.notes || []);
            _setFilterBar(query);
        } catch (e) {
            console.error('search:', e);
        }
    }

    function _setFilterBar(_query) {
        // Output bar is now managed by nav.js / NbNav; no-op here
    }

    function _getSortedNotes(notes) {
        let result = [...notes];
        const byTitle = n => (n.title || n.filename || '').toLowerCase();
        if (_sortMode === 'az')     result.sort((a, b) => byTitle(a).localeCompare(byTitle(b)));
        if (_sortMode === 'za')     result.sort((a, b) => byTitle(b).localeCompare(byTitle(a)));
        if (_sortMode === 'newest') result.sort((a, b) => (b.id || 0) - (a.id || 0));
        if (_sortMode === 'oldest') result.sort((a, b) => (a.id || 0) - (b.id || 0));
        if (_foldersFirst) {
            const folders = result.filter(n => n.type === 'folder');
            const rest    = result.filter(n => n.type !== 'folder');
            result = [...folders, ...rest];
        }
        return result;
    }

    function _updateSortBtn() {
        const btn = document.getElementById('nb-list-menu-btn');
        if (btn) btn.classList.toggle('nb-sort-active', _sortMode !== 'default' || _foldersFirst);
    }

    function resetSort() {
        _sortMode     = 'default';
        _foldersFirst = false;
        _updateSortBtn();
        // Caller will trigger loadNotes(), which re-applies the (now default) sort
    }

    function renderList(notes, fromSort = false) {
        if (!fromSort) {
            _lastNotes = notes;
            notes = _getSortedNotes(notes);   // re-apply current sort to new data
        }
        const ul      = document.getElementById('nb-list');
        const empty   = document.getElementById('nb-list-empty');
        const countEl = document.getElementById('nb-count');
        ul.innerHTML  = '';

        if (!notes.length) {
            empty.hidden = false;
            countEl.textContent = '0 items';
            return;
        }
        empty.hidden = true;
        countEl.textContent = `${notes.length} item${notes.length !== 1 ? 's' : ''}`;

        // type breakdown
        const types = {};
        notes.forEach(n => { types[n.type] = (types[n.type] || 0) + 1; });
        const icons = {note:'📝', bookmark:'🔖', todo:'✔️', folder:'📂', image:'🌄'};
        const breakdown = Object.entries(types)
            .filter(([t]) => t in icons && t !== 'note')
            .map(([t,c]) => `${icons[t]}${c}`)
            .join('  ');
        document.getElementById('nb-type-breakdown').textContent = breakdown;

        notes.forEach(note => {
            const li = document.createElement('li');
            li.className = 'nb-list-item' + (note.type === 'folder' ? ' folder' : '') +
                           (note.selector === _activeSelector ? ' active' : '');
            li.setAttribute('role', 'option');
            li.dataset.selector = note.selector;
            li.dataset.type     = note.type;

            const icon = document.createElement('span');
            icon.className = 'nb-list-icon';
            icon.textContent = note.indicator || '';

            const body = document.createElement('div');
            body.className = 'nb-list-body';

            const titleRow = document.createElement('div');
            titleRow.className = 'nb-list-title-row';

            const title = document.createElement('span');
            title.className = 'nb-list-title';
            title.textContent = note.title || note.filename;
            titleRow.appendChild(title);

            if (note.id) {
                const idEl = document.createElement('span');
                idEl.className = 'nb-list-id';
                idEl.textContent = note.id;
                idEl.title = note.selector;
                titleRow.appendChild(idEl);
            }
            body.appendChild(titleRow);

            if (note.excerpt) {
                const exc = document.createElement('div');
                exc.className = 'nb-list-excerpt';
                exc.textContent = note.excerpt;
                body.appendChild(exc);
            }

            li.appendChild(icon);
            li.appendChild(body);

            if (note.type === 'folder') {
                li.addEventListener('click', () => NbNav.drillFolder(note.filename));
            } else {
                li.addEventListener('click', () => openNote(note.selector));
            }

            ul.appendChild(li);
        });
    }

    // ── Open / preview note ────────────────────────────────────────

    async function openNote(selector, pushHistory = true) {
        // Always update list visual selection — shows where cursor is even when pinned
        document.querySelectorAll('.nb-list-item').forEach(el => {
            el.classList.toggle('active', el.dataset.selector === selector);
        });

        // When pinned, freeze the preview — list browsing doesn't change the note shown
        if (_pinned) return;

        if (pushHistory && _activeSelector && _activeSelector !== selector) {
            _history.push(_activeSelector);
            _future.length = 0;   // new navigation invalidates forward history
        }
        _activeSelector = selector;
        _updateNavBtns();

        // Show toolbar
        const toolbar = document.getElementById('nb-preview-toolbar');
        toolbar.hidden = false;
        document.getElementById('nb-preview-title').textContent = selector.split(':').pop();

        // Show spinner while loading
        const content = document.getElementById('nb-preview-content');
        content.innerHTML = '<div style="padding:40px;color:var(--text-muted)">Loading…</div>';

        try {
            const r = await fetch('/api/note?selector=' + encodeURIComponent(selector));
            if (!r.ok) { content.innerHTML = '<div style="padding:40px;color:var(--red)">Failed to load note.</div>'; return; }
            const d = await r.json();
            renderPreview(d);
        } catch (e) {
            content.innerHTML = `<div style="padding:40px;color:var(--red)">Error: ${_esc(String(e))}</div>`;
        }
    }

    function renderPreview(note) {
        const content = document.getElementById('nb-preview-content');
        document.getElementById('nb-preview-title').textContent = note.title || note.filename;

        const ref = document.getElementById('nb-preview-ref');
        if (ref) ref.textContent = note.notebook ? `${note.notebook}:${note.id ?? '?'}` : '';

        // Cancel any active editing
        _editing = false;
        document.getElementById('nb-editor-wrap').hidden = true;
        document.getElementById('nb-preview-content').hidden = false;

        let html = '';

        if (note.type === 'bookmark') {
            html = _renderBookmark(note);
        } else if (note.type === 'todo') {
            html = _renderTodo(note);
        } else if (['note','file',''].includes(note.type)) {
            html = _renderMarkdown(note.body);
        } else {
            html = `<pre class="nb-rendered" style="padding:0">${_esc(note.raw)}</pre>`;
        }

        content.innerHTML = `<div class="nb-rendered">${html}</div>`;

        // Wire wiki-links and tag-links
        content.querySelectorAll('.nb-wiki-link').forEach(el => {
            el.addEventListener('click', () => openNote(el.dataset.selector || el.textContent));
        });
        content.querySelectorAll('.nb-tag-link').forEach(el => {
            el.addEventListener('click', () => {
                const tag = el.textContent;
                document.getElementById('nb-search').value = tag;
                search(tag);
            });
        });

        // Todo checkboxes
        content.querySelectorAll('.nb-todo-check').forEach(cb => {
            cb.addEventListener('change', () => _toggleTask(note.selector, cb.dataset.task, cb.checked));
        });
    }

    function _renderMarkdown(body) {
        if (typeof marked === 'undefined') return `<pre>${_esc(body)}</pre>`;
        // Pre-process wiki-links and hashtags before marked
        let processed = body
            .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) =>
                `<span class="nb-wiki-link" data-selector="${_esc(target)}">${_esc(label || target)}</span>`)
            .replace(/(^|\s)(#[\w/-]+)/g, (_, pre, tag) =>
                `${pre}<span class="nb-tag-link">${_esc(tag)}</span>`);
        return marked.parse(processed);
    }

    function _renderBookmark(note) {
        const urlMatch = note.raw.match(/<(https?:\/\/[^>]+)>/);
        const url = urlMatch ? urlMatch[1] : '';
        return `
            <div style="margin-bottom:16px">
              <h1>${_esc(note.title)}</h1>
              ${url ? `<a href="${_esc(url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-size:13px">${_esc(url)}</a>` : ''}
            </div>
            ${_renderMarkdown(note.body)}`;
    }

    function _renderTodo(note) {
        // Replace markdown checkboxes with real ones
        let taskNum = 0;
        const html = _renderMarkdown(note.body.replace(/- \[([ x])\] (.+)/g, (_, state, text) => {
            const n   = ++taskNum;
            const chk = state === 'x' ? 'checked' : '';
            return `<li><label><input type="checkbox" class="nb-todo-check" data-task="${n}" ${chk}> ${_esc(text)}</label></li>`;
        }));
        return html;
    }

    async function _toggleTask(selector, taskNum, done) {
        await fetch('/api/todo', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({selector, done, task: Number(taskNum)}),
        });
    }

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
            _showDropdown(btn, [
                { label: '📂 Folders first', active: _foldersFirst,
                  action: () => { _foldersFirst = !_foldersFirst; renderList(_getSortedNotes(_lastNotes), true); _updateSortBtn(); } },
                'sep',
                { label: 'Sort: Default', active: _sortMode === 'default',
                  action: () => _applySort('default') },
                { label: 'Sort: A → Z',   active: _sortMode === 'az',
                  action: () => _applySort('az') },
                { label: 'Sort: Z → A',   active: _sortMode === 'za',
                  action: () => _applySort('za') },
                'sep',
                { label: 'Newest first',  active: _sortMode === 'newest',
                  action: () => _applySort('newest') },
                { label: 'Oldest first',  active: _sortMode === 'oldest',
                  action: () => _applySort('oldest') },
            ]);
        });
    }

    function _applySort(mode) {
        _sortMode = mode;
        renderList(_getSortedNotes(_lastNotes), true);
        _updateSortBtn();
    }

    function _togglePin() {
        _pinned = !_pinned;
        const indicator = document.getElementById('nb-pin-indicator');
        const toolbar   = document.getElementById('nb-preview-toolbar');
        if (indicator) indicator.hidden = !_pinned;
        if (toolbar)   toolbar.classList.toggle('nb-pinned', _pinned);
    }

    function _bindPreviewMenu() {
        const btn = document.getElementById('nb-preview-menu-btn');
        if (!btn) return;
        btn.addEventListener('click', () => {
            const hasNote = !!_activeSelector;
            _showDropdown(btn, [
                { label: _pinned ? '📌 Unpin preview' : '📌 Pin preview',
                  disabled: !hasNote,
                  action: _togglePin },
                'sep',
                { label: 'Rename…',  disabled: !hasNote, action: _doRename },
                { label: 'Move to…', disabled: !hasNote, action: _doMove },
            ]);
        });
    }

    function _doRename() {
        if (!_activeSelector) return;
        const titleEl  = document.getElementById('nb-preview-title');
        const origText = titleEl.textContent;

        const input = document.createElement('input');
        input.type      = 'text';
        input.className = 'nb-rename-input';
        input.value     = origText;
        titleEl.style.display = 'none';
        titleEl.parentNode.insertBefore(input, titleEl.nextSibling);
        input.select();

        function cancel() { input.remove(); titleEl.style.display = ''; }

        async function commit() {
            const newName = input.value.trim();
            input.remove(); titleEl.style.display = '';
            if (!newName || newName === origText) return;
            try {
                const r = await fetch('/api/note/rename', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ selector: _activeSelector, name: newName }),
                });
                const d = await r.json();
                if (d.success) { titleEl.textContent = newName; loadNotes(); }
                else alert('Rename failed: ' + (d.stderr || 'unknown'));
            } catch(e) { alert('Rename error: ' + e); }
        }

        input.addEventListener('keydown', e => {
            if (e.key === 'Enter')  { e.preventDefault(); commit(); }
            if (e.key === 'Escape') cancel();
        });
        input.focus();
    }

    async function _doMove() {
        if (!_activeSelector) return;

        // Remove any existing move bar
        document.getElementById('nb-move-bar')?.remove();

        const r = await fetch('/api/notebooks');
        const d = await r.json();
        const notebooks = d.notebooks || [];

        const toolbar = document.getElementById('nb-preview-toolbar');
        const bar = document.createElement('div');
        bar.id        = 'nb-move-bar';
        bar.className = 'nb-move-bar';

        const lbl = document.createElement('span');
        lbl.className   = 'nb-move-label';
        lbl.textContent = 'Move to:';

        const sel = document.createElement('select');
        sel.className = 'nb-scope-select';
        sel.style.colorScheme = 'dark';
        const curNb = _activeSelector.split(':')[0];
        notebooks.forEach(nb => {
            const opt = document.createElement('option');
            opt.value = nb; opt.textContent = nb;
            if (nb === curNb) { opt.selected = true; opt.disabled = true; }
            sel.appendChild(opt);
        });

        const goBtn = document.createElement('button');
        goBtn.className   = 'nb-tool-btn nb-btn-primary';
        goBtn.textContent = 'Move';

        const cancelBtn = document.createElement('button');
        cancelBtn.className   = 'nb-tool-btn';
        cancelBtn.textContent = 'Cancel';

        bar.append(lbl, sel, goBtn, cancelBtn);
        toolbar.parentNode.insertBefore(bar, toolbar.nextSibling);
        sel.focus();

        cancelBtn.addEventListener('click', () => bar.remove());

        goBtn.addEventListener('click', async () => {
            const dest = sel.value + ':';
            goBtn.textContent = 'Moving…'; goBtn.disabled = true;
            try {
                const resp = await fetch('/api/note/move', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ selector: _activeSelector, dest }),
                });
                const rd = await resp.json();
                if (rd.success) {
                    bar.remove();
                    _activeSelector = null;
                    document.getElementById('nb-preview-toolbar').hidden = true;
                    document.getElementById('nb-preview-content').innerHTML =
                        '<div id="nb-welcome"><h2>nb-web</h2><p>Note moved.</p></div>';
                    loadNotes();
                } else {
                    alert('Move failed: ' + (rd.stderr || 'unknown'));
                    goBtn.textContent = 'Move'; goBtn.disabled = false;
                }
            } catch(e) { goBtn.textContent = 'Move'; goBtn.disabled = false; }
        });
    }

    // ── Keyboard navigation ────────────────────────────────────────

    function _bindKeyboard() {
        let _kbPane = 'list';   // 'list' | 'preview'
        const listPane    = document.getElementById('nb-list-pane');
        const previewPane = document.getElementById('nb-preview-pane');
        const previewContent = document.getElementById('nb-preview-content');

        function _setKbPane(pane) {
            _kbPane = pane;
            listPane.classList.toggle('kb-focus',    pane === 'list');
            previewPane.classList.toggle('kb-focus', pane === 'preview');
        }
        _setKbPane('list');

        // Mouse clicks transfer keyboard focus
        document.getElementById('nb-list').addEventListener('mousedown',
            () => _setKbPane('list'));
        previewContent.addEventListener('mousedown',
            () => _setKbPane('preview'));

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
                openNote(item.dataset.selector);
            }
        }

        document.addEventListener('keydown', e => {
            // Let inputs handle their own keys
            const tag = document.activeElement?.tagName;
            if (['INPUT','TEXTAREA','SELECT'].includes(tag)) return;
            if (e.ctrlKey || e.metaKey) return;

            const items = _visibleItems();
            const idx   = _activeIdx(items);
            const PAGE  = 8;

            if (_kbPane === 'list') {
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
                    case 'ArrowRight': {
                        e.preventDefault();
                        const cur = items[idx];
                        if (cur?.dataset.type === 'folder') {
                            cur.click();    // drill into folder
                        } else {
                            _setKbPane('preview');
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
                    case 'ArrowLeft': e.preventDefault(); _setKbPane('list'); break;
                }
            }
        });
    }

    // ── Drag handle ────────────────────────────────────────────────

    function initDragHandle() {
        const handle   = document.getElementById('nb-drag-handle');
        const listPane = document.getElementById('nb-list-pane');
        if (!handle || !listPane) return;

        const KEY_W = 'nb-list-w';
        const KEY_H = 'nb-list-h';

        function isMobile() { return window.innerWidth <= 700; }

        function applySize(px) {
            if (isMobile()) {
                listPane.style.width     = '';
                listPane.style.maxHeight = Math.max(80, Math.min(px, window.innerHeight * 0.75)) + 'px';
            } else {
                listPane.style.maxHeight = '';
                listPane.style.width     = Math.max(150, Math.min(px, window.innerWidth * 0.65)) + 'px';
            }
        }

        // Restore saved size
        const savedW = localStorage.getItem(KEY_W);
        const savedH = localStorage.getItem(KEY_H);
        if (!isMobile() && savedW) applySize(Number(savedW));
        if (isMobile()  && savedH) applySize(Number(savedH));

        // Re-apply correct size when crossing the mobile/desktop threshold
        let _wasMobile = isMobile();
        window.addEventListener('resize', () => {
            const mobile = isMobile();
            if (mobile === _wasMobile) return;
            _wasMobile = mobile;
            if (mobile) {
                listPane.style.maxHeight = '';
                listPane.style.width = '';
                const h = localStorage.getItem(KEY_H);
                if (h) applySize(Number(h));
            } else {
                listPane.style.maxHeight = '';
                listPane.style.width = '';
                const w = localStorage.getItem(KEY_W);
                if (w) applySize(Number(w));
            }
        });

        let dragging = false, startX = 0, startY = 0, startW = 0, startH = 0;

        function startDrag(cx, cy) {
            dragging = true;
            startX = cx; startY = cy;
            startW = listPane.offsetWidth;
            startH = listPane.offsetHeight;
            handle.classList.add('dragging');
            document.body.style.userSelect = 'none';
            document.body.style.cursor = isMobile() ? 'row-resize' : 'col-resize';
        }

        function moveDrag(cx, cy) {
            if (!dragging) return;
            applySize(isMobile() ? startH + (cy - startY) : startW + (cx - startX));
        }

        function endDrag() {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            const size = isMobile() ? listPane.offsetHeight : listPane.offsetWidth;
            localStorage.setItem(isMobile() ? KEY_H : KEY_W, size);
        }

        handle.addEventListener('mousedown', e => { e.preventDefault(); startDrag(e.clientX, e.clientY); });
        document.addEventListener('mousemove', e => moveDrag(e.clientX, e.clientY));
        document.addEventListener('mouseup', endDrag);

        handle.addEventListener('touchstart', e => {
            e.preventDefault();
            startDrag(e.touches[0].clientX, e.touches[0].clientY);
        }, {passive: false});
        document.addEventListener('touchmove', e => {
            if (dragging) { e.preventDefault(); moveDrag(e.touches[0].clientX, e.touches[0].clientY); }
        }, {passive: false});
        document.addEventListener('touchend', endDrag);
    }

    // ── Inline editor ──────────────────────────────────────────────

    function _updateNavBtns() {
        const back = document.getElementById('nb-back-btn');
        const fwd  = document.getElementById('nb-forward-btn');
        if (back) back.hidden = _history.length === 0;
        if (fwd)  fwd.hidden  = _future.length === 0;
    }

    function _goBack() {
        if (!_history.length) return;
        _future.push(_activeSelector);
        openNote(_history.pop(), false);
    }

    function _goForward() {
        if (!_future.length) return;
        _history.push(_activeSelector);
        openNote(_future.pop(), false);
    }

    function _bindPreviewActions() {
        document.getElementById('nb-back-btn').addEventListener('click', _goBack);
        document.getElementById('nb-forward-btn').addEventListener('click', _goForward);
        document.getElementById('nb-edit-btn').addEventListener('click', _openEditor);
        document.getElementById('nb-save-btn').addEventListener('click', _saveNote);
        document.getElementById('nb-cancel-btn').addEventListener('click', _closeEditor);
        document.getElementById('nb-delete-btn').addEventListener('click', _deleteNote);
        document.getElementById('nb-pin-indicator')?.addEventListener('click', _togglePin);

        // Format toolbar
        document.querySelectorAll('[data-fmt]').forEach(btn => {
            btn.addEventListener('click', () => _applyFmt(btn.dataset.fmt));
        });
    }

    function _openEditor() {
        if (!_activeSelector) return;
        _editing = true;
        const raw = document.querySelector('#nb-preview-content .nb-rendered');
        // Get raw content from server (already stored in note data if we cache it)
        fetch('/api/note?selector=' + encodeURIComponent(_activeSelector))
            .then(r => r.json())
            .then(d => {
                const ta = document.getElementById('nb-editor');
                ta.value = d.raw || d.body || '';
                document.getElementById('nb-preview-content').hidden = true;
                document.getElementById('nb-editor-wrap').hidden = false;
                ta.focus();
            });
    }

    async function _saveNote() {
        if (!_activeSelector) return;
        const content = document.getElementById('nb-editor').value;
        const btn = document.getElementById('nb-save-btn');
        btn.textContent = 'Saving…';
        try {
            const r = await fetch('/api/note', {
                method: 'PUT',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({selector: _activeSelector, content}),
            });
            const d = await r.json();
            if (d.success) { _closeEditor(); openNote(_activeSelector); }
            else alert('Save failed: ' + (d.stderr || 'unknown error'));
        } finally {
            btn.textContent = 'Save';
        }
    }

    function _closeEditor() {
        _editing = false;
        document.getElementById('nb-editor-wrap').hidden = true;
        document.getElementById('nb-preview-content').hidden = false;
    }

    function _applyFmt(fmt) {
        const ta  = document.getElementById('nb-editor');
        const s   = ta.selectionStart, e = ta.selectionEnd;
        const sel = ta.value.slice(s, e);
        const map = {
            bold:    `**${sel || 'bold text'}**`,
            italic:  `_${sel || 'italic text'}_`,
            heading: `\n## ${sel || 'Heading'}\n`,
            link:    `[${sel || 'link text'}](url)`,
            tag:     `#${sel || 'tag'}`,
        };
        const ins = map[fmt] || sel;
        ta.setRangeText(ins, s, e, 'end');
        ta.focus();
    }

    async function _deleteNote() {
        if (!_activeSelector) return;
        if (!confirm(`Delete "${_activeSelector}"?`)) return;
        const r = await fetch('/api/note?selector=' + encodeURIComponent(_activeSelector), {method:'DELETE'});
        const d = await r.json();
        if (d.success) {
            _activeSelector = null;
            document.getElementById('nb-preview-toolbar').hidden = true;
            document.getElementById('nb-preview-content').innerHTML =
                '<div id="nb-welcome"><h2>nb-web</h2><p>Note deleted.</p></div>';
            loadNotes();
        }
    }

    // ── Today / Journal ────────────────────────────────────────────

    async function openToday() {
        try {
            const r = await fetch('/api/today');
            const d = await r.json();
            _todayInfo = {path: d.path};

            const content = document.getElementById('nb-preview-content');
            const toolbar = document.getElementById('nb-preview-toolbar');
            toolbar.hidden = false;
            document.getElementById('nb-preview-title').textContent = "Today's Journal";
            const ref = document.getElementById('nb-preview-ref');
            if (ref) ref.textContent = '';

            const html = _renderMarkdown(d.body || d.raw || '');
            content.innerHTML = `<div class="nb-rendered">${html}</div>`;

            document.getElementById('nb-append-bar').hidden = false;
            document.getElementById('nb-append-input').focus();

            _activeSelector = null;
        } catch(e) {
            console.error('openToday:', e);
        }
    }

    function _bindAppend() {
        const input = document.getElementById('nb-append-input');
        const btn   = document.getElementById('nb-append-btn');

        // Auto-grow textarea
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 120) + 'px';
        });

        input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _doAppend(); }
        });
        btn.addEventListener('click', _doAppend);
    }

    async function _doAppend() {
        const input   = document.getElementById('nb-append-input');
        const content = input.value.trim();
        if (!content) return;
        input.disabled = true;
        try {
            const r = await fetch('/api/today', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({content}),
            });
            const d = await r.json();
            if (d.success) {
                input.value = '';
                input.style.height = '';
                openToday();   // refresh preview
            }
        } finally {
            input.disabled = false;
            input.focus();
        }
    }

    // ── Search ─────────────────────────────────────────────────────

    // Matches nb selectors: notebook:id, notebook:filename, or bare id
    // e.g. tasks:87  home:20260430.md  claude:3
    const _selectorPat = /^([a-z][a-z0-9_-]*):(\d+|[\w.-]+\.(?:md|org|txt|adoc))$/i;
    const _bareIdPat   = /^\d+$/;

    function _dispatchQuery(raw) {
        const q = raw.trim();
        if (!q) { loadNotes(); return; }

        // Direct selector: notebook:id or notebook:filename.md → open immediately
        if (_selectorPat.test(q)) {
            openNote(q);
            return;
        }
        // Bare number → treat as id in current notebook
        if (_bareIdPat.test(q) && NbNav.notebook !== '_all') {
            openNote(`${NbNav.notebook}:${q}`);
            return;
        }
        search(q);
    }

    function _bindSearch() {
        const input = document.getElementById('nb-search');
        const clear = document.getElementById('nb-search-clear');

        input.addEventListener('input', () => {
            clear.hidden = !input.value;
            clearTimeout(_searchTimer);
            _searchTimer = setTimeout(() => _dispatchQuery(input.value), 400);
        });

        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                clearTimeout(_searchTimer);
                _dispatchQuery(input.value);
            }
        });

        clear.addEventListener('click', () => {
            input.value = '';
            clear.hidden = true;
            loadNotes();
        });
    }

    // ── Add (now driven by cmd_bar "Add" button via NbNav) ─────────

    function showAddForm(type) {
        const title   = type === 'bookmark' ? 'New Bookmark' :
                        type === 'todo'     ? 'New Todo' :
                        type === 'folder'   ? 'New Folder' : 'New Note';
        const content = document.getElementById('nb-preview-content');
        document.getElementById('nb-preview-toolbar').hidden = true;
        content.hidden = false;
        document.getElementById('nb-editor-wrap').hidden = true;

        let extraFields = '';
        if (type === 'bookmark') {
            extraFields = `<label>URL <input type="url" id="nf-url" placeholder="https://…" style="width:100%;margin-top:4px"></label>
                           <label>Comment <input type="text" id="nf-comment" placeholder="Optional comment…" style="width:100%;margin-top:4px"></label>`;
        }

        content.innerHTML = `
          <div style="max-width:600px;padding:8px 0">
            <h2 style="margin-bottom:16px;font-size:1.1em;color:var(--text-muted)">${_esc(title)}</h2>
            <div style="display:flex;flex-direction:column;gap:10px">
              <label>Title<br><input type="text" id="nf-title" placeholder="${_esc(title)}" style="width:100%;margin-top:4px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:6px 8px"></label>
              ${extraFields}
              <label>Tags (comma-separated)<br><input type="text" id="nf-tags" placeholder="tag1, tag2" style="width:100%;margin-top:4px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:6px 8px"></label>
              ${type === 'note' ? '<label>Content<br><textarea id="nf-content" rows="6" style="width:100%;margin-top:4px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text);padding:6px 8px;font-family:var(--font-mono);font-size:13px;resize:vertical"></textarea></label>' : ''}
              <div style="display:flex;gap:8px;margin-top:4px">
                <button id="nf-save" class="nb-tool-btn nb-btn-primary">Create</button>
                <button id="nf-cancel" class="nb-tool-btn">Cancel</button>
              </div>
            </div>
          </div>`;

        document.getElementById('nf-title').focus();
        document.getElementById('nf-cancel').addEventListener('click', () => {
            content.innerHTML = '<div id="nb-welcome"><h2>nb-web</h2><p>Select a note, or choose a command above.</p></div>';
        });
        document.getElementById('nf-save').addEventListener('click', () => _submitAdd(type));
    }

    async function _submitAdd(type) {
        const titleEl   = document.getElementById('nf-title');
        const tagsEl    = document.getElementById('nf-tags');
        const contentEl = document.getElementById('nf-content');
        const urlEl     = document.getElementById('nf-url');
        const commentEl = document.getElementById('nf-comment');

        const body = {
            notebook: NbNav.notebook,
            folder:   NbNav.folder,
            type,
            title:   titleEl?.value.trim() || '',
            tags:    tagsEl?.value.split(',').map(t=>t.trim()).filter(Boolean) || [],
            content: contentEl?.value || '',
            url:     urlEl?.value.trim() || '',
            comment: commentEl?.value.trim() || '',
        };

        const btn = document.getElementById('nf-save');
        btn.textContent = 'Creating…'; btn.disabled = true;
        try {
            const r = await fetch('/api/notes', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify(body),
            });
            const d = await r.json();
            if (d.success) {
                loadNotes();
                document.getElementById('nb-preview-content').innerHTML =
                    '<div id="nb-welcome"><h2>nb-web</h2><p>Created!</p></div>';
            } else {
                alert('Create failed: ' + (d.error || 'unknown'));
                btn.textContent = 'Create'; btn.disabled = false;
            }
        } catch(e) {
            btn.textContent = 'Create'; btn.disabled = false;
        }
    }

    // ── Sync ───────────────────────────────────────────────────────

    async function doSync() {
        const btn = document.getElementById('nb-sync-btn');
        if (btn) btn.classList.add('nb-spin');
        try {
            const r = await fetch('/api/sync', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({notebook: NbNav.notebook}),
            });
            const d = await r.json();
            if (!d.success) console.warn('sync stderr:', d.stderr);
            else loadNotes();
        } finally {
            if (btn) btn.classList.remove('nb-spin');
        }
    }

    function _bindSync() {
        document.getElementById('nb-sync-btn').addEventListener('click', doSync);
    }

    // ── Run command (cal / daily / info / weather / notebooks) ─────

    async function runCmd(cmd, opts = {}) {
        _showPreviewLoading();
        try {
            const params = new URLSearchParams({ cmd });
            if (opts.month) params.set('month', opts.month);
            if (opts.year)  params.set('year',  opts.year);
            if (opts.date)  params.set('date',  opts.date);
            const r = await fetch('/api/run?' + params);
            const d = await r.json();
            _showCmdOutput(cmd, d.output || d.stderr || '(no output)');
        } catch (e) {
            _showCmdOutput(cmd, String(e));
        }
    }

    function _showPreviewLoading() {
        document.getElementById('nb-preview-toolbar').hidden = true;
        document.getElementById('nb-preview-content').innerHTML =
            '<div style="padding:40px;color:var(--text-muted)">Loading…</div>';
        document.getElementById('nb-editor-wrap').hidden = true;
    }

    function _showCmdOutput(cmd, text) {
        const content = document.getElementById('nb-preview-content');
        content.innerHTML = `<pre class="nb-cmd-output">${_esc(text)}</pre>`;
        document.getElementById('nb-preview-toolbar').hidden = true;
        _activeSelector = null;
    }

    function showNotebooksWelcome() {
        document.getElementById('nb-preview-toolbar').hidden = true;
        document.getElementById('nb-preview-content').innerHTML =
            '<div id="nb-welcome"><h2>📚 Notebooks</h2>' +
            '<p>Use the <strong>scope:</strong> dropdown above to set the active notebook.</p>' +
            '<p style="margin-top:8px;font-size:12px;color:var(--text-dim)">The selected scope applies to List, Bookmark, Todo, and other commands.</p></div>';
        _activeSelector = null;
    }

    // ── Add note (called from opts bar form) ───────────────────────

    async function addNote({ notebook, type, title, url }) {
        try {
            const r = await fetch('/api/notes', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ notebook, type, title, url,
                                       tags: [], content: '', comment: '' }),
            });
            const d = await r.json();
            if (d.success) { loadNotes(); return true; }
            alert('Add failed: ' + (d.error || 'unknown'));
            return false;
        } catch(e) {
            alert('Add failed: ' + String(e));
            return false;
        }
    }

    // ── Grep ────────────────────────────────────────────────────────

    async function runGrep(opts) {
        if (!opts.pattern) {
            _showCmdOutput('g', '(enter a pattern above and press run ↵)');
            return;
        }
        _showPreviewLoading();
        const params = new URLSearchParams({ q: opts.pattern });
        if (opts.all) params.set('notebook', '_all');
        else          params.set('notebook', NbNav.notebook);
        try {
            const r = await fetch('/api/notes?' + params);
            const d = await r.json();
            renderList(d.notes || []);
            document.getElementById('nb-preview-content').innerHTML =
                '<div style="padding:40px;color:var(--text-muted)">Select a result to preview.</div>';
            document.getElementById('nb-preview-toolbar').hidden = true;
        } catch (e) {
            console.error('runGrep:', e);
        }
    }

    // ── Util ───────────────────────────────────────────────────────

    function _esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function resetAndLoad() {
        const searchEl = document.getElementById('nb-search');
        const clearEl  = document.getElementById('nb-search-clear');
        if (searchEl) searchEl.value = '';
        if (clearEl)  clearEl.hidden = true;
        clearTimeout(_searchTimer);
        loadNotes();
    }

    return { init, loadNotes, resetAndLoad, resetSort, search, openNote, openToday,
             showAddForm, addNote, runCmd, runGrep, doSync };
})();

// ── Settings stub (wired up later) ────────────────────────────────
const NbSettings = { open() { alert('Settings panel coming soon.'); } };

document.addEventListener('DOMContentLoaded', () => NbMain.init());

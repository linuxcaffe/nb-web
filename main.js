// nb-web main.js — list, preview, editor, today, add, sync

const NbMain = (() => {
    let _activeSelector = null;
    let _activeType     = null;   // classify() type of current note
    let _activeFilename = null;   // original filename for raw export
    let _editing        = false;
    const _undoBuffer   = {};     // selector → raw content before last edit (level-1 undo)
    let _searchTimer    = null;
    let _todayInfo      = null;
    let _lastNotes      = [];       // original load order, for client-side sort
    let _sortMode       = 'default';
    let _foldersFirst   = localStorage.getItem('nb-folders-first') === 'true';
    let _pinnedSelectors = new Set(JSON.parse(localStorage.getItem('nb-pinned') || '[]'));
    let _isFullscreen    = false;
    let _listSeq        = 0;        // incremented on every new list request; stale responses are dropped
    const _history      = [];       // back-stack
    const _future       = [];       // forward-stack (cleared on any new navigation)
    const _wikilinkCache = new Map(); // selector → resolved title
    let _noAutoSelect   = false;     // suppresses renderList auto-select during explicit openNote
    let _listDisplayMode = 'title';  // 'title' | 'filename' — resets on every new fetch
    let _kbPane         = 'list';   // 'list' | 'preview'
    const _pendingDeletes = new Set(); // selectors deleted but possibly not yet gone from server
    const _selectedSelectors = new Set(); // multi-select
    let _lastClickedIdx = -1;             // anchor for shift-click range

    function _setKbPane(pane) {
        _kbPane = pane;
        document.getElementById('nb-list-pane')?.classList.toggle('kb-focus',    pane === 'list');
        document.getElementById('nb-preview-pane')?.classList.toggle('kb-focus', pane === 'preview');
    }

    // ── Boot ───────────────────────────────────────────────────────

    async function init() {
        NbNav.init();
        _bindSearch();
        _bindTags();
        _bindAppend();
        _bindPreviewActions();
        _bindListMenu();
        document.getElementById('nb-list-menu-btn')?.classList.toggle('nb-sort-active', _foldersFirst);
        _bindSortBtn();
        _bindPreviewMenu();
        _bindKeyboard();
        _bindDropImport();
        initDragHandle();
        const deepLink = location.hash ? decodeURIComponent(location.hash.slice(1)) : null;
        if (deepLink) _noAutoSelect = true;
        await loadNotes();
        _noAutoSelect = false;
        if (deepLink) openNote(deepLink);
        _loadVersion();
    }

    async function _loadVersion() {
        try {
            const r = await fetch('/api/version');
            const d = await r.json();
            const el = document.getElementById('nb-menu-build');
            if (el) el.textContent = `${d.started}  ${d.rev}`;
        } catch(_e) {}
    }

    // ── Notes list ─────────────────────────────────────────────────

    async function loadNotes(typeFilter, statusFilter, tagsFilter) {
        _listDisplayMode = 'title';
        const seq    = ++_listSeq;
        const nb     = NbNav.notebook;
        const folder = NbNav.folder;
        const params = new URLSearchParams({ notebook: nb });
        if (folder)      params.set('folder', folder);
        if (tagsFilter)  params.set('tags', tagsFilter);

        try {
            const r = await fetch('/api/notes?' + params);
            const d = await r.json();
            if (seq !== _listSeq) return;
            let notes = d.notes || [];
            if (_pendingDeletes.size) { notes = notes.filter(n => !_pendingDeletes.has(n.selector)); _pendingDeletes.clear(); }
            if (typeFilter)   notes = notes.filter(n => n.type   === typeFilter.replace('--type ', ''));
            if (statusFilter) notes = notes.filter(n => n.status === statusFilter);
            renderList(notes);
        } catch (e) {
            console.error('loadNotes:', e);
        }
    }

    async function search(query, typeFilter, statusFilter, tagsQuery) {
        if (!query.trim()) { loadNotes(typeFilter, statusFilter); return; }
        _listDisplayMode = 'title';
        const seq    = ++_listSeq;
        const nb     = NbNav.notebook;
        const folder = NbNav.folder;
        const params = new URLSearchParams({ notebook: nb, q: query });
        if (folder)     params.set('folder', folder);
        if (tagsQuery)  params.set('tags', tagsQuery);
        try {
            const r = await fetch('/api/notes?' + params);
            const d = await r.json();
            if (seq !== _listSeq) return;
            let notes = d.notes || [];
            if (_pendingDeletes.size) { notes = notes.filter(n => !_pendingDeletes.has(n.selector)); _pendingDeletes.clear(); }
            if (typeFilter)   notes = notes.filter(n => n.type   === typeFilter.replace('--type ', ''));
            if (statusFilter) notes = notes.filter(n => n.status === statusFilter);
            renderList(notes);
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
        if (_sortMode === 'newest') result.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
        if (_sortMode === 'oldest') result.sort((a, b) => (a.mtime || 0) - (b.mtime || 0));
        if (_foldersFirst) {
            const folders = result.filter(n => n.type === 'folder');
            const rest    = result.filter(n => n.type !== 'folder');
            result = [...folders, ...rest];
        }
        if (_pinnedSelectors.size) {
            const pinned = result.filter(n => _pinnedSelectors.has(n.selector));
            const rest   = result.filter(n => !_pinnedSelectors.has(n.selector));
            result = [...pinned, ...rest];
        }
        return result;
    }

    function _updateSortBtn() {
        const btn = document.getElementById('nb-sort-btn');
        if (btn) btn.classList.toggle('nb-sort-active', _sortMode !== 'default');
    }

    function resetSort(mode = 'default') {
        _sortMode     = mode;
        _foldersFirst = false;
        _updateSortBtn();
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
            document.getElementById('nb-type-breakdown').textContent = '';
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
            const _iconTip = { '○': 'Open todo', '✔': 'Closed todo', '✔️': 'Closed todo',
                               '🔖': 'Bookmark', '🔒': 'Encrypted', '📂': 'Folder',
                               '🌄': 'Image', '🔉': 'Audio', '📹': 'Video',
                               '📖': 'Ebook', '📄': 'Document', '🗃️': 'Sheet', '🪪': 'Contact' };
            if (note.indicator) icon.title = _iconTip[note.indicator] || '';

            const pinBadge = _pinnedSelectors.has(note.selector)
                ? Object.assign(document.createElement('span'), { className: 'nb-list-pin', textContent: '📌', title: 'Pinned to top' })
                : null;

            const body = document.createElement('div');
            body.className = 'nb-list-body';

            const titleRow = document.createElement('div');
            titleRow.className = 'nb-list-title-row';

            const title = document.createElement('span');
            title.className = 'nb-list-title';
            title.textContent = _listDisplayMode === 'filename'
                ? note.filename
                : (note.title || note.filename);
            titleRow.appendChild(title);

            if (note.annotation_match) {
                const annBadge = document.createElement('span');
                annBadge.className = 'nb-list-ann-badge';
                annBadge.textContent = '📎';
                annBadge.title = 'Found via annotation';
                titleRow.appendChild(annBadge);
            }

            if (note.id) {
                const idEl = document.createElement('span');
                idEl.className = 'nb-list-id';
                idEl.textContent = note.id;
                idEl.title = note.selector;
                titleRow.appendChild(idEl);
            }
            body.appendChild(titleRow);

            if (note.grepLines?.length) {
                const ctx = document.createElement('div');
                ctx.className = 'nb-list-grep-ctx';
                note.grepLines.forEach(gl => {
                    const div = document.createElement('div');
                    div.className = 'nb-list-grep-line' + (gl.match ? ' nb-grep-match' : '');
                    div.textContent = gl.text;
                    ctx.appendChild(div);
                });
                body.appendChild(ctx);
            } else {
                const excerptText = _listDisplayMode === 'filename'
                    ? (note.title !== note.filename ? note.title : '')
                    : note.excerpt;
                if (excerptText) {
                    const exc = document.createElement('div');
                    exc.className = 'nb-list-excerpt';
                    exc.textContent = excerptText;
                    body.appendChild(exc);
                }
            }
            if (note.annotation && !note.annotation_match) {
                const annLine = document.createElement('div');
                annLine.className = 'nb-list-ann-line';
                annLine.textContent = note.annotation.split('\n')[0].slice(0, 120);
                body.appendChild(annLine);
            }

            if (pinBadge) li.appendChild(pinBadge);
            li.appendChild(icon);
            li.appendChild(body);

            if (note.type === 'folder') {
                const moreBtn = document.createElement('button');
                moreBtn.className = 'nb-folder-more-btn';
                moreBtn.textContent = '⋯';
                moreBtn.title = 'Folder options';
                moreBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    NbDialog.openFolder(note.selector, note.filename);
                });
                li.appendChild(moreBtn);

                li.addEventListener('click', e => {
                    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
                    if (NbNav.notebook === '_all' && note.notebook) {
                        NbNav.drillFolderInNotebook(note.notebook, note.filename);
                    } else {
                        NbNav.drillFolder(note.filename);
                    }
                });
            } else {
                li.addEventListener('click', e => {
                    if (e.ctrlKey || e.metaKey) {
                        _toggleSelection(note.selector, notes.indexOf(note));
                    } else if (e.shiftKey) {
                        _rangeSelection(notes.indexOf(note), notes);
                    } else {
                        _clearSelection();
                        _lastClickedIdx = notes.indexOf(note);
                        openNote(note.selector);
                    }
                });
            }

            ul.appendChild(li);
        });

        // Auto-select first non-pinned, non-folder when current selection left the list
        if (!fromSort && !_noAutoSelect) {
            const stillPresent = _activeSelector && notes.some(n => n.selector === _activeSelector);
            if (!stillPresent) {
                const first = notes.find(n => n.type !== 'folder' && !_pinnedSelectors.has(n.selector))
                           || notes.find(n => n.type !== 'folder');
                if (first) {
                    openNote(first.selector, true, { autoSelect: true });
                    _setKbPane('list');   // keep keyboard in list so ↑/↓ works immediately
                }
            }
        }
    }

    // ── Open / preview note ────────────────────────────────────────

    async function openNote(selector, pushHistory = true, opts = {}) {
        if (_editing && selector !== _activeSelector) {
            if (opts.autoSelect) return;   // renderList auto-select: never disrupt editing
            if (!confirm('Discard unsaved changes?')) return;
            _closeEditor();
        }

        // Always update list visual selection — shows where cursor is even when pinned
        document.querySelectorAll('.nb-list-item').forEach(el => {
            el.classList.toggle('active', el.dataset.selector === selector);
        });

        if (pushHistory && _activeSelector && _activeSelector !== selector) {
            _history.push(_activeSelector);
            _future.length = 0;   // new navigation invalidates forward history
        }
        _activeSelector = selector;
        _updateNavBtns();
        document.getElementById('nb-pin-indicator').hidden = !_pinnedSelectors.has(selector);

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
            if (NbDialog.isOpen()) NbDialog.refresh();
        } catch (e) {
            content.innerHTML = `<div style="padding:40px;color:var(--red)">Error: ${_esc(String(e))}</div>`;
        }
    }

    function renderPreview(note) {
        _activeType     = note.type;
        _activeFilename = note.filename;
        const content = document.getElementById('nb-preview-content');
        document.getElementById('nb-preview-title').textContent = note.title || note.filename;
        document.getElementById('nb-done-bar')?.remove();
        document.getElementById('nb-preview-actions').hidden = false;

        const doneBtn   = document.getElementById('nb-done-btn');
        const editBtn   = document.getElementById('nb-edit-btn');
        const openExtBtn = document.getElementById('nb-open-ext-btn');
        if (doneBtn) doneBtn.hidden = !(note.type === 'todo' && note.status === 'open');
        if (editBtn) editBtn.hidden = ['sheet','image','audio','video','pdf','ebook','document','archive'].includes(note.type);

        // "Open externally" button — shown for types that benefit from a desktop app
        const _mediaTypes = new Set(['image','audio','video','pdf','ebook','document','archive','html','file','encrypted']);
        if (openExtBtn) {
            openExtBtn.hidden = !_mediaTypes.has(note.type);
            openExtBtn.onclick = async () => {
                openExtBtn.textContent = '…'; openExtBtn.disabled = true;
                try {
                    await fetch('/api/open', { method: 'POST',
                        headers: {'Content-Type':'application/json'},
                        body: JSON.stringify({ selector: note.selector }) });
                } finally { openExtBtn.textContent = '↗ Open'; openExtBtn.disabled = false; }
            };
        }

        // Hide embedded-block Save button on every navigation
        const _ssb = document.getElementById('nb-sheet-save-btn');
        if (_ssb) { _ssb.hidden = true; _ssb.onclick = null; }

        // Clean up sheet UI when navigating away from a sheet
        if (note.type !== 'sheet' && _sheetInstance) {
            _sheetInstance = null;
            document.getElementById('nb-editor-wrap').hidden = true;
            document.getElementById('nb-editor').hidden = false;
            document.querySelectorAll('#nb-editor-toolbar [data-fmt]')
                .forEach(b => b.hidden = false);
            const sb = document.getElementById('nb-save-btn');
            if (sb) sb.onclick = null;
        }

        const ref = document.getElementById('nb-preview-ref');
        if (ref) {
            ref.textContent = note.notebook ? `${note.notebook}:${note.id ?? '?'}` : '';
            ref.title = note.notebook ? `Go to ${note.notebook} notebook` : '';
            ref.style.cursor = note.notebook ? 'pointer' : 'default';
            ref.onclick = note.notebook ? () => NbNav.switchNotebook(note.notebook) : null;
        }

        const fileUrl = `/api/file?selector=${encodeURIComponent(note.selector)}`;
        let html = '';

        if (note.type === 'image') {
            html = `<div style="text-align:center"><img src="${fileUrl}" class="nb-img-preview" alt="${_esc(note.title)}"></div>`;
        } else if (note.type === 'audio') {
            html = `<div class="nb-audio-wrap">
                      <div style="font-size:1.1em;font-weight:600">${_esc(note.title)}</div>
                      <audio controls class="nb-audio-player"><source src="${fileUrl}"></audio>
                    </div>`;
        } else if (note.type === 'video') {
            const ext = (note.filename || '').split('.').pop().toLowerCase();
            if (['mp4','webm'].includes(ext)) {
                html = `<div style="text-align:center"><video controls class="nb-video-player"><source src="${fileUrl}"></video></div>`;
            } else {
                html = `<div class="nb-media-card">
                          <span class="nb-media-icon">📹</span>
                          <span class="nb-media-name">${_esc(note.filename)}</span>
                          <span class="nb-media-hint">${_esc(ext.toUpperCase())} — use ↗ Open to play</span>
                        </div>`;
            }
        } else if (note.type === 'pdf') {
            content.innerHTML = `<embed src="${fileUrl}" type="application/pdf" class="nb-pdf-embed">`;
            _appendAnnotation(content, note);
            return;
        } else if (note.type === 'contact') {
            html = _renderContact(note);
        } else if (note.type === 'sheet') {
            content.innerHTML = '<div class="nb-rendered"><div id="nb-sheet-host"></div></div>';
            _renderSheet(note);
            return;
        } else if (note.type === 'bookmark') {
            html = _renderBookmark(note);
        } else if (note.type === 'todo') {
            html = _renderTodo(note);
        } else if (note.type === 'html') {
            content.innerHTML = '<div style="padding:40px;color:var(--text-muted)">Loading…</div>';
            fetch(`/api/preview?selector=${encodeURIComponent(note.selector)}`)
                .then(r => r.json())
                .then(d => {
                    if (d.html) content.innerHTML = `<div class="nb-rendered nb-converted">${d.html}</div>`;
                    else content.innerHTML = `<div style="padding:40px;color:var(--red)">${_esc(d.error || 'Cannot preview')}</div>`;
                    _appendAnnotation(content, note);
                });
            return;
        } else if (note.type === 'ebook' || note.type === 'document') {
            content.innerHTML = '<div style="padding:40px;color:var(--text-muted)">Converting…</div>';
            fetch(`/api/preview?selector=${encodeURIComponent(note.selector)}`)
                .then(r => r.json())
                .then(d => {
                    if (d.type === 'html')    content.innerHTML = `<div class="nb-rendered nb-converted">${d.html}</div>`;
                    else if (d.type === 'unavailable')
                        content.innerHTML = `<div class="nb-media-card">
                            <span class="nb-media-icon">${note.type === 'ebook' ? '📖' : '📄'}</span>
                            <span class="nb-media-name">${_esc(note.filename)}</span>
                            <span class="nb-media-hint">${_esc(d.error)} — use ↗ Open</span>
                          </div>`;
                    else content.innerHTML = `<pre class="nb-archive-listing">${_esc(d.text || d.error || '')}</pre>`;
                    _appendAnnotation(content, note);
                });
            return;
        } else if (note.type === 'archive') {
            content.innerHTML = '<div style="padding:40px;color:var(--text-muted)">Reading archive…</div>';
            fetch(`/api/preview?selector=${encodeURIComponent(note.selector)}`)
                .then(r => r.json())
                .then(d => {
                    const listing = d.text || d.error || '';
                    const count = listing.split('\n').filter(Boolean).length;
                    content.innerHTML = `<div style="padding:24px 32px">
                        <div style="margin-bottom:12px;color:var(--text-muted);font-size:0.85em">📦 ${_esc(note.filename)} — ${count} item${count !== 1 ? 's' : ''}</div>
                        <pre class="nb-archive-listing">${_esc(listing)}</pre></div>`;
                    _appendAnnotation(content, note);
                });
            return;
        } else if (['note','file',''].includes(note.type)) {
            html = _renderMarkdown(note.body);
        } else {
            html = `<pre class="nb-rendered" style="padding:0">${_esc(note.raw || '')}</pre>`;
        }

        content.innerHTML = `<div class="nb-rendered">${html}</div>`;

        _renderCsvBlocks(content);
        _renderTwBlocks(content);
        _renderHledgerBlocks(content);
        _renderTBlocks(content);

        // Highlight active search / tag terms in the rendered preview
        const _hq = [NbNav.searchQuery?.trim(), NbNav.tagsQuery?.trim()]
            .filter(Boolean).join(' ');
        if (_hq) _highlightTerms(content.querySelector('.nb-rendered'), _hq);

        // Wire wiki-links and tag-links
        content.querySelectorAll('.nb-wiki-link').forEach(el => {
            el.addEventListener('click', () => openNote(el.dataset.selector || el.textContent));
        });
        _resolveWikilinks(content);
        content.querySelectorAll('.nb-tag-link').forEach(el => {
            el.addEventListener('click', () => {
                const tag      = el.textContent.trim();
                const norm     = tag.startsWith('#') ? tag : '#' + tag;
                const tagsEl   = document.getElementById('nb-tags');
                const tagsCl   = document.getElementById('nb-tags-clear');
                const current  = NbNav.tagsQuery?.trim() || '';
                // Cumulative: append if not already in the filter
                const newQuery = current.includes(norm) ? current
                               : current ? current + ' ' + norm : norm;
                tagsEl.value   = newQuery;
                if (tagsCl) tagsCl.hidden = false;
                NbNav.setTagsQuery(newQuery);
                NbNav.reexecute();
            });
        });

        // Markdown links: external ones get target=_blank; nb-selector hrefs open the note
        content.querySelectorAll('.nb-rendered a[href]').forEach(el => {
            const href = el.getAttribute('href');
            if (!href) return;
            if (/^(https?|mailto|ftp):/.test(href)) {
                el.setAttribute('target', '_blank');
                el.setAttribute('rel', 'noopener noreferrer');
            } else if (/^[a-z][a-z0-9_-]*:[^/]/.test(href)) {
                // nb selector: notebook:id or notebook:filename
                el.addEventListener('click', e => { e.preventDefault(); openNote(href); });
                el.classList.add('nb-nb-link');
            }
        });

        // uuid8 refs in content → nb info popover (inline code spans included)
        _wrapUuids(content);
        content.querySelectorAll('.nb-uuid-ref').forEach(el =>
            el.addEventListener('click', e => _showInfoPopover(e, el.dataset.uuid)));

        // Todo checkboxes
        content.querySelectorAll('.nb-todo-check').forEach(cb => {
            cb.addEventListener('change', () => _toggleTask(note.selector, cb.dataset.task, cb.checked));
        });

        _appendAnnotation(content, note);
    }

    // ── Annotation footnote ────────────────────────────────────────────────

    function _appendAnnotation(container, note) {
        const foot = document.createElement('div');
        foot.className = 'nb-annotation-foot';
        container.appendChild(foot);
        _renderAnnotationFoot(foot, note, note.annotation || null);
    }

    function _renderAnnotationFoot(foot, note, text) {
        if (text) {
            foot.innerHTML = `
                <div class="nb-ann-bar">
                    <span class="nb-ann-label">📝 Annotation</span>
                    <span class="nb-ann-actions">
                        <button class="nb-ann-edit-btn nb-tw-btn">Edit</button>
                        <button class="nb-ann-del-btn nb-tw-btn">Delete</button>
                    </span>
                </div>
                <div class="nb-ann-body nb-rendered">${_renderMarkdown(text)}</div>`;

            foot.querySelector('.nb-ann-edit-btn').addEventListener('click', () =>
                _editAnnotation(foot, note, text));
            foot.querySelector('.nb-ann-del-btn').addEventListener('click', () =>
                _deleteAnnotation(foot, note));
        } else {
            foot.innerHTML = `
                <div class="nb-ann-bar nb-ann-empty">
                    <button class="nb-ann-add-btn nb-tw-btn">+ Add annotation</button>
                </div>`;
            foot.querySelector('.nb-ann-add-btn').addEventListener('click', () =>
                _editAnnotation(foot, note, ''));
        }
    }

    function _editAnnotation(foot, note, current) {
        foot.innerHTML = `
            <div class="nb-ann-bar">
                <span class="nb-ann-label">📝 Annotation</span>
            </div>
            <textarea class="nb-ann-editor" placeholder="Markdown supported…" spellcheck="true">${_esc(current)}</textarea>
            <div class="nb-ann-editor-footer">
                <button class="nb-ann-save-btn nb-btn-primary">Save</button>
                <button class="nb-ann-cancel-btn nb-tw-btn">Cancel</button>
                <span class="nb-ann-status"></span>
            </div>`;

        const ta     = foot.querySelector('.nb-ann-editor');
        const status = foot.querySelector('.nb-ann-status');
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);

        foot.querySelector('.nb-ann-cancel-btn').addEventListener('click', () =>
            _renderAnnotationFoot(foot, note, current || null));

        foot.querySelector('.nb-ann-save-btn').addEventListener('click', async () => {
            const body = ta.value.trim();
            status.textContent = 'Saving…';
            try {
                const r = await fetch(`/api/note/annotate?selector=${encodeURIComponent(note.selector)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: body }),
                });
                const d = await r.json();
                if (d.ok) _renderAnnotationFoot(foot, note, d.annotation);
                else { status.textContent = '✗ ' + (d.error || 'failed'); }
            } catch(e) { status.textContent = '✗ ' + e.message; }
        });
    }

    async function _deleteAnnotation(foot, note) {
        if (!confirm('Delete annotation?')) return;
        try {
            await fetch(`/api/note/annotate?selector=${encodeURIComponent(note.selector)}`,
                { method: 'DELETE' });
            _renderAnnotationFoot(foot, note, null);
        } catch(e) { /* silent */ }
    }

    // Walk text nodes in `root` and wrap 7-8-hex-char tokens as clickable uuid refs.
    // Skips code BLOCKS (pre) and links, but intentionally walks inline <code> spans
    // because nb uuid8 refs are typically written as `678d16d1` backtick style.
    function _wrapUuids(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                let p = node.parentElement;
                while (p && p !== root) {
                    if (['PRE','A','SCRIPT','STYLE'].includes(p.tagName))
                        return NodeFilter.FILTER_REJECT;
                    p = p.parentElement;
                }
                return /\b[a-f0-9]{7,8}\b/i.test(node.textContent)
                    ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
            }
        });
        const nodes = [];
        let n;
        while ((n = walker.nextNode())) nodes.push(n);
        nodes.forEach(node => {
            const parts = node.textContent.split(/\b([a-f0-9]{7,8})\b/i);
            if (parts.length < 3) return;
            const frag = document.createDocumentFragment();
            parts.forEach((part, i) => {
                if (i % 2 === 1) {
                    const span = document.createElement('span');
                    span.className = 'nb-uuid-ref';
                    span.dataset.uuid = part;
                    span.textContent = part;
                    frag.appendChild(span);
                } else if (part) {
                    frag.appendChild(document.createTextNode(part));
                }
            });
            node.parentNode.replaceChild(frag, node);
        });
    }

    async function _showInfoPopover(e, uuid) {
        e.stopPropagation();
        document.querySelector('.nb-info-popover')?.remove();

        const pop = document.createElement('div');
        pop.className = 'nb-info-popover';
        pop.textContent = 'Loading…';

        // Initial position: below element, left-aligned
        const rect = e.target.getBoundingClientRect();
        pop.style.top  = (rect.bottom + 6) + 'px';
        pop.style.left = rect.left + 'px';
        document.body.appendChild(pop);

        // Smart repositioning: flip up if below viewport, flip left if off right edge
        const pr = pop.getBoundingClientRect();
        if (pr.right > window.innerWidth - 8)
            pop.style.left = Math.max(8, rect.right - pr.width) + 'px';
        if (pr.bottom > window.innerHeight - 8)
            pop.style.top = Math.max(8, rect.top - pr.height - 6) + 'px';

        try {
            const isNbSelector = /^[a-z][a-z0-9_-]*:/.test(uuid);
            if (isNbSelector) {
                const r = await fetch('/api/run?cmd=info&selector=' + encodeURIComponent(uuid));
                const d = await r.json();
                pop.textContent = d.output || d.stderr || '(no output)';
            } else {
                // Try Taskwarrior first, then git commit, then nb info
                const tw = await fetch('/api/task-info?uuid=' + encodeURIComponent(uuid));
                const td = await tw.json();
                if (td.output) {
                    pop.textContent = td.output;
                } else {
                    const gr = await fetch('/api/git/show?hash=' + encodeURIComponent(uuid));
                    const gd = await gr.json();
                    if (gd.text) {
                        pop.textContent = gd.text + (gd.repo ? `\n\n(${gd.repo})` : '');
                    } else {
                        const r2 = await fetch('/api/run?cmd=info&selector=' + encodeURIComponent(uuid));
                        const d2 = await r2.json();
                        pop.textContent = d2.output || '(no match found)';
                    }
                }
            }
        } catch(err) {
            pop.textContent = 'Error: ' + err;
        }

        // Reposition vertically after content is known (height may have changed)
        const pr2 = pop.getBoundingClientRect();
        if (pr2.bottom > window.innerHeight - 8)
            pop.style.top = Math.max(8, rect.top - pr2.height - 6) + 'px';

        function dismiss(ev) {
            if (!pop.contains(ev.target)) {
                pop.remove();
                document.removeEventListener('click', dismiss, true);
            }
        }
        setTimeout(() => document.addEventListener('click', dismiss, true), 0);
    }

    function _highlightTerms(container, query) {
        if (!query || !container) return;
        const terms = query.match(/"[^"]+"|#\S+|\S+/g) || [];
        if (!terms.length) return;
        const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const re = new RegExp(`(${escaped.join('|')})`, 'gi');

        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let node;
        while ((node = walker.nextNode())) nodes.push(node);

        nodes.forEach(textNode => {
            const text = textNode.nodeValue;
            if (!re.test(text)) { re.lastIndex = 0; return; }
            re.lastIndex = 0;
            const frag = document.createDocumentFragment();
            let last = 0, m;
            while ((m = re.exec(text)) !== null) {
                if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
                const mark = document.createElement('mark');
                mark.className = 'nb-highlight';
                mark.textContent = m[0];
                frag.appendChild(mark);
                last = m.index + m[0].length;
            }
            if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
            textNode.parentNode.replaceChild(frag, textNode);
        });
    }

    function _renderCsvBlocks(container) {
        const blocks = container.querySelectorAll('pre > code.language-csv');
        if (!blocks.length) return;

        blocks.forEach((code) => {
            const pre  = code.parentElement;
            const raw  = code.textContent.trim();
            const rows = raw.split('\n').filter(r => r.trim() !== '').map(r =>
                r.split(',').map(cell => cell.replace(/^"|"$/g, '').replace(/""/g, '"'))
            );
            const host = document.createElement('div');
            host.className = 'nb-csv-block';
            pre.replaceWith(host);
            jspreadsheet(host, {
                worksheets: [{ data: rows.length ? rows : [['']] }],
            });
        });

        // Show Save button in preview toolbar for embedded blocks
        const btn = document.getElementById('nb-sheet-save-btn');
        if (btn) { btn.hidden = false; btn.onclick = () => _saveCsvBlocks(); }
    }

    async function _saveCsvBlocks() {
        if (!_activeSelector) return;
        const btn = document.getElementById('nb-sheet-save-btn');
        btn.textContent = 'Saving…';
        try {
            const r  = await fetch('/api/note?selector=' + encodeURIComponent(_activeSelector));
            const d  = await r.json();
            let raw  = d.raw || d.body || '';

            const hosts = [...document.querySelectorAll('.nb-csv-block')];
            let blockIdx = 0;
            raw = raw.replace(/```csv\n([\s\S]*?)```/g, (match) => {
                const host = hosts[blockIdx++];
                if (!host?.spreadsheet) return match;
                const data = host.spreadsheet.worksheets[0].getData();
                const csv  = data.map(row =>
                    row.map(cell => {
                        const s = String(cell ?? '');
                        return s.includes(',') || s.includes('"') || s.includes('\n')
                            ? `"${s.replace(/"/g, '""')}"` : s;
                    }).join(',')
                ).join('\n');
                return '```csv\n' + csv + '\n```';
            });

            const wr = await fetch('/api/note', {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({selector: _activeSelector, content: raw}),
            });
            const wd = await wr.json();
            if (wd.success) {
                btn.textContent = '✓ Saved';
                setTimeout(() => { btn.textContent = 'Save'; }, 1200);
            } else {
                alert('Save failed: ' + (wd.stderr || 'unknown'));
            }
        } catch(e) {
            alert('Save error: ' + e);
        } finally {
            if (btn.textContent === 'Saving…') btn.textContent = 'Save';
        }
    }

    let _sheetInstance = null;

    function _renderSheet(note) {
        const host = document.getElementById('nb-sheet-host');
        if (!host) { console.error('nb-sheet-host not found'); return; }
        if (_sheetInstance) { try { jspreadsheet.destroy(host); } catch(_) {} _sheetInstance = null; }

        const raw = note.raw || note.body || '';
        const rows = raw.split('\n').filter(r => r.trim() !== '').map(r =>
            r.split(',').map(cell => cell.replace(/^"|"$/g, '').replace(/""/g, '"'))
        );

        try {
            _sheetInstance = jspreadsheet(host, {
                worksheets: [{
                    data: rows.length ? rows : [['']],
                    minDimensions: [6, 8],
                }],
            });
        } catch(e) {
            host.innerHTML = `<div style="padding:40px;color:var(--red)">Sheet init error: ${_esc(String(e))}</div>`;
            return;
        }

        // Show Save/Cancel synchronously — don't rely on async onload
        document.getElementById('nb-editor-wrap').hidden = false;
        document.getElementById('nb-editor').hidden = true;
        document.querySelectorAll('#nb-editor-toolbar [data-fmt]').forEach(b => b.hidden = true);
        document.getElementById('nb-save-btn').onclick = () => _saveSheet();
        document.getElementById('nb-cancel-btn').onclick = () => openNote(_activeSelector);

    }

    async function _saveSheet() {
        if (!_activeSelector) return;
        const host = document.getElementById('nb-sheet-host');
        const spreadsheet = host?.spreadsheet;
        const ws = spreadsheet?.worksheets?.[0];
        if (!ws) { alert('Sheet not ready'); return; }
        const btn = document.getElementById('nb-save-btn');
        btn.textContent = 'Saving…';
        try {
            const data = ws.getData();
            const csv = data.map(row =>
                row.map(cell => {
                    const s = String(cell ?? '');
                    return s.includes(',') || s.includes('"') || s.includes('\n')
                        ? `"${s.replace(/"/g, '""')}"` : s;
                }).join(',')
            ).join('\n');
            const r = await fetch('/api/note', {
                method: 'PUT',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({selector: _activeSelector, content: csv}),
            });
            const d = await r.json();
            if (d.success) {
                btn.textContent = '✓ Saved';
                setTimeout(() => { btn.textContent = 'Save'; }, 1200);
            } else {
                alert('Save failed: ' + (d.stderr || 'unknown error'));
                btn.textContent = 'Save';
            }
        } catch(e) {
            btn.textContent = 'Save';
            throw e;
        }
    }

    function _contactFields(field) {
        if (!field) return [];
        if (typeof field === 'string') return [{ label: 'email', value: field }];
        if (Array.isArray(field))      return field.flatMap(_contactFields);
        if (typeof field === 'object') return Object.entries(field).map(([label, value]) => ({ label, value: String(value) }));
        return [];
    }

    function _contactInitials(name) {
        return (name || '?').split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase() || '?';
    }

    function _contactColor(name) {
        let h = 0;
        for (let i = 0; i < (name || '').length; i++) h = (h * 31 + (name || '').charCodeAt(i)) & 0xffff;
        return `hsl(${h % 360},40%,38%)`;
    }

    function _renderContact(note) {
        const m    = note.meta || {};
        const name = m.name || m.fn || note.title || '';
        const emails  = _contactFields(m.email);
        const phones  = _contactFields(m.phone);
        const tags    = Array.isArray(m.tags) ? m.tags : (m.tags ? String(m.tags).split(',').map(t => t.trim()) : []);

        const avatar = `<div class="nb-contact-avatar" style="background:${_contactColor(name)}">${_esc(_contactInitials(name))}</div>`;
        const sub    = [m.title, m.org].filter(Boolean).map(_esc).join(' · ');

        let rows = '';
        emails.forEach(({ label, value }) => {
            rows += `<div class="nb-contact-row"><span class="nb-contact-label">${_esc(label)}</span>` +
                    `<a class="nb-contact-value" href="mailto:${_esc(value)}">${_esc(value)}</a></div>`;
        });
        phones.forEach(({ label, value }) => {
            const href = 'tel:' + value.replace(/\s/g, '');
            rows += `<div class="nb-contact-row"><span class="nb-contact-label">${_esc(label)}</span>` +
                    `<a class="nb-contact-value" href="${_esc(href)}">${_esc(value)}</a></div>`;
        });
        if (m.address) {
            const addr = typeof m.address === 'string' ? m.address
                : Object.values(m.address).filter(Boolean).join(', ');
            const mq = `https://maps.google.com/?q=${encodeURIComponent(addr)}`;
            rows += `<div class="nb-contact-row"><span class="nb-contact-label">address</span>` +
                    `<a class="nb-contact-value" href="${mq}" target="_blank" rel="noopener">${_esc(addr)}</a></div>`;
        }
        if (m.url) {
            rows += `<div class="nb-contact-row"><span class="nb-contact-label">web</span>` +
                    `<a class="nb-contact-value" href="${_esc(m.url)}" target="_blank" rel="noopener">${_esc(m.url)}</a></div>`;
        }
        if (m.birthday) {
            rows += `<div class="nb-contact-row"><span class="nb-contact-label">birthday</span>` +
                    `<span class="nb-contact-value">${_esc(String(m.birthday))}</span></div>`;
        }

        const tagHtml = tags.length
            ? `<div class="nb-contact-tags">${tags.map(t => `<span class="nb-tag-link">#${_esc(t)}</span>`).join('')}</div>`
            : '';

        const bodyHtml = note.body?.trim()
            ? `<div class="nb-contact-notes">${_renderMarkdown(note.body)}</div>` : '';

        return `<div class="nb-contact-card">
  <div class="nb-contact-header">${avatar}
    <div class="nb-contact-name-block">
      <div class="nb-contact-name">${_esc(name)}</div>
      ${sub ? `<div class="nb-contact-sub">${sub}</div>` : ''}
    </div>
  </div>
  ${rows ? `<div class="nb-contact-fields">${rows}</div>` : ''}
  ${tagHtml}
  ${bodyHtml}
</div>`;
    }

    async function _resolveWikilinks(container) {
        const spans = [...container.querySelectorAll('.nb-wiki-link[data-autolabel]')];
        if (!spans.length) return;
        await Promise.all(spans.map(async span => {
            const sel = span.dataset.selector;
            if (!sel) return;
            try {
                let title;
                if (_wikilinkCache.has(sel)) {
                    title = _wikilinkCache.get(sel);
                } else {
                    const r = await fetch('/api/note?selector=' + encodeURIComponent(sel));
                    if (!r.ok) return;
                    const d = await r.json();
                    title = d.title || d.filename || sel;
                    _wikilinkCache.set(sel, title);
                }
                if (title && title !== sel) span.textContent = title;
            } catch(e) { /* leave as-is */ }
        }));
    }

    // ── tw / hledger / t codeblock renderers ──────────────────────
    if (typeof marked !== 'undefined') {
        marked.use({ renderer: {
            code({ text, lang }) {
                if (lang === 'tw') {
                    const q = text.trim().replace(/"/g, '&quot;');
                    return `<div class="nb-tw-block" data-query="${q}"><span class="nb-spin">⟳</span></div>`;
                }
                if (lang === 'hledger') {
                    const q = text.trim().replace(/"/g, '&quot;');
                    return `<div class="nb-hl-block" data-query="${q}"><span class="nb-spin">⟳</span></div>`;
                }
                if (lang === 't') {
                    const period = text.trim().replace(/"/g, '&quot;');
                    return `<div class="nb-t-block" data-period="${period}"><span class="nb-spin">⟳</span></div>`;
                }
                return false;
            }
        }});
    }

    // ── t timeclock codeblock ──────────────────────────────────────

    const _tTimers = new Map();

    function _fmtSeconds(s) {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
    }

    async function _renderTBlocks(container) {
        for (const el of container.querySelectorAll('.nb-t-block'))
            await _loadTBlock(el);
    }

    async function _loadTBlock(el) {
        const id = _tTimers.get(el);
        if (id) { clearInterval(id); _tTimers.delete(el); }
        el.innerHTML = '<span class="nb-spin">⟳</span>';
        const period = el.dataset.period || 'today';
        try {
            const [status, report] = await Promise.all([
                fetch('/api/t/status').then(r => r.json()),
                period
                    ? fetch(`/api/t/report?period=${encodeURIComponent(period)}`).then(r => r.json())
                    : Promise.resolve(null),
            ]);
            _buildTBlock(el, status, report, period);
        } catch(e) {
            el.innerHTML = `<span class="nb-t-error">⚠ ${_esc(e.message)}</span>`;
        }
    }

    function _buildTBlock(el, status, report, period) {
        el.innerHTML = '';

        // ── header row: status + actions ──
        const hdr = document.createElement('div');
        hdr.className = 'nb-t-header';

        const statusEl = document.createElement('div');
        statusEl.className = 'nb-t-status';

        if (status.state === 'in') {
            const elapsed = status.elapsed_seconds || 0;
            statusEl.innerHTML =
                `<span class="nb-t-dot nb-t-dot-in">⏱</span>` +
                `<span class="nb-t-account">${_esc(status.account)}</span>` +
                (status.desc ? `<span class="nb-t-desc">${_esc(status.desc)}</span>` : '') +
                `<span class="nb-t-elapsed" data-start="${Date.now() - elapsed * 1000}">${_fmtSeconds(elapsed)}</span>`;
        } else if (status.state === 'out') {
            statusEl.innerHTML =
                `<span class="nb-t-dot nb-t-dot-out">◌</span>` +
                `<span class="nb-t-out-label">OUT</span>` +
                `<span class="nb-t-desc">${_esc(status.account)} · ${_esc(status.last_out)}</span>`;
        } else {
            statusEl.innerHTML = `<span class="nb-t-dot nb-t-dot-out">○</span><span class="nb-t-desc">No entries</span>`;
        }

        const acts = document.createElement('div');
        acts.className = 'nb-t-actions';

        if (status.state === 'in') {
            const outBtn = document.createElement('button');
            outBtn.className = 'nb-tw-btn nb-t-btn nb-t-out-btn';
            outBtn.title = 'Clock out';
            outBtn.textContent = '◼ Out';
            outBtn.addEventListener('click', async () => {
                outBtn.disabled = true;
                const d = await fetch('/api/t/out', { method: 'POST' }).then(r => r.json()).catch(() => ({}));
                if (d.success) _loadTBlock(el); else outBtn.disabled = false;
            });
            acts.appendChild(outBtn);
        } else {
            const inBtn = document.createElement('button');
            inBtn.className = 'nb-tw-btn nb-t-btn nb-t-in-btn';
            inBtn.title = 'Clock in';
            inBtn.textContent = '⏱ In';
            inBtn.addEventListener('click', () => _showTClockInForm(el, status, inBtn));
            acts.appendChild(inBtn);
        }

        const refBtn = document.createElement('button');
        refBtn.className = 'nb-tw-btn nb-t-btn';
        refBtn.title = 'Refresh';
        refBtn.textContent = '↻';
        refBtn.addEventListener('click', () => _loadTBlock(el));
        acts.appendChild(refBtn);

        hdr.append(statusEl, acts);
        el.appendChild(hdr);

        // ── time report ──
        if (report?.rows?.length) {
            const rpt = document.createElement('div');
            rpt.className = 'nb-t-report';
            report.rows.forEach(row => {
                const r = document.createElement('div');
                r.className = 'nb-t-row';
                r.innerHTML = `<span class="nb-t-r-acct">${_esc(row.account)}</span><span class="nb-t-r-time">${_fmtSeconds(row.seconds)}</span>`;
                rpt.appendChild(r);
            });
            const tot = document.createElement('div');
            tot.className = 'nb-t-row nb-t-total';
            tot.innerHTML = `<span class="nb-t-r-acct">${period || 'today'} total</span><span class="nb-t-r-time">${_fmtSeconds(report.total_seconds)}</span>`;
            rpt.appendChild(tot);
            el.appendChild(rpt);
        }

        // ── live elapsed ticker (only when clocked in) ──
        if (status.state === 'in') {
            const startMs = Date.now() - (status.elapsed_seconds || 0) * 1000;
            const tid = setInterval(() => {
                const elapsedEl = el.querySelector('.nb-t-elapsed');
                if (!elapsedEl || !el.isConnected) { clearInterval(tid); _tTimers.delete(el); return; }
                elapsedEl.textContent = _fmtSeconds(Math.floor((Date.now() - startMs) / 1000));
            }, 30000);
            _tTimers.set(el, tid);
        }
    }

    async function _showTClockInForm(el, status, trigger) {
        const existing = el.querySelector('.nb-t-clock-in-form');
        if (existing) { existing.remove(); trigger?.classList.remove('active'); return; }
        trigger?.classList.add('active');

        const accounts = await fetch('/api/t/accounts').then(r => r.json()).then(d => d.accounts || []).catch(() => []);

        const form = document.createElement('div');
        form.className = 'nb-t-clock-in-form';

        const sel = document.createElement('select');
        sel.className = 'nb-t-acct-sel';
        if (!accounts.length) {
            const opt = document.createElement('option');
            opt.value = ''; opt.textContent = 'No recent accounts'; sel.appendChild(opt);
        } else {
            accounts.forEach(a => {
                const opt = document.createElement('option');
                opt.value = a; opt.textContent = a; sel.appendChild(opt);
            });
        }
        if (status.account) {
            const match = [...sel.options].find(o => o.value === status.account);
            if (match) match.selected = true;
        }

        const customInput = document.createElement('input');
        customInput.type = 'text'; customInput.className = 'nb-rename-input nb-t-custom-acct';
        customInput.placeholder = 'or type account…'; customInput.style.flex = '1';

        const descInput = document.createElement('input');
        descInput.type = 'text'; descInput.className = 'nb-rename-input';
        descInput.placeholder = 'description (optional)'; descInput.style.flex = '1.5';

        const goBtn = document.createElement('button');
        goBtn.className = 'nb-tw-btn nb-t-btn nb-btn-primary';
        goBtn.textContent = '⏱ In';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'nb-tw-btn nb-t-btn';
        cancelBtn.textContent = '✕';

        form.append(sel, customInput, descInput, goBtn, cancelBtn);
        el.appendChild(form);
        (accounts.length ? customInput : customInput).focus();

        const doClockIn = async () => {
            const account = customInput.value.trim() || sel.value;
            if (!account) { customInput.focus(); return; }
            goBtn.disabled = true;
            const d = await fetch('/api/t/in', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ account, desc: descInput.value.trim() }),
            }).then(r => r.json()).catch(() => ({}));
            if (d.success) _loadTBlock(el);
            else { goBtn.disabled = false; if (d.error) alert(d.error); }
        };

        goBtn.addEventListener('click', doClockIn);
        [customInput, descInput].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') doClockIn(); }));
        cancelBtn.addEventListener('click', () => { form.remove(); trigger?.classList.remove('active'); });
    }

    async function _renderTwBlocks(container) {
        for (const el of container.querySelectorAll('.nb-tw-block'))
            await _loadTwBlock(el);
    }

    async function _loadTwBlock(el) {
        const q = el.dataset.query || '';
        el.innerHTML = '<span class="nb-spin">⟳</span>';
        try {
            const r = await fetch(`/api/task-query?q=${encodeURIComponent(q)}`);
            const d = await r.json();
            if (d.error) { el.innerHTML = `<span class="nb-tw-error">⚠ ${_esc(d.error)}</span>`; return; }
            _buildTwTable(el, (d.tasks || []).sort((a, b) => (b.urgency || 0) - (a.urgency || 0)), q);
        } catch(e) {
            el.innerHTML = `<span class="nb-tw-error">⚠ ${_esc(e.message)}</span>`;
        }
    }

    function _buildTwTable(el, tasks, q) {
        const todayYmd = _localDateStr().replace(/-/g,'');
        const soonYmd  = _localDateStr(3).replace(/-/g,'');
        const fmtDate  = s => s ? s.replace(/^(\d{4})(\d{2})(\d{2}).*/, '$1-$2-$3') : '';
        const priLabel = { H: '▲', M: '●', L: '▽' };
        const priCls   = { H: 'nb-tw-pri-h', M: 'nb-tw-pri-m', L: 'nb-tw-pri-l' };
        const priDisplay = p => p ? (priLabel[p] || _esc(String(p))) : '';
        const hasPri   = tasks.some(t => t.priority);

        const rowUrgencyCls = t => {
            if (t.start) return 'nb-tw-row-started';
            const due = t.due ? t.due.slice(0,8) : '';
            if (due && due < todayYmd) return 'nb-tw-row-overdue';
            if (due && due <= soonYmd)  return 'nb-tw-row-soon';
            if ((t.urgency || 0) >= 10) return 'nb-tw-row-urgent';
            return '';
        };

        const metaHtml = cnt =>
            `${cnt} task${cnt !== 1 ? 's' : ''}${q ? ` · <code>${_esc(q)}</code>` : ''}`;

        // Header via DOM so event wiring is clean
        el.innerHTML = '';
        const hdr = document.createElement('div');
        hdr.className = 'nb-tw-header';
        hdr.innerHTML = `<span class="nb-tw-meta-inline">${metaHtml(tasks.length)}</span>`;

        const acts = document.createElement('span');
        acts.className = 'nb-tw-header-acts';

        const addBtn = document.createElement('button');
        addBtn.className = 'nb-tw-btn nb-tw-add-btn';
        addBtn.title = 'Add task'; addBtn.textContent = '+';
        addBtn.addEventListener('click', () => _showTwAddForm(el, q, addBtn));
        acts.appendChild(addBtn);

        const refBtn = document.createElement('button');
        refBtn.className = 'nb-tw-btn nb-tw-refresh';
        refBtn.title = 'Refresh'; refBtn.textContent = '↻';
        refBtn.addEventListener('click', () => _loadTwBlock(el));
        acts.appendChild(refBtn);

        hdr.appendChild(acts);
        el.appendChild(hdr);

        if (!tasks.length) return;

        const colspan = hasPri ? 8 : 7;

        const rows = tasks.map(t => {
            const due = t.due ? t.due.slice(0,8) : '';
            const dueCls = due && due < todayYmd ? ' nb-tw-overdue' : due && due <= soonYmd ? ' nb-tw-soon' : '';
            const isPending = !t.status || t.status === 'pending';
            const statusGlyph = t.status === 'completed' ? '✓' : t.status === 'deleted' ? '✗' : '';
            return `<tr class="${rowUrgencyCls(t)}" data-uuid="${_esc(t.uuid || '')}">
                <td class="nb-tw-act">${isPending ? `<button class="nb-tw-btn nb-tw-done-btn" title="Mark done">✓</button>` : ''}</td>
                <td class="nb-tw-id${isPending ? '' : ' nb-tw-id-status'}">${isPending ? (t.id || '') : statusGlyph}</td>
                <td class="nb-tw-desc">${_esc(t.description || '')}</td>
                <td class="nb-tw-proj">${_esc(t.project || '')}</td>
                ${hasPri ? `<td class="nb-tw-pri ${priCls[t.priority] || ''}">${priDisplay(t.priority)}</td>` : ''}
                <td class="nb-tw-due${dueCls}">${fmtDate(t.due)}</td>
                <td class="nb-tw-tags">${(t.tags || []).map(g => `<span class="nb-tw-tag">${_esc(g)}</span>`).join('')}</td>
                <td class="nb-tw-act">${isPending ? `<button class="nb-tw-btn nb-tw-toggle-btn" data-started="${!!t.start}" title="${t.start ? 'Stop' : 'Start'}">${t.start ? '◼' : '▶'}</button>` : ''}</td>
            </tr>`;
        }).join('');

        const tbl = document.createElement('table');
        tbl.className = 'nb-tw-table';
        tbl.innerHTML = `
            <thead><tr><th></th><th>ID</th><th>Description</th><th>Project</th>${hasPri ? '<th>Pri</th>' : ''}<th>Due</th><th>Tags</th><th></th></tr></thead>
            <tbody>${rows}</tbody>`;
        el.appendChild(tbl);

        el.querySelectorAll('.nb-tw-done-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const tr = btn.closest('tr');
                const uuid = tr?.dataset.uuid;
                if (!uuid) return;
                btn.disabled = true;
                const d = await fetch('/api/task-action', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({uuid, action: 'done'}),
                }).then(r => r.json());
                if (d.success) {
                    tr.classList.add('nb-tw-row-done');
                    setTimeout(() => {
                        tr.remove();
                        const remaining = el.querySelectorAll('tbody tr').length;
                        const meta = el.querySelector('.nb-tw-meta-inline');
                        if (meta) meta.innerHTML = metaHtml(remaining);
                        if (!remaining) el.querySelector('tbody').innerHTML =
                            `<tr><td colspan="${colspan}" class="nb-tw-all-done">✓ All done!</td></tr>`;
                    }, 380);
                } else { btn.disabled = false; }
            });
        });

        el.querySelectorAll('.nb-tw-toggle-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const tr = btn.closest('tr');
                const uuid = tr?.dataset.uuid;
                if (!uuid) return;
                const isStarted = btn.dataset.started === 'true';
                btn.disabled = true;
                const d = await fetch('/api/task-action', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({uuid, action: isStarted ? 'stop' : 'start'}),
                }).then(r => r.json());
                if (d.success) _loadTwBlock(el);
                else btn.disabled = false;
            });
        });
    }

    function _showTwAddForm(el, q, trigger) {
        const existing = el.querySelector('.nb-tw-addform');
        if (existing) { existing.remove(); trigger?.classList.remove('active'); return; }
        trigger?.classList.add('active');

        const form = document.createElement('div');
        form.className = 'nb-tw-addform';
        form.innerHTML = `
            <input type="text" class="nb-tw-inp nb-tw-adesc" placeholder="Description" autocomplete="off">
            <div class="nb-tw-addform-row">
                <input type="text" class="nb-tw-inp nb-tw-aproj" placeholder="project">
                <select class="nb-tw-inp nb-tw-adtype">
                    <option value="due">due:</option>
                    <option value="scheduled">sched:</option>
                    <option value="wait">wait:</option>
                    <option value="until">until:</option>
                </select>
                <input type="text" class="nb-tw-inp nb-tw-adval" placeholder="tomorrow">
                <button type="button" class="nb-tw-btn nb-tw-datepick" title="Pick date">📅</button>
                <input type="date" class="nb-tw-datepick-hidden" tabindex="-1">
                <input type="text" class="nb-tw-inp nb-tw-apri" placeholder="priority">
            </div>
            <div class="nb-tw-addform-row">
                <input type="text" class="nb-tw-inp nb-tw-atags" placeholder="tag1, tag2">
                <button class="nb-btn-primary nb-tw-asave">Add</button>
                <button class="nb-tw-btn nb-tw-acancel">Cancel</button>
                <span class="nb-tw-form-status"></span>
            </div>`;

        const dateValInput = form.querySelector('.nb-tw-adval');
        const datePicker   = form.querySelector('.nb-tw-datepick-hidden');
        form.querySelector('.nb-tw-datepick').addEventListener('click', () =>
            datePicker.showPicker ? datePicker.showPicker() : datePicker.click());
        datePicker.addEventListener('change', () => { dateValInput.value = datePicker.value; });

        const doAdd = async () => {
            const desc = form.querySelector('.nb-tw-adesc').value.trim();
            if (!desc) { form.querySelector('.nb-tw-adesc').focus(); return; }
            const status = form.querySelector('.nb-tw-form-status');
            status.textContent = 'Saving…'; status.style.color = '';
            try {
                const d = await fetch('/api/task-add', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        description: desc,
                        project:    form.querySelector('.nb-tw-aproj').value.trim(),
                        date_field: form.querySelector('.nb-tw-adtype').value,
                        date_value: dateValInput.value.trim(),
                        priority:   form.querySelector('.nb-tw-apri').value.trim(),
                        tags:       form.querySelector('.nb-tw-atags').value.trim(),
                    }),
                }).then(r => r.json());
                if (!d.success) {
                    status.textContent = '✗ ' + (d.error || d.stderr || 'failed');
                    status.style.color = 'var(--red, #ef4444)';
                } else {
                    form.remove(); trigger?.classList.remove('active');
                    await _loadTwBlock(el);
                }
            } catch(e) {
                status.textContent = '✗ ' + e.message;
                status.style.color = 'var(--red, #ef4444)';
            }
        };

        form.querySelector('.nb-tw-adesc').addEventListener('keydown', e => {
            if (e.key === 'Enter') doAdd();
            if (e.key === 'Escape') { form.remove(); trigger?.classList.remove('active'); }
        });
        form.querySelector('.nb-tw-asave').addEventListener('click', doAdd);
        form.querySelector('.nb-tw-acancel').addEventListener('click', () => {
            form.remove(); trigger?.classList.remove('active');
        });

        el.querySelector('.nb-tw-header').insertAdjacentElement('afterend', form);
        form.querySelector('.nb-tw-adesc')?.focus();
    }

    // ── hledger codeblock ──────────────────────────────────────────

    async function _renderHledgerBlocks(container) {
        for (const el of container.querySelectorAll('.nb-hl-block'))
            await _loadHledgerBlock(el);
    }

    async function _loadHledgerBlock(el) {
        const q = el.dataset.query || '';
        el.innerHTML = '<span class="nb-spin">⟳</span>';
        try {
            const r = await fetch(`/api/hledger-query?q=${encodeURIComponent(q)}`);
            const d = await r.json();
            if (d.error) { el.innerHTML = `<span class="nb-hl-error">⚠ ${_esc(d.error)}</span>`; return; }
            const webUrl = d.webUrl || null;
            if (d.text != null) { _buildHledgerPre(el, d.text, q, webUrl); return; }
            const cmd = d.cmd || 'balance';
            const BALANCE   = new Set(['balance','bal','b']);
            const REGISTER  = new Set(['register','reg','r']);
            const SECTIONED = new Set(['incomestatement','is','balancesheet','bs','cashflow','cf']);
            if (BALANCE.has(cmd))        _buildHledgerBalance(el, d.data, q, webUrl);
            else if (REGISTER.has(cmd))  _buildHledgerRegister(el, d.data, q, webUrl);
            else if (SECTIONED.has(cmd)) _buildHledgerSectioned(el, d.data, q, webUrl);
            else _buildHledgerPre(el, JSON.stringify(d.data, null, 2), q, webUrl);
        } catch(e) {
            el.innerHTML = `<span class="nb-hl-error">⚠ ${_esc(e.message)}</span>`;
        }
    }

    // Format an hledger amount array → display string
    function _hlFmtAmts(amounts) {
        if (!amounts?.length) return '0';
        return amounts.map(a => {
            const qty  = a.aquantity?.floatingPoint ?? 0;
            const sym  = a.acommodity || '';
            const prec = a.astyle?.asprecision ?? 2;
            const abs  = Math.abs(qty).toFixed(prec).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
            const sign = qty < 0 ? '−' : '';
            return a.astyle?.ascommodityside === 'L'
                ? `${sign}${sym}${abs}`
                : `${sign}${abs}${sym ? ' ' + sym : ''}`;
        }).join(' + ');
    }

    function _hlAmtCls(amounts) {
        const total = (amounts || []).reduce((s, a) => s + (a.aquantity?.floatingPoint ?? 0), 0);
        return total < -0.001 ? 'nb-hl-neg' : total > 0.001 ? 'nb-hl-pos' : 'nb-hl-zero';
    }

    function _hlHeader(el, q, refresh, webUrl) {
        const hdr = document.createElement('div');
        hdr.className = 'nb-hl-header';
        hdr.innerHTML = `<span class="nb-hl-meta">${q ? `<code>${_esc(q)}</code>` : 'hledger'}</span>`;

        const acts = document.createElement('span');
        acts.className = 'nb-hl-actions';

        // + always shows — opens inline add form (no hledger-web needed)
        const addBtn = document.createElement('button');
        addBtn.className = 'nb-tw-btn nb-hl-btn nb-hl-add-btn';
        addBtn.title = 'Add transaction';
        addBtn.textContent = '+';
        addBtn.addEventListener('click', () => _showHledgerAddForm(el, q, addBtn));
        acts.appendChild(addBtn);

        // ⎋ only when hledger-web URL is configured
        if (webUrl) {
            const webBtn = document.createElement('button');
            webBtn.className = 'nb-tw-btn nb-hl-btn nb-hl-web-btn';
            webBtn.title = 'Open in hledger-web';
            webBtn.textContent = '⎋';
            webBtn.addEventListener('click', () => {
                const args    = (q || '').split(/\s+/);
                const pattern = args.slice(1).find(a => !a.startsWith('-')) || '';
                const hash    = pattern ? `#${encodeURIComponent(pattern)}` : '';
                window.open(`${webUrl}${hash}`, 'hledger-web');
            });
            acts.appendChild(webBtn);
        }

        const refBtn = document.createElement('button');
        refBtn.className = 'nb-tw-btn nb-hl-btn nb-hl-refresh';
        refBtn.title = 'Refresh';
        refBtn.textContent = '↻';
        refBtn.addEventListener('click', refresh);
        acts.appendChild(refBtn);

        hdr.appendChild(acts);
        el.appendChild(hdr);
    }

    function _showHledgerAddForm(el, q, trigger) {
        const existing = el.querySelector('.nb-hl-addform');
        if (existing) {
            existing.remove();
            trigger?.classList.remove('nb-hl-btn-active');
            return;
        }
        trigger?.classList.add('nb-hl-btn-active');

        const today = _localDateStr();

        function makePostingRow() {
            const row = document.createElement('div');
            row.className = 'nb-hl-posting-row';
            row.innerHTML = `
                <input type="text" class="nb-hl-inp nb-hl-acc-inp" placeholder="account:name" autocomplete="off" spellcheck="false">
                <input type="text" class="nb-hl-inp nb-hl-amt-inp" placeholder="amount (blank to auto-balance)">
                <button class="nb-tw-btn nb-hl-rm-row" title="Remove posting">✕</button>`;
            row.querySelector('.nb-hl-rm-row').addEventListener('click', () => {
                if (form.querySelectorAll('.nb-hl-posting-row').length > 2) row.remove();
            });
            return row;
        }

        const form = document.createElement('div');
        form.className = 'nb-hl-addform';
        form.innerHTML = `
            <div class="nb-hl-addform-top">
                <input type="date" class="nb-hl-inp nb-hl-date-inp" value="${today}">
                <input type="text" class="nb-hl-inp nb-hl-desc-inp" placeholder="Description" autocomplete="off">
            </div>
            <div class="nb-hl-postings"></div>
            <div class="nb-hl-addform-footer">
                <button class="nb-tw-btn nb-hl-btn nb-hl-add-row">+ posting</button>
                <button class="nb-btn-primary nb-hl-save-btn">Save</button>
                <button class="nb-tw-btn nb-hl-cancel-btn">Cancel</button>
                <span class="nb-hl-form-status"></span>
            </div>`;

        const postingsEl = form.querySelector('.nb-hl-postings');
        postingsEl.appendChild(makePostingRow());
        postingsEl.appendChild(makePostingRow());

        form.querySelector('.nb-hl-add-row').addEventListener('click', () =>
            postingsEl.appendChild(makePostingRow()));

        form.querySelector('.nb-hl-cancel-btn').addEventListener('click', () => {
            form.remove();
            trigger?.classList.remove('nb-hl-btn-active');
        });

        form.querySelector('.nb-hl-save-btn').addEventListener('click', async () => {
            const status = form.querySelector('.nb-hl-form-status');
            const date   = form.querySelector('.nb-hl-date-inp').value;
            const desc   = form.querySelector('.nb-hl-desc-inp').value.trim();
            const postings = [...form.querySelectorAll('.nb-hl-posting-row')].map(r => ({
                account: r.querySelector('.nb-hl-acc-inp').value.trim(),
                amount:  r.querySelector('.nb-hl-amt-inp').value.trim(),
            })).filter(p => p.account);

            if (!date || !desc) { status.textContent = 'Date and description required'; return; }
            if (!postings.length) { status.textContent = 'At least one posting required'; return; }

            status.textContent = 'Saving…';
            status.style.color = '';
            try {
                const r = await fetch('/api/hledger-add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ date, description: desc, postings }),
                });
                const d = await r.json();
                if (d.error) {
                    status.textContent = '✗ ' + d.error;
                    status.style.color = 'var(--accent-neg, #e74c3c)';
                } else {
                    form.remove();
                    trigger?.classList.remove('nb-hl-btn-active');
                    await _loadHledgerBlock(el);
                }
            } catch(e) {
                status.textContent = '✗ ' + e.message;
                status.style.color = 'var(--accent-neg, #e74c3c)';
            }
        });

        el.querySelector('.nb-hl-header').insertAdjacentElement('afterend', form);
        form.querySelector('.nb-hl-desc-inp')?.focus();
    }

    // ── balance / bal / b ─────────────────────────────────────────
    function _buildHledgerBalance(el, data, q, webUrl) {
        // data = [rows_array, totals_array]
        const rows   = Array.isArray(data?.[0]) ? data[0] : [];
        const totals = Array.isArray(data?.[1]) ? data[1] : [];
        el.innerHTML = '';
        _hlHeader(el, q, () => _loadHledgerBlock(el), webUrl);
        if (!rows.length) { el.insertAdjacentHTML('beforeend', '<div class="nb-hl-empty">No accounts matched</div>'); return; }

        const tbody = rows.map(r => {
            const [name, , depth, amounts] = r;
            const cls = _hlAmtCls(amounts);
            return `<tr>
                <td class="nb-hl-account" style="padding-left:${8 + depth * 16}px">${_esc(name)}</td>
                <td class="nb-hl-amt ${cls}">${_hlFmtAmts(amounts)}</td>
            </tr>`;
        }).join('');

        const totalCls = _hlAmtCls(totals);
        el.insertAdjacentHTML('beforeend', `<table class="nb-hl-table">
            <thead><tr><th>Account</th><th class="nb-hl-amt">Balance</th></tr></thead>
            <tbody>${tbody}</tbody>
            <tfoot><tr class="nb-hl-total-row">
                <td>Total</td>
                <td class="nb-hl-amt ${totalCls}">${_hlFmtAmts(totals)}</td>
            </tr></tfoot>
        </table>`);
    }

    // ── register / reg / r ────────────────────────────────────────
    function _buildHledgerRegister(el, data, q, webUrl) {
        const rows = Array.isArray(data) ? data : [];
        el.innerHTML = '';
        _hlHeader(el, q, () => _loadHledgerBlock(el), webUrl);
        if (!rows.length) { el.insertAdjacentHTML('beforeend', '<div class="nb-hl-empty">No transactions matched</div>'); return; }

        const tbody = rows.map(r => {
            const [date, , desc, posting, balance] = r;
            const account = posting?.paccount || '';
            const amounts = posting?.pamount  || [];
            const amtCls  = _hlAmtCls(amounts);
            const balCls  = _hlAmtCls(balance);
            const isCont  = date == null;
            return `<tr class="${isCont ? 'nb-hl-cont' : ''}">
                <td class="nb-hl-date">${isCont ? '' : _esc(date || '')}</td>
                <td class="nb-hl-desc">${isCont ? '' : _esc(desc || '')}</td>
                <td class="nb-hl-account">${_esc(account)}</td>
                <td class="nb-hl-amt ${amtCls}">${_hlFmtAmts(amounts)}</td>
                <td class="nb-hl-amt ${balCls}">${_hlFmtAmts(balance)}</td>
            </tr>`;
        }).join('');

        el.insertAdjacentHTML('beforeend', `<table class="nb-hl-table">
            <thead><tr><th>Date</th><th>Description</th><th>Account</th>
                       <th class="nb-hl-amt">Amount</th><th class="nb-hl-amt">Balance</th></tr></thead>
            <tbody>${tbody}</tbody>
        </table>`);
    }

    // ── incomestatement / balancesheet / cashflow ─────────────────
    function _buildHledgerSectioned(el, data, q, webUrl) {
        const subreports = data?.cbrSubreports || [];
        el.innerHTML = '';
        _hlHeader(el, q, () => _loadHledgerBlock(el), webUrl);

        for (const [sectionName, report] of subreports) {
            const rows   = report?.prRows   || [];
            const totals = report?.prTotals;

            el.insertAdjacentHTML('beforeend', `<div class="nb-hl-section">${_esc(sectionName)}</div>`);

            if (!rows.length) {
                el.insertAdjacentHTML('beforeend', '<div class="nb-hl-empty nb-hl-section-empty">—</div>');
            } else {
                const tbody = rows.map(r => {
                    const name    = (r.prrName || [])[0] || '';
                    const amounts = (r.prrAmounts || [[]])[0] || [];
                    const cls     = _hlAmtCls(amounts);
                    return `<tr>
                        <td class="nb-hl-account">${_esc(name)}</td>
                        <td class="nb-hl-amt ${cls}">${_hlFmtAmts(amounts)}</td>
                    </tr>`;
                }).join('');

                const sectionTotal = (totals?.prrAmounts || [[]])[0] || [];
                const totCls = _hlAmtCls(sectionTotal);
                el.insertAdjacentHTML('beforeend', `<table class="nb-hl-table nb-hl-section-table">
                    <tbody>${tbody}</tbody>
                    <tfoot><tr class="nb-hl-total-row">
                        <td>Total ${_esc(sectionName)}</td>
                        <td class="nb-hl-amt ${totCls}">${_hlFmtAmts(sectionTotal)}</td>
                    </tr></tfoot>
                </table>`);
            }
        }
    }

    // Fallback: plain text in a <pre>
    function _buildHledgerPre(el, text, q, webUrl) {
        el.innerHTML = '';
        _hlHeader(el, q, () => _loadHledgerBlock(el), webUrl);
        el.insertAdjacentHTML('beforeend', `<pre class="nb-hl-pre">${_esc(text)}</pre>`);
    }

    function _renderMarkdown(body) {
        if (typeof marked === 'undefined') return `<pre>${_esc(body)}</pre>`;
        // Pre-process wiki-links and hashtags before marked
        let processed = body
            .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) =>
                `<span class="nb-wiki-link" data-selector="${_esc(target)}"${label ? '' : ' data-autolabel="1"'}>${_esc(label || target)}</span>`)
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
                  action: () => {
                      _foldersFirst = !_foldersFirst;
                      localStorage.setItem('nb-folders-first', _foldersFirst);
                      renderList(_getSortedNotes(_lastNotes), true);
                      const hbtn = document.getElementById('nb-list-menu-btn');
                      if (hbtn) hbtn.classList.toggle('nb-sort-active', _foldersFirst);
                  }},
                { label: _listDisplayMode === 'filename' ? '🏷 Show titles' : '📄 Show filenames',
                  action: () => {
                      _listDisplayMode = _listDisplayMode === 'filename' ? 'title' : 'filename';
                      renderList(_getSortedNotes(_lastNotes), true);
                  }},
                'sep',
                { label: document.documentElement.getAttribute('data-theme') === 'light'
                      ? '☾ Dark mode' : '☀ Light mode',
                  action: () => {
                      const goLight = document.documentElement.getAttribute('data-theme') !== 'light';
                      if (goLight) document.documentElement.setAttribute('data-theme', 'light');
                      else         document.documentElement.removeAttribute('data-theme');
                      localStorage.setItem('nb-theme', goLight ? 'light' : '');
                  }},
                'sep',
                { label: '📥 Import files…', action: () => NbDialog.open('import') },
                { label: '🔗 Link file…',   action: doLinkFile },
            ]);
        });
    }

    function _bindSortBtn() {
        const btn = document.getElementById('nb-sort-btn');
        if (!btn) return;
        btn.addEventListener('click', () => {
            _showDropdown(btn, [
                { label: 'Default',      active: _sortMode === 'default', action: () => _applySort('default') },
                { label: 'A → Z',        active: _sortMode === 'az',      action: () => _applySort('az') },
                { label: 'Z → A',        active: _sortMode === 'za',      action: () => _applySort('za') },
                'sep',
                { label: 'Newest first', active: _sortMode === 'newest',  action: () => _applySort('newest') },
                { label: 'Oldest first', active: _sortMode === 'oldest',  action: () => _applySort('oldest') },
            ]);
        });
    }

    function _applySort(mode) {
        _sortMode = mode;
        renderList(_getSortedNotes(_lastNotes), true);
        _updateSortBtn();
    }

    function _togglePin() {
        if (!_activeSelector) return;
        if (_pinnedSelectors.has(_activeSelector)) _pinnedSelectors.delete(_activeSelector);
        else                                        _pinnedSelectors.add(_activeSelector);
        localStorage.setItem('nb-pinned', JSON.stringify([..._pinnedSelectors]));
        document.getElementById('nb-pin-indicator').hidden = !_pinnedSelectors.has(_activeSelector);
        renderList(_getSortedNotes(_lastNotes), true);
    }

    function _toggleFullscreen() {
        _isFullscreen = !_isFullscreen;
        document.body.classList.toggle('nb-fullscreen', _isFullscreen);
    }

    function _bindPreviewMenu() {
        const btn = document.getElementById('nb-preview-menu-btn');
        if (!btn) return;
        btn.addEventListener('click', () => {
            const hasNote = !!_activeSelector;
            _showDropdown(btn, [
                { label: _pinnedSelectors.has(_activeSelector) ? '📌 Unpin from list' : '📌 Pin to list top',
                  disabled: !hasNote,
                  action: _togglePin },
                { label: _isFullscreen ? '⛶ Exit full screen' : '⛶ Full screen',
                  disabled: !hasNote,
                  action: _toggleFullscreen },
                'sep',
                { label: 'Rename…',              disabled: !hasNote, action: () => NbDialog.open('rename') },
                { label: 'Move to…',             disabled: !hasNote, action: () => NbDialog.open('move') },
                { label: '📋 Save as template…', disabled: !hasNote, action: _doSaveAsTemplate },
                'sep',
                { label: '↩ Undo last edit',
                  disabled: !hasNote || !_undoBuffer[_activeSelector],
                  action: _doUndoLastEdit },
                { label: '🕓 History…',   disabled: !hasNote, action: _showHistoryBar },
                'sep',
                { label: '⬇ Save as…', disabled: !hasNote, action: () => NbDialog.open('export') },
            ]);
        });
    }

    async function _doUndoLastEdit() {
        const raw = _undoBuffer[_activeSelector];
        if (!raw || !_activeSelector) return;
        if (!confirm('Restore note to its state before the last edit?')) return;
        const r = await fetch('/api/note', {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({selector: _activeSelector, content: raw}),
        });
        const d = await r.json();
        if (d.success) {
            delete _undoBuffer[_activeSelector];
            NbNav.reexecute();
            openNote(_activeSelector);
        } else {
            alert('Undo failed: ' + (d.stderr || 'unknown'));
        }
    }

    async function _showHistoryBar() {
        if (!_activeSelector) return;
        document.getElementById('nb-history-bar')?.remove();

        const toolbar = document.getElementById('nb-preview-toolbar');
        const bar     = document.createElement('div');
        bar.id        = 'nb-history-bar';
        bar.className = 'nb-move-bar';

        const lbl = document.createElement('span');
        lbl.className   = 'nb-move-label';
        lbl.textContent = 'History:';

        const sel = document.createElement('select');
        sel.className = 'nb-scope-select';
        sel.style.colorScheme = 'dark';
        sel.style.flex = '1';
        sel.style.maxWidth = '480px';

        const loadingOpt = document.createElement('option');
        loadingOpt.textContent = 'Loading…';
        sel.appendChild(loadingOpt);
        sel.disabled = true;

        const restoreBtn = document.createElement('button');
        restoreBtn.className   = 'nb-tool-btn nb-btn-primary';
        restoreBtn.textContent = 'Restore';
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
            openNote(_activeSelector);
        }
        cancelBtn.addEventListener('click', exitHistory);

        // Fetch commit list
        let commits = [];
        try {
            const r = await fetch('/api/note/history?selector=' + encodeURIComponent(_activeSelector));
            const d = await r.json();
            commits = d.commits || [];
        } catch(e) {
            sel.options[0].textContent = 'Error loading history';
            return;
        }

        sel.innerHTML = '';
        if (!commits.length) {
            const o = document.createElement('option');
            o.textContent = 'No history found';
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
                const r = await fetch(`/api/note/version?selector=${encodeURIComponent(_activeSelector)}&hash=${hash}`);
                const d = await r.json();
                if (d.error) { content.innerHTML = `<div style="padding:40px;color:var(--red)">${_esc(d.error)}</div>`; return; }
                const html = marked.parse(d.body || '');
                content.innerHTML = `<div class="nb-prose">${html}</div>`;
                _resolveWikilinks(content);
                restoreBtn.disabled = false;
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
            restoreBtn.textContent = 'Restoring…'; restoreBtn.disabled = true;
            try {
                const r = await fetch('/api/note/restore', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({selector: _activeSelector, hash}),
                });
                const d = await r.json();
                if (d.success) {
                    delete _undoBuffer[_activeSelector];
                    exitHistory();
                    NbNav.reexecute();
                } else {
                    alert('Restore failed: ' + (d.error || 'unknown'));
                    restoreBtn.textContent = 'Restore'; restoreBtn.disabled = false;
                }
            } catch(e) {
                alert('Restore error: ' + e);
                restoreBtn.textContent = 'Restore'; restoreBtn.disabled = false;
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


    // ── Multi-select ───────────────────────────────────────────────

    function _clearSelection() {
        if (!_selectedSelectors.size) return;
        _selectedSelectors.clear();
        _lastClickedIdx = -1;
        document.querySelectorAll('#nb-list .nb-list-item.selected')
            .forEach(el => el.classList.remove('selected'));
        const actions = document.getElementById('nb-preview-actions');
        if (actions) actions.hidden = !_activeSelector;
        if (_activeSelector) openNote(_activeSelector, false);
        else clearNote();
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
            if (_activeSelector) openNote(_activeSelector, false);
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
        const clrBtn = document.createElement('button');
        clrBtn.className = 'nb-tool-btn'; clrBtn.textContent = '✕ Clear';
        actRow.append(moveBtn, exportBtn, delBtn, clrBtn);
        delBtn.addEventListener('click', _bulkDelete);
        clrBtn.addEventListener('click', _clearSelection);
        wrap.appendChild(actRow);

        [..._selectedSelectors].forEach(sel => {
            const note = _lastNotes.find(n => n.selector === sel);
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
        clearNote('Deleting…');
        NbNav.updateOutputBar?.();

        let failed = 0;
        for (const sel of selectors) {
            try {
                const r = await fetch('/api/note?selector=' + encodeURIComponent(sel), { method: 'DELETE' });
                const d = await r.json();
                if (!d.success) failed++;
                else {
                    _pendingDeletes.add(sel);
                    // Remove from DOM immediately — don't wait for reexecute
                    document.querySelector(`#nb-list .nb-list-item[data-selector="${CSS.escape(sel)}"]`)?.remove();
                }
            } catch { failed++; }
        }
        if (failed) alert(`${failed} deletion${failed !== 1 ? 's' : ''} failed.`);
        clearNote(failed === 0 ? `${count} items deleted.` : 'Some deletions failed.');
        NbNav.reexecute();
    }

    function clearNote(msg) {
        _activeSelector = null;
        document.getElementById('nb-preview-toolbar').hidden = true;
        document.getElementById('nb-preview-content').innerHTML =
            `<div id="nb-welcome"><h2>nb-web</h2><p>${msg || ''}</p></div>`;
    }

    async function _doSaveAsTemplate() {
        if (!_activeSelector) return;

        // Remove any existing template-save bar
        document.getElementById('nb-tmpl-save-bar')?.remove();

        const toolbar = document.getElementById('nb-preview-toolbar');
        const bar = document.createElement('div');
        bar.id        = 'nb-tmpl-save-bar';
        bar.className = 'nb-move-bar';

        const lbl = document.createElement('span');
        lbl.className   = 'nb-move-label';
        lbl.textContent = 'Save as template:';

        const nameInput = document.createElement('input');
        nameInput.type        = 'text';
        nameInput.className   = 'nb-rename-input';
        nameInput.placeholder = 'template-name';
        nameInput.style.width = '12em';
        // Pre-fill from current title
        const titleText = document.getElementById('nb-preview-title')?.textContent || '';
        nameInput.value = titleText.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');

        const scopeSel = document.createElement('select');
        scopeSel.className = 'nb-scope-select';
        scopeSel.style.colorScheme = 'dark';
        [['local', 'Notebook'], ['global', 'Global']].forEach(([v, t]) => {
            const opt = document.createElement('option');
            opt.value = v; opt.textContent = t;
            scopeSel.appendChild(opt);
        });

        const saveBtn = document.createElement('button');
        saveBtn.className   = 'nb-tool-btn nb-btn-primary';
        saveBtn.textContent = 'Save';

        const cancelBtn = document.createElement('button');
        cancelBtn.className   = 'nb-tool-btn';
        cancelBtn.textContent = 'Cancel';

        bar.append(lbl, nameInput, scopeSel, saveBtn, cancelBtn);
        toolbar.parentNode.insertBefore(bar, toolbar.nextSibling);
        nameInput.select();
        nameInput.focus();

        cancelBtn.addEventListener('click', () => bar.remove());

        async function commit() {
            const name = nameInput.value.trim();
            if (!name) { nameInput.focus(); return; }
            saveBtn.textContent = 'Saving…'; saveBtn.disabled = true;
            try {
                // Fetch raw note content
                const noteResp = await fetch('/api/note?selector=' + encodeURIComponent(_activeSelector));
                const noteData = await noteResp.json();
                const content  = noteData.raw ?? noteData.body ?? '';

                const nb = _activeSelector.includes(':') ? _activeSelector.split(':')[0] : 'home';
                const resp = await fetch('/api/templates', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ name, content, scope: scopeSel.value, notebook: nb }),
                });
                const rd = await resp.json();
                if (rd.success) {
                    bar.remove();
                    // Brief flash in title area
                    const ref = document.getElementById('nb-preview-ref');
                    if (ref) { const orig = ref.textContent; ref.textContent = '✓ saved'; setTimeout(() => ref.textContent = orig, 2000); }
                } else {
                    alert('Save failed: ' + (rd.error || 'unknown'));
                    saveBtn.textContent = 'Save'; saveBtn.disabled = false;
                }
            } catch(e) { alert('Save error: ' + e); saveBtn.textContent = 'Save'; saveBtn.disabled = false; }
        }

        nameInput.addEventListener('keydown', e => {
            if (e.key === 'Enter')  { e.preventDefault(); commit(); }
            if (e.key === 'Escape') bar.remove();
        });
        saveBtn.addEventListener('click', commit);
    }

    // ── Keyboard navigation ────────────────────────────────────────

    function _bindKeyboard() {
        const previewContent = document.getElementById('nb-preview-content');
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

        document.getElementById('nb-cmd-bar')?.addEventListener('click', () => {
            if (_isFullscreen) _toggleFullscreen();
        });

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && _isFullscreen) { _toggleFullscreen(); return; }

            // Ctrl+Enter: save while editing (before input guard)
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && _editing) {
                e.preventDefault();
                document.getElementById('nb-save-btn')?.click();
                return;
            }

            // Escape from inputs: blur and park focus on menu button
            if (e.key === 'Escape' && ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) {
                e.preventDefault();
                document.activeElement.blur();
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
                    case 'ArrowRight':
                    case 'Enter': {
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
                    case 'Enter': {
                        const doneBtn = document.getElementById('nb-done-btn');
                        if (doneBtn && !doneBtn.hidden) { e.preventDefault(); doneBtn.click(); }
                        break;
                    }
                }
            }

            // Global shortcuts — skip while editing or when an inline bar has focus
            if (_editing) return;
            if (e.target.closest('#nb-done-bar, .nb-move-bar, #nb-action-panel')) return;
            switch (e.key) {
                case 'Escape': {
                    if (_selectedSelectors.size) { e.preventDefault(); _clearSelection(); break; }
                    const menu = document.getElementById('nb-side-menu');
                    if (!menu?.classList.contains('open')) {
                        e.preventDefault();
                        document.getElementById('nb-logo-btn')?.click();
                    }
                    break;
                }
                case 'a': e.preventDefault(); NbNav.activateCmd('add');       break;
                case 'l': e.preventDefault(); NbNav.activateCmd('list');      break;
                case 'c': e.preventDefault(); document.getElementById('nb-cal-icon')?.click(); break;
                case 'C': e.preventDefault(); NbNav.activateCmd('contacts');  break;
                case 's': e.preventDefault(); document.getElementById('nb-search')?.focus();   break;
                case 'n': e.preventDefault(); document.querySelector('.nb-scope-select')?.focus(); break;
                case 'p': e.preventDefault(); _setKbPane('preview');          break;
                case 'e': if (_activeSelector) { e.preventDefault(); _openEditor(); } break;
                case 'T': e.preventDefault(); NbTerminal.open();               break;
                case ',': e.preventDefault(); NbTerminal.openSettings();       break;
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
        document.getElementById('nb-done-btn').addEventListener('click', _markTodoDone);
        document.getElementById('nb-edit-btn').addEventListener('click', () => _openEditor());
        // nb-save-btn onclick is set contextually: _saveNote in _openEditor, _saveSheet in sheet onload
        document.getElementById('nb-cancel-btn').addEventListener('click', _closeEditor);
        document.getElementById('nb-delete-btn').addEventListener('click', _deleteNote);
        document.getElementById('nb-pin-indicator')?.addEventListener('click', _togglePin);

        // Format toolbar
        document.querySelectorAll('[data-fmt]').forEach(btn => {
            btn.addEventListener('click', () => _applyFmt(btn.dataset.fmt));
        });
    }

    // Single source of truth for preview-pane button visibility.
    // Prevents the double-row situation where preview-actions and editor-toolbar
    // are simultaneously visible, or the done-bar stacks on top of them.
    function _setPaneMode(mode) {
        document.getElementById('nb-done-bar')?.remove();
        const previewActions = document.getElementById('nb-preview-actions');
        const editorWrap     = document.getElementById('nb-editor-wrap');
        const previewContent = document.getElementById('nb-preview-content');
        if (mode === 'edit') {
            previewActions.hidden = true;
            editorWrap.hidden     = false;
            previewContent.hidden = true;
        } else {
            previewActions.hidden = false;
            editorWrap.hidden     = true;
            previewContent.hidden = false;
        }
    }

    function _openEditor(targetSelector) {
        const sel = targetSelector || _activeSelector;
        if (!sel) return;
        _activeSelector = sel;
        _editing = true;
        _setPaneMode('edit');
        fetch('/api/note?selector=' + encodeURIComponent(sel))
            .then(r => r.json())
            .then(d => {
                const raw = d.raw || d.body || '';
                _undoBuffer[sel] = raw;
                const ta = document.getElementById('nb-editor');
                ta.value = raw;
                document.getElementById('nb-save-btn').onclick = _saveNote;
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
            if (d.success) {
                const savedSel = _activeSelector;
                _closeEditor();
                _noAutoSelect = true;
                NbNav.reexecute();
                openNote(savedSel).finally(() => { _noAutoSelect = false; });
            }
            else alert('Save failed: ' + (d.stderr || 'unknown error'));
        } finally {
            btn.textContent = 'Save';
        }
    }

    function _closeEditor() {
        _editing = false;
        _setPaneMode('preview');
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
            const deleted = _activeSelector;
            _activeSelector = null;
            // Remove synchronously from DOM and cache — don't wait for server round-trip
            document.querySelectorAll('#nb-list .nb-list-item').forEach(el => {
                if (el.dataset.selector === deleted) el.remove();
            });
            _lastNotes = (_lastNotes || []).filter(n => n.selector !== deleted);
            _pendingDeletes.add(deleted);
            document.getElementById('nb-preview-toolbar').hidden = true;
            document.getElementById('nb-preview-content').innerHTML =
                '<div id="nb-welcome"><h2>nb-web</h2><p>Note deleted.</p></div>';
            NbNav.reexecute();
        }
    }

    // ── Pre-close rules ────────────────────────────────────────────
    // Each rule: { tags: string[], action: async (note, doClose) => void }
    // action receives the fetched note and a doClose(nugget) callback.
    // Rules whose tags intersect the note's tags are run; unmatched todos
    // close immediately with no UI.

    const _PRE_CLOSE_RULES = [
        {
            tags: ['bug', 'rfe'],
            action: _commitPickerAction,
        },
        // Future rules:
        // { tags: ['timer'],  action: _timeElapsedAction },
        // { tags: ['remind'], action: _followUpAction },
    ];

    async function _markTodoDone() {
        if (!_activeSelector) return;
        document.getElementById('nb-done-bar')?.remove();

        // Fetch note once — used for tag check, passed to action (avoids re-fetch)
        const nr = await fetch('/api/note?selector=' + encodeURIComponent(_activeSelector));
        const note = await nr.json();
        const noteTags = (note.tags || []).map(t => t.toLowerCase().replace(/^#/, ''));

        const matched = _PRE_CLOSE_RULES.filter(rule =>
            rule.tags.some(tag => noteTags.includes(tag))
        );

        if (!matched.length) {
            await _doCloseTodo('', note);
            return;
        }

        // Run first matching rule (extensible to sequential chain later)
        await matched[0].action(note, _doCloseTodo);
    }

    async function _doCloseTodo(nugget, note) {
        if (nugget) {
            const newContent = (note.raw || note.body || '').trimEnd()
                + `\n\n> fixed: ${nugget}\n`;
            await fetch('/api/note', {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ selector: _activeSelector, content: newContent }),
            });
        }
        const r = await fetch('/api/todo', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ selector: _activeSelector, done: true }),
        });
        const d = await r.json();
        if (d.success) {
            document.getElementById('nb-done-bar')?.remove();
            NbNav.reexecute();
            openNote(_activeSelector);
        } else {
            alert('Failed: ' + (d.stderr || 'unknown'));
        }
    }

    async function _commitPickerAction(note, doClose) {
        const toolbar = document.getElementById('nb-preview-toolbar');
        const bar = document.createElement('div');
        bar.id = 'nb-done-bar';
        bar.className = 'nb-move-bar';

        const lbl = document.createElement('span');
        lbl.className = 'nb-move-label';
        lbl.textContent = 'Fixed in:';

        const sel = document.createElement('select');
        sel.className = 'nb-scope-select';
        sel.style.colorScheme = 'dark';
        sel.style.flex = '1';
        sel.style.maxWidth = '420px';

        const noneOpt = document.createElement('option');
        noneOpt.value = ''; noneOpt.textContent = '(no commit)';
        sel.appendChild(noneOpt);

        fetch('/api/git/log?n=8').then(r => r.json()).then(d => {
            (d.commits || []).forEach((c, i) => {
                const opt = document.createElement('option');
                const subj = c.subject.length > 72 ? c.subject.slice(0, 69) + '…' : c.subject;
                opt.value       = `\`${c.hash}\` ${c.subject}`;
                opt.textContent = `${c.hash}  ${subj}`;
                sel.appendChild(opt);
                if (i === 0) opt.selected = true;
            });
        });

        const doneBtn = document.createElement('button');
        doneBtn.className   = 'nb-tool-btn nb-btn-primary';
        doneBtn.textContent = 'Done';

        const editBtn = document.createElement('button');
        editBtn.className   = 'nb-tool-btn';
        editBtn.textContent = 'Edit';

        const skipBtn = document.createElement('button');
        skipBtn.className   = 'nb-tool-btn';
        skipBtn.textContent = 'Skip';

        bar.append(lbl, sel, doneBtn, editBtn, skipBtn);
        document.getElementById('nb-preview-actions').hidden = true;
        toolbar.parentNode.insertBefore(bar, toolbar.nextSibling);
        sel.focus();

        const run = async (nugget) => {
            doneBtn.disabled = editBtn.disabled = skipBtn.disabled = true;
            doneBtn.textContent = 'Marking…';
            try { await doClose(nugget, note); }
            finally { doneBtn.textContent = 'Done'; doneBtn.disabled = editBtn.disabled = skipBtn.disabled = false; }
        };

        doneBtn.addEventListener('click', () => run(sel.value));
        editBtn.addEventListener('click', () => { bar.remove(); _openEditor(); });
        skipBtn.addEventListener('click', () => run(''));
        bar.addEventListener('keydown', e => {
            if (e.key === 'Enter')  run(sel.value);
            if (e.key === 'Escape') {
                bar.remove();
                document.getElementById('nb-preview-actions').hidden = false;
            }
        });
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

    // Parse CLI-style grep args: "g -B 2 -A 3 -I pattern"
    function _parseGrepArgs(raw) {
        const opts = { before: 0, after: 0, caseSensitive: false,
                       fixed: false, word: false, all: false, invert: false, pattern: '' };
        let s = raw;
        s = s.replace(/-B\s*(\d+)/g,  (_, n) => { opts.before = +n; return ''; });
        s = s.replace(/-A\s*(\d+)/g,  (_, n) => { opts.after  = +n; return ''; });
        s = s.replace(/-C\s*(\d+)/g,  (_, n) => { opts.before = opts.after = +n; return ''; });
        s = s.replace(/--all\b/g,     () => { opts.all           = true; return ''; });
        s = s.replace(/-I\b/g,        () => { opts.caseSensitive = true; return ''; });
        s = s.replace(/-F\b/g,        () => { opts.fixed         = true; return ''; });
        s = s.replace(/-w\b/g,        () => { opts.word          = true; return ''; });
        s = s.replace(/-v\b/g,        () => { opts.invert        = true; return ''; });
        opts.pattern = s.trim().replace(/\s{2,}/g, ' ');
        return opts;
    }

    // Matches nb selectors: notebook:id, notebook:filename, or bare id
    // e.g. tasks:87  home:20260430.md  claude:3
    const _selectorPat = /^([a-z][a-z0-9_-]*):(\d+|[\w.-]+\.(?:md|org|txt|adoc))$/i;
    const _bareIdPat   = /^\d+$/;

    function _dispatchQuery(raw) {
        const q = raw.trim();
        if (!q) {
            NbNav.reexecute();
            return;
        }

        // Cal is active — re-run it with the updated search query as a post-filter
        if (NbNav.activeCmd === 'cal') { NbNav.reexecute(); return; }

        // Grep shorthand: "g <args>" in search bar — full flag parsing
        const gMatch = q.match(/^(?:nb\s+)?g\s+(.+)/i);
        if (gMatch) {
            const opts = _parseGrepArgs(gMatch[1]);
            if (opts.pattern) runGrep(opts);
            return;
        }

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
        NbNav.reexecute();
    }

    function _bindTags() {
        const input = document.getElementById('nb-tags');
        if (!input) return;
        const clear = document.getElementById('nb-tags-clear');
        let _tagsTimer;

        input.addEventListener('input', () => {
            clear.hidden = !input.value;
            clearTimeout(_tagsTimer);
            const raw = input.value.trim();
            const q   = raw ? (raw.startsWith('#') ? raw : `#${raw}`) : '';
            NbNav.setTagsQuery(q);
            _tagsTimer = setTimeout(() => {
                NbNav.reexecute();
            }, 400);
        });

        clear.addEventListener('click', () => {
            input.value = '';
            clear.hidden = true;
            NbNav.setTagsQuery('');
            NbNav.reexecute();
        });
    }

    function _bindSearch() {
        const input = document.getElementById('nb-search');
        const clear = document.getElementById('nb-search-clear');

        input.addEventListener('input', () => {
            clear.hidden = !input.value;
            NbNav.setSearchQuery(input.value);
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
            NbNav.setSearchQuery('');
            if (NbNav.activeCmd === 'cal') NbNav.reexecute();
            else loadNotes();
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

        // Enter → Create; Ctrl+Enter → Create and open editor
        // Attach directly to each input (not delegated) to avoid interference
        // from the global document keydown guard that returns early for INPUTs.
        ['nf-title', 'nf-tags', 'nf-url', 'nf-comment'].forEach(id => {
            document.getElementById(id)?.addEventListener('keydown', e => {
                if (e.key !== 'Enter' || e.shiftKey) return;
                const btn = document.getElementById('nf-save');
                if (btn?.disabled) return;   // guard against key-repeat during async submit
                e.preventDefault();
                _submitAdd(type, e.ctrlKey || e.metaKey);
            });
        });
        document.getElementById('nf-content')?.addEventListener('keydown', e => {
            if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
            const btn = document.getElementById('nf-save');
            if (btn?.disabled) return;
            e.preventDefault();
            _submitAdd(type, true);
        });
    }

    async function _submitAdd(type, andEdit = false) {
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
                // Switch to list and refresh — reexecute() is a no-op when _activeCmd==='add'
                _noAutoSelect = true;
                NbNav.activateCmd('list', { internal: true });
                if (andEdit && d.selector) {
                    await openNote(d.selector);
                    _noAutoSelect = false;
                    _openEditor(d.selector);
                } else if (d.selector) {
                    openNote(d.selector).finally(() => { _noAutoSelect = false; });
                } else {
                    _noAutoSelect = false;
                }
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
            else NbNav.reexecute();
        } finally {
            if (btn) btn.classList.remove('nb-spin');
        }
    }

    function _bindSync() {
        document.getElementById('nb-sync-btn')?.addEventListener('click', doSync);
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

    async function addNote({ notebook, type, title, url, template_path }) {
        try {
            const r = await fetch('/api/notes', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ notebook, type, title, url,
                                       tags: [], content: '', comment: '',
                                       template_path: template_path || '' }),
            });
            const d = await r.json();
            if (d.success) { return d; }
            alert('Add failed: ' + (d.error || 'unknown'));
            return null;
        } catch(e) {
            alert('Add failed: ' + String(e));
            return null;
        }
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
            const html = _renderMarkdown(d.content || '');
            const scopeLabel = scope === 'local' ? '📒 notebook' : '🌐 global';
            content.innerHTML = `
                <div style="padding:10px 32px 8px;font-size:11px;color:var(--text-dim);
                            font-family:var(--font-mono);border-bottom:1px solid var(--border);
                            display:flex;align-items:center;gap:12px">
                    <span>📋 <strong>${_esc(name)}</strong></span>
                    <span style="opacity:0.6">${scopeLabel}</span>
                </div>
                <div class="nb-rendered" style="padding:24px 32px;opacity:0.75">${html}</div>`;
        } catch(e) {
            content.innerHTML = '<div style="padding:40px;color:var(--text-muted)">Could not load template.</div>';
        }
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
                const scopeLabel = t.scope === 'local' ? nb : 'global';
                const item = makeTmplItem(
                    t.scope === 'local' ? '📒' : '🌐',
                    t.name,
                    scopeLabel,
                    t.path === curTemplate,
                    () => {
                        NbNav.setAddTemplate(t.path);
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
        } catch(e) {
            countEl.textContent = 'error';
            console.error('loadTemplatesForAdd:', e);
        }
    }

    async function runTemplates() {
        const nb = NbNav.notebook === '_all' ? 'home' : NbNav.notebook;
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
            const d = await r.json();
            const templates = d.templates || [];

            countEl.textContent = `${templates.length} template${templates.length !== 1 ? 's' : ''}`;

            if (!templates.length) {
                empty.hidden = false;
                empty.textContent = 'No templates found.';
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
                    icon.title = t.scope === 'local' ? 'Notebook export template' : 'Global export template';
                } else {
                    icon.textContent = t.scope === 'local' ? '📒' : '🌐';
                    icon.title = t.scope === 'local' ? 'Notebook template' : 'Global template';
                }

                const title = document.createElement('span');
                title.className = 'nb-list-title';
                title.textContent = t.template_type === 'export_html' ? 'HTML export template' : t.name;

                const excerpt = document.createElement('span');
                excerpt.className = 'nb-list-excerpt';
                excerpt.textContent = t.scope === 'local' ? `${nb}: export` : 'global export';
                if (t.template_type !== 'export_html') {
                    excerpt.textContent = t.scope === 'local' ? `${nb}: template` : 'global';
                }

                li.append(icon, title, excerpt);
                li.addEventListener('click', () => {
                    list.querySelectorAll('.nb-list-item').forEach(el => el.classList.remove('active'));
                    li.classList.add('active');
                    if (t.template_type === 'export_html') {
                        _openExportTemplate(t.path, t.name, t.scope);
                    } else {
                        _openTemplate(t.path, t.name, t.scope);
                    }
                });
                list.appendChild(li);
            });

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

    async function _openTemplate(path, name, scope) {
        const content = document.getElementById('nb-preview-content');
        content.innerHTML = '<div style="padding:40px;color:var(--text-muted)">Loading…</div>';
        document.getElementById('nb-preview-toolbar').hidden = true;

        try {
            const r = await fetch('/api/template?path=' + encodeURIComponent(path));
            const d = await r.json();
            const raw = d.content || '';
            const scopeLabel = scope === 'local' ? '📒 notebook' : '🌐 global';
            let latestRaw = raw;  // local — reset per _openTemplate call, no stale cross-template state

            const showPreview = () => {
                content.innerHTML = `
                    <div style="padding:10px 32px 8px;font-size:11px;color:var(--text-dim);
                                font-family:var(--font-mono);border-bottom:1px solid var(--border);
                                display:flex;align-items:center;gap:12px">
                        <span>📋 <strong>${_esc(name)}</strong></span>
                        <span style="opacity:0.6">${scopeLabel}</span>
                    </div>
                    <div class="nb-rendered" style="padding:24px 32px;opacity:0.75">${_renderMarkdown(latestRaw)}</div>`;

                // Render CSV blocks; then reclaim the note-save button (we use our own footer btn)
                _renderCsvBlocks(content.querySelector('.nb-rendered'));
                const ssb = document.getElementById('nb-sheet-save-btn');
                if (ssb) { ssb.hidden = true; ssb.onclick = null; }
                const hasCsvBlocks = !!content.querySelector('.nb-csv-block');

                // Append footer via DOM — innerHTML+= would destroy jspreadsheet instances
                const footer = document.createElement('div');
                footer.style.cssText = 'padding:10px 32px 14px;border-top:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap';
                const curNb = NbNav.notebook === '_all' ? 'home' : NbNav.notebook;
                const nbOptions = NbNav.notebooks
                    .map(n => `<option value="${_esc(n)}"${n === curNb ? ' selected' : ''}>${_esc(n)}</option>`)
                    .join('');
                footer.innerHTML = `
                    <input type="text" id="nb-tmpl-title" class="nb-opt-input"
                           placeholder="Note title…" style="flex:1;min-width:120px">
                    <button id="nb-tmpl-create" class="nb-tool-btn nb-btn-primary">Create note</button>
                    ${hasCsvBlocks ? '<button id="nb-tmpl-sheet-save" class="nb-tool-btn">Save sheet</button>' : ''}
                    <button id="nb-tmpl-edit"   class="nb-tool-btn">Edit</button>
                    <button id="nb-tmpl-delete" class="nb-tool-btn nb-btn-danger">Delete</button>
                    <span style="margin-left:auto;display:flex;align-items:center;gap:4px">
                      <select id="nb-tmpl-default-nb" class="nb-scope-select" title="Target notebook">${nbOptions}</select>
                      <button id="nb-tmpl-set-default" class="nb-tool-btn" title="Copy to notebook's .templates/ so it auto-applies on Add">📌 Set default</button>
                    </span>`;
                content.appendChild(footer);

                const titleEl  = document.getElementById('nb-tmpl-title');
                const createEl = document.getElementById('nb-tmpl-create');

                async function _doCreate() {
                    const title = titleEl.value.trim();
                    if (!title) { titleEl.focus(); return; }
                    createEl.textContent = 'Creating…'; createEl.disabled = true;
                    try {
                        const ok = await addNote({
                            notebook:      NbNav.notebook === '_all' ? 'home' : NbNav.notebook,
                            type:          'note', title, url: '', template_path: path,
                        });
                        if (ok) { NbNav.activateCmd('list'); if (ok.selector) openNote(ok.selector); }
                    } finally { createEl.textContent = 'Create note'; createEl.disabled = false; }
                }
                createEl.addEventListener('click', _doCreate);
                titleEl.addEventListener('keydown', e => {
                    if (e.key === 'Enter')  _doCreate();
                    if (e.key === 'Escape') titleEl.value = '';
                });
                requestAnimationFrame(() => titleEl.focus());

                document.getElementById('nb-tmpl-edit').addEventListener('click', showEditor);

                document.getElementById('nb-tmpl-delete').addEventListener('click', async () => {
                    if (!confirm(`Delete template "${name}"?`)) return;
                    const dr = await fetch('/api/template?path=' + encodeURIComponent(path),
                        { method: 'DELETE' });
                    const dd = await dr.json();
                    if (dd.success) runTemplates();
                    else alert('Delete failed: ' + (dd.error || 'unknown'));
                });

                document.getElementById('nb-tmpl-set-default').addEventListener('click', async () => {
                    const btn = document.getElementById('nb-tmpl-set-default');
                    const nb  = document.getElementById('nb-tmpl-default-nb').value;
                    btn.textContent = 'Setting…'; btn.disabled = true;
                    try {
                        const sr = await fetch('/api/template/default', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ template_path: path, notebook: nb }),
                        });
                        const sd = await sr.json();
                        if (sd.success) {
                            btn.textContent = '✓ Set';
                            setTimeout(() => { btn.textContent = '📌 Set default'; btn.disabled = false; }, 1500);
                        } else {
                            alert('Failed: ' + (sd.error || 'unknown'));
                            btn.textContent = '📌 Set default'; btn.disabled = false;
                        }
                    } catch(e) {
                        alert('Error: ' + e);
                        btn.textContent = '📌 Set default'; btn.disabled = false;
                    }
                });

                if (hasCsvBlocks) {
                    document.getElementById('nb-tmpl-sheet-save').addEventListener('click', async () => {
                        const btn = document.getElementById('nb-tmpl-sheet-save');
                        btn.textContent = 'Saving…'; btn.disabled = true;
                        try {
                            const hosts = [...content.querySelectorAll('.nb-csv-block')];
                            let blockIdx = 0;
                            const newRaw = latestRaw.replace(/```csv\n([\s\S]*?)```/g, (match) => {
                                const host = hosts[blockIdx++];
                                if (!host?.spreadsheet) return match;
                                const data = host.spreadsheet.worksheets[0].getData();
                                const csv  = data.map(row =>
                                    row.map(cell => {
                                        const s = String(cell ?? '');
                                        return s.includes(',') || s.includes('"') || s.includes('\n')
                                            ? `"${s.replace(/"/g, '""')}"` : s;
                                    }).join(',')
                                ).join('\n');
                                return '```csv\n' + csv + '\n```';
                            });
                            const sr = await fetch('/api/template', {
                                method: 'PUT',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({ path, content: newRaw }),
                            });
                            const sd = await sr.json();
                            if (sd.success) {
                                latestRaw = newRaw;
                                btn.textContent = '✓ Saved';
                                setTimeout(() => { btn.textContent = 'Save sheet'; btn.disabled = false; }, 1400);
                            } else {
                                alert('Save failed: ' + (sd.error || 'unknown'));
                                btn.textContent = 'Save sheet'; btn.disabled = false;
                            }
                        } catch(e) {
                            alert('Save error: ' + e);
                            btn.textContent = 'Save sheet'; btn.disabled = false;
                        }
                    });
                }
            };

            const showEditor = () => {
                content.innerHTML = `
                    <div style="padding:10px 32px 8px;font-size:11px;color:var(--text-dim);
                                font-family:var(--font-mono);border-bottom:1px solid var(--border);
                                display:flex;align-items:center;gap:12px">
                        <span>✏️ <strong>${_esc(name)}</strong></span>
                        <span style="opacity:0.6">${scopeLabel}</span>
                    </div>
                    <textarea id="nb-tmpl-editor" spellcheck="false"
                        style="flex:1;width:100%;box-sizing:border-box;padding:16px 32px;
                               border:none;outline:none;resize:none;font-family:var(--font-mono);
                               font-size:13px;background:var(--bg);color:var(--text);
                               min-height:260px">${_esc(latestRaw)}</textarea>
                    <div style="padding:10px 32px 14px;border-top:1px solid var(--border);
                                display:flex;gap:8px">
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
                        if (sd.success) {
                            latestRaw = newContent;
                            showPreview();
                        } else alert('Save failed: ' + (sd.error || 'unknown'));
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

    // ── Cal results ────────────────────────────────────────────────

    async function runCal({ start, end, notebook }) {
        const seq    = ++_listSeq;
        const params = new URLSearchParams();
        if (notebook && notebook !== '_all') params.set('notebook', notebook);
        if (start) params.set('start', start);
        if (end)   params.set('end',   end);

        // Pass the primary query to the server — cal plugin greps note content
        // within the date range (server-side, not title-only).
        // If both search and tag are active, send search; tag post-filters client-side.
        const sq = NbNav.searchQuery?.trim();
        const tq = NbNav.tagsQuery?.trim();
        const serverQ = sq || tq || '';
        if (serverQ) params.set('q', serverQ);

        const content = document.getElementById('nb-preview-content');
        document.getElementById('nb-preview-toolbar').hidden = true;

        try {
            const r = await fetch('/api/cal?' + params);
            const d = await r.json();
            const entries = d.entries || [];

            let notes = entries.map(e => {
                const isDone  = e.done;
                const isTodo  = e.title.startsWith('[ ]') || isDone;
                return {
                    selector:  e.selector,
                    title:     e.title.replace(/^\[.\]\s*/, ''),
                    filename:  e.title,
                    type:      isTodo ? 'todo' : 'note',
                    id:        e.selector.split(':').pop(),
                    excerpt:   e.date,
                    indicator: isDone ? '✔' : isTodo ? '○' : '',
                };
            });

            // If both search AND tag are active, the server only ran one of them —
            // apply the other as a client-side title filter.
            if (sq && tq) {
                const tqLower = tq.toLowerCase().replace(/^#/, '');
                notes = notes.filter(n => (n.title || '').toLowerCase().includes(tqLower));
            }

            if (seq !== _listSeq) return;
            renderList(notes);

            if (!notes.length) {
                content.innerHTML = '<div style="padding:40px;color:var(--text-muted)">No notes in this date range.</div>';
            } else if (_activeSelector && notes.some(n => n.selector === _activeSelector)) {
                // Active note is in the cal results — refresh its preview
                openNote(_activeSelector, false, { autoSelect: true });
            }
            // else: auto-select already fired in renderList for the first item
        } catch (e) {
            console.error('runCal:', e);
        }
    }

    // ── Grep ────────────────────────────────────────────────────────

    async function runGrep(opts) {
        if (!opts.pattern) {
            _showCmdOutput('g', '(enter a pattern above and press run ↵)');
            return;
        }
        const seq = ++_listSeq;
        _showPreviewLoading();
        const params = new URLSearchParams({ q: opts.pattern });
        params.set('notebook', opts.all ? '_all' : NbNav.notebook);
        // Context lines: opts.context (symmetric) or opts.before / opts.after (asymmetric)
        const B = opts.context > 0 ? opts.context : (opts.before || 0);
        const A = opts.context > 0 ? opts.context : (opts.after  || 0);
        if (B > 0) params.set('B', B);
        if (A > 0) params.set('A', A);
        if (opts.caseSensitive) params.set('sensitive', '1');
        if (opts.fixed)         params.set('fixed', '1');
        if (opts.word)          params.set('word',  '1');

        try {
            const r = await fetch('/api/grep?' + params);
            const d = await r.json();
            const notes = (d.results || []).map(res => ({
                selector:  res.selector,
                title:     res.title,
                type:      res.type || 'note',
                id:        res.id,
                indicator: res.indicator || '',
                excerpt:   null,
                grepLines: res.lines || [],
            }));
            if (seq !== _listSeq) return;
            renderList(notes);
            const content = document.getElementById('nb-preview-content');
            content.innerHTML = notes.length
                ? '<div style="padding:40px;color:var(--text-muted)">Select a result to preview.</div>'
                : '<div style="padding:40px;color:var(--text-muted)">No matches found.</div>';
            document.getElementById('nb-preview-toolbar').hidden = true;
        } catch (e) {
            console.error('runGrep:', e);
        }
    }

    // ── Util ───────────────────────────────────────────────────────

    function _esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // Returns local YYYY-MM-DD, optionally offset by daysAhead.
    // Uses local time, not UTC, so dates are correct for any timezone.
    function _localDateStr(daysAhead = 0) {
        const d = new Date(Date.now() + daysAhead * 86400000);
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }

    function resetAndLoad() {
        const searchEl = document.getElementById('nb-search');
        const clearEl  = document.getElementById('nb-search-clear');
        if (searchEl) searchEl.value = '';
        if (clearEl)  clearEl.hidden = true;
        clearTimeout(_searchTimer);
        loadNotes();
    }

    function showAbout() {
        document.getElementById('nb-preview-toolbar').hidden = true;
        const build = document.getElementById('nb-menu-build')?.textContent || '–';
        document.getElementById('nb-preview-content').innerHTML = `
            <div style="padding:48px 40px;max-width:480px">
                <h2 style="margin:0 0 .3em">nb-web</h2>
                <p style="color:var(--text-muted);margin:0 0 1.5em">
                    A lightweight PWA web interface for
                    <a href="https://github.com/xwmx/nb" style="color:var(--accent)">nb</a>.
                </p>
                <hr style="border:none;border-top:1px solid var(--border);margin:0 0 1.2em">
                <p style="font-size:13px;color:var(--text-muted)">Build: <code>${_esc(build)}</code></p>
                <p style="font-size:13px;color:var(--text-muted)">
                    Edit <code>cmds.txt</code> to customise the sidebar menu.
                </p>
            </div>`;
    }

    const _IMPORT_MAX_MB    = 25;
    const _IMPORT_MAX_FILES = 20;

    async function _importPaths(paths, notebookOverride, folderOverride) {
        if (!paths || !paths.length) return;
        _showPreviewLoading();
        const nb     = notebookOverride || (NbNav.notebook === '_all' ? 'home' : NbNav.notebook);
        const folder = folderOverride || '';
        try {
            const r = await fetch('/api/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paths, notebook: nb, folder }),
            });
            const d = await r.json();
            const text = d.lines ? d.lines.join('\n')
                       : d.success ? '✓ Imported'
                       : `✗ ${d.error || 'failed'}`;
            _showCmdOutput('import', text);
        } catch(e) {
            _showCmdOutput('import', `✗ ${e}`);
        }
        NbNav.reexecute();
    }

    async function _importFiles(files, notebookOverride, folderOverride) {
        if (!files.length) return;

        // Client-side quantity guard
        if (files.length > _IMPORT_MAX_FILES) {
            _showCmdOutput('import',
                `✗ Too many files selected (${files.length}). Import at most ${_IMPORT_MAX_FILES} at a time.`);
            return;
        }

        // Client-side size guard (avoids sending obviously oversized files)
        const tooBig = files.filter(f => f.size > _IMPORT_MAX_MB * 1024 * 1024);
        if (tooBig.length) {
            _showCmdOutput('import',
                tooBig.map(f => `✗ ${f.name}: exceeds ${_IMPORT_MAX_MB} MB limit`).join('\n'));
            return;
        }

        _showPreviewLoading();
        const nb     = notebookOverride || (NbNav.notebook === '_all' ? 'home' : NbNav.notebook);
        const folder = folderOverride || '';
        const lines = [];
        for (const file of files) {
            const fd = new FormData();
            fd.append('file', file);
            fd.append('notebook', nb);
            if (folder) fd.append('folder', folder);
            try {
                const r = await fetch('/api/import', { method: 'POST', body: fd });
                const d = await r.json();
                lines.push(d.success ? `✓ ${file.name}` : `✗ ${file.name}: ${d.error || d.stderr || 'failed'}`);
            } catch(e) {
                lines.push(`✗ ${file.name}: ${e}`);
            }
        }
        _showCmdOutput('import', lines.join('\n'));
        NbNav.reexecute();
    }

    function doLinkFile() {
        const nb = NbNav.notebook === '_all' ? 'home' : NbNav.notebook;

        // Build a small inline prompt in the preview area
        const previewContent = document.getElementById('nb-preview-content');
        const previewToolbar = document.getElementById('nb-preview-toolbar');
        if (!previewContent) return;
        previewToolbar.hidden = true;
        previewContent.innerHTML = `
            <div style="padding:48px 40px;max-width:560px">
                <h2 style="margin:0 0 .3em">Link file into notebook</h2>
                <p style="color:var(--text-muted);font-size:0.88em;margin:0 0 1.6em">
                    Creates a symlink in <strong>${_esc(nb)}</strong> pointing at a file on your filesystem.
                    Edits through nb-web will modify the original file.
                </p>
                <label style="display:block;font-size:0.8em;color:var(--text-muted);margin-bottom:4px">
                    Filesystem path
                </label>
                <input id="nb-link-path" type="text"
                    placeholder="/home/you/project/README.md  or  ~/notes/journal.md"
                    autocomplete="off" spellcheck="false"
                    style="width:100%;background:var(--bg3);border:1px solid var(--border);
                           color:var(--text);border-radius:4px;padding:7px 10px;
                           font-family:var(--font-mono);font-size:0.88em;box-sizing:border-box">
                <div style="display:flex;gap:8px;margin-top:1.2em;align-items:center">
                    <button id="nb-link-btn" class="nb-btn-primary" style="padding:7px 20px">Link</button>
                    <span id="nb-link-status" style="font-size:0.85em;color:var(--text-muted)"></span>
                </div>
            </div>`;

        const pathInput = document.getElementById('nb-link-path');
        const status    = document.getElementById('nb-link-status');
        pathInput.focus();

        async function doLink() {
            const path = pathInput.value.trim();
            if (!path) { status.textContent = 'Enter a path first'; return; }
            status.textContent = 'Linking…';
            status.style.color = '';
            try {
                const r = await fetch('/api/link-file', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path, notebook: nb }),
                });
                const d = await r.json();
                if (d.success) {
                    status.textContent = `✓ Linked ${d.name}`;
                    status.style.color = 'var(--accent)';
                    NbNav.reexecute();
                } else {
                    status.textContent = `✗ ${d.error}`;
                    status.style.color = 'var(--accent-neg, #e5534b)';
                }
            } catch(e) {
                status.textContent = `✗ ${e.message}`;
                status.style.color = 'var(--accent-neg, #e5534b)';
            }
        }

        document.getElementById('nb-link-btn').addEventListener('click', doLink);
        pathInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLink(); });
    }

    function _bindDropImport() {
        const overlay = document.getElementById('nb-drop-overlay');
        if (!overlay) return;

        // Capture drag events at document level so they fire even in Epiphany/WebKit
        document.addEventListener('dragenter', e => {
            if (!e.dataTransfer?.types.includes('Files')) return;
            e.preventDefault();
            overlay.classList.add('nb-drop-active');
        }, true);

        document.addEventListener('dragover', e => {
            if (!e.dataTransfer?.types.includes('Files')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        }, true);

        // Hide when drag leaves the browser window (relatedTarget is null at window edge)
        document.addEventListener('dragleave', e => {
            if (e.relatedTarget === null) overlay.classList.remove('nb-drop-active');
        }, true);

        overlay.addEventListener('drop', e => {
            e.preventDefault();
            overlay.classList.remove('nb-drop-active');
            const files = [...e.dataTransfer.files];
            if (files.length) _importFiles(files);
        });

        // Also handle drops that land outside the overlay (belt-and-suspenders)
        document.addEventListener('drop', e => {
            if (e.target === overlay) return;
            e.preventDefault();
            overlay.classList.remove('nb-drop-active');
            const files = [...e.dataTransfer.files];
            if (files.length) _importFiles(files);
        }, true);
    }

    // Fetch a note, render it (including tw/hl/csv codeblocks) in an off-screen
    // container, and return { title, html } with interactive controls stripped.
    // Used by bulk export to produce rendered output for each selected note.
    async function _renderNoteHtml(selector) {
        try {
            const r = await fetch('/api/note?selector=' + encodeURIComponent(selector));
            if (!r.ok) return null;
            const d = await r.json();
            if (d.body == null) return null;

            const container = document.createElement('div');
            container.style.cssText = 'position:fixed;left:-9999px;top:0;width:800px;visibility:hidden;pointer-events:none';
            document.body.appendChild(container);

            const inner = document.createElement('div');
            inner.className = 'nb-rendered';
            inner.innerHTML = _renderMarkdown(d.body);
            container.appendChild(inner);

            _renderCsvBlocks(container);
            await _renderTwBlocks(container);
            await _renderHledgerBlocks(container);
            await _renderTBlocks(container);

            const clone = container.cloneNode(true);
            document.body.removeChild(container);
            clone.querySelectorAll('button, form, .nb-spin').forEach(el => el.remove());

            return { title: d.title || d.filename || selector, html: clone.innerHTML };
        } catch { return null; }
    }

    return { init, loadNotes, resetAndLoad, resetSort, search, openNote, openToday,
             showAddForm, addNote, runCmd, runCal, runGrep, runTemplates, loadTemplatesForAdd,
             doSync, doLinkFile, showAbout, openEditor: _openEditor, closeEditor: _closeEditor,
             isEditing: () => _editing,
             importFiles: (files, nb, folder) => _importFiles(files, nb, folder),
             importPaths: (paths, nb, folder) => _importPaths(paths, nb, folder),
             exportFormats: _exportFormats,
             doPrint: _doPrint,
             clearNote,
             activeSelector: () => _activeSelector,
             activeType:     () => _activeType,
             activeFilename: () => _activeFilename,
             selectedSelectors: () => _selectedSelectors,
             clearSelection: _clearSelection,
             deselect: sel => { _selectedSelectors.delete(sel); _updateSelectionUI(); },
             renderNoteHtml: _renderNoteHtml };
})();

// ── Terminal + Settings-in-preview ────────────────────────────────
const NbTerminal = (() => {
    let _term = null;
    let _ws   = null;

    function _previewEl()  { return document.getElementById('nb-preview-content'); }
    function _toolbarEl()  { return document.getElementById('nb-preview-toolbar'); }

    function openSettings() {
        const el = _previewEl();
        if (!el) return;
        _toolbarEl().hidden = true;
        el.innerHTML = '<iframe src="/settings.html" style="width:100%;height:100%;min-height:600px;border:none"></iframe>';
    }

    async function open() {
        const el = _previewEl();
        if (!el) return;

        // Toggle off if already showing terminal
        if (el.querySelector('#nb-pty-wrap')) {
            close();
            return;
        }

        _toolbarEl().hidden = true;

        // Lazy-load xterm
        if (!window.Terminal) {
            await Promise.all([
                new Promise(r => { const s = document.createElement('script'); s.src = '/xterm.js'; s.onload = r; document.head.appendChild(s); }),
                new Promise(r => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/xterm.css'; l.onload = r; document.head.appendChild(l); }),
            ]);
        }

        // Load terminal settings
        let cfg = { pty_height: 320, pty_cwd: '', pty_init: '' };
        try { const r = await fetch('/api/nb-settings'); Object.assign(cfg, await r.json()); } catch {}
        const initH = parseInt(localStorage.getItem('nb-pty-height') || '0') || cfg.pty_height;

        el.innerHTML = `
            <div id="nb-pty-wrap" style="display:flex;flex-direction:column;height:100%;background:#0a0a0a">
                <div id="nb-pty-titlebar" style="display:flex;align-items:center;justify-content:space-between;
                     padding:4px 12px;background:#111;color:#aaa;font-size:12px;flex-shrink:0">
                    <span>terminal</span>
                    <button id="nb-pty-close" style="background:none;border:none;color:#aaa;cursor:pointer;font-size:1.1em;padding:2px 6px">×</button>
                </div>
                <div id="nb-pty-container" style="flex:1;overflow:hidden;padding:4px 6px"></div>
            </div>`;

        document.getElementById('nb-pty-close').addEventListener('click', close);

        const container = document.getElementById('nb-pty-container');
        const term = new window.Terminal({
            rows: 24, cols: 80,
            fontSize: 13,
            fontFamily: "'JetBrains Mono','Fira Code',monospace",
            theme: { background: '#0a0a0a', foreground: '#d4d4d8' },
            convertEol: true, scrollback: 500,
        });
        _term = term;
        term.open(container);
        term.focus();

        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${proto}://${location.host}/ws/pty`);
        _ws = ws;

        ws.onopen = () => {
            const cols = term.cols, rows = term.rows;
            ws.send(JSON.stringify({ cwd: cfg.pty_cwd || '', init: cfg.pty_init || '', cols, rows }));
        };
        ws.onmessage = e => term.write(e.data);
        ws.onclose   = ()  => { term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n'); setTimeout(close, 1500); };
        ws.onerror   = ()  => term.write('\r\n\x1b[31m[connection error]\x1b[0m\r\n');

        term.onData(data => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
        term.onResize(({ cols, rows }) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(`\x00resize:${cols},${rows}`);
        });
    }

    function close() {
        if (_ws)   { _ws.close();   _ws   = null; }
        if (_term) { _term.dispose(); _term = null; }
        const el = _previewEl();
        if (el) el.innerHTML = '';
        _toolbarEl().hidden = false;
        NbNav.reexecute();
        const sel = NbMain.activeSelector();
        if (sel) NbMain.openNote(sel, false);
    }

    return { open, close, openSettings };
})();

// ── Import / Export / Move panel ──────────────────────────────
const NbDialog = (() => {
    let _tab = 'import';
    let _bulkSelectors  = null; // null = single-note mode, array = bulk mode
    let _folderSelector = null; // non-null = folder mode
    let _folderName     = '';   // display name for folder being operated on

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
        const allTabs = [['import','📥 Import'], ['export','⬇ Export'], ['move','→ Move'], ['rename','✏ Rename']];
        const tabDefs = _bulkSelectors ? allTabs.filter(([id]) => id === 'export' || id === 'move') : allTabs;
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
        else if (_tab === 'rename')     _renderRename();
        else if (_tab === 'f-rename')   _renderFolderRename();
        else if (_tab === 'f-move')     _renderFolderMove();
        else if (_tab === 'f-delete')   _renderFolderDelete();
    }

    // ── Folder dialog ──────────────────────────────────────────
    function openFolder(selector, name) {
        _folderSelector = selector;
        _folderName     = name || selector;
        _bulkSelectors  = null;
        _tab = 'f-rename';
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
        [['f-rename','✏ Rename'], ['f-move','→ Move'], ['f-delete','🗑 Delete']].forEach(([id, label]) => {
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
        (folders || []).filter(f => f !== exclude).forEach(f => {
            const opt = document.createElement('option');
            opt.value = f; opt.textContent = f + '/';
            sel.appendChild(opt);
        });
        sel.disabled = !(folders || []).filter(f => f !== exclude).length;
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
                const payload = JSON.stringify({ selectors: _bulkSelectors });
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

            const compiledHtml = parts.join('\n<hr>\n');
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

        body.append(infoEl, nameRow, fmtRow);
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
            const dest = folderSel.value ? `${nbSel.value}:${folderSel.value}/` : `${nbSel.value}:`;
            moveBtn.textContent = 'Moving…'; moveBtn.disabled = true;
            let failed = 0;
            for (const sel of selectors) {
                try {
                    const resp = await fetch('/api/note/move', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ selector: sel, dest }),
                    });
                    const rd = await resp.json();
                    if (!rd.success) failed++;
                    else document.querySelector(`#nb-list .nb-list-item[data-selector="${CSS.escape(sel)}"]`)?.remove();
                } catch { failed++; }
            }
            if (failed) {
                alert(`${failed} move${failed !== 1 ? 's' : ''} failed.`);
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

    // ── Rename tab ─────────────────────────────────────────────
    function _renderRename() {
        const body     = _body();
        const selector = NbMain.activeSelector();
        if (!selector) {
            body.innerHTML = '<p class="nb-dlg-empty">No note selected — open a note first.</p>';
            return;
        }

        const nameInput = document.createElement('input');
        nameInput.type = 'text'; nameInput.className = 'nb-rename-input'; nameInput.style.flex = '1';
        nameInput.value = document.getElementById('nb-preview-title')?.textContent || '';
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
                    close();
                    document.getElementById('nb-preview-title').textContent = newName;
                    NbNav.reexecute();
                } else {
                    alert('Rename failed: ' + (d.stderr || 'unknown'));
                    saveBtn.textContent = 'Rename'; saveBtn.disabled = false;
                }
            } catch(e) { saveBtn.textContent = 'Rename'; saveBtn.disabled = false; }
        }

        saveBtn.addEventListener('click', commit);
        nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); });

        body.append(nameRow, btnRow);
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

    return { open, openFolder, close, isOpen, refresh, init };
})();

document.addEventListener('DOMContentLoaded', () => { NbMain.init(); NbDialog.init(); });

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
    let _kbPane         = 'list';   // 'list' | 'preview'
    const _pendingDeletes = new Set(); // selectors deleted but possibly not yet gone from server

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

    async function loadNotes(typeFilter, statusFilter) {
        const seq    = ++_listSeq;
        const nb     = NbNav.notebook;
        const folder = NbNav.folder;
        const params = new URLSearchParams({ notebook: nb });
        if (folder) params.set('folder', folder);

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
            } else if (note.excerpt) {
                const exc = document.createElement('div');
                exc.className = 'nb-list-excerpt';
                exc.textContent = note.excerpt;
                body.appendChild(exc);
            }

            if (pinBadge) li.appendChild(pinBadge);
            li.appendChild(icon);
            li.appendChild(body);

            if (note.type === 'folder') {
                li.addEventListener('click', () => {
                    if (NbNav.notebook === '_all' && note.notebook) {
                        NbNav.drillFolderInNotebook(note.notebook, note.filename);
                    } else {
                        NbNav.drillFolder(note.filename);
                    }
                });
            } else {
                li.addEventListener('click', () => openNote(note.selector));
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
            ref.title = 'Click for nb info';
            ref.style.cursor = 'pointer';
            ref.onclick = e => _showInfoPopover(e, note.selector || `${note.notebook}:${note.id}`);
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
                const tag = el.textContent;
                document.getElementById('nb-search').value = tag;
                search(tag);
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
    }

    // Walk text nodes in `root` and wrap 8-hex-char tokens as clickable uuid refs.
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
                return /\b[a-f0-9]{8}\b/i.test(node.textContent)
                    ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
            }
        });
        const nodes = [];
        let n;
        while ((n = walker.nextNode())) nodes.push(n);
        nodes.forEach(node => {
            const parts = node.textContent.split(/\b([a-f0-9]{8})\b/i);
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

        const rect = e.target.getBoundingClientRect();
        pop.style.top  = (rect.bottom + 6) + 'px';
        pop.style.left = rect.left + 'px';
        document.body.appendChild(pop);

        const pr = pop.getBoundingClientRect();
        if (pr.right > window.innerWidth - 8)
            pop.style.left = Math.max(8, rect.right - pr.width) + 'px';

        try {
            const isNbSelector = /^[a-z][a-z0-9_-]*:/.test(uuid);
            if (isNbSelector) {
                // notebook:id click from preview toolbar → nb info
                const r = await fetch('/api/run?cmd=info&selector=' + encodeURIComponent(uuid));
                const d = await r.json();
                pop.textContent = d.output || d.stderr || '(no output)';
            } else {
                // bare uuid8 in content → Taskwarrior task info
                const r = await fetch('/api/task-info?uuid=' + encodeURIComponent(uuid));
                const d = await r.json();
                if (d.output) {
                    pop.textContent = d.output;
                } else {
                    // fall back to nb info in case it's an nb UUID
                    const r2 = await fetch('/api/run?cmd=info&selector=' + encodeURIComponent(uuid));
                    const d2 = await r2.json();
                    pop.textContent = d2.output || '(no match found)';
                }
            }
        } catch(err) {
            pop.textContent = 'Error: ' + err;
        }

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

    // ── tw / hledger codeblock renderers ──────────────────────────
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
                return false;
            }
        }});
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
        const todayYmd = new Date().toISOString().slice(0,10).replace(/-/g,'');
        const soonYmd  = new Date(Date.now() + 3*24*60*60*1000).toISOString().slice(0,10).replace(/-/g,'');
        const fmtDate  = s => s ? s.replace(/^(\d{4})(\d{2})(\d{2}).*/, '$1-$2-$3') : '';
        const priLabel = { H: '▲', M: '●', L: '▽' };
        const priCls   = { H: 'nb-tw-pri-h', M: 'nb-tw-pri-m', L: 'nb-tw-pri-l' };

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

        if (!tasks.length) {
            el.innerHTML = `<div class="nb-tw-header">
                <span class="nb-tw-meta-inline">${metaHtml(0)}</span>
                <button class="nb-tw-btn nb-tw-refresh" title="Refresh">↻</button>
            </div>`;
            el.querySelector('.nb-tw-refresh').addEventListener('click', () => _loadTwBlock(el));
            return;
        }

        const rows = tasks.map(t => {
            const due    = t.due ? t.due.slice(0,8) : '';
            const dueCls = due < todayYmd && due ? ' nb-tw-overdue' : due && due <= soonYmd ? ' nb-tw-soon' : '';
            return `<tr class="${rowUrgencyCls(t)}" data-uuid="${_esc(t.uuid || '')}">
                <td class="nb-tw-act"><button class="nb-tw-btn nb-tw-done-btn" title="Mark done">✓</button></td>
                <td class="nb-tw-id">${t.id || ''}</td>
                <td class="nb-tw-desc">${_esc(t.description || '')}</td>
                <td class="nb-tw-proj">${_esc(t.project || '')}</td>
                <td class="nb-tw-pri ${priCls[t.priority] || ''}">${priLabel[t.priority] || ''}</td>
                <td class="nb-tw-due${dueCls}">${fmtDate(t.due)}</td>
                <td class="nb-tw-tags">${(t.tags || []).map(g => `<span class="nb-tw-tag">${_esc(g)}</span>`).join('')}</td>
                <td class="nb-tw-act"><button class="nb-tw-btn nb-tw-toggle-btn" data-started="${!!t.start}" title="${t.start ? 'Stop' : 'Start'}">${t.start ? '◼' : '▶'}</button></td>
            </tr>`;
        }).join('');

        el.innerHTML = `<div class="nb-tw-header">
            <span class="nb-tw-meta-inline">${metaHtml(tasks.length)}</span>
            <button class="nb-tw-btn nb-tw-refresh" title="Refresh">↻</button>
        </div>
        <table class="nb-tw-table">
            <thead><tr><th></th><th>ID</th><th>Description</th><th>Project</th><th>Pri</th><th>Due</th><th>Tags</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;

        el.querySelector('.nb-tw-refresh').addEventListener('click', () => _loadTwBlock(el));

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
                            `<tr><td colspan="8" class="nb-tw-all-done">✓ All done!</td></tr>`;
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

        const today = new Date().toISOString().slice(0, 10);

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
                { label: '📥 Import files…', action: doImport },
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
                { label: 'Rename…',              disabled: !hasNote, action: _doRename },
                { label: 'Move to…',             disabled: !hasNote, action: _doMove },
                { label: '📋 Save as template…', disabled: !hasNote, action: _doSaveAsTemplate },
                'sep',
                { label: '↩ Undo last edit',
                  disabled: !hasNote || !_undoBuffer[_activeSelector],
                  action: _doUndoLastEdit },
                { label: '🕓 History…',   disabled: !hasNote, action: _showHistoryBar },
                'sep',
                { label: '⬇ Save as…', disabled: !hasNote, action: _showSaveAsBar },
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

    function _showSaveAsBar() {
        if (!_activeSelector) return;
        document.getElementById('nb-export-bar')?.remove();

        const toolbar = document.getElementById('nb-preview-toolbar');
        const bar     = document.createElement('div');
        bar.id        = 'nb-export-bar';
        bar.className = 'nb-move-bar';

        const lbl = document.createElement('span');
        lbl.className   = 'nb-move-label';
        lbl.textContent = 'Save as:';

        const fmtSel = document.createElement('select');
        fmtSel.className = 'nb-scope-select';
        fmtSel.style.colorScheme = 'dark';
        _exportFormats(_activeType).forEach(f => {
            const opt = document.createElement('option');
            opt.value = f.value; opt.textContent = f.label;
            fmtSel.appendChild(opt);
        });

        const nameInput = document.createElement('input');
        nameInput.type      = 'text';
        nameInput.className = 'nb-rename-input';
        nameInput.style.width = '16em';

        const EXT = { md: '.md', html: '.html', docx: '.docx', odt: '.odt' };
        function updateName() {
            const fmt  = fmtSel.value;
            const base = (document.getElementById('nb-preview-title')?.textContent || 'note')
                .replace(/[^\w\s\-]/g, '').trim().replace(/\s+/g, '_') || 'note';
            if (fmt === 'raw') {
                nameInput.value    = _activeFilename || base;
                nameInput.disabled = false;
            } else if (fmt === 'print') {
                nameInput.value    = base + '.pdf';
                nameInput.disabled = true;
            } else {
                nameInput.value    = base + (EXT[fmt] || '');
                nameInput.disabled = false;
            }
        }
        fmtSel.addEventListener('change', updateName);
        updateName();

        const saveBtn = document.createElement('button');
        saveBtn.className   = 'nb-tool-btn nb-btn-primary';
        saveBtn.textContent = 'Save';

        const cancelBtn = document.createElement('button');
        cancelBtn.className   = 'nb-tool-btn';
        cancelBtn.textContent = '✕';

        bar.append(lbl, fmtSel, nameInput, saveBtn, cancelBtn);
        toolbar.parentNode.insertBefore(bar, toolbar.nextSibling);
        if (!nameInput.disabled) { nameInput.focus(); nameInput.select(); }

        cancelBtn.addEventListener('click', () => bar.remove());

        async function commit() {
            const fmt      = fmtSel.value;
            const filename = nameInput.value.trim() || 'export';

            if (fmt === 'print') {
                bar.remove();
                _doPrint();
                return;
            }

            const url = fmt === 'raw'
                ? `/api/file?selector=${encodeURIComponent(_activeSelector)}`
                : `/api/export?selector=${encodeURIComponent(_activeSelector)}&fmt=${fmt}`;

            const ACCEPT = {
                md:   { 'text/markdown': ['.md'] },
                html: { 'text/html': ['.html'] },
                docx: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] },
                odt:  { 'application/vnd.oasis.opendocument.text': ['.odt'] },
            };

            if (window.showSaveFilePicker) {
                try {
                    const types = ACCEPT[fmt]
                        ? [{ description: filename, accept: ACCEPT[fmt] }]
                        : [];
                    const handle = await window.showSaveFilePicker({
                        suggestedName: filename,
                        ...(types.length && { types }),
                    });
                    saveBtn.textContent = 'Saving…'; saveBtn.disabled = true;
                    const resp = await fetch(url);
                    if (!resp.ok) throw new Error(await resp.text());
                    const writable = await handle.createWritable();
                    await resp.body.pipeTo(writable);
                    await writable.close();
                    bar.remove();
                    return;
                } catch (e) {
                    if (e.name === 'AbortError') return;
                    // fall through to anchor download
                }
            }

            const a = document.createElement('a');
            a.href = url; a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            bar.remove();
        }

        saveBtn.addEventListener('click', commit);
        nameInput.addEventListener('keydown', e => {
            if (e.key === 'Enter')  commit();
            if (e.key === 'Escape') bar.remove();
        });
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

    function _doRename() {
        if (!_activeSelector) return;
        const titleEl  = document.getElementById('nb-preview-title');
        const origText = titleEl.textContent;

        const input = document.createElement('input');
        input.type      = 'text';
        input.className = 'nb-rename-input';
        input.value     = origText;

        const saveBtn   = document.createElement('button');
        saveBtn.className   = 'nb-tool-btn nb-btn-primary nb-rename-save';
        saveBtn.textContent = 'Save';

        const cancelBtn = document.createElement('button');
        cancelBtn.className   = 'nb-tool-btn nb-rename-cancel';
        cancelBtn.textContent = 'Cancel';

        titleEl.style.display = 'none';
        titleEl.parentNode.insertBefore(input, titleEl.nextSibling);
        titleEl.parentNode.insertBefore(saveBtn,   input.nextSibling);
        titleEl.parentNode.insertBefore(cancelBtn, saveBtn.nextSibling);
        input.select();

        function cancel() {
            [input, saveBtn, cancelBtn].forEach(el => el.remove());
            titleEl.style.display = '';
        }

        async function commit() {
            const newName = input.value.trim();
            [input, saveBtn, cancelBtn].forEach(el => el.remove());
            titleEl.style.display = '';
            if (!newName || newName === origText) return;
            try {
                const r = await fetch('/api/note/rename', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ selector: _activeSelector, name: newName }),
                });
                const d = await r.json();
                if (d.success) { titleEl.textContent = newName; NbNav.reexecute(); }
                else alert('Rename failed: ' + (d.stderr || 'unknown'));
            } catch(e) { alert('Rename error: ' + e); }
        }

        input.addEventListener('keydown', e => {
            if (e.key === 'Enter')  { e.preventDefault(); commit(); }
            if (e.key === 'Escape') cancel();
        });
        saveBtn.addEventListener('click', commit);
        cancelBtn.addEventListener('click', cancel);
        input.focus();
    }

    async function _doMove() {
        if (!_activeSelector) return;

        document.getElementById('nb-move-bar')?.remove();

        const [nbData] = await Promise.all([fetch('/api/notebooks').then(r => r.json())]);
        const notebooks = nbData.notebooks || [];
        const curNb = _activeSelector.split(':')[0];

        const toolbar = document.getElementById('nb-preview-toolbar');
        const bar = document.createElement('div');
        bar.id        = 'nb-move-bar';
        bar.className = 'nb-move-bar';

        const lbl = document.createElement('span');
        lbl.className   = 'nb-move-label';
        lbl.textContent = 'Move to:';

        const nbSel = document.createElement('select');
        nbSel.className = 'nb-scope-select';
        nbSel.style.colorScheme = 'dark';
        notebooks.forEach(nb => {
            const opt = document.createElement('option');
            opt.value = nb; opt.textContent = nb;
            if (nb === curNb) opt.selected = true;
            nbSel.appendChild(opt);
        });

        const folderSel = document.createElement('select');
        folderSel.className = 'nb-scope-select';
        folderSel.style.colorScheme = 'dark';

        async function _populateFolders(nb) {
            const fd = await fetch(`/api/folders?notebook=${encodeURIComponent(nb)}`).then(r => r.json());
            const folders = fd.folders || [];
            folderSel.innerHTML = '';
            const rootOpt = document.createElement('option');
            rootOpt.value = ''; rootOpt.textContent = '(none)';
            folderSel.appendChild(rootOpt);
            folders.forEach(f => {
                const opt = document.createElement('option');
                opt.value = f; opt.textContent = f + '/';
                folderSel.appendChild(opt);
            });
            folderSel.disabled = folders.length === 0;
        }

        await _populateFolders(curNb);

        nbSel.addEventListener('change', () => _populateFolders(nbSel.value));

        const goBtn = document.createElement('button');
        goBtn.className   = 'nb-tool-btn nb-btn-primary';
        goBtn.textContent = 'Move';

        const cancelBtn = document.createElement('button');
        cancelBtn.className   = 'nb-tool-btn';
        cancelBtn.textContent = 'Cancel';

        bar.append(lbl, nbSel, folderSel, goBtn, cancelBtn);
        toolbar.parentNode.insertBefore(bar, toolbar.nextSibling);
        nbSel.focus();

        cancelBtn.addEventListener('click', () => bar.remove());

        goBtn.addEventListener('click', async () => {
            const nb     = nbSel.value;
            const folder = folderSel.value;
            const dest   = folder ? `${nb}:${folder}/` : `${nb}:`;
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
                    NbNav.reexecute();
                } else {
                    alert('Move failed: ' + (rd.stderr || 'unknown'));
                    goBtn.textContent = 'Move'; goBtn.disabled = false;
                }
            } catch(e) { goBtn.textContent = 'Move'; goBtn.disabled = false; }
        });

        bar.addEventListener('keydown', e => { if (e.key === 'Escape') bar.remove(); });
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
            if (e.target.closest('#nb-done-bar, .nb-move-bar, .nb-rename-bar')) return;
            switch (e.key) {
                case 'Escape': {
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
                case 't': e.preventDefault(); NbTerminal.open();               break;
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

    function _openEditor(targetSelector) {
        const sel = targetSelector || _activeSelector;
        if (!sel) return;
        _activeSelector = sel;
        _editing = true;
        document.getElementById('nb-done-bar')?.remove();
        document.getElementById('nb-preview-actions').hidden = true;
        fetch('/api/note?selector=' + encodeURIComponent(sel))
            .then(r => r.json())
            .then(d => {
                const raw = d.raw || d.body || '';
                _undoBuffer[sel] = raw;   // snapshot before editing (level-1 undo)
                const ta = document.getElementById('nb-editor');
                ta.value = raw;
                document.getElementById('nb-preview-content').hidden = true;
                document.getElementById('nb-editor-wrap').hidden = false;
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
        document.getElementById('nb-editor-wrap').hidden = true;
        document.getElementById('nb-preview-content').hidden = false;
        document.getElementById('nb-preview-actions').hidden = false;
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
            if (e.key === 'Escape') bar.remove();
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
                NbNav.reexecute();
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
                icon.textContent = t.scope === 'local' ? '📒' : '🌐';
                icon.title = t.scope === 'local' ? 'Notebook template' : 'Global template';

                const title = document.createElement('span');
                title.className = 'nb-list-title';
                title.textContent = t.name;

                const excerpt = document.createElement('span');
                excerpt.className = 'nb-list-excerpt';
                excerpt.textContent = t.scope === 'local' ? `${nb}: template` : 'global';

                li.append(icon, title, excerpt);
                li.addEventListener('click', () => {
                    list.querySelectorAll('.nb-list-item').forEach(el => el.classList.remove('active'));
                    li.classList.add('active');
                    _openTemplate(t.path, t.name, t.scope);
                });
                list.appendChild(li);
            });
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

    const _IMPORT_MAX_MB    = 25;   // soft default; server enforces the real limit from settings
    const _IMPORT_MAX_FILES = 20;

    async function _importFiles(files) {
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
        const nb = NbNav.notebook === '_all' ? 'home' : NbNav.notebook;
        const lines = [];
        for (const file of files) {
            const fd = new FormData();
            fd.append('file', file);
            fd.append('notebook', nb);
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

    function doImport() {
        const input = document.createElement('input');
        input.type     = 'file';
        input.multiple = true;
        input.addEventListener('change', () => _importFiles([...input.files]));
        input.click();
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

    return { init, loadNotes, resetAndLoad, resetSort, search, openNote, openToday,
             showAddForm, addNote, runCmd, runCal, runGrep, runTemplates, loadTemplatesForAdd,
             doSync, doImport, doLinkFile, showAbout, openEditor: _openEditor, closeEditor: _closeEditor,
             isEditing: () => _editing };
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
        ws.onclose   = ()  => term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
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
    }

    return { open, close, openSettings };
})();

document.addEventListener('DOMContentLoaded', () => NbMain.init());

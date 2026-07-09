// nb-web main.js — list, preview, editor, today, add, sync

const NbMain = (() => {
    const _t = (key) => NbWeb.t(key);

    let _activeSelector = null;
    let _activeType     = null;   // classify() type of current note
    let _activeFilename = null;   // original filename for raw export
    let _activeNoteRef  = null;   // "notebook:id" for clipboard copy
    let _editing        = false;
    const _undoBuffer   = {};     // selector → raw content before last edit (level-1 undo)
    let _searchTimer    = null;
    let _lastNotes      = [];       // original load order, for client-side sort
    let _sortMode       = 'default';
    let _defaultSortMode = 'default'; // effective default for the current notebook (set by resetSort)
    let _nbSortMode     = 'active-first';  // sort for Notebooks settings view -- shared with notebooks-page.js via getNbSortMode()
    const _toolbarCache = {};              // { notebook: { ts, notes } }
    const _TOOLBAR_TTL  = 30_000;
    let _foldersFirst   = localStorage.getItem('nb-folders-first') !== 'false';
    let _pinnedSelectors = new Set(JSON.parse(localStorage.getItem('nb-pinned') || '[]'));
    let _activeNote      = null;   // full note object for the currently-open note
    let _listSeq        = 0;        // incremented on every new list request; stale responses are dropped
    const _history      = [];       // back-stack
    const _future       = [];       // forward-stack (cleared on any new navigation)
    const _wikilinkCache = new Map(); // selector → resolved title
    const _noteCache     = new Map(); // selector → cached note API response (cache: true frontmatter)
    let _noAutoSelect   = false;     // suppresses renderList auto-select during explicit openNote
    let _listDisplayMode = 'title';  // 'title' | 'filename' — resets on every new fetch
    let _kbPane         = 'list';   // 'list' | 'preview'
    const _pendingDeletes = new Set(); // selectors deleted but possibly not yet gone from server
    // _selectedSelectors/_lastClickedIdx/_isFullscreen privatized into ui-chrome.js
    // (tier 4, 2026-07-08) -- satellite-exclusive, no kernel code touches them.
    let _encPassword    = null;   // session-level openssl password for encrypted notes
    let _encPendingEdit = false;  // open editor immediately after next successful unlock
    let _renderAbort   = new AbortController(); // aborted on every note navigation

    // Chrome-level render progress bar — thin amber strip between toolbar and content.
    // Setting key 'nbRenderBar': 'auto' (default, show when n≥5 inlines), 'always', 'never'.
    const _RenderBar = (() => {
        let _total = 0, _pending = 0, _el = null, _fill = null, _fadeTimer = null;

        function _getEl() {
            if (_el) return _el;
            _el   = document.createElement('div');
            _el.id = 'nb-render-bar';
            _fill = document.createElement('div');
            _fill.id = 'nb-render-bar-fill';
            _el.appendChild(_fill);
            document.getElementById('nb-preview-toolbar')?.after(_el);
            return _el;
        }

        function _setting() { return localStorage.getItem('nbRenderBar') || 'auto'; }

        function start(n) {
            const s = _setting();
            if (s === 'never') return;
            if (s === 'auto' && n < 5) return;
            clearTimeout(_fadeTimer);
            _total = n; _pending = n;
            const bar = _getEl();
            bar.classList.remove('nb-rb-fading', 'nb-rb-done');
            bar.classList.add('nb-rb-active');
            if (_fill) _fill.style.width = '0%';
        }

        function tick() {
            if (!_el?.classList.contains('nb-rb-active')) return;
            _pending = Math.max(0, _pending - 1);
            if (_fill) _fill.style.width =
                (_total > 0 ? ((_total - _pending) / _total) * 100 : 100) + '%';
        }

        function done() {
            if (!_el?.classList.contains('nb-rb-active')) return;
            if (_fill) _fill.style.width = '100%';
            _el.classList.add('nb-rb-done');
            _fadeTimer = setTimeout(() => {
                _el?.classList.add('nb-rb-fading');
                setTimeout(() => {
                    _el?.classList.remove('nb-rb-active', 'nb-rb-done', 'nb-rb-fading');
                }, 500);
            }, 400);
        }

        function reset() {
            clearTimeout(_fadeTimer);
            if (_el) _el.classList.remove('nb-rb-active', 'nb-rb-done', 'nb-rb-fading');
        }

        return { start, tick, done, reset };
    })();

    // Generic async-work counter — every render path calls add(n) to register work
    // and tick() as each item completes, regardless of type (inline includes, test
    // blocks, codeblock renderers, etc.).  Pill shows ⟳ N while anything is pending,
    // flashes ✓ on completion, then hides.  Click forces all pending lazy spans to load.
    const _StatusPill = (() => {
        let _pending = 0, _el = null, _doneTimer = null;
        const _forceCallbacks = [];

        function _getEl() {
            if (_el) return _el;
            _el = document.createElement('span');
            _el.id = 'nb-render-pill';
            _el.hidden = true;
            _el.title = 'Rendering in progress — click to load everything now';
            _el.style.cursor = 'pointer';
            _el.addEventListener('click', () => { _forceCallbacks.splice(0).forEach(fn => fn()); });
            document.querySelector('.nb-toolbar-left')?.append(_el);
            return _el;
        }

        function _update() {
            const el = _getEl();
            clearTimeout(_doneTimer);
            if (_pending > 0) {
                el.className = '';
                el.textContent = `⟳ ${_pending}`;
                el.hidden = false;
            } else {
                el.textContent = '✓';
                el.className = 'nb-rp-done';
                _doneTimer = setTimeout(() => {
                    if (_el) { _el.hidden = true; _el.className = ''; }
                }, 1400);
            }
        }

        function add(n) { if (n > 0) { _pending += n; _update(); } }

        function tick() { if (_pending <= 0) return; _pending--; _update(); }

        function registerForce(fn) { _forceCallbacks.push(fn); }

        function forceAll() { _forceCallbacks.splice(0).forEach(fn => fn()); }

        function reset() {
            clearTimeout(_doneTimer);
            _pending = 0;
            _forceCallbacks.length = 0;
            if (_el) { _el.hidden = true; _el.className = ''; }
        }

        return { add, tick, registerForce, forceAll, reset };
    })();

    // Expose so codeblock renderers (loaded after this module) can call add/tick
    NbWeb.statusPill = _StatusPill;

    function _setKbPane(pane) {
        _kbPane = pane;
        document.getElementById('nb-list-pane')?.classList.toggle('kb-focus',    pane === 'list');
        document.getElementById('nb-preview-pane')?.classList.toggle('kb-focus', pane === 'preview');
    }

    // ── Boot ───────────────────────────────────────────────────────

    async function init() {
        await NbNav.init();
        NbSearch.init();
        NbNoteActions.init();
        _bindPreviewActions();
        NbUiChrome.init();
        _bindDropImport();
        NbDragHandles.init();
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

    function _makePluginBtn(btn, nb, cls, ctx) {
        const el = document.createElement('button');
        el.className = cls;
        el.dataset.pluginBtn = btn.id;
        el.title = btn.title ?? '';
        el.textContent = btn.icon ?? btn.id;
        el.addEventListener('click', () => btn.action(nb, el, ctx));
        return el;
    }

    function _renderPluginButtons(nb) {
        // nav buttons — global, always re-render on notebook switch
        const nav = document.getElementById('nb-cmds-plugins');
        if (nav) {
            nav.querySelectorAll('[data-plugin-btn]').forEach(b => b.remove());
            for (const btn of NbWeb.getNavButtons())
                nav.appendChild(_makePluginBtn(btn, nb, 'nb-cmd nb-cmd-plugin'));
        }
        // list buttons — notebook-specific; pass full notebook object as context
        const listEl = document.getElementById('nb-list-plugin-btns');
        if (listEl) {
            listEl.innerHTML = '';
            const nbObj = NbWeb.notebooks().find(n => n.name === nb);
            for (const btn of NbWeb.getListButtons(nb))
                listEl.appendChild(_makePluginBtn(btn, nb, 'nb-icon-btn nb-list-plugin-btn', nbObj));
            // Auto-inject panel toggle button for any active module with pluginContent
            for (const mod of NbWeb.getPluginContentModules(nb)) {
                const b = document.createElement('button');
                b.className = 'nb-icon-btn nb-list-plugin-btn';
                b.dataset.pluginBtn = 'panel';
                b.dataset.pluginPanelFor = mod.name;
                b.textContent = mod.contentButtonIcon || '⚙';
                b.title = (mod.contentButtonLabel || mod.label || mod.name) + ' panel';
                b.addEventListener('click', () => _togglePluginPanel(mod, nb));
                listEl.appendChild(b);
            }
        }
        // Close any open plugin panel when switching notebooks
        const content = document.getElementById('nb-preview-content');
        if (content?.dataset.pluginPanel) {
            delete content.dataset.pluginPanel;
            content.innerHTML = '';
            document.getElementById('nb-preview-title').textContent = '';
            document.getElementById('nb-preview-actions').hidden = true;
        }
    }

    async function _togglePluginPanel(mod, nb) {
        const content = document.getElementById('nb-preview-content');
        const titleEl = document.getElementById('nb-preview-title');
        const actionsEl = document.getElementById('nb-preview-actions');
        // Toggle off if already showing this module's panel
        if (content.dataset.pluginPanel === mod.name) {
            delete content.dataset.pluginPanel;
            content.innerHTML = '';
            titleEl.textContent = '';
            actionsEl.hidden = true;
            // Restore active button state
            document.querySelectorAll(`[data-plugin-panel-for="${mod.name}"]`)
                .forEach(b => b.classList.remove('nb-active'));
            return;
        }
        // Show panel
        content.dataset.pluginPanel = mod.name;
        titleEl.textContent = mod.contentButtonLabel || mod.label || mod.name;
        actionsEl.hidden = false;
        // Mark button active
        document.querySelectorAll('[data-plugin-panel-for]').forEach(b => b.classList.remove('nb-active'));
        document.querySelectorAll(`[data-plugin-panel-for="${mod.name}"]`)
            .forEach(b => b.classList.add('nb-active'));
        content.innerHTML = '<div style="padding:12px" class="nb-rendered"></div>';
        const el = content.firstElementChild;
        if (mod.requirementCheck) {
            const req = await mod.requirementCheck();
            if (req && !req.ok) {
                await NbWeb.renderRequirementsCard(el, req.markdownFile || req.markdown || '# Requirements not met');
                return;
            }
        }
        mod.pluginContent(el);
    }

    async function loadNotes(typeFilter, statusFilter, tagsFilter) {
        _listDisplayMode = 'title';
        const seq    = ++_listSeq;
        const nb     = NbNav.notebook;
        _renderPluginButtons(nb);
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
        // id (index position) is stable across git ops; mtime breaks after git reset.
        // Use id when both items have one (single-notebook), else fall back to mtime.
        const byAge = (a, b) => (a.id && b.id) ? b.id - a.id : (b.mtime || 0) - (a.mtime || 0);
        if (_sortMode === 'newest') result.sort((a, b) =>  byAge(a, b));
        if (_sortMode === 'oldest') result.sort((a, b) => -byAge(a, b));
        // Plugin sort options — checked after built-ins
        if (!['default','az','za','newest','oldest'].includes(_sortMode)) {
            const pluginSort = NbWeb.getSortOptions(NbNav.notebook).find(s => s.id === _sortMode);
            if (pluginSort) result = pluginSort.sort(result);
        }
        // Group: folders → pinned → rest (stable within each group via prior sort)
        const folders = result.filter(n => n.type === 'folder');
        const pinned  = result.filter(n => n.type !== 'folder' && _pinnedSelectors.has(n.selector));
        const rest    = result.filter(n => n.type !== 'folder' && !_pinnedSelectors.has(n.selector));
        result = _foldersFirst ? [...folders, ...pinned, ...rest] : [...pinned, ...folders, ...rest];
        return result;
    }

    function _updateSortBtn() {
        const btn = document.getElementById('nb-sort-btn');
        if (btn) btn.classList.toggle('nb-sort-active', _sortMode !== _defaultSortMode);
    }

    function resetSort(mode = 'default') {
        _sortMode = _defaultSortMode = mode;
        _updateSortBtn();
    }

    async function _fetchToolbarNotes(nb) {
        const now = Date.now();
        const hit = _toolbarCache[nb];
        if (hit && now - hit.ts < _TOOLBAR_TTL) return hit.notes;
        try {
            const r = await fetch(`/api/toolbar-notes?notebook=${encodeURIComponent(nb)}`);
            if (r.ok) {
                const d = await r.json();
                _toolbarCache[nb] = { ts: now, notes: d.notes || [] };
                return d.notes || [];
            }
        } catch (_) {}
        return [];
    }

    function _matchTagColor(raw, tags) {
        let colorMap;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            colorMap = raw;
        } else {
            colorMap = {};
            const entries = Array.isArray(raw) ? raw : [raw];
            for (const e of entries) {
                const idx = String(e).indexOf(':');
                if (idx > 0) colorMap[e.slice(0, idx).trim()] = e.slice(idx + 1).trim();
            }
        }
        for (const tag of (tags || [])) { if (colorMap[tag]) return colorMap[tag]; }
        return null;
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
        const icons = {note:'📝', bookmark:'🔖', todo:'✔️', folder:'📂', image:'🌄', strip:'🎞️', shot:'🎬', actor:'🧑', location:'📍', day:'📅', resource:'🎁'};
        const breakdown = Object.entries(types)
            .filter(([t]) => t in icons && t !== 'note')
            .map(([t,c]) => `${icons[t]}${c}`)
            .join('  ');
        document.getElementById('nb-type-breakdown').textContent = breakdown;

        const _pluginIconFn  = NbWeb.getListItemIcon(NbNav.notebook);
        const _pluginTitleFn = NbWeb.getListTitle(NbNav.notebook);

        // Toolbar shortcut buttons — notebook-wide scan (across all folders)
        const _nb = NbNav.notebook;
        _fetchToolbarNotes(_nb).then(toolbarNotes => {
            const el = document.getElementById('nb-list-plugin-btns');
            if (!el) return;
            el.querySelectorAll('[data-toolbar-shortcut]').forEach(b => b.remove());
            for (const tn of toolbarNotes) {
                const btn = document.createElement('button');
                btn.className = 'nb-icon-btn';
                btn.dataset.toolbarShortcut = '1';
                btn.textContent = tn.toolbar_icon
                               || (_pluginIconFn ? _pluginIconFn(tn) : null)
                               || tn.indicator || '📌';
                btn.title = tn.title || '';
                btn.addEventListener('click', () => openNote(tn.selector));
                el.appendChild(btn);
            }
        });

        notes.forEach(note => {
            const li = document.createElement('li');
            li.className = 'nb-list-item' + (note.type === 'folder' ? ' folder' : '') +
                           (note.selector === _activeSelector ? ' active' : '');
            li.setAttribute('role', 'option');
            li.dataset.selector = note.selector;
            li.dataset.type     = note.type;

            const icon = document.createElement('span');
            icon.className = 'nb-list-icon';
            const _isPinned = _pinnedSelectors.has(note.selector);
            const _iconTip = { '📌': 'Pinned to top', '📝': 'Note',
                               '○': 'Open todo', '✔': 'Closed todo', '✔️': 'Closed todo',
                               '🔖': 'Bookmark', '🔗': 'Linked file', '🔒': 'Encrypted', '📂': 'Folder',
                               '🌄': 'Image', '🔉': 'Audio', '📹': 'Video',
                               '📖': 'Ebook', '📄': 'Document', '🗃️': 'Sheet', '🪪': 'Contact' };
            const _extIcon = { md:'📝', txt:'📝', markdown:'📝',
                                pdf:'📄', doc:'📄', docx:'📄', odt:'📄', rtf:'📄',
                                png:'🌄', jpg:'🌄', jpeg:'🌄', gif:'🌄', webp:'🌄', svg:'🌄', avif:'🌄',
                                mp3:'🔉', ogg:'🔉', flac:'🔉', m4a:'🔉', wav:'🔉',
                                mp4:'📹', mkv:'📹', webm:'📹', mov:'📹',
                                epub:'📖', mobi:'📖',
                                csv:'🗃️', xlsx:'🗃️', ods:'🗃️',
                                zip:'🗜', tar:'🗜', gz:'🗜',
                                html:'🌐', htm:'🌐' };
            const _ext = (note.filename || '').split('.').pop().toLowerCase();
            const _pluginIcon = _pluginIconFn ? _pluginIconFn(note) : null;
            const _iconChar = _pluginIcon        ? _pluginIcon
                            : _isPinned          ? '📌'
                            : note.indicator     ? note.indicator
                            : note.type === 'bookmark' ? '🔖'
                            : _extIcon[_ext]     ? _extIcon[_ext]
                            : note.type === 'note' ? '📝'
                            : '';
            icon.textContent = _iconChar;
            icon.title = _iconTip[_iconChar] || '';

            const body = document.createElement('div');
            body.className = 'nb-list-body';

            const titleRow = document.createElement('div');
            titleRow.className = 'nb-list-title-row';

            const title = document.createElement('span');
            title.className = 'nb-list-title';
            const _pluginTitle = _pluginTitleFn ? _pluginTitleFn(note) : null;
            title.textContent = _listDisplayMode === 'filename'
                ? note.filename
                : (_pluginTitle ?? note.title ?? note.filename);
            if (note.tag_color) {
                const _tc = _matchTagColor(note.tag_color, note.tags);
                if (_tc) title.style.color = _tc;
            }
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

            li.appendChild(icon);
            li.appendChild(body);

            if (note.type === 'folder') {
                if (note.locked) {
                    const lockBadge = document.createElement('span');
                    lockBadge.className = 'nb-folder-lock-badge';
                    lockBadge.textContent = '🔒';
                    lockBadge.title = 'Folder locked';
                    li.appendChild(lockBadge);
                }
                const moreBtn = document.createElement('button');
                moreBtn.className = 'nb-folder-more-btn';
                moreBtn.textContent = '⋯';
                moreBtn.title = 'Folder options';
                moreBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    NbDialog.openFolder(note.selector, note.filename, note.locked);
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
                        NbUiChrome.toggleSelection(note.selector, notes.indexOf(note));
                    } else if (e.shiftKey) {
                        NbUiChrome.rangeSelection(notes.indexOf(note), notes);
                    } else {
                        NbUiChrome.clearSelection();
                        NbUiChrome.setSelectionAnchor(notes.indexOf(note));
                        openNote(note.selector);
                    }
                });
            }

            ul.appendChild(li);
        });

        // Auto-select first non-folder when current selection left the list
        if (!fromSort && !_noAutoSelect) {
            const stillPresent = _activeSelector && notes.some(n => n.selector === _activeSelector);
            if (!stillPresent) {
                const first = notes.find(n => n.type !== 'folder');
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

        if (pushHistory) {
            const _CMD_PAGES = new Set(['account','plugins','nb-notebooks','templates','contacts']);
            if (_activeSelector && _activeSelector !== selector) {
                _history.push({ sel: _activeSelector, scrollTop: document.getElementById('nb-preview-content')?.scrollTop || 0 });
                _future.length = 0;
            } else if (!_activeSelector && _CMD_PAGES.has(NbNav.activeCmd)) {
                _history.push({ cmd: NbNav.activeCmd });
                _future.length = 0;
            }
        }
        _activeSelector = selector;
        _updateNavBtns();
        document.getElementById('nb-pin-indicator').hidden = !_pinnedSelectors.has(selector);

        // Show toolbar, reset TOC bar until note is rendered
        const toolbar = document.getElementById('nb-preview-toolbar');
        toolbar.hidden = false;
        document.getElementById('nb-toc-bar').hidden = true;
        document.getElementById('nb-preview-title').textContent = selector.split(':').pop();

        // Abort any in-flight render from the previous note, then issue a fresh
        // AbortController for this navigation so new fetches can be cancelled later.
        _renderAbort.abort();
        _renderAbort = new AbortController();
        _StatusPill.reset();
        _RenderBar.reset();

        // Show spinner while loading (skipped for cached notes)
        const content = document.getElementById('nb-preview-content');
        const _cached = _noteCache.get(selector);
        if (!_cached) content.innerHTML = '<div style="padding:40px;color:var(--text-muted)">Loading…</div>';

        try {
            let d = _cached;
            if (!d) {
                const r = await fetch('/api/note?selector=' + encodeURIComponent(selector));
                if (!r.ok) { content.innerHTML = '<div style="padding:40px;color:var(--red)">Failed to load note.</div>'; return; }
                d = await r.json();
                if (d.meta?.cache) _noteCache.set(selector, d);
            }
            // reload: true — run all regen blocks before rendering so blocks show fresh data
            if (d.meta?.reload) {
                const regenCmds = [...(d.body || '').matchAll(/```hledger\s*\nregen\s+(\S+)/gm)];
                for (const m of regenCmds) {
                    await fetch('/api/hledger/regen', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({notebook: NbNav.notebook, script: m[1]})
                    }).catch(() => null);
                }
            }
            renderPreview(d);
            if (opts.restoreScrollTop) {
                content.dataset.restoreScrollTop = opts.restoreScrollTop;
                requestAnimationFrame(() => {
                    const target = parseInt(content.dataset.restoreScrollTop || '0', 10);
                    if (target && content.scrollHeight >= target) {
                        content.scrollTop = target;
                        delete content.dataset.restoreScrollTop;
                    }
                    // else: large-note still loading — leave dataset for its render handler
                });
            }
            if (d.meta?.pinned && !_pinnedSelectors.has(selector)) {
                _pinnedSelectors.add(selector);
                localStorage.setItem('nb-pinned', JSON.stringify([..._pinnedSelectors]));
                document.getElementById('nb-pin-indicator').hidden = false;
                renderList(_getSortedNotes(_lastNotes), true);
            }
            if (NbDialog.isOpen()) NbDialog.refresh();
        } catch (e) {
            content.innerHTML = `<div style="padding:40px;color:var(--red)">Error: ${_esc(String(e))}</div>`;
        }
    }

    async function renderPreview(note) {
        _activeNote     = note;
        _activeType     = note.type;
        _activeFilename = note.filename;
        _activeNoteRef  = (note.notebook && note.id) ? `${note.notebook}:${note.id}` : null;
        const content = document.getElementById('nb-preview-content');
        // Clear plugin panel state — note click dismisses any open panel
        if (content.dataset.pluginPanel) {
            delete content.dataset.pluginPanel;
            document.querySelectorAll('[data-plugin-panel-for]').forEach(b => b.classList.remove('nb-active'));
        }
        document.getElementById('nb-preview-title').textContent = note.title || note.filename;
        document.getElementById('nb-done-bar')?.remove();
        document.getElementById('nb-preview-actions').hidden = false;

        const doneBtn    = document.getElementById('nb-done-btn');
        const editBtn    = document.getElementById('nb-edit-btn');
        const changesBtn = document.getElementById('nb-changes-btn');
        const openExtBtn = document.getElementById('nb-open-ext-btn');
        if (doneBtn) doneBtn.hidden = !(note.type === 'todo' && note.status === 'open');
        if (editBtn) editBtn.hidden = ['sheet','image','audio','video','pdf','ebook','document','archive'].includes(note.type);
        if (changesBtn) {
            const hasMeta = note.meta && Object.keys(note.meta).length > 0;
            changesBtn.hidden   = !hasMeta || !!note.locked;
            changesBtn.classList.remove('nb-active');
            changesBtn.onclick  = () => _toggleFmChangesPanel(note, changesBtn);
            // Close panel when navigating to a new note
            const panel = document.getElementById('nb-changes-panel');
            if (panel) panel.hidden = true;
        }

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
                } finally { openExtBtn.textContent = _t('btn_open'); openExtBtn.disabled = false; }
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

        // ── Renderer style toggle ──────────────────────────────────────────
        const _rEl     = document.getElementById('nb-preview-renderers');
        if (_rEl) _rEl.innerHTML = '';
        await NbWeb.loadNotebookConfig(note.notebook);   // prime cache; no-op on hit
        const _renderers  = NbWeb.getPreviewRenderers(note.notebook, note);
        const _modeKey    = `nb-render-mode:${note.notebook}`;
        const _activeId   = _renderers.length > 1
            ? (localStorage.getItem(_modeKey) || _renderers[0].id)
            : (_renderers[0]?.id ?? '');
        const _activeRend = _renderers.find(r => r.id === _activeId) ?? _renderers[0] ?? null;
        if (_renderers.length > 1 && _rEl) {
            for (const r of _renderers) {
                const btn = document.createElement('button');
                btn.className = 'nb-tool-btn' + (r.id === _activeId ? ' nb-active' : '');
                btn.title = r.label;  btn.textContent = r.icon;
                btn.addEventListener('click', () => {
                    localStorage.setItem(_modeKey, r.id);
                    renderPreview(note);
                });
                _rEl.appendChild(btn);
            }
        }
        const _pluginRaw  = _activeRend
            ? _activeRend.render(note)
            : (NbWeb.getPreviewRenderer(note.notebook)?.(note) ?? null);
        const _pluginHtml = (_pluginRaw instanceof Promise) ? await _pluginRaw : _pluginRaw;

        // Check-script output (check:/check_add: FM cascade) -- computed once here so
        // every branch below that reaches the shared render step gets identical,
        // cascade-consistent check rendering, spliced in at the same relative
        // position (after any FM-fallback table, before type-specific content) the
        // generic-fallback branch already used before this fix. No-op (empty string)
        // when no check config resolves for this note -- zero behavior change for
        // notes that don't opt in. See claude:mainjs-check-cascade-fix.md.
        // Still excluded (early-return branches below never reach this variable,
        // pre-existing, not new): pdf, code/timedot, html, ebook/document, archive,
        // sheet, encrypted, and the large-note /api/render path.
        const _checkPrefix = _virtualTestPrefix(note);
        const _checkHtml   = _checkPrefix ? _renderMarkdown(_checkPrefix, note.selector) : '';

        // ── Lock / Unlock UI ───────────────────────────────────────────────
        document.getElementById('nb-unlock-btn')?.remove();
        const _isLocked = /^(yes|on|true|1)$/i.test(String(note.meta?.lock ?? ''));
        // Stamp lock state on the content pane so codeblock renderers can read it
        const _contentPane = document.getElementById('nb-preview-content');
        if (_contentPane) _contentPane.dataset.noteLocked = _isLocked ? 'true' : '';
        const _editBtn  = document.getElementById('nb-edit-btn');
        if (_isLocked && _editBtn) {
            _editBtn.hidden = true;
            const unlockBtn = document.createElement('button');
            unlockBtn.id        = 'nb-unlock-btn';
            unlockBtn.className = 'nb-tool-btn';
            unlockBtn.title     = _t('tip_unlock_note');
            unlockBtn.textContent = '🔒 ' + _t('btn_unlock');
            unlockBtn.addEventListener('click', async () => {
                unlockBtn.disabled = true; unlockBtn.textContent = '…';
                try {
                    await fetch('/api/cine/lock', {
                        method:  'POST',
                        headers: {'Content-Type': 'application/json'},
                        body:    JSON.stringify({ selector: note.selector, locked: false }),
                    });
                    await openNote(note.selector);
                } finally {
                    unlockBtn.disabled = false;
                }
            });
            _editBtn.insertAdjacentElement('afterend', unlockBtn);
        }

        // Re-lock button — shown when lock: key exists in meta but value is cleared
        document.getElementById('nb-relock-btn')?.remove();
        const _hasSoftLock = !_isLocked && note.meta != null && 'lock' in note.meta;
        if (_hasSoftLock && _editBtn) {
            const relockBtn = document.createElement('button');
            relockBtn.id        = 'nb-relock-btn';
            relockBtn.className = 'nb-tool-btn';
            relockBtn.title     = _t('tip_lock_note');
            relockBtn.textContent = '🔒';
            relockBtn.addEventListener('click', async () => {
                relockBtn.disabled = true;
                try {
                    await fetch('/api/cine/lock', {
                        method:  'POST',
                        headers: {'Content-Type': 'application/json'},
                        body:    JSON.stringify({ selector: note.selector, locked: true }),
                    });
                    await openNote(note.selector);
                } finally {
                    relockBtn.disabled = false;
                }
            });
            _editBtn.insertAdjacentElement('beforebegin', relockBtn);
        }

        // ── Directory lock (.nb-unlock file in folder or notebook) ───────────────
        document.getElementById('nb-dir-lock-indicator')?.remove();
        if (note.locked) {
            const editBtn   = document.getElementById('nb-edit-btn');
            const deleteBtn = document.getElementById('nb-delete-btn');
            if (editBtn)   editBtn.hidden   = true;
            if (deleteBtn) deleteBtn.hidden = true;
            const lockInd = document.createElement('span');
            lockInd.id = 'nb-dir-lock-indicator';
            lockInd.textContent = '🔒';
            lockInd.style.cssText = 'font-size:13px;cursor:default;opacity:0.75;user-select:none';
            lockInd.title = note.lock_reason
                ? `Locked: ${note.lock_reason}`
                : 'Read-only — locked by folder or notebook lock';
            const pinInd = document.getElementById('nb-pin-indicator');
            if (pinInd) pinInd.insertAdjacentElement('beforebegin', lockInd);
            else document.getElementById('nb-preview-actions')?.prepend(lockInd);
        }

        if (note.type === 'image') {
            html = _checkHtml + `<div style="text-align:center"><img src="${fileUrl}" class="nb-img-preview" alt="${_esc(note.title)}"></div>`;
        } else if (note.type === 'audio') {
            html = _checkHtml + `<div class="nb-audio-wrap">
                      <div style="font-size:1.1em;font-weight:600">${_esc(note.title)}</div>
                      <audio controls class="nb-audio-player"><source src="${fileUrl}"></audio>
                    </div>`;
        } else if (note.type === 'video') {
            const ext = (note.filename || '').split('.').pop().toLowerCase();
            if (['mp4','webm'].includes(ext)) {
                html = _checkHtml + `<div style="text-align:center"><video controls class="nb-video-player"><source src="${fileUrl}"></video></div>`;
            } else {
                html = _checkHtml + `<div class="nb-media-card">
                          <span class="nb-media-icon">📹</span>
                          <span class="nb-media-name">${_esc(note.filename)}</span>
                          <span class="nb-media-hint">${_esc(ext.toUpperCase())} — use ↗ Open to play</span>
                        </div>`;
            }
        } else if (note.type === 'pdf') {
            content.innerHTML = `<embed src="${fileUrl}" type="application/pdf" class="nb-pdf-embed">`;
            _appendAnnotation(content, note);
            return;
        } else if (note.type === 'code' || note.type === 'timedot') {
            const ext  = (note.filename || '').split('.').pop().toLowerCase();
            const _langMap = {
                sh:'bash', bash:'bash', zsh:'bash', fish:'bash',
                journal:'ledger', ledger:'ledger', hledger:'ledger', timedot:'ledger',
                hs:'haskell', lhs:'haskell',
                py:'python', pyw:'python',
                js:'javascript', mjs:'javascript', cjs:'javascript',
                ts:'javascript', tsx:'javascript', jsx:'javascript',
                html:'markup', htm:'markup', xml:'markup', svg:'markup',
                css:'css', scss:'css', less:'css',
                json:'json', jsonc:'json',
                sql:'sql',
                yaml:'yaml', yml:'yaml',
                c:'c', h:'c',
                cpp:'cpp', cc:'cpp', cxx:'cpp', hpp:'cpp', hxx:'cpp',
                rs:'rust',
                toml:'toml',
            };
            const lang = _langMap[ext] || 'plaintext';
            // Show plain text immediately so the file is readable without waiting for Prism
            content.innerHTML = `<div class="nb-rendered"><pre class="nb-code-preview language-${lang}"><code class="language-${lang}">${_esc(note.body || '')}</code></pre></div>`;
            if (lang === 'ledger') _addIncludeLinks(content, note);
            _appendAnnotation(content, note);
            if (typeof Prism !== 'undefined') {
                const codeEl = content.querySelector('code');
                _StatusPill.add(1);
                const _sched = typeof requestIdleCallback !== 'undefined'
                    ? cb => requestIdleCallback(cb, { timeout: 2000 })
                    : cb => setTimeout(cb, 0);
                _sched(() => {
                    if (codeEl) {
                        const grammar = Prism.languages[lang] || Prism.languages.plaintext;
                        codeEl.innerHTML = Prism.highlight(note.body || '', grammar, lang);
                        if (lang === 'ledger') _addIncludeLinks(content, note);
                    }
                    _StatusPill.tick();
                });
            }
            return;
        } else if (_pluginHtml !== null) {
            html = (note.meta ? _renderFmFallback(note.meta) : '') + _checkHtml + _pluginHtml;
        } else if (note.type === 'sheet') {
            content.innerHTML = '<div class="nb-rendered"><div id="nb-sheet-host"></div></div>';
            _renderSheet(note);
            return;
        } else if (note.type === 'bookmark') {
            html = _checkHtml + _renderBookmark(note);
        } else if (note.type === 'todo') {
            html = _checkHtml + _renderTodo(note);
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
        } else if (note.type === 'encrypted') {
            if (_encPassword) {
                _decryptAndRender(note, content);
            } else {
                content.innerHTML = `
                    <div style="display:flex;flex-direction:column;align-items:center;padding:60px 40px;text-align:center">
                        <div style="font-size:3em;margin-bottom:.5em">🔒</div>
                        <p style="margin:0 0 1em;color:var(--text-muted)">Encrypted note — enter password to view</p>
                        <div style="display:flex;gap:8px;align-items:center;width:100%;max-width:320px">
                            <input type="password" id="nb-enc-pw" placeholder="Password" autocomplete="current-password"
                                   style="flex:1;padding:6px 10px;border:1px solid var(--border);background:var(--bg2);color:var(--text);border-radius:4px;font-size:1em">
                            <button id="nb-enc-unlock-btn" class="nb-tool-btn">Unlock</button>
                        </div>
                        <div id="nb-enc-error" style="color:var(--red);margin-top:6px;min-height:1.2em;font-size:.9em"></div>
                    </div>`;
                const pw  = content.querySelector('#nb-enc-pw');
                const err = content.querySelector('#nb-enc-error');
                const doUnlock = async () => {
                    if (!pw.value) return;
                    const unlockBtn = content.querySelector('#nb-enc-unlock-btn');
                    unlockBtn.disabled = true; unlockBtn.textContent = '…';
                    try {
                        const r = await fetch('/api/note/decrypt', {
                            method: 'POST',
                            headers: {'Content-Type':'application/json'},
                            body: JSON.stringify({selector: note.selector, password: pw.value})
                        });
                        if (r.status === 401) { err.textContent = _t('msg_wrong_pw'); pw.select(); return; }
                        const d = await r.json();
                        _encPassword = pw.value;
                        _decryptAndRender(note, content, d.content);
                    } catch(e) {
                        err.textContent = _t('status_error') + ': ' + e.message;
                    } finally {
                        unlockBtn.disabled = false; unlockBtn.textContent = _t('btn_unlock');
                    }
                };
                pw.addEventListener('keydown', e => { if (e.key === 'Enter') doUnlock(); });
                content.querySelector('#nb-enc-unlock-btn').addEventListener('click', doUnlock);
            }
            return;
        } else {
            // Large or plain notes: render server-side to avoid freezing on marked.parse + innerHTML.
            // Triggered by frontmatter `large: true` or body > 100 KB.
            // Custom codeblocks and wikilinks are not processed in this path.
            if ((note.meta?.large || (note.body || '').length > 100000) && note.meta?.large !== false) {
                content.innerHTML = `<div class="nb-rendered" style="padding:40px;color:var(--text-muted)"><span class="nb-spin">⟳</span> Rendering…</div>`;
                fetch(`/api/render?selector=${encodeURIComponent(note.selector)}`)
                    .then(r => r.json())
                    .then(d => {
                        if (_activeNote !== note) return;
                        if (d.error) { content.innerHTML = `<div style="padding:40px;color:var(--red)">${_esc(d.error)}</div>`; return; }
                        content.innerHTML = `<div class="nb-rendered">${d.html}</div>`;
                        _finishRendered(content, note);
                        if (content.dataset.restoreScrollTop) {
                            const top = parseInt(content.dataset.restoreScrollTop, 10);
                            delete content.dataset.restoreScrollTop;
                            requestAnimationFrame(() => { content.scrollTop = top; });
                        }
                    })
                    .catch(e => { if (_activeNote !== note) return; content.innerHTML = `<div style="padding:40px;color:var(--red)">Render error: ${_esc(e.message)}</div>`; });
                return;
            }
            // Unknown types render as markdown. Only raw-display if there's genuinely no body to render.
                html = _renderFmFallback(note.meta) + _checkHtml + _renderMarkdown(note.body || '', note.selector);
        }

        content.innerHTML = `<div class="nb-rendered">${html}</div>`;
        _finishRendered(content, note);
    }

    // Enrich a rendered container: wikilinks, codeblocks, links, uuids, todos.
    // Does NOT append the annotation footnote — call _finishRendered for that.
    function _resolveInlineQueries(container, note) {
        const IQ_RE = /\{\{(\w+):\s*([^}]*?)\}\}/g;
        // Walk text nodes, skipping PRE/CODE so backtick examples aren't processed.
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
            acceptNode(n) {
                let p = n.parentElement;
                while (p) {
                    if (['PRE','CODE','SCRIPT','STYLE'].includes(p.tagName))
                        return NodeFilter.FILTER_REJECT;
                    p = p.parentElement;
                }
                return n.textContent.includes('{{') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
            }
        });
        const textNodes = [];
        let n;
        while ((n = walker.nextNode())) textNodes.push(n);

        const spans = [];
        for (const textNode of textNodes) {
            const text = textNode.textContent;
            const parts = [];
            let last = 0, m;
            IQ_RE.lastIndex = 0;
            while ((m = IQ_RE.exec(text)) !== null) {
                if (m.index > last) parts.push(document.createTextNode(text.slice(last, m.index)));
                const span = document.createElement('span');
                span.className = 'nb-inline-query';
                span.dataset.provider = m[1].toLowerCase();
                span.dataset.query    = m[2].trim();
                span.textContent = '⋯';
                parts.push(span);
                spans.push(span);
                last = m.index + m[0].length;
            }
            if (!parts.length) continue;
            if (last < text.length) parts.push(document.createTextNode(text.slice(last)));
            textNode.replaceWith(...parts);
        }

        const nb     = note?.notebook || NbNav.notebook;
        const signal = _renderAbort.signal;   // captured now; aborted if user navigates away
        const inlineSpans = [];
        let nonInlineCount = 0;
        for (const span of spans) {
            const { provider, query } = span.dataset;
            if (provider === 'inline') {
                inlineSpans.push(span);
                continue;
            }
            // Non-inline queries are cheap single-value lookups — fire in parallel
            nonInlineCount++;
            fetch(`/api/inline-query?provider=${encodeURIComponent(provider)}&query=${encodeURIComponent(query)}&notebook=${encodeURIComponent(nb)}&selector=${encodeURIComponent(note?.selector || '')}`, { signal })
                .then(r => r.json())
                .then(d => {
                    if (d.error) {
                        span.textContent = `{{${provider}: ${query}}}`;
                        span.classList.add('nb-iq-error');
                        span.title = d.error;
                    } else {
                        span.classList.add('nb-iq-done');
                        if (d.regen) {
                            span.textContent = '';
                            const val = document.createElement('span');
                            val.textContent = d.result;
                            const btn = document.createElement('button');
                            btn.className = 'nb-iq-refresh';
                            btn.textContent = '↻';
                            btn.title = 'Regenerate budget and refresh';
                            btn.onclick = async () => {
                                btn.disabled = true;
                                val.textContent = '⋯';
                                try {
                                    await fetch('/api/hledger/regen', {
                                        method: 'POST',
                                        headers: {'Content-Type': 'application/json'},
                                        body: JSON.stringify(d.regen)
                                    });
                                } catch (_) {}
                                try {
                                    const r2 = await fetch(`/api/inline-query?provider=${encodeURIComponent(provider)}&query=${encodeURIComponent(query)}&notebook=${encodeURIComponent(nb)}&selector=${encodeURIComponent(note?.selector || '')}`);
                                    const d2 = await r2.json();
                                    val.textContent = d2.error ? `{{${provider}: ${query}}}` : d2.result;
                                } catch (_) {
                                    val.textContent = `{{${provider}: ${query}}}`;
                                }
                                btn.disabled = false;
                            };
                            span.append(val, btn);
                        } else {
                            span.textContent = d.result;
                        }
                    }
                    _StatusPill.tick();
                })
                .catch(e => {
                    if (e.name === 'AbortError') return;
                    span.textContent = `{{${provider}: ${query}}}`;
                    span.classList.add('nb-iq-error');
                    _StatusPill.tick();
                });
        }
        if (nonInlineCount > 0) _StatusPill.add(nonInlineCount);

        // Inline includes: eager ones (near viewport) resolve sequentially top-to-bottom;
        // lazy ones (below fold) are deferred to an IntersectionObserver and resolve
        // independently as the user scrolls.  nb-inlines-settled fires after the eager
        // sequence so the TOC builds from above-fold content without waiting for the rest.
        if (inlineSpans.length) {
            _RenderBar.start(inlineSpans.length);
            _StatusPill.add(inlineSpans.length);
            const _pane = document.getElementById('nb-preview-content');
            let _remaining = inlineSpans.length;
            const _oneDone = () => {
                if (signal.aborted) return;
                if (--_remaining <= 0)
                    container.dispatchEvent(new CustomEvent('nb-inlines-complete', { bubbles: false }));
            };
            (async () => {
                for (const span of inlineSpans) {
                    if (signal.aborted) break;
                    if (_isNearViewport(span, _pane)) {
                        await _resolveInlineInclude(span, span.dataset.query, note, signal);
                        _oneDone();
                    } else {
                        _deferInlineInclude(span, note, _pane, container, signal, _oneDone);
                    }
                }
                if (!signal.aborted) {
                    container.dispatchEvent(new CustomEvent('nb-inlines-settled', { bubbles: false }));
                    _RenderBar.done();
                }
            })();
        }
    }

    // Resolve a relative path or bare filename to an nb selector.
    // baseSelector: e.g. "accts:tutorial/07_first_commands.md"
    function _resolveRelPath(rawPath, baseSelector) {
        if (!rawPath) return '';
        if (/^\.?[\w-]+:/.test(rawPath)) return rawPath;  // already a full selector (inc. .lib:file)
        const ci     = (baseSelector || '').indexOf(':');
        const nb     = ci >= 0 ? baseSelector.slice(0, ci) : '';
        const rest   = ci >= 0 ? baseSelector.slice(ci + 1) : baseSelector;
        const folder = rest.includes('/') ? rest.slice(0, rest.lastIndexOf('/') + 1) : '';
        const parts  = (folder + rawPath).split('/').filter(Boolean);
        const resolved = [];
        for (const p of parts) {
            if (p === '..') resolved.pop();
            else if (p !== '.') resolved.push(p);
        }
        return nb ? `${nb}:${resolved.join('/')}` : resolved.join('/');
    }

    // {{inline: path}} — fetch target note body, render markdown inline.
    // Depth-guarded: included content is not processed for further {{inline:}} to
    // prevent recursion.
    async function _resolveInlineInclude(span, rawPath, note, signal) {
        if (span.closest('.nb-inline-content')) { span.remove(); return; }
        const rendered = span.closest('.nb-rendered');
        const selector = _resolveRelPath(rawPath.trim(), note?.selector || '');
        try {
            const r = await fetch(`/api/note?selector=${encodeURIComponent(selector)}&inline=1`, { signal });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const d = await r.json();
            if (d.error) throw new Error(d.error);
            const html = _renderMarkdown(d.body || '', d.selector || selector);
            const wrap = document.createElement('div');
            wrap.className = 'nb-inline-content';
            wrap.innerHTML = `<div class="nb-rendered">${html}</div>`;
            span.replaceWith(wrap);
            _enrichRendered(wrap, d);
            window.NbAuth?.applyVisibility();
        } catch (e) {
            if (e.name === 'AbortError') return;   // navigation cancelled this render
            const err = document.createElement('span');
            err.className = 'nb-iq-error';
            err.textContent = `[inline: ${rawPath}]`;
            err.title = String(e);
            span.replaceWith(err);
        } finally {
            _RenderBar.tick();
            _StatusPill.tick();
        }
    }

    // Returns true if el is within 500px below the visible bottom of scrollRoot
    // (or the window if scrollRoot is null).  Used to classify inline includes as
    // eager (fetch immediately) vs lazy (defer to IntersectionObserver).
    function _isNearViewport(el, scrollRoot) {
        const bottom = scrollRoot
            ? scrollRoot.getBoundingClientRect().bottom
            : window.innerHeight;
        return el.getBoundingClientRect().top < bottom + 500;
    }

    // Set up an IntersectionObserver on a lazy inline-include span.  Fires
    // _resolveInlineInclude exactly once when the span scrolls within 500px of the
    // scrollRoot's edge.  The span remains as a ⋯ placeholder until then.
    function _deferInlineInclude(span, note, scrollRoot, container, signal, onComplete) {
        let fired = false;
        let io;
        const load = () => {
            if (fired || signal?.aborted) return;
            fired = true;
            io?.disconnect();
            _resolveInlineInclude(span, span.dataset.query, note, signal).then(() => {
                if (!signal?.aborted && container) _scheduleTocRebuild(container, note);
                onComplete?.();
            });
        };
        io = new IntersectionObserver((entries, observer) => {
            if (!entries[0]?.isIntersecting) return;
            observer.disconnect();
            load();
        }, { root: scrollRoot ?? null, rootMargin: '500px' });
        io.observe(span);
        _StatusPill.registerForce(load);
    }

    // Synchronously prepend a rendering notice when a note has many inline includes
    // or a very large body — injected before any async fetch begins so the countdown
    // is accurate from the first include resolution.  Skipped for chapter containers.
    function _injectRenderingNotice(container, note) {
        const rendered = container.querySelector('.nb-rendered') ?? container;
        if (rendered.closest('.nb-inline-content')) return;
        if (rendered.querySelector('.nb-rendering-notice')) return;
        const n = rendered.querySelectorAll(
            '.nb-inline-query[data-provider="inline"]').length;
        const bodyKb = Math.round((note?.body?.length || 0) / 1024);
        if (n < 5 && bodyKb < 50) return;
        const el = document.createElement('div');
        el.className = 'nb-rendering-notice';
        if (n >= 5) {
            el.innerHTML = `⏳ <span class="nb-rn-label">Rendering</span>` +
                `<span class="nb-rn-rest"> — ` +
                `<span class="nb-rn-count">${n}</span> includes to fetch</span>`;
        } else {
            el.innerHTML = `⏳ <span class="nb-rn-label">Rendering</span>` +
                `<span class="nb-rn-rest"> — ${bodyKb} KB file</span>`;
        }
        rendered.prepend(el);
    }

    // ── Synchronous wiring ─────────────────────────────────────────────────────
    // Pure DOM work: event handlers, Prism, copy buttons, CSV → spreadsheet.
    // No network calls.  Safe to call multiple times (copy buttons are guarded
    // by nb-copy-added; Prism guards with .token check).
    function _wireContainer(container, note) {
        _renderCsvBlocks(container);

        if (typeof Prism !== 'undefined') {
            const toHighlight = [...container.querySelectorAll('pre > code[class*="language-"]')]
                .filter(el => !el.querySelector('.token'));
            if (toHighlight.length > 20 && typeof IntersectionObserver !== 'undefined') {
                // Many blocks: lazy-highlight only as they scroll into view
                const _obs = new IntersectionObserver((entries, observer) => {
                    entries.forEach(entry => {
                        if (!entry.isIntersecting) return;
                        observer.unobserve(entry.target);
                        Prism.highlightElement(entry.target);
                    });
                }, { rootMargin: '400px' });
                toHighlight.forEach(el => _obs.observe(el));
            } else {
                toHighlight.forEach(el => Prism.highlightElement(el));
            }
        }

        container.querySelectorAll('pre:not(.nb-copy-added)').forEach(pre => {
            const code = pre.querySelector('code');
            if (!code) return;
            pre.classList.add('nb-copy-added');
            const btn = document.createElement('button');
            btn.className = 'nb-copy-btn';
            btn.title = 'Copy to clipboard';
            btn.textContent = '⎘';
            btn.addEventListener('click', e => {
                e.stopPropagation();
                navigator.clipboard.writeText(code.innerText || code.textContent || '').then(() => {
                    btn.textContent = '✓';
                    setTimeout(() => { btn.textContent = '⎘'; }, 1500);
                }).catch(() => {});
            });
            pre.appendChild(btn);
        });

        const _hq = [NbNav.searchQuery?.trim(), NbNav.tagsQuery?.trim()]
            .filter(Boolean).join(' ');
        if (_hq) _highlightTerms(container.querySelector('.nb-rendered'), _hq);

        container.querySelectorAll('.nb-wiki-link').forEach(el => {
            el.addEventListener('click', async () => {
                const sel  = el.dataset.selector;
                const frag = el.dataset.fragment || '';
                if (sel) await openNote(await _resolveWikilinkSelector(sel));
                if (frag) {
                    const pane   = document.getElementById('nb-preview-content');
                    const fragLc = frag.toLowerCase().trim();
                    const slug   = fragLc.replace(/\s+/g, '-').replace(/[^\w-]/g, '');
                    const target = pane?.querySelector(`[id="${CSS.escape(slug)}"]`)
                        ?? [...(pane?.querySelectorAll('h1,h2,h3,h4,h5,h6') ?? [])]
                            .find(h => h.textContent.trim().toLowerCase() === fragLc);
                    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
        });

        container.querySelectorAll('.nb-tag-link').forEach(el => {
            el.addEventListener('click', () => {
                const tag      = el.textContent.trim();
                const norm     = tag.startsWith('#') ? tag : '#' + tag;
                const tagsEl   = document.getElementById('nb-tags');
                const tagsCl   = document.getElementById('nb-tags-clear');
                const current  = NbNav.tagsQuery?.trim() || '';
                const newQuery = current.includes(norm) ? current
                               : current ? current + ' ' + norm : norm;
                tagsEl.value   = newQuery;
                if (tagsCl) tagsCl.hidden = false;
                NbNav.setTagsQuery(newQuery);
                NbNav.reexecute();
            });
        });

        // When container itself is .nb-rendered (e.g. test block output), query a[href] directly.
        const _linkEls = container.classList.contains('nb-rendered')
            ? container.querySelectorAll('a[href]')
            : container.querySelectorAll('.nb-rendered a[href]');
        _linkEls.forEach(el => {
            const href = el.getAttribute('href');
            if (!href) return;
            if (/^(https?|mailto|ftp):/.test(href)) {
                el.setAttribute('target', '_blank');
                el.setAttribute('rel', 'noopener noreferrer');
            } else if (href.startsWith('note:')) {
                const path = decodeURIComponent(href.slice(5));
                el.addEventListener('click', e => { e.preventDefault(); openNote(path); });
                el.classList.add('nb-nb-link');
            } else if (href.startsWith('term:')) {
                const raw = decodeURIComponent(href.slice(5));
                const cmd = raw.replace(/\{(file|dir|name|selector|notebook|title)\}/g, (_, v) => ({
                    file:     note?.path     || '',
                    dir:      note?.path     ? note.path.replace(/\/[^/]+$/, '') : '',
                    name:     note?.filename ? note.filename.replace(/\.[^.]+$/, '') : '',
                    selector: note?.selector || '',
                    notebook: note?.notebook || '',
                    title:    note?.title    || '',
                })[v] ?? '');
                el.addEventListener('click', e => { e.preventDefault(); NbWeb.runInTerminal(cmd); });
                el.classList.add('nb-term-link');
            } else if (/^[a-z][a-z0-9_-]*:[^/]/.test(href)) {
                el.addEventListener('click', e => { e.preventDefault(); openNote(href); });
                el.classList.add('nb-nb-link');
            }
        });

        _wrapUuids(container);
        container.querySelectorAll('.nb-uuid-ref').forEach(el =>
            el.addEventListener('click', e => _showInfoPopover(e, el.dataset.uuid)));

        container.querySelectorAll('.nb-todo-check').forEach(cb => {
            cb.addEventListener('change', () => _toggleTask(note?.selector, cb.dataset.task, cb.checked));
        });
    }

    // ── Async fetching ─────────────────────────────────────────────────────────
    // Fires all network-bound render work: inline includes, codeblock renderers,
    // wikilink label resolution.  Does not repeat sync wiring.
    function _fetchContainer(container, note) {
        _resolveInlineQueries(container, note);

        // Phase gate: wait for eager inline includes before firing codeblocks and
        // wikilinks.  Inline includes load sequentially and dispatch nb-inlines-settled
        // when the eager sequence is done; if there are no inlines (or all are lazy)
        // the event fires immediately, so non-book notes see no delay.
        (async () => {
            const signal  = _renderAbort.signal;
            const inlines = container.querySelectorAll('.nb-inline-query[data-provider="inline"]');
            if (inlines.length) {
                await new Promise(resolve =>
                    container.addEventListener('nb-inlines-settled', resolve, { once: true }));
            }
            if (signal.aborted) return;
            await NbWeb.renderCodeblocks(container);
            if (signal.aborted) return;
            _resolveWikilinks(container);
        })();
    }

    // Combined entry point — wire then fetch.  Used for the main note body,
    // chapter inclusions, and the annotation foot.
    function _enrichRendered(container, note) {
        _wireContainer(container, note);
        _fetchContainer(container, note);
        _applyFoldableHeadings(container, note);
    }

    function _applyFoldableHeadings(container, note) {
        const raw = note?.meta?.foldable ?? note?.effective_fm?.foldable;
        if (!raw) return;
        const patterns = (Array.isArray(raw) ? raw : [raw])
            .map(p => { try { return new RegExp(String(p), 'i'); } catch(_) { return null; } })
            .filter(Boolean);
        if (!patterns.length) return;

        const rendered = container.querySelector('.nb-rendered');
        if (!rendered) return;
        const headings = [...rendered.querySelectorAll('h1,h2,h3,h4,h5,h6')];

        for (const h of headings) {
            const level  = parseInt(h.tagName[1]);
            const raw    = '#'.repeat(level) + ' ' + h.textContent.trim();
            if (!patterns.some(re => re.test(raw))) continue;

            // Collect fold content — siblings until next heading of equal or higher level
            const getFoldEls = () => {
                const els = [];
                let el = h.nextElementSibling;
                while (el) {
                    if (el.matches('h1,h2,h3,h4,h5,h6') && parseInt(el.tagName[1]) <= level) break;
                    els.push(el);
                    el = el.nextElementSibling;
                }
                return els;
            };

            const key     = `nb-fold:${note?.selector || ''}:${raw}`;
            const toggle  = document.createElement('span');
            toggle.className  = 'nb-fold-toggle';
            toggle.setAttribute('aria-label', 'toggle section');
            h.prepend(toggle);

            const applyState = folded => {
                toggle.textContent = folded ? '▸' : '▾';
                toggle.classList.toggle('nb-fold-closed', folded);
                getFoldEls().forEach(el => { el.hidden = folded; });
                localStorage.setItem(key, folded ? '1' : '0');
            };

            const stored = localStorage.getItem(key);
            applyState(stored === '1');

            toggle.addEventListener('click', e => {
                e.stopPropagation();
                applyState(!toggle.classList.contains('nb-fold-closed'));
            });
            h.style.cursor = 'pointer';
            h.addEventListener('click', e => {
                if (e.target === toggle) return;
                applyState(!toggle.classList.contains('nb-fold-closed'));
            });
        }
    }

    function _buildToc(container, note) {
        const rendered = container.querySelector('.nb-rendered');
        if (!rendered) return;
        const headings = [...rendered.querySelectorAll('h1, h2, h3, h4')];
        if (headings.length < 2) return;
        const slugCount = {};
        for (const h of headings) {
            if (!h.id) {
                let slug = h.textContent.trim().toLowerCase()
                    .replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-')
                    .replace(/-+/g, '-').replace(/^-|-$/g, '') || 'section';
                const n = slugCount[slug] ?? 0;
                slugCount[slug] = n + 1;
                h.id = n === 0 ? slug : `${slug}-${n}`;
            }
        }

        const tocBar = document.getElementById('nb-toc-bar');
        if (!tocBar) return;

        const summary = document.createElement('summary');
        summary.className = 'nb-toc-header';
        const sel = note.selector || '';
        const raw = sel.includes(':') ? sel.slice(sel.indexOf(':') + 1) : sel;
        const parts = raw ? raw.split('/') : [];
        const file   = parts[parts.length - 1] || '';
        const parent = parts.length > 1 ? parts[parts.length - 2] : '';
        const notePath = parent ? `~/..${parent}/${file}` : (file ? `~/${file}` : '');
        summary.innerHTML = `<span class="nb-toc-label">TOC</span>`
            + (notePath ? `<span class="nb-toc-path">${notePath}</span>` : '')
            + `<span class="nb-toc-meta">${headings.length} ↑</span>`;
        tocBar.innerHTML = '';
        tocBar.appendChild(summary);

        const ul = document.createElement('ul');
        const pane = document.getElementById('nb-preview-content');
        for (const h of headings) {
            const li = document.createElement('li');
            li.className = `nb-toc-${h.tagName.toLowerCase()}`;
            const a = document.createElement('a');
            a.href = '#' + h.id;
            a.textContent = h.textContent;
            a.addEventListener('click', e => {
                e.preventDefault();
                pane?.querySelector(`#${CSS.escape(h.id)}`)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                tocBar.open = false;
            });
            li.appendChild(a);
            ul.appendChild(li);
        }
        tocBar.appendChild(ul);
        tocBar.hidden = false;
    }

    function _finishRendered(container, note) {
        _enrichRendered(container, note);
        const tocBar = document.getElementById('nb-toc-bar');
        if (tocBar) tocBar.hidden = true;
        if (note?.meta?.toc) {
            _buildToc(container, note);
            if (NbWeb.getCodeblockRenderer?.('toc')) {
                if (tocBar) tocBar.hidden = true;
            } else {
                _markTocPartial(container);
                _watchInlineTocRebuild(container, note);
            }
        }
        _buildTabs(note);
        _buildFmBlocks(note);
        _appendAnnotation(container, note);
        if (note?.effective_xref ?? note?.meta?.xref) _enrichXref(container, note);
        _injectAccessBadge(note);
    }

    async function _buildTabs(note) {
        const bar = document.getElementById('nb-tabs-bar');
        if (!bar) return;
        bar.innerHTML = '';
        bar.hidden = true;

        const rawTabs = note?.meta?.tabs ?? note?.effective_fm?.tabs;
        if (!rawTabs) return;
        const entries = Array.isArray(rawTabs) ? rawTabs : String(rawTabs).split(',').map(s => s.trim()).filter(Boolean);
        if (!entries.length) return;

        // Resolve a relative tab entry to a full selector.
        // Entries can be: bare filename, relative path (../folder/file.md), or full selector (nb:file.md)
        function _resolveTabEntry(entry) {
            if (entry.includes(':')) return entry;  // already a full selector
            const nb  = note.notebook || NbNav.notebook;
            const rel = note.filename ? note.filename.split('/').slice(0, -1).join('/') : '';
            // Normalise ../  paths relative to note's folder
            const parts = (rel ? rel + '/' : '') + entry;
            const resolved = parts.split('/').reduce((acc, seg) => {
                if (seg === '..') { acc.pop(); } else if (seg && seg !== '.') { acc.push(seg); }
                return acc;
            }, []);
            return nb + ':' + resolved.join('/');
        }

        bar.hidden = false;

        for (const entry of entries) {
            const raw = entry.trim();
            const isFolder = raw.endsWith('/');
            const sel = _resolveTabEntry(raw);
            const active = sel === note.selector;
            const btn = document.createElement('button');
            btn.className = 'nb-tab' + (active ? ' nb-tab--active' : '');
            if (active && note.tag_color) {
                const tc = _matchTagColor(note.tag_color, note.tags);
                if (tc) btn.style.setProperty('--tab-active-color', tc);
            }

            if (isFolder) {
                // Label: last non-empty path segment of the folder path
                const segments = raw.replace(/\/$/, '').split(/[:/]/);
                btn.textContent = segments.filter(Boolean).pop() || raw;
                if (!active) btn.addEventListener('click', () => {
                    const [nb, ...rest] = sel.split(':');
                    NbNav.drillFolderInNotebook(nb, rest.join(':').replace(/\/$/, ''));
                });
            } else {
                btn.textContent = sel.split(':').pop().replace(/\.md$/, '');  // interim label
                if (!active) btn.addEventListener('click', () => openNote(sel));
                fetch('/api/note?selector=' + encodeURIComponent(sel))
                    .then(r => r.ok ? r.json() : null)
                    .then(d => { if (d) btn.textContent = d.meta?.alias || d.title || d.filename || sel; })
                    .catch(() => {});
            }
            bar.appendChild(btn);
        }
    }

    async function _buildFmBlocks(note) {
        const wrap = document.getElementById('nb-fm-blocks');
        if (!wrap) return;
        wrap.innerHTML = '';
        wrap.hidden = true;
        if (!note?.meta) return;

        const fu = NbWeb.fmUtils;
        const blockData = []; // { block, renderer, fmKey }

        const fmSource = { ...(note.effective_fm || {}), ...note.meta };

        // Apply theme from config chain; fall back to 'default' when unset
        const noteTheme = fmSource.theme || 'default';
        if (noteTheme !== NbTheme.getSlug())
            NbTheme.apply(noteTheme, NbTheme.getMode());

        const _tocMin = fmSource.toc_min != null ? Number(fmSource.toc_min) : null;
        for (const [key, val] of Object.entries(fmSource)) {
            if (key === 'check') continue;
            if (key === 'toc' && _tocMin != null) {
                const pane = document.getElementById('nb-preview-content');
                const hCount = pane ? pane.querySelectorAll('h1,h2,h3,h4,h5,h6').length : 0;
                if (hCount < _tocMin) continue;
            }
            const r = NbWeb.getCodeblockRenderer(key);
            if (!r) continue;
            const query = val === true ? '' : String(val ?? '').trim();
            const tmp = document.createElement('div');
            tmp.innerHTML = r.html(query);
            const block = tmp.firstElementChild;
            if (!block) continue;
            if (r.renderOne && fu?.buildFmSkeleton) fu.buildFmSkeleton(block, key);
            wrap.appendChild(block);
            const bCls = [...block.classList].find(c => c.endsWith('-block')) || 'block';
            const bId  = block.dataset.cmd || block.dataset.query || block.dataset.period || '';
            blockData.push({ block, renderer: r, fmKey: `nb-fm:${bCls}:${bId}` });
        }
        if (!blockData.length) return;
        wrap.hidden = false;

        const wireFm = (block, fmKey) => {
            const hdr = block.querySelector('[class*="-header"]');
            if (hdr && !hdr.dataset.fmWired) {
                hdr.dataset.fmWired = '1';
                hdr.addEventListener('click', () => setTimeout(() => {
                    block.classList.contains('nb-collapsed')
                        ? localStorage.removeItem(fmKey)
                        : localStorage.setItem(fmKey, '1');
                }, 0));
            }
        };

        const eagerRenderers = new Set();
        const lazyRenders = [];
        for (const { block, renderer, fmKey } of blockData) {
            const wasOpen = localStorage.getItem(fmKey) === '1';
            if (renderer.renderOne && fu?.buildFmSkeleton) {
                // Lazy: always start collapsed; render body only on first expand
                block.classList.add('nb-collapsed');
                let rendered = false;
                const doRender = async () => {
                    if (rendered) return;
                    rendered = true;
                    NbWeb.statusPill?.add(1);
                    try { await renderer.renderOne(block); }
                    finally { NbWeb.statusPill?.tick(); }
                    wireFm(block, fmKey);
                };
                const skelHdr = block.querySelector('[class*="-header"]');
                if (skelHdr && !skelHdr.dataset.fmWired) {
                    skelHdr.dataset.fmWired = '1';
                    skelHdr.addEventListener('click', () => {
                        const nowCollapsed = block.classList.toggle('nb-collapsed');
                        nowCollapsed ? localStorage.removeItem(fmKey) : localStorage.setItem(fmKey, '1');
                        if (!nowCollapsed) doRender();
                    });
                }
                lazyRenders.push(doRender);
            } else {
                // Eager: render immediately (tui, check, no-renderOne renderers)
                if (!wasOpen) block.classList.add('nb-collapsed');
                eagerRenderers.add(renderer);
            }
        }

        if (eagerRenderers.size) {
            for (const r of eagerRenderers) await r.render(wrap);
            for (const { block, renderer, fmKey } of blockData) {
                if (!renderer.renderOne) wireFm(block, fmKey);
            }
        }

        // Background render: populate bar metadata while idle so headers show real
        // data (counts, balances, etc.) even if the user never opens a block.
        // doRender() is idempotent — user clicks before idle fires win the race.
        if (lazyRenders.length) {
            const bgRender = async () => { for (const fn of lazyRenders) await fn(); };
            if (typeof requestIdleCallback !== 'undefined') {
                requestIdleCallback(() => bgRender(), { timeout: 8000 });
            } else {
                setTimeout(bgRender, 200);
            }
        }
    }

    // Build synthetic Type-1 test fences from `tests:` FM or config chain.
    // check: hl-          → one block running all hl-* scripts
    // check: [nb-, hl-]   → two blocks, one per prefix
    // check: ""           → empty string suppresses inherited (returns '')
    // check_add: unions in additions from every config level (never overrides)
    // check_skip: subtracts from the resolved (check ∪ check_add) set — a
    //             skip entry ending in '-' excludes any token sharing that
    //             family prefix (whole family-glob token or individual
    //             script name alike); an exact entry excludes only itself.
    //             Applies unconditionally from every level, same as
    //             check_add — a note's own check: does not grant immunity.
    // Dotfiles used to be hardcoded-excluded here ("dotfiles are the SOURCE
    // of config, never self-inject"). Removed 2026-07-07: dotfiles cascade
    // like every other note type now (djp's own real .djp.md sets check_add:
    // and expects it to render) -- see claude:mainjs-check-cascade-fix.md for
    // the full reasoning. Note dotfiles were ALSO independently broken by the
    // renderPreview() branch-dispatch bug this same fix addresses (they go
    // through the _pluginHtml !== null branch via nbweb-specialty.js's
    // registered renderer, not the generic fallback) -- both bugs applied to
    // dotfiles simultaneously; both are fixed here.
    function _virtualTestPrefix(note) {
        // Per-note FM check: wins; fall back to effective value from config chain
        const raw = (note?.meta?.check !== undefined)
            ? note.meta.check
            : note?.effective_checks;
        // null, undefined, or empty string all suppress the base set
        const base = (raw == null || raw === '' || raw === false) ? [] :
            Array.isArray(raw)
                ? raw.map(s => String(s).trim()).filter(Boolean)
                : String(raw).trim().split(/[\s,]+/).filter(Boolean);

        // check_add: unions from note FM + every config level (never overrides)
        const addRaw = [note?.meta?.check_add, note?.effective_check_add]
            .filter(Boolean).join(' ');
        const adds = addRaw.trim().split(/[\s,]+/).filter(Boolean);

        const all = [...new Set([...base, ...adds])];
        if (!all.length) return '';

        // check_skip: unions from note FM + every config level (never overrides)
        const skipRaw = [note?.meta?.check_skip, note?.effective_check_skip]
            .filter(Boolean).join(' ');
        const skips = skipRaw.trim().split(/[\s,]+/).filter(Boolean);

        const filtered = skips.length
            ? all.filter(tok => !skips.some(skip =>
                skip.endsWith('-') ? (tok === skip || tok.startsWith(skip)) : tok === skip))
            : all;
        if (!filtered.length) return '';
        return filtered.map(p => `\`\`\`check\n${p}\n\`\`\``).join('\n') + '\n\n';
    }

    const _ACCESS_LEVELS = ['guest', 'user', 'office', 'admin', 'tech'];

    function _injectAccessBadge(note) {
        // Remove any existing badge; restore bar visibility if it was badge-only
        const oldBadge = document.getElementById('nb-access-badge');
        if (oldBadge) {
            oldBadge.remove();
            const bar    = document.getElementById('nb-cmd-output-bar');
            const tokDiv = document.getElementById('nb-cmd-output-tokens');
            if (bar && tokDiv && !tokDiv.hasChildNodes()) bar.hidden = true;
        }

        const nbCfg = NbWeb.getCachedNotebookConfig(note?.notebook);
        // access_badge is a notebook/folder config setting — never read from note.meta,
        // since dotfile frontmatter (e.g. .accts.md) would trigger it when viewed as a note.
        const enabled = /^(true|yes|1|on)$/i.test(String(nbCfg?.access_badge ?? ''));
        if (!enabled) return;

        // effective_access from backend is the full resolved chain
        // (note FM → folder config walk-up → notebook → global).
        // Fall back to nbCfg.access only if the note predates the field.
        const access    = note?.effective_access
                          ? String(note.effective_access)
                          : (note?.meta?.access ? String(note.meta.access)
                             : (nbCfg?.access   ? String(nbCfg.access) : 'user'));
        const inherited = !note?.meta?.access;
        const isUser    = !_ACCESS_LEVELS.includes(access);

        const clearBtn = document.getElementById('nb-cmd-output-clear');
        const bar      = document.getElementById('nb-cmd-output-bar');
        if (!clearBtn || !bar) return;

        const badge = document.createElement('span');
        badge.id        = 'nb-access-badge';
        badge.className = 'nb-access-badge' + (inherited ? ' nb-access-badge--inherited' : '');
        badge.dataset.level = isUser ? 'username' : access;
        badge.textContent   = isUser ? `@${access}` : access;
        badge.title = `access: ${access}${inherited ? ' (inherited)' : ' (inherited from notebook)'}`;
        bar.insertBefore(badge, clearBtn);
        bar.hidden = false;
    }

    // If unloaded inline spans remain after a TOC build, mark the TOC as partial
    // so the user knows more entries will appear as lazy chapters load.
    function _markTocPartial(container) {
        const toc = document.getElementById('nb-toc-bar');
        if (!toc) return;
        const pending = container.querySelectorAll('.nb-inline-query[data-provider="inline"]').length;
        toc.classList.toggle('nb-toc-partial', pending > 0);
    }

    // Debounced TOC rebuild — safe to call multiple times (lazy chapter loads call it
    // repeatedly; the 400 ms window collapses bursts into a single rebuild).
    function _scheduleTocRebuild(container, note) {
        clearTimeout(container._tocRebuildTimer);
        container._tocRebuildTimer = setTimeout(() => {
            if (!container.querySelector('.nb-rendered')) return;
            _buildToc(container, note);
            _markTocPartial(container);
        }, 400);
    }

    // Listen for the completion signals and schedule a TOC rebuild.
    //
    //   nb-inlines-settled — fired by _resolveInlineQueries after the eager sequential
    //     loop finishes; lazy chapters each call _scheduleTocRebuild directly via
    //     _deferInlineInclude so the TOC stays current as the user scrolls.
    //   nb-tests-settled   — fallback for toc:true notes with no inline includes.
    //
    // The MutationObserver approach was replaced because it debounced on every DOM
    // mutation, fired multiple times per render, and caused a CPU-loop bug.
    function _watchInlineTocRebuild(container, note) {
        if (!container.querySelector('.nb-rendered')) return;

        if (container.querySelector('.nb-inline-query[data-provider="inline"]')) {
            container.addEventListener('nb-inlines-settled', () => {
                _scheduleTocRebuild(container, note);
            }, { once: true });
        } else {
            container.addEventListener('nb-tests-settled', () => {
                _scheduleTocRebuild(container, note);
            }, { once: true });
        }
    }

    // ── Encrypted note decrypt/render ──────────────────────────────────────

    async function _decryptAndRender(note, container, decryptedContent) {
        if (decryptedContent === undefined) {
            container.innerHTML = '<div style="padding:40px;color:var(--text-muted)">Decrypting…</div>';
            try {
                const r = await fetch('/api/note/decrypt', {
                    method: 'POST',
                    headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({selector: note.selector, password: _encPassword})
                });
                if (r.status === 401) {
                    _encPassword = null;
                    renderPreview(note);   // re-render → shows lock prompt
                    return;
                }
                const d = await r.json();
                decryptedContent = d.content;
            } catch(e) {
                container.innerHTML = `<div style="padding:40px;color:var(--red)">Decrypt error: ${_esc(String(e))}</div>`;
                return;
            }
        }

        if (_encPendingEdit) {
            _encPendingEdit = false;
            _editing = true;
            _setPaneMode('edit');
            _populateEditor(_activeSelector, decryptedContent, _saveEncryptedNote);
            return;
        }

        container.innerHTML = `<div class="nb-rendered">${_renderMarkdown(decryptedContent, _activeSelector)}</div>`;
        _finishRendered(container, note);
    }

    // ── Annotation footnote ────────────────────────────────────────────────

    const _NO_ANNOTATION_TYPES = new Set();
    function _setExtrasAnnotationHint(hasAnnotation) {
        const btn = document.getElementById('nb-extras-btn');
        if (!btn) return;
        if (hasAnnotation) btn.dataset.hasAnnotation = '1';
        else delete btn.dataset.hasAnnotation;
    }

    function _appendAnnotation(container, note) {
        if (_NO_ANNOTATION_TYPES.has(note.meta?.type)) return;
        _setExtrasAnnotationHint(!!note.annotation);
        const foot = document.createElement('div');
        foot.className = 'nb-annotation-foot';
        container.appendChild(foot);
        _renderAnnotationFoot(foot, note, note.annotation || null);
    }

    function _annBodyText(raw) {
        // Strip YAML frontmatter block from annotation text before display.
        // The raw sidecar content is shown as-is in the editor; display strips FM.
        if (!raw) return raw;
        const m = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
        return m ? m[1].trim() : raw;
    }

    function _renderAnnotationFoot(foot, note, text) {
        if (text) {
            const displayText = _annBodyText(text);
            foot.innerHTML = `
                <div class="nb-ann-bar">
                    <span class="nb-ann-label">📝 Annotation</span>
                    <span class="nb-ann-actions">
                        <button class="nb-ann-edit-btn nb-tw-btn nb-action-write">Edit</button>
                        <button class="nb-ann-del-btn nb-tw-btn nb-action-write">Delete</button>
                    </span>
                </div>
                <div class="nb-ann-body nb-rendered">${_renderMarkdown(displayText)}</div>`;

            _enrichRendered(foot.querySelector('.nb-ann-body'), note);
            foot.querySelector('.nb-ann-edit-btn').addEventListener('click', () =>
                _editAnnotation(foot, note, text));
            foot.querySelector('.nb-ann-del-btn').addEventListener('click', () =>
                _deleteAnnotation(foot, note));
            _appendFmChangesBtn(foot.querySelector('.nb-ann-actions'), note);
        } else {
            foot.innerHTML = `
                <div class="nb-ann-bar nb-ann-empty">
                    <button class="nb-ann-add-btn nb-tw-btn">+ Add annotation</button>
                </div>`;
            foot.querySelector('.nb-ann-add-btn').addEventListener('click', async () => {
                let initial = '';
                try {
                    const r = await fetch(`/api/note/annotation-template?selector=${encodeURIComponent(note.selector)}`);
                    if (r.ok) { const d = await r.json(); initial = d.content || ''; }
                } catch { /* no template — start empty */ }
                _editAnnotation(foot, note, initial);
            });
            _appendFmChangesBtn(foot.querySelector('.nb-ann-bar'), note);
        }
    }

    function _editAnnotation(foot, note, current) {
        foot.hidden = true;

        const wrap    = document.getElementById('nb-ann-editor-wrap');
        const ta      = document.getElementById('nb-ann-editor');
        const pane    = document.getElementById('nb-preview-pane');
        const content = document.getElementById('nb-preview-content');

        // Restore saved split height (fallback to CSS 50%)
        const savedH = localStorage.getItem('nb-ann-split-h');
        if (savedH) content.style.flexBasis = savedH + 'px';

        ta.value = current || '';
        wrap.hidden = false;
        pane.classList.add('nb-ann-editing');
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);

        function _close(savedText) {
            wrap.hidden = true;
            pane.classList.remove('nb-ann-editing');
            content.style.flexBasis = '';
            foot.hidden = false;
            document.getElementById('nb-ann-save-btn').textContent = _t('btn_save');
            _renderAnnotationFoot(foot, note, savedText !== undefined ? savedText : (current || null));
        }

        document.getElementById('nb-ann-cancel-btn').onclick = () => _close(undefined);

        document.getElementById('nb-ann-save-btn').onclick = async () => {
            const body = ta.value.trim();
            const sb   = document.getElementById('nb-ann-save-btn');
            sb.textContent = _t('status_saving');
            try {
                const r = await fetch(`/api/note/annotate?selector=${encodeURIComponent(note.selector)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: body }),
                });
                const d = await r.json();
                if (d.ok) { _noteCache.delete(note.selector); _setExtrasAnnotationHint(!!d.annotation); _close(d.annotation); }
                else { sb.textContent = _t('btn_save'); alert('✗ ' + (d.error || 'failed')); }
            } catch(e) { sb.textContent = _t('btn_save'); alert('✗ ' + e.message); }
        };
    }

    async function _deleteAnnotation(foot, note) {
        if (!confirm('Delete annotation?')) return;
        try {
            await fetch(`/api/note/annotate?selector=${encodeURIComponent(note.selector)}`,
                { method: 'DELETE' });
            _noteCache.delete(note.selector);
            _setExtrasAnnotationHint(false);
            _renderAnnotationFoot(foot, note, null);
        } catch(e) { /* silent */ }
    }

    // ── Config dotfile renderer ────────────────────────────────────────────────
    // Triggered for type:dotfile notes with a config: FM field.
    // Renders an editable form for known config fields, followed by body content.

    function _cfgTagColorRow(tag, color) {
        return `<div class="nb-cfg-tc-row">
            <input class="nb-cfg-text nb-cfg-tc-name" type="text" value="${_esc(tag)}" placeholder="tag">
            <input class="nb-cfg-color" type="color" value="${_esc(/^#[0-9a-f]{6}$/i.test(color) ? color : '#888888')}">
            <button type="button" class="nb-cfg-tc-del nb-tw-btn">×</button>
        </div>`;
    }

    function _configFmToContent(meta, body) {
        const lines = ['---'];
        const ORDER = ['type', 'title', 'date', 'access', 'pinned', 'prepend_date', 'check', 'tag_color'];
        const handled = new Set();
        function emitYaml(key, v, indent) {
            const pad = ' '.repeat(indent);
            if (v === null || v === undefined) {
                lines.push(`${pad}${key}:`);
            } else if (Array.isArray(v)) {
                const items = v.map(item => {
                    const s = String(item);
                    return (s.includes(',') || s.includes(':') || s.includes('#') || s.includes('"') || s.startsWith(' ') || s.endsWith(' '))
                        ? `"${s.replace(/"/g, '\\"')}"` : s;
                });
                lines.push(`${pad}${key}: [${items.join(', ')}]`);
            } else if (typeof v === 'boolean') {
                lines.push(`${pad}${key}: ${v}`);
            } else if (typeof v === 'object') {
                lines.push(`${pad}${key}:`);
                for (const [k, cv] of Object.entries(v)) emitYaml(k, cv, indent + 2);
            } else {
                // Quote strings containing : or # to be safe
                const s = String(v);
                const needsQuote = s.includes(':') || s.includes('#') || s.includes('"') || s.startsWith(' ') || s.endsWith(' ');
                lines.push(`${pad}${key}: ${needsQuote ? `"${s.replace(/"/g, '\\"')}"` : s}`);
            }
        }
        function emit(key, v) { emitYaml(key, v, 0); }
        for (const key of ORDER) {
            if (key in meta) { emit(key, meta[key]); handled.add(key); }
        }
        for (const [key, val] of Object.entries(meta)) {
            if (!handled.has(key)) emit(key, val);
        }
        lines.push('---');
        if (body && body.trim()) lines.push('', body.trim());
        return lines.join('\n') + '\n';
    }

    async function _saveConfigForm(form, note, statusEl) {
        const meta = { ...note.meta };

        const access = form.querySelector('[name=access]').value;
        if (access) meta.access = access; else delete meta.access;

        const pinned = form.querySelector('[name=pinned]').value.trim();
        if (pinned) meta.pinned = pinned; else delete meta.pinned;

        const pd = form.querySelector('[name=prepend_date]').value;
        if (pd === '') delete meta.prepend_date;
        else meta.prepend_date = (pd === 'true');

        const checksText = form.querySelector('[name=check]').value.trim();
        if (checksText) meta.check = checksText.split(/\s+/).filter(Boolean);
        else delete meta.check;

        const tcRows = [...form.querySelectorAll('.nb-cfg-tc-row')];
        if (tcRows.length) {
            const tc = {};
            tcRows.forEach(r => {
                const t = r.querySelector('.nb-cfg-tc-name').value.trim();
                const c = r.querySelector('.nb-cfg-color').value;
                if (t) tc[t] = c;
            });
            if (Object.keys(tc).length) meta.tag_color = tc; else delete meta.tag_color;
        } else {
            delete meta.tag_color;
        }

        const newContent = _configFmToContent(meta, note.body);
        statusEl.textContent = 'Saving…';
        form.querySelector('.nb-cfg-save-btn').disabled = true;
        try {
            const r = await fetch('/api/note', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ selector: note.selector, content: newContent }),
            });
            const d = await r.json();
            if (d.success) {
                NbMain.bustNoteCache(note.selector);
                NbWeb.bustNotebookConfigCache(note.notebook);
                statusEl.textContent = 'Saved';
                setTimeout(() => { statusEl.textContent = ''; }, 2000);
            } else {
                statusEl.textContent = '✗ ' + (d.stderr || d.error || 'failed');
            }
        } catch(e) {
            statusEl.textContent = '✗ ' + e.message;
        } finally {
            form.querySelector('.nb-cfg-save-btn').disabled = false;
        }
    }

    function _buildConfigForm(container, note) {
        const m  = note.meta || {};
        const pm = note.parent_meta || {};   // inherited from parent chain
        const ACCESS = ['', 'guest', 'user', 'office', 'admin'];

        function _wireHint(el, ownVal, inheritedRaw, sourcePath) {
            const hint = el.parentElement.querySelector('.nb-cfg-hint');
            if (!hint) return;
            const hasInherited = inheritedRaw !== undefined && inheritedRaw !== null;
            const row = el.closest('.nb-cfg-row');
            function update() {
                const cur = el.value.trim ? el.value.trim() : el.value;
                const inheriting = hasInherited && (!cur || cur === '');
                if (inheriting) {
                    hint.textContent = sourcePath || 'inherited';
                    hint.className = 'nb-cfg-hint nb-cfg-hint-inherit';
                    row?.classList.add('nb-cfg-row--inherited');
                } else {
                    hint.textContent = '';
                    hint.className = 'nb-cfg-hint';
                    row?.classList.remove('nb-cfg-row--inherited');
                }
            }
            el.addEventListener('input',  update);
            el.addEventListener('change', update);
            update();
        }

        function row(label, ctrl, hint = '') {
            const hintHtml = hint !== false ? `<span class="nb-cfg-hint"></span>` : '';
            return `<div class="nb-cfg-row">
                <span class="nb-cfg-label" data-xref-heading="${_esc(label)}">${_esc(label)}</span>
                <div class="nb-cfg-ctrl">${ctrl}${hintHtml}</div>
            </div>`;
        }

        // access
        const accessInherit = pm.access || '(inherit)';
        const accessSel = `<select class="nb-cfg-select" name="access">${
            ACCESS.map(v => `<option value="${v}"${(m.access ?? '') === v ? ' selected' : ''}>${v || accessInherit}</option>`).join('')
        }</select>`;

        // prepend_date — tristate
        const pdCur = m.prepend_date === undefined || m.prepend_date === null ? '' : String(m.prepend_date);
        const pdInherit = pm.prepend_date !== undefined && pm.prepend_date !== null ? String(pm.prepend_date) : '(inherit)';
        const pdSel = `<select class="nb-cfg-select" name="prepend_date">${
            [['', pdInherit], ['true', 'true'], ['false', 'false']]
                .map(([v, l]) => `<option value="${v}"${pdCur === v ? ' selected' : ''}>${l}</option>`).join('')
        }</select>`;

        // check
        const checksVal      = Array.isArray(m.check) ? m.check.join(' ') : (m.check || '');
        const checksInherited = Array.isArray(pm.check) ? pm.check.join(' ') : (pm.check || '');
        const checksCtrl = `<input class="nb-cfg-text" type="text" name="check" value="${_esc(checksVal)}" placeholder="${_esc(checksInherited)}">`;

        // tag_color
        const tc = (m.tag_color && typeof m.tag_color === 'object') ? m.tag_color : {};
        const tcHtml = Object.entries(tc).map(([t, c]) => _cfgTagColorRow(t, c)).join('');
        const tcCtrl = `<div class="nb-cfg-tc-list">${tcHtml}</div>
            <button type="button" class="nb-cfg-tc-add nb-tw-btn">+ tag color</button>`;

        const bodyHtml = note.body
            ? `<div class="nb-cfg-body nb-rendered">${_renderMarkdown(note.body, note.selector)}</div>`
            : '';

        const effAccess = note.effective_access || '';
        const accessMeta = effAccess
            ? `<span class="nb-cfg-meta-item">access: ${_esc(effAccess)}</span>`
            : '';
        const headerBar = `<div class="nb-cfg-meta">
            <span class="nb-cfg-meta-item nb-cfg-meta-sel">${_esc(note.selector)}</span>
            <span class="nb-cfg-meta-item">modified ${_esc(note.mtime || '')}</span>
            ${accessMeta}
        </div>`;

        container.innerHTML = `<div class="nb-config-form">
            ${headerBar}
            <div class="nb-cfg-fields">
                ${row('access',       accessSel)}
                ${row('pinned',       `<input class="nb-cfg-text" type="text" name="pinned" value="${_esc(m.pinned || '')}" placeholder="filename.md">`)}
                ${row('prepend_date', pdSel)}
                ${row('check',        checksCtrl)}
                ${row('tag_color',    tcCtrl, false)}
            </div>
            <div class="nb-cfg-actions">
                <button type="button" class="nb-cfg-save-btn nb-tw-btn">Save</button>
                <span class="nb-cfg-status"></span>
            </div>
        </div>${bodyHtml}`;

        const form = container.querySelector('.nb-config-form');

        // Wire inherited hints
        const pms = note.parent_meta_sources || {};
        _wireHint(form.querySelector('[name=access]'),       m.access,       pm.access,       pms.access);
        _wireHint(form.querySelector('[name=pinned]'),       m.pinned,       pm.pinned,       pms.pinned);
        _wireHint(form.querySelector('[name=prepend_date]'), m.prepend_date, pm.prepend_date, pms.prepend_date);
        _wireHint(form.querySelector('[name=check]'),        m.check,        pm.check,        pms.check);

        // Wire tag-color rows
        form.querySelectorAll('.nb-cfg-tc-row').forEach(r =>
            r.querySelector('.nb-cfg-tc-del').addEventListener('click', () => r.remove()));

        form.querySelector('.nb-cfg-tc-add').addEventListener('click', () => {
            const list = form.querySelector('.nb-cfg-tc-list');
            const div = document.createElement('div');
            div.innerHTML = _cfgTagColorRow('', '#888888');
            const newRow = div.firstElementChild;
            newRow.querySelector('.nb-cfg-tc-del').addEventListener('click', () => newRow.remove());
            list.appendChild(newRow);
            newRow.querySelector('.nb-cfg-tc-name').focus();
        });

        form.querySelector('.nb-cfg-save-btn').addEventListener('click', () =>
            _saveConfigForm(form, note, form.querySelector('.nb-cfg-status')));

        const bodyEl = container.querySelector('.nb-cfg-body');
        if (bodyEl) _enrichRendered(bodyEl, note);
    }

    // ── Frontmatter Changes panel (toolbar button → panel below toolbar) ──────
    // Footer placement code preserved below but dormant — see _appendFmChangesBtn.

    async function _toggleFmChangesPanel(note, btn) {
        const panel = document.getElementById('nb-changes-panel');
        if (!panel) return;
        if (!panel.hidden) {
            panel.hidden = true; btn.classList.remove('nb-active'); return;
        }
        btn.disabled = true;
        try {
            const fu = NbWeb.fmUtils;
            if (!fu) throw new Error('fmUtils not loaded — codeblocks plugin missing?');

            const [noteD, conD] = await Promise.all([
                fetch(`/api/note?selector=${encodeURIComponent(note.selector)}`).then(r => r.json()),
                fetch(`/api/note/constraints?selector=${encodeURIComponent(note.selector)}`).then(r => r.json()),
            ]);
            if (noteD.error) throw new Error(noteD.error);

            const noteRaw     = noteD.raw || '';
            const constraints = conD.error ? {} : conD;
            const fields      = fu.parseFields(noteRaw);

            panel.innerHTML = '';
            const form = document.createElement('div');
            form.className = 'nb-fm-changes-form';

            for (const { key, value } of fields) {
                const row = document.createElement('div');
                row.className = 'nb-fm-changes-row';
                const lbl = document.createElement('label');
                lbl.className   = 'nb-fm-changes-label';
                lbl.textContent = key;
                row.appendChild(lbl);
                row.appendChild(fu.widget(key, value, constraints[key]));
                form.appendChild(row);
            }

            const actions = document.createElement('div');
            actions.className = 'nb-fm-changes-actions';

            const saveBtn = document.createElement('button');
            saveBtn.className   = 'nb-tw-btn';
            saveBtn.textContent = _t('btn_save');
            saveBtn.addEventListener('click', async () => {
                const updates = {};
                for (const w of form.querySelectorAll('[data-fm-key]')) {
                    updates[w.dataset.fmKey] = w.type === 'checkbox' ? String(w.checked) : w.value;
                }
                saveBtn.disabled = true; saveBtn.textContent = '⟳';
                try {
                    const r = await fetch('/api/note', {
                        method:  'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({ selector: note.selector, content: fu.patch(noteRaw, updates) }),
                    }).then(r => r.json());
                    if (r.error) throw new Error(r.error);
                    _noteCache.delete(note.selector);
                    panel.hidden = true;
                    btn.classList.remove('nb-active');
                    NbMain.openNote(note.selector);
                } catch(e) {
                    saveBtn.textContent = `⚠ ${e.message}`;
                    saveBtn.disabled = false;
                }
            });

            const cancelBtn = document.createElement('button');
            cancelBtn.className   = 'nb-tw-btn';
            cancelBtn.textContent = _t('btn_cancel');
            cancelBtn.addEventListener('click', () => {
                panel.hidden = true; btn.classList.remove('nb-active');
            });

            actions.appendChild(saveBtn);
            actions.appendChild(cancelBtn);
            panel.appendChild(form);
            panel.appendChild(actions);
            panel.hidden = false;
            btn.classList.add('nb-active');
        } catch(e) {
            panel.innerHTML = `<span class="nb-hl-error">⚠ ${_esc(e.message)}</span>`;
            panel.hidden = false;
        } finally {
            btn.disabled = false;
        }
    }

    // DORMANT — footer placement; kept for reference.
    // Call _appendFmChangesBtn(barEl, note) to re-enable per-note footer buttons.
    function _appendFmChangesBtn(/*bar, note*/) { /* dormant */ }

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
        pop.textContent = _t('status_loading');

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

    async function _addIncludeLinks(container, note) {
        const spans = [...container.querySelectorAll('code.language-ledger .token.keyword')];
        for (const span of spans) {
            const text = span.textContent;
            if (!text.startsWith('include ')) continue;
            const incPath = text.slice('include '.length).trim();
            if (!incPath) continue;
            try {
                const d = await fetch(
                    `/api/hledger/resolve-include?selector=${encodeURIComponent(note.selector)}&path=${encodeURIComponent(incPath)}`
                ).then(r => r.json());
                if (!d.selector) continue;
                const sel = d.selector;
                const link = document.createElement('span');
                link.className = 'nb-include-link' + (d.exists ? '' : ' nb-include-missing');
                link.title     = d.exists ? `Open ${sel}` : `Not found: ${sel}`;
                link.textContent = incPath;
                link.addEventListener('click', () => openNote(sel));
                span.textContent = 'include ';
                span.appendChild(link);
            } catch (_) {}
        }
    }

    function _buildCsvBarblock(label, rowCount, blockIdx, addBtnFn) {
        const wrap = document.createElement('div');
        wrap.className = 'nb-csv-wrap';

        const hdr = document.createElement('div');
        hdr.className = 'nb-barblock nb-csv-header';

        const icon = document.createElement('span');
        icon.className = 'nb-cb-icon';
        icon.textContent = 'CSV';
        icon.setAttribute('aria-label', 'csv');
        hdr.appendChild(icon);

        const meta = document.createElement('span');
        meta.className = 'nb-csv-meta';
        meta.innerHTML = `<span class="nb-csv-name">${_esc(label)}</span> <span class="nb-csv-count">${rowCount}</span>`;
        hdr.appendChild(meta);

        const acts = document.createElement('span');
        acts.className = 'nb-barblock-acts';

        if (addBtnFn !== undefined) {
            const addBtn = document.createElement('button');
            addBtn.className = 'nb-tw-btn nb-csv-add-btn';
            addBtn.title = 'Add row';
            addBtn.textContent = '+';
            if (addBtnFn) addBtn.addEventListener('click', e => { e.stopPropagation(); addBtnFn(addBtn); });
            acts.appendChild(addBtn);
        }

        const saveBtn = document.createElement('button');
        saveBtn.className = 'nb-tw-btn nb-csv-save-btn';
        saveBtn.title = 'Save';
        saveBtn.textContent = '↓';
        saveBtn.addEventListener('click', e => { e.stopPropagation(); _saveCsvBlocks(saveBtn); });
        acts.appendChild(saveBtn);
        hdr.appendChild(acts);
        wrap.appendChild(hdr);

        const collapseKey = `nb-collapse:nb-csv-wrap:${blockIdx}`;
        if (localStorage.getItem(collapseKey) === '1') wrap.classList.add('nb-collapsed');
        hdr.addEventListener('click', e => {
            if (acts.contains(e.target)) return;
            const collapsed = wrap.classList.toggle('nb-collapsed');
            collapsed ? localStorage.setItem(collapseKey, '1') : localStorage.removeItem(collapseKey);
        });

        const body = document.createElement('div');
        body.className = 'nb-csv-body';
        wrap.appendChild(body);

        return { wrap, body, meta };
    }

    function _renderCsvBlocks(container) {
        const blocks     = [...container.querySelectorAll('pre > code.language-csv')];
        const tmplBlocks = [...container.querySelectorAll('.nb-csv-tmpl-pending')];
        if (!blocks.length && !tmplBlocks.length) return;

        let blockIdx = 0;

        blocks.forEach(code => {
            const pre = code.parentElement;
            const raw = code.textContent.trim();
            const allRows = raw.split('\n')
                .filter(r => r.trim() !== '')
                .map(r => r.split(',').map(cell => cell.replace(/^"|"$/g, '').replace(/""/g, '"')));

            const [headerRow = [], ...dataRows] = allRows;
            const columns = headerRow.map(h => ({ title: h, width: 120 }));

            const { wrap, body } = _buildCsvBarblock('csv', dataRows.length, blockIdx++, undefined);

            const host = document.createElement('div');
            host.className = 'nb-csv-block';
            host.dataset.csvHeaders = JSON.stringify(headerRow);
            body.appendChild(host);
            pre.replaceWith(wrap);

            const jssP = jspreadsheet(host, {
                worksheets: [{
                    data: dataRows.length ? dataRows : [Array(Math.max(headerRow.length, 1)).fill('')],
                    columns: columns.length ? columns : undefined,
                }],
            });
            host._csvSheet = Array.isArray(jssP) ? jssP[0] : (jssP?.worksheets?.[0] ?? jssP);
        });

        tmplBlocks.forEach(pending => _renderCsvTmplBlock(pending, blockIdx++));
    }

    async function _renderCsvTmplBlock(pending, blockIdx) {
        const token      = pending.dataset.token;
        const bodyText   = decodeURIComponent(pending.dataset.content || '');
        const dataRows   = bodyText.split('\n')
            .filter(r => r.trim() !== '')
            .map(r => r.split(',').map(cell => cell.replace(/^"|"$/g, '').replace(/""/g, '"')));

        const { wrap, body, meta } = _buildCsvBarblock(token, dataRows.length, blockIdx, null);
        pending.replaceWith(wrap);

        let headerRow = [], footerRows = [];
        try {
            const r = await fetch(`/api/lib/csv-template?name=${encodeURIComponent(token)}`);
            if (!r.ok) throw new Error((await r.json()).error || r.status);
            const d = await r.json();
            const tmplRows = d.content.trim().split('\n')
                .filter(r => r.trim() !== '')
                .map(r => r.split(',').map(cell => cell.replace(/^"|"$/g, '').replace(/""/g, '"')));
            const ci = tmplRows.findIndex(r => r.length === 1 && r[0].trim().toLowerCase() === 'contents');
            if (ci >= 0) {
                headerRow  = tmplRows[0] || [];
                footerRows = tmplRows.slice(ci + 1);
            } else {
                headerRow = tmplRows[0] || [];
            }
            if (d.path) {
                const nameEl = meta.querySelector('.nb-csv-name');
                nameEl.classList.add('nb-csv-name-linked');
                nameEl.title = d.path;
                nameEl.addEventListener('click', e => { e.stopPropagation(); NbMain.openNote(d.path); });
            }
        } catch(e) {
            body.innerHTML = `<div style="padding:12px;color:var(--red)">Template error: ${_esc(String(e))}</div>`;
            return;
        }

        const host = document.createElement('div');
        host.className = 'nb-csv-block';
        host.dataset.csvToken       = token;
        host.dataset.csvHeaders     = JSON.stringify(headerRow);
        host.dataset.csvFooterCount = String(footerRows.length);
        body.appendChild(host);

        // Rewrite footer formula ranges to match actual data row count,
        // preventing circular references when the footer lands inside =SUM(X1:XN).
        const dataCount = Math.max(dataRows.length, 1);
        const adjustedFooter = footerRows.map(row => row.map(cell => {
            const s = String(cell);
            if (!s.startsWith('=')) return cell;
            return s.replace(/([A-Z]+)(\d+):([A-Z]+)(\d+)/g, (_, c1, r1, c2) =>
                r1 === '1' ? `${c1}1:${c2}${dataCount}` : `${c1}${r1}:${c2}${dataCount}`
            );
        }));

        const sheetData = [
            ...(dataRows.length ? dataRows : [Array(Math.max(headerRow.length, 1)).fill('')]),
            ...adjustedFooter,
        ];

        const jss = jspreadsheet(host, {
            worksheets: [{
                data: sheetData,
                columns: headerRow.length ? headerRow.map(h => ({ title: h, width: 120 })) : undefined,
            }],
        });
        // Normalise worksheet access across jspreadsheet v9 (array) and v10 (object)
        host._csvSheet = Array.isArray(jss) ? jss[0] : (jss?.worksheets?.[0] ?? jss);

        // Update count badge now that template and data are both known
        meta.querySelector('.nb-csv-count').textContent = dataRows.length;

        // CSV badge on the header acts as checklist trigger
        const badge = wrap.querySelector('.nb-cb-icon');
        if (badge) {
            badge.title = `Pick from ${token} catalog`;
            badge.style.cursor = 'pointer';
            badge.addEventListener('click', e => { e.stopPropagation(); _openCsvChecklist(badge, token, host, wrap); });
        }
    }

    function _parseCatalogFull(body) {
        const lines = body.split('\n');
        let i = 0, groups = [], curGroup = null;
        while (i < lines.length) {
            const line = lines[i];
            if (/^#+\s/.test(line)) {
                curGroup = { name: line.replace(/^#+\s*/, '').trim(), rows: [] };
                groups.push(curGroup);
                i++;
            } else if (line.startsWith('```csv')) {
                i++;
                const csvLines = [];
                while (i < lines.length && !lines[i].startsWith('```')) { csvLines.push(lines[i]); i++; }
                i++;
                const allRows = csvLines
                    .filter(l => l.trim() && l.trim().toLowerCase() !== 'contents')
                    .map(l => l.split(',').map(c => c.replace(/^"|"$/g, '').replace(/""/g, '"').trim()));
                if (allRows.length < 2) continue;
                if (!curGroup) { curGroup = { name: '', rows: [] }; groups.push(curGroup); }
                curGroup.rows.push(...allRows.slice(1).filter(r => r.some(c => c)));
            } else { i++; }
        }
        return groups;
    }

    async function _openCsvChecklist(trigger, token, host, wrap) {
        if (trigger._chkPop) { trigger._chkPop.remove(); trigger._chkPop = null; return; }
        const note = NbMain.activeNote();
        if (!note) return;
        const nb     = note.notebook || '';
        const sel    = note.selector || '';
        const rel    = sel.includes(':') ? sel.split(':').slice(1).join(':') : '';
        const folder = rel.includes('/') ? rel.split('/').slice(0, -1).join('/') : '';
        const origTitle = trigger.title;
        trigger.style.opacity = '0.5';
        try {
            const r = await fetch(`/api/csv/source?notebook=${encodeURIComponent(nb)}&folder=${encodeURIComponent(folder)}&token=${encodeURIComponent(token)}`);
            const d = await r.json();
            if (!d.found) { trigger.title = `No ${token} catalog found`; return; }
            const nd = await (await fetch(`/api/note?selector=${encodeURIComponent(d.selector)}`)).json();
            const groups = _parseCatalogFull(nd.body || '');

            const sheet       = host._csvSheet;
            const currentData = sheet ? sheet.getData() : [];
            const footerCount = parseInt(host.dataset.csvFooterCount || '0', 10);
            const dataRows    = currentData.slice(0, currentData.length - footerCount);
            const currentDescs = new Set(dataRows.map(r => (r[0] || '').trim()).filter(Boolean));

            const pop = _buildCsvChecklistPopup(groups, currentDescs, async selectedRows => {
                if (sheet) {
                    const footerData = currentData.slice(currentData.length - footerCount);
                    sheet.setData([...selectedRows, ...footerData]);
                    const countEl = wrap.querySelector('.nb-csv-count');
                    if (countEl) countEl.textContent = selectedRows.length;
                    await _saveCsvBlocks(null);
                }
                pop.remove(); trigger._chkPop = null;
            });

            // Position: vertically centred on barblock, left offset ~160px to clear badge+token
            const wRect = wrap.getBoundingClientRect();
            const popH  = 340;
            const top   = Math.max(8, wRect.top + (wRect.height - popH) / 2);
            pop.style.top  = Math.min(top, window.innerHeight - popH - 8) + 'px';
            pop.style.left = (wRect.left + 160) + 'px';
            document.body.appendChild(pop);
            trigger._chkPop = pop;

            setTimeout(() => {
                const onOut = e => { if (!pop.contains(e.target) && e.target !== trigger) { pop.remove(); trigger._chkPop = null; document.removeEventListener('click', onOut); } };
                document.addEventListener('click', onOut);
            }, 0);
        } catch(e) {
            trigger.title = `Error: ${e.message}`;
        } finally {
            trigger.style.opacity = '';
            trigger.title = origTitle;
        }
    }

    function _buildCsvChecklistPopup(groups, currentDescs, onSave) {
        const pop = document.createElement('div');
        pop.className = 'nb-csv-cl-pop';
        const inner = document.createElement('div');
        inner.className = 'nb-csv-cl-inner';
        const checkboxes = [];

        for (const g of groups) {
            if (!g.rows.length) continue;
            if (g.name) {
                const gh = document.createElement('div');
                gh.className = 'nb-csv-cl-group';
                gh.textContent = g.name;
                inner.appendChild(gh);
            }
            for (const row of g.rows) {
                const desc = (row[0] || '').trim();
                if (!desc) continue;
                const lbl = document.createElement('label');
                lbl.className = 'nb-csv-cl-item';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = currentDescs.has(desc);
                checkboxes.push({ cb, row });
                const span = document.createElement('span');
                span.className = 'nb-csv-cl-desc';
                span.textContent = desc;
                lbl.append(cb, span);
                if (row[2]) {
                    const cost = document.createElement('span');
                    cost.className = 'nb-csv-cl-cost';
                    cost.textContent = row[2];
                    lbl.appendChild(cost);
                }
                inner.appendChild(lbl);
            }
        }
        pop.appendChild(inner);
        const footer = document.createElement('div');
        footer.className = 'nb-csv-cl-footer';
        const saveBtn = document.createElement('button');
        saveBtn.className = 'nb-btn';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', () => onSave(checkboxes.filter(({cb}) => cb.checked).map(({row}) => row)));
        footer.appendChild(saveBtn);
        pop.appendChild(footer);
        return pop;
    }

    function _csvRowsToCsv(rows) {
        return rows.map(row =>
            row.map(cell => {
                const s = String(cell ?? '');
                return s.includes(',') || s.includes('"') || s.includes('\n')
                    ? `"${s.replace(/"/g, '""')}"` : s;
            }).join(',')
        ).join('\n');
    }

    async function _saveCsvBlocks(triggerBtn) {
        if (!_activeSelector) return;
        const origText = triggerBtn?.textContent;
        if (triggerBtn) triggerBtn.textContent = _t('status_saving');
        try {
            const r  = await fetch('/api/note?selector=' + encodeURIComponent(_activeSelector));
            const d  = await r.json();
            let raw  = d.raw || d.body || '';

            // Template csv blocks: ```csv token\n...\n``` — save only user data rows
            const tmplHosts = [...document.querySelectorAll('.nb-csv-block[data-csv-token]')];
            let tmplIdx = 0;
            raw = raw.replace(/```csv ([\w-]+)\n([\s\S]*?)```/g, (match, token) => {
                const host = tmplHosts[tmplIdx++];
                const ws = host?._csvSheet;
                if (!ws) return match;
                const footerCount = parseInt(host.dataset.csvFooterCount || '0', 10);
                const allData = ws.getData();
                const dataRows = footerCount > 0 ? allData.slice(0, -footerCount) : allData;
                return `\`\`\`csv ${token}\n${_csvRowsToCsv(dataRows)}\n\`\`\``;
            });

            // Plain csv blocks: ```csv\n...\n``` — save header + all rows
            const plainHosts = [...document.querySelectorAll('.nb-csv-block:not([data-csv-token])')];
            let plainIdx = 0;
            raw = raw.replace(/```csv\n([\s\S]*?)```/g, (match) => {
                const host = plainHosts[plainIdx++];
                const ws = host?._csvSheet;
                if (!ws) return match;
                const headers = host.dataset.csvHeaders ? JSON.parse(host.dataset.csvHeaders) : [];
                const data    = ws.getData();
                const allRows = headers.length ? [headers, ...data] : data;
                return '```csv\n' + _csvRowsToCsv(allRows) + '\n```';
            });

            const wr = await fetch('/api/note', {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({selector: _activeSelector, content: raw}),
            });
            const wd = await wr.json();
            if (wd.success) {
                _noteCache.delete(_activeSelector);
                // Sync domain journals — one call per unique token (note may have multiple blocks)
                const tokenHosts = [...document.querySelectorAll('.nb-csv-block[data-csv-token]')];
                const uniqueTokens = [...new Set(tokenHosts.map(h => h.dataset.csvToken))];
                await Promise.all(uniqueTokens.map(token =>
                    fetch('/api/t/journal/from-csv', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ selector: _activeSelector, token }),
                    }).catch(() => {})
                ));
                // Clear journals for any csv token removed from the note body
                const presentTokens  = new Set(tokenHosts.map(h => h.dataset.csvToken));
                const expectedTokens = [].concat(d.meta?.csv || []);
                await Promise.all(expectedTokens
                    .filter(t => !presentTokens.has(t))
                    .map(t => fetch('/api/t/journal/from-csv', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ selector: _activeSelector, token: t, clear: true }),
                    }).catch(() => {}))
                );
                if (triggerBtn) {
                    triggerBtn.textContent = _t('status_saved');
                    setTimeout(() => { triggerBtn.textContent = origText; }, 1200);
                }
            } else {
                alert('Save failed: ' + (wd.stderr || 'unknown'));
            }
        } catch(e) {
            alert('Save error: ' + e);
        } finally {
            if (triggerBtn?.textContent === _t('status_saving')) triggerBtn.textContent = origText;
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
        btn.textContent = _t('status_saving');
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
                _noteCache.delete(_activeSelector);
                btn.textContent = _t('status_saved');
                setTimeout(() => { btn.textContent = _t('btn_save'); }, 1200);
            } else {
                alert('Save failed: ' + (d.stderr || 'unknown error'));
                btn.textContent = _t('btn_save');
            }
        } catch(e) {
            btn.textContent = _t('btn_save');
            throw e;
        }
    }

    // Resolve a wikilink selector to a full nb selector.
    // Plain titles (no ":" and not a bare integer) are matched by title
    // within the current notebook, enabling [[Shop]] to work like Quartz wikilinks.
    async function _resolveWikilinkSelector(sel) {
        if (!sel) return sel
        if (sel.includes(':') || /^\d+$/.test(sel)) return sel
        const cached = _wikilinkCache.get('\x00' + sel)
        if (cached) return cached
        try {
            // Use the notebook of the note currently displayed, not the list panel's notebook.
            // When a note from hledger: is open but the list shows docs:, bare [[links]] must
            // still resolve within hledger — NbNav.notebook would give the wrong scope.
            const activeSel = NbMain.activeSelector() || ''
            const activeNb  = activeSel.includes(':') ? activeSel.split(':')[0] : null
            const nb = activeNb || (NbNav.notebook === '_all' ? 'home' : NbNav.notebook)
            const r  = await fetch(`/api/notes?notebook=${encodeURIComponent(nb)}&q=${encodeURIComponent(sel)}`)
            const d  = await r.json()
            const lower = sel.toLowerCase()
            const match = (d.notes || []).find(n =>
                (n.title || '').toLowerCase() === lower ||
                (n.filename || '').replace(/\.[^.]+$/, '').toLowerCase() === lower
            )
            if (match) { _wikilinkCache.set('\x00' + sel, match.selector); return match.selector }
        } catch(e) { /* fall through */ }
        return sel
    }

    async function _resolveWikilinks(container) {
        const spans = [...container.querySelectorAll('.nb-wiki-link[data-autolabel]')];
        if (!spans.length) return;
        // Only count spans whose label needs a network fetch — cached hits are instant
        const uncached = spans.filter(s => {
            const raw = s.dataset.selector;
            if (!raw) return false;
            // selector is cached if either the raw key or a resolved selector key exists
            return !_wikilinkCache.has(raw) && !_wikilinkCache.has('\x00' + raw);
        });
        if (uncached.length) _StatusPill.add(uncached.length);
        await Promise.all(spans.map(async span => {
            const raw = span.dataset.selector;
            if (!raw) return;
            const needsTick = uncached.includes(span);
            try {
                // Resolve plain titles to full selectors first
                const sel = await _resolveWikilinkSelector(raw)
                let title;
                if (_wikilinkCache.has(sel)) {
                    title = _wikilinkCache.get(sel);
                } else {
                    const r = await fetch('/api/note?selector=' + encodeURIComponent(sel));
                    if (!r.ok) return;
                    const d = await r.json();
                    title = d.meta?.alias || d.title || d.filename || sel;
                    _wikilinkCache.set(sel, title);
                }
                if (title && title !== raw) span.textContent = title;
            } catch(e) { /* leave as-is */ }
            finally { if (needsTick) _StatusPill.tick(); }
        }));
    }

    // ── Cross-reference enrichment ────────────────────────────────────────────
    // Triggered by frontmatter `xref: <notebook>`. Searches heading words against
    // note titles (+ annotation free text) in the target notebook and injects
    // small [N] reference indicators after matching words.
    // Suppress specific words with `xref-ignore: [word, word]` in frontmatter.

    const _XREF_STOP = new Set([
        'a','an','the','and','or','but','in','on','at','to','for','of',
        'with','by','from','as','is','was','are','were','be','been','being',
        'have','has','had','do','does','did','will','would','could','should',
        'may','might','shall','can','into','through','during','before',
        'after','above','below','between','each','all','both','few','more',
        'most','other','some','such','no','not','only','same','so','than',
        'too','very','just','also','that','this','these','those','its','it',
        'we','you','he','she','they','them','their','our','your','his','her',
        'what','which','who','when','where','why','how','if','then',
        'use','using','used','file','files','note','notes','see','about',
    ]);

    function _stemXref(word) {
        let w = word.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (w.length < 4) return w;
        const rules = [
            ['ations',''],['ation',''],['ings',''], ['ing',''],
            ['ions',''], ['ion',''], ['ments',''],['ment',''],
            ['ness',''], ['ities',''],['ity',''], ['ies','y'],
            ['ves','f'], ['ed',''],  ['ly',''],  ['er',''],
            ['es',''],   ['s',''],
        ];
        for (const [suf, rep] of rules) {
            if (w.endsWith(suf) && w.length - suf.length >= 3)
                return w.slice(0, w.length - suf.length) + rep;
        }
        return w;
    }

    function _xrefUrlLabel(url) {
        try {
            const u    = new URL(url);
            const host = u.hostname.replace(/^www\./, '');
            if (host === 'en.wikipedia.org' || host === 'wikipedia.org') {
                const slug = u.pathname.split('/').pop() || '';
                return 'Wikipedia: ' + decodeURIComponent(slug).replace(/_/g, ' ');
            }
            if (host === 'github.com') {
                const parts = u.pathname.split('/').filter(Boolean);
                return parts.length >= 2 ? `GitHub: ${parts[0]}/${parts[1]}` : 'GitHub';
            }
            if (host === 'youtube.com' || host === 'youtu.be') return 'YouTube';
            if (host === 'vimeo.com') return 'Vimeo';
            return host;
        } catch { return url; }
    }

    async function _enrichXref(container, note) {
        // xref: accepts a string, URL, or list — three resolver types:
        //   "hledger:" / "accts:tutorial/"  → notebook/folder: heading words vs note titles
        //   "Takeout:docs/ref.md"            → file: heading words vs headings in that file
        //   "https://..."                    → URL: appended as "See also" footer link
        const xrefRaw = note.effective_xref ?? note.meta?.xref;
        const targets = (Array.isArray(xrefRaw) ? xrefRaw : [xrefRaw])
            .map(t => {
                // YAML parses 'hledger:' inside a flow list as {hledger: null} — unwrap it
                if (t && typeof t === 'object' && !Array.isArray(t)) {
                    const k = Object.keys(t);
                    if (k.length === 1 && t[k[0]] == null) return `${k[0]}:`;
                }
                return String(t || '').trim();
            })
            .filter(Boolean);
        if (!targets.length) return;

        const isUrl  = t => /^https?:\/\//.test(t);
        const isFile = t => !isUrl(t) && t.endsWith('.md');

        const urlTargets = targets.filter(isUrl);
        const filTargets = targets.filter(isFile);
        const nbTargets  = targets.filter(t => !isUrl(t) && !isFile(t));

        const rendered = container.querySelector('.nb-rendered') ?? container;

        // ── URL targets: "See also" footer — links rendered immediately,
        //    Wikipedia summaries fetched in parallel and injected in place ──
        if (urlTargets.length) {
            const foot = document.createElement('div');
            foot.className = 'nb-xref-urls';
            for (const url of urlTargets) {
                const row = document.createElement('div');
                row.className = 'nb-xref-url-row';

                const a = document.createElement('a');
                a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
                a.textContent = _xrefUrlLabel(url);
                row.appendChild(a);

                // Wikipedia: fetch summary and inject extract below the link
                try {
                    const u = new URL(url);
                    if (u.hostname === 'en.wikipedia.org' || u.hostname === 'wikipedia.org') {
                        const slug = u.pathname.split('/').pop();
                        if (slug) {
                            const extract = document.createElement('div');
                            extract.className = 'nb-xref-url-extract';
                            row.appendChild(extract);
                            fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`)
                                .then(r => r.ok ? r.json() : null)
                                .then(d => { if (d?.extract) extract.textContent = d.extract; else extract.remove(); })
                                .catch(() => extract.remove());
                        }
                    }
                } catch { /* non-URL or parse error — link only */ }

                foot.appendChild(row);
            }
            rendered.appendChild(foot);
        }

        if (!filTargets.length && !nbTargets.length) return;

        const ignoreRaw = note.meta?.['xref-ignore'];
        const ignoreSet = new Set(
            (Array.isArray(ignoreRaw) ? ignoreRaw
                : String(ignoreRaw || '').split(/[\s,]+/))
                .map(w => w.toLowerCase().trim()).filter(Boolean)
        );

        // Inline includes (book chapters, {{inline:}}) load asynchronously.
        // Wait for eager inlines (nb-inlines-settled), then force any deferred ones and
        // wait for all of them (nb-inlines-complete) so every chapter's headings are in the DOM.
        if (rendered.querySelector('.nb-inline-query[data-provider="inline"]')) {
            await new Promise(resolve =>
                container.addEventListener('nb-inlines-settled', resolve, { once: true }));
            if (rendered.querySelector('.nb-inline-query[data-provider="inline"]')) {
                // Deferred inlines remain — force them all, then wait for complete
                _StatusPill.forceAll();
                await new Promise(resolve =>
                    container.addEventListener('nb-inlines-complete', resolve, { once: true }));
            }
        }

        const headings = [...rendered.querySelectorAll('h1,h2,h3,h4,h5,h6,[data-xref-heading]')];
        if (!headings.length) return;

        // Build word → stem map from all heading text (skip stop/ignore/short words)
        const wordToStem = new Map();
        for (const h of headings) {
            for (const raw of h.textContent.match(/[a-zA-Z][a-zA-Z0-9-]*/g) ?? []) {
                const clean = raw.toLowerCase();
                if (clean.length < 3 || _XREF_STOP.has(clean) || ignoreSet.has(clean)) continue;
                const stem = _stemXref(clean);
                if (stem && stem.length >= 3) wordToStem.set(clean, stem);
            }
        }
        if (!wordToStem.size) return;

        const stems    = [...new Set(wordToStem.values())];
        const stemsEnc = encodeURIComponent(stems.join(','));

        // Parallel-fetch all targets (notebook + file), merge into one matchMap keyed by stem
        const matchMap = {};
        const _mergeRefs = (d, keyFn = r => r.selector) => {
            if (d.error) return;
            for (const [stem, refs] of Object.entries(d)) {
                if (!matchMap[stem]) matchMap[stem] = [];
                for (const ref of refs) {
                    if (!matchMap[stem].some(x => keyFn(x) === keyFn(ref)))
                        matchMap[stem].push(ref);
                }
            }
        };
        await Promise.all([
            ...nbTargets.map(async target => {
                try {
                    const r = await fetch(`/api/xref?target=${encodeURIComponent(target)}&stems=${stemsEnc}`);
                    if (r.ok) _mergeRefs(await r.json());
                } catch { /* skip failed target */ }
            }),
            ...filTargets.map(async target => {
                try {
                    const r = await fetch(`/api/xref/headings?selector=${encodeURIComponent(target)}&stems=${stemsEnc}`);
                    // file refs are deduped by selector+title since same file can match multiple headings
                    if (r.ok) _mergeRefs(await r.json(), ref => `${ref.selector}\x00${ref.title}`);
                } catch { /* skip failed target */ }
            }),
        ]);
        if (!Object.keys(matchMap).length) return;

        // Assign sequential reference numbers per unique (selector, title) pair
        const refNums = new Map();
        let refN = 0;
        const getRef = key => { if (!refNums.has(key)) refNums.set(key, ++refN); return refNums.get(key); };

        for (const h of headings) {
            const walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
            const textNodes = [];
            let tn;
            while ((tn = walker.nextNode())) {
                if (!tn.parentElement?.closest('code,script')) textNodes.push(tn);
            }
            for (const textNode of textNodes) {
                const text = textNode.textContent;
                const frag = document.createDocumentFragment();
                let lastIdx = 0, hasRef = false;
                for (const m of text.matchAll(/[a-zA-Z][a-zA-Z0-9-]*/g)) {
                    const stem = wordToStem.get(m[0].toLowerCase());
                    const refs = stem ? matchMap[stem] : null;
                    if (m.index > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
                    frag.appendChild(document.createTextNode(m[0]));
                    if (refs?.length) {
                        for (const ref of refs) {
                            const key = `${ref.selector}\x00${ref.title || ''}`;
                            const sup = document.createElement('sup');
                            sup.className       = 'nb-xref-ref';
                            sup.title           = ref.title;
                            sup.textContent     = `[${getRef(key)}]`;
                            sup.dataset.xrefSel = ref.selector;
                            sup.addEventListener('click', e => { e.stopPropagation(); NbMain.openNote(ref.selector); });
                            frag.appendChild(sup);
                            hasRef = true;
                        }
                    }
                    lastIdx = m.index + m[0].length;
                }
                if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
                if (hasRef) textNode.replaceWith(frag);
            }
        }
    }

    // ── codeblock renderer dispatch — delegates to NbWeb plugin system ────────
    if (typeof marked !== 'undefined') {
        marked.use({ renderer: {
            code({ text, lang }) {
                const r = NbWeb.getCodeblockRenderer(lang);
                if (r?.html) return r.html(text);
                return false;
            }
        }});
    }

    // marked.parse with the global code-renderer bypassed — produces plain
    // <pre><code> for every fenced block. Use wherever live hydration must NOT
    // happen: template previews, version-diff views, help panels.
    function _parseMarkdownStatic(body) {
        const r = new marked.Renderer();
        r.code = ({ text, lang }) => {
            const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            const src = (lang ? `\`\`\`${lang}\n${text}\n\`\`\`` : `\`\`\`\n${text}\n\`\`\``);
            return `<pre><code>${esc(src)}</code></pre>\n`;
        };
        return marked.parse(body, { renderer: r });
    }

    // ── codeblock infra + renderers → plugins/nbweb-codeblocks.js ────────────
    function _renderMarkdown(body, noteSelector = null) {
        if (typeof marked === 'undefined') return `<pre>${_esc(body)}</pre>`;
        // Pre-process wiki-links and hashtags before marked.
        // Split on fenced code blocks and inline code first so [[links]] and
        // #tags inside backticks are never converted.
        const _processInline = chunk =>
            chunk
                .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => {
                    const hashIdx  = target.indexOf('#')
                    const page     = hashIdx >= 0 ? target.slice(0, hashIdx) : target
                    const frag     = hashIdx >= 0 ? target.slice(hashIdx + 1) : ''
                    const fragAttr = frag ? ` data-fragment="${_esc(frag)}"` : ''
                    return `<span class="nb-wiki-link" data-selector="${_esc(page)}"${fragAttr}${label ? '' : ' data-autolabel="1"'}>${_esc(label || target)}</span>`
                })
                .replace(/(^|\s)(#[\w/-]+)/g, (_, pre, tag) =>
                    `${pre}<span class="nb-tag-link">${_esc(tag)}</span>`);
        // Pre-process csv template blocks (```csv token) into placeholder divs before
        // marked sees them — marked drops all but the first word of the info string.
        body = body.replace(/```csv ([\w-]+)\n([\s\S]*?)```/g, (_, token, content) =>
            `<div class="nb-csv-tmpl-pending" data-token="${token}" data-content="${encodeURIComponent(content.trimEnd())}"></div>`
        );

        const _codeParts = body.split(/(````[\s\S]*?````|```[\s\S]*?```|`[^`\n]+`)/g);
        let processed = _codeParts.map((part, i) => i % 2 === 0 ? _processInline(part) : part).join('');
        let html = marked.parse(processed);
        if (noteSelector) {
            // Rewrite relative img srcs to /api/file?selector=... so images resolve
            const ci     = noteSelector.indexOf(':');
            const nb     = ci >= 0 ? noteSelector.slice(0, ci) : '';
            const rest   = ci >= 0 ? noteSelector.slice(ci + 1) : noteSelector;
            const folder = rest.includes('/') ? rest.slice(0, rest.lastIndexOf('/') + 1) : '';
            html = html.replace(/(<img\b[^>]*?\bsrc=")([^"]+)(")/g, (_, pre, src, post) => {
                if (/^(https?:|data:|\/api\/|\/\/)/.test(src)) return _;
                let imgSel;
                if (/^[\w.-]+:/.test(src)) {
                    imgSel = src;
                } else {
                    // Normalise path: resolve any ../ so nb show gets a clean selector
                    const parts = (folder + src).split('/');
                    const resolved = [];
                    for (const p of parts) {
                        if (p === '..') resolved.pop();
                        else if (p && p !== '.') resolved.push(p);
                    }
                    imgSel = `${nb}:${resolved.join('/')}`;
                }
                return `${pre}/api/file?selector=${encodeURIComponent(imgSel)}${post}`;
            });
        }
        return html;
    }

    // Fallback frontmatter display — shown above body for any note with meta fields
    // that aren't handled by a plugin previewRenderer or specialised renderer.
    // Skips `title` and `tags` which are already shown in the toolbar.
    const _FM_SKIP    = new Set(['title', 'tags']);
    const _FM_EMPTY_KEY = 'nb-fm-show-empty';

    function _renderFmFallback(meta) {
        if (!meta || typeof meta !== 'object') return '';
        const rows = Object.entries(meta)
            .filter(([k]) => !_FM_SKIP.has(k))
            .map(([k, v]) => {
                const empty = v === null || v === undefined || v === '';
                let display;
                if (empty) {
                    display = '<em class="nb-fm-dash">—</em>';
                } else if (typeof v === 'object') {
                    display = _esc(JSON.stringify(v));
                } else {
                    const s = String(v);
                    display = s.includes('\n')
                        ? `<pre style="margin:0;white-space:pre-wrap;font-size:0.9em">${_esc(s.trim())}</pre>`
                        : _esc(s);
                }
                return `<div class="nb-contact-row${empty ? ' nb-fm-empty-row' : ''}">` +
                    `<span class="nb-contact-label">${_esc(k)}</span>` +
                    `<span class="nb-contact-value">${display}</span>` +
                    `</div>`;
            });
        if (!rows.length) return '';
        const showEmpty = localStorage.getItem(_FM_EMPTY_KEY) === '1';
        return `<div class="nb-contact-fields nb-fm-fallback${showEmpty ? ' nb-fm-show-empty' : ''}" data-fm-fallback>` +
            rows.join('') +
            `<button class="nb-fm-empty-toggle nb-tw-btn" title="Toggle empty fields">` +
            `${showEmpty ? 'Hide empty' : 'Show empty'}</button>` +
            `</div>`;
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
    // _showDropdown/_bindListMenu/_bindSortBtn moved to ui-chrome.js (tier 4,
    // 2026-07-08). _applyNbSort/_applySort stay here -- they're thin kernel-state
    // mutators (write _nbSortMode/_sortMode, call kernel-only renderList/
    // _getSortedNotes/_updateSortBtn/NbNotebooksPage.renderNbList) that the
    // satellite reaches via NbMain.applyNbSort()/applySort() rather than owning.

    function _applyNbSort(mode) {
        _nbSortMode = mode;
        const btn = document.getElementById('nb-sort-btn');
        if (btn) btn.classList.toggle('nb-sort-active', mode !== 'active-first');
        // Call-time reference into notebooks-page.js -- deferred (inside a function
        // body, not a return-object literal), so NOT order-sensitive regardless of
        // index.html script position, unlike the bare NbX.method entries below.
        // Zero-arg: the satellite re-renders from its own privatized list state --
        // the kernel has no independent use for the notebooks array itself, only
        // for _nbSortMode (read by _bindSortBtn's dropdown-active checkmarks below).
        NbNotebooksPage.renderNbList();
    }

    function _applySort(mode) {
        _sortMode = mode;
        renderList(_getSortedNotes(_lastNotes), true);
        _updateSortBtn();
    }

    // ── Extras toggle / preview menu / multi-select ──────────────────
    // All moved to ui-chrome.js (tier 4, 2026-07-08) except clearNote, which
    // stays -- only touches _activeSelector, already Tier-A public.

    function clearNote(msg) {
        _activeSelector = null;
        document.getElementById('nb-preview-toolbar').hidden = true;
        document.getElementById('nb-preview-content').innerHTML =
            `<div id="nb-welcome"><h2>nb-web</h2><p>${msg || ''}</p></div>`;
    }

    // ── Inline editor ──────────────────────────────────────────────

    function _updateNavBtns() {
        const back = document.getElementById('nb-back-btn');
        const fwd  = document.getElementById('nb-forward-btn');
        if (back) back.hidden = _history.length === 0;
        if (fwd)  fwd.hidden  = _future.length === 0;
    }

    function _currentHistoryEntry() {
        if (_activeSelector) return { sel: _activeSelector, scrollTop: document.getElementById('nb-preview-content')?.scrollTop || 0 };
        if (NbNav.activeCmd) return { cmd: NbNav.activeCmd };
        return null;
    }

    function _restoreEntry(entry) {
        if (!entry) return;
        if (entry.cmd) { NbNav.activateCmd(entry.cmd); return; }
        const sel = typeof entry === 'object' ? entry.sel : entry;
        const top = typeof entry === 'object' ? entry.scrollTop : 0;
        openNote(sel, false, top ? { restoreScrollTop: top } : {});
    }

    function _goBack() {
        if (!_history.length) return;
        const cur = _currentHistoryEntry();
        if (cur) _future.push(cur);
        _restoreEntry(_history.pop());
    }

    function _goForward() {
        if (!_future.length) return;
        const cur = _currentHistoryEntry();
        if (cur) _history.push(cur);
        _restoreEntry(_future.pop());
    }

    function _bindPreviewActions() {
        document.getElementById('nb-back-btn').addEventListener('click', _goBack);
        document.getElementById('nb-forward-btn').addEventListener('click', _goForward);
        document.getElementById('nb-done-btn').addEventListener('click', _markTodoDone);
        document.getElementById('nb-edit-btn').addEventListener('click', () => _openEditor());
        // nb-save-btn onclick is set contextually: _saveNote in _openEditor, _saveSheet in sheet onload
        document.getElementById('nb-cancel-btn').addEventListener('click', _closeEditor);
        document.getElementById('nb-delete-btn').addEventListener('click', _deleteNote);
        document.getElementById('nb-pin-indicator')?.addEventListener('click', NbUiChrome.togglePin);

        // Click title to copy notebook:id selector to clipboard
        const titleEl = document.getElementById('nb-preview-title');
        if (titleEl) {
            titleEl.style.cursor = 'pointer';
            titleEl.title = _t('tip_copy_selector');
            titleEl.addEventListener('click', () => {
                const link = _activeNoteRef || _activeSelector;
                if (!link) return;
                navigator.clipboard.writeText(link).then(() => {
                    const orig = titleEl.textContent;
                    titleEl.textContent = `✓ ${link}`;
                    setTimeout(() => { titleEl.textContent = orig; }, 1500);
                });
            });
        }

        // Markdown reference modal
        const _mkdModal = document.getElementById('nb-mkd-modal');
        function _toggleMkdModal() { _mkdModal.hidden = !_mkdModal.hidden; }
        document.getElementById('nb-mkd-ref-btn').addEventListener('click', _toggleMkdModal);
        document.getElementById('nb-mkd-modal-close').addEventListener('click', () => { _mkdModal.hidden = true; });
        document.querySelectorAll('.nb-mkd-ref-trigger').forEach(b => b.addEventListener('click', _toggleMkdModal));
        _mkdModal.addEventListener('click', e => { if (e.target === _mkdModal) _mkdModal.hidden = true; });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && !_mkdModal.hidden) _mkdModal.hidden = true; });

        // Line number toggle
        const _lnBtn    = document.getElementById('nb-ln-btn');
        const _lnGutter = document.getElementById('nb-ln-gutter');
        const _ta       = document.getElementById('nb-editor');
        let _lnActive   = false;

        function _syncLineNumbers() {
            const count = _ta.value.split('\n').length;
            _lnGutter.textContent = Array.from({length: count}, (_, i) => i + 1).join('\n');
            _lnGutter.scrollTop = _ta.scrollTop;
        }
        _ta.addEventListener('input',  () => { if (_lnActive) _syncLineNumbers(); });
        _ta.addEventListener('scroll', () => { if (_lnActive) _lnGutter.scrollTop = _ta.scrollTop; });

        _lnBtn.addEventListener('click', () => {
            _lnActive = !_lnActive;
            _lnGutter.hidden = !_lnActive;
            _lnBtn.classList.toggle('nb-active', _lnActive);
            if (_lnActive) _syncLineNumbers();
        });
    }

    // Single source of truth for preview-pane button visibility.
    // Prevents the double-row situation where preview-actions and editor-toolbar
    // are simultaneously visible, or the done-bar stacks on top of them.
    function _setPaneMode(mode) {
        document.getElementById('nb-done-bar')?.remove();
        document.getElementById('nb-tmpl-save-bar')?.remove();
        // Always close annotation editor when switching modes or loading a new note
        const annWrap = document.getElementById('nb-ann-editor-wrap');
        if (!annWrap.hidden) {
            annWrap.hidden = true;
            document.getElementById('nb-preview-pane').classList.remove('nb-ann-editing');
            document.getElementById('nb-preview-content').style.flexBasis = '';
            document.getElementById('nb-ann-save-btn').textContent = 'Save';
        }
        const previewActions = document.getElementById('nb-preview-actions');
        const editorWrap     = document.getElementById('nb-editor-wrap');
        const previewContent = document.getElementById('nb-preview-content');
        if (mode === 'edit') {
            previewActions.hidden = true;
            editorWrap.hidden     = false;
            previewContent.hidden = true;
            document.getElementById('nb-fm-blocks').hidden = true;
            document.getElementById('nb-tabs-bar').hidden  = true;
        } else {
            previewActions.hidden = false;
            editorWrap.hidden     = true;
            previewContent.hidden = false;
            if (_activeNote) { _buildFmBlocks(_activeNote); _buildTabs(_activeNote); }
        }
    }

    function _populateEditor(sel, raw, saveFn, note = null) {
        _undoBuffer[sel] = raw;
        const ta = document.getElementById('nb-editor');
        ta.value = raw;
        document.getElementById('nb-save-btn').onclick = saveFn;

        // Install plugin keybindings for this note; remove any previous handler
        if (ta._pluginKeyHandler) ta.removeEventListener('keydown', ta._pluginKeyHandler);
        ta._pluginKeyHandler = null;
        const _bindings = NbWeb.getEditorKeybindings(note);
        if (_bindings.length) {
            ta._pluginKeyHandler = e => {
                for (const b of _bindings) {
                    if (e.key === b.key &&
                        !!b.ctrl  === e.ctrlKey &&
                        !!b.shift === e.shiftKey &&
                        !!b.alt   === e.altKey) {
                        e.preventDefault();
                        b.action(ta, note);
                        return;
                    }
                }
            };
            ta.addEventListener('keydown', ta._pluginKeyHandler);
        }

        ta.focus();
    }

    function _foldableImpliesDates(foldable) {
        if (!foldable) return false;
        const patterns = Array.isArray(foldable) ? foldable : [foldable];
        const probe = '## 2026-01-01';
        return patterns.some(p => { try { return new RegExp(p, 'i').test(probe); } catch(_) { return false; } });
    }

    async function _ensureTodayHeading(sel, d) {
        const today = new Date().toISOString().slice(0, 10);
        const body  = d.raw || d.body || '';
        if (body.includes(`## ${today}`)) return;
        const updated = body.trimEnd() + `\n\n## ${today}\n`;
        const r  = await fetch('/api/note', {
            method: 'PUT', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ selector: sel, content: updated }),
        });
        const wd = await r.json();
        if (wd.success) { d.raw = updated; d.body = updated; _noteCache.delete(sel); }
    }

    function _openEditor(targetSelector) {
        const sel = targetSelector || _activeSelector;
        if (!sel) return;
        _activeSelector = sel;

        if (_activeType === 'encrypted') {
            if (!_encPassword) {
                _encPendingEdit = true;
                openNote(sel, false);   // re-opens lock prompt; after unlock editor auto-opens
                return;
            }
            _editing = true;
            _setPaneMode('edit');
            fetch('/api/note/decrypt', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({selector: sel, password: _encPassword})
            })
            .then(r => { if (r.status === 401) throw Object.assign(new Error('Wrong password'), {status: 401}); return r.json(); })
            .then(d => _populateEditor(sel, d.content, _saveEncryptedNote))
            .catch(err => {
                _closeEditor();
                if (err.status === 401) { _encPassword = null; _encPendingEdit = true; openNote(sel, false); }
                else alert('Decrypt error: ' + err.message);
            });
            return;
        }

        _editing = true;
        _setPaneMode('edit');
        const _saveBtn = document.getElementById('nb-save-btn');
        if (_saveBtn) _saveBtn.disabled = true;
        fetch('/api/note?selector=' + encodeURIComponent(sel))
            .then(r => r.json())
            .then(async d => {
                if (_saveBtn) _saveBtn.disabled = false;
                if (d.meta?.date_headers || _foldableImpliesDates(d.meta?.foldable)) await _ensureTodayHeading(sel, d);
                _populateEditor(sel, d.raw || d.body || '', _saveNote, d);
            })
            .catch(() => { if (_saveBtn) _saveBtn.disabled = false; });
    }

    async function _saveEncryptedNote() {
        if (!_activeSelector || !_encPassword) return;
        const content = document.getElementById('nb-editor').value;
        const btn = document.getElementById('nb-save-btn');
        btn.textContent = _t('status_saving');
        try {
            const r = await fetch('/api/note/encrypted', {
                method: 'PUT',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({selector: _activeSelector, content, password: _encPassword})
            });
            const d = await r.json();
            if (d.success) {
                _noteCache.delete(_activeSelector);
                const savedSel = _activeSelector;
                _closeEditor();
                _noAutoSelect = true;
                NbNav.reexecute();
                NbNav.pollSyncStatus();
                openNote(savedSel).finally(() => { _noAutoSelect = false; });
            } else {
                alert('Save failed: ' + (d.error || 'unknown error'));
            }
        } finally {
            btn.textContent = _t('btn_save');
        }
    }

    async function _saveNote() {
        if (!_activeSelector) return;
        const content = document.getElementById('nb-editor').value;
        const btn = document.getElementById('nb-save-btn');
        btn.textContent = _t('status_saving');
        try {
            const r = await fetch('/api/note', {
                method: 'PUT',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({selector: _activeSelector, content}),
            });
            const d = await r.json();
            if (d.success) {
                _noteCache.delete(_activeSelector);
                const savedSel = _activeSelector;
                delete _toolbarCache[NbNav.notebook];  // bust so toolbar: changes show immediately
                // Config dotfiles (.{name}.md) affect notebook config — bust so changes take effect immediately.
                const _savedFile = _activeSelector.split(':').pop().split('/').pop();
                if (_savedFile.startsWith('.')) NbWeb.bustNotebookConfigCache(NbNav.notebook);
                _closeEditor();
                _noAutoSelect = true;
                NbNav.reexecute();
                NbNav.pollSyncStatus();
                openNote(savedSel).finally(() => { _noAutoSelect = false; });
            }
            else alert('Save failed: ' + (d.stderr || 'unknown error'));
        } finally {
            btn.textContent = _t('btn_save');
        }
    }

    function _closeEditor() {
        _editing = false;
        _setPaneMode('preview');
        document.getElementById('nb-editor').value = '';  // never let stale content survive into next edit session
    }

    function _applyFmt(fmt, ta) {
        ta = ta || document.getElementById('nb-editor');
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
            NbNav.pollSyncStatus();
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
        lbl.textContent = _t('label_fixed_in');

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
        doneBtn.textContent = _t('btn_done');

        const editBtn = document.createElement('button');
        editBtn.className   = 'nb-tool-btn';
        editBtn.textContent = _t('btn_edit');

        const skipBtn = document.createElement('button');
        skipBtn.className   = 'nb-tool-btn';
        skipBtn.textContent = _t('btn_skip');

        bar.append(lbl, sel, doneBtn, editBtn, skipBtn);
        document.getElementById('nb-preview-actions').hidden = true;
        toolbar.parentNode.insertBefore(bar, toolbar.nextSibling);
        sel.focus();

        const run = async (nugget) => {
            doneBtn.disabled = editBtn.disabled = skipBtn.disabled = true;
            doneBtn.textContent = _t('btn_marking');
            try { await doClose(nugget, note); }
            finally { doneBtn.textContent = _t('btn_done'); doneBtn.disabled = editBtn.disabled = skipBtn.disabled = false; }
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

    // ── Shared preview-pane display utilities ───────────────────────
    // Used by runGrep/the import flow below (still in this file) and by
    // NbSync (sync.js, tier-2d) via the NbMain.showCmdOutput/showPreviewLoading
    // exposures on the return object -- kept in the kernel rather than moved,
    // since ownership genuinely spans multiple satellites, not just Sync.

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
            inner.innerHTML = _renderMarkdown(d.body, selector);
            container.appendChild(inner);

            _renderCsvBlocks(container);
            await NbWeb.renderCodeblocks(container);

            const clone = container.cloneNode(true);
            document.body.removeChild(container);
            clone.querySelectorAll('button, form, .nb-spin').forEach(el => el.remove());

            return { title: d.title || d.filename || selector, html: clone.innerHTML };
        } catch { return null; }
    }

    // ── Account page ────────────────────────────────────────────────

    const _LEVEL_DESC = {
        guest:  'Read-only access to public notes.',
        user:   'Create and edit notes in assigned notebooks.',
        office: 'Extended access: accounting features and reports.',
        admin:  'Full admin: manage notebooks, users, and settings.',
        tech:   'Unrestricted system access.',
    };

    async function runAccount() {
        const content = document.getElementById('nb-preview-content');
        document.getElementById('nb-preview-toolbar').hidden = true;
        document.getElementById('nb-list-empty').hidden = true;
        document.getElementById('nb-count').textContent = '';
        content.innerHTML = '<div style="padding:40px;color:var(--text-muted)">Loading…</div>';

        try {
            const [meRes, exRes] = await Promise.all([
                fetch('/api/me'),
                fetch('/api/me/exclusive'),
            ]);
            const me = await meRes.json();
            const ex = exRes.ok ? (await exRes.json()).notes || [] : [];

            const levelDesc = _LEVEL_DESC[me.level] || me.level;
            const nbs = (me.notebooks || []);

            const contactLink = me.contact_selector
                ? ` <a href="#" class="nb-acct-contact" data-sel="${_esc(me.contact_selector)}" style="font-size:11px;color:var(--text-dim)">→ contact</a>`
                : '';

            const exRows = ex.length
                ? ex.map(n => `<li><a href="#" class="nb-acct-excl" data-sel="${_esc(n.selector)}">${_esc(n.title)}</a> <span style="color:var(--text-dim);font-size:11px">${_esc(n.notebook)}</span></li>`).join('')
                : '<li style="color:var(--text-dim)">None found.</li>';

            content.innerHTML = `
<div class="nb-account-page" style="padding:28px 32px;max-width:520px">

  <h2 style="margin:0 0 20px;font-size:18px">Account</h2>

  <section class="nb-acct-section" style="margin-bottom:24px">
    <div style="display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:13px;align-items:baseline">
      <span style="color:var(--text-dim)">Name</span>      <span><strong id="nb-acct-name-display">${_esc(me.name || me.username)}</strong>${contactLink}</span>
      <span style="color:var(--text-dim)">Username</span>  <code>${_esc(me.username)}</code>
      <span style="color:var(--text-dim)">Level</span>     <span><code>${_esc(me.level)}</code> <span style="color:var(--text-dim);font-size:11px">— ${_esc(levelDesc)}</span></span>
      <span style="color:var(--text-dim)">Notebooks</span> <span>${nbs.length ? nbs.map(n => `<code style="margin-right:4px">${_esc(n)}</code>`).join('') : '<span style="color:var(--text-dim)">all</span>'}</span>
    </div>
  </section>

  <section class="nb-acct-section" style="margin-bottom:24px">
    <h3 style="font-size:13px;font-weight:600;margin:0 0 10px">Edit name</h3>
    <div style="display:flex;gap:8px;align-items:center">
      <input id="nb-acct-name" type="text" value="${_esc(me.name || me.username)}"
             style="flex:1;padding:5px 8px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input,var(--bg));color:var(--text)">
      <button id="nb-acct-name-save" class="nb-btn" style="font-size:12px">Save</button>
    </div>
    <div id="nb-acct-name-msg" style="font-size:11px;margin-top:4px;min-height:14px"></div>
  </section>

  <section class="nb-acct-section" style="margin-bottom:24px">
    <h3 style="font-size:13px;font-weight:600;margin:0 0 10px">Change password</h3>
    <div style="display:grid;gap:6px">
      <input id="nb-acct-pw-cur"  type="password" placeholder="Current password"
             style="padding:5px 8px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input,var(--bg));color:var(--text)">
      <input id="nb-acct-pw-new"  type="password" placeholder="New password"
             style="padding:5px 8px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input,var(--bg));color:var(--text)">
      <input id="nb-acct-pw-new2" type="password" placeholder="Confirm new password"
             style="padding:5px 8px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input,var(--bg));color:var(--text)">
      <button id="nb-acct-pw-save" class="nb-btn" style="font-size:12px;width:max-content">Change password</button>
    </div>
    <div id="nb-acct-pw-msg" style="font-size:11px;margin-top:4px;min-height:14px"></div>
  </section>

  <section class="nb-acct-section">
    <h3 style="font-size:13px;font-weight:600;margin:0 0 8px">Your exclusive notes <span style="font-weight:normal;color:var(--text-dim);font-size:11px">— access: ${_esc(me.username)}</span></h3>
    <ul style="list-style:none;padding:0;margin:0;font-size:12px;display:grid;gap:4px">${exRows}</ul>
  </section>

</div>`;

            // Name save
            content.querySelector('#nb-acct-name-save').addEventListener('click', async () => {
                const name = content.querySelector('#nb-acct-name').value.trim();
                const msg  = content.querySelector('#nb-acct-name-msg');
                if (!name) { msg.textContent = 'Name cannot be empty.'; msg.style.color = 'var(--error,red)'; return; }
                const r = await fetch('/api/me', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name }),
                });
                const d = await r.json();
                if (d.success) {
                    msg.textContent = 'Saved.';
                    msg.style.color = 'var(--success,green)';
                    content.querySelector('#nb-acct-name-display').textContent = name;
                    NbAuth?.bust?.();
                } else {
                    msg.textContent = d.error || 'Error.';
                    msg.style.color = 'var(--error,red)';
                }
            });

            // Password save
            content.querySelector('#nb-acct-pw-save').addEventListener('click', async () => {
                const cur  = content.querySelector('#nb-acct-pw-cur').value;
                const pw1  = content.querySelector('#nb-acct-pw-new').value;
                const pw2  = content.querySelector('#nb-acct-pw-new2').value;
                const msg  = content.querySelector('#nb-acct-pw-msg');
                if (!cur || !pw1) { msg.textContent = 'Fill in current and new password.'; msg.style.color = 'var(--error,red)'; return; }
                if (pw1 !== pw2)  { msg.textContent = 'New passwords do not match.';       msg.style.color = 'var(--error,red)'; return; }
                const r = await fetch('/api/me', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ current_password: cur, new_password: pw1 }),
                });
                const d = await r.json();
                if (d.success) {
                    msg.textContent = 'Password changed.';
                    msg.style.color = 'var(--success,green)';
                    content.querySelector('#nb-acct-pw-cur').value  = '';
                    content.querySelector('#nb-acct-pw-new').value  = '';
                    content.querySelector('#nb-acct-pw-new2').value = '';
                } else {
                    msg.textContent = d.error || 'Error.';
                    msg.style.color = 'var(--error,red)';
                }
            });

            // Contact card link
            content.querySelectorAll('.nb-acct-contact, .nb-acct-excl').forEach(a => {
                a.addEventListener('click', e => {
                    e.preventDefault();
                    openNote(a.dataset.sel);
                });
            });

        } catch(e) {
            content.innerHTML = `<div style="padding:40px;color:var(--error,red)">Failed to load account: ${_esc(String(e))}</div>`;
        }
    }

    function setFoldersFirst(val) {
        _foldersFirst = val;
        localStorage.setItem('nb-folders-first', val);
        if (_lastNotes?.length) renderList(_getSortedNotes(_lastNotes), true);
    }

    return { init, loadNotes, resetAndLoad, resetSort, search, openNote,
             openToday: NbNoteActions.openToday,
             showAddForm: NbNoteActions.showAddForm,
             addNote: NbNoteActions.addNote,
             addEncryptedNote: NbNoteActions.addEncryptedNote,
             encPassword: () => _encPassword,
             // Kernel-state setters exposed for satellite extractions (design doc §2) —
             // added lazily, one per extraction that provably needs to touch shared
             // state it doesn't own.
             setEncPassword: pw => { _encPassword = pw; },
             clearActiveSelector: () => { _activeSelector = null; },
             setActiveNote: note => { _activeNote = note; },
             setNoAutoSelect: v => { _noAutoSelect = v; },
             clearSearchTimer: () => { clearTimeout(_searchTimer); },
             setSearchTimer: id => { _searchTimer = id; },
             // Notebooks-settings sort mode -- kernel-owned because kernel's own
             // _applyNbSort (still here, called by NbUiChrome's moved dropdown-
             // building code) also writes it, and notebooks-page.js already reads
             // it through this getter from a prior tier. Same shape as getSortMode
             // below for the plain note-list sort.
             getNbSortMode: () => _nbSortMode,
             applyNbSort: _applyNbSort,
             getSortMode: () => _sortMode,
             applySort: _applySort,
             // Tier 4 (UI chrome, 2026-07-08) — kernel-owned state/functions the
             // extracted satellite (ui-chrome.js) needs to reach back for. Sets/objects
             // are exposed as live references (satellite calls .has/.add/.delete
             // directly, same pattern as selectedSelectors below); primitives get
             // paired get/set. _pinnedSelectors/_undoBuffer/_pendingDeletes stay
             // kernel-declared because kernel code elsewhere (openNote, _populateEditor,
             // _deleteNote/loadNotes) reads or writes them too -- only _selectedSelectors/
             // _lastClickedIdx/_isFullscreen were satellite-exclusive and fully
             // privatized into NbUiChrome instead.
             getListDisplayMode: () => _listDisplayMode,
             setListDisplayMode: v => { _listDisplayMode = v; },
             getKbPane: () => _kbPane,
             setKbPane: _setKbPane,
             getLastNotes: () => _lastNotes,
             pinnedSelectors: () => _pinnedSelectors,
             undoBuffer: () => _undoBuffer,
             pendingDeletes: () => _pendingDeletes,
             reRenderList: () => renderList(_getSortedNotes(_lastNotes), true),
             resolveWikilinks: container => _resolveWikilinks(container),
             deleteNote: _deleteNote,
             // List-generation counter -- genuinely cross-cutting (kernel loadNotes/
             // search, and not-yet-extracted runCal/runGrep, all increment/check it
             // too), so it stays a private kernel counter behind two narrow intent-
             // named operations rather than a raw get/set of the value itself.
             bumpListSeq: () => ++_listSeq,
             isStaleListSeq: seq => seq !== _listSeq,
             // Generic preview-pane display / rendering utilities -- exposed here (not
             // moved) because they're genuinely shared across satellites and kernel code
             // alike: showCmdOutput/showPreviewLoading are called by NbSync (sync.js) and
             // by runGrep/the import flow (still in this file, Grep/Util sections);
             // parseMarkdownStatic is called by NbPluginsPage (plugins-page.js), by
             // NbTemplates (templates.js), and by kernel renderPreview.
             showCmdOutput: _showCmdOutput,
             showPreviewLoading: _showPreviewLoading,
             parseMarkdownStatic: _parseMarkdownStatic,
             runCmd: NbSync.runCmd,
             runPlugins: NbPluginsPage.runPlugins,
             runNbNotebooks: NbNotebooksPage.runNbNotebooks,
             runTemplates: NbTemplates.runTemplates,
             loadTemplatesForAdd: NbTemplates.loadTemplatesForAdd,
             runCal, runGrep, runAccount,
             showNbGitLog: NbSync.showNbGitLog, showNbGitWire: NbSync.showNbGitWire,
             doLinkFile, showAbout, openEditor: _openEditor, closeEditor: _closeEditor, saveNote: _saveNote,
             isEditing: () => _editing,
             setFoldersFirst,
             importFiles: (files, nb, folder) => _importFiles(files, nb, folder),
             importPaths: (paths, nb, folder) => _importPaths(paths, nb, folder),
             exportFormats: NbUiChrome.exportFormats,
             doPrint: NbUiChrome.doPrint,
             clearNote,
             activeSelector: () => _activeSelector,
             activeNote:     () => _activeNote,
             activeType:     () => _activeType,
             activeFilename: () => _activeFilename,
             selectedSelectors: () => NbUiChrome.selectedSelectors(),
             clearSelection: NbUiChrome.clearSelection,
             deselect: sel => NbUiChrome.deselect(sel),
             renderNoteHtml: _renderNoteHtml,
             renderMarkdown:  (body, sel)       => _renderMarkdown(body, sel),
             enrichRendered:  (container, note) => _enrichRendered(container, note),
             wireContainer:   (container, note) => _wireContainer(container, note),
             fetchContainer:  (container, note) => _fetchContainer(container, note),
             bustNoteCache:   sel => { if (sel) _noteCache.delete(sel); else _noteCache.clear(); },
             matchTagColor:   _matchTagColor };
})();

document.addEventListener('DOMContentLoaded', async () => {
    await NbWeb.loadLocale();
    NbWeb.applyI18n();
    await NbWeb._loadPlugins();
    await NbWeb._init();
    NbMain.init();
    NbDialog.init();
    NbTheme.init();
    document.getElementById('nb-mode-toggle')
        ?.addEventListener('click', () => NbTheme.toggleMode());
});

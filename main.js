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
    let _todayInfo      = null;
    let _lastNotes      = [];       // original load order, for client-side sort
    let _sortMode       = 'default';
    let _defaultSortMode = 'default'; // effective default for the current notebook (set by resetSort)
    let _nbSortMode     = 'active-first';  // sort for Notebooks settings view
    const _toolbarCache = {};              // { notebook: { ts, notes } }
    const _TOOLBAR_TTL  = 30_000;
    let _lastNbList     = [];              // last fetched notebooks array
    let _lastNbCurrent  = 'home';          // nb's actual current notebook (from ~/.nb/.current)
    let _foldersFirst   = localStorage.getItem('nb-folders-first') !== 'false';
    let _pinnedSelectors = new Set(JSON.parse(localStorage.getItem('nb-pinned') || '[]'));
    let _activeNote      = null;   // full note object for the currently-open note
    let _isFullscreen    = false;
    let _listSeq        = 0;        // incremented on every new list request; stale responses are dropped
    const _history      = [];       // back-stack
    const _future       = [];       // forward-stack (cleared on any new navigation)
    const _wikilinkCache = new Map(); // selector → resolved title
    const _noteCache     = new Map(); // selector → cached note API response (cache: true frontmatter)
    let _noAutoSelect   = false;     // suppresses renderList auto-select during explicit openNote
    let _listDisplayMode = 'title';  // 'title' | 'filename' — resets on every new fetch
    let _kbPane         = 'list';   // 'list' | 'preview'
    const _pendingDeletes = new Set(); // selectors deleted but possibly not yet gone from server
    const _selectedSelectors = new Set(); // multi-select
    let _lastClickedIdx = -1;             // anchor for shift-click range
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
        _bindSearch();
        _bindTags();
        _bindAppend();
        _bindPreviewActions();
        _bindListMenu();
        _bindSortBtn();
        _bindPreviewMenu();
        _bindExtrasToggle();
        _bindFmEmptyToggle();
        _bindKeyboard();
        _bindDropImport();
        initDragHandle();
        initAnnDragHandle();
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
            html = (note.meta ? _renderFmFallback(note.meta) : '') + _pluginHtml;
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
            // Unknown types (plugin types like 'account', 'contact', etc.) render as markdown.
                // Only raw-display if there's genuinely no body to render.
                html = _renderFmFallback(note.meta) + _renderMarkdown(_virtualTestPrefix(note) + (note.body || ''), note.selector);
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
    // Dotfiles are the SOURCE of config — never self-inject.
    function _virtualTestPrefix(note) {
        if (note?.meta?.type === 'dotfile') return '';
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
        return all.map(p => `\`\`\`check\n${p}\n\`\`\``).join('\n') + '\n\n';
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
                        <button class="nb-ann-edit-btn nb-tw-btn">Edit</button>
                        <button class="nb-ann-del-btn nb-tw-btn">Delete</button>
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

            jspreadsheet(host, {
                worksheets: [{
                    data: dataRows.length ? dataRows : [Array(Math.max(headerRow.length, 1)).fill('')],
                    columns: columns.length ? columns : undefined,
                }],
            });
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

        jspreadsheet(host, {
            worksheets: [{
                data: sheetData,
                columns: headerRow.length ? headerRow.map(h => ({ title: h, width: 120 })) : undefined,
            }],
        });

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

            const sheet       = host.jspreadsheet?.[0];
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
                const ws = host?.jspreadsheet?.[0];
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
                const ws = host?.jspreadsheet?.[0];
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
                      const prismLink = document.getElementById('nb-prism-theme');
                      if (prismLink) prismLink.href = goLight ? 'prism-light.min.css' : 'prism-tomorrow.min.css';
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
            if (NbNav.activeCmd === 'nb-notebooks') {
                _showDropdown(btn, [
                    { label: 'Active first', active: _nbSortMode === 'active-first',
                      action: () => _applyNbSort('active-first') },
                    { label: 'A → Z',        active: _nbSortMode === 'az',
                      action: () => _applyNbSort('az') },
                    { label: 'Z → A',        active: _nbSortMode === 'za',
                      action: () => _applyNbSort('za') },
                    'sep',
                    { label: 'Most notes',   active: _nbSortMode === 'most',
                      action: () => _applyNbSort('most') },
                    { label: 'Fewest notes', active: _nbSortMode === 'fewest',
                      action: () => _applyNbSort('fewest') },
                ]);
                return;
            }
            const _pluginSorts = NbWeb.getSortOptions(NbNav.notebook).map(s => ({
                label: s.label, active: _sortMode === s.id, action: () => _applySort(s.id),
            }));
            _showDropdown(btn, [
                { label: 'Default',      active: _sortMode === 'default', action: () => _applySort('default') },
                { label: 'A → Z',        active: _sortMode === 'az',      action: () => _applySort('az') },
                { label: 'Z → A',        active: _sortMode === 'za',      action: () => _applySort('za') },
                'sep',
                { label: 'Newest first', active: _sortMode === 'newest',  action: () => _applySort('newest') },
                { label: 'Oldest first', active: _sortMode === 'oldest',  action: () => _applySort('oldest') },
                ...(_pluginSorts.length ? ['sep', ..._pluginSorts] : []),
            ]);
        });
    }

    function _applyNbSort(mode) {
        _nbSortMode = mode;
        const btn = document.getElementById('nb-sort-btn');
        if (btn) btn.classList.toggle('nb-sort-active', mode !== 'active-first');
        _renderNbList(_lastNbList);
    }

    function _sortNbList(notebooks) {
        const sorted = [...notebooks];
        if (_nbSortMode === 'az')          sorted.sort((a, b) => a.name.localeCompare(b.name));
        else if (_nbSortMode === 'za')     sorted.sort((a, b) => b.name.localeCompare(a.name));
        else if (_nbSortMode === 'most')   sorted.sort((a, b) => b.count - a.count);
        else if (_nbSortMode === 'fewest') sorted.sort((a, b) => a.count - b.count);
        else { // current-first: nb's current notebook on top, rest by mtime desc
            sorted.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
            const idx = sorted.findIndex(n => n.is_current);
            if (idx > 0) { const [nb] = sorted.splice(idx, 1); sorted.unshift(nb); }
        }
        return sorted;
    }

    function _applySort(mode) {
        _sortMode = mode;
        renderList(_getSortedNotes(_lastNotes), true);
        _updateSortBtn();
    }

    function _togglePin() {
        if (!_activeSelector) return;
        if (_pinnedSelectors.has(_activeSelector)) {
            _pinnedSelectors.delete(_activeSelector);
            if (_activeNote?.meta?.pinned) {
                const newRaw = _activeNote.raw.replace(/^pinned:[ \t]*\S.*\n?/m, '');
                fetch('/api/note', { method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({selector: _activeSelector, content: newRaw}) });
                _activeNote = {..._activeNote, meta: {..._activeNote.meta, pinned: undefined}};
            }
        } else {
            _pinnedSelectors.add(_activeSelector);
        }
        localStorage.setItem('nb-pinned', JSON.stringify([..._pinnedSelectors]));
        document.getElementById('nb-pin-indicator').hidden = !_pinnedSelectors.has(_activeSelector);
        renderList(_getSortedNotes(_lastNotes), true);
    }

    function _toggleFullscreen() {
        _isFullscreen = !_isFullscreen;
        document.body.classList.toggle('nb-fullscreen', _isFullscreen);
    }

    // ── Extras toggle (👁) ─────────────────────────────────────────────────────
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
                { label: 'Copy to…',             disabled: !hasNote, action: () => NbDialog.open('copy') },
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
            _noteCache.delete(_activeSelector);
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
            restoreBtn.textContent = _t('btn_restoring'); restoreBtn.disabled = true;
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
                    _noteCache.delete(sel);
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

        const curNb     = _activeSelector.includes(':') ? _activeSelector.split(':')[0] : 'home';
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
                const noteResp = await fetch('/api/note?selector=' + encodeURIComponent(_activeSelector));
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
                    case 'Home':      e.preventDefault(); previewContent.scrollTo(0, 0); break;
                    case 'End':       e.preventDefault(); previewContent.scrollTo(0, previewContent.scrollHeight); break;
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
                    if (_kbPane === 'list' && _activeSelector) { e.preventDefault(); _deleteNote(); }
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
                case 'p': e.preventDefault(); _setKbPane('preview');          break;
                case 'e': if (_activeSelector) { e.preventDefault(); _openEditor(); } break;
                case 'T': e.preventDefault(); NbTerminal.open();               break;
                case ',': e.preventDefault(); NbTerminal.openSettings();       break;
                case '.': e.preventDefault(); document.getElementById('nb-extras-btn')?.click(); break;
            }
        });
    }

    // ── Annotation split drag handle ───────────────────────────────

    function initAnnDragHandle() {
        const handle  = document.getElementById('nb-ann-drag-handle');
        const content = document.getElementById('nb-preview-content');
        const pane    = document.getElementById('nb-preview-pane');
        const KEY     = 'nb-ann-split-h';
        if (!handle || !content) return;

        let dragging = false, startY = 0, startH = 0;

        function applyHeight(px) {
            const min = 80;
            const max = pane.offsetHeight - handle.offsetHeight - 120;
            content.style.flexBasis = Math.max(min, Math.min(px, max)) + 'px';
        }

        function startDrag(cy) {
            dragging = true;
            startY = cy;
            startH = content.offsetHeight;
            handle.classList.add('dragging');
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'row-resize';
        }

        function moveDrag(cy) {
            if (!dragging) return;
            applyHeight(startH + (cy - startY));
        }

        function endDrag() {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            localStorage.setItem(KEY, content.offsetHeight);
        }

        handle.addEventListener('mousedown',  e => { e.preventDefault(); startDrag(e.clientY); });
        document.addEventListener('mousemove', e => moveDrag(e.clientY));
        document.addEventListener('mouseup',   endDrag);
        handle.addEventListener('touchstart',  e => { e.preventDefault(); startDrag(e.touches[0].clientY); }, { passive: false });
        document.addEventListener('touchmove', e => { if (dragging) { e.preventDefault(); moveDrag(e.touches[0].clientY); } }, { passive: false });
        document.addEventListener('touchend',  endDrag);
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

    function _currentHistoryEntry() {
        if (_activeSelector) return { sel: _activeSelector, scrollTop: document.getElementById('nb-preview-content')?.scrollTop || 0 };
        if (_activeCmd)      return { cmd: _activeCmd };
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
        document.getElementById('nb-pin-indicator')?.addEventListener('click', _togglePin);

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

    // ── Today / Journal ────────────────────────────────────────────

    async function openToday() {
        try {
            const r = await fetch('/api/today');
            const d = await r.json();
            _todayInfo = {path: d.path};

            const content = document.getElementById('nb-preview-content');
            const toolbar = document.getElementById('nb-preview-toolbar');
            toolbar.hidden = false;
            document.getElementById('nb-preview-title').textContent = _t('msg_today_journal');
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
            const q   = raw ? raw.split(/[\s,]+/).filter(Boolean).map(tok => {
                if (tok.startsWith('-')) {
                    const rest = tok.slice(1);
                    return '-' + (rest.startsWith('#') ? rest : '#' + rest);
                }
                return tok.startsWith('#') ? tok : '#' + tok;
            }).join(' ') : '';
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
        btn.textContent = _t('btn_creating'); btn.disabled = true;
        try {
            const r = await fetch('/api/notes', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify(body),
            });
            const d = await r.json();
            if (d.success) {
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
                btn.textContent = _t('btn_create'); btn.disabled = false;
            }
        } catch(e) {
            btn.textContent = _t('btn_create'); btn.disabled = false;
        }
    }

    // ── Sync ───────────────────────────────────────────────────────

    async function doSync() {
        // Sync is handled by the nav sync dialog; this is a no-op fallback.
    }

    async function showNbGitWire() {
        _showCmdOutput('wire remotes', 'Working… (pushing each notebook, may take 10–30s)');
        try {
            const r = await fetch('/api/nb/git-wire', { method: 'POST' });
            if (!r.ok) { _showCmdOutput('wire remotes', `Server error: ${r.status}`); return; }
            const d = await r.json();
            if (d.error) { _showCmdOutput('wire remotes', d.error); return; }
            const lines = (d.results || []).map(r => {
                const icon = r.status === 'ok' ? '✓' : r.status === 'skip' ? '·' : '✗';
                return `${icon}  ${r.notebook.padEnd(16)}  ${r.message}`;
            });
            _showCmdOutput('wire remotes', lines.join('\n') || '(no notebooks found)');
        } catch(e) {
            _showCmdOutput('wire remotes', String(e));
        }
    }

    async function showNbGitLog() {
        const nb = (!NbNav.notebook || NbNav.notebook === '_all') ? 'home' : NbNav.notebook;
        _showPreviewLoading();
        try {
            const d = await fetch(`/api/nb/git-log?notebook=${encodeURIComponent(nb)}&n=30`)
                          .then(r => r.json());
            _showCmdOutput(`git log · ${nb}`, d.output || d.error || '(no output)');
        } catch(e) {
            _showCmdOutput('git log', String(e));
        }
    }

    function _bindSync() { /* sync is handled by nav.js dialog */ }

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

    async function addNote({ notebook, folder, type, title, url, template_path, template_content }) {
        try {
            const r = await fetch('/api/notes', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ notebook, folder: folder || '', type, title, url,
                                       tags: [], content: '', comment: '',
                                       template_path:    template_path    || '',
                                       template_content: template_content || '' }),
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

    async function addEncryptedNote({ notebook, title, template_path, password, folder }) {
        try {
            const r = await fetch('/api/note/new-encrypted', {
                method: 'POST',
                headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ notebook, folder: folder || '', title, tags: [], content: '', password }),
            });
            const d = await r.json();
            if (d.success) { _encPassword = password; return d; }
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

    function _previewVirtualTemplate(content, name, moduleLabel) {
        const el = document.getElementById('nb-preview-content');
        document.getElementById('nb-preview-toolbar').hidden = true;
        const html = _renderMarkdown(content);
        el.innerHTML = `
            <div style="padding:10px 32px 8px;font-size:11px;color:var(--text-dim);
                        font-family:var(--font-mono);border-bottom:1px solid var(--border);
                        display:flex;align-items:center;gap:12px">
                <span>🔌 <strong>${_esc(name)}</strong></span>
                <span style="opacity:0.6">${_esc(moduleLabel || 'plugin template')}</span>
            </div>
            <div class="nb-rendered" style="padding:24px 32px;opacity:0.75">${html}</div>`;
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
        const seq = ++_listSeq;
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
            if (seq !== _listSeq) return;
            const d = await r.json();
            if (seq !== _listSeq) return;
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

    // ── Notebooks settings view ────────────────────────────────────

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
        if (sortBtn) sortBtn.classList.toggle('nb-sort-active', _nbSortMode !== 'active-first');

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

    // ── Plugins page ───────────────────────────────────────────────────────────

    async function runPlugins() {
        document.getElementById('nb-preview-toolbar').hidden = true;
        document.getElementById('nb-preview-content').innerHTML =
            '<div id="nb-welcome"><h2>Plugins</h2><p>Loading…</p></div>';
        document.getElementById('nb-list-empty').hidden = true;
        document.getElementById('nb-count').textContent = '…';
        document.getElementById('nb-type-breakdown').textContent = '';

        const nbwebPlugins = NbWeb.list();

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
                    // Bail if Flask served the SPA fallback instead of a real file
                    if (!md.includes('nb-preview-content')) {
                        helpHtml = `<div class="nb-plugin-help nb-markdown">${marked.parse(md)}</div>`;
                    }
                }
            } catch(_) {}
        }

        const activeFor = p.global ? 'all notebooks'
            : p.activeNotebooks.length ? p.activeNotebooks.join(', ') : 'none detected';
        const statusColor = p.error ? 'var(--red)' : p.enabled ? 'var(--green,#2ecc71)' : 'var(--text-dim)';
        const statusText  = p.error ? '✗ error' : p.enabled ? '● active' : '◌ disabled';

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

        content.innerHTML = `
            <div class="nb-plugin-header">
                <span style="font-size:18px">🔌</span>
                <strong style="font-size:14px;color:var(--text)">${_esc(p.spec?.label || p.name)}</strong>
                <span style="color:${statusColor};font-size:12px">${statusText}</span>
                <span class="nb-plugin-active-for">${_esc(activeFor)}</span>
            </div>
            ${p.spec?.description ? `<div class="nb-plugin-desc">${_esc(p.spec.description)}</div>` : ''}
            ${helpHtml}
            ${listDefaultsHtml}
            <div id="nbplug-custom-content"></div>
            <div class="nb-plugin-section" style="display:flex;gap:8px;flex-wrap:wrap">
                <button id="nbplug-toggle" class="nb-tool-btn">${p.enabled ? 'Disable' : 'Enable'}</button>
                <button id="nbplug-remove" class="nb-tool-btn" style="color:var(--red)">Remove</button>
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

        document.getElementById('nbplug-toggle').addEventListener('click', async () => {
            NbWeb.setEnabled(p.name, !p.enabled);
            const s = await fetch('/api/nb-settings').then(r => r.json());
            const plugins = (s.plugins || []).map(pl =>
                pl.url?.includes(p.name) ? { ...pl, enabled: !p.enabled } : pl);
            await fetch('/api/nb-settings', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ plugins }),
            });
            runPlugins();
        });

        document.getElementById('nbplug-remove').addEventListener('click', async () => {
            if (!confirm(`Remove plugin "${p.name}"?`)) return;
            NbWeb.unregister(p.name);
            const s = await fetch('/api/nb-settings').then(r => r.json());
            const plugins = (s.plugins || []).filter(pl => !pl.url?.includes(p.name));
            await fetch('/api/nb-settings', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ plugins }),
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

    function _renderNbList(notebooks) {
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
                        _renderNbList(_lastNbList.map(n => ({ ...n, is_current: n.name === name })));
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
                    ? `<div class="nb-rendered" style="margin-top:12px;opacity:0.85">${_renderMarkdown(bodyRaw)}</div>` : '';
                content.innerHTML = `${HDR}<div style="padding:16px 32px 8px;opacity:0.85">${fmHtml}${bodyHtml}</div>`;

                const _renderedEl = content.querySelector('.nb-rendered');
                if (_renderedEl) _renderCsvBlocks(_renderedEl);
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

    return { init, loadNotes, resetAndLoad, resetSort, search, openNote, openToday,
             showAddForm, addNote, addEncryptedNote, encPassword: () => _encPassword,
             runCmd, runCal, runGrep, runTemplates, runNbNotebooks, runPlugins, runAccount, loadTemplatesForAdd,
             doSync, showNbGitLog, showNbGitWire, doLinkFile, showAbout, openEditor: _openEditor, closeEditor: _closeEditor, saveNote: _saveNote,
             isEditing: () => _editing,
             setFoldersFirst,
             importFiles: (files, nb, folder) => _importFiles(files, nb, folder),
             importPaths: (paths, nb, folder) => _importPaths(paths, nb, folder),
             exportFormats: _exportFormats,
             doPrint: _doPrint,
             clearNote,
             activeSelector: () => _activeSelector,
             activeNote:     () => _activeNote,
             activeType:     () => _activeType,
             activeFilename: () => _activeFilename,
             selectedSelectors: () => _selectedSelectors,
             clearSelection: _clearSelection,
             deselect: sel => { _selectedSelectors.delete(sel); _updateSelectionUI(); },
             renderNoteHtml: _renderNoteHtml,
             renderMarkdown:  (body, sel)       => _renderMarkdown(body, sel),
             enrichRendered:  (container, note) => _enrichRendered(container, note),
             wireContainer:   (container, note) => _wireContainer(container, note),
             fetchContainer:  (container, note) => _fetchContainer(container, note),
             bustNoteCache:   sel => { if (sel) _noteCache.delete(sel); else _noteCache.clear(); },
             matchTagColor:   _matchTagColor };
})();

// ── Terminal + Settings-in-preview ────────────────────────────────
const NbTerminal = (() => {
    let _term = null;
    let _ws   = null;

    function _previewEl()  { return document.getElementById('nb-preview-content'); }
    function _toolbarEl()  { return document.getElementById('nb-preview-toolbar'); }

    function openSettings(anchor = '') {
        const el = _previewEl();
        if (!el) return;
        _toolbarEl().hidden = true;
        el.innerHTML = `<iframe src="/settings.html${anchor ? '#' + anchor : ''}" style="width:100%;height:100%;min-height:600px;border:none"></iframe>`;
    }

    async function run(cmd) {
        if (_ws?.readyState === WebSocket.OPEN) {
            _ws.send(cmd + '\r');
            return;
        }
        await open(cmd);
    }

    async function open(extraCmd = '') {
        const el = _previewEl();
        if (!el) return;

        // Toggle off if already showing terminal (only via plain open(), not run())
        if (!extraCmd && el.querySelector('#nb-pty-wrap')) {
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
            // Codeblock launches bypass the init script — just run the app directly.
            const init = extraCmd || cfg.pty_init || '';
            ws.send(JSON.stringify({ cwd: cfg.pty_cwd || '', init, cols, rows }));
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

    return { open, close, run, openSettings };
})();

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

document.addEventListener('DOMContentLoaded', async () => {
    await NbWeb.loadLocale();
    NbWeb.applyI18n();
    await NbWeb._loadPlugins();
    await NbWeb._init();
    NbMain.init();
    NbDialog.init();
});

// nb-web nav.js — command bar, opts bar, output bar, side menu

const NbNav = (() => {
    let _notebooks = [];
    let _scope     = 'home';   // global notebook scope, set via Notebooks cmd

    let _activeCmd = 'list';

    // Per-notebook defaults applied when switching scope in list view
    const _NB_DEFAULTS = {
        contacts: { type: 'contact', sort: 'az'      },
        nb:       { type: 'todo',    sort: 'default'  },
    };
    const _DEFAULT_LIST = { type: 'all', sort: 'default' };

    function _applyNotebookDefaults(nb) {
        const d = _NB_DEFAULTS[nb] || _DEFAULT_LIST;
        _state.list.type = d.type;
        NbMain.resetSort?.(d.sort);
    }

    // Per-command state (scope-independent options only)
    const _state = {
        list:    { type: 'all', todoStatus: 'open' },
        add:       { type: 'note', title: '', url: '', template: null, templateName: '', dirty: false },
        templates: {},
        todo:    { status: 'open' },
        cal:     { displayYear: new Date().getFullYear(), displayMonth: new Date().getMonth() + 1,
                   selected: null, start: null, end: null, noteDays: new Set() },
        daily:   { date: '' },
        g:       { all: false, context: 0, before: 0, after: 0, pattern: '' },
        info:    {},
        weather: {},
    };

    let _calKeyHandler = null;   // removed when leaving cal mode

    // folder drill state (per-command so drill persists)
    const _folder = {};

    // ── Notebooks ─────────────────────────────────────────────────

    async function _loadNotebooks() {
        try {
            const r = await fetch('/api/notebooks');
            const d = await r.json();
            _notebooks = d.notebooks || [];
            // Seed scope from nb's actual current notebook on first load
            if (d.current_notebook && _notebooks.includes(d.current_notebook)) {
                _scope = d.current_notebook;
            }
            renderOptsBar();
            // Apply per-notebook defaults now that scope is known, then
            // poll sync status against the correct notebook
            _applyNotebookDefaults(_scope);
            _pollNbSyncStatus();
        } catch (e) {
            console.error('loadNotebooks:', e);
        }
    }

    // ── Command bar ───────────────────────────────────────────────

    function _initCmdBar() {
        document.querySelectorAll('.nb-cmd').forEach(btn => {
            btn.addEventListener('click', () => activateCmd(btn.dataset.cmd));
        });
        // Search-bar icon buttons (toggle: click active icon → back to list)
        document.getElementById('nb-cal-icon')?.addEventListener('click', () =>
            activateCmd(_activeCmd === 'cal' ? 'list' : 'cal'));
    }

    function activateCmd(cmd, opts = {}) {
        if (!opts.internal && NbMain.isEditing?.()) {
            if (!confirm('Discard unsaved changes?')) return;
            NbMain.closeEditor?.();
        }
        if (!opts.internal) { NbDialog.close?.(); NbMain.clearSelection?.(); }
        if (cmd === 'add' && !opts.internal) {
            const pa = document.getElementById('nb-preview-actions');
            if (pa) pa.hidden = true;
        }
        const isContactsShortcut = (cmd === 'contacts');
        if (isContactsShortcut) { _scope = 'contacts'; cmd = 'list'; }

        // Explicit user navigation to List: clear transient filters so the
        // list always opens clean, regardless of what command was active.
        if (cmd === 'list' && !opts.internal && !isContactsShortcut) {
            // Coming from contacts scope: reset back to home
            if (_scope === 'contacts') _scope = 'home';
            // Coming from a different command: clear search + tags
            if (_activeCmd !== 'list') {
                _searchQuery = '';
                _tagsQuery   = '';
                ['nb-search', 'nb-tags'].forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.value = '';
                });
                ['nb-search-clear', 'nb-tags-clear'].forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.hidden = true;
                });
            }
        }

        _activeCmd = cmd;
        document.querySelectorAll('.nb-cmd').forEach(b =>
            b.classList.toggle('active', b.dataset.cmd === cmd));

        // Full-preview layout (no list pane) for output-only commands
        const fullPreview = ['daily', 'info', 'weather'].includes(cmd);
        document.getElementById('nb-layout').classList.toggle('nb-full-preview', fullPreview);

        // Clean up cal Enter handler when leaving cal
        if (_calKeyHandler) {
            document.removeEventListener('keydown', _calKeyHandler);
            _calKeyHandler = null;
        }

        if (cmd === 'list') _applyNotebookDefaults(_scope);
        else NbMain.resetSort?.();   // non-list commands just reset
        _updateSearchIcons();
        renderOptsBar();
        _executeCmd();
    }

    // ── Opts bar ──────────────────────────────────────────────────

    function renderOptsBar() {
        const bar = document.getElementById('nb-cmd-opts-bar');
        bar.innerHTML = '';
        (_optsRenderers[_activeCmd] || (() => {}))(bar);
        _updateOutputBar();
    }

    const _optsRenderers = {
        list:      _renderListOpts,
        add:       _renderAddOpts,
        todo:      _renderTodoOpts,
        cal:       _renderCalOpts,
        daily:     _renderDailyOpts,
        g:         _renderGrepOpts,
        templates: _renderTemplatesOpts,
        info:      () => {},
        weather:   () => {},
    };

    // Scope selector — a compact <select> showing all notebooks + All
    function _makeScopeSelect(onChange) {
        const wrap = document.createElement('span');
        wrap.className = 'nb-scope-wrap';
        wrap.title = 'Scope (notebook)';

        const icon = document.createElement('span');
        icon.className   = 'nb-scope-icon';
        icon.textContent = '📒';
        icon.setAttribute('aria-hidden', 'true');

        const sel = document.createElement('select');
        sel.className = 'nb-scope-select';

        const allOpt = document.createElement('option');
        allOpt.value = '_all'; allOpt.textContent = 'all';
        sel.appendChild(allOpt);

        _notebooks.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name; opt.textContent = name;
            if (name === _scope) opt.selected = true;
            sel.appendChild(opt);
        });
        if (_scope === '_all') sel.value = '_all';

        sel.addEventListener('change', () => {
            _scope = sel.value;
            _updateOutputBar();
            onChange(_scope);
            sel.blur();   // release focus so arrow keys go to the list, not notebook options
        });

        wrap.append(icon, sel);
        return wrap;
    }

    function _renderListOpts(bar) {
        const st = _state.list;

        function _run() {
            _executeCmd();   // honours _searchQuery / _tagsQuery alongside type + status
        }

        bar.appendChild(_makeScopeSelect(nb => { _applyNotebookDefaults(nb); renderOptsBar(); _run(); }));
        bar.appendChild(_makeSep());

        bar.appendChild(_makeChipRow([
            { val: 'all',      label: 'all' },
            { val: 'note',     label: '📝'  },
            { val: 'bookmark', label: '🔖'  },
            { val: 'todo',     label: '✔'   },
            { val: 'contact',  label: '🪪'  },
            { val: 'folder',   label: '📂'  },
            { val: 'image',    label: '🌄'  },
        ], st.type, val => {
            st.type = val;
            statusWrap.hidden = val !== 'todo';
            _updateOutputBar();
            _run();
        }));

        // Status chips — appear only when ✔ todo type is active
        const statusWrap = document.createElement('span');
        statusWrap.className = 'nb-opts-chips';
        statusWrap.hidden = st.type !== 'todo';
        ['open', 'closed'].forEach(s => {
            const chip = _makeChip(s, st.todoStatus === s, () => {
                st.todoStatus = s;
                statusWrap.querySelectorAll('.nb-opt-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                _updateOutputBar();
                _run();
            });
            statusWrap.appendChild(chip);
        });
        bar.appendChild(statusWrap);
    }

    function _renderAddOpts(bar) {
        const st = _state.add;
        let urlInput, titleInput, actionWrap, scopeWrap, tmplBtn;
        let _tmplMode = false;

        function _syncTmplBtn() {
            if (!tmplBtn) return;
            const hasTemplate = !!st.template;
            tmplBtn.classList.toggle('active', _tmplMode || hasTemplate);
            tmplBtn.title = hasTemplate
                ? `Template: ${st.templateName} (click to change)`
                : 'Use template';
        }

        async function _applyDefaultTemplate(nb) {
            try {
                const r = await fetch(`/api/template/default?notebook=${encodeURIComponent(nb)}`);
                const d = await r.json();
                if (d.template) {
                    st.template     = d.template.path;
                    st.templateName = d.template.name;
                } else {
                    st.template = null; st.templateName = '';
                }
                _syncTmplBtn();
                _updateOutputBar();
            } catch(e) { /* network error — leave template state unchanged */ }
        }

        // Scope select — first/leftmost; hidden when creating a notebook (they're top-level)
        scopeWrap = _makeScopeSelect(async nb => {
            _updateOutputBar();
            await _applyDefaultTemplate(nb === '_all' ? 'home' : nb);
            _tmplMode ? NbMain.loadTemplatesForAdd() : NbMain.loadNotes();
        });
        scopeWrap.hidden = st.type === 'notebook';
        bar.appendChild(scopeWrap);

        bar.appendChild(_makeSep());

        // Type chips
        bar.appendChild(_makeChipRow([
            { val: 'note',     label: '📝 Note'     },
            { val: 'bookmark', label: '🔖 Bookmark' },
            { val: 'todo',     label: '✔ Todo'      },
            { val: 'folder',   label: '📂 Folder'   },
            { val: 'notebook', label: '📒 Notebook' },
        ], st.type, val => {
            st.type = val;
            if (urlInput)   urlInput.hidden  = val !== 'bookmark';
            if (scopeWrap)  scopeWrap.hidden = val === 'notebook';
            if (titleInput) titleInput.placeholder =
                val === 'folder'   ? 'Folder name…'   :
                val === 'notebook' ? 'Notebook name…' : 'Title…';
            if (tmplBtn) {
                tmplBtn.hidden = val !== 'note';
                if (val !== 'note' && _tmplMode) {
                    _tmplMode = false;
                    st.template = null; st.templateName = '';
                    _syncTmplBtn();
                    NbMain.loadNotes();
                }
            }
            _updateOutputBar();
        }));

        // Templates toggle — note type only; active when template mode is on OR a template is applied
        tmplBtn = document.createElement('button');
        tmplBtn.className = 'nb-icon-btn';
        tmplBtn.textContent = '📋';
        tmplBtn.hidden      = st.type !== 'note';
        tmplBtn.addEventListener('click', () => {
            _tmplMode = !_tmplMode;
            _syncTmplBtn();
            _tmplMode ? NbMain.loadTemplatesForAdd() : NbMain.loadNotes();
        });
        _syncTmplBtn();   // reflect any already-applied template
        bar.appendChild(tmplBtn);

        bar.appendChild(_makeSep());

        // Title input — grows to fill available space
        titleInput = document.createElement('input');
        titleInput.type        = 'text';
        titleInput.className   = 'nb-opt-input nb-add-title';
        titleInput.placeholder = st.type === 'folder'   ? 'Folder name…'   :
                                 st.type === 'notebook' ? 'Notebook name…' : 'Title…';
        titleInput.value       = st.title;
        titleInput.addEventListener('input', () => { st.title = titleInput.value; _markDirty(); });
        titleInput.addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && st.dirty) _doEdit();
            else if (e.key === 'Enter'  && st.dirty) _doSave();
            if (e.key === 'Escape')                  _doCancel();
        });
        bar.appendChild(titleInput);

        // URL input — bookmark only
        urlInput = document.createElement('input');
        urlInput.type        = 'url';
        urlInput.className   = 'nb-opt-input nb-add-url';
        urlInput.placeholder = 'URL…';
        urlInput.value       = st.url;
        urlInput.hidden      = st.type !== 'bookmark';
        urlInput.addEventListener('input', () => { st.url = urlInput.value; _markDirty(); });
        urlInput.addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && st.dirty) _doEdit();
            else if (e.key === 'Enter'  && st.dirty) _doSave();
            if (e.key === 'Escape')                  _doCancel();
        });
        bar.appendChild(urlInput);

        // Cancel / Save row — full-width so it always sits on its own line
        actionWrap = document.createElement('div');
        actionWrap.className = 'nb-add-actions';
        actionWrap.hidden    = !st.dirty;

        const cancelBtn = document.createElement('button');
        cancelBtn.className   = 'nb-tool-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', _doCancel);

        const wantsEditor = st.type === 'note' || st.type === 'todo';
        const editBtn = document.createElement('button');
        editBtn.className   = 'nb-tool-btn';
        editBtn.textContent = 'Edit';
        editBtn.hidden      = !wantsEditor;
        editBtn.addEventListener('click', _doEdit);

        const saveBtn = document.createElement('button');
        saveBtn.className   = 'nb-tool-btn nb-btn-primary';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', _doSave);

        actionWrap.append(cancelBtn, editBtn, saveBtn);
        bar.appendChild(actionWrap);

        // ── Local helpers (close over DOM refs) ───────────────────

        function _markDirty() {
            st.dirty = true;
            actionWrap.hidden = false;
            _updateOutputBar();
        }

        function _busy(label) {
            saveBtn.disabled = editBtn.disabled = true;
            saveBtn.textContent = label;
        }
        function _idle() {
            saveBtn.disabled = editBtn.disabled = false;
            saveBtn.textContent = 'Save';
        }

        function _doCancel() {
            st.title = ''; st.url = ''; st.template = null; st.templateName = ''; st.dirty = false;
            titleInput.value = ''; urlInput.value = '';
            actionWrap.hidden = true;
            _tmplMode = false;
            _syncTmplBtn();
            _updateOutputBar();
            NbMain.loadNotes();
        }

        function _noteArgs() {
            return {
                notebook:      _scope === '_all' ? 'home' : _scope,
                type:          st.type,
                title:         st.title,
                url:           st.url,
                template_path: st.template || '',
            };
        }

        async function _doSave() {
            if (!st.title && !st.url) return;
            if (saveBtn.disabled) return;
            _busy('Saving…');
            try {
                const result = await NbMain.addNote(_noteArgs());
                if (result) {
                    _doCancel();
                    if (result.selector) NbMain.openNote(result.selector);
                }
            } finally {
                _idle();
            }
        }

        async function _doEdit() {
            if (!st.title && !st.url) return;
            if (editBtn.disabled) return;
            _busy('Opening…');
            try {
                const result = await NbMain.addNote(_noteArgs());
                if (result && result.selector) {
                    st.title = ''; st.url = ''; st.template = null; st.dirty = false;
                    activateCmd('list', { internal: true });
                    await NbMain.openNote(result.selector);
                    NbMain.openEditor(result.selector);
                } else if (result) {
                    console.warn('[doEdit] no selector returned — falling back to save', result);
                    _doCancel();
                }
            } finally {
                _idle();
            }
        }

        // Focus title immediately when Add is clicked
        requestAnimationFrame(() => titleInput.focus());

        // Auto-apply notebook default template on open (async — won't delay render)
        if (st.type === 'note' && !st.dirty) {
            _applyDefaultTemplate(_scope === '_all' ? 'home' : _scope);
        }
    }

    function _renderTodoOpts(bar) {
        bar.appendChild(_makeScopeSelect(() => _executeCmd()));
        bar.appendChild(_makeSep());
        bar.appendChild(_makeChipRow([
            { val: 'open',   label: 'open'   },
            { val: 'closed', label: 'closed' },
        ], _state.todo.status, val => {
            _state.todo.status = val;
            _updateOutputBar();
            _executeCmd();
        }));
    }

    function _renderCalOpts(bar) {
        const st = _state.cal;
        const today = new Date().toISOString().slice(0, 10);

        // Default selected to today on first open; clean up any stale Enter handler
        if (!st.selected) st.selected = today;
        if (_calKeyHandler) {
            document.removeEventListener('keydown', _calKeyHandler);
            _calKeyHandler = null;
        }

        // ── Widget shell ──────────────────────────────────────────
        const widget = document.createElement('div');
        widget.className = 'nb-cal-widget';

        // ── Left: mini calendar ───────────────────────────────────
        const left = document.createElement('div');
        left.className = 'nb-cal-left';

        // Month header
        const header = document.createElement('div');
        header.className = 'nb-cal-header';

        const prevBtn = document.createElement('button');
        prevBtn.className = 'nb-cal-nav-btn';
        prevBtn.textContent = '‹';

        const monthLabel = document.createElement('div');
        monthLabel.className = 'nb-cal-month-label';

        const nextBtn = document.createElement('button');
        nextBtn.className = 'nb-cal-nav-btn';
        nextBtn.textContent = '›';

        const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

        function _updateMonthLabel() {
            monthLabel.innerHTML = '';
            const y = st.displayYear, m = st.displayMonth;
            const pfx  = `${y}-${String(m).padStart(2,'0')}`;
            const last = new Date(y, m, 0).getDate();
            const mBtn = document.createElement('button');
            mBtn.className = 'nb-cal-label-btn';
            mBtn.textContent = MONTHS[m - 1];
            mBtn.addEventListener('click', () => {
                st.start = `${pfx}-01`; st.end = `${pfx}-${last}`; st.selected = null;
                _updateLabels(); _renderGrid(); _updateOutputBar();
                NbMain.runCal({ start: st.start, end: st.end, notebook: _scope });
            });
            const yBtn = document.createElement('button');
            yBtn.className = 'nb-cal-label-btn';
            yBtn.textContent = y;
            yBtn.addEventListener('click', () => {
                st.start = `${y}-01-01`; st.end = `${y}-12-31`; st.selected = null;
                _updateLabels(); _renderGrid(); _updateOutputBar();
                NbMain.runCal({ start: st.start, end: st.end, notebook: _scope });
            });
            monthLabel.append(mBtn, ' ', yBtn);
        }
        _updateMonthLabel();
        header.append(prevBtn, monthLabel, nextBtn);
        left.appendChild(header);

        // Calendar grid
        const grid = document.createElement('div');
        grid.className = 'nb-cal-grid';

        // Weekday header row
        ['Mo','Tu','We','Th','Fr','Sa','Su'].forEach(d => {
            const cell = document.createElement('span');
            cell.className = 'nb-cal-day nb-cal-day-hdr';
            cell.textContent = d;
            grid.appendChild(cell);
        });

        function _renderGrid() {
            while (grid.children.length > 7) grid.removeChild(grid.lastChild);
            const y = st.displayYear, m = st.displayMonth;
            const firstDay = new Date(y, m - 1, 1).getDay();
            const offset = (firstDay + 6) % 7;   // Mon-first
            const daysInMonth = new Date(y, m, 0).getDate();
            const pfx = `${y}-${String(m).padStart(2,'0')}`;

            for (let i = 0; i < offset; i++) {
                const cell = document.createElement('span');
                cell.className = 'nb-cal-day nb-cal-empty';
                grid.appendChild(cell);
            }
            for (let d = 1; d <= daysInMonth; d++) {
                const ds = `${pfx}-${String(d).padStart(2,'0')}`;
                const cell = document.createElement('button');
                cell.className = 'nb-cal-day';
                cell.textContent = d;
                cell.dataset.date = ds;
                if (ds === today)         cell.classList.add('today');
                if (st.noteDays?.has(ds)) cell.classList.add('has-notes');
                if (ds === st.selected)   cell.classList.add('selected');
                if (ds === st.start)      cell.classList.add('range-start');
                if (ds === st.end)        cell.classList.add('range-end');
                if (st.start && st.end && ds > st.start && ds < st.end)
                    cell.classList.add('in-range');
                cell.addEventListener('click', () => _selectDay(ds));
                grid.appendChild(cell);
            }
        }
        _renderGrid();
        left.appendChild(grid);
        widget.appendChild(left);

        // ── Right: action column ──────────────────────────────────
        const right = document.createElement('div');
        right.className = 'nb-cal-right';

        const startLabel = document.createElement('div');
        startLabel.className = 'nb-cal-range-item';
        const endLabel = document.createElement('div');
        endLabel.className = 'nb-cal-range-item';

        function _updateLabels() {
            startLabel.textContent = `▶ ${st.start || '–'}`;
            endLabel.textContent   = `◀ ${st.end   || '–'}`;
            startLabel.classList.toggle('nb-cal-range-set', !!st.start);
            endLabel.classList.toggle('nb-cal-range-set',   !!st.end);
        }
        _updateLabels();

        function _makeCalBtn(label, onClick) {
            const b = document.createElement('button');
            b.className   = 'nb-opt-chip';
            b.textContent = label;
            b.addEventListener('click', onClick);
            return b;
        }

        right.append(
            _makeCalBtn('Today', () => {
                const now = new Date();
                st.displayYear  = now.getFullYear();
                st.displayMonth = now.getMonth() + 1;
                st.start = null; st.end = null; st.selected = today;
                _updateMonthLabel(); _updateLabels(); _renderGrid(); _updateOutputBar();
                _loadNoteDays();
                _selectDay(today);
            }),
            startLabel,
            endLabel,
            _makeCalBtn('Start', () => {
                if (!st.selected) return;
                st.start = st.selected; st.end = null;
                _updateLabels(); _renderGrid(); _updateOutputBar();
                NbMain.runCal({ start: st.start, notebook: _scope });
            }),
            _makeCalBtn('End', () => {
                if (!st.selected) return;
                st.end = st.selected;
                if (st.start && st.end < st.start) [st.start, st.end] = [st.end, st.start];
                _updateLabels(); _renderGrid(); _updateOutputBar();
                NbMain.runCal({ start: st.start || st.end, end: st.end, notebook: _scope });
            }),
            _makeCalBtn('Clear', () => {
                st.start = null; st.end = null; st.selected = null;
                _updateLabels(); _renderGrid(); _updateOutputBar();
                _runMonth();
            }),
            _makeScopeSelect(() => { _updateOutputBar(); _runMonth(); }),
        );
        widget.appendChild(right);
        bar.appendChild(widget);

        // ── Month navigation ──────────────────────────────────────
        function _stepMonth(delta) {
            st.displayMonth += delta;
            if (st.displayMonth < 1)  { st.displayMonth = 12; st.displayYear--; }
            if (st.displayMonth > 12) { st.displayMonth =  1; st.displayYear++; }
            _updateMonthLabel();
            _renderGrid(); _updateOutputBar();
            _loadNoteDays();
        }
        prevBtn.addEventListener('click', () => _stepMonth(-1));
        nextBtn.addEventListener('click', () => _stepMonth(1));

        // ── Select a day ──────────────────────────────────────────
        function _selectDay(ds) {
            st.selected = ds;
            _renderGrid(); _updateOutputBar();
            const s = st.start || ds;
            const e = st.end   || ds;
            NbMain.runCal({ start: s, end: e, notebook: _scope });
        }

        // ── Run current display month ─────────────────────────────
        function _runMonth() {
            const y = st.displayYear, m = st.displayMonth;
            const pfx = `${y}-${String(m).padStart(2,'0')}`;
            const last = new Date(y, m, 0).getDate();
            NbMain.runCal({ start: `${pfx}-01`, end: `${pfx}-${last}`, notebook: _scope });
        }

        // ── Load note-days for current month (async highlight) ────
        async function _loadNoteDays() {
            const y = st.displayYear, m = st.displayMonth;
            const pfx  = `${y}-${String(m).padStart(2,'0')}`;
            const last = new Date(y, m, 0).getDate();
            try {
                const params = new URLSearchParams({
                    start: `${pfx}-01`, end: `${pfx}-${last}`,
                    notebook: (_scope && _scope !== '_all') ? _scope : 'home',
                });
                const r = await fetch('/api/cal?' + params);
                const d = await r.json();
                st.noteDays = new Set((d.entries || []).map(e => e.date));
                _renderGrid();
            } catch(_e) {}
        }

        _loadNoteDays();
        // Show today's notes on open (or re-run the current selection)
        _selectDay(st.selected || today);

        // Enter key selects the currently highlighted day
        _calKeyHandler = (e) => {
            if (e.key !== 'Enter') return;
            if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) return;
            e.preventDefault();
            _selectDay(st.selected || today);
        };
        document.addEventListener('keydown', _calKeyHandler);
    }

    function _renderDailyOpts(bar) {
        const st = _state.daily;
        const label = document.createElement('span');
        label.className = 'nb-opt-nav-label';
        label.textContent = st.date || 'today';

        function step(d) {
            const base = st.date ? new Date(st.date + 'T12:00:00') : new Date();
            base.setDate(base.getDate() + d);
            st.date = base.toISOString().slice(0, 10);
            label.textContent = st.date;
            _updateOutputBar(); _executeCmd();
        }

        const wrap = document.createElement('div');
        wrap.className = 'nb-opts-nav';
        wrap.append(
            _makeNavBtn('◀', () => step(-1)),
            label,
            _makeNavBtn('▶', () => step(1)),
            _makeChip('today', !st.date, () => {
                st.date = ''; label.textContent = 'today';
                _updateOutputBar(); _executeCmd();
            })
        );
        bar.appendChild(wrap);
    }

    function _renderGrepOpts(bar) {
        const st = _state.g;

        const patInput = document.createElement('input');
        patInput.type        = 'text';
        patInput.className   = 'nb-opt-input';
        patInput.placeholder = 'pattern…';
        patInput.value       = st.pattern;
        patInput.addEventListener('input',   () => { st.pattern = patInput.value; _updateOutputBar(); });
        patInput.addEventListener('keydown', e  => { if (e.key === 'Enter') _executeCmd(); });
        bar.appendChild(patInput);
        bar.appendChild(_makeSep());

        const allChip = _makeChip('--all', st.all, () => {
            st.all = !st.all;
            allChip.classList.toggle('active', st.all);
            _updateOutputBar();
            if (st.pattern) _executeCmd();
        });
        bar.appendChild(allChip);
        bar.appendChild(_makeSep());

        // Context lines stepper
        const stepWrap = document.createElement('div');
        stepWrap.className = 'nb-opts-stepper';
        const ctxLbl = document.createElement('span');
        ctxLbl.className   = 'nb-step-label';
        ctxLbl.textContent = `-C ${st.context}`;
        ctxLbl.title       = 'Context lines (before + after)';
        const btnM = document.createElement('button'); btnM.className = 'nb-step-btn'; btnM.textContent = '−';
        const btnP = document.createElement('button'); btnP.className = 'nb-step-btn'; btnP.textContent = '+';
        btnM.addEventListener('click', () => { if (st.context > 0) { st.context--; st.before = st.after = st.context; } ctxLbl.textContent = `-C ${st.context}`; _updateOutputBar(); });
        btnP.addEventListener('click', () => { if (st.context < 9) { st.context++; st.before = st.after = st.context; } ctxLbl.textContent = `-C ${st.context}`; _updateOutputBar(); });
        stepWrap.append(btnM, ctxLbl, btnP);
        bar.appendChild(stepWrap);
        bar.appendChild(_makeSep());

        const runBtn = document.createElement('button');
        runBtn.className   = 'nb-opt-chip nb-opt-run';
        runBtn.textContent = 'run ↵';
        runBtn.addEventListener('click', _executeCmd);
        bar.appendChild(runBtn);

        requestAnimationFrame(() => patInput.focus());
    }

    function _renderTemplatesOpts(bar) {
        bar.appendChild(_makeScopeSelect(() => _executeCmd()));
    }

    // ── Helpers ───────────────────────────────────────────────────

    function _typeArg(type) { return type !== 'all' ? `--type ${type}` : null; }

    function _makeChipRow(items, activeVal, onChange) {
        const row = document.createElement('div');
        row.className = 'nb-opts-chips';
        items.forEach(({ val, label }) => {
            const chip = _makeChip(label, val === activeVal, () => {
                row.querySelectorAll('.nb-opt-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                onChange(val);
            });
            chip.title = val;
            row.appendChild(chip);
        });
        return row;
    }

    function _makeChip(label, isActive, onClick) {
        const btn = document.createElement('button');
        btn.className   = 'nb-opt-chip' + (isActive ? ' active' : '');
        btn.textContent = label;
        btn.addEventListener('click', onClick);
        return btn;
    }

    function _makeNavBtn(label, onClick) {
        const btn = document.createElement('button');
        btn.className   = 'nb-opt-nav-btn';
        btn.textContent = label;
        btn.addEventListener('click', onClick);
        return btn;
    }

    function _makeSep() {
        const s = document.createElement('span');
        s.className = 'nb-opts-sep';
        s.setAttribute('aria-hidden', 'true');
        return s;
    }

    // ── Output bar (omnipresent token bar) ───────────────────────

    let _searchQuery = '';
    let _tagsQuery   = '';

    // Build an ordered list of token descriptors for the current state.
    // Tokens with a clearFn become filter chips with ×.
    function _buildTokens() {
        const cmd    = _activeCmd;
        const st     = _state[cmd] || {};
        const folder = _folder[cmd] || '';
        const tokens = [];

        // Helper: scope token (notebook + folder combined)
        function _scopeTok() {
            if (_scope === '_all') {
                return { text: '--all', clearFn: () => {
                    _scope = 'home'; _executeCmd(); _updateOutputBar();
                }};
            }
            if (_scope !== 'home' || folder) {
                const t = folder ? `${_scope}:${folder}/` : `${_scope}:`;
                return { text: t, clearFn: () => {
                    _scope = 'home'; _folder[cmd] = ''; updateBreadcrumb([]);
                    _executeCmd(); _updateOutputBar();
                }};
            }
            return null;
        }

        // Helper: search token
        function _searchTok() {
            if (!_searchQuery) return null;
            return { text: `"${_searchQuery}"`, clearFn: () => {
                _searchQuery = '';
                const el = document.getElementById('nb-search');
                const cl = document.getElementById('nb-search-clear');
                if (el) el.value = '';
                if (cl) cl.hidden = true;
                _executeCmd(); _updateOutputBar();
            }};
        }

        // Helper: tags token
        function _tagsTok() {
            if (!_tagsQuery) return null;
            return { text: `--tags ${_tagsQuery}`, clearFn: () => {
                _tagsQuery = '';
                const el = document.getElementById('nb-tags');
                const cl = document.getElementById('nb-tags-clear');
                if (el) el.value = '';
                if (cl) cl.hidden = true;
                _executeCmd(); _updateOutputBar();
            }};
        }

        switch (cmd) {
            case 'list': {
                tokens.push({ text: 'list' });
                const sc = _scopeTok(); if (sc) tokens.push(sc);
                if (st.type && st.type !== 'all') {
                    const typeText = st.type === 'todo'
                        ? `todo ${st.todoStatus || 'open'}`
                        : `--type ${st.type}`;
                    tokens.push({ text: typeText, clearFn: () => {
                        st.type = 'all'; renderOptsBar(); _executeCmd();
                    }});
                }
                const tg = _tagsTok();  if (tg) tokens.push(tg);
                const sq = _searchTok(); if (sq) tokens.push(sq);
                break;
            }
            case 'todo': {
                tokens.push({ text: `todo ${st.status || 'open'}` });
                const sc = _scopeTok(); if (sc) tokens.push(sc);
                const tg = _tagsTok();  if (tg) tokens.push(tg);
                const sq = _searchTok(); if (sq) tokens.push(sq);
                break;
            }
            case 'add': {
                const t = st.type === 'bookmark' ? 'bookmark'      :
                          st.type === 'todo'     ? 'todo add'      :
                          st.type === 'folder'   ? 'add folder'    :
                          st.type === 'notebook' ? 'notebooks add' : 'add';
                tokens.push({ text: t });
                if (_scope !== 'home' && st.type !== 'notebook') tokens.push({ text: `${_scope}:` });
                if (st.template) {
                    const tname = st.template.split('/').pop().replace(/\.md$/, '');
                    tokens.push({ text: `--template ${tname}`, clearFn: () => {
                        st.template = null;
                        NbMain.loadTemplatesForAdd();
                        _updateOutputBar();
                    }});
                }
                if (st.title) tokens.push({ text: `"${st.title}"` });
                if (st.url)   tokens.push({ text: st.url });
                break;
            }
            case 'templates': {
                tokens.push({ text: 'templates' });
                const sc = _scopeTok(); if (sc) tokens.push(sc);
                break;
            }
            case 'cal': {
                tokens.push({ text: 'cal' });
                if (_scope !== 'home') tokens.push({ text: `${_scope}:` });
                if (st.start) tokens.push({ text: `--start ${st.start}`, clearFn: () => {
                    st.start = null; renderOptsBar(); _executeCmd();
                }});
                if (st.end) tokens.push({ text: `--end ${st.end}`, clearFn: () => {
                    st.end = null; renderOptsBar(); _executeCmd();
                }});
                if (!st.start && !st.end && st.selected) tokens.push({ text: st.selected });
                const tg = _tagsTok();  if (tg) tokens.push(tg);
                const sq = _searchTok(); if (sq) tokens.push(sq);
                break;
            }
            case 'daily':
                tokens.push({ text: 'daily' });
                tokens.push({ text: st.date || 'today' });
                break;
            case 'g': {
                tokens.push({ text: 'g' });
                if (st.all) tokens.push({ text: '--all', clearFn: () => {
                    st.all = false; renderOptsBar(); _executeCmd();
                }});
                if (st.pattern) tokens.push({ text: `"${st.pattern}"` });
                if (st.before > 0 || st.after > 0) {
                    if (st.before === st.after) tokens.push({ text: `-C ${st.before}` });
                    else { tokens.push({ text: `-B ${st.before}` }); tokens.push({ text: `-A ${st.after}` }); }
                } else if (st.context > 0) {
                    tokens.push({ text: `-C ${st.context}` });
                }
                break;
            }
            case 'info':    tokens.push({ text: 'info' });    break;
            case 'weather': tokens.push({ text: 'weather' }); break;
            default:        tokens.push({ text: _activeCmd || 'list' }); break;
        }

        // Selection tokens — appended after cmd tokens
        const selSet = NbMain.selectedSelectors?.();
        if (selSet?.size > 0) {
            tokens.push({ text: '·' });   // visual separator, non-clearable
            [...selSet].forEach(s => tokens.push({
                text: s,
                clearFn: () => NbMain.deselect?.(s),
            }));
        }

        return tokens;
    }

    function _updateOutputBar() {
        const bar    = document.getElementById('nb-cmd-output-bar');
        const tokDiv = document.getElementById('nb-cmd-output-tokens');
        if (!bar || !tokDiv) return;

        tokDiv.innerHTML = '';
        _buildTokens().forEach(tok => {
            const span = document.createElement('span');
            span.className = 'nb-cmd-token' + (tok.clearFn ? ' nb-cmd-token-filter' : '');
            span.appendChild(document.createTextNode(tok.text));
            if (tok.clearFn) {
                const x = document.createElement('button');
                x.className   = 'nb-cmd-token-x';
                x.textContent = '×';
                x.title       = 'Remove this filter';
                x.addEventListener('click', e => { e.stopPropagation(); tok.clearFn(); });
                span.appendChild(x);
            }
            tokDiv.appendChild(span);
        });
        bar.removeAttribute('hidden');   // always visible
    }

    function _clearOutputBar() {
        // Clear search + tags
        _searchQuery = ''; _tagsQuery = '';
        const searchEl = document.getElementById('nb-search');
        const clearEl  = document.getElementById('nb-search-clear');
        if (searchEl) searchEl.value = '';
        if (clearEl)  clearEl.hidden = true;
        const tagsEl = document.getElementById('nb-tags');
        const tagsCl = document.getElementById('nb-tags-clear');
        if (tagsEl) tagsEl.value = '';
        if (tagsCl) tagsCl.hidden = true;
        // Clear folder + scope
        _folder[_activeCmd] = '';
        _scope = 'home';
        updateBreadcrumb([]);
        // Reset command-specific state
        const now = new Date();
        const defaults = {
            list:      { type: 'all', todoStatus: 'open' },
            todo:      { status: 'open' },
            cal:       { displayYear: now.getFullYear(), displayMonth: now.getMonth() + 1,
                         selected: null, start: null, end: null, noteDays: new Set() },
            daily:     { date: '' },
            g:         { all: false, context: 0, before: 0, after: 0, pattern: '' },
            templates: {},
        };
        if (defaults[_activeCmd]) Object.assign(_state[_activeCmd], defaults[_activeCmd]);
        renderOptsBar();
        _executeCmd();
    }

    function setSearchQuery(q) {
        _searchQuery = q;
        _updateOutputBar();
    }

    function setTagsQuery(q) {
        _tagsQuery = q;
        _updateOutputBar();
    }

    function setAddTemplate(path, name = '') {
        _state.add.template     = path;
        _state.add.templateName = name || (path ? path.split('/').pop().replace(/\.[^.]*$/, '') : '');
        _updateOutputBar();
    }

    function _updateSearchIcons() {
        document.getElementById('nb-cal-icon')?.classList.toggle('active', _activeCmd === 'cal');
    }

    // ── Execute command ───────────────────────────────────────────

    function _executeCmd() {
        const st = _state[_activeCmd];
        switch (_activeCmd) {
            case 'list': {
                const _status = st.type === 'todo' ? (st.todoStatus || 'open') : null;
                if (_searchQuery && _tagsQuery)
                    NbMain.search(_searchQuery, _typeArg(st.type), _status, _tagsQuery);
                else if (_searchQuery)
                    NbMain.search(_searchQuery, _typeArg(st.type), _status);
                else
                    // tags-only (or no filter): server handles tag grep, client applies type
                    NbMain.loadNotes(_typeArg(st.type), _status, _tagsQuery || '');
                break;
            }
            case 'todo':    NbMain.loadNotes('--type todo', _state.todo.status);        break;
            case 'add':     /* form lives in opts bar; list/preview untouched */        break;
            case 'cal': {
                const y = st.displayYear, m = st.displayMonth;
                const pfx = `${y}-${String(m).padStart(2,'0')}`;
                const last = new Date(y, m, 0).getDate();
                NbMain.runCal({ start: st.start || `${pfx}-01`,
                                end:   st.end   || `${pfx}-${last}`,
                                notebook: _scope });
                break;
            }
            case 'daily':     NbMain.runCmd('daily', { date: st.date });               break;
            case 'g':         NbMain.runGrep(st);                                      break;
            case 'templates':     NbMain.runTemplates();                               break;
            case 'nb-notebooks': NbMain.runNbNotebooks();                              break;
            case 'info':      NbMain.runCmd('info');                                   break;
            case 'weather':   NbMain.runCmd('weather');                                break;
        }
    }

    // ── Side menu ─────────────────────────────────────────────────

    function _initMenu() {
        const logo    = document.getElementById('nb-logo-btn');
        const overlay = document.getElementById('nb-menu-overlay');
        const menu    = document.getElementById('nb-side-menu');
        const header  = document.getElementById('nb-menu-header');
        const nav     = document.getElementById('nb-menu-nav');

        function open() { menu.classList.add('open'); overlay.removeAttribute('hidden'); }
        function shut() { menu.classList.remove('open'); overlay.setAttribute('hidden', ''); }

        logo.addEventListener('click', open);
        overlay.addEventListener('click', shut);
        header.addEventListener('click', shut);

        const menuSyncBtn = document.getElementById('nb-menu-sync-btn');
        if (menuSyncBtn) {
            menuSyncBtn.addEventListener('click', e => {
                e.stopPropagation(); // prevent header click-to-close
                shut();
                _openSyncDialog();
            });
        }

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && menu.classList.contains('open')) shut();
        });

        const _UI_CMDS = new Set(['list','add','todo','cal','templates','nb-notebooks','g','daily','weather','info','contacts']);

        function _menuAction(cmd) {
            shut();
            if (_UI_CMDS.has(cmd))      activateCmd(cmd);
            else if (cmd === 'sync')    _openSyncDialog();
            else if (cmd === 'git-log')  NbMain.showNbGitLog();
            else if (cmd === 'git-wire') NbMain.showNbGitWire();
            else if (cmd === 'about')   NbMain.showAbout();
            else if (cmd === 'restart') _restartServer();
            else if (cmd === 'import')      NbDialog.open('import');
            else if (cmd === 'export')      NbDialog.open('export');
            else if (cmd === 'link-file')   NbMain.doLinkFile();
            else if (cmd === 'contacts')    activateCmd('contacts');
            else if (cmd === 'nb-settings') NbTerminal.openSettings();
            else if (cmd === 'terminal')    NbTerminal.open();
            else                        NbMain.runCmd(cmd);
        }

        async function _restartServer() {
            const bar    = document.getElementById('nb-cmd-output-bar');
            const tokens = document.getElementById('nb-cmd-output-tokens');
            bar.hidden = false;
            tokens.textContent = 'Restarting…';
            await fetch('/api/restart', { method: 'POST' }).catch(() => {});
            const poll = () => fetch('/api/notebooks')
                .then(async () => {
                    // Full SW + cache flush so the reload always gets fresh assets
                    if ('serviceWorker' in navigator) {
                        const regs = await navigator.serviceWorker.getRegistrations();
                        await Promise.all(regs.map(r => r.unregister()));
                    }
                    await Promise.all((await caches.keys()).map(k => caches.delete(k)));
                    location.reload();
                })
                .catch(() => setTimeout(poll, 400));
            setTimeout(poll, 600);
        }

        function _openSyncDialog() {
            const dialog    = document.getElementById('nb-sync-dialog');
            const title     = document.getElementById('nb-sync-title');
            const changesEl  = document.getElementById('nb-sync-changes');
            const comment    = document.getElementById('nb-sync-comment');
            const nowBtn     = document.getElementById('nb-sync-now');
            const previewBtn = document.getElementById('nb-sync-preview');
            const logBtn     = document.getElementById('nb-sync-log');
            const outputWrap = dialog.querySelector('.nb-sync-output-wrap');
            const output     = document.getElementById('nb-sync-output');
            const copyBtn    = dialog.querySelector('.nb-sync-copy-btn');
            const closeBtn  = document.getElementById('nb-sync-close');
            if (!dialog) return;

            const showOutput = text => {
                output.textContent  = text;
                outputWrap.hidden   = false;
            };
            const hideOutput = () => {
                outputWrap.hidden   = true;
                output.textContent  = '';
            };

            copyBtn.onclick = () => {
                navigator.clipboard.writeText(output.textContent).then(() => {
                    const orig = copyBtn.textContent;
                    copyBtn.textContent = '✓';
                    setTimeout(() => { copyBtn.textContent = orig; }, 1200);
                });
            };

            const nb = (!_scope || _scope === '_all') ? 'home' : _scope;
            title.textContent  = `Sync · ${nb}`;
            comment.value      = '';
            nowBtn.disabled    = false;
            nowBtn.textContent = 'Sync Now';
            hideOutput();
            changesEl.innerHTML   = 'Loading…';

            fetch(`/api/nb/sync/status?notebook=${encodeURIComponent(nb)}`).then(r => r.json()).then(d => {
                if (!d.has_remote) {
                    nowBtn.disabled = true;
                    const defaultUrl = d.default_remote || '';
                    changesEl.innerHTML =
                        `<div class="nb-sync-nowire">` +
                            `<div class="nb-sync-noremote-label">Not connected to a remote</div>` +
                            `<input type="text" class="nb-sync-remote-url nb-tw-inp" ` +
                                `placeholder="git@github.com:user/repo.git" value="${defaultUrl}">` +
                            `<button class="nb-sync-connect-btn">Connect</button>` +
                        `</div>`;
                    const connectBtn = changesEl.querySelector('.nb-sync-connect-btn');
                    const urlInput   = changesEl.querySelector('.nb-sync-remote-url');
                    connectBtn.onclick = () => {
                        const url = urlInput.value.trim();
                        if (!url) return;
                        connectBtn.disabled    = true;
                        connectBtn.textContent = 'Connecting…';
                        fetch('/api/nb/wire-notebook', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ notebook: nb, remote_url: url }),
                        }).then(r => r.json()).then(wd => {
                            showOutput(wd.output || (wd.success ? 'Connected.' : 'Connect failed.'));
                            if (wd.success) {
                                changesEl.innerHTML = '<span class="nb-sync-uptodate">Connected — up to date</span>';
                                nowBtn.disabled    = false;
                                nowBtn.textContent = 'Sync Now';
                                _pollNbSyncStatus();
                            } else {
                                connectBtn.disabled    = false;
                                connectBtn.textContent = 'Retry';
                            }
                        }).catch(err => {
                            showOutput('Error: ' + err);
                            connectBtn.disabled    = false;
                            connectBtn.textContent = 'Retry';
                        });
                    };
                    return;
                }
                const _h = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                const parts = [];
                if (d.files?.length) {
                    const STATUS_LABEL = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', '?': 'untracked' };
                    const rows = d.files.map(f => {
                        const label = STATUS_LABEL[f.status] || f.status;
                        return `<span class="nb-sync-file-row">` +
                            `<span class="nb-sync-fs nb-sync-fs-${f.status.toLowerCase()}">${label}</span>` +
                            `<span class="nb-sync-fname">${_h(f.path)}</span></span>`;
                    }).join('');
                    parts.push(
                        `<div class="nb-sync-files-section">` +
                        `<div class="nb-sync-files-label">${d.files.length} file${d.files.length !== 1 ? 's' : ''} uncommitted</div>` +
                        `${rows}</div>`
                    );
                }
                if (d.unpushed) {
                    const n = d.unpushed;
                    let html = `<div class="nb-sync-files-section">` +
                        `<div class="nb-sync-files-label">${n} unpushed commit${n !== 1 ? 's' : ''}</div>`;
                    if (d.pending_commits?.length) {
                        html += d.pending_commits.map(c =>
                            `<span class="nb-sync-file-row">` +
                            `<span class="nb-sync-commit-hash">${_h(c.hash)}</span>` +
                            `<span class="nb-sync-commit-subject">${_h(c.subject)}</span>` +
                            `<span class="nb-sync-commit-age">${_h(c.age)}</span>` +
                            `</span>`
                        ).join('');
                    }
                    html += `</div>`;
                    parts.push(html);
                }
                changesEl.innerHTML = parts.length
                    ? parts.join('')
                    : '<span class="nb-sync-uptodate">Up to date</span>';
            }).catch(() => { changesEl.textContent = 'Could not load status.'; });

            dialog.style.display = 'flex';
            const close = () => { dialog.style.display = 'none'; };
            closeBtn.onclick  = close;
            dialog.onclick    = e => { if (e.target === dialog) close(); };

            nowBtn.onclick = () => {
                const msg = comment.value.trim();
                nowBtn.disabled = true;
                hideOutput();

                let elapsed = 0;
                const tick = () => { nowBtn.textContent = `Syncing… ${++elapsed}s`; };
                nowBtn.textContent = 'Syncing… 0s';
                const timer = setInterval(tick, 1000);

                fetch('/api/sync', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ notebook: nb, message: msg }),
                }).then(r => r.json()).then(data => {
                    clearInterval(timer);
                    showOutput(data.output || (data.success ? 'Sync complete.' : 'Sync failed.'));
                    nowBtn.disabled    = false;
                    nowBtn.textContent = data.success ? 'Sync Now' : 'Retry';
                    if (data.success) {
                        comment.value = '';
                        _pollNbSyncStatus();
                        NbNav.reexecute();
                        // Refresh the status panel inside the dialog
                        changesEl.innerHTML = '<span class="nb-sync-uptodate">Up to date</span>';
                        fetch(`/api/nb/sync/status?notebook=${encodeURIComponent(nb)}`)
                            .then(r => r.json()).then(d => {
                                if (d.unpushed || d.files?.length)
                                    changesEl.innerHTML = `<span class="nb-sync-unpushed">${d.changes} change${d.changes !== 1 ? 's' : ''} remaining</span>`;
                            }).catch(() => {});
                    }
                }).catch(err => {
                    clearInterval(timer);
                    showOutput('Error: ' + err);
                    nowBtn.disabled    = false;
                    nowBtn.textContent = 'Retry';
                });
            };

            logBtn.onclick = () => {
                logBtn.disabled = true;
                fetch(`/api/nb/git-log?notebook=${encodeURIComponent(nb)}&n=30`)
                    .then(r => r.json())
                    .then(d => { showOutput(d.output || '(no log)'); })
                    .catch(err => { showOutput('Error: ' + err); })
                    .finally(() => { logBtn.disabled = false; });
            };

            previewBtn.onclick = () => {
                previewBtn.disabled = true;
                let elapsed = 0;
                const tick = () => { previewBtn.textContent = `Fetching… ${++elapsed}s`; };
                previewBtn.textContent = 'Fetching… 0s';
                const timer = setInterval(tick, 1000);
                fetch(`/api/nb/sync/preview?notebook=${encodeURIComponent(nb)}`)
                    .then(r => r.json())
                    .then(d => { showOutput(d.output || '(nothing to preview)'); })
                    .catch(err => { showOutput('Error: ' + err); })
                    .finally(() => {
                        clearInterval(timer);
                        previewBtn.disabled = false;
                        previewBtn.textContent = 'Preview';
                    });
            };

            // Danger zone moved to Notebooks settings page (Menu → Notebooks)
        }

        const MENU = [
            { label: 'About', items: [
                { label: 'version', cmd: 'version' },
            ]},
            { label: 'Help',      cmd: 'help' },
            { label: 'Contacts',  cmd: 'contacts' },
            { label: 'Import',    cmd: 'import' },
            { label: 'Export',    cmd: 'export' },
            { label: 'History',   cmd: 'history' },
            { label: 'Notebooks', cmd: 'nb-notebooks' },
            { label: 'Plugins',   cmd: 'plugins' },
            { label: 'Terminal',  cmd: 'terminal' },
            { label: 'Settings',  cmd: 'nb-settings' },
            { label: 'Templates', cmd: 'templates' },
            { label: 'Undo',      cmd: 'undo' },
        ];

        nav.innerHTML = '';
        MENU.forEach(entry => {
            if (entry.items) {
                const group = document.createElement('div');
                group.className = 'nb-menu-group';

                const hdr = document.createElement('button');
                hdr.className = 'nb-menu-section';
                const lbl = document.createElement('span');
                lbl.textContent = entry.label;
                const arrow = document.createElement('span');
                arrow.className = 'nb-menu-arrow';
                arrow.textContent = '▸';
                hdr.append(lbl, arrow);
                hdr.addEventListener('click', () => group.classList.toggle('open'));
                group.appendChild(hdr);

                const sub = document.createElement('div');
                sub.className = 'nb-menu-subitems';
                entry.items.forEach(item => {
                    const btn = document.createElement('button');
                    btn.className = 'nb-menu-item nb-menu-subitem';
                    btn.textContent = item.label;
                    btn.dataset.cmd = item.cmd;
                    btn.addEventListener('click', () => _menuAction(item.cmd));
                    sub.appendChild(btn);
                });
                group.appendChild(sub);
                nav.appendChild(group);
            } else {
                const btn = document.createElement('button');
                btn.className = 'nb-menu-item nb-menu-toplevel';
                btn.textContent = entry.label;
                btn.dataset.cmd = entry.cmd;
                btn.addEventListener('click', () => _menuAction(entry.cmd));
                nav.appendChild(btn);
            }
        });
    }

    // ── Sync dialog (module-level) ────────────────────────────────

    function _initSyncDialog() {
        if (document.getElementById('nb-sync-dialog')) return;
        const el = document.createElement('div');
        el.id        = 'nb-sync-dialog';
        el.className = 'nb-sync-backdrop';
        el.style.display = 'none';
        el.innerHTML =
            `<div class="nb-sync-dialog">` +
                `<div class="nb-sync-header">` +
                    `<span id="nb-sync-title">Sync</span>` +
                    `<button id="nb-sync-close" class="nb-sync-close">×</button>` +
                `</div>` +
                `<div class="nb-sync-body">` +
                    `<div id="nb-sync-changes" class="nb-sync-changes">Loading…</div>` +
                    `<input type="text" id="nb-sync-comment" class="nb-sync-comment nb-tw-inp"` +
                           ` placeholder="Commit message (optional)">` +
                    `<div class="nb-sync-btn-row">` +
                        `<button id="nb-sync-now" class="nb-sync-now-btn">Sync Now</button>` +
                        `<button id="nb-sync-preview" class="nb-sync-secondary-btn">Preview</button>` +
                        `<button id="nb-sync-log" class="nb-sync-secondary-btn">Show Log</button>` +
                    `</div>` +
                    `<div class="nb-sync-output-wrap" hidden>` +
                        `<button class="nb-sync-copy-btn" title="Copy to clipboard">copy</button>` +
                        `<pre id="nb-sync-output" class="nb-sync-output"></pre>` +
                    `</div>` +
                `</div>` +
            `</div>`;
        document.body.appendChild(el);
    }

    async function _pollNbSyncStatus() {
        const nb = (!_scope || _scope === '_all') ? 'home' : _scope;
        try {
            const d = await fetch(`/api/nb/sync/status?notebook=${encodeURIComponent(nb)}`).then(r => r.json());
            const syncBtn  = document.getElementById('nb-menu-sync-btn');
            const logoBtn  = document.getElementById('nb-logo-btn');
            const pending  = !d.has_remote || d.changes > 0 || d.unpushed > 0;
            logoBtn?.classList.toggle('nb-sync-pending', pending);
            if (!syncBtn) return;
            syncBtn.classList.toggle('nb-sync-pending', pending);
            if (!d.has_remote) {
                syncBtn.textContent = `Sync ${nb}  ·  no remote`;
            } else if (d.changes > 0 || d.unpushed > 0) {
                const parts = [];
                if (d.unpushed)      parts.push(`${d.unpushed} unpushed`);
                if (d.files?.length) parts.push(`${d.files.length} uncommitted`);
                syncBtn.textContent = `Sync ${nb}  ·  ${parts.join(', ')}`;
            } else {
                syncBtn.textContent = `Sync ${nb}`;
            }
        } catch { /* network error — leave badge as-is */ }
    }

    // ── Folder navigation ─────────────────────────────────────────

    function goUpFolder() {
        const cur = _folder[_activeCmd] || '';
        if (!cur) return;
        const parts = cur.split('/');
        parts.pop();
        _folder[_activeCmd] = parts.join('/');
        NbMain.loadNotes();
        const remaining = _folder[_activeCmd];
        updateBreadcrumb(remaining ? remaining.split('/') : []);
    }

    // ── Breadcrumb ────────────────────────────────────────────────

    function updateBreadcrumb(segments) {
        const el = document.getElementById('nb-breadcrumb');
        if (!segments.length) { el.hidden = true; el.innerHTML = ''; return; }
        el.hidden = false;
        el.innerHTML = '';
        const root = document.createElement('span');
        root.className   = 'nb-crumb';
        root.textContent = _scope;
        root.addEventListener('click', () => {
            _folder[_activeCmd] = '';
            NbMain.loadNotes();
            updateBreadcrumb([]);
        });
        el.appendChild(root);
        let built = '';
        segments.forEach(seg => {
            const sep = document.createElement('span');
            sep.className = 'nb-crumb-sep'; sep.textContent = ' / ';
            el.appendChild(sep);
            built += (built ? '/' : '') + seg;
            const crumb = document.createElement('span');
            crumb.className   = 'nb-crumb';
            crumb.textContent = seg;
            const captured = built;
            crumb.addEventListener('click', () => {
                _folder[_activeCmd] = captured;
                NbMain.loadNotes();
                updateBreadcrumb(captured.split('/'));
            });
            el.appendChild(crumb);
        });
    }

    function drillFolder(folderName) {
        const cur = _folder[_activeCmd] || '';
        _folder[_activeCmd] = cur ? `${cur}/${folderName}` : folderName;
        NbMain.loadNotes();
        updateBreadcrumb(_folder[_activeCmd].split('/'));
    }

    function drillFolderInNotebook(notebook, folderName) {
        _scope = notebook;
        document.querySelectorAll('.nb-scope-select').forEach(sel => { sel.value = notebook; });
        _folder[_activeCmd] = folderName;
        _updateOutputBar();
        NbMain.loadNotes();
        updateBreadcrumb([folderName]);
    }

    // ── Public ────────────────────────────────────────────────────

    return {
        init() {
            const notebooksReady = _loadNotebooks();
            _initCmdBar();
            _initMenu();
            _initSyncDialog();
            setInterval(_pollNbSyncStatus, 60_000);
            document.getElementById('nb-cmd-output-clear').addEventListener('click', _clearOutputBar);

            const prompt = document.querySelector('.nb-cmd-output-prompt');
            if (prompt) {
                prompt.title  = 'Copy command to clipboard';
                prompt.style.cursor = 'pointer';
                prompt.addEventListener('click', () => {
                    const selSet = NbMain.selectedSelectors?.();
                    let text;
                    if (selSet?.size > 0) {
                        text = [...selSet].join(' ');   // just the selectors for CLI use
                    } else {
                        const parts = [...document.querySelectorAll('#nb-cmd-output-tokens .nb-cmd-token')]
                            .map(el => el.childNodes[0]?.textContent?.trim())
                            .filter(Boolean);
                        text = 'nb ' + parts.join(' ');
                    }
                    navigator.clipboard.writeText(text).then(() => {
                        const orig = prompt.textContent;
                        prompt.textContent = '✓';
                        setTimeout(() => { prompt.textContent = orig; }, 900);
                    });
                });
            }
            return notebooksReady;
        },
        get notebook()     { return _scope; },
        get notebooks()    { return [..._notebooks]; },
        get folder()       { return _folder[_activeCmd] || ''; },
        get activeCmd()    { return _activeCmd; },
        get searchQuery()  { return _searchQuery; },
        get tagsQuery()    { return _tagsQuery; },
        reexecute: () => _executeCmd(),
        get addTemplate() { return _state.add.template; },
        setAddTemplate,
        activateCmd,
        drillFolder,
        drillFolderInNotebook,
        goUpFolder,
        switchNotebook(nb) {
            if (!nb || nb === _scope) return;
            _scope = nb;
            _folder[_activeCmd] = '';
            document.querySelectorAll('.nb-scope-select').forEach(sel => { sel.value = nb; });
            activateCmd('list');
        },
        updateBreadcrumb,
        setSearchQuery,
        setTagsQuery,
        updateOutputBar: _updateOutputBar,
    };
})();

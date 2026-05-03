// nb-web nav.js — command bar, opts bar, output bar, side menu

const NbNav = (() => {
    let _notebooks = [];
    let _scope     = 'home';   // global notebook scope, set via Notebooks cmd

    let _activeCmd = 'list';

    // Per-command state (scope-independent options only)
    const _state = {
        list:    { type: 'all' },
        add:     { type: 'note', title: '', url: '', dirty: false },
        todo:    { status: 'open' },
        cal:     { displayYear: new Date().getFullYear(), displayMonth: new Date().getMonth() + 1,
                   selected: null, start: null, end: null, noteDays: new Set() },
        daily:   { date: '' },
        g:       { all: false, context: 1, pattern: '' },
        info:    {},
        weather: {},
    };

    // folder drill state (per-command so drill persists)
    const _folder = {};

    // ── Notebooks ─────────────────────────────────────────────────

    async function _loadNotebooks() {
        try {
            const r = await fetch('/api/notebooks');
            const d = await r.json();
            _notebooks = d.notebooks || [];
            renderOptsBar();
        } catch (e) {
            console.error('loadNotebooks:', e);
        }
    }

    // ── Command bar ───────────────────────────────────────────────

    function _initCmdBar() {
        document.querySelectorAll('.nb-cmd').forEach(btn => {
            btn.addEventListener('click', () => activateCmd(btn.dataset.cmd));
        });
        // Search-bar icon buttons
        document.getElementById('nb-todo-icon') ?.addEventListener('click', () => {
            activateCmd(_activeCmd === 'todo' ? 'list' : 'todo');
        });
        document.getElementById('nb-tasks-icon')?.addEventListener('click', () => {
            if (_activeCmd === 'list' && _state.list.type === 'todo') {
                _state.list.type = 'all';
                activateCmd('list');
            } else {
                _state.list.type = 'todo';
                activateCmd('list');
            }
        });
        document.getElementById('nb-cal-icon')  ?.addEventListener('click', () => {
            activateCmd(_activeCmd === 'cal' ? 'list' : 'cal');
        });
    }

    function activateCmd(cmd) {
        _activeCmd = cmd;
        document.querySelectorAll('.nb-cmd').forEach(b =>
            b.classList.toggle('active', b.dataset.cmd === cmd));

        // Full-preview layout (no list pane) for output-only commands
        const fullPreview = ['daily', 'info', 'weather'].includes(cmd);
        document.getElementById('nb-layout').classList.toggle('nb-full-preview', fullPreview);

        NbMain.resetSort?.();   // new command context — reset list sort
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
        list:    _renderListOpts,
        add:     _renderAddOpts,
        todo:    _renderTodoOpts,
        cal:     _renderCalOpts,
        daily:   _renderDailyOpts,
        g:       _renderGrepOpts,
        info:    () => {},
        weather: () => {},
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
        });

        wrap.append(icon, sel);
        return wrap;
    }

    function _renderListOpts(bar) {
        bar.appendChild(_makeScopeSelect(() => NbMain.loadNotes(_typeArg(_state.list.type))));
        bar.appendChild(_makeSep());
        bar.appendChild(_makeChipRow([
            { val: 'all',      label: 'all' },
            { val: 'note',     label: '📝'  },
            { val: 'bookmark', label: '🔖'  },
            { val: 'todo',     label: '✔'   },
            { val: 'folder',   label: '📂'  },
            { val: 'image',    label: '🌄'  },
        ], _state.list.type, val => {
            _state.list.type = val;
            _updateOutputBar();
            NbMain.loadNotes(_typeArg(val));
        }));
    }

    function _renderAddOpts(bar) {
        const st = _state.add;
        let urlInput, titleInput, actionWrap, scopeWrap;

        // Type chips — toggle URL/scope visibility and title placeholder
        bar.appendChild(_makeChipRow([
            { val: 'note',     label: '📝 Note'     },
            { val: 'bookmark', label: '🔖 Bookmark' },
            { val: 'todo',     label: '✔ Task'      },
            { val: 'folder',   label: '📂 Folder'   },
            { val: 'notebook', label: '📒 Notebook' },
        ], st.type, val => {
            st.type = val;
            if (urlInput)   urlInput.hidden  = val !== 'bookmark';
            if (scopeWrap)  scopeWrap.hidden = val === 'notebook';
            if (titleInput) titleInput.placeholder =
                val === 'folder'   ? 'Folder name…'   :
                val === 'notebook' ? 'Notebook name…' : 'Title…';
            _updateOutputBar();
        }));

        bar.appendChild(_makeSep());

        // Scope select — hidden when creating a notebook (they're top-level)
        scopeWrap = _makeScopeSelect(() => _updateOutputBar());
        scopeWrap.hidden = st.type === 'notebook';
        bar.appendChild(scopeWrap);

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
            if (e.key === 'Enter'  && st.dirty) _doSubmit();
            if (e.key === 'Escape')              _doCancel();
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
            if (e.key === 'Enter'  && st.dirty) _doSubmit();
            if (e.key === 'Escape')              _doCancel();
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

        const saveBtn = document.createElement('button');
        saveBtn.className   = 'nb-tool-btn nb-btn-primary';
        saveBtn.textContent = 'Add';
        saveBtn.addEventListener('click', _doSubmit);

        actionWrap.append(cancelBtn, saveBtn);
        bar.appendChild(actionWrap);

        // ── Local helpers (close over DOM refs) ───────────────────

        function _markDirty() {
            st.dirty = true;
            actionWrap.hidden = false;
            _updateOutputBar();
        }

        function _doCancel() {
            st.title = ''; st.url = ''; st.dirty = false;
            titleInput.value = ''; urlInput.value = '';
            actionWrap.hidden = true;
            _updateOutputBar();
        }

        async function _doSubmit() {
            if (!st.title && !st.url) return;
            saveBtn.textContent = 'Adding…'; saveBtn.disabled = true;
            try {
                const ok = await NbMain.addNote({
                    notebook: _scope === '_all' ? 'home' : _scope,
                    type:  st.type,
                    title: st.title,
                    url:   st.url,
                });
                if (ok) _doCancel();
            } finally {
                saveBtn.textContent = 'Add'; saveBtn.disabled = false;
            }
        }

        // Focus title immediately when Add is clicked
        requestAnimationFrame(() => titleInput.focus());
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

        const monthLabel = document.createElement('span');
        monthLabel.className = 'nb-cal-month-label';

        const nextBtn = document.createElement('button');
        nextBtn.className = 'nb-cal-nav-btn';
        nextBtn.textContent = '›';

        const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        function _monthStr() {
            return `${MONTHS[st.displayMonth - 1]} ${st.displayYear}`;
        }
        monthLabel.textContent = _monthStr();
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
        );
        widget.appendChild(right);
        bar.appendChild(widget);

        // ── Month navigation ──────────────────────────────────────
        function _stepMonth(delta) {
            st.displayMonth += delta;
            if (st.displayMonth < 1)  { st.displayMonth = 12; st.displayYear--; }
            if (st.displayMonth > 12) { st.displayMonth =  1; st.displayYear++; }
            monthLabel.textContent = _monthStr();
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
        _runMonth();
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
        ctxLbl.title       = 'Context lines';
        const btnM = document.createElement('button'); btnM.className = 'nb-step-btn'; btnM.textContent = '−';
        const btnP = document.createElement('button'); btnP.className = 'nb-step-btn'; btnP.textContent = '+';
        btnM.addEventListener('click', () => { if (st.context > 0) st.context--; ctxLbl.textContent = `-C ${st.context}`; _updateOutputBar(); });
        btnP.addEventListener('click', () => { if (st.context < 9) st.context++; ctxLbl.textContent = `-C ${st.context}`; _updateOutputBar(); });
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
                if (st.type && st.type !== 'all') tokens.push({ text: `--type ${st.type}`, clearFn: () => {
                    st.type = 'all'; renderOptsBar(); _executeCmd();
                    _updateSearchIcons();
                }});
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
                if (st.title) tokens.push({ text: `"${st.title}"` });
                if (st.url)   tokens.push({ text: st.url });
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
                if (st.context > 0) tokens.push({ text: `-C ${st.context}` });
                break;
            }
            case 'info':    tokens.push({ text: 'info' });    break;
            case 'weather': tokens.push({ text: 'weather' }); break;
            default:        tokens.push({ text: _activeCmd || 'list' }); break;
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
            list:  { type: 'all' },
            todo:  { status: 'open' },
            cal:   { displayYear: now.getFullYear(), displayMonth: now.getMonth() + 1,
                     selected: null, start: null, end: null, noteDays: new Set() },
            daily: { date: '' },
            g:     { all: false, context: 1, pattern: '' },
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

    function _updateSearchIcons() {
        document.getElementById('nb-todo-icon') ?.classList.toggle('active', _activeCmd === 'todo');
        document.getElementById('nb-tasks-icon')?.classList.toggle('active',
            _activeCmd === 'list' && _state.list.type === 'todo');
        document.getElementById('nb-cal-icon')  ?.classList.toggle('active', _activeCmd === 'cal');
    }

    // ── Execute command ───────────────────────────────────────────

    function _executeCmd() {
        const st = _state[_activeCmd];
        switch (_activeCmd) {
            case 'list':
                if (_tagsQuery)        NbMain.search(_tagsQuery,   _typeArg(st.type));
                else if (_searchQuery) NbMain.search(_searchQuery, _typeArg(st.type));
                else                   NbMain.loadNotes(_typeArg(st.type));
                break;
            case 'todo':    NbMain.loadNotes('--type todo');                            break;
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
            case 'daily':   NbMain.runCmd('daily', { date: st.date });                 break;
            case 'g':       NbMain.runGrep(st);                                        break;
            case 'info':    NbMain.runCmd('info');                                     break;
            case 'weather': NbMain.runCmd('weather');                                  break;
        }
    }

    // ── Side menu ─────────────────────────────────────────────────

    function _initMenu() {
        const logo    = document.getElementById('nb-logo-btn');
        const overlay = document.getElementById('nb-menu-overlay');
        const menu    = document.getElementById('nb-side-menu');
        const header  = document.getElementById('nb-menu-header');

        function open() { menu.classList.add('open'); overlay.removeAttribute('hidden'); }
        function shut() { menu.classList.remove('open'); overlay.setAttribute('hidden', ''); }

        logo.addEventListener('click', open);
        overlay.addEventListener('click', shut);
        header.addEventListener('click', shut);

        // Close on Escape
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && menu.classList.contains('open')) shut();
        });

        // Menu items — close drawer then act
        document.getElementById('nb-menu-settings').addEventListener('click', () => { shut(); NbSettings.open(); });
        const syncEl = document.getElementById('nb-menu-sync');
        if (syncEl) syncEl.addEventListener('click', () => { shut(); NbMain.doSync(); });
        // Remaining items close the menu; their real action can be wired later
        ['nb-menu-status','nb-menu-import','nb-menu-export','nb-menu-plugins','nb-menu-about']
            .forEach(id => { const el = document.getElementById(id); if (el) el.addEventListener('click', shut); });
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

    // ── Public ────────────────────────────────────────────────────

    return {
        init() {
            _loadNotebooks();
            _initCmdBar();
            _initMenu();
            document.getElementById('nb-cmd-output-clear').addEventListener('click', _clearOutputBar);
        },
        get notebook()  { return _scope; },
        get folder()    { return _folder[_activeCmd] || ''; },
        get activeCmd() { return _activeCmd; },
        activateCmd,
        drillFolder,
        goUpFolder,
        updateBreadcrumb,
        setSearchQuery,
        setTagsQuery,
    };
})();

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
        cal:     { month: new Date().getMonth() + 1, year: new Date().getFullYear() },
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
    }

    function activateCmd(cmd) {
        _activeCmd = cmd;
        document.querySelectorAll('.nb-cmd').forEach(b =>
            b.classList.toggle('active', b.dataset.cmd === cmd));

        // Full-preview layout (no list pane) for output-only commands
        const fullPreview = ['cal', 'daily', 'info', 'weather'].includes(cmd);
        document.getElementById('nb-layout').classList.toggle('nb-full-preview', fullPreview);

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
        let urlInput, titleInput, actionWrap;

        // Type chips — also toggle URL field visibility
        bar.appendChild(_makeChipRow([
            { val: 'note',     label: '📝 Note'     },
            { val: 'bookmark', label: '🔖 Bookmark' },
            { val: 'todo',     label: '✔ Todo'      },
        ], st.type, val => {
            st.type = val;
            if (urlInput) urlInput.hidden = val !== 'bookmark';
            _updateOutputBar();
        }));

        bar.appendChild(_makeSep());
        bar.appendChild(_makeScopeSelect(() => _updateOutputBar()));
        bar.appendChild(_makeSep());

        // Title input — grows to fill available space
        titleInput = document.createElement('input');
        titleInput.type        = 'text';
        titleInput.className   = 'nb-opt-input nb-add-title';
        titleInput.placeholder = 'Title…';
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

    function _renderAddOpts(bar) {
        bar.appendChild(_makeChipRow([
            { val: 'note',     label: '📝 Note'     },
            { val: 'bookmark', label: '🔖 Bookmark' },
            { val: 'todo',     label: '✔ Todo'      },
        ], _state.add.type, val => {
            _state.add.type = val;
            _updateOutputBar();
            NbMain.showAddForm(val);
        }));
    }

    function _renderCalOpts(bar) {
        const st = _state.cal;
        const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const label = document.createElement('span');
        label.className = 'nb-opt-nav-label';

        function update() { label.textContent = `${MON[st.month - 1]} ${st.year}`; }
        function step(d) {
            st.month += d;
            if (st.month < 1)  { st.month = 12; st.year--; }
            if (st.month > 12) { st.month =  1; st.year++; }
            update(); _updateOutputBar(); _executeCmd();
        }
        update();

        const wrap = document.createElement('div');
        wrap.className = 'nb-opts-nav';
        wrap.append(
            _makeNavBtn('◀', () => step(-1)),
            label,
            _makeNavBtn('▶', () => step(1)),
            _makeChip('today', false, () => {
                const n = new Date();
                st.month = n.getMonth() + 1; st.year = n.getFullYear();
                update(); _updateOutputBar(); _executeCmd();
            })
        );
        bar.appendChild(wrap);
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

    // ── Output bar ────────────────────────────────────────────────

    function _updateOutputBar() {
        const bar  = document.getElementById('nb-cmd-output-bar');
        const text = document.getElementById('nb-cmd-output-text');
        const cmd  = _buildCmdString();
        text.textContent = cmd || '';
        bar.hidden = !cmd;
    }

    function _buildCmdString() {
        const cmd = _activeCmd;
        const st  = _state[cmd] || {};

        switch (cmd) {
            case 'list': {
                const parts = ['list'];
                if (_scope === '_all')       parts.push('--all');
                else if (_scope !== 'home')  parts.push(`${_scope}:`);
                if (st.type && st.type !== 'all') parts.push(`--type ${st.type}`);
                return parts.length > 1 ? parts.join(' ') : '';
            }
            case 'todo': {
                const parts = [`todo ${st.status || 'open'}`];
                if (_scope === '_all')       parts.push('--all');
                else if (_scope !== 'home')  parts.push(`${_scope}:`);
                return parts.join(' ');
            }
            case 'add': {
                if (st.type === 'bookmark') return st.url   ? `bookmark ${st.url}`     : 'bookmark';
                if (st.type === 'todo')     return st.title ? `todo add "${st.title}"` : 'todo add';
                return st.title ? `add "${st.title}"` : 'add';
            }
            case 'cal': {
                const n = new Date();
                if (st.month === n.getMonth() + 1 && st.year === n.getFullYear()) return '';
                return `cal ${st.year}-${String(st.month).padStart(2, '0')}`;
            }
            case 'daily':   return st.date ? `daily ${st.date}` : '';
            case 'g': {
                if (!st.pattern) return '';
                const parts = ['g'];
                if (st.all)     parts.push('--all');
                parts.push(`"${st.pattern}"`);
                if (st.context) parts.push(`-C ${st.context}`);
                return parts.join(' ');
            }
            case 'info':    return 'info';
            case 'weather': return 'weather';
            default:        return '';
        }
    }

    function _clearOutputBar() {
        const defaults = {
            list:  { type: 'all' },
            todo:  { status: 'open' },
            cal:   { month: new Date().getMonth() + 1, year: new Date().getFullYear() },
            daily: { date: '' },
            g:     { all: false, context: 1, pattern: '' },
        };
        if (defaults[_activeCmd]) Object.assign(_state[_activeCmd], defaults[_activeCmd]);
        _scope = 'home';
        renderOptsBar();
        _executeCmd();
    }

    // ── Execute command ───────────────────────────────────────────

    function _executeCmd() {
        const st = _state[_activeCmd];
        switch (_activeCmd) {
            case 'list':    NbMain.loadNotes(_typeArg(st.type));                        break;
            case 'todo':    NbMain.loadNotes('--type todo');                            break;
            case 'add':     /* form lives in opts bar; list/preview untouched */        break;
            case 'cal':     NbMain.runCmd('cal',   { month: st.month, year: st.year }); break;
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
        const close   = document.getElementById('nb-menu-close');

        function open() { menu.classList.add('open'); overlay.removeAttribute('hidden'); }
        function shut() { menu.classList.remove('open'); overlay.setAttribute('hidden', ''); }

        logo.addEventListener('click', open);
        overlay.addEventListener('click', shut);
        close.addEventListener('click', shut);

        document.getElementById('nb-menu-settings').addEventListener('click', () => { shut(); NbSettings.open(); });
        const syncEl = document.getElementById('nb-menu-sync');
        if (syncEl) syncEl.addEventListener('click', () => { shut(); NbMain.doSync(); });
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
        updateBreadcrumb,
    };
})();

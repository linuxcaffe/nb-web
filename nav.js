// nb-web nav.js — notebook tab bar, side menu, routing

const NbNav = (() => {
    let _notebooks = [];
    let _current   = 'home';
    let _folder    = '';
    let _view      = 'notes';   // notes | journal | bookmarks | todos | all | tags | pinned

    // ── Notebook tabs ──────────────────────────────────────────────

    async function loadNotebooks() {
        try {
            const r = await fetch('/api/notebooks');
            const d = await r.json();
            _notebooks = d.notebooks || [];
            renderTabs();
        } catch (e) {
            console.error('loadNotebooks:', e);
        }
    }

    function renderTabs() {
        const bar = document.getElementById('nb-notebook-tabs');
        bar.innerHTML = '';

        // "All" pseudo-notebook first
        const allBtn = document.createElement('button');
        allBtn.className = 'nb-notebook-tab' + (_current === '_all' ? ' active' : '');
        allBtn.textContent = 'All';
        allBtn.title = 'All notebooks';
        allBtn.addEventListener('click', () => switchNotebook('_all'));
        bar.appendChild(allBtn);

        _notebooks.forEach(name => {
            const btn = document.createElement('button');
            btn.className = 'nb-notebook-tab' + (name === _current ? ' active' : '');
            btn.textContent = name;
            btn.addEventListener('click', () => switchNotebook(name));
            bar.appendChild(btn);
        });
    }

    function switchNotebook(name) {
        _current = name;
        _folder  = '';
        renderTabs();
        updateBreadcrumb([]);
        // Re-apply whatever is in the search bar to the new notebook context
        const q = document.getElementById('nb-search')?.value.trim();
        if (q) NbMain.search(q);
        else   NbMain.loadNotes();
    }

    // ── Breadcrumb ─────────────────────────────────────────────────

    function updateBreadcrumb(segments) {
        const el = document.getElementById('nb-breadcrumb');
        if (!segments.length) { el.hidden = true; el.innerHTML = ''; return; }
        el.hidden = false;
        el.innerHTML = '';
        const root = document.createElement('span');
        root.className = 'nb-crumb';
        root.textContent = _current;
        root.addEventListener('click', () => { _folder = ''; NbMain.loadNotes(); updateBreadcrumb([]); });
        el.appendChild(root);
        let built = '';
        segments.forEach(seg => {
            const sep = document.createElement('span');
            sep.className = 'nb-crumb-sep'; sep.textContent = ' / ';
            el.appendChild(sep);
            built += (built ? '/' : '') + seg;
            const crumb = document.createElement('span');
            crumb.className = 'nb-crumb';
            crumb.textContent = seg;
            const captured = built;
            crumb.addEventListener('click', () => { _folder = captured; NbMain.loadNotes(); updateBreadcrumb(captured.split('/')); });
            el.appendChild(crumb);
        });
    }

    function drillFolder(folderName) {
        _folder = _folder ? _folder + '/' + folderName : folderName;
        NbMain.loadNotes();
        updateBreadcrumb(_folder.split('/'));
    }

    // ── Side menu ──────────────────────────────────────────────────

    function initMenu() {
        const menuBtn   = document.getElementById('nb-menu-btn');
        const overlay   = document.getElementById('nb-menu-overlay');
        const sideMenu  = document.getElementById('nb-side-menu');
        const closeBtn  = document.getElementById('nb-menu-close');

        function openMenu()  { sideMenu.classList.add('open'); overlay.hidden = false; }
        function closeMenu() { sideMenu.classList.remove('open'); overlay.hidden = true; }

        menuBtn.addEventListener('click', openMenu);
        overlay.addEventListener('click', closeMenu);
        closeBtn.addEventListener('click', closeMenu);

        sideMenu.querySelectorAll('.nb-menu-item[data-view]').forEach(btn => {
            btn.addEventListener('click', () => {
                _view = btn.dataset.view;
                sideMenu.querySelectorAll('.nb-menu-item').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                closeMenu();
                applyView();
            });
        });

        document.getElementById('nb-menu-settings').addEventListener('click', () => {
            closeMenu();
            NbSettings.open();
        });
    }

    function applyView() {
        const searchEl = document.getElementById('nb-search');
        switch (_view) {
            case 'journal':
                searchEl.value = '';
                NbMain.loadNotes();
                document.getElementById('nb-append-bar').hidden = false;
                break;
            case 'bookmarks':
                searchEl.value = '--type bookmark';
                NbMain.loadNotes('--type bookmark');
                break;
            case 'todos':
                searchEl.value = '--type todo';
                NbMain.loadNotes('--type todo');
                break;
            case 'pinned':
                searchEl.value = '#pinned';
                NbMain.search('#pinned');
                break;
            default:
                searchEl.value = '';
                NbMain.loadNotes();
                document.getElementById('nb-append-bar').hidden = true;
        }
    }

    // ── Filter chips ───────────────────────────────────────────────

    const _activeFilters = new Set();

    function addFilter(term) {
        _activeFilters.add(term);
        renderFilterBar();
        NbMain.search([..._activeFilters].join(' '));
    }

    function removeFilter(term) {
        _activeFilters.delete(term);
        renderFilterBar();
        if (_activeFilters.size)
            NbMain.search([..._activeFilters].join(' '));
        else
            NbMain.loadNotes();
    }

    function clearFilters() {
        _activeFilters.clear();
        renderFilterBar();
        NbMain.loadNotes();
    }

    function renderFilterBar() {
        const bar   = document.getElementById('nb-filter-bar');
        const chips = document.getElementById('nb-filter-chips');
        if (!_activeFilters.size) { bar.hidden = true; chips.innerHTML = ''; return; }
        bar.hidden = false;
        chips.innerHTML = '';
        _activeFilters.forEach(term => {
            const chip = document.createElement('div');
            chip.className = 'nb-chip';
            chip.innerHTML = `<span>${_esc(term)}</span><button class="nb-chip-remove" title="Remove">✕</button>`;
            chip.querySelector('.nb-chip-remove').addEventListener('click', () => removeFilter(term));
            chips.appendChild(chip);
        });
    }

    function _esc(s) {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // ── Public ─────────────────────────────────────────────────────

    return {
        init() {
            loadNotebooks();
            initMenu();
            document.getElementById('nb-filter-clear').addEventListener('click', clearFilters);
        },
        get notebook() { return _current; },
        get folder()   { return _folder; },
        get view()     { return _view; },
        drillFolder,
        updateBreadcrumb,
        addFilter,
        removeFilter,
        clearFilters,
    };
})();

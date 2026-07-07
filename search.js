// nb-web search.js — extracted from main.js (tier-2c modularization, 2026-07-06).
// NbSearch: search-bar dispatch (grep shorthand, direct selector, bare id) and
// tag-filter input binding.
//
// Cross-references rewritten during extraction (all other lines verbatim):
//   runGrep(opts)   -> NbMain.runGrep(opts)      (already-exported kernel run* launcher)
//   openNote(sel)   -> NbMain.openNote(sel)
//   loadNotes()     -> NbMain.loadNotes()
//   _searchTimer    -> NbMain.clearSearchTimer()/setSearchTimer(id) (new intent-named
//                       setter pair, not a raw getter+setter -- caught in review: every
//                       call site only ever cleared-then-replaced the timer, never
//                       inspected its value, so exposing the raw id would have been an
//                       unnecessary leak of kernel-internal state across the module
//                       boundary. Still shared kernel state -- also cleared by
//                       resetAndLoad() in the Util section, which stays inside NbMain's
//                       closure and references the bare variable directly.)
//   _selectorPat/_bareIdPat -> privatized (only ever used in _dispatchQuery, confirmed
//                       via full-repo grep -- no other reader)
//   _tagsTimer      -> already a local var scoped inside _bindTags itself, no change

const NbSearch = (() => {
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
            if (opts.pattern) NbMain.runGrep(opts);
            return;
        }

        // Direct selector: notebook:id or notebook:filename.md → open immediately
        if (_selectorPat.test(q)) {
            NbMain.openNote(q);
            return;
        }
        // Bare number → treat as id in current notebook
        if (_bareIdPat.test(q) && NbNav.notebook !== '_all') {
            NbMain.openNote(`${NbNav.notebook}:${q}`);
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
            NbMain.clearSearchTimer();
            NbMain.setSearchTimer(setTimeout(() => _dispatchQuery(input.value), 400));
        });

        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                NbMain.clearSearchTimer();
                _dispatchQuery(input.value);
            }
        });

        clear.addEventListener('click', () => {
            input.value = '';
            clear.hidden = true;
            NbNav.setSearchQuery('');
            if (NbNav.activeCmd === 'cal') NbNav.reexecute();
            else NbMain.loadNotes();
        });
    }

    function init() {
        _bindSearch();
        _bindTags();
    }

    return { init };
})();

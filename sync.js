// nb-web sync.js — extracted from main.js (tier-2d modularization, 2026-07-06).
// NbSync: git wire/log commands, generic run-command dispatch (cal/daily/info/
// weather).
//
// Cross-references rewritten during extraction (all other lines verbatim):
//   _showCmdOutput(cmd, text)  -> NbMain.showCmdOutput(cmd, text)
//   _showPreviewLoading()      -> NbMain.showPreviewLoading()
//     Both were NEWLY EXPOSED on NbMain's return object in this same commit
//     (bare-reference delegation to the existing private main.js functions,
//     NOT moved -- they're genuinely shared utilities also called by runGrep
//     (Grep section) and the import flow (Util section), both of which stay
//     inside NbMain's closure. Moving them would have required exposing them
//     publicly anyway for THIS module's sake, so they stay where multiple
//     callers already are: the kernel.
//
// Deleted rather than carried forward (unlike prior tiers' "defer dead code
// to tier-5" default): doSync(), _bindSync(), showNotebooksWelcome() were all
// confirmed zero-caller dead code via full-repo grep, same as tier-2b's
// openToday/showAddForm -- but this is a brand-new file with no pre-existing
// diff to preserve, and the deadness analysis was already fully done in this
// same review pass. Deleting cost nothing extra and left no dead public API
// surface (NbMain.doSync in particular would have read as a live entry point
// that silently no-ops). Tier-5's dead-function list is now just
// _setFilterBar/_injectRenderingNotice (both still genuinely in main.js).

const NbSync = (() => {
    async function showNbGitWire() {
        NbMain.showCmdOutput('wire remotes', 'Working… (pushing each notebook, may take 10–30s)');
        try {
            const r = await fetch('/api/nb/git-wire', { method: 'POST' });
            if (!r.ok) { NbMain.showCmdOutput('wire remotes', `Server error: ${r.status}`); return; }
            const d = await r.json();
            if (d.error) { NbMain.showCmdOutput('wire remotes', d.error); return; }
            const lines = (d.results || []).map(r => {
                const icon = r.status === 'ok' ? '✓' : r.status === 'skip' ? '·' : '✗';
                return `${icon}  ${r.notebook.padEnd(16)}  ${r.message}`;
            });
            NbMain.showCmdOutput('wire remotes', lines.join('\n') || '(no notebooks found)');
        } catch(e) {
            NbMain.showCmdOutput('wire remotes', String(e));
        }
    }

    async function showNbGitLog() {
        const nb = (!NbNav.notebook || NbNav.notebook === '_all') ? 'home' : NbNav.notebook;
        NbMain.showPreviewLoading();
        try {
            const d = await fetch(`/api/nb/git-log?notebook=${encodeURIComponent(nb)}&n=30`)
                          .then(r => r.json());
            NbMain.showCmdOutput(`git log · ${nb}`, d.output || d.error || '(no output)');
        } catch(e) {
            NbMain.showCmdOutput('git log', String(e));
        }
    }

    async function runCmd(cmd, opts = {}) {
        NbMain.showPreviewLoading();
        try {
            const params = new URLSearchParams({ cmd });
            if (opts.month) params.set('month', opts.month);
            if (opts.year)  params.set('year',  opts.year);
            if (opts.date)  params.set('date',  opts.date);
            const r = await fetch('/api/run?' + params);
            const d = await r.json();
            NbMain.showCmdOutput(cmd, d.output || d.stderr || '(no output)');
        } catch (e) {
            NbMain.showCmdOutput(cmd, String(e));
        }
    }

    return { showNbGitWire, showNbGitLog, runCmd };
})();

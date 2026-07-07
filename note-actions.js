// nb-web note-actions.js — extracted from main.js (tier-2b modularization, 2026-07-06).
// NbNoteActions: Today/Journal view, Add-note form (opts bar + inline), note-creation API wrappers.
//
// Cross-references rewritten during extraction (all other lines verbatim):
//   _t(...)            -> local copy (trivial NbWeb.t wrapper, matches dialog.js's _esc precedent)
//   _esc(...)          -> local copy (matches dialog.js's existing duplicate of the same helper)
//   _renderMarkdown()  -> NbMain.renderMarkdown()
//   openNote()         -> NbMain.openNote()
//   _openEditor()      -> NbMain.openEditor()
//   _activeSelector = null   -> NbMain.clearActiveSelector()   (new narrow setter)
//   _noAutoSelect = v        -> NbMain.setNoAutoSelect(v)      (new narrow setter; still shared
//                                kernel state, read by renderList's auto-select and the inline editor)
//   _encPassword = password  -> NbMain.setEncPassword(password) (new narrow setter; still shared
//                                kernel state, read by renderPreview/_decryptAndRender/_openEditor)
//   _todayInfo               -> privatized to a local module variable (nothing else reads it)
//
// NOT extracted this round: Search and Sync/Run-command -- both had real
// entanglement with code still living inside NbMain's closure at the time
// (_searchTimer also cleared by resetAndLoad(); _showCmdOutput/_showPreviewLoading
// also called by runGrep and the import flow) that needed its own careful
// handling, not folded in here just because it was nearby in the file. Both
// have since been extracted: see search.js (tier-2c) and sync.js (tier-2d).
//
// TODO(tier-5 dead-code pass): openToday/showAddForm (and their only caller,
// _submitAdd) have zero callers anywhere in the codebase as of this extraction
// (confirmed via full-repo grep during the tier-2b review) -- pre-existing,
// not caused by this move. addNote/addEncryptedNote ARE live (called from
// nav.js's opts-bar Add flow). Add these two to the dead-function cleanup list
// alongside _setFilterBar/_injectRenderingNotice (see mainjs-split-design.md).

const NbNoteActions = (() => {
    const _t = key => NbWeb.t(key);
    function _esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    let _todayInfo = null;

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

            const html = NbMain.renderMarkdown(d.body || d.raw || '');
            content.innerHTML = `<div class="nb-rendered">${html}</div>`;

            document.getElementById('nb-append-bar').hidden = false;
            document.getElementById('nb-append-input').focus();

            NbMain.clearActiveSelector();
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
                NbMain.setNoAutoSelect(true);
                NbNav.activateCmd('list', { internal: true });
                if (andEdit && d.selector) {
                    await NbMain.openNote(d.selector);
                    NbMain.setNoAutoSelect(false);
                    NbMain.openEditor(d.selector);
                } else if (d.selector) {
                    NbMain.openNote(d.selector).finally(() => { NbMain.setNoAutoSelect(false); });
                } else {
                    NbMain.setNoAutoSelect(false);
                }
            } else {
                alert('Create failed: ' + (d.error || 'unknown'));
                btn.textContent = _t('btn_create'); btn.disabled = false;
            }
        } catch(e) {
            btn.textContent = _t('btn_create'); btn.disabled = false;
        }
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
            if (d.success) { NbMain.setEncPassword(password); return d; }
            alert('Add failed: ' + (d.error || 'unknown'));
            return null;
        } catch(e) {
            alert('Add failed: ' + String(e));
            return null;
        }
    }

    function init() {
        _bindAppend();
    }

    return { init, openToday, showAddForm, addNote, addEncryptedNote };
})();

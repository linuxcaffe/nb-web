// NbWeb-archive — notebook archive (.nbz) and safe removal
(() => {

    const _esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    // ── Archive ───────────────────────────────────────────────────────────────

    function _showArchiveForm(nb, wrap, archiveBtn) {
        if (document.getElementById('nbarch-form')) return; // already open
        archiveBtn.disabled = true;

        const form = document.createElement('div');
        form.id = 'nbarch-form';
        form.style.cssText = 'margin-top:10px;display:flex;flex-direction:column;gap:8px;font-size:12px';
        form.innerHTML =
            `<label style="display:flex;gap:8px;align-items:center;cursor:pointer">` +
                `<input type="checkbox" id="nbarch-git"> Include git history` +
            `</label>` +
            `<input id="nbarch-desc" class="nb-opt-input" placeholder="Description (optional)">` +
            `<div style="display:flex;gap:6px">` +
                `<button id="nbarch-go" class="nb-tool-btn nb-btn-primary">↓ Create archive</button>` +
                `<button id="nbarch-cancel" class="nb-tool-btn">Cancel</button>` +
            `</div>` +
            `<div id="nbarch-status" style="color:var(--text-dim)"></div>`;
        wrap.appendChild(form);

        document.getElementById('nbarch-cancel').onclick = () => {
            form.remove();
            archiveBtn.disabled = false;
        };

        document.getElementById('nbarch-go').onclick = async () => {
            const btn  = document.getElementById('nbarch-go');
            const stat = document.getElementById('nbarch-status');
            const includesGit = document.getElementById('nbarch-git').checked;
            const desc = document.getElementById('nbarch-desc').value.trim();

            btn.disabled = true;
            btn.textContent = 'Archiving…';
            stat.textContent = '';

            try {
                const r = await fetch('/api/nb/archive', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ notebook: nb.name, includes_git: includesGit, description: desc }),
                });
                if (!r.ok) {
                    const d = await r.json().catch(() => ({}));
                    stat.style.color = 'var(--text-danger,#e74c3c)';
                    stat.textContent = '✗ ' + (d.error || 'Archive failed.');
                    btn.disabled = false;
                    btn.textContent = '↓ Create archive';
                    return;
                }
                const skipped = r.headers.get('X-Nb-Skipped');
                const blob    = await r.blob();
                const cd      = r.headers.get('Content-Disposition') || '';
                const fname   = cd.match(/filename[^;=\n]*=["']?([^"';\n]+)/)?.[1]
                              || `${nb.name}-${new Date().toISOString().slice(0,10)}.nbz`;
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = fname; a.click();
                URL.revokeObjectURL(url);

                stat.style.color = 'var(--green,#2ecc71)';
                stat.textContent = '✓ ' + fname + (skipped ? ` (${skipped.split(',').length} file(s) skipped — too large)` : '');
                btn.textContent  = '↓ Create archive';
                btn.disabled     = false;
            } catch(e) {
                stat.style.color = 'var(--text-danger,#e74c3c)';
                stat.textContent = '✗ ' + e.message;
                btn.disabled = false;
                btn.textContent = '↓ Create archive';
            }
        };

        document.getElementById('nbarch-desc').focus();
    }

    // ── Remove ────────────────────────────────────────────────────────────────

    function _showRemoveForm(nb, wrap, removeBtn, unpushed) {
        if (document.getElementById('nbarch-rm-form')) return;
        removeBtn.disabled = true;

        const form = document.createElement('div');
        form.id = 'nbarch-rm-form';
        form.style.cssText = 'margin-top:10px;font-size:12px';

        const warning = unpushed > 0
            ? `<div style="color:var(--yellow,#f39c12);margin-bottom:8px">` +
              `⚠ <strong>${unpushed} unpushed commit${unpushed !== 1 ? 's' : ''}</strong> will be lost. ` +
              `Archive first if you want to keep them.</div>`
            : `<div style="color:var(--text-dim);margin-bottom:8px">` +
              `This will permanently remove <strong>${_esc(nb.name)}</strong> from this machine.` +
              `</div>`;

        form.innerHTML = warning +
            `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">` +
                `<input id="nbarch-rm-input" class="nb-opt-input" style="flex:1;min-width:100px"` +
                `       placeholder='type &quot;${_esc(nb.name)}&quot; to confirm'>` +
                `<button id="nbarch-rm-ok" class="nb-tool-btn nb-btn-danger">Delete</button>` +
                `<button id="nbarch-rm-cancel" class="nb-tool-btn">Cancel</button>` +
            `</div>` +
            `<div id="nbarch-rm-status" style="margin-top:6px;color:var(--text-danger,#e74c3c)"></div>`;
        wrap.appendChild(form);

        document.getElementById('nbarch-rm-cancel').onclick = () => {
            form.remove();
            removeBtn.disabled = false;
        };

        const input = document.getElementById('nbarch-rm-input');
        const ok    = document.getElementById('nbarch-rm-ok');

        ok.onclick = async () => {
            if (input.value.trim() !== nb.name) {
                input.style.outline = '2px solid var(--text-danger,#e74c3c)';
                setTimeout(() => { input.style.outline = ''; }, 800);
                return;
            }
            ok.disabled = true;
            ok.textContent = 'Deleting…';
            try {
                const r = await fetch('/api/nb/delete-notebook', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ notebook: nb.name, scope: 'local' }),
                });
                const d = await r.json();
                if (d.success) {
                    NbMain.runNbNotebooks();
                } else {
                    document.getElementById('nbarch-rm-status').textContent = d.output || 'Failed.';
                    ok.disabled = false;
                    ok.textContent = 'Delete';
                }
            } catch(e) {
                document.getElementById('nbarch-rm-status').textContent = e.message;
                ok.disabled = false;
                ok.textContent = 'Delete';
            }
        };

        input.focus();
    }

    // ── Import (rendered inline on the plugin page via pluginContent) ─────────

    function _renderImportContent(container) {
        container.style.cssText = 'padding:0 28px 14px;border-top:1px solid var(--border);margin-top:4px';
        container.innerHTML =
            `<div style="font-size:11px;color:var(--text-dim);margin:12px 0 8px;font-weight:600;` +
            `letter-spacing:.05em;text-transform:uppercase">Import archive</div>` +
            `<label id="nbarch-imp-drop" style="display:flex;align-items:center;justify-content:center;` +
            `height:64px;border:2px dashed var(--border);border-radius:6px;cursor:pointer;` +
            `font-size:12px;color:var(--text-dim);transition:border-color .15s;margin-bottom:10px">` +
              `<span id="nbarch-imp-drop-label">Drop .nbz here or click to pick</span>` +
              `<input id="nbarch-imp-file" type="file" accept=".nbz,.zip" style="display:none">` +
            `</label>` +
            `<div id="nbarch-imp-preview" style="display:none;font-size:12px;margin-bottom:8px;` +
            `background:var(--bg-secondary,color-mix(in srgb,var(--border) 50%,var(--bg)));` +
            `border-radius:6px;padding:8px 10px"></div>` +
            `<div id="nbarch-imp-name-row" style="display:none;flex-direction:column;gap:6px;margin-bottom:8px">` +
              `<label style="font-size:11px;color:var(--text-dim)">Import as</label>` +
              `<input id="nbarch-imp-name" class="nb-opt-input">` +
              `<div id="nbarch-imp-conflict" style="font-size:11px;color:var(--yellow,#f39c12);display:none">` +
                `⚠ Name already in use — choose another.` +
              `</div>` +
            `</div>` +
            `<div style="display:flex;gap:6px;align-items:center">` +
              `<button id="nbarch-imp-go" class="nb-tool-btn nb-btn-primary" disabled>Import</button>` +
              `<span id="nbarch-imp-status" style="font-size:12px"></span>` +
            `</div>`;

        let _currentFile = null;
        const drop     = container.querySelector('#nbarch-imp-drop');
        const fileIn   = container.querySelector('#nbarch-imp-file');
        const preview  = container.querySelector('#nbarch-imp-preview');
        const nameRow  = container.querySelector('#nbarch-imp-name-row');
        const nameIn   = container.querySelector('#nbarch-imp-name');
        const conflict = container.querySelector('#nbarch-imp-conflict');
        const goBtn    = container.querySelector('#nbarch-imp-go');
        const status   = container.querySelector('#nbarch-imp-status');
        const dropLbl  = container.querySelector('#nbarch-imp-drop-label');

        drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = 'var(--accent,var(--text))'; });
        drop.addEventListener('dragleave', () => { drop.style.borderColor = ''; });
        drop.addEventListener('drop', e => { e.preventDefault(); drop.style.borderColor = ''; const f = e.dataTransfer.files[0]; if (f) _onFile(f); });
        fileIn.addEventListener('change', () => { if (fileIn.files[0]) _onFile(fileIn.files[0]); });
        nameIn.addEventListener('input', () => { conflict.style.display = 'none'; });

        async function _onFile(file) {
            _currentFile = file;
            dropLbl.textContent   = file.name;
            preview.style.display = 'none';
            nameRow.style.display = 'none';
            goBtn.disabled        = true;
            status.style.color    = 'var(--text-dim)';
            status.textContent    = 'Reading…';
            const fd = new FormData();
            fd.append('archive', file);
            try {
                const r = await fetch('/api/nb/import-preview', { method: 'POST', body: fd });
                const d = await r.json();
                if (!d.ok) { status.style.color = 'var(--text-danger,#e74c3c)'; status.textContent = '✗ ' + d.error; return; }
                status.textContent = '';
                const m = d.meta, date = (m.archived_at || '').slice(0, 10);
                preview.style.display = 'block';
                preview.innerHTML =
                    `<div style="font-weight:600;margin-bottom:2px">${_esc(m.name)}</div>` +
                    `<div style="color:var(--text-dim)">` +
                        (m.note_count != null ? `${m.note_count} notes` : '') +
                        (date ? ` · ${_esc(date)}` : '') +
                        (m.includes_git ? ' · git history' : '') +
                    `</div>` +
                    (m.description ? `<div style="margin-top:4px;font-style:italic">${_esc(m.description)}</div>` : '');
                nameRow.style.display  = 'flex';
                nameIn.value           = d.suggested;
                conflict.style.display = d.conflict ? 'block' : 'none';
                goBtn.disabled         = false;
            } catch(e) {
                status.style.color = 'var(--text-danger,#e74c3c)';
                status.textContent = '✗ ' + e.message;
            }
        }

        goBtn.onclick = async () => {
            if (!_currentFile) return;
            const name = nameIn.value.trim();
            if (!name) { nameIn.focus(); return; }
            goBtn.disabled = true; goBtn.textContent = 'Importing…'; status.textContent = '';
            const fd = new FormData();
            fd.append('archive', _currentFile);
            fd.append('name', name);
            try {
                const r = await fetch('/api/nb/import', { method: 'POST', body: fd });
                const d = await r.json();
                if (d.ok) {
                    status.style.color = 'var(--green,#2ecc71)';
                    status.textContent = `✓ Imported "${_esc(d.notebook)}" (${d.note_count} notes)`;
                    goBtn.textContent  = 'Import';
                    setTimeout(() => NbMain.runNbNotebooks(), 1200);
                } else if (d.conflict) {
                    conflict.style.display = 'block';
                    goBtn.disabled = false; goBtn.textContent = 'Import';
                } else {
                    status.style.color = 'var(--text-danger,#e74c3c)';
                    status.textContent = '✗ ' + (d.error || 'Import failed.');
                    goBtn.disabled = false; goBtn.textContent = 'Import';
                }
            } catch(e) {
                status.style.color = 'var(--text-danger,#e74c3c)';
                status.textContent = '✗ ' + e.message;
                goBtn.disabled = false; goBtn.textContent = 'Import';
            }
        };
    }

    // ── Plugin registration ───────────────────────────────────────────────────

    NbWeb.registerModule('archive', {

        label:       'NbWeb-archive',
        description: 'Archive notebooks to .nbz for backup or transfer, and remove them safely',
        helpUrl:     '/plugins/nbweb-archive.md',

        pluginContent: _renderImportContent,

        notebookSection: (nb) => {
            return {
                label:   'Archive',
                rows:    [],
                actions: [
                    {
                        id:    'nbarch-archive-btn',
                        icon:  '↓',
                        label: 'Archive notebook',
                        fn:    (nbObj, btn) => _showArchiveForm(nbObj, btn.parentElement.parentElement, btn),
                    },
                ],
            };
        },

    });

})();

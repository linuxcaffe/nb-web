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

    // ── Plugin registration ───────────────────────────────────────────────────

    NbWeb.registerModule('archive', {

        label:       'NbWeb-archive',
        description: 'Archive notebooks to .nbz for backup or transfer, and remove them safely',
        helpUrl:     '/plugins/nbweb-archive.md',

        notebookSection: (nb) => {
            const unpushed = nb.git?.unpushed ?? 0;
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
                    {
                        id:    'nbarch-remove-btn',
                        icon:  '🗑',
                        label: 'Remove notebook',
                        fn:    (nbObj, btn) => _showRemoveForm(nbObj, btn.parentElement.parentElement, btn, unpushed),
                    },
                ],
            };
        },

    });

})();

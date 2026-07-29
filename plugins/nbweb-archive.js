// NbWeb-archive — notebook archive (.nbz) and safe removal
// @name     NbWeb Archive
// @version  0.1.0
// @type     bundled
// @homepage
(() => {

    const _esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    const _chk = (id, label, checked=true) =>
        `<label style="display:flex;gap:8px;align-items:center;cursor:pointer">` +
        `<input type="checkbox" id="${id}"${checked ? ' checked' : ''}> ${label}</label>`;

    // ── Archive ───────────────────────────────────────────────────────────────

    function _showArchiveForm(nb, wrap, archiveBtn) {
        if (document.getElementById('nbarch-form')) return;
        archiveBtn.disabled = true;

        const form = document.createElement('div');
        form.id = 'nbarch-form';
        form.style.cssText = 'margin-top:10px;display:flex;flex-direction:column;gap:8px;font-size:12px';
        form.innerHTML =
            `<div style="display:flex;align-items:center;gap:8px">` +
                _chk('nbarch-git', 'Include git history', false) +
            `</div>` +
            `<input id="nbarch-desc" class="nb-opt-input" placeholder="Description (optional)" style="margin-top:2px">` +
            `<div style="display:flex;align-items:center;gap:8px;margin-top:2px">` +
                _chk('nbarch-encrypt', 'Encrypt', false) +
            `</div>` +
            `<div id="nbarch-pw-wrap" hidden style="display:flex;flex-direction:column;gap:4px">` +
                `<input id="nbarch-pw1"  type="password" class="nb-opt-input" placeholder="Password">` +
                `<input id="nbarch-pw2"  type="password" class="nb-opt-input" placeholder="Confirm password">` +
                `<div id="nbarch-pw-err" style="color:var(--text-danger,#e74c3c);font-size:11px;display:none">Passwords don't match — try again.</div>` +
            `</div>` +
            `<div style="display:flex;gap:6px">` +
                `<button id="nbarch-go" class="nb-tool-btn nb-btn-primary">↓ Create archive</button>` +
                `<button id="nbarch-cancel" class="nb-tool-btn">Cancel</button>` +
            `</div>` +
            `<div id="nbarch-status" style="color:var(--text-dim)"></div>`;
        wrap.appendChild(form);

        form.querySelector('#nbarch-cancel').onclick = () => {
            form.remove();
            archiveBtn.disabled = false;
        };

        const encCb   = form.querySelector('#nbarch-encrypt');
        const pwWrap  = form.querySelector('#nbarch-pw-wrap');
        const pw1     = form.querySelector('#nbarch-pw1');
        const pw2     = form.querySelector('#nbarch-pw2');
        const pwErr   = form.querySelector('#nbarch-pw-err');
        encCb.onchange = () => {
            pwWrap.hidden = !encCb.checked;
            if (encCb.checked) { pw1.focus(); pwErr.style.display = 'none'; }
            else { pw1.value = ''; pw2.value = ''; }
        };
        pw2.addEventListener('input', () => { pwErr.style.display = 'none'; });

        form.querySelector('#nbarch-go').onclick = async () => {
            const btn  = form.querySelector('#nbarch-go');
            const stat = form.querySelector('#nbarch-status');

            if (encCb.checked) {
                if (!pw1.value) { pw1.focus(); return; }
                if (pw1.value !== pw2.value) {
                    pwErr.style.display = 'block';
                    pw2.value = ''; pw2.focus();
                    return;
                }
            }

            btn.disabled = true;
            btn.textContent = 'Archiving…';
            stat.textContent = '';

            try {
                const r = await fetch('/api/nb/archive', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({
                        notebook:     nb.name,
                        includes_git: form.querySelector('#nbarch-git').checked,
                        description:  form.querySelector('#nbarch-desc').value.trim(),
                        password:     encCb.checked ? pw1.value : '',
                    }),
                });
                if (!r.ok) {
                    const d = await r.json().catch(() => ({}));
                    stat.style.color = 'var(--text-danger,#e74c3c)';
                    stat.textContent = '✗ ' + (d.error || 'Archive failed.');
                    btn.disabled = false; btn.textContent = '↓ Create archive';
                    return;
                }
                const skipped = r.headers.get('X-Nb-Skipped');
                const blob    = await r.blob();
                const cd      = r.headers.get('Content-Disposition') || '';
                const fname   = cd.match(/filename[^;=\n]*=["']?([^"';\n]+)/)?.[1]
                              || `${nb.name}-${new Date().toISOString().slice(0,10)}.nbz`;
                const a = Object.assign(document.createElement('a'), {href: URL.createObjectURL(blob), download: fname});
                a.click(); URL.revokeObjectURL(a.href);

                stat.style.color = 'var(--green,#2ecc71)';
                stat.textContent = '✓ ' + fname + (skipped ? ` (${skipped.split(',').length} file(s) skipped — too large)` : '');
                btn.textContent = '↓ Create archive'; btn.disabled = false;
            } catch(e) {
                stat.style.color = 'var(--text-danger,#e74c3c)';
                stat.textContent = '✗ ' + e.message;
                btn.disabled = false; btn.textContent = '↓ Create archive';
            }
        };

        form.querySelector('#nbarch-desc').focus();
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

    // Import UI moved to Settings → Archive section.

    // ── Plugin registration ───────────────────────────────────────────────────
    // (Import UI lives in Settings → Archive; stub kept so pluginContent renders a pointer)

    function _renderImportContent(container) {
        container.style.cssText = 'padding:8px 28px 14px;border-top:1px solid var(--border)';
        container.innerHTML =
            `<div style="font-size:12px;color:var(--text-dim);padding-top:8px">` +
            `Import .nbz archives in <strong>Settings → Archive</strong>.</div>`;
    }

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

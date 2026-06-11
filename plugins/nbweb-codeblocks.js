// NbWeb-codeblocks — live fenced code block renderers for nb-web
// Provides: tw (Taskwarrior), hledger, t (timeclock), nb, git block types.
// Global plugin — no detect(), active for all notebooks.
(() => {

    // ── Utilities ─────────────────────────────────────────────────────────────

    const _esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    function _localDateStr(daysAhead = 0) {
        const d = new Date(Date.now() + daysAhead * 86400000);
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }

    // ── Shared codeblock infrastructure ──────────────────────────────────────

    // Attach a codeblock form: floats as fixed popover when block is collapsed,
    // inserts inline otherwise. Returns a dismiss function that cleans up both.
    function _cbFormAttach(form, trigger, el, inlineInsertFn) {
        let outside;
        const dismiss = () => {
            form.remove();
            trigger._cbForm = null;
            trigger.classList.remove('active', 'nb-hl-btn-active');
            if (outside) document.removeEventListener('click', outside, true);
        };
        if (el.classList.contains('nb-collapsed')) {
            const rect = trigger.getBoundingClientRect();
            form.style.cssText =
                `position:fixed;z-index:9000;top:${rect.bottom+4}px;right:${window.innerWidth-rect.right}px;` +
                `background:var(--bg2,#22272e);border:1px solid var(--border);border-radius:6px;` +
                `padding:10px;box-shadow:0 4px 20px rgba(0,0,0,.5);min-width:340px`;
            document.body.appendChild(form);
            trigger._cbForm = form;
            outside = e => { if (!form.contains(e.target) && e.target !== trigger) dismiss(); };
            setTimeout(() => document.addEventListener('click', outside, true), 0);
        } else {
            inlineInsertFn(form);
        }
        return dismiss;
    }

    function _collapseKey(block) {
        const cls = [...block.classList].find(c => c.endsWith('-block')) || 'block';
        const id  = block.dataset.cmd || block.dataset.query || block.dataset.period || '';
        return `nb-collapse:${cls}:${id}`;
    }

    function _initCollapseToggle(block) {
        const header = block.querySelector('[class*="-header"]');
        if (!header || header.querySelector('.nb-collapse-btn')) return;
        const key = _collapseKey(block);
        const btn = document.createElement('button');
        btn.className = 'nb-collapse-btn';
        btn.setAttribute('aria-label', 'Toggle collapse');
        header.insertBefore(btn, header.firstChild);
        const apply = collapsed => {
            block.classList.toggle('nb-collapsed', collapsed);
            btn.textContent = collapsed ? '▶' : '▼';
        };
        apply(localStorage.getItem(key) === '1');
        const toggle = e => {
            e.stopPropagation();
            const collapsed = !block.classList.contains('nb-collapsed');
            apply(collapsed);
            collapsed ? localStorage.setItem(key, '1') : localStorage.removeItem(key);
        };
        btn.addEventListener('click', toggle);
        header.querySelectorAll('.nb-collapse-zone').forEach(z =>
            z.addEventListener('click', toggle));
    }

    // ── t timeclock ───────────────────────────────────────────────────────────

    const _tTimers = new Map();

    function _fmtSeconds(s) {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
    }

    async function _loadTBlock(el) {
        const id = _tTimers.get(el);
        if (id) { clearInterval(id); _tTimers.delete(el); }
        el.classList.remove('nb-collapsed');
        el.innerHTML = '<span class="nb-spin">⟳</span>';
        const period = el.dataset.period || 'today';
        try {
            const [status, report] = await Promise.all([
                fetch('/api/t/status').then(r => r.json()),
                period
                    ? fetch(`/api/t/report?period=${encodeURIComponent(period)}`).then(r => r.json())
                    : Promise.resolve(null),
            ]);
            _buildTBlock(el, status, report, period);
        } catch(e) {
            el.innerHTML = `<span class="nb-t-error">⚠ ${_esc(e.message)}</span>`;
        }
        _initCollapseToggle(el);
    }

    function _buildTBlock(el, status, report, period) {
        el.innerHTML = '';

        const hdr = document.createElement('div');
        hdr.className = 'nb-t-header';

        const statusEl = document.createElement('div');
        statusEl.className = 'nb-t-status';

        if (status.state === 'in') {
            const elapsed = status.elapsed_seconds || 0;
            statusEl.innerHTML =
                `<span class="nb-t-dot nb-t-dot-in">⏱</span>` +
                `<span class="nb-t-account">${_esc(status.account)}</span>` +
                (status.desc ? `<span class="nb-t-desc">${_esc(status.desc)}</span>` : '') +
                `<span class="nb-t-elapsed" data-start="${Date.now() - elapsed * 1000}">${_fmtSeconds(elapsed)}</span>`;
        } else if (status.state === 'out') {
            statusEl.innerHTML =
                `<span class="nb-t-dot nb-t-dot-out">◌</span>` +
                `<span class="nb-t-out-label">OUT</span>` +
                `<span class="nb-t-desc">${_esc(status.account)} · ${_esc(status.last_out)}</span>`;
        } else {
            statusEl.innerHTML = `<span class="nb-t-dot nb-t-dot-out">○</span><span class="nb-t-desc">No entries</span>`;
        }

        const acts = document.createElement('div');
        acts.className = 'nb-t-actions';

        if (status.state === 'in') {
            const outBtn = document.createElement('button');
            outBtn.className = 'nb-tw-btn nb-t-btn nb-t-out-btn';
            outBtn.title = 'Clock out';
            outBtn.textContent = '◼ Out';
            outBtn.addEventListener('click', async () => {
                outBtn.disabled = true;
                const d = await fetch('/api/t/out', { method: 'POST' }).then(r => r.json()).catch(() => ({}));
                if (d.success) _loadTBlock(el); else outBtn.disabled = false;
            });
            acts.appendChild(outBtn);
        } else {
            const inBtn = document.createElement('button');
            inBtn.className = 'nb-tw-btn nb-t-btn nb-t-in-btn';
            inBtn.title = 'Clock in';
            inBtn.textContent = '⏱ In';
            inBtn.addEventListener('click', () => _showTClockInForm(el, status, inBtn));
            acts.appendChild(inBtn);
        }

        const refBtn = document.createElement('button');
        refBtn.className = 'nb-tw-btn nb-t-btn';
        refBtn.title = 'Refresh';
        refBtn.textContent = '↻';
        refBtn.addEventListener('click', () => _loadTBlock(el));
        acts.appendChild(refBtn);

        hdr.append(statusEl, acts);
        el.appendChild(hdr);

        if (report?.rows?.length) {
            const rpt = document.createElement('div');
            rpt.className = 'nb-t-report';
            report.rows.forEach(row => {
                const r = document.createElement('div');
                r.className = 'nb-t-row';
                r.innerHTML = `<span class="nb-t-r-acct">${_esc(row.account)}</span><span class="nb-t-r-time">${_fmtSeconds(row.seconds)}</span>`;
                rpt.appendChild(r);
            });
            const tot = document.createElement('div');
            tot.className = 'nb-t-row nb-t-total';
            tot.innerHTML = `<span class="nb-t-r-acct">${period || 'today'} total</span><span class="nb-t-r-time">${_fmtSeconds(report.total_seconds)}</span>`;
            rpt.appendChild(tot);
            el.appendChild(rpt);
        }

        if (status.state === 'in') {
            const startMs = Date.now() - (status.elapsed_seconds || 0) * 1000;
            const tid = setInterval(() => {
                const elapsedEl = el.querySelector('.nb-t-elapsed');
                if (!elapsedEl || !el.isConnected) { clearInterval(tid); _tTimers.delete(el); return; }
                elapsedEl.textContent = _fmtSeconds(Math.floor((Date.now() - startMs) / 1000));
            }, 30000);
            _tTimers.set(el, tid);
        }
    }

    async function _showTClockInForm(el, status, trigger) {
        const existing = trigger._cbForm || el.querySelector('.nb-t-clock-in-form');
        if (existing) { existing.remove(); trigger._cbForm = null; trigger?.classList.remove('active'); return; }
        trigger?.classList.add('active');

        const accounts = await fetch('/api/t/accounts').then(r => r.json()).then(d => d.accounts || []).catch(() => []);

        const form = document.createElement('div');
        form.className = 'nb-t-clock-in-form';

        const sel = document.createElement('select');
        sel.className = 'nb-t-acct-sel';
        if (!accounts.length) {
            const opt = document.createElement('option');
            opt.value = ''; opt.textContent = 'No recent accounts'; sel.appendChild(opt);
        } else {
            accounts.forEach(a => {
                const opt = document.createElement('option');
                opt.value = a; opt.textContent = a; sel.appendChild(opt);
            });
        }
        if (status.account) {
            const match = [...sel.options].find(o => o.value === status.account);
            if (match) match.selected = true;
        }

        const customInput = document.createElement('input');
        customInput.type = 'text'; customInput.className = 'nb-rename-input nb-t-custom-acct';
        customInput.placeholder = 'or type account…'; customInput.style.flex = '1';

        const descInput = document.createElement('input');
        descInput.type = 'text'; descInput.className = 'nb-rename-input';
        descInput.placeholder = 'description (optional)'; descInput.style.flex = '1.5';

        const goBtn = document.createElement('button');
        goBtn.className = 'nb-tw-btn nb-t-btn nb-btn-primary';
        goBtn.textContent = '⏱ In';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'nb-tw-btn nb-t-btn';
        cancelBtn.textContent = '✕';

        form.append(sel, customInput, descInput, goBtn, cancelBtn);

        const doClockIn = async () => {
            const account = customInput.value.trim() || sel.value;
            if (!account) { customInput.focus(); return; }
            goBtn.disabled = true;
            const d = await fetch('/api/t/in', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ account, desc: descInput.value.trim() }),
            }).then(r => r.json()).catch(() => ({}));
            if (d.success) { dismiss(); _loadTBlock(el); }
            else { goBtn.disabled = false; if (d.error) alert(d.error); }
        };

        const dismiss = _cbFormAttach(form, trigger, el, f => el.appendChild(f));

        goBtn.addEventListener('click', doClockIn);
        [customInput, descInput].forEach(i => i.addEventListener('keydown', e => {
            if (e.key === 'Enter')  doClockIn();
            if (e.key === 'Escape') dismiss();
        }));
        cancelBtn.addEventListener('click', dismiss);
        customInput.focus();
    }

    // ── tw Taskwarrior ────────────────────────────────────────────────────────

    async function _loadTwBlock(el) {
        const rawQ     = el.dataset.query || '';
        const colMatch = rawQ.match(/\bcolumns:(\S+)/i);
        const colSpec  = colMatch ? colMatch[1].split(',').map(s => s.trim().toLowerCase()) : null;
        const q        = rawQ.replace(/\bcolumns:\S+/gi, '').trim();
        el.classList.remove('nb-collapsed');
        el.innerHTML = '<span class="nb-spin">⟳</span>';
        try {
            const r = await fetch(`/api/task-query?q=${encodeURIComponent(q)}`);
            const d = await r.json();
            if (d.error) { el.innerHTML = `<span class="nb-tw-error">⚠ ${_esc(d.error)}</span>`; return; }
            const twLaunch = d.twTerminalMode ? {terminal: true, cmd: d.twLaunchCmd}
                           : d.twWebUrl      ? {url: d.twWebUrl}
                           : null;
            _buildTwTable(el, (d.tasks || []).sort((a, b) => (b.urgency || 0) - (a.urgency || 0)), q, colSpec, twLaunch);
        } catch(e) {
            el.innerHTML = `<span class="nb-tw-error">⚠ ${_esc(e.message)}</span>`;
        }
        _initCollapseToggle(el);
    }

    function _buildTwTable(el, tasks, q, colSpec, launch) {
        const todayYmd = _localDateStr().replace(/-/g,'');
        const soonYmd  = _localDateStr(3).replace(/-/g,'');
        const fmtDate  = s => s ? s.replace(/^(\d{4})(\d{2})(\d{2}).*/, '$1-$2-$3') : '';
        const priLabel = { H: '▲', M: '●', L: '▽' };
        const priCls   = { H: 'nb-tw-pri-h', M: 'nb-tw-pri-m', L: 'nb-tw-pri-l' };
        const priDisplay = p => p ? (priLabel[p] || _esc(String(p))) : '';

        const has = colSpec
            ? {
                project:  colSpec.some(c => ['proj','project'].includes(c)),
                priority: colSpec.some(c => ['pri','priority'].includes(c)),
                due:      colSpec.includes('due'),
                tags:     colSpec.includes('tags'),
              }
            : {
                project:  tasks.some(t => t.project),
                priority: tasks.some(t => t.priority),
                due:      tasks.some(t => t.due),
                tags:     tasks.some(t => t.tags?.length),
              };

        const colspan = 4 + (has.project ? 1 : 0) + (has.priority ? 1 : 0) + (has.due ? 1 : 0) + (has.tags ? 1 : 0);

        const rowUrgencyCls = t => {
            if (t.start) return 'nb-tw-row-started';
            const due = t.due ? t.due.slice(0,8) : '';
            if (due && due < todayYmd) return 'nb-tw-row-overdue';
            if (due && due <= soonYmd)  return 'nb-tw-row-soon';
            if ((t.urgency || 0) >= 10) return 'nb-tw-row-urgent';
            return '';
        };

        el.innerHTML = '';
        const hdr = document.createElement('div');
        hdr.className = 'nb-tw-header';
        const filterHtml = q ? ` <code>${_esc(q)}</code>` : '';
        const twTitle = !launch         ? 'Configure launch in Settings → Codeblocks'
                      : launch.terminal ? 'Run in terminal'
                      :                   'Open in tw-web';
        hdr.innerHTML = `<span class="nb-tw-meta"><span class="nb-tw-name" title="${twTitle}">task</span><span class="nb-tw-count">${tasks.length}</span>${filterHtml}</span>`;
        const twNameEl = hdr.querySelector('.nb-tw-name');
        twNameEl.addEventListener('click', async () => {
            if (!launch) { NbTerminal.openSettings('sec-codeblocks'); return; }
            if (launch.terminal) { NbTerminal.run(launch.cmd); return; }
            twNameEl.classList.add('nb-tw-name-launching');
            try {
                const d = await fetch('/api/tw/launch', {method: 'POST'}).then(r => r.json());
                if (d.url) window.open(d.url, 'tw-web');
            } catch(e) { console.error('tw launch:', e); }
            finally { twNameEl.classList.remove('nb-tw-name-launching'); }
        });

        const acts = document.createElement('span');
        acts.className = 'nb-tw-header-acts';

        const addBtn = document.createElement('button');
        addBtn.className = 'nb-tw-btn nb-tw-add-btn';
        addBtn.title = 'Add task'; addBtn.textContent = '+';
        addBtn.addEventListener('click', () => _showTwAddForm(el, q, addBtn));
        acts.appendChild(addBtn);

        const refBtn = document.createElement('button');
        refBtn.className = 'nb-tw-btn nb-tw-refresh';
        refBtn.title = 'Refresh'; refBtn.textContent = '↻';
        refBtn.addEventListener('click', () => _loadTwBlock(el));
        acts.appendChild(refBtn);

        hdr.appendChild(acts);
        el.appendChild(hdr);

        if (!tasks.length) return;

        const rows = tasks.map(t => {
            const due = t.due ? t.due.slice(0,8) : '';
            const dueCls = due && due < todayYmd ? ' nb-tw-overdue' : due && due <= soonYmd ? ' nb-tw-soon' : '';
            const isPending = !t.status || t.status === 'pending';
            const statusGlyph = t.status === 'completed' ? '✓' : t.status === 'deleted' ? '✗' : '';
            const idLabel = isPending ? (t.id || '') : statusGlyph;
            return `<tr class="${rowUrgencyCls(t)}" data-uuid="${_esc(t.uuid || '')}">
                <td class="nb-tw-act">${isPending ? `<button class="nb-tw-btn nb-tw-done-btn" title="Mark done">✓</button>` : ''}</td>
                <td class="nb-tw-id"><button class="nb-tw-btn nb-tw-id-btn${isPending ? '' : ' nb-tw-id-status'}" title="Show info">${idLabel}</button></td>
                <td class="nb-tw-desc">${_esc(t.description || '')}</td>
                ${has.project  ? `<td class="nb-tw-proj">${_esc(t.project || '')}</td>` : ''}
                ${has.priority ? `<td class="nb-tw-pri ${priCls[t.priority] || ''}">${priDisplay(t.priority)}</td>` : ''}
                ${has.due      ? `<td class="nb-tw-due${dueCls}">${fmtDate(t.due)}</td>` : ''}
                ${has.tags     ? `<td class="nb-tw-tags">${(t.tags || []).map(g => `<span class="nb-tw-tag">${_esc(g)}</span>`).join('')}</td>` : ''}
                <td class="nb-tw-act">${isPending ? `<button class="nb-tw-btn nb-tw-toggle-btn" data-started="${!!t.start}" title="${t.start ? 'Stop' : 'Start'}">${t.start ? '◼' : '▶'}</button>` : ''}</td>
            </tr>`;
        }).join('');

        const tbl = document.createElement('table');
        tbl.className = 'nb-tw-table';
        tbl.innerHTML = `
            <thead><tr>
                <th></th><th>ID</th><th>Description</th>
                ${has.project  ? '<th>Project</th>'  : ''}
                ${has.priority ? '<th>Pri</th>'      : ''}
                ${has.due      ? '<th>Due</th>'      : ''}
                ${has.tags     ? '<th>Tags</th>'     : ''}
                <th></th>
            </tr></thead>
            <tbody>${rows}</tbody>`;
        el.appendChild(tbl);

        el.querySelectorAll('.nb-tw-id-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const tr  = btn.closest('tr');
                const uuid = tr?.dataset.uuid;
                if (!uuid) return;

                const openBtn    = el.querySelector('.nb-tw-id-btn[data-open]');
                const openDetail = el.querySelector('.nb-tw-detail-row');
                if (openDetail) openDetail.remove();
                if (openBtn)    openBtn.removeAttribute('data-open');
                if (openBtn === btn) return;

                btn.setAttribute('data-open', '1');
                const detailTr = document.createElement('tr');
                detailTr.className = 'nb-tw-detail-row';
                detailTr.innerHTML = `<td colspan="${colspan}"><pre class="nb-tw-detail-pre">Loading…</pre></td>`;
                tr.insertAdjacentElement('afterend', detailTr);

                if (!btn._infoCache) {
                    try {
                        const d = await fetch(`/api/task-info?uuid=${encodeURIComponent(uuid)}`).then(r => r.json());
                        btn._infoCache = _twInfoTrunc(d.output || '');
                    } catch(e) { btn._infoCache = '⚠ ' + e.message; }
                }
                detailTr.querySelector('.nb-tw-detail-pre').textContent = btn._infoCache;
            });
        });

        el.querySelectorAll('.nb-tw-done-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const tr = btn.closest('tr');
                const uuid = tr?.dataset.uuid;
                if (!uuid) return;
                btn.disabled = true;
                const d = await fetch('/api/task-action', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({uuid, action: 'done'}),
                }).then(r => r.json());
                if (d.success) {
                    tr.nextElementSibling?.classList.contains('nb-tw-detail-row') && tr.nextElementSibling.remove();
                    tr.classList.add('nb-tw-row-done');
                    setTimeout(() => {
                        tr.remove();
                        const remaining = el.querySelectorAll('tbody tr:not(.nb-tw-detail-row)').length;
                        const countEl = el.querySelector('.nb-tw-count');
                        if (countEl) countEl.textContent = remaining;
                        if (!remaining) el.querySelector('tbody').innerHTML =
                            `<tr><td colspan="${colspan}" class="nb-tw-all-done">✓ All done!</td></tr>`;
                    }, 380);
                } else { btn.disabled = false; }
            });
        });

        el.querySelectorAll('.nb-tw-toggle-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const tr = btn.closest('tr');
                const uuid = tr?.dataset.uuid;
                if (!uuid) return;
                const isStarted = btn.dataset.started === 'true';
                btn.disabled = true;
                const d = await fetch('/api/task-action', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({uuid, action: isStarted ? 'stop' : 'start'}),
                }).then(r => r.json());
                if (d.success) _loadTwBlock(el);
                else btn.disabled = false;
            });
        });
    }

    function _twInfoTrunc(text) {
        const lines = text.split('\n');
        let dashes = 0;
        for (let i = 0; i < lines.length; i++) {
            if (/^-{5,}/.test(lines[i]) && ++dashes >= 2)
                return lines.slice(0, i).join('\n').trimEnd();
        }
        return text.trimEnd();
    }

    function _showTwAddForm(el, q, trigger) {
        const existing = trigger._cbForm || el.querySelector('.nb-tw-addform');
        if (existing) { existing.remove(); trigger._cbForm = null; trigger?.classList.remove('active'); return; }
        trigger?.classList.add('active');

        const form = document.createElement('div');
        form.className = 'nb-tw-addform';
        form.innerHTML = `
            <input type="text" class="nb-tw-inp nb-tw-adesc" placeholder="Description" autocomplete="off">
            <div class="nb-tw-addform-row">
                <input type="text" class="nb-tw-inp nb-tw-aproj" placeholder="project">
                <select class="nb-tw-inp nb-tw-adtype">
                    <option value="due">due:</option>
                    <option value="scheduled">sched:</option>
                    <option value="wait">wait:</option>
                    <option value="until">until:</option>
                </select>
                <input type="text" class="nb-tw-inp nb-tw-adval" placeholder="tomorrow">
                <button type="button" class="nb-tw-btn nb-tw-datepick" title="Pick date">📅</button>
                <input type="date" class="nb-tw-datepick-hidden" tabindex="-1">
                <input type="text" class="nb-tw-inp nb-tw-apri" placeholder="priority">
            </div>
            <div class="nb-tw-addform-row">
                <input type="text" class="nb-tw-inp nb-tw-atags" placeholder="tag1, tag2">
                <button class="nb-btn-primary nb-tw-asave">Add</button>
                <button class="nb-tw-btn nb-tw-acancel">Cancel</button>
                <span class="nb-tw-form-status"></span>
            </div>`;

        const dateValInput = form.querySelector('.nb-tw-adval');
        const datePicker   = form.querySelector('.nb-tw-datepick-hidden');
        form.querySelector('.nb-tw-datepick').addEventListener('click', () =>
            datePicker.showPicker ? datePicker.showPicker() : datePicker.click());
        datePicker.addEventListener('change', () => { dateValInput.value = datePicker.value; });

        const doAdd = async () => {
            const desc = form.querySelector('.nb-tw-adesc').value.trim();
            if (!desc) { form.querySelector('.nb-tw-adesc').focus(); return; }
            const status = form.querySelector('.nb-tw-form-status');
            status.textContent = 'Saving…'; status.style.color = '';
            try {
                const d = await fetch('/api/task-add', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        description: desc,
                        project:    form.querySelector('.nb-tw-aproj').value.trim(),
                        date_field: form.querySelector('.nb-tw-adtype').value,
                        date_value: dateValInput.value.trim(),
                        priority:   form.querySelector('.nb-tw-apri').value.trim(),
                        tags:       form.querySelector('.nb-tw-atags').value.trim(),
                    }),
                }).then(r => r.json());
                if (!d.success) {
                    status.textContent = '✗ ' + (d.error || d.stderr || 'failed');
                    status.style.color = 'var(--red, #ef4444)';
                } else {
                    dismiss();
                    await _loadTwBlock(el);
                }
            } catch(e) {
                status.textContent = '✗ ' + e.message;
                status.style.color = 'var(--red, #ef4444)';
            }
        };

        const dismiss = _cbFormAttach(form, trigger, el,
            f => el.querySelector('.nb-tw-header').insertAdjacentElement('afterend', f));

        form.querySelector('.nb-tw-adesc').addEventListener('keydown', e => {
            if (e.key === 'Enter')  doAdd();
            if (e.key === 'Escape') dismiss();
        });
        form.querySelector('.nb-tw-asave').addEventListener('click', doAdd);
        form.querySelector('.nb-tw-acancel').addEventListener('click', dismiss);
        form.querySelector('.nb-tw-adesc')?.focus();
    }

    // ── nb ────────────────────────────────────────────────────────────────────

    async function _loadNbBlock(el) {
        const parts = (el.dataset.cmd || '').trim().split(/\s+/);
        const cmd   = parts[0];
        const limit = parseInt(parts[1]) || 20;
        el.classList.remove('nb-collapsed');
        if (cmd === 'notebooks') {
            el.innerHTML = '<span class="nb-spin">⟳</span>';
            try {
                const d = await fetch('/api/nb/notebooks').then(r => r.json());
                _buildNbNotebooks(el, d.notebooks || []);
            } catch(e) {
                el.innerHTML = `<span class="nb-nb-error">⚠ ${_esc(e.message)}</span>`;
            }
        } else if (cmd === 'backlinks') {
            const title    = document.getElementById('nb-preview-title')?.textContent?.trim() || '';
            const selector = NbMain.activeSelector() || '';
            if (!title) { el.innerHTML = '<span class="nb-nb-empty">No note open</span>'; return; }
            el.innerHTML = '<span class="nb-spin">⟳</span>';
            try {
                const d = await fetch(
                    `/api/nb/backlinks?title=${encodeURIComponent(title)}&selector=${encodeURIComponent(selector)}&limit=${limit}`
                ).then(r => r.json());
                _buildNbBacklinks(el, d.backlinks || [], title, limit);
            } catch(e) {
                el.innerHTML = `<span class="nb-nb-error">⚠ ${_esc(e.message)}</span>`;
            }
        } else {
            el.innerHTML = `<span class="nb-nb-error">unknown nb command: ${_esc(cmd)}</span>`;
        }
        _initCollapseToggle(el);
    }

    function _buildNbBacklinks(el, backlinks, title, limit = 20) {
        el.innerHTML = '';
        const hdr = document.createElement('div');
        hdr.className = 'nb-nb-header';
        const countHint = backlinks.length === limit ? `top ${limit}` : backlinks.length;
        hdr.innerHTML = `<span class="nb-nb-meta"><span class="nb-nb-name">nb</span> backlinks · <code>${_esc(title)}</code> <span class="nb-nb-count">${countHint}</span></span>`;

        const refBtn = document.createElement('button');
        refBtn.className = 'nb-tw-btn';
        refBtn.title = 'Refresh'; refBtn.textContent = '↻';
        refBtn.addEventListener('click', () => _loadNbBlock(el));
        hdr.appendChild(refBtn);
        el.appendChild(hdr);

        if (!backlinks.length) {
            el.insertAdjacentHTML('beforeend', '<div class="nb-nb-empty">No backlinks found</div>');
            return;
        }

        const list = document.createElement('ul');
        list.className = 'nb-nb-list';
        backlinks.forEach(b => {
            const li   = document.createElement('li');
            li.className = 'nb-nb-item';
            if (b.notebook) {
                const nb = document.createElement('span');
                nb.className = 'nb-nb-notebook';
                nb.textContent = b.notebook;
                li.appendChild(nb);
            }
            const btn = document.createElement('button');
            btn.className = 'nb-nb-link';
            btn.textContent = b.title || b.selector;
            btn.addEventListener('click', () => NbMain.openNote(b.selector));
            li.appendChild(btn);
            list.appendChild(li);
        });
        el.appendChild(list);
    }

    function _buildNbNotebooks(el, notebooks) {
        el.innerHTML = '';
        const hdr = document.createElement('div');
        hdr.className = 'nb-nb-header';
        const refBtn = document.createElement('button');
        refBtn.className = 'nb-tw-btn'; refBtn.title = 'Refresh'; refBtn.textContent = '↻';
        refBtn.addEventListener('click', () => _loadNbBlock(el));
        hdr.innerHTML = `<span class="nb-nb-meta"><span class="nb-nb-name">nb</span> notebooks <span class="nb-nb-count">${notebooks.length}</span></span>`;
        hdr.appendChild(refBtn);
        el.appendChild(hdr);

        if (!notebooks.length) {
            el.insertAdjacentHTML('beforeend', '<div class="nb-nb-empty">No notebooks found</div>');
            return;
        }

        const activeNb = NbNav.notebook === '_all' ? null : NbNav.notebook;
        const now = Date.now() / 1000;
        function _relTime(mtime) {
            const s = now - mtime;
            if (s < 120)       return 'just now';
            if (s < 3600)      return `${Math.floor(s/60)}m ago`;
            if (s < 86400)     return `${Math.floor(s/3600)}h ago`;
            if (s < 86400*30)  return `${Math.floor(s/86400)}d ago`;
            if (s < 86400*365) return `${Math.floor(s/86400/30)}mo ago`;
            return `${Math.floor(s/86400/365)}y ago`;
        }

        const list = document.createElement('ul');
        list.className = 'nb-nb-list';
        notebooks.forEach(nb => {
            const li = document.createElement('li');
            li.className = 'nb-nb-item nb-nb-nb-item' + (nb.name === activeNb ? ' nb-nb-nb-active' : '');
            const btn = document.createElement('button');
            btn.className = 'nb-nb-link nb-nb-nb-name';
            btn.textContent = nb.name;
            btn.addEventListener('click', () => NbNav.switchNotebook(nb.name));
            const count = document.createElement('span');
            count.className = 'nb-nb-nb-count';
            count.textContent = nb.count;
            const age = document.createElement('span');
            age.className = 'nb-nb-nb-age';
            age.textContent = _relTime(nb.mtime);
            li.appendChild(btn);
            li.appendChild(count);
            li.appendChild(age);
            list.appendChild(li);
        });
        el.appendChild(list);
    }

    // ── git ───────────────────────────────────────────────────────────────────

    async function _loadGitBlock(el) {
        const line  = (el.dataset.cmd || '').trim();
        const space = line.indexOf(' ');
        const repo  = space === -1 ? line : line.slice(0, space);
        const args  = space === -1 ? ''   : line.slice(space + 1).trim();
        el.classList.remove('nb-collapsed');
        el.innerHTML = '<span class="nb-spin">⟳</span>';
        try {
            const d = await fetch(
                `/api/nb/git?repo=${encodeURIComponent(repo)}&args=${encodeURIComponent(args)}`
            ).then(r => r.json());
            if (d.error) { el.innerHTML = `<span class="nb-git-error">⚠ ${_esc(d.error)}</span>`; return; }
            _buildGitOutput(el, d.output || '', repo, args);
        } catch(e) {
            el.innerHTML = `<span class="nb-git-error">⚠ ${_esc(e.message)}</span>`;
        }
        _initCollapseToggle(el);
    }

    function _gitRemoteToWebUrl(raw) {
        const s = raw.trim();
        if (!s || s.startsWith('error') || s.startsWith('fatal')) return null;
        if (s.startsWith('https://') || s.startsWith('http://'))
            return s.replace(/\.git$/, '');
        const m = s.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
        return m ? `https://${m[1]}/${m[2]}` : null;
    }

    function _buildGitOutput(el, text, repo, args) {
        el.innerHTML = '';
        const hdr = document.createElement('div');
        hdr.className = 'nb-git-header';
        const refBtn = document.createElement('button');
        refBtn.className = 'nb-tw-btn'; refBtn.title = 'Refresh'; refBtn.textContent = '↻';
        refBtn.addEventListener('click', () => _loadGitBlock(el));
        hdr.innerHTML = `<span class="nb-git-meta"><span class="nb-git-repo" title="Open remote in browser">${_esc(repo)}</span> <code>git ${_esc(args)}</code></span>`;
        const repoEl = hdr.querySelector('.nb-git-repo');
        repoEl.addEventListener('click', async () => {
            try {
                const d = await fetch(
                    `/api/nb/git?repo=${encodeURIComponent(repo)}&args=${encodeURIComponent('remote get-url origin')}`
                ).then(r => r.json());
                const url = _gitRemoteToWebUrl(d.output || '');
                if (url) window.open(url, '_blank');
            } catch(e) { console.error('git remote:', e); }
        });
        hdr.appendChild(refBtn);
        el.appendChild(hdr);
        const pre = document.createElement('pre');
        pre.className = 'nb-git-pre';
        pre.textContent = text;
        el.appendChild(pre);
    }

    // ── hledger ───────────────────────────────────────────────────────────────

    async function _loadHledgerBlock(el) {
        const q = el.dataset.query || '';
        el.classList.remove('nb-collapsed');
        el.innerHTML = '<span class="nb-spin">⟳</span>';
        try {
            const r = await fetch(`/api/hledger-query?q=${encodeURIComponent(q)}`);
            const d = await r.json();
            if (d.error) { el.innerHTML = `<span class="nb-hl-error">⚠ ${_esc(d.error)}</span>`; return; }
            el.dataset.hlFile = d.file || '';
            const launch = d.terminalMode ? {terminal: true, cmd: d.launchCmd}
                         : d.webUrl       ? {url: d.webUrl}
                         : null;
            if (d.text != null) { _buildHledgerPre(el, d.text, q, launch); return; }
            const cmd = d.cmd || 'balance';
            const BALANCE   = new Set(['balance','bal','b']);
            const REGISTER  = new Set(['register','reg','r']);
            const SECTIONED = new Set(['incomestatement','is','balancesheet','bs','cashflow','cf']);
            if (BALANCE.has(cmd))        _buildHledgerBalance(el, d.data, q, launch);
            else if (REGISTER.has(cmd))  _buildHledgerRegister(el, d.data, q, launch);
            else if (SECTIONED.has(cmd)) _buildHledgerSectioned(el, d.data, q, launch);
            else _buildHledgerPre(el, JSON.stringify(d.data, null, 2), q, launch);
        } catch(e) {
            el.innerHTML = `<span class="nb-hl-error">⚠ ${_esc(e.message)}</span>`;
        }
    }

    function _negateHlAmount(s) {
        s = (s || '').trim();
        return s.startsWith('-') ? s.slice(1).trim() : s ? '-' + s : '';
    }

    function _hlFmtAmts(amounts) {
        if (!amounts?.length) return '0';
        return amounts.map(a => {
            const qty  = a.aquantity?.floatingPoint ?? 0;
            const sym  = a.acommodity || '';
            const prec = a.astyle?.asprecision ?? 2;
            const abs  = Math.abs(qty).toFixed(prec).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
            const sign = qty < 0 ? '−' : '';
            return a.astyle?.ascommodityside === 'L'
                ? `${sign}${sym}${abs}`
                : `${sign}${abs}${sym ? ' ' + sym : ''}`;
        }).join(' + ');
    }

    function _hlAmtCls(amounts) {
        const total = (amounts || []).reduce((s, a) => s + (a.aquantity?.floatingPoint ?? 0), 0);
        return total < -0.001 ? 'nb-hl-neg' : total > 0.001 ? 'nb-hl-pos' : 'nb-hl-zero';
    }

    function _hlHeader(el, q, refresh, launch, count = null) {
        const hdr = document.createElement('div');
        hdr.className = 'nb-hl-header';
        const countHtml = count != null ? `<span class="nb-hl-count">${count}</span>` : '';
        const filterHtml = q ? ` <code>${_esc(q)}</code>` : '';
        const nameTitle = !launch                ? 'Configure launch in Settings → Codeblocks'
                        : launch.terminal        ? 'Run in terminal'
                        :                          'Open in hledger-web';
        hdr.innerHTML = `<span class="nb-hl-meta"><span class="nb-hl-name" title="${nameTitle}">hledger</span>${countHtml}${filterHtml}</span>`;

        const nameEl = hdr.querySelector('.nb-hl-name');
        nameEl.addEventListener('click', async () => {
            if (!launch) { NbTerminal.openSettings('sec-codeblocks'); return; }
            if (launch.terminal) { NbTerminal.run(launch.cmd); return; }
            nameEl.classList.add('nb-hl-name-launching');
            try {
                const d = await fetch('/api/hledger/launch', {method: 'POST'}).then(r => r.json());
                if (d.url) {
                    const args    = (q || '').split(/\s+/);
                    const pattern = args.slice(1).find(a => !a.startsWith('-')) || '';
                    const hash    = pattern ? `#${encodeURIComponent(pattern)}` : '';
                    window.open(`${d.url}${hash}`, 'hledger-web');
                }
            } catch(e) { console.error('hledger launch:', e); }
            finally { nameEl.classList.remove('nb-hl-name-launching'); }
        });

        const acts = document.createElement('span');
        acts.className = 'nb-hl-actions';

        const addBtn = document.createElement('button');
        addBtn.className = 'nb-tw-btn nb-hl-btn nb-hl-add-btn';
        addBtn.title = 'Add transaction';
        addBtn.textContent = '+';
        addBtn.addEventListener('click', () => _showHledgerAddForm(el, q, addBtn));
        acts.appendChild(addBtn);

        const helpBtn = document.createElement('button');
        helpBtn.className = 'nb-tw-btn nb-hl-btn nb-hl-help-btn';
        helpBtn.title = 'Help';
        helpBtn.textContent = '?';
        helpBtn.addEventListener('click', () => _showHledgerHelp(helpBtn));
        acts.appendChild(helpBtn);

        const refBtn = document.createElement('button');
        refBtn.className = 'nb-tw-btn nb-hl-btn nb-hl-refresh';
        refBtn.title = 'Refresh';
        refBtn.textContent = '↻';
        refBtn.addEventListener('click', refresh);
        acts.appendChild(refBtn);

        hdr.appendChild(acts);
        el.appendChild(hdr);
        _initCollapseToggle(el);
    }

    function _showHledgerHelp(trigger) {
        if (trigger._helpPop) {
            trigger._helpPop.remove();
            trigger._helpPop = null;
            trigger.classList.remove('nb-hl-btn-active');
            return;
        }
        trigger.classList.add('nb-hl-btn-active');

        const pop = document.createElement('div');
        pop.className = 'nb-hl-help-pop';
        pop.innerHTML = `
            <b class="nb-hl-hp-title">hledger block</b>
            <table class="nb-hl-hp-cmds">
                <tr><td>balance · bal · b</td><td>account tree</td></tr>
                <tr><td>register · reg · r</td><td>ledger + running balance</td></tr>
                <tr><td>incomestatement · is</td><td>revenues / expenses</td></tr>
                <tr><td>balancesheet · bs</td><td>assets / liabilities</td></tr>
                <tr><td>cashflow · cf</td><td>cash flow</td></tr>
            </table>
            <div class="nb-hl-hp-sec">File</div>
            <code class="nb-hl-hp-code">~/path/ledger.journal reg thismonth</code>
            <div class="nb-hl-hp-sec">Filters</div>
            <code class="nb-hl-hp-code">--period thisweek · --depth 2 · tag:name</code>
            <code class="nb-hl-hp-code">--begin 2026-01-01 · --end 2026-12-31</code>`;

        document.body.appendChild(pop);
        const rect = trigger.getBoundingClientRect();
        pop.style.top  = (rect.bottom + 4) + 'px';
        pop.style.left = rect.left + 'px';
        const pr = pop.getBoundingClientRect();
        if (pr.right  > window.innerWidth  - 8) pop.style.left = Math.max(8, rect.right - pr.width) + 'px';
        if (pr.bottom > window.innerHeight - 8) pop.style.top  = Math.max(8, rect.top - pr.height - 4) + 'px';

        trigger._helpPop = pop;

        const dismiss = () => {
            pop.remove();
            trigger._helpPop = null;
            trigger.classList.remove('nb-hl-btn-active');
            document.removeEventListener('click', outside, true);
        };
        const outside = e => { if (!pop.contains(e.target) && e.target !== trigger) dismiss(); };
        setTimeout(() => document.addEventListener('click', outside, true), 0);
    }

    function _showHledgerAddForm(el, q, trigger) {
        const existing = trigger._cbForm || el.querySelector('.nb-hl-addform');
        if (existing) { existing.remove(); trigger._cbForm = null; trigger?.classList.remove('nb-hl-btn-active'); return; }
        trigger?.classList.add('nb-hl-btn-active');

        const today = _localDateStr();
        let _accDlId = null;

        function makePostingRow() {
            const row = document.createElement('div');
            row.className = 'nb-hl-posting-row';
            row.innerHTML = `
                <input type="text" class="nb-hl-inp nb-hl-acc-inp" placeholder="account:name" autocomplete="off" spellcheck="false">
                <input type="text" class="nb-hl-inp nb-hl-amt-inp" placeholder="amount (blank to auto-balance)">
                <button class="nb-tw-btn nb-hl-rm-row" title="Remove posting">✕</button>`;
            row.querySelector('.nb-hl-rm-row').addEventListener('click', () => {
                if (form.querySelectorAll('.nb-hl-posting-row').length > 2) row.remove();
            });
            if (_accDlId) row.querySelector('.nb-hl-acc-inp').setAttribute('list', _accDlId);
            return row;
        }

        const form = document.createElement('div');
        form.className = 'nb-hl-addform';
        form.innerHTML = `
            <div class="nb-hl-addform-top">
                <input type="date" class="nb-hl-inp nb-hl-date-inp" value="${today}">
                <input type="text" class="nb-hl-inp nb-hl-desc-inp" placeholder="Description" autocomplete="off">
            </div>
            <div class="nb-hl-postings"></div>
            <div class="nb-hl-addform-footer">
                <button class="nb-tw-btn nb-hl-btn nb-hl-add-row">+ posting</button>
                <input type="text" class="nb-hl-inp nb-hl-comment-inp" placeholder="; comment (optional)" autocomplete="off" spellcheck="false">
                <button class="nb-btn-primary nb-hl-save-btn">Save</button>
                <button class="nb-tw-btn nb-hl-cancel-btn">Cancel</button>
                <span class="nb-hl-form-status"></span>
            </div>`;

        const postingsEl = form.querySelector('.nb-hl-postings');
        const row1 = makePostingRow();
        const row2 = makePostingRow();
        postingsEl.appendChild(row1);
        postingsEl.appendChild(row2);

        const amt1 = row1.querySelector('.nb-hl-amt-inp');
        const amt2 = row2.querySelector('.nb-hl-amt-inp');
        amt1.addEventListener('input', () => {
            if (!amt2._userEdited) amt2.value = _negateHlAmount(amt1.value);
        });
        amt2.addEventListener('input', () => {
            amt2._userEdited = amt2.value !== '' && amt2.value !== _negateHlAmount(amt1.value);
        });

        form.querySelector('.nb-hl-add-row').addEventListener('click', () =>
            postingsEl.appendChild(makePostingRow()));

        const dismiss = _cbFormAttach(form, trigger, el,
            f => el.querySelector('.nb-hl-header').insertAdjacentElement('afterend', f));

        form.querySelector('.nb-hl-cancel-btn').addEventListener('click', dismiss);

        form.querySelector('.nb-hl-save-btn').addEventListener('click', async () => {
            const status  = form.querySelector('.nb-hl-form-status');
            const date    = form.querySelector('.nb-hl-date-inp').value;
            const desc    = form.querySelector('.nb-hl-desc-inp').value.trim();
            const comment = form.querySelector('.nb-hl-comment-inp').value.trim();
            const postings = [...form.querySelectorAll('.nb-hl-posting-row')].map(r => ({
                account: r.querySelector('.nb-hl-acc-inp').value.trim(),
                amount:  r.querySelector('.nb-hl-amt-inp').value.trim(),
            })).filter(p => p.account);

            if (!date || !desc) { status.textContent = 'Date and description required'; return; }
            if (!postings.length) { status.textContent = 'At least one posting required'; return; }

            status.textContent = 'Saving…';
            status.style.color = '';
            try {
                const hlFile = el.dataset.hlFile || '';
                const r = await fetch('/api/hledger-add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ date, description: desc, postings,
                        ...(comment  && { comment }),
                        ...(hlFile   && { file: hlFile }) }),
                });
                const d = await r.json();
                if (d.error) {
                    status.textContent = '✗ ' + d.error;
                    status.style.color = 'var(--accent-neg, #e74c3c)';
                } else {
                    dismiss();
                    await _loadHledgerBlock(el);
                }
            } catch(e) {
                status.textContent = '✗ ' + e.message;
                status.style.color = 'var(--accent-neg, #e74c3c)';
            }
        });

        form.querySelector('.nb-hl-desc-inp')?.focus();

        // Populate account autocomplete datalist (async, best-effort)
        fetch('/api/hledger/accounts?notebook=').then(r => r.json()).then(d => {
            const accounts = d.accounts || [];
            if (!accounts.length || !form.isConnected) return;
            _accDlId = 'nb-hl-acc-dl-' + Date.now();
            const dl = document.createElement('datalist');
            dl.id = _accDlId;
            accounts.forEach(a => { const o = document.createElement('option'); o.value = a; dl.appendChild(o); });
            form.appendChild(dl);
            form.querySelectorAll('.nb-hl-acc-inp').forEach(inp => inp.setAttribute('list', _accDlId));
        }).catch(() => {});
    }

    function _buildHledgerBalance(el, data, q, launch) {
        const rows   = Array.isArray(data?.[0]) ? data[0] : [];
        const totals = Array.isArray(data?.[1]) ? data[1] : [];
        el.innerHTML = '';
        _hlHeader(el, q, () => _loadHledgerBlock(el), launch, rows.length);
        if (!rows.length) { el.insertAdjacentHTML('beforeend', '<div class="nb-hl-empty">No accounts matched</div>'); return; }

        const tbody = rows.map(r => {
            const [name, , depth, amounts] = r;
            const cls = _hlAmtCls(amounts);
            return `<tr>
                <td class="nb-hl-account" style="padding-left:${8 + depth * 16}px">${_esc(name)}</td>
                <td class="nb-hl-amt ${cls}">${_hlFmtAmts(amounts)}</td>
            </tr>`;
        }).join('');

        const totalCls = _hlAmtCls(totals);
        el.insertAdjacentHTML('beforeend', `<table class="nb-hl-table">
            <thead><tr><th>Account</th><th class="nb-hl-amt">Balance</th></tr></thead>
            <tbody>${tbody}</tbody>
            <tfoot><tr class="nb-hl-total-row">
                <td>Total</td>
                <td class="nb-hl-amt ${totalCls}">${_hlFmtAmts(totals)}</td>
            </tr></tfoot>
        </table>`);
    }

    function _buildHledgerRegister(el, data, q, launch) {
        const rows = Array.isArray(data) ? data : [];
        const txnCount = rows.filter(r => r[0] != null).length;
        el.innerHTML = '';
        _hlHeader(el, q, () => _loadHledgerBlock(el), launch, txnCount);
        if (!rows.length) { el.insertAdjacentHTML('beforeend', '<div class="nb-hl-empty">No transactions matched</div>'); return; }

        const tbody = rows.map(r => {
            const [date, , desc, posting, balance] = r;
            const account = posting?.paccount || '';
            const amounts = posting?.pamount  || [];
            const amtCls  = _hlAmtCls(amounts);
            const balCls  = _hlAmtCls(balance);
            const isCont  = date == null;
            return `<tr class="${isCont ? 'nb-hl-cont' : ''}">
                <td class="nb-hl-date">${isCont ? '' : _esc(date || '')}</td>
                <td class="nb-hl-desc">${isCont ? '' : _esc(desc || '')}</td>
                <td class="nb-hl-account">${_esc(account)}</td>
                <td class="nb-hl-amt ${amtCls}">${_hlFmtAmts(amounts)}</td>
                <td class="nb-hl-amt ${balCls}">${_hlFmtAmts(balance)}</td>
            </tr>`;
        }).join('');

        el.insertAdjacentHTML('beforeend', `<table class="nb-hl-table">
            <thead><tr><th>Date</th><th>Description</th><th>Account</th>
                       <th class="nb-hl-amt">Amount</th><th class="nb-hl-amt">Balance</th></tr></thead>
            <tbody>${tbody}</tbody>
        </table>`);
    }

    function _buildHledgerSectioned(el, data, q, launch) {
        const subreports = data?.cbrSubreports || [];
        const rowCount = subreports.reduce((n, [, r]) => n + (r?.prRows?.length || 0), 0);
        el.innerHTML = '';
        _hlHeader(el, q, () => _loadHledgerBlock(el), launch, rowCount || null);

        for (const [sectionName, report] of subreports) {
            const rows   = report?.prRows   || [];
            const totals = report?.prTotals;

            el.insertAdjacentHTML('beforeend', `<div class="nb-hl-section">${_esc(sectionName)}</div>`);

            if (!rows.length) {
                el.insertAdjacentHTML('beforeend', '<div class="nb-hl-empty nb-hl-section-empty">—</div>');
            } else {
                const tbody = rows.map(r => {
                    const name    = r.prrName || '';
                    const amounts = (r.prrAmounts || [[]])[0] || [];
                    const cls     = _hlAmtCls(amounts);
                    return `<tr>
                        <td class="nb-hl-account">${_esc(name)}</td>
                        <td class="nb-hl-amt ${cls}">${_hlFmtAmts(amounts)}</td>
                    </tr>`;
                }).join('');

                const sectionTotal = (totals?.prrAmounts || [[]])[0] || [];
                const totCls = _hlAmtCls(sectionTotal);
                el.insertAdjacentHTML('beforeend', `<table class="nb-hl-table nb-hl-section-table">
                    <tbody>${tbody}</tbody>
                    <tfoot><tr class="nb-hl-total-row">
                        <td>Total ${_esc(sectionName)}</td>
                        <td class="nb-hl-amt ${totCls}">${_hlFmtAmts(sectionTotal)}</td>
                    </tr></tfoot>
                </table>`);
            }
        }
    }

    function _buildHledgerPre(el, text, q, launch) {
        el.innerHTML = '';
        _hlHeader(el, q, () => _loadHledgerBlock(el), launch);
        el.insertAdjacentHTML('beforeend', `<pre class="nb-hl-pre">${_esc(text)}</pre>`);
    }

    // ── Plugin registration ───────────────────────────────────────────────────

    NbWeb.registerModule('codeblocks', {

        label:       'NbWeb-codeblocks',
        description: 'Live fenced code block renderers (tw, hledger, t, nb, git)',
        helpUrl:     '/plugins/nbweb-codeblocks.md',

        codeblockRenderers: [
            {
                lang:   'tw',
                html:   text => `<div class="nb-tw-block" data-query="${text.trim().replace(/"/g,'&quot;')}"><span class="nb-spin">⟳</span></div>`,
                render: async container => {
                    const blocks = container.querySelectorAll('.nb-tw-block');
                    if (!blocks.length) return;
                    const w = await NbWeb.checkWhich('task');
                    for (const el of blocks) {
                        if (!w.found) { await NbWeb.renderRequirementsCard(el, '/plugins/requirements/tw-requirements.md'); continue; }
                        await _loadTwBlock(el);
                    }
                },
            },
            {
                lang:   'hledger',
                html:   text => `<div class="nb-hl-block" data-query="${text.trim().replace(/"/g,'&quot;')}"><span class="nb-spin">⟳</span></div>`,
                render: async container => {
                    const blocks = container.querySelectorAll('.nb-hl-block');
                    if (!blocks.length) return;
                    const w = await NbWeb.checkWhich('hledger');
                    for (const el of blocks) {
                        if (!w.found) { await NbWeb.renderRequirementsCard(el, '/plugins/requirements/hledger-requirements.md'); continue; }
                        await _loadHledgerBlock(el);
                    }
                },
            },
            {
                lang:   't',
                html:   text => `<div class="nb-t-block" data-period="${text.trim().replace(/"/g,'&quot;')}"><span class="nb-spin">⟳</span></div>`,
                render: async container => { for (const el of container.querySelectorAll('.nb-t-block')) await _loadTBlock(el); },
            },
            {
                lang:   'nb',
                html:   text => `<div class="nb-nb-block" data-cmd="${text.trim().toLowerCase().replace(/"/g,'&quot;')}"><span class="nb-spin">⟳</span></div>`,
                render: async container => { for (const el of container.querySelectorAll('.nb-nb-block')) await _loadNbBlock(el); },
            },
            {
                lang:   'git',
                html:   text => `<div class="nb-git-block" data-cmd="${text.trim().replace(/"/g,'&quot;')}"><span class="nb-spin">⟳</span></div>`,
                render: async container => { for (const el of container.querySelectorAll('.nb-git-block')) await _loadGitBlock(el); },
            },
        ],

    });

})();

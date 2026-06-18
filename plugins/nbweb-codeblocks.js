// NbWeb-codeblocks — live fenced code block renderers for nb-web
// Provides: tw (Taskwarrior), hledger, t (timeclock), nb, git block types.
// Global plugin — no detect(), active for all notebooks.
// @name     NbWeb Codeblocks
// @version  0.1.0
// @type     core
// @homepage
(() => {

    // ── Utilities ─────────────────────────────────────────────────────────────

    const _esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    // ── Access gates ──────────────────────────────────────────────────────────

    let _cbAccess = {};
    fetch('/api/nb-settings').then(r => r.json()).then(s => { _cbAccess = s.codeblock_access || {}; }).catch(() => {});

    function _cbParseGates(text) {
        let readLevel = null, writeLevel = null;
        const lines = text.split('\n').filter(l => {
            const m = l.match(/^\s*(read|write)\s*:\s*(\S+)\s*$/i);
            if (!m) return true;
            if (m[1].toLowerCase() === 'read') readLevel  = m[2].toLowerCase();
            else                               writeLevel = m[2].toLowerCase();
            return false;
        });
        return { readLevel, writeLevel, query: lines.join('\n').trim() };
    }

    function _cbLevel(el, blockType, mode) {
        const attr = mode === 'read' ? el.dataset.cbRead : el.dataset.cbWrite;
        if (attr) return attr;
        return (_cbAccess[blockType] || {})[mode] || null;
    }

    function _cbCan(el, blockType, mode) {
        const level = _cbLevel(el, blockType, mode);
        if (!level) return true;
        return window.NbAuth?.is(level) ?? true;
    }

    function _cbDenyRead(el) {
        el.remove();
    }

    function _cbGateAttrs(readLevel, writeLevel) {
        return (readLevel  ? ` data-cb-read="${readLevel}"`  : '')
             + (writeLevel ? ` data-cb-write="${writeLevel}"` : '');
    }

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
        if (!_cbCan(el, 't', 'read')) { _cbDenyRead(el); return; }
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
        if (!_cbCan(el, 'tw', 'read')) { _cbDenyRead(el); return; }
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

        if (_cbCan(el, 'tw', 'write')) {
            const addBtn = document.createElement('button');
            addBtn.className = 'nb-tw-btn nb-tw-add-btn';
            addBtn.title = 'Add task'; addBtn.textContent = '+';
            addBtn.addEventListener('click', () => _showTwAddForm(el, q, addBtn));
            acts.appendChild(addBtn);
        }

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
        if (document.getElementById('nb-preview-content')?.dataset.noteLocked === 'true') {
            trigger.title = "Can't add — this file is locked";
            trigger.textContent = '🔒';
            setTimeout(() => { trigger.title = 'Add task'; trigger.textContent = '+'; }, 2500);
            return;
        }
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
        if (!_cbCan(el, 'nb', 'read')) { _cbDenyRead(el); return; }
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
        if (!_cbCan(el, 'git', 'read')) { _cbDenyRead(el); return; }
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

    // ── tui — inline terminal widget ─────────────────────────────────────────

    let _xtermReady = null;

    function _loadXterm() {
        if (window.Terminal) return Promise.resolve();
        if (_xtermReady)     return _xtermReady;
        // CSS: inject fire-and-forget — link.onload is unreliable and must never
        // block the render pipeline; xterm works without CSS for a moment anyway.
        if (!document.querySelector('link[href="/xterm.css"]')) {
            const l = document.createElement('link');
            l.rel = 'stylesheet'; l.href = '/xterm.css';
            document.head.appendChild(l);
        }
        _xtermReady = new Promise(resolve => {
            const s = document.createElement('script');
            s.src = '/xterm.js';
            s.onload  = resolve;
            s.onerror = resolve;  // never deadlock the render pipeline
            document.head.appendChild(s);
        });
        return _xtermReady;
    }

    // CSS lives in styles.css; this is a no-op kept for call-site compatibility.
    function _tuiInjectStyle() {}

    // Returns the inner HTML for a tui widget. Stored cmd in data-tui-cmd for wiring.
    // label='': Form 2 (auto-run).  label set: Form 1 (click-to-launch, pending).
    function _tuiBuildHtml(cmd, label, heightPx) {
        const isForm1 = Boolean(label);
        return `<div class="nb-tui-outer${isForm1 ? ' nb-tui-pending' : ''}" data-tui-cmd="${_esc(cmd)}">
            <div class="nb-tui-header" title="${isForm1 ? 'Click to launch' : 'Click to collapse'}">
                <span class="nb-tui-toggle">${isForm1 ? '▶' : '▾'}</span>
                <code class="nb-tui-cmd">${_esc(label || cmd)}</code>
                <button class="nb-tui-restart" title="Restart" tabindex="-1"
                        style="opacity:${isForm1 ? '0' : '1'};pointer-events:${isForm1 ? 'none' : 'auto'}">↺</button>
            </div>
            <div class="nb-tui-wrap" style="height:${heightPx}px;${isForm1 ? 'display:none' : ''}">
                <div class="nb-tui-container"></div>
            </div>
        </div>`;
    }

    // Wire all interactive behavior onto a .nb-tui-outer element.
    // window.Terminal must be loaded before calling this.
    function _tuiWire(outer) {
        const cmd        = outer.dataset.tuiCmd;
        const header     = outer.querySelector('.nb-tui-header');
        const wrap       = outer.querySelector('.nb-tui-wrap');
        const container  = outer.querySelector('.nb-tui-container');
        const toggle     = outer.querySelector('.nb-tui-toggle');
        const restartBtn = outer.querySelector('.nb-tui-restart');
        let term = null, ws = null, ro = null, launched = false;

        wrap.addEventListener('keydown', e => e.stopPropagation());
        wrap.addEventListener('click', () => term?.focus());

        function _fit() {
            if (!term || !container.clientWidth) return;
            const dims = term._core?._renderService?.dimensions;
            const cw   = dims?.actualCellWidth  || 7.8;
            const ch   = dims?.actualCellHeight || 20;
            const cols = Math.max(10, Math.floor(container.clientWidth  / cw));
            const rows = Math.max(3,  Math.floor(container.clientHeight / ch));
            if (cols !== term.cols || rows !== term.rows) {
                term.resize(cols, rows);
                if (ws?.readyState === WebSocket.OPEN) ws.send(`\x00resize:${cols},${rows}`);
            }
        }

        function connect() {
            if (ws)   { try { ws.close(); } catch(_) {} ws = null; }
            if (term) { term.dispose(); term = null; }
            if (ro)   { ro.disconnect(); ro = null; }
            container.innerHTML = '';
            launched = true;
            restartBtn.style.opacity = '';
            restartBtn.style.pointerEvents = '';

            term = new window.Terminal({
                rows: 24, cols: 80,
                fontSize: 13,
                fontFamily: "'JetBrains Mono','Fira Code',monospace",
                theme: { background: '#0a0a0a', foreground: '#d4d4d8' },
                convertEol: true, scrollback: 2000,
            });
            term.open(container);

            const proto = location.protocol === 'https:' ? 'wss' : 'ws';
            ws = new WebSocket(`${proto}://${location.host}/ws/pty`);

            ws.onopen = () => {
                requestAnimationFrame(() => {
                    _fit();
                    ws.send(JSON.stringify({ cmd, cols: term.cols, rows: term.rows }));
                });
            };
            ws.onmessage = e => term?.write(e.data);
            ws.onclose   = () => term?.write('\r\n\x1b[2m[exited — ↺ to restart]\x1b[0m\r\n');
            ws.onerror   = () => term?.write('\r\n\x1b[31m[connection error]\x1b[0m\r\n');

            term.onData(data => { if (ws?.readyState === WebSocket.OPEN) ws.send(data); });
            term.onResize(({ cols, rows }) => {
                if (ws?.readyState === WebSocket.OPEN) ws.send(`\x00resize:${cols},${rows}`);
            });

            if (window.ResizeObserver) {
                ro = new ResizeObserver(_fit);
                ro.observe(container);
            }
        }

        header.addEventListener('click', () => {
            if (outer.classList.contains('nb-tui-pending')) {
                outer.classList.remove('nb-tui-pending');
                wrap.style.display = '';
                toggle.textContent = '▾';
                header.title = 'Click to collapse';
                connect();
            } else if (outer.classList.contains('nb-tui-collapsed')) {
                outer.classList.remove('nb-tui-collapsed');
                wrap.style.display = '';
                toggle.textContent = '▾';
                header.title = 'Click to collapse';
                requestAnimationFrame(_fit);
            } else {
                outer.classList.add('nb-tui-collapsed');
                wrap.style.display = 'none';
                toggle.textContent = '▶';
                header.title = launched ? 'Click to expand' : 'Click to launch';
            }
        });

        if (window.MutationObserver) {
            const _watch = document.getElementById('nb-preview-content') || outer.parentNode;
            if (_watch) {
                const mo = new MutationObserver(() => {
                    if (!outer.isConnected) {
                        mo.disconnect();
                        ro?.disconnect();
                        try { ws?.close(); } catch(_) {}
                        term?.dispose();
                    }
                });
                mo.observe(_watch, { childList: true });
            }
        }

        restartBtn.addEventListener('click', e => { e.stopPropagation(); connect(); });
        if (!outer.classList.contains('nb-tui-pending')) connect();  // Form 2: auto-run
    }

    // For hledger (and other callers): set el.innerHTML and wire in one step.
    async function _createInlineTerm(el, cmd, heightPx = 400, label = '') {
        el.innerHTML = _tuiBuildHtml(cmd, label, heightPx);
        _tuiInjectStyle();
        await _loadXterm();
        if (!window.Terminal) {
            el.innerHTML = `<div style="padding:8px;color:var(--orange,#e07b39);font-size:12px">⚠ xterm.js failed to load — cannot render terminal</div>`;
            return;
        }
        const outer = el.querySelector('.nb-tui-outer');
        if (outer) _tuiWire(outer);
    }

    // ── hledger ───────────────────────────────────────────────────────────────

    function _buildHledgerLaunch(el, filePath, cmd) {
        const termCmd = `hledger-${cmd}${filePath ? ' -f ' + filePath : ''}`;
        el.classList.remove('nb-collapsed');
        el.innerHTML = `
            <div class="nb-hl-header">
                <span class="nb-hl-meta">
                    <span class="nb-hl-name" title="${_esc(termCmd)}">hledger</span>
                    <code style="margin-left:4px;opacity:0.7">${_esc(cmd)}</code>
                </span>
            </div>
            <div style="padding:6px 10px">
                <button class="nb-tw-btn nb-hl-launch-btn" style="font-size:13px;padding:4px 12px">
                    ▶ hledger-${_esc(cmd)}
                </button>
            </div>`;
        el.querySelector('.nb-hl-launch-btn').addEventListener('click', () => {
            if (cmd === 'web') {
                fetch('/api/hledger/launch', {method: 'POST'})
                    .then(r => r.json())
                    .then(d => { if (d.url) window.open(d.url, 'hledger-web'); })
                    .catch(() => {});
            } else {
                NbTerminal.run(termCmd);
            }
        });
    }

    function _hlNotebook() {
        // Prefer the active note's notebook so hledger blocks resolve the right
        // journal when the nav scope is '_all' or a different notebook.
        const sel = window.NbMain?.activeSelector?.();
        if (sel) {
            const colon = sel.indexOf(':');
            if (colon > 0) return sel.slice(0, colon);
        }
        const nb = NbNav.notebook;
        return (nb && nb !== '_all') ? nb : 'home';
    }

    async function _loadHledgerBlock(el) {
        if (!_cbCan(el, 'hledger', 'read')) { _cbDenyRead(el); return; }
        const q = el.dataset.query || '';

        // Detect launch-mode commands before hitting the backend
        const tokens = q.trim().split(/\s+/);
        const hasPath = tokens[0] && (tokens[0].startsWith('~') || tokens[0].startsWith('/'));
        const cmdToken = (hasPath ? tokens[1] : tokens[0] || '').toLowerCase();
        if (cmdToken === 'ui') {
            const filePath = hasPath ? tokens[0] : '';
            const pipeIdx  = q.indexOf('|');
            const label    = pipeIdx >= 0 ? q.slice(pipeIdx + 1).trim() : '';
            await _createInlineTerm(el, `hledger-ui${filePath ? ' -f ' + filePath : ''}`, 400, label);
            return;
        }
        if (cmdToken === 'web') {
            _buildHledgerLaunch(el, hasPath ? tokens[0] : '', 'web');
            return;
        }
        if (cmdToken === 'regen') {
            const script = tokens[1] || '';
            const label  = q.includes('|') ? q.slice(q.indexOf('|') + 1).trim() : `Regenerate (${script})`;
            el.innerHTML = `<button class="nb-hl-regen-btn nb-tool-btn">↻ ${_esc(label)}</button>`;
            el.querySelector('.nb-hl-regen-btn').addEventListener('click', async () => {
                el.innerHTML = '<span class="nb-spin">⟳</span>';
                const r = await fetch('/api/hledger/regen', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({notebook: _hlNotebook(), script})
                });
                if (!r.ok) { el.innerHTML = `<span class="nb-hl-error">⚠ ${r.status} ${r.statusText}</span>`; return; }
                const d = await r.json();
                if (d.error) { el.innerHTML = `<span class="nb-hl-error">⚠ ${_esc(d.error)}</span>`; return; }
                el.innerHTML = `<span style="color:var(--green,#4caf50)">✓ ${_esc(d.message || 'done')}</span>`;
                // Refresh all other hledger blocks on the page
                document.querySelectorAll('.nb-codeblock-hledger').forEach(b => {
                    if (b !== el) _loadHledgerBlock(b);
                });
            });
            return;
        }

        const _initCollapsed = el.hasAttribute('data-init-collapsed');
        el.classList.remove('nb-collapsed');
        el.innerHTML = '<span class="nb-spin">⟳</span>';
        try {
            const r = await fetch(`/api/hledger-query?q=${encodeURIComponent(q)}&notebook=${encodeURIComponent(_hlNotebook())}`);
            const d = await r.json();
            if (d.error) { el.innerHTML = `<span class="nb-hl-error">⚠ ${_esc(d.error)}</span>`; return; }
            el.dataset.hlFile         = d.file            || '';
            el.dataset.hlJournal      = d.journal         || '';
            el.dataset.hlJournalSel   = d.journalSelector || '';
            const launch = d.terminalMode ? {terminal: true, cmd: d.launchCmd}
                         : d.webUrl       ? {url: d.webUrl}
                         : null;
            if (d.text != null) {
                if (d.cmd === 'files') { _buildHledgerFiles(el, d.text, q, launch); return; }
                _buildHledgerPre(el, d.text, q, launch); return;
            }
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
        } finally {
            if (_initCollapsed) el.classList.add('nb-collapsed');
        }
    }

    function _accountFromQuery(q) {
        const CMDS     = new Set(['reg','register','bal','balance','bs','is','cf','print',
                                  'check','accounts','activity','stats','aregister','areg',
                                  'incomestatement','balancesheet','cashflow']);
        const QUERY_RE = /^(date2?|payee|desc|note|cur|amt|tag|acct|code|status|type|not|inacct|real|depth):/i;
        for (const tok of (q || '').split(/\s+/)) {
            if (!tok || tok.startsWith('-'))                         continue; // flag
            if (tok.includes('/') || tok.startsWith('~'))           continue; // path
            if (/^\d/.test(tok))                                    continue; // number/date
            if (CMDS.has(tok.toLowerCase()))                        continue; // command
            if (QUERY_RE.test(tok))                                 continue; // query filter
            if (/^[A-Za-z][\w:]*$/.test(tok))                      return tok;
        }
        return '';
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
        hdr.innerHTML = `<span class="nb-hl-meta nb-collapse-zone"><span class="nb-hl-name" title="${nameTitle}">hledger</span>${countHtml}${filterHtml}</span>`;

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

        if (_cbCan(el, 'hledger', 'write')) {
            const editBtn = document.createElement('button');
            editBtn.className = 'nb-tw-btn nb-hl-btn nb-hl-edit-btn';
            editBtn.title = 'Edit journal';
            editBtn.textContent = '✎';
            editBtn.addEventListener('click', () => {
                const sel  = el.dataset.hlJournalSel;
                const path = el.dataset.hlJournal;
                NbMain.openNote(sel || path);
            });
            acts.appendChild(editBtn);

            const addBtn = document.createElement('button');
            addBtn.className = 'nb-tw-btn nb-hl-btn nb-hl-add-btn';
            addBtn.title = 'Add transaction';
            addBtn.textContent = '+';
            addBtn.addEventListener('click', () => _showHledgerAddForm(el, q, addBtn));
            acts.appendChild(addBtn);
        }

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
        if (document.getElementById('nb-preview-content')?.dataset.noteLocked === 'true') {
            trigger.title = "Can't add — this file is locked";
            trigger.textContent = '🔒';
            setTimeout(() => { trigger.title = 'Add transaction'; trigger.textContent = '+'; }, 2500);
            return;
        }
        trigger?.classList.add('nb-hl-btn-active');

        const _fn   = typeof NbMain !== 'undefined' ? (NbMain.activeFilename() || '') : '';
        const _dm   = _fn.match(/^(\d{4})(\d{2})(\d{2})\b/);
        const today = _dm ? `${_dm[1]}-${_dm[2]}-${_dm[3]}` : _localDateStr();
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
        const _preAcct = _accountFromQuery(q);
        if (_preAcct) row1.querySelector('.nb-hl-acc-inp').value = _preAcct;

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

    async function _buildHledgerFiles(el, text, q, launch) {
        el.innerHTML = '';
        _hlHeader(el, q, () => _loadHledgerBlock(el), launch);
        const paths = text.trim().split('\n').filter(Boolean);
        const list = document.createElement('div');
        list.className = 'nb-hl-files-list';
        for (const rawPath of paths) {
            const row = document.createElement('div');
            row.className = 'nb-hl-file-row';
            const link = document.createElement('button');
            link.className = 'nb-tw-btn nb-hl-file-link';
            link.title = rawPath;
            link.textContent = rawPath.replace(/^.*\//, '');   // basename
            link.addEventListener('click', () => NbMain.openNote(rawPath));
            const hint = document.createElement('span');
            hint.className = 'nb-hl-file-hint';
            hint.textContent = rawPath.replace(/\/[^/]+$/, '');  // dirname
            row.appendChild(link);
            row.appendChild(hint);
            list.appendChild(row);
        }
        el.appendChild(list);
    }

    // ── front codeblock ───────────────────────────────────────────────────────
    // Syntax: field:value field2:value2 | Optional label
    //   field:value  → frontmatter field equals value (case-insensitive)
    //   field:        → frontmatter field exists (any value)
    //   field:""      → frontmatter field is absent or empty

    // Parse: [nb1 nb2] field:value field2: field3:"" | Label
    // Leading bare words (no colon) = notebook scope; none = all notebooks.
    function _frontParseQuery(raw) {
        raw = (raw || '').trim();
        const pipeIdx = raw.indexOf(' |');
        const label   = pipeIdx >= 0 ? raw.slice(pipeIdx + 2).trim() : '';
        const qpart   = pipeIdx >= 0 ? raw.slice(0, pipeIdx).trim() : raw;

        // Consume leading tokens with no colon as notebook names
        const notebooks = [];
        const tokens    = qpart ? qpart.split(/\s+/) : [];
        let i = 0;
        while (i < tokens.length && !tokens[i].includes(':')) {
            notebooks.push(tokens[i++]);
        }
        const filterPart = tokens.slice(i).join(' ');

        const filters = [];
        const pat = /(\w[\w.-]*):"([^"]*)"|(\w[\w.-]*):(\S*)/g;
        let m;
        while ((m = pat.exec(filterPart))) {
            if (m[1] !== undefined) {
                filters.push({ field: m[1], op: m[2] === '' ? 'empty' : 'eq', value: m[2] });
            } else {
                const field = m[3], value = m[4];
                filters.push({ field, op: value === '' ? 'exists' : 'eq', value });
            }
        }
        return { notebooks, filters, label };
    }

    // ── front changes mode — frontmatter editor ───────────────────────────────

    function _fmParseFields(raw) {
        if (!raw.startsWith('---\n')) return [];
        const end = raw.indexOf('\n---', 3);
        if (end === -1) return [];
        const fields = [];
        for (const line of raw.slice(4, end).split('\n')) {
            const cm = line.match(/^([\w/-]+):([ \t]*)(.*)$/);
            if (!cm) continue;
            const value = cm[3].trim();
            if (value === '|' || value === '>') continue;  // skip block scalars
            fields.push({ key: cm[1], value });
        }
        return fields;
    }

    function _fmPatch(raw, updates) {
        if (!raw.startsWith('---\n')) return raw;
        const boundary = raw.indexOf('\n---', 3);
        if (boundary === -1) return raw;
        // head = opening --- + FM content (without the closing \n---)
        // tail = \n--- + everything after (body preserved exactly)
        let head = raw.slice(0, boundary);
        const tail = raw.slice(boundary);
        for (const [key, val] of Object.entries(updates)) {
            const re = new RegExp(`^([ \\t]*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}):[ \\t]*.*$`, 'm');
            head = head.replace(re, `$1: ${val}`);
        }
        return head + tail;
    }

    function _fmWidget(key, value, constraint) {
        const c = (constraint || '').trim();
        if (c.startsWith('select ')) {
            const options = c.slice(7).split(',').map(s => s.trim());
            const sel = document.createElement('select');
            sel.dataset.fmKey = key;
            if (value && !options.includes(value)) {
                const o = document.createElement('option');
                o.value = value; o.textContent = value;
                sel.appendChild(o);
            }
            for (const opt of options) {
                const o = document.createElement('option');
                o.value = opt; o.textContent = opt || '—';
                if (opt === value) o.selected = true;
                sel.appendChild(o);
            }
            return sel;
        }
        if (c === 'bool') {
            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.dataset.fmKey = key;
            cb.checked = value === 'true';
            return cb;
        }
        if (c === 'date') {
            const inp = document.createElement('input');
            inp.type = 'date'; inp.dataset.fmKey = key; inp.value = value;
            return inp;
        }
        if (c === 'area') {
            const ta = document.createElement('textarea');
            ta.dataset.fmKey = key; ta.value = value;
            return ta;
        }
        const inp = document.createElement('input');
        inp.type = 'text'; inp.dataset.fmKey = key; inp.value = value;
        return inp;
    }

    async function _loadFrontChanges(el) {
        const firstLine = (el.dataset.query || '').trim().split('\n')[0];
        const pipeIdx   = firstLine.indexOf('|');
        const label     = pipeIdx >= 0 ? firstLine.slice(pipeIdx + 1).trim() : 'Changes';

        el.innerHTML = '';
        el.classList.add('nb-front-changes');

        const btn = document.createElement('button');
        btn.className  = 'nb-front-changes-btn nb-tw-btn';
        btn.textContent = label;
        el.appendChild(btn);

        const panel = document.createElement('div');
        panel.className = 'nb-front-changes-panel';
        panel.hidden = true;
        el.appendChild(panel);

        btn.addEventListener('click', async () => {
            if (!panel.hidden) {
                panel.hidden = true; btn.classList.remove('nb-active'); return;
            }
            btn.disabled = true; btn.textContent = '⟳';
            try {
                const selector = NbMain.activeSelector?.();
                if (!selector) throw new Error('no active note');

                const [noteD, conD] = await Promise.all([
                    fetch(`/api/note?selector=${encodeURIComponent(selector)}`).then(r => r.json()),
                    fetch(`/api/note/constraints?selector=${encodeURIComponent(selector)}`).then(r => r.json()),
                ]);
                if (noteD.error) throw new Error(noteD.error);

                const noteRaw    = noteD.raw || '';
                const constraints = conD.error ? {} : conD;
                const fields      = _fmParseFields(noteRaw);

                panel.innerHTML = '';
                const form = document.createElement('div');
                form.className = 'nb-front-changes-form';

                for (const { key, value } of fields) {
                    const row = document.createElement('div');
                    row.className = 'nb-front-changes-row';
                    const lbl = document.createElement('label');
                    lbl.className   = 'nb-front-changes-label';
                    lbl.textContent = key;
                    row.appendChild(lbl);
                    row.appendChild(_fmWidget(key, value, constraints[key]));
                    form.appendChild(row);
                }

                const actions = document.createElement('div');
                actions.className = 'nb-front-changes-actions';

                const _t = (key) => NbWeb.t(key);
                const saveBtn = document.createElement('button');
                saveBtn.className   = 'nb-tw-btn';
                saveBtn.textContent = _t('btn_save');
                saveBtn.addEventListener('click', async () => {
                    const updates = {};
                    for (const w of form.querySelectorAll('[data-fm-key]')) {
                        updates[w.dataset.fmKey] = w.type === 'checkbox' ? String(w.checked) : w.value;
                    }
                    saveBtn.disabled = true; saveBtn.textContent = '⟳';
                    try {
                        const r = await fetch('/api/note', {
                            method:  'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body:    JSON.stringify({ selector, content: _fmPatch(noteRaw, updates) }),
                        }).then(r => r.json());
                        if (r.error) throw new Error(r.error);
                        panel.hidden = true;
                        btn.classList.remove('nb-active');
                        NbMain.openNote(selector);
                    } catch (e) {
                        saveBtn.textContent = `⚠ ${e.message}`;
                        saveBtn.disabled = false;
                    }
                });

                const cancelBtn = document.createElement('button');
                cancelBtn.className   = 'nb-tw-btn';
                cancelBtn.textContent = _t('btn_cancel');
                cancelBtn.addEventListener('click', () => {
                    panel.hidden = true; btn.classList.remove('nb-active');
                });

                actions.appendChild(saveBtn);
                actions.appendChild(cancelBtn);
                panel.appendChild(form);
                panel.appendChild(actions);
                panel.hidden = false;
                btn.classList.add('nb-active');
            } catch (e) {
                panel.innerHTML = `<span class="nb-hl-error">⚠ ${_esc(e.message)}</span>`;
                panel.hidden = false;
            } finally {
                btn.disabled    = false;
                btn.textContent = label;
            }
        });
    }

    // ── front block dispatcher ─────────────────────────────────────────────────

    async function _loadFrontBlock(el) {
        if (!_cbCan(el, 'front', 'read')) { _cbDenyRead(el); return; }
        if ((el.dataset.query || '').trim().startsWith('changes')) {
            await _loadFrontChanges(el);
            return;
        }
        const parsed = _frontParseQuery(el.dataset.query || '');
        el.dataset.frontNotebooks = parsed.notebooks.join(',');
        el.dataset.frontFilters   = JSON.stringify(parsed.filters);
        el.dataset.frontLabel     = parsed.label;
        await _frontRender(el);
    }

    async function _frontRender(el) {
        const notebooks  = el.dataset.frontNotebooks || '';
        const filters    = JSON.parse(el.dataset.frontFilters || '[]');
        const label      = el.dataset.frontLabel || '';
        const wasOpen    = el.classList.contains('nb-front-open');
        el.innerHTML     = '<span class="nb-spin">⟳</span>';
        try {
            const params = new URLSearchParams({ notebooks, filters: JSON.stringify(filters) });
            const _fr    = await fetch(`/api/front-query?${params}`);
            if (_fr.status === 403) { _cbDenyRead(el); return; }
            const notes  = await _fr.json();
            if (notes.error) throw new Error(notes.error);

            // Determine which notebooks appear in results
            const nbSet   = new Set(notes.map(n => n.notebook).filter(Boolean));
            const multiNb = nbSet.size > 1;
            const nbLabel = nbSet.size === 1 ? `(${[...nbSet][0]})`
                          : nbSet.size > 1   ? `(${nbSet.size} notebooks)`
                          : '';

            el.innerHTML = '';

            // ── Header ──────────────────────────────────────────────────────
            const hdr = document.createElement('div');
            hdr.className = 'nb-front-header';

            const toggle = document.createElement('span');
            toggle.className = 'nb-front-toggle';

            const countEl = document.createElement('span');
            countEl.className = 'nb-front-count';
            countEl.textContent = notes.length ? String(notes.length) : 'No matches';

            const refBtn = document.createElement('button');
            refBtn.className = 'nb-tw-btn nb-nav-refresh nb-front-refresh';
            refBtn.title = 'Refresh'; refBtn.textContent = '↻';
            refBtn.addEventListener('click', e => { e.stopPropagation(); _frontRender(el); });

            // Whole header is the click zone
            hdr.addEventListener('click', () => {
                el.classList.toggle('nb-front-open');
                toggle.textContent = el.classList.contains('nb-front-open') ? '▼' : '▶';
            });

            hdr.appendChild(toggle);
            hdr.appendChild(countEl);
            if (nbLabel) {
                const nbEl = document.createElement('span');
                nbEl.className = 'nb-front-nb';
                nbEl.textContent = nbLabel;
                hdr.appendChild(nbEl);
            }
            if (label) {
                const lbl = document.createElement('span');
                lbl.className = 'nb-front-label';
                lbl.textContent = label;
                hdr.appendChild(lbl);
            }
            hdr.appendChild(refBtn);
            el.appendChild(hdr);

            // ── List ────────────────────────────────────────────────────────
            if (notes.length) {
                const list = document.createElement('ul');
                list.className = 'nb-nav-list';
                for (const n of notes) {
                    const li = document.createElement('li');
                    li.className = 'nb-nav-item';
                    if (n.meta && Object.keys(n.meta).length) {
                        li.dataset.tip = Object.entries(n.meta).map(([k, v]) => `${k}: ${v.replace(/\n/g,' ')}`).join('\n');
                    }
                    const icon = document.createElement('span');
                    icon.className = 'nb-nav-icon';
                    icon.textContent = n.type === 'todo' ? '☐' : '·';
                    const btn = document.createElement('button');
                    btn.className = 'nb-nav-link';
                    btn.textContent = n.title || n.filename;
                    btn.addEventListener('click', () => NbMain.openNote(n.selector));
                    li.appendChild(icon);
                    li.appendChild(btn);
                    if (multiNb && n.notebook) {
                        const badge = document.createElement('span');
                        badge.className = 'nb-front-nb-badge';
                        badge.textContent = n.notebook;
                        li.appendChild(badge);
                    }
                    list.appendChild(li);
                }
                el.appendChild(list);
            }

            // Default collapsed; restore open state on refresh
            toggle.textContent = wasOpen ? '▼' : '▶';
            if (wasOpen) el.classList.add('nb-front-open');

        } catch (e) {
            el.innerHTML = `<span class="nb-hl-error">⚠ ${_esc(e.message)}</span>`;
        }
    }

    // ── nav codeblock ─────────────────────────────────────────────────────────

    function _navParseQuery(raw) {
        raw = (raw || '').trim();
        if (/^[^/\s]+:/.test(raw)) {         // nb selector: notebook:folder/
            const colon = raw.indexOf(':');
            return { notebook: raw.slice(0, colon), folder: raw.slice(colon + 1).replace(/\/$/, '') };
        }
        const m = raw.replace(/^~/, '').match(/\/\.nb\/([^/]+)(\/(.+))?$/);
        if (m) {
            const nb = m[1];
            // Hidden dir (e.g. .test, .templates) — not an nb notebook, use raw fs listing
            if (nb.startsWith('.')) return { rawPath: raw };
            return { notebook: nb, folder: m[3] || '' };
        }
        if (raw) return { notebook: raw.replace(/^.*\//, ''), folder: '' };
        return { notebook: '', folder: '' };
    }

    // Entry point — called on first render and on refresh
    async function _loadNavBlock(el) {
        if (!_cbCan(el, 'nav', 'read')) { _cbDenyRead(el); return; }
        if (!el.dataset.navReady) {
            const parsed = _navParseQuery(el.dataset.query || '');
            if (parsed.rawPath !== undefined) {
                el.dataset.navRawPath = parsed.rawPath;
            } else {
                el.dataset.navNb     = parsed.notebook;
                el.dataset.navFolder = parsed.folder;
            }
            el.dataset.navReady = '1';
        }
        await _navRender(el);
    }

    // Navigate to a location and re-render.
    // Pass rawPath (string) to enter filesystem mode; omit/pass undefined to use nb mode.
    async function _navGo(el, notebook, folder, rawPath) {
        if (rawPath !== undefined) {
            el.dataset.navRawPath = rawPath;
            delete el.dataset.navNb;
            delete el.dataset.navFolder;
        } else {
            delete el.dataset.navRawPath;
            el.dataset.navNb     = notebook;
            el.dataset.navFolder = folder;
        }
        await _navRender(el);
    }

    async function _navRender(el) {
        const rawPath  = el.dataset.navRawPath || '';
        const notebook = el.dataset.navNb      || '';
        const folder   = el.dataset.navFolder  || '';
        const wasCollapsed = el.classList.contains('nb-collapsed');
        el.innerHTML = '';
        if (wasCollapsed) el.classList.add('nb-collapsed');

        try {
            if (rawPath) {
                const _r = await fetch(`/api/fs/list?path=${encodeURIComponent(rawPath)}`);
                if (_r.status === 403) { _cbDenyRead(el); return; }
                if (!_r.ok) throw new Error(`HTTP ${_r.status}`);
                const d = await _r.json();
                if (d.error) throw new Error(d.error);
                _navBuildFs(el, d.entries || [], d.path || rawPath);
            } else if (!notebook) {
                const d = await fetch('/api/nb/notebooks').then(r => r.json());
                const nbs = Array.isArray(d) ? d : (d.notebooks || []);
                _navBuildNotebooks(el, nbs);
            } else {
                const params = new URLSearchParams({ notebook, limit: 200 });
                if (folder) params.set('folder', folder);
                const r = await fetch(`/api/notes?${params}`);
                if (r.status === 403) { _cbDenyRead(el); return; }
                const d = await r.json();
                const notes = Array.isArray(d) ? d : (d.notes || []);
                _navBuildNotes(el, notes, notebook, folder);
            }
        } catch (e) {
            el.innerHTML = `<span class="nb-hl-error">⚠ ${_esc(e.message)}</span>`;
        }
    }

    function _navMakeHeader(el) {
        const hdr  = document.createElement('div');
        hdr.className = 'nb-nav-header';
        const acts = document.createElement('span');
        acts.className = 'nb-nav-acts';
        const refBtn = document.createElement('button');
        refBtn.className = 'nb-tw-btn nb-nav-refresh';
        refBtn.title = 'Refresh'; refBtn.textContent = '↻';
        refBtn.addEventListener('click', () => _loadNavBlock(el));
        acts.appendChild(refBtn);
        hdr.appendChild(acts);
        return hdr;
    }

    function _navHeader(el, notebook, folder) {
        const hdr   = _navMakeHeader(el);
        const crumbs = document.createElement('span');
        crumbs.className = 'nb-nav-crumbs nb-collapse-zone';

        const mkCrumb = (label, nb, fld, isCurrent) => {
            const b = document.createElement('button');
            b.className = 'nb-nav-crumb' + (isCurrent ? ' nb-nav-crumb-cur' : '');
            b.textContent = label;
            if (!isCurrent) b.addEventListener('click', e => { e.stopPropagation(); _navGo(el, nb, fld); });
            return b;
        };

        crumbs.appendChild(mkCrumb('nb', '', '', !notebook));
        if (notebook) {
            crumbs.insertAdjacentHTML('beforeend', '<span class="nb-nav-sep">›</span>');
            const folderParts = folder ? folder.split('/') : [];
            crumbs.appendChild(mkCrumb(notebook, notebook, '', folderParts.length === 0));
            folderParts.forEach((part, i) => {
                crumbs.insertAdjacentHTML('beforeend', '<span class="nb-nav-sep">›</span>');
                crumbs.appendChild(mkCrumb(part, notebook, folderParts.slice(0, i + 1).join('/'), i === folderParts.length - 1));
            });
        }
        hdr.prepend(crumbs);
        el.appendChild(hdr);
        _initCollapseToggle(el);
    }

    // Header for raw filesystem mode — breadcrumb shows path relative to .nb/
    function _navHeaderFs(el, absPath) {
        const hdr    = _navMakeHeader(el);
        const crumbs = document.createElement('span');
        crumbs.className = 'nb-nav-crumbs nb-collapse-zone';

        const nbBtn = document.createElement('button');
        nbBtn.className = 'nb-nav-crumb';
        nbBtn.textContent = 'nb';
        nbBtn.addEventListener('click', e => { e.stopPropagation(); _navGo(el, '', ''); });
        crumbs.appendChild(nbBtn);

        const parts  = absPath.split('/');
        const nbIdx  = parts.lastIndexOf('.nb');
        const rel    = nbIdx >= 0 ? parts.slice(nbIdx + 1) : [];
        rel.forEach((part, i) => {
            crumbs.insertAdjacentHTML('beforeend', '<span class="nb-nav-sep">›</span>');
            const isCurrent = i === rel.length - 1;
            const b = document.createElement('button');
            b.className = 'nb-nav-crumb' + (isCurrent ? ' nb-nav-crumb-cur' : '');
            b.textContent = part;
            if (!isCurrent) {
                const target = parts.slice(0, nbIdx + 1 + i + 1).join('/');
                b.addEventListener('click', e => { e.stopPropagation(); _navGo(el, undefined, undefined, target); });
            }
            crumbs.appendChild(b);
        });

        hdr.prepend(crumbs);
        el.appendChild(hdr);
        _initCollapseToggle(el);
    }

    // Build a raw filesystem listing (used for hidden dirs like .test, .templates)
    function _navBuildFs(el, entries, absPath) {
        _navHeaderFs(el, absPath);
        if (!entries.length) { el.insertAdjacentHTML('beforeend', '<div class="nb-nav-empty">Empty</div>'); return; }
        const list = document.createElement('ul');
        list.className = 'nb-nav-list';
        for (const entry of entries) {
            const li  = document.createElement('li');
            li.className = 'nb-nav-item' + (entry.isDir ? ' nb-nav-folder' : '');
            const icon = document.createElement('span');
            icon.className = 'nb-nav-icon';
            icon.textContent = entry.isDir ? '▸' : '·';
            const btn = document.createElement('button');
            btn.className = 'nb-nav-link';
            btn.textContent = entry.name;
            if (entry.isDir) {
                btn.addEventListener('click', () => _navGo(el, undefined, undefined, entry.path));
            } else {
                btn.addEventListener('click', () => NbMain.openNote(entry.path));
            }
            li.appendChild(icon);
            li.appendChild(btn);
            list.appendChild(li);
        }
        el.appendChild(list);
    }

    function _navBuildNotebooks(el, notebooks) {
        _navHeader(el, '', '');
        if (!notebooks.length) { el.insertAdjacentHTML('beforeend', '<div class="nb-nav-empty">No notebooks</div>'); return; }
        const list = document.createElement('ul');
        list.className = 'nb-nav-list';
        for (const nb of notebooks) {
            const li = document.createElement('li');
            li.className = 'nb-nav-item nb-nav-folder';
            li.innerHTML = `<span class="nb-nav-icon">▸</span>`;
            const btn = document.createElement('button');
            btn.className = 'nb-nav-link';
            btn.textContent = nb.name || nb.title || nb;
            if (nb.count != null) btn.insertAdjacentHTML('beforeend', ` <span class="nb-nav-count">${nb.count}</span>`);
            btn.addEventListener('click', () => _navGo(el, nb.name || nb, ''));
            li.appendChild(btn);
            list.appendChild(li);
        }
        el.appendChild(list);
    }

    function _navBuildNotes(el, notes, notebook, folder) {
        _navHeader(el, notebook, folder);
        if (!notes.length) { el.insertAdjacentHTML('beforeend', '<div class="nb-nav-empty">Empty</div>'); return; }
        const list = document.createElement('ul');
        list.className = 'nb-nav-list';
        for (const n of notes) {
            const isFolder = n.type === 'folder';
            const li = document.createElement('li');
            li.className = 'nb-nav-item' + (isFolder ? ' nb-nav-folder' : '');
            const icon = document.createElement('span');
            icon.className = 'nb-nav-icon';
            icon.textContent = isFolder ? '▸' : n.type === 'pdf' ? '⬜' : n.type === 'todo' ? '☐' : '·';
            const btn = document.createElement('button');
            btn.className = 'nb-nav-link';
            btn.textContent = n.title || n.filename || n.selector;
            if (isFolder) {
                const sub = folder ? `${folder}/${n.filename}` : n.filename;
                btn.addEventListener('click', () => _navGo(el, notebook, sub));
            } else {
                btn.addEventListener('click', () => NbMain.openNote(n.selector));
            }
            li.appendChild(icon);
            li.appendChild(btn);
            list.appendChild(li);
        }
        el.appendChild(list);
    }

    // ── test codeblock ────────────────────────────────────────────────────────
    // Form 1: "script | Label"  → clickable button; runs on click; resets on pass
    // Form 2: "script"          → auto-runs at render; invisible on pass+empty output

    // Collect the names of all scripts that will auto-run (Form 2) across a set
    // of .nb-test-block elements.  Used to build the batch request.
    function _collectAutoRunScripts(blocks) {
        const scripts = new Set();
        for (const el of blocks) {
            const raw   = (el.dataset.query || '').trim();
            const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length <= 1) {
                const line   = lines[0] || '';
                const pipe   = line.indexOf('|');
                const script = (pipe >= 0 ? line.slice(0, pipe) : line).trim();
                const label  = pipe >= 0 ? line.slice(pipe + 1).trim() : '';
                if (script && !label) scripts.add(script);
            } else {
                // Multi-script: only collect if the group has no label (auto-run mode)
                let groupLabel = '';
                const parsed = [];
                for (const line of lines) {
                    if (line.startsWith('|')) { groupLabel = groupLabel || line.slice(1).trim(); continue; }
                    const pipe   = line.indexOf('|');
                    const script = (pipe >= 0 ? line.slice(0, pipe) : line).trim();
                    const label  = pipe >= 0 ? line.slice(pipe + 1).trim() : '';
                    if (script) { parsed.push(script); groupLabel = groupLabel || label; }
                }
                if (!groupLabel) parsed.forEach(s => scripts.add(s));
            }
        }
        return [...scripts];
    }

    // POST /api/test/batch — one round trip for N scripts.  Returns a Map of
    // script → result.  On any error returns an empty Map so callers fall back
    // to individual /api/test/run fetches transparently.
    async function _fetchTestBatch(scripts, selector) {
        try {
            const r = await fetch('/api/test/batch', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ scripts, selector }),
            });
            if (!r.ok) return new Map();
            return new Map(Object.entries(await r.json()));
        } catch {
            return new Map();
        }
    }

    async function _loadTestBlock(el, batchMap = new Map()) {
        const raw   = (el.dataset.query || '').trim();
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

        if (lines.length <= 1) {
            // Single-script — existing behaviour unchanged
            const line   = lines[0] || '';
            const pipe   = line.indexOf('|');
            const script = (pipe >= 0 ? line.slice(0, pipe) : line).trim();
            const label  = pipe >= 0 ? line.slice(pipe + 1).trim() : '';
            if (!script) { el.remove(); return; }
            if (!_cbCan(el, 'test', 'read')) {
                if (label) _buildTestDenied(el, label, _cbLevel(el, 'test', 'read'));
                else       el.remove();
                return;
            }
            if (label) { _buildTestBtn(el, script, label); }
            else       { el.innerHTML = '<span class="nb-spin">⟳</span>'; await _runTest(el, script, null, null, batchMap.get(script) ?? null); }
            return;
        }

        // Multi-script group — parse scripts and optional group label
        // A line starting with | (no script) sets the group label only.
        const scripts = [];
        let groupLabel = '';
        for (const line of lines) {
            if (line.startsWith('|')) { groupLabel = groupLabel || line.slice(1).trim(); continue; }
            const pipe   = line.indexOf('|');
            const script = (pipe >= 0 ? line.slice(0, pipe) : line).trim();
            const label  = pipe >= 0 ? line.slice(pipe + 1).trim() : '';
            if (script) { scripts.push({ script, label }); groupLabel = groupLabel || label; }
        }
        if (!scripts.length) { el.remove(); return; }

        if (!_cbCan(el, 'test', 'read')) {
            if (groupLabel) _buildTestDenied(el, groupLabel, _cbLevel(el, 'test', 'read'));
            else            el.remove();
            return;
        }

        if (groupLabel) {
            _buildGroupBtn(el, scripts, groupLabel);
        } else {
            el.innerHTML = '<span class="nb-spin">⟳</span>';
            await _runGroupTest(el, scripts, null, null, batchMap);
        }
    }

    function _buildTestDenied(el, label, level) {
        el.innerHTML = '';
        const btn = document.createElement('button');
        btn.className = 'nb-test-btn';
        btn.textContent = `▶ ${label}`;
        const out = document.createElement('div');
        out.className = 'nb-test-out';
        btn.addEventListener('click', () => {
            out.textContent = `🔒 Requires ${level} access`;
        });
        el.appendChild(btn);
        el.appendChild(out);
    }

    function _buildGroupBtn(el, scripts, label) {
        el.innerHTML = '';
        const btn = document.createElement('button');
        btn.className = 'nb-test-btn';
        btn.textContent = `▶ ${label}`;
        const out = document.createElement('div');
        out.className = 'nb-test-out';
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = '⟳ …';
            out.innerHTML = '';
            await _runGroupTest(el, scripts, btn, out);
            btn.disabled = false;
            btn.textContent = `▶ ${label}`;
        });
        el.appendChild(btn);
        el.appendChild(out);
    }

    async function _runGroupTest(el, scripts, btn, out, batchMap = new Map()) {
        const selector = NbMain.activeSelector() || '';
        const force    = btn !== null;   // user-clicked = always fresh; auto-run = cacheable
        const results  = await Promise.all(scripts.map(async ({ script }) => {
            if (!force && batchMap.has(script)) {
                return { script, ...batchMap.get(script) };
            }
            try {
                const r = await fetch('/api/test/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ script, selector, force }),
                });
                return { script, ...(await r.json()) };
            } catch (e) {
                return { script, error: String(e), exit_code: 1, stdout: '' };
            }
        }));

        const failures = results.filter(r => r.exit_code !== 0 || (r.stdout || '').trim() || r.error);
        if (!failures.length) { if (!btn) el.remove(); return; }

        const result  = document.createElement('div');
        result.className = 'nb-test-result';

        const dismiss = document.createElement('button');
        dismiss.className = 'nb-test-dismiss';
        dismiss.title = 'Dismiss until next render';
        dismiss.textContent = '×';
        dismiss.addEventListener('click', () => { el.innerHTML = ''; });
        result.appendChild(dismiss);

        const wrap = document.createElement('div');
        wrap.className = 'nb-rendered nb-group-result';

        const hdr = document.createElement('p');
        hdr.className = 'nb-group-hdr';
        hdr.textContent = `${failures.length} of ${scripts.length} check${scripts.length !== 1 ? 's' : ''} failed`;
        wrap.appendChild(hdr);

        failures.forEach(({ script, stdout, error, exit_code }) => {
            const entry = scripts.find(s => s.script === script);
            const label = (entry && entry.label) || script;
            const text  = (stdout || '').trim() || error || '';

            const row = document.createElement('div');
            row.className = 'nb-subtest';

            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'nb-subtest-toggle';
            toggleBtn.textContent = label;

            const body = document.createElement('div');
            body.className = 'nb-subtest-body';
            body.hidden = true;

            const inner = document.createElement('div');
            inner.className = 'nb-rendered' + (exit_code !== 0 ? ' nb-test-fail' : '');
            inner.innerHTML = NbMain.renderMarkdown(text, '');
            NbMain.enrichRendered(inner, null);
            body.appendChild(inner);

            toggleBtn.addEventListener('click', () => {
                body.hidden = !body.hidden;
                if (body.hidden) toggleBtn.removeAttribute('data-open');
                else toggleBtn.dataset.open = '1';
            });

            row.appendChild(toggleBtn);
            row.appendChild(body);
            wrap.appendChild(row);
        });

        result.appendChild(wrap);
        if (out) { out.appendChild(result); }
        else      { el.innerHTML = ''; el.appendChild(result); }
    }

    function _buildTestBtn(el, script, label) {
        el.innerHTML = '';
        const btn = document.createElement('button');
        btn.className = 'nb-test-btn';
        btn.textContent = `▶ ${label}`;
        const out = document.createElement('div');
        out.className = 'nb-test-out';
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = '⟳ …';
            out.innerHTML = '';
            await _runTest(el, script, btn, out);
            btn.disabled = false;
            btn.textContent = `▶ ${label}`;
        });
        el.appendChild(btn);
        el.appendChild(out);
    }

    async function _runTest(el, script, btn, out, cachedResult = null) {
        const selector = NbMain.activeSelector() || '';
        const force    = btn !== null;   // user-clicked = always fresh; auto-run = cacheable
        let d;
        if (cachedResult && !force) {
            d = cachedResult;
        } else {
            try {
                const r = await fetch('/api/test/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ script, selector, force }),
                });
                d = await r.json();
            } catch (e) {
                d = { error: String(e), exit_code: 1, stdout: '' };
            }
        }

        const stdout = (d.stdout || '').trim();
        const pass   = d.exit_code === 0 && !stdout && !d.error;

        if (pass) {
            // Form 2: vanish; Form 1: button already resets in _buildTestBtn
            if (!btn) el.remove();
            return;
        }

        const text = d.error && !stdout ? `⚠ ${d.error}` : stdout || d.error || '';
        const result = document.createElement('div');
        result.className = 'nb-test-result';

        const dismiss = document.createElement('button');
        dismiss.className = 'nb-test-dismiss';
        dismiss.title = 'Dismiss until next render';
        dismiss.textContent = '×';
        dismiss.addEventListener('click', () => { el.innerHTML = ''; });
        result.appendChild(dismiss);

        const wrap = document.createElement('div');
        wrap.className = 'nb-rendered' + (d.exit_code !== 0 ? ' nb-test-fail' : '');
        wrap.innerHTML = NbMain.renderMarkdown(text, '');
        NbMain.enrichRendered(wrap, null);
        result.appendChild(wrap);

        _enrichSubtests(wrap);
        if (out) {
            out.appendChild(result);
        } else {
            el.innerHTML = '';
            el.appendChild(result);
        }
    }

    // Converts [label](subtest:scriptname) links inside a test result into
    // toggle buttons that run the named script and expand its output inline.
    function _enrichSubtests(container) {
        if (!container.innerHTML.includes('subtest:')) return;   // #5: fast guard
        container.querySelectorAll('a[href^="subtest:"]').forEach(a => {
            const script = a.getAttribute('href').slice('subtest:'.length);
            const label  = a.textContent;

            const wrap = document.createElement('span');
            wrap.className = 'nb-subtest';

            const btn = document.createElement('button');
            btn.className = 'nb-subtest-toggle';
            btn.textContent = label;

            const body = document.createElement('div');
            body.className = 'nb-subtest-body';
            body.hidden = true;

            btn.addEventListener('click', async () => {
                if (!body.hidden) {
                    body.hidden = true;
                    btn.removeAttribute('data-open');
                    return;
                }
                if (body.children.length) {
                    body.hidden = false;
                    btn.dataset.open = '1';
                    return;
                }
                btn.disabled = true;
                const saved = btn.textContent;
                btn.textContent = '⟳ …';

                const selector = NbMain.activeSelector() || '';
                let d;
                try {
                    const r = await fetch('/api/test/run', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ script, selector, force: true }),
                    });
                    d = await r.json();
                } catch (e) {
                    d = { error: String(e), exit_code: 1, stdout: '' };
                }

                const text = (d.stdout || '').trim() || d.error || '✓ Check passed.';
                const inner = document.createElement('div');
                inner.className = 'nb-rendered' + (d.exit_code !== 0 ? ' nb-test-fail' : '');
                inner.innerHTML = NbMain.renderMarkdown(text, '');
                NbMain.enrichRendered(inner, null);
                body.appendChild(inner);
                body.hidden = false;

                btn.disabled = false;
                btn.textContent = saved;
                btn.dataset.open = '1';
            });

            wrap.appendChild(btn);
            wrap.appendChild(body);
            a.replaceWith(wrap);
        });
    }

    // ── Plugin registration ───────────────────────────────────────────────────

    NbWeb.registerModule('codeblocks', {

        label:       'NbWeb-codeblocks',
        description: 'Live fenced code block renderers (tw, hledger, t, nb, git)',
        helpUrl:     '/plugins/nbweb-codeblocks.md',

        codeblockRenderers: [
            {
                lang:   'tw',
                html:   text => { const {readLevel,writeLevel,query} = _cbParseGates(text); return `<div class="nb-tw-block"${_cbGateAttrs(readLevel,writeLevel)} data-query="${query.replace(/"/g,'&quot;')}"><span class="nb-spin">⟳</span></div>`; },
                render: async container => {
                    const blocks = [...container.querySelectorAll('.nb-tw-block')];
                    if (!blocks.length) return;
                    NbWeb.statusPill?.add(blocks.length);
                    try {
                        const w = await NbWeb.checkWhich('task');
                        await Promise.all(blocks.map(async el => {
                            try { await (w.found ? _loadTwBlock(el) : NbWeb.renderRequirementsCard(el, '/plugins/requirements/tw-requirements.md')); }
                            finally { NbWeb.statusPill?.tick(); }
                        }));
                    } catch { blocks.forEach(() => NbWeb.statusPill?.tick()); }
                },
            },
            {
                lang:   'hledger',
                html:   text => {
                    const collapsed = /^#\s*collapsed\b/im.test(text);
                    const {readLevel, writeLevel, query} = _cbParseGates(text.split('\n').filter(l => !/^#\s*collapsed\b/i.test(l.trim())).join('\n'));
                    return `<div class="nb-hl-block${collapsed ? ' nb-collapsed' : ''}"${_cbGateAttrs(readLevel,writeLevel)} data-query="${query.replace(/"/g,'&quot;')}"${collapsed ? ' data-init-collapsed' : ''}><span class="nb-spin">⟳</span></div>`;
                },
                render: async container => {
                    const blocks = [...container.querySelectorAll('.nb-hl-block')];
                    if (!blocks.length) return;
                    NbWeb.statusPill?.add(blocks.length);
                    try {
                        const w = await NbWeb.checkWhich('hledger');
                        await Promise.all(blocks.map(async el => {
                            try { await (w.found ? _loadHledgerBlock(el) : NbWeb.renderRequirementsCard(el, '/plugins/requirements/hledger-requirements.md')); }
                            finally { NbWeb.statusPill?.tick(); }
                        }));
                    } catch { blocks.forEach(() => NbWeb.statusPill?.tick()); }
                },
            },
            {
                lang:   'nav',
                html:   text => { const {readLevel,writeLevel,query} = _cbParseGates(text); return `<div class="nb-nav-block"${_cbGateAttrs(readLevel,writeLevel)} data-query="${query.replace(/"/g,'&quot;')}"><span class="nb-spin">⟳</span></div>`; },
                render: async container => {
                    const blocks = [...container.querySelectorAll('.nb-nav-block')];
                    if (!blocks.length) return;
                    NbWeb.statusPill?.add(blocks.length);
                    await Promise.all(blocks.map(async el => { try { await _loadNavBlock(el); } finally { NbWeb.statusPill?.tick(); } }));
                },
            },
            {
                lang:   'front',
                html:   text => { const {readLevel,writeLevel,query} = _cbParseGates(text); return `<div class="nb-front-block"${_cbGateAttrs(readLevel,writeLevel)} data-query="${query.replace(/"/g,'&quot;')}"><span class="nb-spin">⟳</span></div>`; },
                render: async container => {
                    const blocks = [...container.querySelectorAll('.nb-front-block')];
                    if (!blocks.length) return;
                    NbWeb.statusPill?.add(blocks.length);
                    await Promise.all(blocks.map(async el => { try { await _loadFrontBlock(el); } finally { NbWeb.statusPill?.tick(); } }));
                },
            },
            {
                lang:   't',
                html:   text => { const {readLevel,writeLevel,query} = _cbParseGates(text); return `<div class="nb-t-block"${_cbGateAttrs(readLevel,writeLevel)} data-period="${query.replace(/"/g,'&quot;')}"><span class="nb-spin">⟳</span></div>`; },
                render: async container => {
                    const blocks = [...container.querySelectorAll('.nb-t-block')];
                    if (!blocks.length) return;
                    NbWeb.statusPill?.add(blocks.length);
                    await Promise.all(blocks.map(async el => { try { await _loadTBlock(el); } finally { NbWeb.statusPill?.tick(); } }));
                },
            },
            {
                lang:   'nb',
                html:   text => { const {readLevel,writeLevel,query} = _cbParseGates(text); return `<div class="nb-nb-block"${_cbGateAttrs(readLevel,writeLevel)} data-cmd="${query.toLowerCase().replace(/"/g,'&quot;')}"><span class="nb-spin">⟳</span></div>`; },
                render: async container => {
                    const blocks = [...container.querySelectorAll('.nb-nb-block')];
                    if (!blocks.length) return;
                    NbWeb.statusPill?.add(blocks.length);
                    await Promise.all(blocks.map(async el => { try { await _loadNbBlock(el); } finally { NbWeb.statusPill?.tick(); } }));
                },
            },
            {
                lang:   'git',
                html:   text => { const {readLevel,writeLevel,query} = _cbParseGates(text); return `<div class="nb-git-block"${_cbGateAttrs(readLevel,writeLevel)} data-cmd="${query.replace(/"/g,'&quot;')}"><span class="nb-spin">⟳</span></div>`; },
                render: async container => {
                    const blocks = [...container.querySelectorAll('.nb-git-block')];
                    if (!blocks.length) return;
                    NbWeb.statusPill?.add(blocks.length);
                    await Promise.all(blocks.map(async el => { try { await _loadGitBlock(el); } finally { NbWeb.statusPill?.tick(); } }));
                },
            },
            {
                lang: 'tui',
                // html() emits the full structure immediately so the header is visible
                // before any slow codeblock renderers (hledger queries etc.) run.
                html: text => {
                    const {readLevel, writeLevel, query} = _cbParseGates(text);
                    const lines  = query.trim().split('\n');
                    const height = (query.match(/^#\s*height[=:]\s*(\d+)/m) || [])[1] || '400';
                    const body   = lines.filter(l => !l.startsWith('#')).join(' ').trim();
                    const pipe   = body.indexOf('|');
                    const cmd    = (pipe >= 0 ? body.slice(0, pipe) : body).trim();
                    const label  = pipe >= 0 ? body.slice(pipe + 1).trim() : '';
                    return `<div class="nb-tui-block"${_cbGateAttrs(readLevel,writeLevel)}>${_tuiBuildHtml(cmd, label, parseInt(height) || 400)}</div>`;
                },
                // render() just wires event handlers — the HTML is already in the DOM.
                render: async container => {
                    const outers = [...container.querySelectorAll('.nb-tui-block > .nb-tui-outer:not([data-tui-wired])')];
                    if (!outers.length) return;
                    NbWeb.statusPill?.add(outers.length);
                    _tuiInjectStyle();
                    await _loadXterm();
                    if (!window.Terminal) {
                        outers.forEach(outer => {
                            outer.innerHTML = `<div style="padding:8px;color:var(--orange,#e07b39);font-size:12px">⚠ xterm.js failed to load</div>`;
                            NbWeb.statusPill?.tick();
                        });
                        return;
                    }
                    for (const outer of outers) {
                        const block = outer.closest('.nb-tui-block');
                        if (block && !_cbCan(block, 'tui', 'read')) {
                            _cbDenyRead(block);
                            NbWeb.statusPill?.tick();
                            continue;
                        }
                        outer.dataset.tuiWired = '1';
                        try { _tuiWire(outer); }
                        catch (e) {
                            console.error('[tui] wire error:', e);
                            outer.innerHTML = `<div style="padding:8px;color:var(--red,#ef4444);font-size:12px">⚠ tui error: ${_esc(String(e))}</div>`;
                        } finally {
                            NbWeb.statusPill?.tick();
                        }
                    }
                },
            },
            {
                lang:   'test',
                html:   text => { const {readLevel,writeLevel,query} = _cbParseGates(text); return `<div class="nb-test-block"${_cbGateAttrs(readLevel,writeLevel)} data-query="${query.replace(/"/g,'&quot;')}"></div>`; },
                render: async container => {
                    const blocks = [...container.querySelectorAll('.nb-test-block')];
                    if (!blocks.length) return;
                    NbWeb.statusPill?.add(blocks.length);

                    // Collect all auto-run scripts across every block, fetch in one
                    // round trip, then distribute cached results to each block.
                    const selector   = NbMain.activeSelector() || '';
                    const autoScripts = _collectAutoRunScripts(blocks);
                    const batchMap   = autoScripts.length
                        ? await _fetchTestBatch(autoScripts, selector)
                        : new Map();

                    await Promise.all(blocks.map(async el => {
                        try { await _loadTestBlock(el, batchMap); }
                        finally { NbWeb.statusPill?.tick(); }
                    }));
                    container.dispatchEvent(new CustomEvent('nb-tests-settled', { bubbles: false }));
                },
            },
        ],

    });

    // Export FM utilities so main.js can use them in the card-footer Changes button
    // without duplicating the helpers.
    NbWeb.fmUtils = { parseFields: _fmParseFields, patch: _fmPatch, widget: _fmWidget };

})();

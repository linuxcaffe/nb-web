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

    // ── .lib barblock extras — ? help and Open buttons ────────────────────────
    // Populated by /api/lib/block-extras on load. Shape: {help:{lang:selector}, open:{lang:selector}}
    // Absent = no file exists for that lang (button invisible).

    let _blockExtras = {};
    fetch('/api/lib/block-extras').then(r => r.json()).then(d => { _blockExtras = d || {}; }).catch(() => {});

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

    function _cbError(el, lang, message, onRefresh) {
        el.innerHTML = '';
        const cls = lang === 'cfg' ? 'config' : lang;
        const { hdr, meta } = _buildBarHeader(el, { lang, cls, onRefresh });
        meta.innerHTML = `<span class="nb-cb-err">⚠ ${_esc(message)}</span>`;
        el.appendChild(hdr);
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

    // Block icons — image-backed or CAPS text badge. Always visible in header.
    // Image blocks: served from ~/.nb/.images/ via /api/file?selector=.images:*
    // Native blocks: short CAPS label styled as a monospace chip.
    const _CB_ICONS = {
        hl:       { img: '.images:hledger-logo.png', alt: 'hledger' },
        chart:    { img: '.images:pie-chart.svg',    alt: 'chart' },
        tw:       { img: '.images:tw-logo.png',      alt: 'Taskwarrior' },
        git:      { img: '.images:git-logo.png',     alt: 'git' },
        nb:       { img: 'nb-logo.png',              alt: 'nb', direct: true },
        t:        { img: '.images:t-logo.png',       alt: 't' },
        tui:      { text: 'TUI' },
        nav:      { text: 'NAV' },
        fm:       { text: 'FM'  },
        cfg:      { text: 'CFG' },
        gallery:  { text: 'GAL' },
        toc:      { text: 'TOC' },
        test:     { text: 'TST' },
        timedot:  { text: '⏱', emoji: true },
    };

    function _cbIcon(blockType) {
        const spec = _CB_ICONS[blockType];
        const el = document.createElement(spec?.img ? 'img' : 'span');
        el.className = 'nb-cb-icon';
        if (spec?.img) {
            el.src = spec.direct
                ? `/${spec.img}`
                : `/api/file?selector=${encodeURIComponent(spec.img)}`;
            el.alt = spec.alt || blockType;
            el.title = spec.alt || blockType;
        } else {
            el.textContent = spec?.text || blockType.slice(0, 3).toUpperCase();
            if (spec?.large)  el.classList.add('nb-cb-icon--large');
            if (spec?.emoji)  el.classList.add('nb-cb-icon--emoji');
            el.setAttribute('aria-label', blockType);
        }
        return el;
    }

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
        if (!header || header.dataset.collapseWired) return;
        header.dataset.collapseWired = '1';
        const key = _collapseKey(block);
        const apply = collapsed => block.classList.toggle('nb-collapsed', collapsed);
        apply(localStorage.getItem(key) === '1');
        const toggle = e => {
            e.stopPropagation();
            const collapsed = !block.classList.contains('nb-collapsed');
            apply(collapsed);
            collapsed ? localStorage.setItem(key, '1') : localStorage.removeItem(key);
        };
        header.addEventListener('click', toggle);
        header.querySelectorAll('.nb-collapse-zone').forEach(z =>
            z.addEventListener('click', toggle));
    }

    // Shared barblock header factory — icon + meta placeholder + acts (help? + refresh?).
    // Returns { hdr, meta, acts, refBtn, helpBtn } so callers can fill meta and prepend extra acts buttons.
    // cls overrides lang for CSS class names when the icon key and CSS prefix differ (e.g. lang:'cfg', cls:'config').
    function _buildBarHeader(el, { lang, cls, collapseZone = false, onRefresh, onHelp } = {}) {
        const blockCls = cls || lang;
        const hdr = document.createElement('div');
        hdr.className = `nb-barblock nb-${blockCls}-header` + (collapseZone ? ' nb-collapse-zone' : '');
        hdr.appendChild(_cbIcon(lang));
        const meta = document.createElement('span');
        meta.className = `nb-${blockCls}-meta`;
        hdr.appendChild(meta);
        const acts = document.createElement('span');
        acts.className = 'nb-barblock-acts';

        // Lib-based help overrides hardcoded onHelp; lib-based Open is always additive
        const libHelp = lang ? _blockExtras?.help?.[lang] : null;
        const libOpen = lang ? _blockExtras?.open?.[lang] : null;
        const effectiveHelp = libHelp ? btn => _showLibHelp(btn, lang, libHelp) : onHelp;

        let helpBtn = null;
        if (effectiveHelp) {
            helpBtn = document.createElement('button');
            helpBtn.className = 'nb-tw-btn';
            helpBtn.title = 'Help'; helpBtn.textContent = '?';
            helpBtn.addEventListener('click', e => { e.stopPropagation(); effectiveHelp(helpBtn); });
            acts.appendChild(helpBtn);
        }
        if (libOpen) {
            const openBtn = document.createElement('button');
            openBtn.className = 'nb-tw-btn nb-lib-open-btn';
            openBtn.title = 'Open'; openBtn.textContent = '⎋';
            openBtn.addEventListener('click', e => { e.stopPropagation(); _execLibOpen(openBtn, lang); });
            acts.appendChild(openBtn);
        }
        let refBtn = null;
        if (onRefresh) {
            refBtn = document.createElement('button');
            refBtn.className = 'nb-tw-btn nb-barblock-refresh';
            refBtn.title = 'Refresh'; refBtn.textContent = '↻';
            refBtn.addEventListener('click', e => { e.stopPropagation(); onRefresh(); });
            acts.appendChild(refBtn);
        }
        hdr.appendChild(acts);
        return { hdr, meta, acts, refBtn, helpBtn };
    }

    function _showLibHelp(trigger, lang, selector) {
        if (trigger._libHelpPop) {
            trigger._libHelpPop.remove();
            trigger._libHelpPop = null;
            trigger.classList.remove('nb-lib-btn-active');
            return;
        }
        trigger.classList.add('nb-lib-btn-active');
        const pop = document.createElement('div');
        pop.className = 'nb-lib-help-pop';
        pop.innerHTML = '<span class="nb-spin">⟳</span>';
        document.body.appendChild(pop);
        const rect = trigger.getBoundingClientRect();
        pop.style.top  = (rect.bottom + 4) + 'px';
        pop.style.left = rect.left + 'px';

        fetch(`/api/note?selector=${encodeURIComponent(selector)}`)
            .then(r => r.json())
            .then(d => {
                const body = d.body || '';
                pop.innerHTML = body
                    ? (typeof marked !== 'undefined' ? marked.parse(body) : `<pre>${_esc(body)}</pre>`)
                    : '<em style="padding:8px;display:block;color:var(--muted)">No content</em>';
                const pr = pop.getBoundingClientRect();
                if (pr.right > window.innerWidth - 8)
                    pop.style.left = Math.max(8, rect.right - pr.width) + 'px';
                if (pr.bottom > window.innerHeight - 8)
                    pop.style.top  = Math.max(8, rect.top - pr.height - 4) + 'px';
            })
            .catch(() => { pop.innerHTML = '<em style="padding:8px;display:block">Error loading help</em>'; });

        trigger._libHelpPop = pop;
        const dismiss = () => {
            pop.remove();
            trigger._libHelpPop = null;
            trigger.classList.remove('nb-lib-btn-active');
            document.removeEventListener('click', outside, true);
        };
        const outside = e => { if (!pop.contains(e.target) && e.target !== trigger) dismiss(); };
        setTimeout(() => document.addEventListener('click', outside, true), 0);
    }

    function _dispatchLibOpen(out) {
        if (!out) return;
        if (out.startsWith('nb:'))   { NbMain.openNote(out.slice(3)); return; }
        if (out.startsWith('file:')) { NbMain.openNote(out.slice(5)); return; }
        if (out.startsWith('term:')) { NbTerminal.run(out.slice(5)); return; }
        if (/^https?:\/\//.test(out)) { window.open(out, '_blank'); return; }
    }

    function _execLibOpen(trigger, lang, { journal: journalOverride } = {}) {
        const isBtn = trigger.tagName === 'BUTTON';
        if (isBtn) trigger.disabled = true;
        else trigger.classList.add('nb-lib-loading');
        const sel      = NbMain.activeSelector() || '';
        const notebook = sel.includes(':') ? sel.slice(0, sel.indexOf(':')) : '';
        const note     = NbMain.activeNote();
        const journal  = journalOverride ?? note?.effective_fm?.journal ?? note?.meta?.journal ?? '';
        fetch('/api/lib/block-open', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ lang, notebook, journal }),
        })
        .then(r => r.json())
        .then(d => {
            if (d.error) {
                if (isBtn) { trigger.title = d.error; trigger.textContent = '⚠'; setTimeout(() => { trigger.title = 'Open'; trigger.textContent = '⎋'; }, 3000); }
                else console.error('lib open:', lang, d.error);
                return;
            }
            _dispatchLibOpen(d.output || '');
        })
        .catch(e => { console.error('lib open:', e); })
        .finally(() => {
            if (isBtn) trigger.disabled = false;
            else trigger.classList.remove('nb-lib-loading');
        });
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
        const period  = el.dataset.period || 'today';
        const dotMode = el.dataset.dotMode === '1';
        // FM file overrides (note.meta.timelog_file / note.meta.timedot_file)
        const meta    = typeof NbMain !== 'undefined' ? NbMain.activeNote?.()?.meta || {} : {};
        const tcFile  = meta.timelog_file || null;
        const tdFile  = meta.timedot_file || null;
        const tcQ     = tcFile ? `&file=${encodeURIComponent(tcFile)}` : '';
        const tdQ     = tdFile ? `&file=${encodeURIComponent(tdFile)}` : '';
        try {
            if (dotMode) {
                const [tdStatus, tdReport, tcReport] = await Promise.all([
                    fetch(`/api/t/timedot/status?period=${encodeURIComponent(period)}${tdQ}`).then(r => r.json()),
                    fetch(`/api/t/timedot/report?period=${encodeURIComponent(period)}${tdQ}`).then(r => r.json()),
                    fetch(`/api/t/report?period=${encodeURIComponent(period)}${tcQ}`).then(r => r.json()),
                ]);
                _buildTBlock(el, null, tdReport, period, { dotMode: true, tdStatus, tcReport });
            } else {
                const [status, tcReport, tdReport] = await Promise.all([
                    fetch(`/api/t/status?${tcQ.slice(1)}`).then(r => r.json()),
                    fetch(`/api/t/report?period=${encodeURIComponent(period)}${tcQ}`).then(r => r.json()),
                    fetch(`/api/t/timedot/report?period=${encodeURIComponent(period)}${tdQ}`).then(r => r.json()),
                ]);
                _buildTBlock(el, status, tcReport, period, { dotMode: false, tdReport });
            }
        } catch(e) {
            el.innerHTML = `<span class="nb-t-error">⚠ ${_esc(e.message)}</span>`;
        }
        _initCollapseToggle(el);
    }

    function _buildTBlock(el, status, report, period, opts = {}) {
        const { dotMode = false, tdStatus = null, tdReport = null, tcReport = null } = opts;
        el.innerHTML = '';

        const hdr = document.createElement('div');
        hdr.className = 'nb-t-header';

        const statusEl = document.createElement('div');
        statusEl.className = 'nb-t-status';

        if (dotMode) {
            // Dot mode: show last timedot entry
            const s = tdStatus || {};
            if (s.state === 'has_entries') {
                statusEl.innerHTML =
                    `<span class="nb-t-dot nb-t-dot-td">◦</span>` +
                    `<span class="nb-t-account">${_esc(s.account)}</span>` +
                    `<span class="nb-t-desc">${_esc(s.time)}</span>` +
                    `<span class="nb-t-elapsed">${_esc(s.date || '')}</span>`;
            } else {
                statusEl.innerHTML = `<span class="nb-t-dot nb-t-dot-out">◦</span><span class="nb-t-desc">No timedot entries</span>`;
            }
        } else if (status?.state === 'in') {
            const elapsed = status.elapsed_seconds || 0;
            statusEl.innerHTML =
                `<span class="nb-t-dot nb-t-dot-in">⏱</span>` +
                `<span class="nb-t-account">${_esc(status.account)}</span>` +
                (status.desc ? `<span class="nb-t-desc">${_esc(status.desc)}</span>` : '') +
                `<span class="nb-t-elapsed" data-start="${Date.now() - elapsed * 1000}">${_fmtSeconds(elapsed)}</span>`;
        } else if (status?.state === 'out') {
            statusEl.innerHTML =
                `<span class="nb-t-dot nb-t-dot-out">◌</span>` +
                `<span class="nb-t-out-label">OUT</span>` +
                `<span class="nb-t-desc">${_esc(status.account)} · ${_esc(status.last_out)}</span>`;
        } else {
            statusEl.innerHTML = `<span class="nb-t-dot nb-t-dot-out">○</span><span class="nb-t-desc">No entries</span>`;
        }

        const acts = document.createElement('div');
        acts.className = 'nb-t-actions';

        // Dot-mode toggle button
        const dotBtn = document.createElement('button');
        dotBtn.className = 'nb-tw-btn nb-t-btn nb-t-dot-toggle' + (dotMode ? ' active' : '');
        dotBtn.title = dotMode ? 'Switch to timeclock mode' : 'Switch to timedot mode';
        dotBtn.textContent = dotMode ? 'tc' : '.';
        dotBtn.addEventListener('click', () => {
            el.dataset.dotMode = dotMode ? '0' : '1';
            _loadTBlock(el);
        });
        acts.appendChild(dotBtn);

        if (!dotMode) {
            if (status?.state === 'in') {
                const outBtn = document.createElement('button');
                outBtn.className = 'nb-tw-btn nb-t-btn nb-t-out-btn';
                outBtn.title = 'Clock out';
                outBtn.textContent = '◼ Out';
                outBtn.addEventListener('click', async () => {
                    outBtn.disabled = true;
                    const meta = typeof NbMain !== 'undefined' ? NbMain.activeNote?.()?.meta || {} : {};
                    const body = meta.timelog_file ? JSON.stringify({ file: meta.timelog_file }) : '{}';
                    const d = await fetch('/api/t/out', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
                    }).then(r => r.json()).catch(() => ({}));
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
        }

        const refBtn = document.createElement('button');
        refBtn.className = 'nb-tw-btn nb-t-btn';
        refBtn.title = 'Refresh';
        refBtn.textContent = '↻';
        refBtn.addEventListener('click', () => _loadTBlock(el));
        acts.appendChild(refBtn);

        hdr.append(statusEl, acts);
        hdr.insertBefore(_cbIcon('t'), hdr.firstChild);
        el.appendChild(hdr);

        // Report rows (timeclock in tc-mode, timedot in dot-mode)
        const activeReport = dotMode ? report : report;  // both paths use `report` arg
        if (activeReport?.rows?.length) {
            const rpt = document.createElement('div');
            rpt.className = 'nb-t-report';
            activeReport.rows.forEach(row => {
                const r = document.createElement('div');
                r.className = 'nb-t-row';
                if (dotMode) {
                    const hrs = row.hours || 0;
                    r.innerHTML = `<span class="nb-t-r-acct">${_esc(row.account)}</span><span class="nb-t-r-time">${hrs.toFixed(1)}h</span>`;
                } else {
                    r.innerHTML = `<span class="nb-t-r-acct">${_esc(row.account)}</span><span class="nb-t-r-time">${_fmtSeconds(row.seconds)}</span>`;
                }
                rpt.appendChild(r);
            });

            // Combined total footer: tc total + td total when both have data
            const tcTotalSecs  = dotMode ? (tcReport?.total_seconds || 0) : (activeReport?.total_seconds || 0);
            const tdTotalHrs   = dotMode ? (activeReport?.total_hours || 0) : (tdReport?.total_hours || 0);
            const hasBoth      = tcTotalSecs > 0 && tdTotalHrs > 0;

            const tot = document.createElement('div');
            tot.className = 'nb-t-row nb-t-total';
            if (dotMode) {
                const dHrs = (activeReport.total_hours || 0).toFixed(1);
                tot.innerHTML = `<span class="nb-t-r-acct">${period || 'today'} (td)</span><span class="nb-t-r-time">${dHrs}h</span>`;
            } else {
                tot.innerHTML = `<span class="nb-t-r-acct">${period || 'today'} (tc)</span><span class="nb-t-r-time">${_fmtSeconds(activeReport.total_seconds)}</span>`;
            }
            rpt.appendChild(tot);

            if (hasBoth) {
                const tcH = tcTotalSecs / 3600;
                const combined = document.createElement('div');
                combined.className = 'nb-t-row nb-t-combined';
                const tcStr = dotMode ? `${tcH.toFixed(1)}h tc` : _fmtSeconds(tcTotalSecs) + ' tc';
                const tdStr = `${tdTotalHrs.toFixed(1)}h td`;
                const sumH  = tcH + tdTotalHrs;
                combined.innerHTML =
                    `<span class="nb-t-r-acct">${tcStr} + ${tdStr}</span>` +
                    `<span class="nb-t-r-time">${sumH.toFixed(1)}h</span>`;
                rpt.appendChild(combined);
            }

            el.appendChild(rpt);
        }

        if (!dotMode && status?.state === 'in') {
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

        const tcFile   = typeof NbMain !== 'undefined' ? NbMain.activeNote?.()?.meta?.timelog_file || null : null;
        const fileQ    = tcFile ? `?file=${encodeURIComponent(tcFile)}` : '';
        const accounts = await fetch(`/api/t/accounts${fileQ}`).then(r => r.json()).then(d => d.accounts || []).catch(() => []);

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
            const payload = { account, desc: descInput.value.trim() };
            if (tcFile) payload.file = tcFile;
            const d = await fetch('/api/t/in', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
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
            if (d.error) { _cbError(el, 'tw', d.error, () => _loadTwBlock(el)); return; }
            const twLaunch = d.twTerminalMode ? {terminal: true, cmd: d.twLaunchCmd}
                           : d.twWebUrl      ? {url: d.twWebUrl}
                           : null;
            _buildTwTable(el, (d.tasks || []).sort((a, b) => (b.urgency || 0) - (a.urgency || 0)), q, colSpec, twLaunch);
        } catch(e) {
            _cbError(el, 'tw', e.message, () => _loadTwBlock(el));
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
        const filterHtml = q ? ` <code>${_esc(q)}</code>` : '';
        const twTitle = !launch         ? 'Configure launch in Settings → Codeblocks'
                      : launch.terminal ? 'Run in terminal'
                      :                   'Open in tw-web';
        const { hdr, meta, acts, refBtn } = _buildBarHeader(el, { lang: 'tw', onRefresh: () => _loadTwBlock(el) });
        meta.innerHTML = `<span class="nb-tw-name" title="${twTitle}">task</span><span class="nb-tw-count">${tasks.length}</span>${filterHtml}`;
        const twNameEl = hdr.querySelector('.nb-tw-name');
        twNameEl.addEventListener('click', async () => {
            if (_blockExtras?.open?.tw) { _execLibOpen(twNameEl, 'tw'); return; }
            if (!launch) { NbTerminal.openSettings('sec-codeblocks'); return; }
            if (launch.terminal) { NbTerminal.run(launch.cmd); return; }
            twNameEl.classList.add('nb-tw-name-launching');
            try {
                const d = await fetch('/api/tw/launch', {method: 'POST'}).then(r => r.json());
                if (d.url) window.open(d.url, 'tw-web');
            } catch(e) { console.error('tw launch:', e); }
            finally { twNameEl.classList.remove('nb-tw-name-launching'); }
        });

        if (_cbCan(el, 'tw', 'write')) {
            const addBtn = document.createElement('button');
            addBtn.className = 'nb-tw-btn nb-tw-add-btn';
            addBtn.title = 'Add task'; addBtn.textContent = '+';
            addBtn.addEventListener('click', () => _showTwAddForm(el, q, addBtn));
            acts.insertBefore(addBtn, refBtn);
        }

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

    // Extract tw: codeblock query strings from a body slice.
    // Strips CBQL keys (source/filter/timeframe) in case a project note's tw block has them.
    function _twExtractQueries(body) {
        const queries = [];
        const lines = body.split('\n');
        let inBlock = false, blockLines = [];
        for (const line of lines) {
            if (!inBlock) {
                if (/^```tw\b/i.test(line)) { inBlock = true; blockLines = []; }
                continue;
            }
            if (/^```\s*$/.test(line)) {
                const q = blockLines
                    .filter(l => !/^(source|filter|timeframe):\s*/i.test(l))
                    .join(' ').trim();
                if (q) queries.push(q);
                inBlock = false; blockLines = [];
                continue;
            }
            blockLines.push(line);
        }
        return queries;
    }

    // CBQL tw block: fetch source note, slice to timeframe, run extracted tw queries.
    async function _loadTwCBQLBlock(el) {
        if (!_cbCan(el, 'tw', 'read')) { _cbDenyRead(el); return; }
        const note   = typeof NbMain !== 'undefined' ? NbMain.activeNote?.() : null;
        const params = _cbqlParams(el.dataset.src || '', note?.meta);
        if (!params) return _loadTwBlock(el);

        const timeframe = el.dataset.activeTimeframe ?? params.timeframe ?? 'current';
        const noteSel   = note?.selector || '';
        let sourceSel   = _cbqlResolveSel(params.source, noteSel);

        el.innerHTML = '<span class="nb-spin">⟳</span>';
        try {
            const r = await fetch(`/api/note?selector=${encodeURIComponent(sourceSel)}`);
            if (!r.ok) throw new Error(`source not found: ${sourceSel}`);
            const d       = await r.json();
            const slice   = _cbqlSliceBody(d.body || '', timeframe);
            const queries = _twExtractQueries(slice);

            if (!queries.length) {
                el.innerHTML = '<div class="nb-timedot-empty">No tasks in this timeframe</div>';
                return;
            }

            const combined = queries.length === 1
                ? queries[0]
                : queries.map(q => `( ${q} )`).join(' or ');

            const tr = await fetch(`/api/task-query?q=${encodeURIComponent(combined)}`);
            const td = await tr.json();
            if (td.error) { _cbError(el, 'tw', td.error, () => _loadTwCBQLBlock(el)); return; }
            const twLaunch = td.twTerminalMode ? { terminal: true, cmd: td.twLaunchCmd }
                           : td.twWebUrl       ? { url: td.twWebUrl }
                           : null;
            _buildTwTable(el, (td.tasks || []).sort((a, b) => (b.urgency || 0) - (a.urgency || 0)), combined, null, twLaunch);
        } catch (e) {
            _cbError(el, 'tw', e.message, () => _loadTwCBQLBlock(el));
        }
        _initCollapseToggle(el);
    }

    // Extract checklist items from body, optionally scoped to a named section.
    // filter = heading text to match (case-insensitive); null = whole body.
    // Returns [{done, text}].
    function _checklistExtract(body, filter) {
        const lines = body.split('\n');
        let inSection = !filter, items = [];
        const headingRe = /^#{1,6}\s+(.+)/;
        for (const line of lines) {
            const hm = line.match(headingRe);
            if (hm) {
                inSection = !filter || hm[1].trim().toLowerCase().includes(filter.toLowerCase());
                continue;
            }
            if (!inSection) continue;
            const cm = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)/);
            if (cm) items.push({ done: cm[1].trim().toLowerCase() === 'x', text: cm[2].trim() });
        }
        return items;
    }

    // Extract checklist items grouped by > MILESTONE: markers in the event log.
    // Returns [{milestone, items: [{done, text}]}] — only milestones with items.
    function _checklistExtractByMilestone(body) {
        const groups = [];
        let current = null;
        for (const line of body.split('\n')) {
            const mm = line.match(/^> ([A-Z]{2,}):\s*(.*)/);
            if (mm) {
                current = mm[1] === 'MILESTONE'
                    ? (groups.push({ milestone: mm[2].trim(), items: [] }), groups[groups.length - 1])
                    : null;
                continue;
            }
            if (!current) continue;
            const cm = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)/);
            if (cm) current.items.push({ done: cm[1].trim().toLowerCase() === 'x', text: cm[2].trim() });
        }
        return groups.filter(g => g.items.length);
    }

    // CBQL checklist block: fetch source, extract items, render with completion badge.
    // Deliverables are static plan items — no timeframe slicing; filter: matches a heading.
    // group: milestones renders items grouped by > MILESTONE: markers from the event log.
    async function _loadChecklistCBQLBlock(el) {
        const note   = typeof NbMain !== 'undefined' ? NbMain.activeNote?.() : null;
        const params = _cbqlParams(el.dataset.src || '', note?.meta);
        if (!params) { el.innerHTML = '<div class="nb-timeline-empty">No source specified</div>'; return; }

        const noteSel = note?.selector || '';
        let sourceSel = _cbqlResolveSel(params.source, noteSel);

        el.innerHTML = '<span class="nb-spin">⟳</span>';
        try {
            const r = await fetch(`/api/note?selector=${encodeURIComponent(sourceSel)}`);
            if (!r.ok) throw new Error(`source not found: ${sourceSel}`);
            const d      = await r.json();
            const grouped = params.group === 'milestones';

            el.innerHTML = '';

            let done = 0, total = 0;
            let bodyEl;

            if (grouped) {
                const groups = _checklistExtractByMilestone(d.body || '');
                groups.forEach(g => { done += g.items.filter(i => i.done).length; total += g.items.length; });

                const { hdr, meta: metaEl } = _buildBarHeader(el, {
                    lang: 'checklist', onRefresh: () => _loadChecklistCBQLBlock(el),
                });
                metaEl.textContent = total ? `${done}/${total} done · milestones` : 'no milestone items';
                el.appendChild(hdr);
                _initCollapseToggle(el);

                bodyEl = document.createElement('div');
                bodyEl.className = 'nb-checklist-body';
                if (!groups.length) {
                    bodyEl.innerHTML = '<div class="nb-timedot-empty">No milestone items found</div>';
                } else {
                    for (const g of groups) {
                        const gdone = g.items.filter(i => i.done).length;
                        const grp = document.createElement('div');
                        grp.className = 'nb-checklist-group';
                        const ghdr = document.createElement('div');
                        ghdr.className = 'nb-checklist-group-hdr';
                        ghdr.innerHTML =
                            `<span class="nb-checklist-group-label">${_esc(g.milestone)}</span>` +
                            `<span class="nb-checklist-group-count">${gdone}/${g.items.length}</span>`;
                        grp.appendChild(ghdr);
                        const list = document.createElement('ul');
                        list.className = 'nb-checklist-list';
                        for (const item of g.items) {
                            const li = document.createElement('li');
                            li.className = 'nb-checklist-item' + (item.done ? ' nb-checklist-done' : '');
                            li.innerHTML =
                                `<span class="nb-checklist-box">${item.done ? '☑' : '☐'}</span>` +
                                `<span class="nb-checklist-text">${_esc(item.text)}</span>`;
                            list.appendChild(li);
                        }
                        grp.appendChild(list);
                        bodyEl.appendChild(grp);
                    }
                }
            } else {
                const items = _checklistExtract(d.body || '', params.filter || null);
                done  = items.filter(i => i.done).length;
                total = items.length;

                const { hdr, meta: metaEl } = _buildBarHeader(el, {
                    lang: 'checklist', onRefresh: () => _loadChecklistCBQLBlock(el),
                });
                const section = params.filter ? _esc(params.filter) : 'all';
                metaEl.textContent = total ? `${done}/${total} done · ${section}` : `empty · ${section}`;
                el.appendChild(hdr);
                _initCollapseToggle(el);

                bodyEl = document.createElement('div');
                bodyEl.className = 'nb-checklist-body';
                if (!items.length) {
                    bodyEl.innerHTML = '<div class="nb-timedot-empty">No checklist items found</div>';
                } else {
                    const list = document.createElement('ul');
                    list.className = 'nb-checklist-list';
                    for (const item of items) {
                        const li = document.createElement('li');
                        li.className = 'nb-checklist-item' + (item.done ? ' nb-checklist-done' : '');
                        li.innerHTML =
                            `<span class="nb-checklist-box">${item.done ? '☑' : '☐'}</span>` +
                            `<span class="nb-checklist-text">${_esc(item.text)}</span>`;
                        list.appendChild(li);
                    }
                    bodyEl.appendChild(list);
                }
            }

            el.appendChild(bodyEl);
        } catch (e) {
            el.innerHTML = `<div class="nb-timedot-err">CBQL: ${_esc(e.message)}</div>`;
        }
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
                _cbError(el, 'nb', e.message, () => _loadNbBlock(el));
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
                _cbError(el, 'nb', e.message, () => _loadNbBlock(el));
            }
        } else {
            _cbError(el, 'nb', `unknown nb command: ${_esc(cmd)}`, () => _loadNbBlock(el));
        }
        _initCollapseToggle(el);
    }

    function _buildNbBacklinks(el, backlinks, title, limit = 20) {
        el.innerHTML = '';
        const countHint = backlinks.length === limit ? `top ${limit}` : backlinks.length;
        const { hdr, meta } = _buildBarHeader(el, { lang: 'nb', onRefresh: () => _loadNbBlock(el) });
        meta.innerHTML = `<span class="nb-nb-name">nb</span> backlinks · <code>${_esc(title)}</code> <span class="nb-nb-count">${countHint}</span>`;
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
        const { hdr, meta } = _buildBarHeader(el, { lang: 'nb', onRefresh: () => _loadNbBlock(el) });
        meta.innerHTML = `<span class="nb-nb-name">nb</span> notebooks <span class="nb-nb-count">${notebooks.length}</span>`;
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
        let   repo  = space === -1 ? line : line.slice(0, space);
        const args  = space === -1 ? ''   : line.slice(space + 1).trim();
        if (repo === '.') {
            const sel = NbMain?.activeSelector?.() || '';
            const c   = sel.indexOf(':');
            repo = c >= 0 ? sel.slice(0, c) : repo;
        }
        el.classList.remove('nb-collapsed');
        el.innerHTML = '<span class="nb-spin">⟳</span>';
        try {
            const d = await fetch(
                `/api/nb/git?repo=${encodeURIComponent(repo)}&args=${encodeURIComponent(args)}`
            ).then(r => r.json());
            if (d.error) { _cbError(el, 'git', d.error, () => _loadGitBlock(el)); return; }
            _buildGitOutput(el, d.output || '', repo, args);
        } catch(e) {
            _cbError(el, 'git', e.message, () => _loadGitBlock(el));
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
        const { hdr, meta } = _buildBarHeader(el, { lang: 'git', onRefresh: () => _loadGitBlock(el) });
        meta.innerHTML = `<span class="nb-git-repo" title="Open remote in browser">${_esc(repo)}</span> <code>git ${_esc(args)}</code>`;
        hdr.querySelector('.nb-git-repo').addEventListener('click', async () => {
            try {
                const d = await fetch(
                    `/api/nb/git?repo=${encodeURIComponent(repo)}&args=${encodeURIComponent('remote get-url origin')}`
                ).then(r => r.json());
                const url = _gitRemoteToWebUrl(d.output || '');
                if (url) window.open(url, '_blank');
            } catch(e) { console.error('git remote:', e); }
        });
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
        const selector   = NbMain.activeSelector() || '';
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
                    ws.send(JSON.stringify({ cmd, selector, cols: term.cols, rows: term.rows }));
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
        el.innerHTML = '';
        const { hdr, meta } = _buildBarHeader(el, { lang: 'hl' });
        meta.innerHTML = `<span class="nb-hl-name" title="${_esc(termCmd)}">hledger</span><code style="margin-left:4px;opacity:0.7">${_esc(cmd)}</code>`;
        el.appendChild(hdr);
        const body = document.createElement('div');
        body.style.cssText = 'padding:6px 10px';
        body.innerHTML = `<button class="nb-tw-btn nb-hl-launch-btn" style="font-size:13px;padding:4px 12px">▶ hledger-${_esc(cmd)}</button>`;
        el.appendChild(body);
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
        const sel = NbMain.activeSelector();
        if (sel) {
            const colon = sel.indexOf(':');
            if (colon > 0) return sel.slice(0, colon);
        }
        const nb = NbNav.notebook;
        return (nb && nb !== '_all') ? nb : 'home';
    }

    async function _loadHledgerBlock(el) {
        if (!_cbCan(el, 'hl', 'read')) { _cbDenyRead(el); return; }
        let q = el.dataset.query || '';

        // Inject journal: FM key as positional path when no file already in query.
        const _fmNote   = typeof NbMain !== 'undefined' ? NbMain.activeNote?.() : null;
        const _fmJournal = _fmNote?.meta?.journal || _fmNote?.effective_fm?.journal || '';
        if (_fmJournal) {
            const _qt = q.trim();
            const _firstTok = _qt.split(/\s+/)[0]?.toLowerCase() || '';
            const _hasFile  = /^[~/]/.test(_qt) || /(?:^|\s)(?:-f|--file)[=\s]/.test(_qt);
            if (!_hasFile && !['regen', 'ui', 'web'].includes(_firstTok))
                q = _fmJournal + ' ' + q;
        }

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
            if (d.error) { _cbError(el, 'hl', d.error, () => _loadHledgerBlock(el)); return; }
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
            const SECTIONED = new Set(['incomestatement','is','balancesheet','bs','balancesheetequity','bse','cashflow','cf']);
            if (BALANCE.has(cmd))        _buildHledgerBalance(el, d.data, q, launch);
            else if (REGISTER.has(cmd))  _buildHledgerRegister(el, d.data, q, launch);
            else if (SECTIONED.has(cmd)) _buildHledgerSectioned(el, d.data, q, launch);
            else _buildHledgerPre(el, JSON.stringify(d.data, null, 2), q, launch);
        } catch(e) {
            _cbError(el, 'hl', e.message, () => _loadHledgerBlock(el));
        } finally {
            if (_initCollapsed) el.classList.add('nb-collapsed');
        }
    }

    function _accountFromQuery(q) {
        const CMDS     = new Set(['reg','register','bal','balance','bs','bse','is','cf','print',
                                  'check','accounts','activity','stats','aregister','areg',
                                  'incomestatement','balancesheet','balancesheetequity','cashflow']);
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

    function _hlHeader(el, q, refresh, launch, count = null, total = null) {
        const countHtml = count != null ? `<span class="nb-hl-count">${count}</span>` : '';
        const filterHtml = q ? ` <code>${_esc(q)}</code>` : '';
        const totalHtml = total
            ? ` <span class="nb-hl-bar-total ${_esc(total.cls || '')}">= ${_esc(total.text)}</span>`
            : '';
        const nameTitle = !launch                ? 'Configure launch in Settings → Codeblocks'
                        : launch.terminal        ? 'Run in terminal'
                        :                          'Open in hledger-web';
        const { hdr, meta, acts, refBtn, helpBtn } = _buildBarHeader(el, {
            lang: 'hl', onRefresh: refresh, onHelp: _showHledgerHelp,
        });
        helpBtn.className += ' nb-hl-btn nb-hl-help-btn';
        meta.className += ' nb-collapse-zone';
        meta.innerHTML = `<span class="nb-hl-name" title="${nameTitle}">hledger</span>${countHtml}${filterHtml}${totalHtml}`;
        meta.querySelector('.nb-hl-name').addEventListener('click', async () => {
            const nameEl = meta.querySelector('.nb-hl-name');
            if (_blockExtras?.open?.hl) { _execLibOpen(nameEl, 'hl', { journal: el.dataset.hlJournalSel || '' }); return; }
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
            finally { meta.querySelector('.nb-hl-name')?.classList.remove('nb-hl-name-launching'); }
        });

        if (_cbCan(el, 'hl', 'write')) {
            const editBtn = document.createElement('button');
            editBtn.className = 'nb-tw-btn nb-hl-btn nb-hl-edit-btn';
            editBtn.title = 'Edit journal';
            editBtn.textContent = '✎';
            editBtn.addEventListener('click', () => {
                const sel  = el.dataset.hlJournalSel;
                const path = el.dataset.hlJournal;
                NbMain.openNote(sel || path);
            });
            acts.insertBefore(editBtn, helpBtn);

            const addBtn = document.createElement('button');
            addBtn.className = 'nb-tw-btn nb-hl-btn nb-hl-add-btn';
            addBtn.title = 'Add transaction';
            addBtn.textContent = '+';
            addBtn.addEventListener('click', () => _showHledgerAddForm(el, q, addBtn));
            acts.insertBefore(addBtn, helpBtn);
        }

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
        const barTotal = totals.length
            ? { text: _hlFmtAmts(totals), cls: _hlAmtCls(totals) } : null;
        el.innerHTML = '';
        _hlHeader(el, q, () => _loadHledgerBlock(el), launch, rows.length, barTotal);
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
        // Last row's running balance = account balance at end of register period
        const lastBal = rows.length ? rows[rows.length - 1]?.[4] : null;
        const barTotal = lastBal?.length
            ? { text: _hlFmtAmts(lastBal), cls: _hlAmtCls(lastBal) } : null;
        el.innerHTML = '';
        _hlHeader(el, q, () => _loadHledgerBlock(el), launch, txnCount, barTotal);
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
    function _frontParseQuery(raw, currentSelector) {
        raw = (raw || '').trim();
        const pipeIdx = raw.indexOf(' |');
        const label   = pipeIdx >= 0 ? raw.slice(pipeIdx + 2).trim() : '';
        const qpart   = pipeIdx >= 0 ? raw.slice(0, pipeIdx).trim() : raw;

        // Consume leading tokens with no colon as notebook names; '.' resolves to current notebook
        const notebooks = [];
        const tokens    = qpart ? qpart.split(/\s+/) : [];
        let i = 0;
        while (i < tokens.length && !tokens[i].includes(':')) {
            const tok = tokens[i++];
            if (tok === '.') {
                const colon = (currentSelector || '').indexOf(':');
                if (colon >= 0) notebooks.push(currentSelector.slice(0, colon));
            } else {
                notebooks.push(tok);
            }
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
            if (re.test(head)) {
                head = head.replace(re, `$1: ${val}`);
            } else {
                // Key doesn't exist in this note's FM yet — append it rather than
                // silently no-op. Needed for any consumer filling in a field a
                // constraints: schema declares but this particular note never had
                // (e.g. a required field left blank at creation).
                head += `\n${key}: ${val}`;
            }
        }
        return head + tail;
    }

    function _fmWidget(key, value, constraint) {
        const c = (constraint || '').trim();
        // Dot-notation inheritance ref (e.g. "scene.loc") — field is read-only, sourced from another note
        if (/^\w+\.\w+$/.test(c)) {
            const wrap = document.createElement('span');
            wrap.className = 'nb-fm-inherited';
            wrap.dataset.fmKey = key;
            wrap.dataset.fmInherited = c;
            wrap.textContent = value || '';
            wrap.title = `inherited from ${c}`;
            return wrap;
        }
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
        el.classList.add('nb-fm-changes');

        const btn = document.createElement('button');
        btn.className  = 'nb-fm-changes-btn nb-tw-btn';
        btn.textContent = label;
        el.appendChild(btn);

        const panel = document.createElement('div');
        panel.className = 'nb-fm-changes-panel';
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
                form.className = 'nb-fm-changes-form';

                for (const { key, value } of fields) {
                    const row = document.createElement('div');
                    row.className = 'nb-fm-changes-row';
                    const lbl = document.createElement('label');
                    lbl.className   = 'nb-fm-changes-label';
                    lbl.textContent = key;
                    row.appendChild(lbl);
                    row.appendChild(_fmWidget(key, value, constraints[key]));
                    form.appendChild(row);
                }

                const actions = document.createElement('div');
                actions.className = 'nb-fm-changes-actions';

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

    async function _loadFmListBlock(el) {
        // Parse: "list", "list 20", "list-core", "list-core 12", "list-empty"
        const raw = (el.dataset.query || '').trim();
        const m   = raw.match(/^list(?:-(\w+))?(?:\s+(\d+))?$/);
        const scope       = m?.[1] || null;         // 'cine', 'core', 'empty', or null
        const limit       = parseInt(m?.[2] || '8', 10);
        const isEmptyScope = scope === 'empty';
        const scopeLabel  = scope ? `list-${scope}` : 'list';
        const ROW_H       = 26;

        let scopeKeys = null;
        if (scope && !isEmptyScope) scopeKeys = NbWeb.getFmKeysForScope(scope);

        const nb = NbMain?.activeNote?.()?.notebook || '';
        el.innerHTML = '<span class="nb-spin">⟳</span>';
        try {
            const params = new URLSearchParams({ notebook: nb });
            if (scopeKeys?.length) scopeKeys.forEach(k => params.append('keys', k));
            const r = await fetch(`/api/fm/keys?${params}`);
            if (r.status === 403) { _cbDenyRead(el); return; }
            const d = await r.json();
            if (d.error) throw new Error(d.error);

            let keys = Object.entries(d.keys);
            if (isEmptyScope) keys = keys.filter(([, v]) => v.count_empty > 0);
            keys.sort((a, b) => b[1].count - a[1].count);

            el.innerHTML = '';
            const { hdr, meta } = _buildBarHeader(el, { lang: 'fm', onRefresh: () => _loadFmListBlock(el) });

            const countEl = document.createElement('span');
            countEl.className = 'nb-fm-count';
            countEl.textContent = keys.length ? String(keys.length) + ' keys' : 'No keys';
            meta.appendChild(countEl);
            const lbl = document.createElement('span');
            lbl.className = 'nb-fm-label';
            lbl.textContent = scopeLabel;
            meta.appendChild(lbl);
            el.appendChild(hdr);

            if (keys.length) {
                const scroll = document.createElement('div');
                scroll.className = 'nb-fm-list-scroll';
                scroll.style.maxHeight = (limit * ROW_H) + 'px';

                const tbl = document.createElement('table');
                tbl.className = 'nb-fm-list-table';
                for (const [key, info] of keys) {
                    const tr = document.createElement('tr');
                    tr.className = 'nb-fm-list-row';
                    tr.title = 'Show notes with this field';

                    const tdKey = document.createElement('td');
                    tdKey.className = 'nb-fm-list-key';
                    tdKey.textContent = key;

                    const tdCount = document.createElement('td');
                    tdCount.className = 'nb-fm-list-count';
                    tdCount.textContent = info.count;

                    const tdSamples = document.createElement('td');
                    tdSamples.className = 'nb-fm-list-samples';
                    tdSamples.textContent = info.samples.join(', ');

                    tr.append(tdKey, tdCount, tdSamples);
                    tr.addEventListener('click', () => {
                        // key: → op:'exists' (bare word without colon = notebook name in parser)
                        el.dataset.query      = key + ':';
                        el.dataset._fmListSrc = raw; // stash original query for back button
                        _loadFrontBlock(el);
                    });
                    tbl.appendChild(tr);
                }
                scroll.appendChild(tbl);
                el.appendChild(scroll);
            }

            _initCollapseToggle(el);
        } catch(e) {
            _cbError(el, 'fm', e.message, () => _loadFmListBlock(el));
        }
    }

    async function _loadFrontBlock(el) {
        if (!_cbCan(el, 'fm', 'read')) { _cbDenyRead(el); return; }
        if ((el.dataset.query || '').trim().startsWith('changes')) {
            await _loadFrontChanges(el);
            return;
        }
        // list / list-X / list-X N — delegate to list renderer
        if ((el.dataset.query || '').trim().match(/^list(-\w+)?(\s+\d+)?$/)) {
            await _loadFmListBlock(el);
            return;
        }
        const parsed = _frontParseQuery(el.dataset.query || '', NbMain?.activeSelector?.() || '');
        el.dataset.frontNotebooks = parsed.notebooks.join(',');
        el.dataset.frontFilters   = JSON.stringify(parsed.filters);
        el.dataset.frontLabel     = parsed.label;
        await _frontRender(el);
    }

    async function _frontRender(el) {
        const notebooks  = el.dataset.frontNotebooks || '';
        const filters    = JSON.parse(el.dataset.frontFilters || '[]');
        const label      = el.dataset.frontLabel || '';
        const wasCollapsed = el.classList.contains('nb-collapsed');
        el.innerHTML       = '<span class="nb-spin">⟳</span>';
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
            const { hdr, meta } = _buildBarHeader(el, { lang: 'fm', onRefresh: () => _frontRender(el) });

            // Back button when drilled into a field from a list view
            if (el.dataset._fmListSrc) {
                const back = document.createElement('button');
                back.className = 'nb-fm-list-back nb-tw-btn';
                back.textContent = '← list';
                back.addEventListener('click', e => {
                    e.stopPropagation();
                    const src = el.dataset._fmListSrc;
                    delete el.dataset._fmListSrc;
                    el.dataset.query = src;
                    _loadFmListBlock(el);
                });
                meta.appendChild(back);
            }

            const toggle = document.createElement('span');
            toggle.className = 'nb-fm-toggle';
            meta.appendChild(toggle);

            const countEl = document.createElement('span');
            countEl.className = 'nb-fm-count';
            countEl.textContent = notes.length ? String(notes.length) : 'No matches';
            meta.appendChild(countEl);

            if (nbLabel) {
                const nbEl = document.createElement('span');
                nbEl.className = 'nb-fm-nb';
                nbEl.textContent = nbLabel;
                meta.appendChild(nbEl);
            }
            if (label) {
                const lbl = document.createElement('span');
                lbl.className = 'nb-fm-label';
                lbl.textContent = label;
                meta.appendChild(lbl);
            }
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
                        badge.className = 'nb-fm-nb-badge';
                        badge.textContent = n.notebook;
                        li.appendChild(badge);
                    }
                    list.appendChild(li);
                }
                el.appendChild(list);
            }

            if (wasCollapsed) el.classList.add('nb-collapsed');
            _initCollapseToggle(el);

        } catch (e) {
            _cbError(el, 'fm', e.message, () => _frontRender(el));
        }
    }

    // ── nav codeblock ─────────────────────────────────────────────────────────

    function _navParseQuery(raw, currentSelector) {
        raw = (raw || '').trim();
        if (raw === '.') {
            const colon = (currentSelector || '').indexOf(':');
            if (colon >= 0) {
                const nb   = currentSelector.slice(0, colon);
                const rel  = currentSelector.slice(colon + 1);
                const parts = rel.split('/');
                const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
                return { notebook: nb, folder };
            }
            return { notebook: '', folder: '' };
        }
        if (/^[^/\s]+:/.test(raw)) {         // nb selector: notebook:folder/
            const colon = raw.indexOf(':');
            return { notebook: raw.slice(0, colon), folder: raw.slice(colon + 1).replace(/\/$/, '') };
        }
        const m = raw.replace(/^~/, '').replace(/\/$/, '').match(/\/\.nb\/([^/]+)(\/(.+))?$/);
        if (m) {
            const nb = m[1];
            // Hidden dir (e.g. .checks, .lib) — not an nb notebook, use raw fs listing
            if (nb.startsWith('.')) return { rawPath: raw.replace(/\/$/, '') };
            return { notebook: nb, folder: m[3] || '' };
        }
        if (raw) return { notebook: raw.replace(/^.*\//, ''), folder: '' };
        return { notebook: '', folder: '' };
    }

    // Entry point — called on first render and on refresh
    async function _loadNavBlock(el) {
        if (!_cbCan(el, 'nav', 'read')) { _cbDenyRead(el); return; }
        if (!el.dataset.navReady) {
            const parsed = _navParseQuery(el.dataset.query || '', NbMain?.activeSelector?.() || '');
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
            _cbError(el, 'nav', e.message, () => _loadNavBlock(el));
        }
    }

    function _navHeader(el, notebook, folder) {
        const { hdr, meta } = _buildBarHeader(el, { lang: 'nav', onRefresh: () => _loadNavBlock(el) });
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
        hdr.replaceChild(crumbs, meta);
        el.appendChild(hdr);
        _initCollapseToggle(el);
    }

    // Header for raw filesystem mode — breadcrumb shows path relative to .nb/
    function _navHeaderFs(el, absPath) {
        const { hdr, meta } = _buildBarHeader(el, { lang: 'nav', onRefresh: () => _loadNavBlock(el) });
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

        hdr.replaceChild(crumbs, meta);
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
            if (n.tag_color) {
                const tc = NbMain.matchTagColor(n.tag_color, n.tags);
                if (tc) btn.style.color = tc;
            }
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

    // ── config codeblock ─────────────────────────────────────────────────────
    // Visualises the config inheritance chain from global root to a target.
    //
    // Query forms:
    //   <key>: .              walk to current note's notebook/folder; highlight <key>
    //   <key>: nb:folder/     walk to specified target; highlight <key>
    //   (bare)                walk to current note; show all contributed keys

    function _configParseQuery(raw, currentSelector) {
        raw = (raw || '').trim();
        let key = '', target = '', treeMode = false, orgMode = false, treeAttrs = [], context = 2, maxDepth = 0;

        // tree/org mode: first token is 'tree' or 'org'
        if (/^tree\b/i.test(raw) || /^org\b/i.test(raw)) {
            orgMode  = /^org\b/i.test(raw);
            treeMode = !orgMode;
            const rest = raw.replace(/^(?:tree|org)\s*/i, '').trim();
            const rawToks = rest.split(/\s+/).filter(Boolean).map(t => t.replace(/^["']|["']$/g, ''));
            const attrTokens = [];
            for (let i = 0; i < rawToks.length; i++) {
                const tok = rawToks[i];
                const cm = tok.match(/^-[cC](\d*)$/);
                const dm = tok.match(/^-[dD](\d*)$/);
                if (cm) {
                    // -C N or -CN  (tooltip context line count)
                    if (cm[1]) context = parseInt(cm[1]);
                    else if (i + 1 < rawToks.length && /^\d+$/.test(rawToks[i + 1])) context = parseInt(rawToks[++i]);
                } else if (dm) {
                    // -D N or -DN  (max folder depth; 0 = unlimited)
                    if (dm[1]) maxDepth = parseInt(dm[1]);
                    else if (i + 1 < rawToks.length && /^\d+$/.test(rawToks[i + 1])) maxDepth = parseInt(rawToks[++i]);
                } else if (!orgMode && tok.endsWith(':')) {
                    target = tok;
                } else {
                    attrTokens.push(tok.replace(/^\[|\]$/g, ''));
                }
            }
            // Accept comma- or space-separated attrs across any number of tokens
            treeAttrs = attrTokens.join(',').split(/[\s,]+/).filter(Boolean);
            // Org mode: always scope to current notebook only (never a subfolder)
            if (orgMode) {
                const colon = (currentSelector || '').indexOf(':');
                if (colon >= 0) {
                    target = currentSelector.slice(0, colon) + ':';
                } else if (/\/\.nb\/\.nb\.md$/.test(currentSelector || '')) {
                    // .nb.md opened by filesystem path (no colon) → global scope
                    target = '.nb:';
                }
            }
        } else if (raw) {
            const m = raw.match(/^(\w[\w.-]*):\s*(.*)$/);
            if (m) { key = m[1]; target = m[2].trim(); }
            else     target = raw;
        }

        // Resolve '.' or empty → current note's notebook + folder
        if (!target || target === '.') {
            const colon = (currentSelector || '').indexOf(':');
            if (colon >= 0) {
                const nb  = currentSelector.slice(0, colon);
                const rel = currentSelector.slice(colon + 1);
                const parts = rel.split('/');
                const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
                target = folder ? `${nb}:${folder}/` : `${nb}:`;
            }
        }

        // Parse target into notebook + folder
        const tc = target.indexOf(':');
        const notebook = tc >= 0 ? target.slice(0, tc) : target.replace(/\/$/, '');
        const folder   = tc >= 0 ? target.slice(tc + 1).replace(/\/$/, '') : '';

        return { key, notebook, folder, treeMode, orgMode, treeAttrs, context, maxDepth };
    }

    async function _loadConfigBlock(el) {
        if (!_cbCan(el, 'cfg', 'read')) { _cbDenyRead(el); return; }
        const wasOpen = !el.classList.contains('nb-collapsed');
        const currentSelector = NbMain?.activeSelector?.() || '';
        const { key, notebook, folder, treeMode, orgMode, treeAttrs, context, maxDepth } = _configParseQuery(el.dataset.query || '', currentSelector);
        const treeAttr = treeAttrs[0] || '';  // single-attr for tree mode and legacy

        if (!notebook) {
            _cbError(el, 'cfg', 'cfg: no notebook resolved', () => _loadConfigBlock(el));
            return;
        }

        el.innerHTML = '<span class="nb-spin">⟳</span>';

        try {
            if (treeMode || orgMode) {
                let tree;
                if (orgMode && notebook === '.nb') {
                    // Super-notebook scope: global walk across all notebooks.
                    // No attribute filter: org charts always show all folders;
                    // treeAttrs drive client-side filter chips only.
                    const params = new URLSearchParams();
                    if (maxDepth) params.set('max_depth', maxDepth);
                    const r = await fetch(`/api/config-global-walk?${params}`);
                    if (r.status === 403) { _cbDenyRead(el); return; }
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    tree = await r.json();
                    if (tree.error) throw new Error(tree.error);
                    _configOrgRender(el, tree, treeAttrs, '.nb', wasOpen, context);
                } else {
                    const params = new URLSearchParams({ notebook });
                    if (treeMode && treeAttr) params.set('attribute', treeAttr);
                    if (folder)               params.set('folder', folder);
                    if (orgMode)              params.set('with_global', '1');
                    if (maxDepth)             params.set('max_depth', maxDepth);
                    const r = await fetch(`/api/config-tree-walk?${params}`);
                    if (r.status === 403) { _cbDenyRead(el); return; }
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    tree = await r.json();
                    if (tree.error) throw new Error(tree.error);
                    if (orgMode) _configOrgRender(el, tree, treeAttrs, notebook, wasOpen, context);
                    else         _configTreeRender(el, tree, treeAttr, notebook, wasOpen);
                }
            } else {
                const params = new URLSearchParams({ notebook });
                if (folder)          params.set('folder', folder);
                if (key)             params.set('key', key);
                if (currentSelector) params.set('selector', currentSelector);
                const r = await fetch(`/api/config-tree?${params}`);
                if (r.status === 403) { _cbDenyRead(el); return; }
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const nodes = await r.json();
                if (nodes.error) throw new Error(nodes.error);
                _configRender(el, nodes, key, currentSelector, wasOpen, notebook, folder);
            }
        } catch (e) {
            _cbError(el, 'cfg', e.message, () => _loadConfigBlock(el));
        }
    }

    function _configHelpPopover(trigger) {
        if (trigger._helpPop) { trigger._helpPop.remove(); trigger._helpPop = null; return; }
        const pop = document.createElement('div');
        pop.className = 'nb-config-help-pop';
        pop.innerHTML =
            `<strong>config block</strong> — shows the config inheritance chain for a key.<br><br>` +
            `<code>access: .</code> &nbsp;— <em>key</em> for current note's context<br>` +
            `<code>access: Notebook:folder/</code> &nbsp;— explicit target<br>` +
            `<code>.</code> &nbsp;— all keys, current context<br><br>` +
            `Chain: <code>note → folder → notebook → global</code><br>` +
            `<strong>▶</strong> amber = effective (wins). &nbsp;<strong>◉</strong> blue = this file is open.<br>` +
            `<strong>○</strong> = config file not yet created at this level.<br><br>` +
            `<a href="#" onclick="NbMain.openNote('docs:CODEBLOCKS.md');return false">Full docs →</a>`;
        const rect = trigger.getBoundingClientRect();
        pop.style.cssText =
            `position:fixed;z-index:9000;top:${rect.bottom+4}px;right:${window.innerWidth-rect.right}px;` +
            `background:var(--bg2);border:1px solid var(--border);border-radius:6px;` +
            `padding:10px 14px;box-shadow:0 4px 20px rgba(0,0,0,.5);max-width:320px;font-size:0.82em;line-height:1.6`;
        document.body.appendChild(pop);
        trigger._helpPop = pop;
        trigger.classList.add('nb-hl-btn-active');
        const away = e => {
            if (!pop.contains(e.target) && e.target !== trigger) {
                pop.remove(); trigger._helpPop = null;
                trigger.classList.remove('nb-hl-btn-active');
                document.removeEventListener('click', away, true);
            }
        };
        setTimeout(() => document.addEventListener('click', away, true), 0);
    }

    function _configTreeRender(el, tree, attribute, notebook, wasOpen) {
        el.innerHTML = '';
        el.className = (el.className || '').replace(/\bnb-spin\b/, '').trim();

        // Header
        const { hdr, meta, acts, refBtn, helpBtn } = _buildBarHeader(el, {
            lang: 'cfg', cls: 'config', collapseZone: true,
            onRefresh: () => _loadConfigBlock(el), onHelp: _configHelpPopover,
        });
        helpBtn.className += ' nb-config-btn';
        refBtn.className  += ' nb-config-btn';
        meta.innerHTML = 'cfg <code>tree</code>';
        if (attribute) {
            const k = document.createElement('code');
            k.className = 'nb-config-hdr-key'; k.textContent = attribute + ':';
            meta.appendChild(document.createTextNode(' '));
            meta.appendChild(k);
        }
        el.appendChild(hdr);
        if (!wasOpen) el.classList.add('nb-collapsed');
        _initCollapseToggle(el);

        // Recursive tree builder
        const body = document.createElement('div');
        body.className = 'nb-config-tree-body';

        function _renderNode(node, depth) {
            const row = document.createElement('div');
            row.className = 'nb-config-tree-row'
                + (node.has_config  ? ' nb-config-tree-has-cfg'  : ' nb-config-tree-no-cfg')
                + (node.has_attr    ? ' nb-config-tree-has-attr'  : '');
            row.style.paddingLeft = `${depth * 1.4}em`;

            const marker = document.createElement('span');
            marker.className = 'nb-config-tree-marker';
            marker.textContent = node.has_attr ? '▶' : (node.has_config ? '●' : '○');

            const nameBtn = document.createElement(node.has_config ? 'button' : 'span');
            nameBtn.className = 'nb-config-tree-name' + (node.has_config ? ' nb-nav-link' : '');
            nameBtn.textContent = node.name;
            if (node.has_config) {
                nameBtn.addEventListener('click', () => NbMain.openNote(node.cfg_path));
            }

            row.appendChild(marker);
            row.appendChild(nameBtn);

            if (node.has_attr && attribute) {
                const val = document.createElement('code');
                val.className = 'nb-config-tree-val';
                val.textContent = _configFormatVal(node.contributes[attribute]);
                row.appendChild(val);
            }

            if (!node.has_config && node.level !== 'note') {
                const createBtn = document.createElement('button');
                createBtn.className = 'nb-tw-btn nb-config-create-btn';
                createBtn.title = 'Create config file here';
                createBtn.textContent = '＋ Create';
                createBtn.addEventListener('click', async e => {
                    e.stopPropagation();
                    createBtn.disabled = true; createBtn.textContent = '⟳ creating…';
                    try {
                        const r = await fetch('/api/config-create', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            // rel_path is '' for notebook root — backend maps that to notebook-level config
                            body: JSON.stringify({ notebook, folder: node.rel_path }),
                        });
                        const d = await r.json();
                        if (d.selector) {
                            await _loadConfigBlock(el);
                            NbMain.openNote(d.selector);
                        } else {
                            createBtn.disabled = false; createBtn.textContent = '＋ Create';
                        }
                    } catch {
                        createBtn.disabled = false; createBtn.textContent = '＋ Create';
                    }
                });
                row.appendChild(createBtn);
            }

            body.appendChild(row);
            for (const child of (node.children || [])) _renderNode(child, depth + 1);
        }

        _renderNode(tree, 0);

        if (attribute && !tree.has_attr && !(tree.children || []).length) {
            const hint = document.createElement('div');
            hint.className = 'nb-config-tree-hint';
            hint.textContent = `No folders in ${notebook} have ${attribute}: set yet. Use ＋ Create to add a folder config.`;
            body.appendChild(hint);
        }

        el.appendChild(body);
    }

    function _configOrgRender(el, tree, treeAttrs, notebook, wasOpen, context = 2) {
        el.innerHTML = '';
        el.className = (el.className || '').replace(/\bnb-spin\b/, '').trim();

        const { hdr, meta, refBtn, helpBtn } = _buildBarHeader(el, {
            lang: 'cfg', cls: 'config', collapseZone: true,
            onRefresh: () => _loadConfigBlock(el), onHelp: _configHelpPopover,
        });
        helpBtn.className += ' nb-config-btn';
        refBtn.className  += ' nb-config-btn';
        meta.innerHTML = 'cfg <code>org</code>';
        el.appendChild(hdr);
        if (!wasOpen) el.classList.add('nb-collapsed');
        _initCollapseToggle(el);

        // Layout constants — left-to-right flow
        const NW = 128, NH = 26, GX = 44, GY = 4, PAD = 14, PAD_BOT = 24;

        const ACCESS_TINTS = { guest: '#22c55e', office: '#f0a500', admin: '#ef4444', tech: '#a855f7' };

        // Icons keyed on the config file's own `type:` FM field
        const TYPE_ICONS = {
            dotfile:   '⚙️',  note:      '📝',  project:   '📊',
            dashboard: '🖥️',  daily:     '📅',  journal:   '📓',
            invoice:   '🧾',  contact:   '👤',  item:      '🏷️',
            shot:      '🎬',  scene:     '🎭',  actor:     '🎭',
            character: '👥',  location:  '📍',  storyline: '📖',
            milestone: '🚩',
        };

        function _measure(node) {
            if (!node.children?.length) { node._h = NH; return; }
            node.children.forEach(_measure);
            const total = node.children.reduce((s, c) => s + c._h, 0) + GY * (node.children.length - 1);
            node._h = Math.max(NH, total);
        }

        function _place(node, x, cy) {
            node._x = x;
            node._y = cy - NH / 2;
            if (!node.children?.length) return;
            let top = cy - node._h / 2;
            for (const c of node.children) {
                _place(c, x + NW + GX, top + c._h / 2);
                top += c._h + GY;
            }
        }

        function _maxX(node) {
            return Math.max(node._x + NW, ...(node.children || []).map(_maxX));
        }

        function _maxY(node) {
            return Math.max(node._y + NH, ...(node.children || []).map(_maxY));
        }

        function _shiftY(node, dy) {
            node._y += dy;
            (node.children || []).forEach(c => _shiftY(c, dy));
        }

        // With-global single-notebook view: detach global node and float it above the root.
        // Full global walk (many notebooks): global node IS the layout root — don't split.
        let globalNode = null;
        let layoutRoot = tree;
        if (tree.level === 'global' && tree.children?.length === 1) {
            globalNode = tree;
            layoutRoot = tree.children[0];
        }

        function _propagateAccess(node, inherited) {
            node._accessExplicit = node.contributes?.access != null;
            node._access = node.contributes?.access ?? inherited;
            (node.children || []).forEach(c => _propagateAccess(c, node._access));
        }
        const rootAccess = globalNode?.contributes?.access ?? null;
        if (globalNode) {
            globalNode._accessExplicit = globalNode.contributes?.access != null;
            globalNode._access = globalNode.contributes?.access ?? null;
        }
        _propagateAccess(layoutRoot, rootAccess);

        _measure(layoutRoot);
        _place(layoutRoot, PAD, PAD + layoutRoot._h / 2);

        if (globalNode) {
            globalNode._x = PAD;
            globalNode._y = layoutRoot._y - NH - 12;
            if (globalNode._y < PAD) {
                _shiftY(layoutRoot, PAD - globalNode._y);
                globalNode._y = PAD;
            }
        }

        const svgW = _maxX(layoutRoot) + PAD;
        const svgH = _maxY(layoutRoot) + PAD_BOT;

        const NS  = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('width',   svgW);
        svg.setAttribute('height',  svgH);
        svg.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
        svg.setAttribute('class', 'nb-config-org-svg');

        function _drawEdges(node) {
            for (const c of (node.children || [])) {
                const edge = document.createElementNS(NS, 'path');
                const x1 = node._x + NW, y1 = node._y + NH / 2;
                const x2 = c._x,         y2 = c._y  + NH / 2;
                const mx = (x1 + x2) / 2;
                edge.setAttribute('d', `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`);
                edge.setAttribute('fill', 'none');
                edge.setAttribute('class', 'nb-config-org-edge');
                svg.appendChild(edge);
                _drawEdges(c);
            }
        }

        function _drawNode(node) {
            const g = document.createElementNS(NS, 'g');
            g.setAttribute('transform', `translate(${node._x},${node._y})`);
            g.setAttribute('class', 'nb-config-org-node'
                + (node.level === 'global' ? ' nb-config-org-global' : '')
                + (node.has_config ? ' nb-config-org-has-cfg' : ' nb-config-org-no-cfg'));

            // Tag node with FM keys + values for filter bar matching
            const contrib = node.contributes || {};
            const cfgKeys = Object.keys(contrib).filter(k => !k.startsWith('_'));
            g.dataset.cfgKeys = cfgKeys.join(',');
            g.dataset.cfgVals = JSON.stringify(contrib);

            const tip = document.createElementNS(NS, 'title');
            const cfgFile = (node.cfg_path || '').split('/').pop() || node.name;
            g.dataset.tipPath  = node.rel_path ? `${node.rel_path}/${cfgFile}` : cfgFile;
            g.dataset.hasCfg   = node.has_config ? '1' : '';
            g.appendChild(tip);

            const rect = document.createElementNS(NS, 'rect');
            rect.setAttribute('width',  NW);
            rect.setAttribute('height', NH);
            rect.setAttribute('rx', 5);
            rect.setAttribute('class', 'nb-config-org-rect');
            g.appendChild(rect);

            // Access tint — cascades down the branch: every node paints its
            // effective (own or inherited) access, full opacity where explicitly
            // set, lighter where just inherited, so the source node still stands out.
            const tintColor = ACCESS_TINTS[node._access] || null;
            if (tintColor) {
                const tint = document.createElementNS(NS, 'rect');
                tint.setAttribute('width',  NW);
                tint.setAttribute('height', NH);
                tint.setAttribute('rx', 5);
                tint.setAttribute('fill', tintColor);
                tint.setAttribute('fill-opacity', node._accessExplicit ? '0.30' : '0.14');
                tint.setAttribute('pointer-events', 'none');
                g.appendChild(tint);
            }

            // Left slot: type icon (from config file's own `type:`) or ●/○ fallback
            const typeIcon = TYPE_ICONS[contrib.type || ''] || '';
            const leftEl = document.createElementNS(NS, 'text');
            leftEl.setAttribute('x', 6);
            leftEl.setAttribute('y', NH / 2 + 4);
            leftEl.setAttribute('pointer-events', 'none');
            if (typeIcon) {
                leftEl.setAttribute('class', 'nb-config-org-typeicon');
                leftEl.textContent = typeIcon;
            } else {
                leftEl.setAttribute('class', 'nb-config-org-marker');
                leftEl.textContent = node.has_config ? '●' : '○';
            }
            g.appendChild(leftEl);

            // Centre: name label
            const label = document.createElementNS(NS, 'text');
            label.setAttribute('x', NW / 2 + 5);
            label.setAttribute('y', NH / 2 + 4);
            label.setAttribute('text-anchor', 'middle');
            label.setAttribute('class', 'nb-config-org-label');
            const maxCh = 11;
            const rawLabel = node.level === 'global' ? '⊕ ' + node.name : node.name;
            label.textContent = rawLabel.length > maxCh ? rawLabel.slice(0, maxCh - 1) + '…' : rawLabel;
            g.appendChild(label);

            // Right slot: skipped indicator OR key count badge
            if (node.skipped) {
                const skip = document.createElementNS(NS, 'text');
                skip.setAttribute('x', NW - 4);
                skip.setAttribute('y', NH / 2 + 4);
                skip.setAttribute('text-anchor', 'end');
                skip.setAttribute('class', 'nb-config-org-skip');
                skip.setAttribute('pointer-events', 'none');
                skip.textContent = '…';
                g.appendChild(skip);
            } else if (cfgKeys.length) {
                const badge = document.createElementNS(NS, 'text');
                badge.setAttribute('x', NW - 4);
                badge.setAttribute('y', NH / 2 + 4);
                badge.setAttribute('text-anchor', 'end');
                badge.setAttribute('class', 'nb-config-org-badge');
                badge.setAttribute('pointer-events', 'none');
                badge.textContent = cfgKeys.length;
                g.appendChild(badge);
            }

            if (node.has_config) {
                g.style.cursor = 'pointer';
                g.addEventListener('click', () => NbMain.openNote(node.cfg_path));
            } else if (node.level !== 'note') {
                g.style.cursor = 'pointer';
                g.addEventListener('click', async () => {
                    g.style.opacity = '0.5';
                    try {
                        // Use node.notebook so global-scope nodes target the right notebook
                        const r = await fetch('/api/config-create', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ notebook: node.notebook || notebook, folder: node.rel_path }),
                        });
                        const d = await r.json();
                        if (d.selector) {
                            await _loadConfigBlock(el);
                            NbMain.openNote(d.selector);
                        } else { g.style.opacity = ''; }
                    } catch { g.style.opacity = ''; }
                });
            }

            svg.appendChild(g);
            for (const c of (node.children || [])) _drawNode(c);
        }

        // Global node: draw above tree with a short vertical drop edge
        if (globalNode) {
            const vx  = globalNode._x + NW / 2;
            const vy1 = globalNode._y + NH;
            const vy2 = layoutRoot._y;
            const vEdge = document.createElementNS(NS, 'path');
            vEdge.setAttribute('d', `M${vx},${vy1} L${vx},${vy2}`);
            vEdge.setAttribute('fill', 'none');
            vEdge.setAttribute('class', 'nb-config-org-edge');
            svg.appendChild(vEdge);
            const savedChildren = globalNode.children;
            globalNode.children = [];
            _drawNode(globalNode);
            globalNode.children = savedChildren;
        }

        _drawEdges(layoutRoot);
        _drawNode(layoutRoot);

        // ── Viewport group — all SVG content goes in here for zoom/pan ──
        const vp = document.createElementNS(NS, 'g');
        vp.setAttribute('class', 'nb-org-vp');
        while (svg.firstChild) vp.appendChild(svg.firstChild);
        svg.appendChild(vp);
        svg.removeAttribute('width');
        svg.removeAttribute('height');
        svg.removeAttribute('viewBox');
        svg.setAttribute('width',  '100%');
        svg.setAttribute('height', '100%');

        // ── Zoom/pan state ────────────────────────────────────────────
        let _z = 1, _tx = 0, _ty = 0, _drag = null, _keysActive = false;

        function _applyVP() {
            vp.setAttribute('transform', `translate(${_tx.toFixed(1)},${_ty.toFixed(1)}) scale(${_z.toFixed(4)})`);
        }
        function _fitAll() {
            const cw = svgCon.clientWidth  || svgW;
            const ch = svgCon.clientHeight || Math.min(svgH, 480);
            const pad = 20;
            const fullFit = Math.min((cw - pad*2) / svgW, (ch - pad*2) / svgH, 2);
            const minZ    = Math.max(12 / NH, 0.05);
            _z = Math.max(fullFit, minZ);
            if (_z > fullFit) {
                // Tree too large to fit entirely — center the root node in the viewport
                _tx = pad - layoutRoot._x * _z;
                _ty = ch * 0.4 - (layoutRoot._y + NH / 2) * _z;
            } else {
                _tx = Math.max(pad, (cw - svgW * _z) / 2);
                _ty = Math.max(pad, (ch - svgH * _z) / 2);
            }
            _applyVP();
        }
        function _zoomAt(mx, my, factor) {
            _z   = Math.max(0.05, Math.min(_z * factor, 8));
            _tx  = mx - (mx - _tx) * factor;
            _ty  = my - (my - _ty) * factor;
            _applyVP();
        }

        // ── SVG container (clips, scroll-captures) ────────────────────
        const svgCon = document.createElement('div');
        svgCon.className = 'nb-org-svg-con';
        svgCon.style.cssText = `overflow:hidden;position:relative;width:100%;` +
            `height:${Math.min(svgH + 8, 520)}px;cursor:grab;touch-action:none`;
        svgCon.appendChild(svg);

        // Ctrl+wheel zooms; plain wheel scrolls the page normally
        svgCon.addEventListener('wheel', e => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            const r = svgCon.getBoundingClientRect();
            _zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1/1.12);
        }, { passive: false });

        // Drag to pan
        svgCon.addEventListener('mousedown', e => {
            if (e.button !== 0) return;
            _drag = { x: e.clientX - _tx, y: e.clientY - _ty };
            svgCon.style.cursor = 'grabbing';
            e.preventDefault();
        });
        const _onOrgMove = e => { if (_drag) { _tx = e.clientX - _drag.x; _ty = e.clientY - _drag.y; _applyVP(); } };
        const _onOrgUp   = () => { if (_drag) { _drag = null; svgCon.style.cursor = 'grab'; } };
        window.addEventListener('mousemove', _onOrgMove);
        window.addEventListener('mouseup',   _onOrgUp);

        // Pinch to zoom
        let _pinchDist = null;
        svgCon.addEventListener('touchstart', e => {
            if (e.touches.length === 2)
                _pinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                                        e.touches[0].clientY - e.touches[1].clientY);
        }, { passive: true });
        svgCon.addEventListener('touchmove', e => {
            if (e.touches.length !== 2 || !_pinchDist) return;
            e.preventDefault();
            const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                                 e.touches[0].clientY - e.touches[1].clientY);
            const r  = svgCon.getBoundingClientRect();
            _zoomAt((e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left,
                    (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top,
                    d / _pinchDist);
            _pinchDist = d;
        }, { passive: false });
        svgCon.addEventListener('touchend', () => { _pinchDist = null; });

        // Keyboard shortcuts (active while mouse is over svgCon)
        svgCon.addEventListener('mouseenter', () => { _keysActive = true; });
        svgCon.addEventListener('mouseleave', () => { _keysActive = false; });
        window.addEventListener('keydown', e => {
            if (!_keysActive) return;
            const ae = document.activeElement;
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
            const cw = svgCon.clientWidth, ch = svgCon.clientHeight;
            if      (e.key === 'f' || e.key === 'F')  { e.preventDefault(); _fitAll(); }
            else if (e.key === '+' || e.key === '=')  { e.preventDefault(); _zoomAt(cw/2, ch/2, 1.2); }
            else if (e.key === '-')                    { e.preventDefault(); _zoomAt(cw/2, ch/2, 1/1.2); }
            else if (e.key === '0')                    { e.preventDefault(); _z=1; _tx=0; _ty=0; _applyVP(); }
        });

        const wrap = document.createElement('div');
        wrap.className = 'nb-config-org-wrap';

        // Filter bar — always shown in org mode
        {
            const bar = document.createElement('div');
            bar.className = 'nb-config-org-filterbar';

            const lbl = document.createElement('span');
            lbl.className = 'nb-config-org-filterlabel';
            lbl.textContent = 'Configs:';
            bar.appendChild(lbl);

            // Update all <title> elements to show context around the active filter key
            function _updateTooltips(spec) {
                svg.querySelectorAll('.nb-config-org-node').forEach(g => {
                    const tip = g.querySelector('title');
                    if (!tip) return;
                    const tipPath = g.dataset.tipPath || '';
                    const keys    = (g.dataset.cfgKeys || '').split(',').filter(Boolean);
                    const vals    = JSON.parse(g.dataset.cfgVals || '{}');

                    let kvLines;
                    if (!spec || !keys.length) {
                        // No filter: first C keys + overflow hint
                        kvLines = keys.slice(0, context).map(k => `${k}: ${typeof vals[k] === 'object' ? JSON.stringify(vals[k]) : vals[k]}`);
                        if (keys.length > context) kvLines.push(`… +${keys.length - context} more`);
                    } else {
                        const ki = keys.indexOf(spec.key);
                        if (ki < 0) {
                            kvLines = keys.slice(0, context).map(k => `${k}: ${typeof vals[k] === 'object' ? JSON.stringify(vals[k]) : vals[k]}`);
                        } else {
                            const lo = Math.max(0, ki - context);
                            const hi = Math.min(keys.length, ki + context + 1);
                            kvLines = [];
                            if (lo > 0) kvLines.push(`⋯ ${lo} above`);
                            for (let i = lo; i < hi; i++) {
                                const v = typeof vals[keys[i]] === 'object' ? JSON.stringify(vals[keys[i]]) : vals[keys[i]];
                                kvLines.push(`${i === ki ? '▶ ' : '  '}${keys[i]}: ${v}`);
                            }
                            if (hi < keys.length) kvLines.push(`⋯ ${keys.length - hi} below`);
                        }
                    }

                    tip.textContent = g.dataset.hasCfg
                        ? [tipPath, ...kvLines].join('\n')
                        : `${tipPath}\n(no config — click to create)`;
                });
            }

            // spec: null = all | { key } = key-only | { key, val } = key:value
            function _applyFilter(spec, { clearInput = false } = {}) {
                if (clearInput) input.value = '';
                bar.querySelectorAll('.nb-config-org-chip').forEach(c => {
                    const active = !spec ? c.dataset.key === 'all'
                        : spec.val !== undefined ? c.dataset.key === `${spec.key}:${spec.val}`
                        : c.dataset.key === spec.key;
                    c.classList.toggle('nb-config-org-chip-active', active);
                });
                svg.querySelectorAll('.nb-config-org-node').forEach(g => {
                    if (!spec) { g.classList.remove('nb-config-org-dim', 'nb-config-org-active'); return; }
                    const keys = (g.dataset.cfgKeys || '').split(',').filter(Boolean);
                    let hit;
                    if (spec.val !== undefined) {
                        const vals = JSON.parse(g.dataset.cfgVals || '{}');
                        hit = String(vals[spec.key] ?? '') === spec.val;
                    } else {
                        hit = keys.includes(spec.key);
                    }
                    g.classList.toggle('nb-config-org-dim',    !hit);
                    g.classList.toggle('nb-config-org-active',  hit);
                });
                _updateTooltips(spec);
            }

            _updateTooltips(null);

            // Freeform text input — type any key or key:value
            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = 'key or key:value…';
            input.className = 'nb-config-org-filter-input';
            let _ft;
            input.addEventListener('input', () => {
                clearTimeout(_ft);
                _ft = setTimeout(() => {
                    const v = input.value.trim();
                    if (!v) { _applyFilter(null); return; }
                    const ci = v.indexOf(':');
                    const spec = ci > 0 ? { key: v.slice(0, ci), val: v.slice(ci + 1) } : { key: v };
                    // Deactivate predefined chips; freeform is now driving
                    bar.querySelectorAll('.nb-config-org-chip').forEach(c => c.classList.remove('nb-config-org-chip-active'));
                    _applyFilter(spec);
                }, 180);
            });
            input.addEventListener('keydown', e => {
                if (e.key === 'Escape') { input.value = ''; _applyFilter(null, { clearInput: false }); }
            });
            bar.appendChild(input);

            // "all" chip
            const allChip = document.createElement('span');
            allChip.className = 'nb-config-org-chip nb-config-org-chip-active';
            allChip.dataset.key = 'all';
            allChip.textContent = 'all';
            allChip.addEventListener('click', () => _applyFilter(null, { clearInput: true }));
            bar.appendChild(allChip);

            // attr chips — detect key:value vs key-only
            treeAttrs.forEach(attr => {
                const ci = attr.indexOf(':');
                const spec = ci > 0
                    ? { key: attr.slice(0, ci), val: attr.slice(ci + 1) }
                    : { key: attr };
                const c = document.createElement('span');
                c.className = 'nb-config-org-chip';
                c.dataset.key = attr;
                c.textContent = attr;
                c.addEventListener('click', () => _applyFilter(spec, { clearInput: true }));
                bar.appendChild(c);
            });
            wrap.appendChild(bar);
        }

        wrap.appendChild(svgCon);
        el.appendChild(wrap);
        requestAnimationFrame(_fitAll);
    }

    function _configRender(el, nodes, key, currentSelector, wasOpen, notebook, folder) {
        el.innerHTML = '';
        el.className = (el.className || '').replace(/\bnb-spin\b/, '').trim();

        // ── Header ──────────────────────────────────────────────────────────
        const { hdr, meta, refBtn, helpBtn } = _buildBarHeader(el, {
            lang: 'cfg', cls: 'config', collapseZone: true,
            onRefresh: () => _loadConfigBlock(el), onHelp: _configHelpPopover,
        });
        helpBtn.className += ' nb-config-btn';
        refBtn.className  += ' nb-config-btn';
        meta.textContent = 'cfg';
        if (key) {
            const kspan = document.createElement('code');
            kspan.className = 'nb-config-hdr-key';
            kspan.textContent = key + ':';
            meta.appendChild(document.createTextNode(' '));
            meta.appendChild(kspan);
        }
        el.appendChild(hdr);
        if (!wasOpen) el.classList.add('nb-collapsed');
        _initCollapseToggle(el);

        const ICONS  = { global: '🌐', notebook: '📒', folder: '📁', subfolder: '📂', note: '📄' };
        const INDENT = { global: 0, notebook: 1, folder: 2, subfolder: 3, note: 4 };

        // Effective = last (highest priority) node that contributes the queried key.
        // If no key, effective = deepest existing node.
        const deepest = key
            ? [...nodes].reverse().find(n => n.contributes && n.contributes[key] !== undefined)
            : [...nodes].reverse().find(n => n.exists);

        const table = document.createElement('table');
        table.className = 'nb-config-tree';

        for (const node of nodes) {
            const isHere      = node.exists && currentSelector && node.selector === currentSelector;
            const isEffective = !isHere && node === deepest;
            const contrib     = node.contributes || {};

            const tr = document.createElement('tr');
            tr.className = 'nb-config-node'
                + (node.exists    ? ''                    : ' nb-config-missing')
                + (isHere         ? ' nb-config-here'     : '')
                + (isEffective    ? ' nb-config-effective': '');
            tr.dataset.level = node.level;

            // Marker cell
            const tdM = document.createElement('td');
            tdM.className = 'nb-config-marker';
            tdM.textContent = isHere ? '◉' : (isEffective ? '▶' : (node.exists ? '●' : '○'));

            // Icon cell (indented by depth)
            const tdI = document.createElement('td');
            tdI.className = 'nb-config-icon';
            tdI.style.paddingLeft = `${(INDENT[node.level] || 0) * 1.2}em`;
            tdI.textContent = ICONS[node.level] || '·';

            // Path/name cell
            const tdN = document.createElement('td');
            tdN.className = 'nb-config-name-cell';
            const displayName = node.level === 'note'
                ? node.selector
                : node.path.replace(/.*\/\.nb\//, '~/.nb/');
            if (node.exists) {
                const btn = document.createElement('button');
                btn.className = 'nb-nav-link nb-config-name';
                btn.textContent = displayName;
                btn.addEventListener('click', () => NbMain.openNote(node.selector));
                tdN.appendChild(btn);
            } else {
                tdN.className += ' nb-config-name nb-config-name--missing';
                tdN.textContent = displayName;
                if (node.level === 'folder' || node.level === 'subfolder' || node.level === 'notebook') {
                    const createBtn = document.createElement('button');
                    createBtn.className = 'nb-tw-btn nb-config-create-btn';
                    createBtn.title = 'Create config file here';
                    createBtn.textContent = '＋ Create';
                    createBtn.addEventListener('click', async e => {
                        e.stopPropagation();
                        createBtn.disabled = true; createBtn.textContent = '⟳ creating…';
                        const body = { notebook };
                        if (node.level !== 'notebook') {
                            // Derive folder from path: strip ~/.nb/{notebook}/ prefix and .{leaf}.md suffix
                            const nbPrefix = new RegExp(`.*\\/\\.nb\\/${notebook}\\/`);
                            body.folder = node.path.replace(nbPrefix, '').replace(/\/\.[^/]+\.md$/, '');
                        }
                        try {
                            const r = await fetch('/api/config-create', {
                                method: 'POST',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify(body),
                            });
                            const d = await r.json();
                            if (d.selector) {
                                await _loadConfigBlock(el);
                                NbMain.openNote(d.selector);
                            } else {
                                createBtn.disabled = false; createBtn.textContent = '＋ Create';
                            }
                        } catch {
                            createBtn.disabled = false; createBtn.textContent = '＋ Create';
                        }
                    });
                    tdN.appendChild(createBtn);
                }
            }

            // Value cell — always rendered; dash when key not set at this level
            const tdV = document.createElement('td');
            tdV.className = 'nb-config-contrib';
            if (key) {
                if (contrib[key] !== undefined) {
                    tdV.textContent = _configFormatVal(contrib[key]);
                    tdV.classList.add('nb-config-contrib-key');
                } else {
                    tdV.textContent = '—';
                    tdV.classList.add('nb-config-contrib-empty');
                }
            } else {
                const keys = Object.keys(contrib);
                keys.forEach((k, i) => {
                    const sp = document.createElement('span');
                    sp.textContent = k;
                    sp.dataset.xrefHeading = k;
                    tdV.appendChild(sp);
                    if (i < keys.length - 1) tdV.appendChild(document.createTextNode(', '));
                });
            }

            tr.appendChild(tdM);
            tr.appendChild(tdI);
            tr.appendChild(tdN);
            tr.appendChild(tdV);
            table.appendChild(tr);
        }

        if (key) {
            const lbl = document.createElement('div');
            lbl.className = 'nb-config-key-label';
            lbl.textContent = key + ':';
            lbl.dataset.xrefHeading = key;
            el.appendChild(lbl);
        }
        el.appendChild(table);
    }

    function _configFormatVal(v) {
        if (v === null || v === undefined) return '';
        if (typeof v === 'object') return Array.isArray(v) ? v.join(', ') : '{…}';
        return String(v);
    }

    // ── test codeblock ────────────────────────────────────────────────────────
    // Form 1: "script | Label"  → clickable button; runs on click; resets on pass
    // Form 2: "script"          → auto-runs at render; invisible on pass+empty output

    // Collect the names of all scripts that will auto-run (Form 2) across a set
    // of .nb-test-block elements.  Used to build the batch request.
    function _collectAutoRunScripts(blocks) {
        // Glob prefixes (dangling dash) can't be pre-collected without a network
        // round trip — they're resolved lazily in _loadTestBlock instead.
        const scripts = new Set();
        for (const el of blocks) {
            const raw   = (el.dataset.query || '').trim();
            const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length <= 1) {
                const line   = lines[0] || '';
                const pipe   = line.indexOf('|');
                const script = (pipe >= 0 ? line.slice(0, pipe) : line).trim();
                const label  = pipe >= 0 ? line.slice(pipe + 1).trim() : '';
                if (script && !label && !script.endsWith('-')) scripts.add(script);
            } else {
                // Multi-script: only collect if the group has no label (auto-run mode)
                let groupLabel = '';
                const parsed = [];
                for (const line of lines) {
                    if (line.startsWith('|')) { groupLabel = groupLabel || line.slice(1).trim(); continue; }
                    const pipe   = line.indexOf('|');
                    const script = (pipe >= 0 ? line.slice(0, pipe) : line).trim();
                    const label  = pipe >= 0 ? line.slice(pipe + 1).trim() : '';
                    if (script && !script.endsWith('-')) { parsed.push(script); groupLabel = groupLabel || label; }
                }
                if (!groupLabel) parsed.forEach(s => scripts.add(s));
            }
        }
        return [...scripts];
    }

    // POST /api/check/batch — one round trip for N scripts.  Returns a Map of
    // script → result.  On any error returns an empty Map so callers fall back
    // to individual /api/check/run fetches transparently.
    async function _fetchTestBatch(scripts, selector) {
        try {
            const r = await fetch('/api/check/batch', {
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

    // Resolve a dangling-dash prefix (e.g. 'nb-schem-') to a sorted list of
    // matching script names via /api/check/glob.  Returns [] on any error.
    async function _resolveTestGlob(prefix) {
        try {
            const r = await fetch(`/api/check/glob?prefix=${encodeURIComponent(prefix)}`);
            if (!r.ok) return [];
            const names = await r.json();
            return Array.isArray(names) ? names : [];
        } catch { return []; }
    }

    async function _buildCheckList(el, prefix) {
        if (!_cbCan(el, 'check', 'read')) { el.remove(); return; }
        const _initCollapsed = el.hasAttribute('data-init-collapsed');
        el.classList.remove('nb-collapsed');
        el.innerHTML = '<span class="nb-spin">⟳</span>';

        const load = async () => {
            el.querySelectorAll('.nb-check-list-body').forEach(n => n.remove());
            let names;
            try {
                names = await _resolveTestGlob(prefix);
            } catch (e) {
                const body = document.createElement('div');
                body.className = 'nb-check-list-body';
                body.innerHTML = `<span class="nb-hl-muted">⚠ ${_esc(e.message)}</span>`;
                el.appendChild(body);
                return;
            }

            const metaEl = el.querySelector('.nb-test-meta');
            if (metaEl) {
                const filterHtml = prefix ? ` <code>${_esc(prefix)}*</code>` : '';
                metaEl.innerHTML = `<span class="nb-test-name">check list</span><span class="nb-tw-count">${names.length}</span>${filterHtml}`;
            }

            const body = document.createElement('div');
            body.className = 'nb-check-list-body';

            if (!names.length) {
                body.innerHTML = `<span class="nb-hl-muted">No scripts match${prefix ? ' ' + _esc(prefix) + '*' : ''}.</span>`;
                el.appendChild(body);
                return;
            }

            const list = document.createElement('div');
            list.className = 'nb-check-list';
            names.forEach(name => {
                const script = name.replace(/\.sh$/, '');
                const row    = document.createElement('div');
                row.className = 'nb-check-list-row';

                const iconBtn = document.createElement('button');
                iconBtn.className = 'nb-check-list-icon-btn';
                iconBtn.innerHTML = _checkDomainIcon(script) || '▶';
                iconBtn.title     = `Demo ${script}`;

                const nameBtn = document.createElement('button');
                nameBtn.className   = 'nb-check-list-name-btn';
                nameBtn.textContent = script;
                nameBtn.title       = 'Open script';
                nameBtn.addEventListener('click', () => NbMain.openNote(`.checks:${name}`));

                const ctrl = document.createElement('div');
                ctrl.className = 'nb-check-list-ctrl';
                ctrl.appendChild(iconBtn);
                ctrl.appendChild(nameBtn);

                const out = document.createElement('div');
                out.className = 'nb-test-out';

                iconBtn.addEventListener('click', async () => {
                    if (out.childElementCount) { out.innerHTML = ''; iconBtn.classList.remove('nb-active'); return; }
                    iconBtn.disabled = true;
                    nameBtn.disabled = true;
                    out.innerHTML = '<span class="nb-spin">⟳</span>';
                    try {
                        const r = await fetch('/api/check/run', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ script, selector: NbMain.activeSelector() || '', force: true, demo: true }),
                        });
                        const d = await r.json();
                        const { text, severity } = _parseCheckResult(d, script);
                        if (!text) {
                            out.innerHTML = '<span class="nb-check-list-pass">no --demo output</span>';
                            setTimeout(() => { out.innerHTML = ''; iconBtn.classList.remove('nb-active'); }, 2000);
                        } else {
                            const result = document.createElement('div');
                            result.className = 'nb-test-result' + _severityClass(severity);
                            result.innerHTML = NbMain.renderMarkdown(text, '');
                            NbMain.enrichRendered(result, null);
                            _enrichSubtests(result);
                            out.innerHTML = '';
                            out.appendChild(result);
                            iconBtn.classList.add('nb-active');
                        }
                    } catch (e) {
                        out.innerHTML = `<span class="nb-hl-muted">⚠ ${_esc(e.message)}</span>`;
                    }
                    iconBtn.disabled = false;
                    nameBtn.disabled = false;
                });

                row.appendChild(ctrl);
                row.appendChild(out);
                list.appendChild(row);
            });
            body.appendChild(list);
            el.appendChild(body);
        };

        const { hdr, meta } = _buildBarHeader(el, { lang: 'test', onRefresh: load });
        const filterHtml = prefix ? ` <code>${_esc(prefix)}*</code>` : '';
        meta.innerHTML = `<span class="nb-test-name">check list</span><span class="nb-tw-count">…</span>${filterHtml}`;
        el.innerHTML = '';
        el.appendChild(hdr);

        try {
            await load();
        } finally {
            _initCollapseToggle(el);
            if (_initCollapsed) el.classList.add('nb-collapsed');
        }
    }

    async function _loadTestBlock(el, batchMap = new Map()) {
        const raw   = (el.dataset.query || '').trim();
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

        if (lines.length <= 1) {
            // Single-script or single glob prefix
            const line   = lines[0] || '';
            const pipe   = line.indexOf('|');
            const token  = (pipe >= 0 ? line.slice(0, pipe) : line).trim();
            const label  = pipe >= 0 ? line.slice(pipe + 1).trim() : '';
            if (!token) { el.remove(); return; }

            // "list" or "list prefix-" — check script browser
            if (token === 'list' || token.startsWith('list ')) {
                const prefix = token === 'list' ? '' : token.slice(5).trim();
                await _buildCheckList(el, prefix);
                return;
            }

            // Dangling dash — resolve to a group
            if (token.endsWith('-')) {
                if (!_cbCan(el, 'check', 'read')) { el.remove(); return; }
                const names = await _resolveTestGlob(token);
                if (!names.length) { el.innerHTML = `<span class="nb-hl-muted">No scripts match ${_esc(token)}*.sh</span>`; return; }
                const scripts = names.map(n => ({ script: n, label: n.replace(/\.sh$/, '') }));
                const groupLabel = label || token;
                if (label) { _buildGroupBtn(el, scripts, groupLabel); }
                else       { await _runGroupTest(el, scripts, null, null, batchMap); }
                return;
            }

            if (!_cbCan(el, 'check', 'read')) { el.remove(); return; }
            if (label) { _buildTestBtn(el, token, label); }
            else       { await _runTest(el, token, null, null, batchMap.get(token) ?? null); }
            return;
        }

        // Multi-script group — parse scripts and optional group label.
        // A line starting with | (no script) sets the group label only.
        // A glob line (ends with -) expands inline before running.
        const scripts = [];
        let groupLabel = '';
        for (const line of lines) {
            if (line.startsWith('|')) { groupLabel = groupLabel || line.slice(1).trim(); continue; }
            const pipe   = line.indexOf('|');
            const token  = (pipe >= 0 ? line.slice(0, pipe) : line).trim();
            const label  = pipe >= 0 ? line.slice(pipe + 1).trim() : '';
            if (!token) continue;
            if (token.endsWith('-')) {
                const names = await _resolveTestGlob(token);
                names.forEach(n => scripts.push({ script: n, label: n.replace(/\.sh$/, '') }));
            } else {
                if (token) { scripts.push({ script: token, label }); groupLabel = groupLabel || label; }
            }
        }
        if (!scripts.length) { el.remove(); return; }

        if (!_cbCan(el, 'check', 'read')) { el.remove(); return; }

        if (groupLabel) {
            _buildGroupBtn(el, scripts, groupLabel);
        } else {
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
                const r = await fetch('/api/check/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ script, selector, force }),
                });
                return { script, ...(await r.json()) };
            } catch (e) {
                return { script, error: String(e), exit_code: 1, stdout: '' };
            }
        }));

        const parsed  = results.map(r => ({ ...r, ..._parseCheckResult(r, r.script) }));
        const failures = parsed.filter(r => r.severity !== 'pass' || r.text);
        if (!failures.length) { if (!btn) el.remove(); return; }

        const result  = document.createElement('div');
        result.className = 'nb-test-result nb-test-result--group';

        const worstSeverity = failures.some(r => r.severity === 'error') ? 'error' : 'warn';
        const wrap = document.createElement('div');
        wrap.className = 'nb-rendered nb-group-result' + _severityClass(worstSeverity);

        // A shared domain icon (all failures from the same script family, e.g. all
        // "hl-") is hoisted to the header instead of repeated on every subtest row —
        // otherwise a "12 of 23 failed" group shows the same icon 12 times in a row.
        // Mixed-domain groups fall back to per-row icons, where they're informative.
        const failureIcons = new Set(failures.map(({ script }) => _checkDomainIcon(script)));
        const sharedIcon = failureIcons.size === 1 ? [...failureIcons][0] : '';

        const headRow = document.createElement('div');
        headRow.className = 'nb-group-headrow';

        const toggle = document.createElement('button');
        toggle.className = 'nb-group-toggle';
        toggle.dataset.open = '0';
        toggle.innerHTML = sharedIcon + _esc(`${failures.length} of ${scripts.length} check${scripts.length !== 1 ? 's' : ''} failed`);
        headRow.appendChild(toggle);

        const dismiss = document.createElement('button');
        dismiss.className = 'nb-test-dismiss nb-group-dismiss';
        dismiss.title = 'Dismiss until next render';
        dismiss.textContent = '×';
        dismiss.addEventListener('click', () => { el.innerHTML = ''; });
        headRow.appendChild(dismiss);

        wrap.appendChild(headRow);

        const groupBody = document.createElement('div');
        groupBody.className = 'nb-group-body';
        groupBody.hidden = true;
        toggle.addEventListener('click', () => {
            const open = toggle.dataset.open === '1';
            toggle.dataset.open = open ? '0' : '1';
            groupBody.hidden = open;
        });

        failures.forEach(({ script, text, severity }) => {
            const entry = scripts.find(s => s.script === script);
            const label = (entry && entry.label) || script;

            const row = document.createElement('div');
            row.className = 'nb-subtest';

            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'nb-subtest-toggle';
            const iconHtml = sharedIcon ? '' : _checkDomainIcon(script);
            if (iconHtml) {
                toggleBtn.innerHTML = iconHtml + _esc(label);
            } else {
                toggleBtn.textContent = label;
            }

            const body = document.createElement('div');
            body.className = 'nb-subtest-body';
            body.hidden = true;

            const inner = document.createElement('div');
            inner.className = 'nb-rendered' + _severityClass(severity);
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
            groupBody.appendChild(row);
        });

        wrap.appendChild(groupBody);
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

    // Parse a raw check API response into { text, meta, severity }.
    // Strips optional #! metadata first line; derives severity from exit code;
    // injects fix: as a subtest link; auto-generates fallback text from script name.
    function _parseCheckResult(d, script) {
        let text = (d.stdout || '').trim();
        const meta = {};

        if (text.startsWith('#!')) {
            const nl = text.indexOf('\n');
            const header = nl >= 0 ? text.slice(0, nl) : text;
            text = nl >= 0 ? text.slice(nl + 1).trimStart() : '';
            header.slice(2).trim().split(/\s+/).forEach(pair => {
                const i = pair.indexOf(':');
                if (i > 0) meta[pair.slice(0, i)] = pair.slice(i + 1);
            });
        }

        const severity = d.exit_code === 0 ? 'pass' : d.exit_code === 2 ? 'warn' : 'error';

        if (meta.fix) text += (text ? '\n\n' : '') + `[→ run fix](subtest:${meta.fix})`;
        if (!text && severity !== 'pass') text = d.error || `**${script}** check failed`;

        return { text, meta, severity };
    }

    // Map script domain prefix → inline icon HTML (img or chip span).
    // Image domains match _CB_ICONS; others get a monospace chip until a logo lands.
    function _checkDomainIcon(script) {
        const img = (sel, alt, direct = false) =>
            `<img src="${direct ? '/' + sel : '/api/file?selector=' + encodeURIComponent(sel)}" class="nb-check-icon" alt="${alt}">`;
        const chip = t => `<span class="nb-check-icon nb-check-icon--chip">${t}</span>`;

        if (script.startsWith('hl-'))    return img('.images:hledger-logo.png', 'hledger') + ' ';
        if (script.startsWith('nb-'))    return img('nb-logo.png', 'nb', true) + ' ';
        if (script.startsWith('note-'))  return img('nb-logo.png', 'nb', true) + ' ';
        if (script.startsWith('tw-'))    return img('.images:tw-logo.png', 'Taskwarrior') + ' ';
        if (script.startsWith('git-'))   return img('.images:git-logo.png', 'git') + ' ';
        if (script.startsWith('flask-')) return chip('FLK') + ' ';
        if (script.startsWith('sys-'))   return chip('SYS') + ' ';
        if (script.startsWith('test-'))  return chip('TST') + ' ';
        return '';
    }

    function _severityClass(severity) {
        return severity === 'error' ? ' nb-test-fail' : severity === 'warn' ? ' nb-test-warn' : '';
    }

    // Snooze helpers — suppress a check for N minutes after dismiss.
    // key: nb-snooze:<selector>:<script>  value: expiry ms timestamp
    function _snoozeKey(selector, script) { return `nb-snooze:${selector}:${script}`; }
    function _isSnoozed(selector, script) {
        try {
            const exp = parseInt(localStorage.getItem(_snoozeKey(selector, script)) || '0', 10);
            return exp > Date.now();
        } catch { return false; }
    }
    function _snooze(selector, script, minutes) {
        try { localStorage.setItem(_snoozeKey(selector, script), String(Date.now() + minutes * 60000)); }
        catch {}
    }

    async function _runTest(el, script, btn, out, cachedResult = null) {
        const selector = NbMain.activeSelector() || '';
        const force    = btn !== null;   // user-clicked = always fresh; auto-run = cacheable

        // Snooze: skip auto-runs while snooze is active (force/button click always runs)
        if (!force && _isSnoozed(selector, script)) { el.remove(); return; }

        let d;
        if (cachedResult && !force) {
            d = cachedResult;
        } else {
            try {
                const r = await fetch('/api/check/run', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ script, selector, force }),
                });
                d = await r.json();
            } catch (e) {
                d = { error: String(e), exit_code: 1, stdout: '' };
            }
        }

        const { text, severity } = _parseCheckResult(d, script);
        const pass = severity === 'pass' && !text;

        if (pass) {
            if (!btn) el.remove();
            return;
        }

        const snoozeMin = parseInt(NbMain.activeNote()?.meta?.check_timeout ?? 0, 10);

        const result = document.createElement('div');
        result.className = 'nb-test-result';

        const dismiss = document.createElement('button');
        dismiss.className = 'nb-test-dismiss';
        dismiss.title    = snoozeMin > 0 ? `Snooze ${snoozeMin} min` : 'Dismiss';
        dismiss.textContent = snoozeMin > 0 ? '⏸' : '×';
        dismiss.addEventListener('click', () => {
            if (snoozeMin > 0) _snooze(selector, script, snoozeMin);
            el.innerHTML = '';
        });
        result.appendChild(dismiss);

        const iconHtml = _checkDomainIcon(script);
        if (iconHtml) {
            const iconEl = document.createElement('span');
            iconEl.className = 'nb-check-result-icon';
            iconEl.innerHTML = iconHtml;
            result.appendChild(iconEl);
        }

        const wrap = document.createElement('div');
        wrap.className = 'nb-rendered' + _severityClass(severity);
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
                    const r = await fetch('/api/check/run', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ script, selector, force: true }),
                    });
                    d = await r.json();
                } catch (e) {
                    d = { error: String(e), exit_code: 1, stdout: '' };
                }

                const { text: rText, severity: rSev } = _parseCheckResult(d, script);
                const displayText = rText || (rSev === 'pass' ? '✓ Check passed.' : '');
                const inner = document.createElement('div');
                inner.className = 'nb-rendered' + _severityClass(rSev);
                inner.innerHTML = NbMain.renderMarkdown(displayText, '');
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

    // ── sysadmin ──────────────────────────────────────────────────────────────

    function _dispatchSysadminBlock(el) {
        if (el.dataset.mode === 'users')    return _loadSysadminUsersBlock(el);
        if (el.dataset.mode === 'crontab')  return _loadSysadminCrontabBlock(el);
        return _loadSysadminBlock(el);
    }

    async function _loadSysadminCrontabBlock(el) {
        el.innerHTML = '<span class="nb-spin">⟳</span>';
        try {
            const r = await fetch('/api/sysadmin/crontab');
            if (r.status === 403) { el.innerHTML = '<span class="nb-sa-muted">Crontab view requires tech level.</span>'; return; }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const d = await r.json();
            const entries = d.entries || [];

            const rows = entries.map(e => `<tr>
                <td class="nb-sa-muted"><code>${_esc(e.schedule)}</code></td>
                <td><code>${_esc(e.command)}</code></td>
                <td class="nb-sa-muted">${_esc(e.description || '')}</td>
            </tr>`).join('');

            el.innerHTML = `
                <div class="nb-sa-section">
                    <div class="nb-sa-heading">Crontab
                        <span class="nb-sa-muted">${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</span>
                    </div>
                    ${entries.length
                        ? `<table class="nb-sa-table">
                            <thead><tr><th>Schedule</th><th>Command</th><th>Description</th></tr></thead>
                            <tbody>${rows}</tbody>
                          </table>`
                        : '<span class="nb-sa-muted">No crontab entries.</span>'}
                </div>`;
        } catch(e) {
            el.innerHTML = `<span style="color:var(--red)">⚠ ${_esc(String(e))}</span>`;
        }
    }

    const _SA_LEVELS = ['guest', 'user', 'office', 'admin', 'tech'];

    async function _loadSysadminUsersBlock(el) {
        el.innerHTML = '<span class="nb-spin">⟳</span>';
        try {
            const r = await fetch('/api/users');
            if (r.status === 403) { el.innerHTML = '<span class="nb-sa-muted">User management requires admin level.</span>'; return; }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const d = await r.json();
            const myLevel = window.NbAuth?.level() || 'guest';
            const myUsername = window.NbUser?.username || '';

            const renderRow = u => {
                const isSelf = u.username === myUsername;
                const levelSel = _SA_LEVELS.map(l =>
                    `<option value="${l}"${l === u.level ? ' selected' : ''}>${l}</option>`
                ).join('');
                const nbs = u.notebooks?.length ? u.notebooks.join(', ') : '(all)';
                const delBtn = isSelf ? '' :
                    `<button class="nb-sa-user-del nb-action-admin" data-username="${_esc(u.username)}" title="Delete user">🗑</button>`;
                return `<tr data-username="${_esc(u.username)}">
                    <td class="nb-sa-name">
                        <a href="#" class="nb-sa-link" data-open="${_esc(u.selector)}">${_esc(u.username)}</a>
                        ${isSelf ? '<span class="nb-sa-self-badge">you</span>' : ''}
                    </td>
                    <td><select class="nb-sa-level-sel nb-action-admin" data-username="${_esc(u.username)}" data-orig="${_esc(u.level)}">${levelSel}</select></td>
                    <td class="nb-sa-muted">${_esc(u.name)}</td>
                    <td class="nb-sa-muted nb-sa-notebooks">${_esc(nbs)}</td>
                    <td>${delBtn}</td>
                </tr>`;
            };

            const rows = (d.users || []).map(renderRow).join('');

            el.innerHTML = `
                <div class="nb-sa-section">
                    <div class="nb-sa-heading">Users
                        <span class="nb-sa-muted">${(d.users || []).length} accounts</span>
                        <button class="nb-sa-add-user-btn nb-action-admin">+ Add user</button>
                    </div>
                    <table class="nb-sa-table nb-sa-users-table">
                        <thead><tr><th>Username</th><th>Level</th><th>Name</th><th>Notebooks</th><th></th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                    <div class="nb-sa-add-form" hidden>
                        <div class="nb-sa-form-row">
                            <input class="nb-sa-input" name="username" placeholder="username" autocomplete="off">
                            <input class="nb-sa-input" name="name"     placeholder="display name">
                            <select class="nb-sa-input" name="level">
                                ${_SA_LEVELS.map(l => `<option value="${l}"${l==='user'?' selected':''}>${l}</option>`).join('')}
                            </select>
                            <input class="nb-sa-input" name="password" type="password" placeholder="password">
                            <button class="nb-sa-form-create nb-btn-primary">Create</button>
                            <button class="nb-sa-form-cancel">Cancel</button>
                        </div>
                        <div class="nb-sa-form-err" hidden></div>
                    </div>
                </div>`;

            // Level change
            el.addEventListener('change', async ev => {
                const sel = ev.target.closest('.nb-sa-level-sel');
                if (!sel) return;
                const username = sel.dataset.username;
                const level    = sel.value;
                sel.disabled   = true;
                try {
                    const r = await fetch(`/api/users/${encodeURIComponent(username)}`, {
                        method: 'PUT',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ level }),
                    });
                    if (!r.ok) {
                        const e = await r.json().catch(() => ({}));
                        alert(e.error || `Failed to update ${username}`);
                        sel.value = sel.dataset.orig;
                    } else {
                        sel.dataset.orig = level;
                    }
                } finally { sel.disabled = false; }
            });

            // Delete user
            el.addEventListener('click', async ev => {
                const btn = ev.target.closest('.nb-sa-user-del');
                if (!btn) return;
                const username = btn.dataset.username;
                if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
                btn.disabled = true;
                const r = await fetch(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
                if (r.ok) {
                    btn.closest('tr').remove();
                } else {
                    const e = await r.json().catch(() => ({}));
                    alert(e.error || 'Delete failed');
                    btn.disabled = false;
                }
            });

            // Add user form toggle
            const addBtn  = el.querySelector('.nb-sa-add-user-btn');
            const form    = el.querySelector('.nb-sa-add-form');
            const errEl   = el.querySelector('.nb-sa-form-err');
            addBtn.addEventListener('click', () => { form.hidden = false; addBtn.hidden = true; });
            el.querySelector('.nb-sa-form-cancel').addEventListener('click', () => { form.hidden = true; addBtn.hidden = false; errEl.hidden = true; });

            el.querySelector('.nb-sa-form-create').addEventListener('click', async () => {
                const get = name => form.querySelector(`[name="${name}"]`).value.trim();
                const body = { username: get('username'), name: get('name'), level: get('level'), password: get('password') };
                if (!body.username || !body.password) { errEl.textContent = 'Username and password required.'; errEl.hidden = false; return; }
                const r = await fetch('/api/users', {
                    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
                });
                if (r.ok) {
                    _loadSysadminUsersBlock(el);  // refresh
                } else {
                    const e = await r.json().catch(() => ({}));
                    errEl.textContent = e.error || 'Create failed';
                    errEl.hidden = false;
                }
            });

        } catch(e) {
            el.innerHTML = `<span style="color:var(--red)">⚠ ${_esc(String(e))}</span>`;
        }
    }

    async function _loadSysadminBlock(el) {
        el.innerHTML = '<span class="nb-spin">⟳</span>';
        try {
            const r = await fetch('/api/sysadmin');
            if (!r.ok) { el.innerHTML = `<span style="color:var(--red)">Sysadmin error ${r.status}</span>`; return; }
            const d = await r.json();

            const nbRows = (d.notebooks || []).map(nb => {
                const nameCell = nb.selector
                    ? `<a href="#" data-open="${_esc(nb.selector)}" class="nb-sa-link">${_esc(nb.name)}</a>`
                    : `<span class="nb-sa-muted">${_esc(nb.name)}</span>`;
                const tick = v => v ? '<span class="nb-sa-ok">✓</span>' : '<span class="nb-sa-gap">·</span>';
                const chips = (nb.plugins || []).map(p => `<span class="nb-sa-chip">${_esc(p)}</span>`).join('');
                return `<tr>
                    <td class="nb-sa-name">${nameCell}</td>
                    <td class="nb-sa-center">${tick(nb.has_dotfile)}</td>
                    <td class="nb-sa-center">${tick(nb.wired)}</td>
                    <td class="nb-sa-center">${tick(nb.has_checks)}</td>
                    <td>${chips}</td>
                    <td class="nb-sa-count nb-sa-muted">${nb.note_count}</td>
                </tr>`;
            }).join('');

            const pluginsByType = {};
            for (const p of (d.plugins || [])) {
                const t = p.type || 'other';
                (pluginsByType[t] = pluginsByType[t] || []).push(p);
            }
            const pluginHtml = Object.entries(pluginsByType).map(([type, list]) =>
                `<div class="nb-sa-plugin-group">
                    <span class="nb-sa-type-label">${_esc(type)}</span>
                    ${list.map(p =>
                        `<span class="nb-sa-chip${p.enabled ? '' : ' nb-sa-disabled'}" title="${_esc(p.url || '')}">${_esc(p.name)}</span>`
                    ).join('')}
                </div>`
            ).join('');

            const cfgHtml = (d.config_files || []).map(f => {
                const cls  = f.exists ? 'nb-sa-ok' : 'nb-sa-missing';
                const icon = f.exists ? '✓' : '✗';
                const link = f.selector
                    ? `<a href="#" data-open="${_esc(f.selector)}" class="nb-sa-link">${_esc(f.label)}</a>`
                    : `<code>${_esc(f.label)}</code>`;
                return `<div class="nb-sa-cfg-row"><span class="${cls}">${icon}</span> ${link}</div>`;
            }).join('');

            el.innerHTML = `
                <div class="nb-sa-section">
                    <div class="nb-sa-heading">Notebooks
                        <span class="nb-sa-muted">${d.notebooks.length} notebooks · ${d.check_count} checks available</span>
                    </div>
                    <table class="nb-sa-table">
                        <thead><tr>
                            <th>Notebook</th><th>config</th><th>wired</th><th>.checks</th><th>plugins</th><th>notes</th>
                        </tr></thead>
                        <tbody>${nbRows}</tbody>
                    </table>
                </div>
                <div class="nb-sa-section">
                    <div class="nb-sa-heading">Plugins</div>
                    <div class="nb-sa-plugins">${pluginHtml}</div>
                </div>
                <div class="nb-sa-section">
                    <div class="nb-sa-heading">Config files</div>
                    <div class="nb-sa-cfgs">${cfgHtml}</div>
                </div>`;
        } catch(e) {
            el.innerHTML = `<span style="color:var(--red)">⚠ ${_esc(String(e))}</span>`;
        }
    }

    // ── gallery ───────────────────────────────────────────────────────────────

    const _GALLERY_SIZES = { thumb: 80, small: 140, med: 220, large: 320 };

    async function _loadGalleryBlock(el) {
        const raw     = (el.dataset.query || '').trim();
        const space   = raw.indexOf(' ');
        const sizeKey = space < 0 ? raw : raw.slice(0, space);
        const pathArg = space < 0 ? '' : raw.slice(space + 1).trim();
        const cellPx  = _GALLERY_SIZES[sizeKey] || _GALLERY_SIZES.med;
        const selector = NbMain.activeSelector() || '';

        const params = new URLSearchParams({ selector });
        if (pathArg) params.set('path', pathArg);

        try {
            const d = await fetch(`/api/gallery?${params}`).then(r => r.json());
            const images = d.images || [];

            const wasCollapsed = el.classList.contains('nb-collapsed');
            el.innerHTML = '';
            if (wasCollapsed) el.classList.add('nb-collapsed');

            const { hdr, meta } = _buildBarHeader(el, { lang: 'gallery', onRefresh: () => _loadGalleryBlock(el) });
            if (images.length) {
                meta.innerHTML =
                    `<span class="nb-gallery-count">${images.length}</span>` +
                    (pathArg ? ` <code>${_esc(pathArg)}</code>` : '');
            } else {
                meta.innerHTML = `<span class="nb-gallery-empty">${pathArg ? _esc(pathArg) + ' — ' : ''}no images</span>`;
            }

            el.appendChild(hdr);

            if (images.length) {
                const grid = document.createElement('div');
                grid.className = 'nb-gallery-grid';
                grid.style.setProperty('--nb-gcell', cellPx + 'px');

                for (const img of images) {
                    const cell = document.createElement('div');
                    cell.className = 'nb-gallery-cell';
                    const pic = document.createElement('img');
                    pic.className = 'nb-gallery-img';
                    pic.alt = img.name; pic.loading = 'lazy'; pic.src = img.url;
                    pic.addEventListener('click', () => _galleryLightbox(images, img.url));
                    const cap = document.createElement('div');
                    cap.className = 'nb-gallery-cap';
                    cap.textContent = img.name;
                    cell.appendChild(pic);
                    cell.appendChild(cap);
                    grid.appendChild(cell);
                }
                el.appendChild(grid);
            }
            _initCollapseToggle(el);
        } catch (e) {
            _cbError(el, 'gallery', e.message, () => _loadGalleryBlock(el));
        }
    }

    function _loadTocBlock(el) {
        if (!_cbCan(el, 'toc', 'read')) { _cbDenyRead(el); return; }
        el.innerHTML = '';
        const pane = document.getElementById('nb-preview-content');
        const headings = pane ? [...pane.querySelectorAll('h1,h2,h3,h4,h5,h6')] : [];

        // Assign slug IDs to any headings that don't have them yet
        const slugCount = {};
        for (const h of headings) {
            if (!h.id) {
                let slug = h.textContent.trim().toLowerCase()
                    .replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-')
                    .replace(/-+/g, '-').replace(/^-|-$/g, '') || 'section';
                const n = slugCount[slug] ?? 0;
                slugCount[slug] = n + 1;
                h.id = n === 0 ? slug : `${slug}-${n}`;
            }
        }

        const { hdr, meta } = _buildBarHeader(el, { lang: 'toc', collapseZone: true });
        const sel = NbMain.activeSelector() || '';
        const notePath = (() => {
            const raw = sel.includes(':') ? sel.slice(sel.indexOf(':') + 1) : sel;
            if (!raw) return '';
            const parts = raw.split('/');
            const file  = parts[parts.length - 1];
            const parent = parts.length > 1 ? parts[parts.length - 2] : '';
            return parent ? `~/..${parent}/${file}` : `~/${file}`;
        })();
        const countPart = headings.length ? ` · ${headings.length} ↑` : '';
        meta.textContent = notePath ? `${notePath}${countPart}` : (headings.length ? `${headings.length}` : 'empty');
        el.appendChild(hdr);
        _initCollapseToggle(el);

        if (!headings.length) return;

        const ul = document.createElement('ul');
        ul.className = 'nb-toc-list';
        for (const h of headings) {
            const li = document.createElement('li');
            li.className = `nb-toc-${h.tagName.toLowerCase()}`;
            const a = document.createElement('a');
            a.href = '#' + h.id;
            a.textContent = h.textContent;
            a.addEventListener('click', e => {
                e.preventDefault();
                pane.querySelector(`#${CSS.escape(h.id)}`)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            li.appendChild(a);
            ul.appendChild(li);
        }
        const body = document.createElement('div');
        body.className = 'nb-toc-body';
        body.appendChild(ul);
        el.appendChild(body);
    }

    function _galleryLightbox(images, activeUrl) {
        document.getElementById('nb-gallery-lb')?.remove();
        let cur = images.findIndex(i => i.url === activeUrl);

        const lb = document.createElement('div');
        lb.id = 'nb-gallery-lb';
        lb.className = 'nb-gallery-lb';

        const img = document.createElement('img');
        img.className = 'nb-gallery-lb-img';

        const cap = document.createElement('div');
        cap.className = 'nb-gallery-lb-cap';

        function show(idx) {
            cur = ((idx % images.length) + images.length) % images.length;
            img.src = images[cur].url;
            cap.textContent = images[cur].name;
        }

        const prev = document.createElement('button');
        prev.className = 'nb-gallery-lb-nav nb-gallery-lb-prev';
        prev.textContent = '‹';
        prev.addEventListener('click', e => { e.stopPropagation(); show(cur - 1); });

        const next = document.createElement('button');
        next.className = 'nb-gallery-lb-nav nb-gallery-lb-next';
        next.textContent = '›';
        next.addEventListener('click', e => { e.stopPropagation(); show(cur + 1); });

        const close = document.createElement('button');
        close.className = 'nb-gallery-lb-close';
        close.textContent = '×';
        close.addEventListener('click', () => lb.remove());

        lb.addEventListener('click', () => lb.remove());
        img.addEventListener('click', e => e.stopPropagation());

        lb.appendChild(prev); lb.appendChild(img);
        lb.appendChild(next); lb.appendChild(close); lb.appendChild(cap);
        document.body.appendChild(lb);

        const onKey = e => {
            if (!document.getElementById('nb-gallery-lb')) {
                document.removeEventListener('keydown', onKey); return;
            }
            if (e.key === 'Escape')      { lb.remove(); document.removeEventListener('keydown', onKey); }
            if (e.key === 'ArrowLeft')   show(cur - 1);
            if (e.key === 'ArrowRight')  show(cur + 1);
        };
        document.addEventListener('keydown', onKey);

        show(cur);
    }

    // ── csv catalog barblock ─────────────────────────────────────────────────

    function _csvToTable(csvText) {
        const lines = csvText.trim().split('\n').filter(l => l.trim() && l.trim() !== 'contents');
        if (lines.length < 2) return '';
        const headers = lines[0].split(',').map(h => h.trim()).filter(Boolean);
        const thHtml  = headers.map(h => `<th>${_esc(h)}</th>`).join('');
        const trHtml  = lines.slice(1).map(r => {
            const cells = r.split(',').map(c => c.trim());
            return `<tr>${cells.map(c => `<td>${_esc(c)}</td>`).join('')}</tr>`;
        }).join('');
        return `<table class="nb-catalog-table"><thead><tr>${thHtml}</tr></thead><tbody>${trHtml}</tbody></table>`;
    }

    // Compact FM catalog renderer: groups from H2 headings, desc left + cost right,
    // scroll wrapper kicks in after `limit` total items across all groups.
    function _csvRenderCompact(body, limit, srcSelector) {
        const ITEM_H = 24; // px per row for scroll calc
        const lines = body.split('\n');
        let i = 0;
        const groups = [];
        let curGroup = null;

        while (i < lines.length) {
            const line = lines[i];
            if (/^#+\s/.test(line)) {
                curGroup = { name: line.replace(/^#+\s*/, '').trim(), items: [] };
                groups.push(curGroup);
                i++;
            } else if (line.startsWith('```csv')) {
                i++;
                const csvLines = [];
                while (i < lines.length && !lines[i].startsWith('```')) { csvLines.push(lines[i]); i++; }
                i++;
                if (!csvLines.length) continue;
                const rows = csvLines
                    .filter(l => l.trim() && l.trim().toLowerCase() !== 'contents')
                    .map(l => l.split(',').map(c => c.replace(/^"|"$/g, '').replace(/""/g, '"').trim()));
                if (rows.length < 2) continue;
                const hdr = rows[0].map(h => h.toLowerCase());
                const descIdx = hdr.findIndex(h => h.includes('desc') || h.includes('name') || h.includes('item'));
                const costIdx = hdr.findIndex(h => h.includes('cost') || h.includes('price'));
                const di = descIdx >= 0 ? descIdx : 0;
                const ci = costIdx >= 0 ? costIdx : -1;
                if (!curGroup) { curGroup = { name: '', items: [] }; groups.push(curGroup); }
                for (const row of rows.slice(1)) {
                    const desc = row[di] || '';
                    const cost = ci >= 0 ? (row[ci] || '') : '';
                    if (desc) curGroup.items.push({ desc, cost });
                }
            } else { i++; }
        }

        if (!groups.length) return '<span style="color:var(--text-dim);font-size:12px">No items.</span>';

        // Always cap height — browser only shows scrollbar when content overflows.
        // Use 28px per row to account for group heading margins (not just item rows).
        const maxH = limit * ITEM_H;

        let inner = '';
        for (const g of groups) {
            if (!g.items.length) continue;
            const anchor = srcSelector ? ` data-open-src="${_esc(srcSelector)}"` : '';
            if (g.name) inner += `<div class="nb-cat-group"${anchor}>${_esc(g.name)}</div>`;
            for (const { desc, cost } of g.items) {
                inner += `<div class="nb-cat-row"><span class="nb-cat-desc">${_esc(desc)}</span>`
                       + (cost ? `<span class="nb-cat-cost">${_esc(cost)}</span>` : '')
                       + `</div>`;
            }
        }
        return `<div class="nb-cat-scroll" style="max-height:${maxH}px;overflow-y:auto;"><div class="nb-cat-list">${inner}</div></div>`;
    }

    async function _loadCsvCatalogBlock(el) {
        const tokens = (el.dataset.csvTokens || '').split(',').map(t => t.trim()).filter(Boolean);
        const limit  = parseInt(el.dataset.csvLimit || '8', 10);
        const note   = NbMain.activeNote();
        // In FM mode buildFmSkeleton already built the header — don't clobber it.
        // In body mode (no fmLazy marker) build the header ourselves.
        const isFm = el.dataset.fmLazy === '1';
        if (!isFm) {
            el.innerHTML = '';
            const { hdr, meta } = _buildBarHeader(el, { lang: 'csv' });
            meta.textContent = tokens.join(', ') || '—';
            el.appendChild(hdr);
        } else {
            // Update the skeleton meta text with resolved token names + limit for debug
            const meta = el.querySelector('[class*="-meta"]');
            if (meta) meta.textContent = tokens.join(', ') || '—';
        }
        if (!tokens.length || !note) return;
        const nb     = note.notebook || '';
        const sel    = note.selector || '';
        const rel    = sel.includes(':') ? sel.split(':').slice(1).join(':') : '';
        const folder = rel.includes('/') ? rel.split('/').slice(0, -1).join('/') : '';
        for (const token of tokens) {
            const panel = document.createElement('div');
            panel.className = 'nb-csv-panel';
            el.appendChild(panel);
            try {
                const r = await fetch(`/api/csv/source?notebook=${encodeURIComponent(nb)}&folder=${encodeURIComponent(folder)}&token=${encodeURIComponent(token)}`);
                const d = await r.json();
                if (!d.found) { panel.textContent = `No ${token} catalog in this notebook.`; continue; }
                const nr = await fetch(`/api/note?selector=${encodeURIComponent(d.selector)}`);
                const nd = await nr.json();
                panel.innerHTML = _csvRenderCompact(nd.body || '', limit, d.selector);
                panel.querySelectorAll('[data-open-src]').forEach(el => {
                    el.style.cursor = 'pointer';
                    el.addEventListener('click', () => NbMain.openNote(el.dataset.openSrc));
                });
            } catch(e) {
                panel.textContent = `Error loading ${token} catalog.`;
            }
        }
    }

    // ── timedot ───────────────────────────────────────────────────────────────
    // Extended timedot spec (Simon Michael / timedot-vim):
    //   YYYY/MM/DD or YYYY-MM-DD  — date boundary
    //   ##-/###-/####-  text      — section headings (level 2/3/4)
    //   account  <2+ spaces>  time  [; comment]  — entry (2+ space separator)
    //   *  ...                — task item (skipped)
    //   ; or // ...           — comment/modeline (skipped)
    //   time formats: .... .... .. (dots=15min), 1.5h, 90m, 1.5 (decimal hours)

    function _timedotParseTime(str) {
        if (!str) return 0;
        str = str.trim();
        if (str.endsWith('h')) return parseFloat(str) || 0;
        if (str.endsWith('m')) return (parseFloat(str) || 0) / 60;
        if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str) || 0;
        return (str.match(/\./g) || []).length * 0.25;
    }

    // Returns { account, time, comment } or null.
    // Extended spec: 2+ spaces separates account (may contain single spaces) from time.
    function _timedotParseLine(trimmed) {
        const m = trimmed.match(/^(.+?)\s{2,}([. ]+|\d+(?:\.\d+)?[hm]?)\s*(?:;\s*(.*))?$/);
        if (m) return { account: m[1].trimEnd(), time: m[2].trim(), comment: m[3] || '' };
        const b = trimmed.match(/^([. ]+|\d+(?:\.\d+)?[hm]?)\s*(?:;\s*(.*))?$/);
        if (b && /[.\d]/.test(b[1])) return { account: null, time: b[1].trim(), comment: b[2] || '' };
        return null;
    }

    // Parse text into typed segments, tracking the current date.
    // Returns [{type:'heading'|'entry'|'date', level, title, account, hrs, date}]
    function _timedotSegment(text) {
        const segs = [];
        let currentDate = null;
        for (const line of text.split('\n')) {
            const t = line.trim();
            if (!t || t.startsWith(';') || t.startsWith('*') || t.startsWith('//')) continue;
            // Section headings: ##-, ###-, ####-  or ## text
            const hm = t.match(/^(#{2,4})-?\s*(.*)$/);
            if (hm) { segs.push({ type: 'heading', level: hm[1].length, title: hm[2].trim() }); continue; }
            // Date line
            const dm = t.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
            if (dm) { currentDate = `${dm[1]}-${dm[2]}-${dm[3]}`; continue; }
            // Entry line
            const entry = _timedotParseLine(t);
            if (entry && entry.account) {
                const hrs = _timedotParseTime(entry.time);
                if (hrs > 0) segs.push({ type: 'entry', account: entry.account, hrs, date: currentDate, comment: entry.comment || '' });
            }
        }
        return segs;
    }

    // Group segments into sections: [{level, title, entries:[]}]
    // Entries before any heading go into a default untitled section.
    function _timedotGroup(segs) {
        const sections = [];
        let cur = { level: 2, title: '', entries: [] };
        sections.push(cur);
        for (const seg of segs) {
            if (seg.type === 'heading') { cur = { level: seg.level, title: seg.title, entries: [] }; sections.push(cur); }
            else if (seg.type === 'entry') cur.entries.push(seg);
        }
        return sections;
    }

    // True if dateStr falls within the current filter window.
    function _timedotInRange(dateStr, filter) {
        if (filter === 'all' || !dateStr) return true;
        const now = new Date();
        const d = new Date(dateStr + 'T00:00:00');
        if (filter === 'month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
        if (filter === 'week') {
            const mon = new Date(now);
            mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
            mon.setHours(0, 0, 0, 0);
            const sun = new Date(mon); sun.setDate(mon.getDate() + 7);
            return d >= mon && d < sun;
        }
        return true;
    }

    // Compute {totals: {account→hrs}, totalHrs} across all sections, respecting filter.
    function _timedotTotals(sections, filter) {
        const totals = {};
        let totalHrs = 0;
        for (const sec of sections) {
            for (const e of sec.entries) {
                if (!_timedotInRange(e.date, filter)) continue;
                totals[e.account] = (totals[e.account] || 0) + e.hrs;
                totalHrs += e.hrs;
            }
        }
        return { totals, totalHrs };
    }

    // Apply FM project: prefix to stored timedot content.
    // Bare dots/time → project; :sub → project:sub; full account → pass through.
    function _timedotRewrite(text, project) {
        if (!project) return text;
        return text.split('\n').map(line => {
            const t = line.trim();
            if (!t || t.startsWith(';') || t.startsWith('#') || t.startsWith('*') || t.startsWith('//')) return line;
            if (/^\d{4}[-/]\d{2}[-/]\d{2}/.test(t)) return line;
            if (/^[. ]+$|^[. ]+\s*;|^\d+(?:\.\d+)?[hm]?(\s|$)/.test(t) && !t.match(/\S.{1,}\s{2,}/))
                return line.replace(/^(\s*)/, `$1${project}  `);
            if (t.startsWith(':')) return line.replace(/^(\s*):/, `$1${project}:`);
            return line;
        }).join('\n');
    }

    // ── CBQL timedot (step 7) ─────────────────────────────────────────────────

    // Parse CBQL params from block text. Returns {source, filter, timeframe} or null.
    // Resolve a bare source filename against the current note's notebook + folder.
    // 'nathan.md' in 'djp:projects/gbct/nathan/nathan-reports.md'
    //   → 'djp:projects/gbct/nathan/nathan.md'
    function _cbqlResolveSel(sourceSel, noteSel) {
        if (sourceSel.includes(':')) return sourceSel;
        const nb = noteSel.includes(':') ? noteSel.split(':')[0]
                 : (typeof NbNav !== 'undefined' ? NbNav.notebook : '');
        if (!nb) return sourceSel;
        if (!sourceSel.includes('/') && noteSel.includes('/')) {
            const afterColon = noteSel.slice(noteSel.indexOf(':') + 1);
            const folder     = afterColon.slice(0, afterColon.lastIndexOf('/'));
            return `${nb}:${folder}/${sourceSel}`;
        }
        return `${nb}:${sourceSel}`;
    }

    function _cbqlParams(text, meta) {
        const out = {};
        for (const line of (text || '').split('\n')) {
            const m = line.match(/^(source|filter|timeframe|group):\s*(.+)$/);
            if (m) out[m[1]] = m[2].trim();
        }
        // Resolve ${key} variable references from the containing note's FM
        if (meta) {
            for (const k of Object.keys(out))
                out[k] = out[k].replace(/\$\{(\w+)\}/g, (_, key) => meta[key] ?? '');
        }
        return out.source ? out : null;
    }

    // Parse marker positions from source body.
    // Returns [{label: 'MILESTONE: internal-rc', line: N}, ...]
    function _cbqlMarkerLines(body) {
        return body.split('\n').reduce((acc, line, i) => {
            const m = line.match(/^> ([A-Z][A-Z0-9_]+:.*)$/);
            if (m) acc.push({ label: m[1].trim(), line: i });
            return acc;
        }, []);
    }

    // Slice body to the line range corresponding to a timeframe value.
    // Returns the relevant portion of body as a string.
    function _cbqlSliceBody(body, timeframe) {
        const lines   = body.split('\n');
        const markers = _cbqlMarkerLines(body);
        if (!timeframe || timeframe === 'all') return body;
        if (timeframe === 'current') {
            const todayM  = markers.find(m => /^TODAY:/i.test(m.label));
            const billing = markers.filter(m => /^(INVOICED|CLOSED):/i.test(m.label));
            const lastBill = billing[billing.length - 1];
            const start = lastBill ? lastBill.line + 1 : 0;
            const end   = todayM   ? todayM.line       : lines.length;
            return lines.slice(start, end).join('\n');
        }
        if (timeframe === 'future') {
            const todayM = markers.find(m => /^TODAY:/i.test(m.label));
            if (!todayM) return '';
            return lines.slice(todayM.line + 1).join('\n');
        }
        // Specific marker label — the phase ending AT that marker
        const idx = markers.findIndex(m => m.label === timeframe);
        if (idx < 0) return body;
        const start = idx > 0 ? markers[idx - 1].line + 1 : 0;
        return lines.slice(start, markers[idx].line).join('\n');
    }

    // Render a CBQL timedot block: fetch source, slice to timeframe, aggregate, display.
    async function _loadTimedotCBQLBlock(el) {
        const note      = typeof NbMain !== 'undefined' ? NbMain.activeNote?.() : null;
        const params = _cbqlParams(el.dataset.src || '', note?.meta);
        if (!params) return _loadTimedotRawBlock(el);

        const timeframe = el.dataset.activeTimeframe ?? params.timeframe ?? 'current';
        const noteSel   = note?.selector || '';

        // Resolve source selector — inherit notebook from current note if no prefix
        let sourceSel = _cbqlResolveSel(params.source, noteSel);

        el.innerHTML = '<span class="nb-spin">⟳</span>';
        try {
            const r = await fetch(`/api/note?selector=${encodeURIComponent(sourceSel)}`);
            if (!r.ok) throw new Error(`source not found: ${sourceSel}`);
            const d = await r.json();
            // Rate is resolved from the SOURCE note (frontmatter default, overridden
            // by any > RATE: markers) — never the reports note being viewed. Reports
            // notes carry no rate of their own; see the rate-drift fix,
            // claude:nbweb-hledger_plugin_design.md.
            const rate = _timedotEffectiveRate(d.body || '', parseFloat(d.meta?.rate) || null);
            const slice = _cbqlSliceBody(d.body || '', timeframe);

            // _timedotExtractFile expects raw (with or without FM header)
            const combined = _timedotExtractFile(slice, null);
            const segs     = _timedotGroup(_timedotSegment(combined));
            const { totals, totalHrs } = _timedotTotals(segs, 'all');

            el.innerHTML = '';
            const { hdr, meta: metaEl, acts } = _buildBarHeader(el, {
                lang: 'timedot',
                onRefresh: () => _loadTimedotCBQLBlock(el),
            });
            const srcLabel = sourceSel.split(':').pop().replace(/\.md$/i, '');
            const tfLabel  = timeframe === 'current' ? 'current phase'
                           : timeframe === 'future'  ? 'future/planning'
                           : timeframe === 'all'     ? 'all time'
                           : timeframe;
            metaEl.textContent = totalHrs > 0
                ? `${totalHrs.toFixed(1)}h · ${srcLabel} · ${tfLabel}`
                : `empty · ${srcLabel} · ${tfLabel}`;
            el.appendChild(hdr);
            _initCollapseToggle(el);

            const body = document.createElement('div');
            body.className = 'nb-timedot-body';
            if (totalHrs > 0) {
                const table = document.createElement('table');
                table.className = 'nb-timedot-table';
                for (const [acct, hrs] of Object.entries(totals)) {
                    const amt = rate ? (hrs * rate).toFixed(2) : null;
                    const tr = document.createElement('tr');
                    tr.innerHTML = `<td class="nb-timedot-acct">${_esc(acct)}</td>
                                    <td class="nb-timedot-hrs">${hrs.toFixed(2)}h</td>
                                    ${amt ? `<td class="nb-timedot-amt">$${amt}</td>` : ''}`;
                    table.appendChild(tr);
                }
                const total = document.createElement('tr');
                total.className = 'nb-timedot-total';
                const totalAmt = rate ? (totalHrs * rate).toFixed(2) : null;
                total.innerHTML = `<td>Total</td><td>${totalHrs.toFixed(2)}h</td>
                                   ${totalAmt ? `<td>$${totalAmt}</td>` : ''}`;
                table.appendChild(total);
                body.appendChild(table);
            } else {
                body.innerHTML = '<div class="nb-timedot-empty">No entries in this timeframe</div>';
            }
            el.appendChild(body);
        } catch (e) {
            el.innerHTML = `<div class="nb-timedot-err">CBQL: ${_esc(e.message)}</div>`;
        }
    }

    // Render an hl block in CBQL mode: fetch source → slice → extract timedot → hledger.
    // Extract a {from, to} date range for a timeframe from marker labels.
    // Journals are complete records; this range is applied at query time only.
    function _cbqlDateRange(body, timeframe) {
        const markers = _cbqlMarkerLines(body);
        const billing = markers.filter(m => /^(INVOICED|CLOSED):/i.test(m.label));
        const todayM  = markers.find(m => /^TODAY:/i.test(m.label));
        const today   = new Date().toISOString().slice(0, 10);

        const dateFromLabel = label => { const m = label.match(/\b(\d{4}-\d{2}-\d{2})\b/); return m ? m[1] : null; };
        const nextDay = d => { if (!d) return null; const dt = new Date(d + 'T12:00:00Z'); dt.setDate(dt.getDate() + 1); return dt.toISOString().slice(0, 10); };

        if (!timeframe || timeframe === 'all') return { from: null, to: null };

        if (timeframe === 'current') {
            // TODAY's own text is never the date source — it's written bare and only
            // its position matters. Real wall-clock `today` is the only authority.
            // `to` must be exclusive-bound past today (like `future` below), or
            // hledger's date:X..Y (Y exclusive) silently drops today's entries.
            const last = billing[billing.length - 1];
            return { from: nextDay(last ? dateFromLabel(last.label) : null), to: nextDay(today) };
        }

        if (timeframe === 'future') {
            if (!todayM) return { from: null, to: null }; // no TODAY marker = no defined future
            return { from: nextDay(today), to: null };
        }

        // Specific marker label (e.g. "INVOICED: INV-2026-004  2026-06-27 ...")
        const idx = markers.findIndex(m => m.label === timeframe);
        if (idx < 0) return { from: null, to: null };
        const prev = billing.filter(b => b.line < markers[idx].line).pop();
        return { from: nextDay(prev ? dateFromLabel(prev.label) : null), to: dateFromLabel(markers[idx].label) };
    }

    async function _loadHledgerCBQLBlock(el) {
        const note    = typeof NbMain !== 'undefined' ? NbMain.activeNote?.() : null;
        const params  = _cbqlParams(el.dataset.src || '', note?.meta);
        if (!params) return _loadHledgerBlock(el);

        const timeframe  = el.dataset.activeTimeframe ?? params.timeframe ?? 'current';
        const noteSel    = note?.selector || '';
        const journalKey = note?.meta?.journal || note?.effective_fm?.journal || '';
        const sourceSel  = _cbqlResolveSel(params.source, noteSel);

        // Base query = block lines that aren't CBQL params
        const baseQuery = (el.dataset.src || '').split('\n')
            .filter(l => !/^(source|filter|timeframe|group):\s*/.test(l) && l.trim())
            .join(' ').trim() || 'bal';

        el.innerHTML = '<span class="nb-spin">⟳</span>';
        try {
            // Fetch diary to extract marker-based date range
            const r = await fetch(`/api/note?selector=${encodeURIComponent(sourceSel)}`);
            if (!r.ok) throw new Error(`source not found: ${sourceSel}`);
            const d   = await r.json();
            const { from, to } = _cbqlDateRange(d.body || '', timeframe);

            // Append date filter to query — journals are complete, timeframe is reporting only
            const datePart = from ? `date:${from}..${to || ''}` : to ? `date:..${to}` : '';
            const query = datePart ? `${baseQuery} ${datePart}` : baseQuery;

            const resp = await fetch('/api/hledger/cbql-query', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ journalFile: journalKey, query }),
            });
            if (!resp.ok) throw new Error(`hledger error: ${resp.status}`);
            const rd = await resp.json();
            if (rd.error) throw new Error(rd.error);

            el.innerHTML = '';
            const { hdr, meta: metaEl } = _buildBarHeader(el, {
                lang: 'hl', onRefresh: () => _loadHledgerCBQLBlock(el),
            });
            const srcLabel = sourceSel.split(':').pop().replace(/\.md$/i, '');
            const tfLabel  = timeframe === 'current' ? 'current phase'
                           : timeframe === 'future'  ? 'future/planning'
                           : timeframe === 'all'     ? 'all time' : timeframe;
            metaEl.textContent = `${srcLabel} · ${tfLabel}`;
            el.appendChild(hdr);
            _initCollapseToggle(el);
            const pre = document.createElement('pre');
            pre.className = 'nb-hl-cbql-result';
            pre.textContent = rd.result || '(no output)';
            el.appendChild(pre);
        } catch (e) {
            el.innerHTML = `<div class="nb-timedot-err">CBQL: ${_esc(e.message)}</div>`;
        }
    }

    // Extract ALL markers from a full project body (never pre-sliced).
    // Returns { items, hasTodayMarker } where items are in document order.
    // Future items (below > TODAY:) get date:null and future:true.
    // TODAY itself is skipped — the hasTodayMarker flag is its signal.
    function _cbqlExtractAllMarkers(body) {
        const lines = body.split('\n');
        let currentDate = null, pastToday = false;
        const items = [];
        for (const line of lines) {
            const dateM = line.match(/^## (\d{4}-\d{2}-\d{2})\b/);
            if (dateM) { if (!pastToday) currentDate = dateM[1]; continue; }
            const markerM = line.match(/^> ([A-Z]{2,}):[ \t]*(.*)/);
            if (!markerM) continue;
            const type = markerM[1].toLowerCase();
            if (type === 'today') { pastToday = true; continue; }
            items.push({ date: pastToday ? null : currentDate, type, ref: markerM[2].trim(), future: pastToday });
        }
        return { items, hasTodayMarker: pastToday };
    }

    // Compute which item indices are "in scope" for a given timeframe.
    // Returns a Set<number>. TODAY separator is never in/out of scope — it's structural.
    function _timelineScope(items, hasTodayMarker, timeframe) {
        const all = new Set(items.map((_, i) => i));
        if (!timeframe || timeframe === 'all') return all;
        if (timeframe === 'current') {
            if (!hasTodayMarker) return all;
            return new Set(items.reduce((s, m, i) => (m.future ? s : [...s, i]), []));
        }
        if (timeframe === 'future') {
            if (!hasTodayMarker) return new Set();
            return new Set(items.reduce((s, m, i) => (m.future ? [...s, i] : s), []));
        }
        // Specific marker label — scope = items from after the previous marker up to & including this one
        const endIdx = items.findIndex(m => `${m.type.toUpperCase()}: ${m.ref}` === timeframe);
        if (endIdx < 0) return new Set();
        let prevIdx = -1;
        for (let i = endIdx - 1; i >= 0; i--) {
            if (items[i].type !== items[endIdx].type || items[i].ref !== items[endIdx].ref) {
                prevIdx = i; break;
            }
        }
        // Actually: previous marker of any kind is the phase open boundary
        prevIdx = endIdx - 1; // phase = just from the item before to endIdx
        // Cumulative scope: everything from 0..endIdx so the full arc is readable
        return new Set(items.map((_, i) => i).filter(i => i <= endIdx));
    }

    function _timelineTodaySep() {
        const n  = new Date();
        const mm = String(n.getMonth() + 1).padStart(2, '0');
        const dd = String(n.getDate()).padStart(2, '0');
        const sep = document.createElement('div');
        sep.className = 'nb-timeline-sep-today';
        sep.innerHTML =
            `<span class="nb-timeline-sep-label">TODAY</span>` +
            `<span class="nb-timeline-sep-date">${n.getFullYear()}-${mm}-${dd}</span>`;
        return sep;
    }

    // Build the timeline block header: type filter + timeframe + today's date.
    // Replaces the specialty bar dropdown. Rendered once; list is rebuilt separately.
    function _buildTimelineHeader(items) {
        const n = new Date();
        const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        const mm = String(n.getMonth() + 1).padStart(2, '0');
        const dd = String(n.getDate()).padStart(2, '0');
        const dateStr = `${n.getFullYear()}-${mm}-${dd}`;

        // Type filter — fixed vocabulary: ALL, MILESTONE, INVOICED, OTHER
        const typeSet = new Set(items.map(m => m.type));
        const typeOpts = [
            { val: 'all',      label: 'ALL'      },
            { val: 'milestone',label: 'MILESTONE', show: typeSet.has('milestone') },
            { val: 'invoiced', label: 'INVOICED',  show: typeSet.has('invoiced')  },
            { val: 'other',    label: 'OTHER',
              show: [...typeSet].some(t => t !== 'milestone' && t !== 'invoiced') },
        ].filter(o => o.show !== false);
        const typeSel = document.createElement('select');
        typeSel.className = 'nb-timeline-type-sel';
        typeSel.innerHTML = typeOpts.map(o =>
            `<option value="${_esc(o.val)}">${_esc(o.label)}</option>`).join('');

        // Timeframe — TODAY first, FUTURE next, all markers in doc order, All time last
        const tfSel = document.createElement('select');
        tfSel.className = 'nb-timeline-tf-sel';
        let tfHtml = `<option value="current">TODAY</option><option value="future">FUTURE</option>`;
        if (items.length) {
            tfHtml += `<option disabled>──────</option>`;
            for (const m of items)
                tfHtml += `<option value="${_esc(`${m.type.toUpperCase()}: ${m.ref}`)}">${_esc(`${m.type.toUpperCase()}: ${m.ref}`)}</option>`;
        }
        tfHtml += `<option disabled>──────</option><option value="all">All time</option>`;
        tfSel.innerHTML = tfHtml;

        const hdr = document.createElement('div');
        hdr.className = 'nb-timeline-hdr';
        const titleSpan = document.createElement('span');
        titleSpan.className = 'nb-timeline-hdr-title';
        titleSpan.textContent = 'Timeline';
        hdr.appendChild(titleSpan);
        hdr.appendChild(typeSel);
        hdr.appendChild(tfSel);
        return hdr;
    }

    // Re-render only the list portion (header stays). Type hides; timeframe dims.
    function _renderTimelineFromData(el, timeframe) {
        const data = el._timelineData;
        if (!data) return;
        const { items, hasTodayMarker } = data;
        const typeFilter = el.dataset.activeTypeFilter ?? 'all';
        const scope      = _timelineScope(items, hasTodayMarker, timeframe);

        const typeMatch = type => {
            if (typeFilter === 'all')      return true;
            if (typeFilter === 'other')    return type !== 'milestone' && type !== 'invoiced';
            return type === typeFilter;
        };

        let list = el.querySelector('.nb-timeline-list');
        if (!list) {
            list = document.createElement('div');
            list.className = 'nb-timeline-list';
            el.appendChild(list);
        }
        list.innerHTML = '';

        const visible = items.reduce((acc, m, i) => (typeMatch(m.type) ? [...acc, i] : acc), []);
        if (!visible.length && !hasTodayMarker) {
            list.innerHTML = '<div class="nb-timeline-empty">No markers match this filter</div>';
            return;
        }

        let todayInserted = false;
        for (const i of visible) {
            const m = items[i];
            if (m.future && !todayInserted) { todayInserted = true; list.appendChild(_timelineTodaySep()); }
            const row = document.createElement('div');
            row.className = 'nb-timeline-row' + (scope.has(i) ? '' : ' nb-timeline-row--dim');
            const deliverBtn = m.type === 'milestone'
                ? `<button class="nb-timeline-deliver-btn" data-marker="DELIVERED"
                      data-ref="${_esc(m.ref)}"
                      data-source-sel="${_esc(el.dataset.sourceSel || '')}"
                      title="Mark delivered">✓ deliver</button>`
                : '';
            row.innerHTML =
                `<span class="nb-timeline-date">${_esc(m.date || '—')}</span>` +
                `<span class="nb-timeline-chip" data-marker="${_esc(m.type)}">${_esc(m.type.toUpperCase())}</span>` +
                `<span class="nb-timeline-ref">${_esc(m.ref)}</span>` +
                `<span class="nb-timeline-badge">${deliverBtn}</span>`;
            list.appendChild(row);
        }
        if (hasTodayMarker && !todayInserted) list.appendChild(_timelineTodaySep());
    }

    // Load a CBQL timeline block: fetch source once, build header with controls, cache data.
    // Type changes and timeframe changes both re-render the list without re-fetching.
    async function _loadTimelineCBQLBlock(el) {
        const note   = typeof NbMain !== 'undefined' ? NbMain.activeNote?.() : null;
        const params = _cbqlParams(el.dataset.src || '', note?.meta);
        if (!params) { el.innerHTML = '<div class="nb-timeline-empty">No source specified</div>'; return; }

        if (!el._timelineData) {
            const noteSel = note?.selector || '';
            let sourceSel = _cbqlResolveSel(params.source, noteSel);
            el.dataset.sourceSel = sourceSel;
            el.innerHTML = '<span class="nb-spin">⟳</span>';
            try {
                const r = await fetch(`/api/note?selector=${encodeURIComponent(sourceSel)}`);
                if (!r.ok) throw new Error(`source not found: ${sourceSel}`);
                const d = await r.json();
                el._timelineData = _cbqlExtractAllMarkers(d.body || '');
            } catch (e) {
                el.innerHTML = `<div class="nb-timedot-err">CBQL: ${_esc(e.message)}</div>`;
                return;
            }

            // Build header once (type sel + timeframe sel + today's date)
            el.innerHTML = '';
            el.appendChild(_buildTimelineHeader(el._timelineData.items));

            // Wire block-level controls
            el.addEventListener('change', ev => {
                const tfSel   = el.querySelector('.nb-timeline-tf-sel');
                const typeSel = el.querySelector('.nb-timeline-type-sel');
                const tf   = tfSel?.value   || 'current';
                const type = typeSel?.value || 'all';
                el.dataset.activeTimeframe  = tf;
                el.dataset.activeTypeFilter = type;
                _renderTimelineFromData(el, tf);
                // Broadcast timeframe change so timedot blocks stay in sync
                if (ev.target === tfSel)
                    document.dispatchEvent(new CustomEvent('nb-timeframe-changed', { detail: { timeframe: tf } }));
            });
        }

        const timeframe = el.dataset.activeTimeframe ?? params.timeframe ?? 'current';
        el.dataset.activeTimeframe = timeframe;
        // Sync the tf-sel dropdown to current timeframe state
        const tfSel = el.querySelector('.nb-timeline-tf-sel');
        if (tfSel) tfSel.value = timeframe;
        _renderTimelineFromData(el, timeframe);
    }

    // Rebuild a timedot file from all ```timedot blocks in raw note text.
    // Date context comes from heading lines (## YYYY-MM-DD).
    // :sub shortcuts are expanded via _timedotRewrite.
    function _timedotExtractFile(raw, project) {
        let body = raw;
        if (raw.startsWith('---')) {
            const end = raw.indexOf('\n---', 3);
            if (end >= 0) body = raw.slice(end + 4).replace(/^\n+/, '');
        }
        const lines = body.split('\n');
        const out = [];
        let curDate = null, inBlock = false, blockLines = [];
        for (const line of lines) {
            if (!inBlock) {
                const dm = line.match(/^#{1,6}\s+(\d{4}[-/]\d{2}[-/]\d{2})/);
                if (dm) { curDate = dm[1]; continue; }
                if (/^```timedot\b/.test(line)) { inBlock = true; blockLines = []; continue; }
                continue;
            }
            if (/^```\s*$/.test(line)) {
                if (blockLines.length) {
                    const content = _timedotRewrite(blockLines.join('\n'), project);
                    // Only prepend heading date if the block has no internal date line
                    const hasDate = blockLines.some(l => /^\d{4}[-/]\d{2}[-/]\d{2}/.test(l.trim()));
                    if (!hasDate && curDate) out.push(curDate);
                    out.push(content);
                    out.push('');
                }
                inBlock = false;
                continue;
            }
            blockLines.push(line);
        }
        return out.join('\n').trimEnd() + '\n';
    }

    // Effective-rate schedule from RATE: markers — extends _cbqlMarkerLines (the same
    // generic marker scan INVOICED/CLOSED/TODAY use), so RATE is just another label
    // consumers filter for, not a bespoke parser. Frontmatter rate is the default;
    // each marker overrides forward from its line, including one that precedes the
    // first dated entry (a plain override of the default, not a special case).
    function _timedotRateAtLine(body) {
        const byLine = new Map();
        for (const m of _cbqlMarkerLines(body)) {
            if (!/^RATE:\s*/i.test(m.label)) continue;
            const val = parseFloat(m.label.replace(/^RATE:\s*/i, ''));
            if (!isNaN(val)) byLine.set(m.line, val);
        }
        return byLine;
    }

    // Effective rate "as of now" — the same schedule as _timedotRateAtLine, collapsed
    // to its final value (document order is preserved by Map insertion order, so the
    // last entry is the most recent override). Used by display code that needs one
    // rate for a summary total, not a per-entry schedule.
    function _timedotEffectiveRate(body, defaultRate) {
        const schedule = _timedotRateAtLine(body);
        if (!schedule.size) return defaultRate;
        return [...schedule.values()].pop();
    }

    // Generate hledger labour journal entries (CAD) from all body timedot blocks.
    // Mirrors _timedotExtractFile but produces double-entry income/AR transactions.
    function _timedotExtractLabourJournal(raw, project, rate) {
        if (!project || !rate) return '';
        const PAD = 46;
        const ar  = `Assets:AR:${project}`;
        const inc = `Income:Services:Hourly:${project}`;
        let body = raw;
        if (raw.startsWith('---')) {
            const end = raw.indexOf('\n---', 3);
            if (end >= 0) body = raw.slice(end + 4).replace(/^\n+/, '');
        }
        const rateAtLine = _timedotRateAtLine(body);
        let curRate = rate;
        const out = [
            `; ${project} labour journal — DO NOT HAND EDIT`,
            `; Auto-generated from note timedot blocks. Edit source blocks in nb-web.`,
            ``,
            `account ${ar}`,
            `account ${inc}`,
            ``,
        ];
        const lines = body.split('\n');
        let curDate = null, inBlock = false, blockLines = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (rateAtLine.has(i)) curRate = rateAtLine.get(i);
            if (!inBlock) {
                const dm = line.match(/^#{1,6}\s+(\d{4}[-/]\d{2}[-/]\d{2})/);
                if (dm) { curDate = dm[1]; continue; }
                if (/^```timedot\b/.test(line)) { inBlock = true; blockLines = []; continue; }
                continue;
            }
            if (/^```\s*$/.test(line)) {
                if (blockLines.length) {
                    let blockDate = curDate;
                    const rewritten = _timedotRewrite(blockLines.join('\n'), project);
                    for (const bline of rewritten.split('\n')) {
                        const t = bline.trim();
                        if (!t) continue;
                        const dm2 = t.match(/^(\d{4}[-/]\d{2}[-/]\d{2})\s*$/);
                        if (dm2) { blockDate = dm2[1]; continue; }
                        const entry = _timedotParseLine(t);
                        if (!entry) continue;
                        const hrs = _timedotParseTime(entry.time);
                        if (!hrs || !blockDate) continue;
                        const amount = Math.round(hrs * curRate * 100) / 100;
                        const descLine = entry.comment
                            ? `${blockDate} ${project} — ${hrs}h @ $${curRate}  ; ${entry.comment}`
                            : `${blockDate} ${project} — ${hrs}h @ $${curRate}`;
                        out.push(descLine);
                        out.push(`    ${ar.padEnd(PAD)} ${amount.toFixed(2)} CAD`);
                        out.push(`    ${inc}`);
                        out.push('');
                    }
                }
                inBlock = false;
                continue;
            }
            blockLines.push(line);
        }
        return out.join('\n').trimEnd() + '\n';
    }

    // Append new entry lines — inline (PUT note) or external (POST /api/t/timedot/append).
    async function _timedotAppend(el, newLines) {
        const note    = typeof NbMain !== 'undefined' ? NbMain.activeNote?.() : null;
        const tdFile  = note?.meta?.timedot_file || null;

        if (tdFile) {
            // External file: append via API
            const r = await fetch('/api/t/timedot/append', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file: tdFile, lines: newLines }),
            });
            const d = await r.json();
            if (!d.success) throw new Error(d.error || 'Append failed');
            // Refresh el.dataset.src from the file so re-render is accurate
            const cr = await fetch(`/api/t/timedot/content?file=${encodeURIComponent(tdFile)}`);
            const cd = await cr.json();
            if (cd.exists) el.dataset.src = cd.content;
            return;
        }

        // Inline: splice into note's fenced block
        const selector = note?.selector || (typeof NbMain !== 'undefined' ? NbMain.activeSelector?.() : null);
        if (!selector) throw new Error('No active note');
        const r = await fetch('/api/note?selector=' + encodeURIComponent(selector));
        const d = await r.json();
        let raw = d.raw || d.body || '';
        const preview = document.getElementById('nb-preview-content');
        const hosts = [...(preview || document).querySelectorAll('.nb-timedot-block')];
        const idx = hosts.indexOf(el);
        let blockIdx = 0, replaced = false;
        raw = raw.replace(/```timedot\n([\s\S]*?)```/g, (match, content) => {
            if (blockIdx++ !== idx) return match;
            replaced = true;
            return '```timedot\n' + content.trimEnd() + '\n' + newLines + '\n```';
        });
        if (!replaced) throw new Error('Block not found in source');
        const wr = await fetch('/api/note', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selector, content: raw }),
        });
        const wd = await wr.json();
        if (!wd.success) throw new Error(wd.stderr || 'Save failed');
        const newBlock = raw.match(/```timedot\n([\s\S]*?)```/g)?.[idx];
        if (newBlock) el.dataset.src = newBlock.replace(/^```timedot\n/, '').replace(/\n```$/, '');
    }

    // Floating summary popover: per-account breakdown for current filter.
    function _showTimedotSummary(trigger, totals, rate, filterLabel) {
        document.querySelectorAll('.nb-timedot-summary-pop').forEach(p => p.remove());
        const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
        const totalHrs = entries.reduce((s, [, h]) => s + h, 0);
        const totalAmt = rate ? totalHrs * rate : null;
        const pop = document.createElement('div');
        pop.className = 'nb-timedot-summary-pop';
        let html = `<div class="nb-timedot-pop-title">${_esc(filterLabel)}</div>`;
        html += `<table class="nb-timedot-table nb-timedot-pop-table">`;
        for (const [acct, hrs] of entries) {
            const amt = rate ? hrs * rate : null;
            html += `<tr><td class="nb-timedot-acct">${_esc(acct)}</td>` +
                `<td class="nb-timedot-h">${hrs.toFixed(2)}h</td>` +
                (amt !== null ? `<td class="nb-timedot-amt">$${amt.toFixed(2)}</td>` : '') + '</tr>';
        }
        if (entries.length > 1) {
            html += `<tr class="nb-timedot-total"><td>Total</td><td>${totalHrs.toFixed(2)}h</td>` +
                (totalAmt !== null ? `<td>$${totalAmt.toFixed(2)}</td>` : '') + '</tr>';
        }
        html += '</table><button class="nb-timedot-pop-close nb-tw-btn">✕</button>';
        pop.innerHTML = html;
        document.body.appendChild(pop);
        const rect = trigger.getBoundingClientRect();
        const pw = pop.offsetWidth, ph = pop.offsetHeight;
        let top = rect.bottom + 4, left = rect.left;
        if (top + ph > window.innerHeight) top = rect.top - ph - 4;
        if (left + pw > window.innerWidth) left = window.innerWidth - pw - 8;
        pop.style.top = top + 'px'; pop.style.left = left + 'px';
        pop.querySelector('.nb-timedot-pop-close').addEventListener('click', () => pop.remove());
        setTimeout(() => document.addEventListener('click', e => {
            if (!pop.contains(e.target) && e.target !== trigger) pop.remove();
        }, { once: true, capture: true }), 0);
    }

    function _showTimedotAddForm(el, trigger, project) {
        const existing = trigger._cbForm || el.querySelector('.nb-timedot-addform');
        if (existing) { existing.remove(); trigger._cbForm = null; trigger.classList.remove('active'); return; }
        trigger.classList.add('active');

        const today = _localDateStr();
        const raw = el.dataset.src || '';
        const subAccts = new Set();
        for (const line of raw.split('\n')) {
            const t = line.trim();
            const entry = _timedotParseLine(t);
            if (!entry?.account) continue;
            const acct = entry.account;
            if (project && acct.startsWith(project + ':')) subAccts.add(':' + acct.slice(project.length + 1));
            else if (acct.startsWith(':')) subAccts.add(acct);
        }

        const dlId = 'nb-timedot-dl-' + Math.random().toString(36).slice(2);
        const dlOpts = [...subAccts].map(a => `<option value="${_esc(a)}">`).join('');
        const form = document.createElement('div');
        form.className = 'nb-timedot-addform';
        form.innerHTML = `
            <datalist id="${dlId}">${dlOpts}</datalist>
            <input type="date" class="nb-hl-inp nb-timedot-date" value="${today}">
            <input type="text" class="nb-hl-inp nb-timedot-time" placeholder=".... or 1.5h" size="8" autocomplete="off" spellcheck="false">
            <input type="text" class="nb-hl-inp nb-timedot-sub" placeholder=":sub-account" list="${dlId}" autocomplete="off" spellcheck="false">
            <input type="text" class="nb-hl-inp nb-timedot-comment" placeholder="; comment" autocomplete="off" spellcheck="false">
            <button class="nb-btn-primary nb-timedot-save">Add</button>
            <button class="nb-tw-btn nb-timedot-cancel">✕</button>
            <span class="nb-timedot-status"></span>`;

        const dismiss = _cbFormAttach(form, trigger, el,
            f => el.querySelector('.nb-timedot-header').insertAdjacentElement('afterend', f));

        form.querySelector('.nb-timedot-cancel').addEventListener('click', dismiss);
        form.querySelector('.nb-timedot-save').addEventListener('click', async () => {
            const status  = form.querySelector('.nb-timedot-status');
            const date    = form.querySelector('.nb-timedot-date').value;
            const time    = form.querySelector('.nb-timedot-time').value.trim();
            const sub     = form.querySelector('.nb-timedot-sub').value.trim();
            const comment = form.querySelector('.nb-timedot-comment').value.trim();
            if (!date || !time) { status.textContent = 'Date and time required'; return; }
            if (!_timedotParseTime(time)) { status.textContent = 'Invalid time (use .... or 1.5h)'; return; }
            const acct = sub.startsWith(':') ? sub : (sub && !sub.startsWith(':') ? sub : '');
            const commentPart = comment ? `    ; ${comment.replace(/^;\s*/, '')}` : '';
            const entryLine = acct ? `  ${acct}  ${time}${commentPart}` : `  ${time}${commentPart}`;
            status.textContent = 'Saving…';
            try {
                await _timedotAppend(el, `${date}\n${entryLine}`);
                dismiss();
                await _loadTimedotBlock(el);
            } catch(e) { status.textContent = '✗ ' + e.message; }
        });
        setTimeout(() => form.querySelector('.nb-timedot-time').focus(), 50);
    }

    // Replace the entire content of a body timedot fenced block in the note.
    async function _timedotSaveInlineBlock(el, newContent) {
        const selector = typeof NbMain !== 'undefined' ? NbMain.activeSelector?.() : null;
        if (!selector) throw new Error('No active note');
        const r = await fetch('/api/note?selector=' + encodeURIComponent(selector));
        const d = await r.json();
        let raw = d.raw || d.body || '';
        const preview = document.getElementById('nb-preview-content');
        const hosts = [...(preview || document).querySelectorAll('.nb-timedot-block')];
        const idx = hosts.indexOf(el);
        let blockIdx = 0, replaced = false;
        raw = raw.replace(/```timedot\n([\s\S]*?)```/g, (match) => {
            if (blockIdx++ !== idx) return match;
            replaced = true;
            return '```timedot\n' + newContent.trimEnd() + '\n```';
        });
        if (!replaced) throw new Error('Block not found in source');
        const wr = await fetch('/api/note', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selector, content: raw }),
        });
        const wd = await wr.json();
        if (!wd.success) throw new Error(wd.stderr || 'Save failed');
        el.dataset.src = newContent.trimEnd();

        // Sync timedot_file: + labour journal when set on this note.
        // Falls back to deriving timedot path from journal: (direct or via effective_fm).
        const _syncNote    = typeof NbMain !== 'undefined' ? NbMain.activeNote?.() : null;
        const _journalKey  = _syncNote?.meta?.journal || _syncNote?.effective_fm?.journal || '';
        const _syncFile    = _syncNote?.meta?.timedot_file
                          || _syncNote?.effective_fm?.timedot_file
                          || (_journalKey ? _journalKey.replace(/\.journal$/, '-gen.timedot') : '');
        if (_syncFile) {
            const _proj    = _syncNote?.meta?.project || null;
            const _rate    = parseFloat(_syncNote?.meta?.rate) || null;
            const _write   = (file, content) => fetch('/api/t/timedot/write', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file, content }),
            });
            const _genHdr  = `; DO NOT HAND EDIT — generated from note blocks. Edit source in nb-web.\n`;
            await _write(_syncFile, _genHdr + _timedotExtractFile(raw, _proj));
            const _labourFile = _journalKey ? _journalKey.replace(/\.journal$/, '-gen.labour.journal') : '';
            if (_rate && _labourFile)
                await _write(_labourFile, _timedotExtractLabourJournal(raw, _proj, _rate));
        }

        // Clear journals for any csv token listed in FM but no longer in the note body
        const _csvTokens = [].concat(_syncNote?.meta?.csv || []);
        if (_csvTokens.length && selector) {
            await Promise.all(_csvTokens
                .filter(t => !new RegExp('```csv ' + t + '\\b').test(raw))
                .map(t => fetch('/api/t/journal/from-csv', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ selector, token: t, clear: true }),
                }).catch(() => {}))
            );
        }
    }

    // Body codeblock: verbatim display with inline textarea editing.
    async function _loadTimedotRawBlock(el) {
        const note    = typeof NbMain !== 'undefined' ? NbMain.activeNote?.() : null;
        const meta    = note?.meta || {};
        const project = meta.project || null;
        const rate    = parseFloat(meta.rate) || null;
        const raw     = el.dataset.src || '';
        el.innerHTML = '';

        const { hdr, meta: metaEl, acts } = _buildBarHeader(el, {
            lang: 'timedot',
            onRefresh: () => _loadTimedotRawBlock(el),
        });

        const editBtn = document.createElement('button');
        editBtn.className = 'nb-tw-btn nb-timedot-edit-btn';
        editBtn.title = 'Edit inline';
        editBtn.textContent = '✎';
        acts.insertBefore(editBtn, acts.firstChild);

        // Header meta: total hours + billing (parse now, costs nothing on empty blocks)
        const { totalHrs } = _timedotTotals(_timedotGroup(_timedotSegment(_timedotRewrite(raw, project))), 'all');
        const totalAmt = rate && totalHrs ? totalHrs * rate : null;
        metaEl.textContent = totalHrs > 0
            ? totalHrs.toFixed(1) + 'h' + (totalAmt !== null ? ' · $' + totalAmt.toFixed(2) : '')
            : 'empty';

        el.appendChild(hdr);
        _initCollapseToggle(el);

        // nb-timedot-body--raw removes the default 0.4em top/bottom padding
        // that creates a visible gap between header and the pre block.
        const body = document.createElement('div');
        body.className = 'nb-timedot-body nb-timedot-body--raw';
        el.appendChild(body);

        let editing = false;

        const enterEdit = () => {
            if (editing) return;
            editing = true;
            editBtn.textContent = '✕';
            body.innerHTML = '';
            const ta = document.createElement('textarea');
            ta.className = 'nb-timedot-edit-ta';
            ta.value = raw;
            ta.rows = Math.max(4, (raw.split('\n').length || 1) + 1);
            const btns = document.createElement('div');
            btns.className = 'nb-timedot-edit-btns';
            const saveBtn = document.createElement('button');
            saveBtn.className = 'nb-tw-btn nb-timedot-save-btn';
            saveBtn.textContent = 'Save';
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'nb-tw-btn';
            cancelBtn.textContent = 'Cancel';
            btns.appendChild(saveBtn);
            btns.appendChild(cancelBtn);
            body.appendChild(ta);
            body.appendChild(btns);
            ta.focus();

            saveBtn.addEventListener('click', async () => {
                try {
                    saveBtn.disabled = true;
                    saveBtn.textContent = '…';
                    await _timedotSaveInlineBlock(el, ta.value);
                    _loadTimedotRawBlock(el);
                } catch (e) {
                    saveBtn.disabled = false;
                    saveBtn.textContent = 'Save';
                    const err = document.createElement('div');
                    err.className = 'nb-timedot-err';
                    err.textContent = e.message || 'Save failed';
                    body.appendChild(err);
                }
            });
            cancelBtn.addEventListener('click', exitEdit);
        };

        const exitEdit = () => {
            editing = false;
            editBtn.textContent = '✎';
            showRaw();
        };

        const showRaw = () => {
            body.innerHTML = '';
            const pre = document.createElement('pre');
            pre.className = 'nb-timedot-raw';
            pre.textContent = raw || '';
            pre.title = 'Click to edit';
            pre.addEventListener('click', () => enterEdit());
            body.appendChild(pre);
        };

        editBtn.addEventListener('click', e => {
            e.stopPropagation();
            editing ? exitEdit() : enterEdit();
        });

        showRaw();
    }

    // FM barblock (no timedot_file): date-ordered log of all body block entries,
    // with comments and per-date subtotals; date rows link to heading anchors.
    async function _loadTimedotLogBlock(el) {
        const note    = typeof NbMain !== 'undefined' ? NbMain.activeNote?.() : null;
        const meta    = note?.meta || {};
        const project = meta.project || null;
        const rate    = parseFloat(meta.rate) || null;

        el.innerHTML = '';
        const { hdr, meta: metaEl, acts } = _buildBarHeader(el, {
            lang: 'timedot',
            onRefresh: () => _loadTimedotLogBlock(el),
        });
        el.appendChild(hdr);
        _initCollapseToggle(el);

        const body = document.createElement('div');
        body.className = 'nb-timedot-body nb-timedot-log-body';
        el.appendChild(body);

        // Collect entries from body blocks, resolving date from DOM headings when
        // no inline date line is present (project diary pattern: ## YYYY-MM-DD).
        const preview = document.getElementById('nb-preview-content');
        if (!preview) { body.innerHTML = '<div class="nb-timedot-empty">Preview not ready</div>'; return; }

        const allEntries = [];
        for (const block of preview.querySelectorAll('.nb-timedot-block')) {
            // Find the nearest heading above this block for date + anchor context.
            let headingDate = null, headingId = null;
            let sib = block.previousElementSibling;
            while (sib) {
                if (/^H[1-6]$/.test(sib.tagName)) {
                    const dm = sib.textContent.match(/(\d{4}-\d{2}-\d{2})/);
                    if (dm) { headingDate = dm[1]; headingId = sib.id; }
                    break;
                }
                sib = sib.previousElementSibling;
            }

            const raw = block.dataset.src || '';
            if (!raw.trim()) continue;

            const segs = _timedotSegment(_timedotRewrite(raw, project));
            for (const seg of segs) {
                if (seg.type !== 'entry') continue;
                allEntries.push({
                    date:      seg.date || headingDate,
                    headingId: seg.date ? null : headingId,   // anchor only for heading-sourced dates
                    account:   seg.account,
                    hrs:       seg.hrs,
                    comment:   seg.comment || '',
                });
            }
        }

        // Sort oldest-first; entries without a date sink to the bottom.
        allEntries.sort((a, b) => {
            if (!a.date && !b.date) return 0;
            if (!a.date) return 1;
            if (!b.date) return -1;
            return a.date.localeCompare(b.date);
        });

        // Grand total for header meta.
        const grandHrs = allEntries.reduce((s, e) => s + e.hrs, 0);
        const grandAmt = rate && grandHrs ? grandHrs * rate : null;
        metaEl.textContent = grandHrs > 0
            ? grandHrs.toFixed(1) + 'h' + (grandAmt !== null ? ' · $' + grandAmt.toFixed(2) : '')
            : 'empty';

        if (!allEntries.length) {
            body.innerHTML = '<div class="nb-timedot-empty">No entries yet</div>';
            return;
        }

        // Render date-grouped table.
        const table = document.createElement('table');
        table.className = 'nb-timedot-table nb-timedot-log-table';

        // Group by date (preserves sorted order via Map).
        const byDate = new Map();
        for (const e of allEntries) {
            const k = e.date || '—';
            if (!byDate.has(k)) byDate.set(k, { headingId: e.headingId, entries: [] });
            byDate.get(k).entries.push(e);
        }

        for (const [date, { headingId, entries }] of byDate) {
            const dateHrs = entries.reduce((s, e) => s + e.hrs, 0);
            const dateAmt = rate ? dateHrs * rate : null;

            // Date header row — clickable link scrolls to heading anchor.
            const dateTr = document.createElement('tr');
            dateTr.className = 'nb-timedot-log-date-row';
            const dateTd = document.createElement('td');
            dateTd.colSpan = 3;
            if (headingId) {
                const a = document.createElement('a');
                a.className = 'nb-timedot-log-anchor';
                a.href = '#' + headingId;
                a.textContent = date;
                a.addEventListener('click', ev => {
                    ev.preventDefault();
                    document.getElementById(headingId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                });
                dateTd.appendChild(a);
            } else {
                dateTd.textContent = date;
            }
            const dateSumTd = document.createElement('td');
            dateSumTd.className = 'nb-timedot-log-date-sum';
            dateSumTd.textContent = dateHrs.toFixed(1) + 'h' + (dateAmt !== null ? ' · $' + dateAmt.toFixed(2) : '');
            dateTr.appendChild(dateTd);
            dateTr.appendChild(dateSumTd);
            table.appendChild(dateTr);

            // Entry rows.
            for (const e of entries) {
                const tr = document.createElement('tr');
                tr.className = 'nb-timedot-log-entry';
                const acctTd = document.createElement('td');
                acctTd.className = 'nb-timedot-acct';
                acctTd.textContent = e.account;
                const hrsTd = document.createElement('td');
                hrsTd.className = 'nb-timedot-h';
                hrsTd.textContent = e.hrs.toFixed(1) + 'h';
                const cmtTd = document.createElement('td');
                cmtTd.className = 'nb-timedot-log-comment';
                cmtTd.textContent = e.comment;
                tr.appendChild(acctTd);
                tr.appendChild(hrsTd);
                tr.appendChild(cmtTd);
                table.appendChild(tr);
            }
        }

        body.appendChild(table);
    }

    async function _loadTimedotBlock(el) {
        const note    = typeof NbMain !== 'undefined' ? NbMain.activeNote?.() : null;
        const meta    = note?.meta || {};
        const project = meta.project || null;
        const rate    = parseFloat(meta.rate) || null;
        const filter  = el.dataset.filter || 'all';

        // External file: fetch content, update dataset.src for consistent downstream use
        const tdFile  = meta.timedot_file || null;
        if (tdFile && !el.dataset.externalLoaded) {
            try {
                const r = await fetch(`/api/t/timedot/content?file=${encodeURIComponent(tdFile)}`);
                const d = await r.json();
                if (d.exists) { el.dataset.src = d.content; el.dataset.externalLoaded = '1'; }
            } catch { /* fallback to inline */ }
        }

        // FM barblock with no external file and no inline data: aggregate from body blocks.
        // isAggregation=true means "+" add button is suppressed (no single target to write to).
        let isAggregation = false;
        if (!el.dataset.src && !tdFile) {
            const bodyBlocks = [...document.querySelectorAll('#nb-preview-content .nb-timedot-block')];
            const combined = bodyBlocks.map(b => b.dataset.src || '').filter(Boolean).join('\n');
            if (combined) { el.dataset.src = combined; isAggregation = true; }
        }

        const raw     = el.dataset.src || '';

        const rewritten = _timedotRewrite(raw, project);
        const sections  = _timedotGroup(_timedotSegment(rewritten));
        const { totals, totalHrs } = _timedotTotals(sections, filter);
        const totalAmt = rate && totalHrs ? totalHrs * rate : null;

        const _FILTER_LABEL = { all: 'All time', month: 'This month', week: 'This week' };
        const _FILTER_BADGE = { all: 'all', month: 'mo', week: 'wk' };
        const _FILTER_NEXT  = { all: 'month', month: 'week', week: 'all' };

        el.innerHTML = '';
        const { hdr, meta: metaEl, acts } = _buildBarHeader(el, { lang: 'timedot', onRefresh: () => _loadTimedotBlock(el) });

        // Filter cycle button (inserted before ↻)
        const filterBtn = document.createElement('button');
        filterBtn.className = 'nb-tw-btn nb-timedot-filter-btn' + (filter !== 'all' ? ' active' : '');
        filterBtn.title = 'Filter: ' + _FILTER_LABEL[filter];
        filterBtn.textContent = _FILTER_BADGE[filter];
        filterBtn.addEventListener('click', e => {
            e.stopPropagation();
            el.dataset.filter = _FILTER_NEXT[filter];
            _loadTimedotBlock(el);
        });
        acts.insertBefore(filterBtn, acts.firstChild);

        // + entry button — hidden in aggregation mode (no single inline target to write to)
        if (!isAggregation) {
            const addBtn = document.createElement('button');
            addBtn.className = 'nb-tw-btn nb-timedot-add-btn';
            addBtn.title = 'Add time entry';
            addBtn.textContent = '+';
            addBtn.addEventListener('click', e => { e.stopPropagation(); _showTimedotAddForm(el, addBtn, project); });
            acts.insertBefore(addBtn, acts.firstChild);
        }

        // Clickable meta: totals → summary popover
        const totalBtn = document.createElement('button');
        totalBtn.className = 'nb-timedot-total-btn';
        totalBtn.title = 'Show summary';
        totalBtn.innerHTML =
            (project ? `<span class="nb-timedot-project">${_esc(project)}</span> · ` : '') +
            `<span class="nb-timedot-hours">${totalHrs.toFixed(1)}h</span>` +
            (totalAmt !== null ? ` · <span class="nb-timedot-amount">$${totalAmt.toFixed(2)}</span>` : '');
        totalBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (Object.keys(totals).length) _showTimedotSummary(totalBtn, totals, rate, _FILTER_LABEL[filter]);
        });
        metaEl.appendChild(totalBtn);

        el.appendChild(hdr);
        _initCollapseToggle(el);

        const body = document.createElement('div');
        body.className = 'nb-timedot-body';

        const hasHeadings = sections.some(s => s.title);
        const visibleSections = hasHeadings
            ? sections.filter(s => s.entries.some(e => _timedotInRange(e.date, filter)))
            : sections;
        const hasEntries = Object.keys(totals).length > 0;

        if (!hasEntries) {
            const empty = filter === 'month' ? 'No entries this month'
                        : filter === 'week'  ? 'No entries this week'
                        : 'No entries yet';
            body.innerHTML = `<div class="nb-timedot-empty">${empty}</div>`;
        } else if (hasHeadings) {
            // Accordion sections
            const selector = el.closest('[data-selector]')?.dataset.selector || '';
            visibleSections.forEach((sec, si) => {
                const filteredEntries = sec.entries.filter(e => _timedotInRange(e.date, filter));
                if (!filteredEntries.length) return;

                const secTotals = {};
                for (const e of filteredEntries) secTotals[e.account] = (secTotals[e.account] || 0) + e.hrs;
                const secHrs = Object.values(secTotals).reduce((s, h) => s + h, 0);
                const secAmt = rate ? secHrs * rate : null;

                const storeKey = `nb-tdt-sec:${selector}:${si}`;
                const defaultOpen = sec.level <= 2;
                const saved = localStorage.getItem(storeKey);
                const isOpen = saved !== null ? saved === '1' : defaultOpen;

                const section = document.createElement('div');
                section.className = `nb-timedot-section nb-timedot-section--lv${sec.level}`;

                const secHdr = document.createElement('div');
                secHdr.className = 'nb-timedot-section-hdr';
                secHdr.innerHTML =
                    `<span class="nb-timedot-toggle">${isOpen ? '▾' : '▸'}</span>` +
                    `<span class="nb-timedot-section-title">${_esc(sec.title || '(entries)')}</span>` +
                    `<span class="nb-timedot-section-hrs">${secHrs.toFixed(1)}h` +
                    (secAmt !== null ? ` · $${secAmt.toFixed(2)}` : '') + '</span>';

                const secBody = document.createElement('div');
                secBody.className = 'nb-timedot-section-body';
                if (!isOpen) secBody.style.display = 'none';

                const table = document.createElement('table');
                table.className = 'nb-timedot-table';
                for (const [acct, hrs] of Object.entries(secTotals)) {
                    const amt = rate ? hrs * rate : null;
                    const tr = document.createElement('tr');
                    tr.innerHTML = `<td class="nb-timedot-acct">${_esc(acct)}</td>` +
                        `<td class="nb-timedot-h">${hrs.toFixed(1)}h</td>` +
                        (amt !== null ? `<td class="nb-timedot-amt">$${amt.toFixed(2)}</td>` : '');
                    table.appendChild(tr);
                }
                secBody.appendChild(table);

                secHdr.addEventListener('click', () => {
                    const nowOpen = secBody.style.display !== 'none';
                    secBody.style.display = nowOpen ? 'none' : '';
                    secHdr.querySelector('.nb-timedot-toggle').textContent = nowOpen ? '▸' : '▾';
                    localStorage.setItem(storeKey, nowOpen ? '0' : '1');
                });

                section.appendChild(secHdr);
                section.appendChild(secBody);
                body.appendChild(section);
            });
        } else {
            // No headings — flat table
            const table = document.createElement('table');
            table.className = 'nb-timedot-table';
            for (const [acct, hrs] of Object.entries(totals)) {
                const amt = rate ? hrs * rate : null;
                const tr = document.createElement('tr');
                tr.innerHTML = `<td class="nb-timedot-acct">${_esc(acct)}</td>` +
                    `<td class="nb-timedot-h">${hrs.toFixed(1)}h</td>` +
                    (amt !== null ? `<td class="nb-timedot-amt">$${amt.toFixed(2)}</td>` : '');
                table.appendChild(tr);
            }
            if (Object.keys(totals).length > 1) {
                const tr = document.createElement('tr');
                tr.className = 'nb-timedot-total';
                tr.innerHTML = `<td>Total</td><td>${totalHrs.toFixed(1)}h</td>` +
                    (totalAmt !== null ? `<td>$${totalAmt.toFixed(2)}</td>` : '');
                table.appendChild(tr);
            }
            body.appendChild(table);
        }

        el.appendChild(body);
    }

    // ── Plugin registration ───────────────────────────────────────────────────

    NbWeb.registerModule('codeblocks', {

        label:       'NbWeb-codeblocks',
        description: 'Live fenced code block renderers (tw, hledger, t, nb, git)',
        helpUrl:     '/plugins/nbweb-codeblocks.md',

        codeblockRenderers: [
            {
                lang:   'tw',
                html:   text => {
                    const cbql = /^source:\s*\S/m.test(text);
                    const {readLevel, writeLevel, query} = _cbParseGates(text);
                    return `<div class="nb-tw-block"${cbql ? ' data-cbql="1"' : ''}${_cbGateAttrs(readLevel,writeLevel)} data-src="${text.replace(/"/g,'&quot;')}" data-query="${query.replace(/"/g,'&quot;')}"><span class="nb-spin">⟳</span></div>`;
                },
                renderOne: async el => { const w = await NbWeb.checkWhich('task'); return w.found ? (el.dataset.cbql ? _loadTwCBQLBlock(el) : _loadTwBlock(el)) : NbWeb.renderRequirementsCard(el, '/plugins/requirements/tw-requirements.md'); },
                render: async container => {
                    const blocks = [...container.querySelectorAll('.nb-tw-block')];
                    if (!blocks.length) return;
                    NbWeb.statusPill?.add(blocks.length);
                    try {
                        const w = await NbWeb.checkWhich('task');
                        await Promise.all(blocks.map(async el => {
                            try { await (w.found ? (el.dataset.cbql ? _loadTwCBQLBlock(el) : _loadTwBlock(el)) : NbWeb.renderRequirementsCard(el, '/plugins/requirements/tw-requirements.md')); }
                            finally { NbWeb.statusPill?.tick(); }
                        }));
                    } catch { blocks.forEach(() => NbWeb.statusPill?.tick()); }
                },
            },
            {
                lang:   'hl',
                html:   text => {
                    const collapsed = /^#\s*collapsed\b/im.test(text);
                    const cbql      = /^source:\s*\S/m.test(text);
                    const {readLevel, writeLevel, query} = _cbParseGates(text.split('\n').filter(l => !/^#\s*collapsed\b/i.test(l.trim())).join('\n'));
                    if (cbql)
                        return `<div class="nb-hl-block${collapsed ? ' nb-collapsed' : ''}" data-cbql="1"${_cbGateAttrs(readLevel,writeLevel)} data-src="${text.replace(/"/g,'&quot;')}"${collapsed ? ' data-init-collapsed' : ''}><span class="nb-spin">⟳</span></div>`;
                    return `<div class="nb-hl-block${collapsed ? ' nb-collapsed' : ''}"${_cbGateAttrs(readLevel,writeLevel)} data-query="${query.replace(/"/g,'&quot;')}"${collapsed ? ' data-init-collapsed' : ''}><span class="nb-spin">⟳</span></div>`;
                },
                renderOne: async el => {
                    const w = await NbWeb.checkWhich('hledger');
                    return w.found
                        ? (el.dataset.cbql ? _loadHledgerCBQLBlock(el) : _loadHledgerBlock(el))
                        : NbWeb.renderRequirementsCard(el, '/plugins/requirements/hledger-requirements.md');
                },
                render: async container => {
                    const blocks = [...container.querySelectorAll('.nb-hl-block')];
                    if (!blocks.length) return;
                    NbWeb.statusPill?.add(blocks.length);
                    try {
                        const w = await NbWeb.checkWhich('hledger');
                        await Promise.all(blocks.map(async el => {
                            try { await (w.found
                                ? (el.dataset.cbql ? _loadHledgerCBQLBlock(el) : _loadHledgerBlock(el))
                                : NbWeb.renderRequirementsCard(el, '/plugins/requirements/hledger-requirements.md')); }
                            finally { NbWeb.statusPill?.tick(); }
                        }));
                    } catch { blocks.forEach(() => NbWeb.statusPill?.tick()); }
                },
            },
            {
                lang:      'timedot',
                html:      text => {
                    const cbql = /^source:\s*\S/m.test(text);
                    return `<div class="nb-timedot-block"${cbql ? ' data-cbql="1"' : ''} data-src="${text.replace(/"/g, '&quot;')}"><span class="nb-spin">⟳</span></div>`;
                },
                renderOne: async el => {                          // FM barblock: log or aggregate
                    const note = typeof NbMain !== 'undefined' ? NbMain.activeNote?.() : null;
                    return note?.meta?.timedot_file
                        ? _loadTimedotBlock(el)     // external file: aggregate + filter + add form
                        : _loadTimedotLogBlock(el); // inline: date log with comments + anchors
                },
                render:    async container => {                  // body codeblock: verbatim + edit / CBQL
                    const blocks = [...container.querySelectorAll('.nb-timedot-block')];
                    if (!blocks.length) return;
                    NbWeb.statusPill?.add(blocks.length);
                    await Promise.all(blocks.map(async el => {
                        try { await (el.dataset.cbql ? _loadTimedotCBQLBlock(el) : _loadTimedotRawBlock(el)); }
                        finally { NbWeb.statusPill?.tick(); }
                    }));
                },
            },
            {
                lang:  'timeline',
                html:  text => {
                    const cbql = /^source:\s*\S/m.test(text);
                    return `<div class="nb-timeline-block"${cbql ? ' data-cbql="1"' : ''} data-src="${text.replace(/"/g, '&quot;')}"><span class="nb-spin">⟳</span></div>`;
                },
                render: async container => {
                    const blocks = [...container.querySelectorAll('.nb-timeline-block')];
                    if (!blocks.length) return;
                    NbWeb.statusPill?.add(blocks.length);
                    await Promise.all(blocks.map(async el => {
                        try { await _loadTimelineCBQLBlock(el); }
                        finally { NbWeb.statusPill?.tick(); }
                    }));
                },
            },
            {
                lang:  'checklist',
                html:  text => {
                    const cbql = /^source:\s*\S/m.test(text);
                    return `<div class="nb-checklist-block"${cbql ? ' data-cbql="1"' : ''} data-src="${text.replace(/"/g, '&quot;')}"><span class="nb-spin">⟳</span></div>`;
                },
                render: async container => {
                    const blocks = [...container.querySelectorAll('.nb-checklist-block')];
                    if (!blocks.length) return;
                    NbWeb.statusPill?.add(blocks.length);
                    await Promise.all(blocks.map(async el => {
                        try { await _loadChecklistCBQLBlock(el); }
                        finally { NbWeb.statusPill?.tick(); }
                    }));
                },
            },
            {
                lang:   'nav',
                html:   text => { const {readLevel,writeLevel,query} = _cbParseGates(text); return `<div class="nb-nav-block"${_cbGateAttrs(readLevel,writeLevel)} data-query="${query.replace(/"/g,'&quot;')}"><span class="nb-spin">⟳</span></div>`; },
                renderOne: async el => _loadNavBlock(el),
                render: async container => {
                    const blocks = [...container.querySelectorAll('.nb-nav-block')];
                    if (!blocks.length) return;
                    NbWeb.statusPill?.add(blocks.length);
                    await Promise.all(blocks.map(async el => { try { await _loadNavBlock(el); } finally { NbWeb.statusPill?.tick(); } }));
                },
            },
            {
                lang:   'fm',
                html:   text => { const {readLevel,writeLevel,query} = _cbParseGates(text); return `<div class="nb-fm-block"${_cbGateAttrs(readLevel,writeLevel)} data-query="${query.replace(/"/g,'&quot;')}"><span class="nb-spin">⟳</span></div>`; },
                renderOne: async el => _loadFrontBlock(el),
                render: async container => {
                    const blocks = [...container.querySelectorAll('.nb-fm-block')];
                    if (!blocks.length) return;
                    NbWeb.statusPill?.add(blocks.length);
                    await Promise.all(blocks.map(async el => { try { await _loadFrontBlock(el); } finally { NbWeb.statusPill?.tick(); } }));
                },
            },
            {
                lang:   'cfg',
                html:   text => { const {readLevel,writeLevel,query} = _cbParseGates(text); return `<div class="nb-config-block"${_cbGateAttrs(readLevel,writeLevel)} data-query="${query.replace(/"/g,'&quot;')}"><span class="nb-spin">⟳</span></div>`; },
                renderOne: async el => _loadConfigBlock(el),
                render: async container => {
                    const blocks = [...container.querySelectorAll('.nb-config-block')];
                    if (!blocks.length) return;
                    NbWeb.statusPill?.add(blocks.length);
                    await Promise.all(blocks.map(async el => { try { await _loadConfigBlock(el); } finally { NbWeb.statusPill?.tick(); } }));
                },
            },
            {
                lang:   't',
                html:   text => { const {readLevel,writeLevel,query} = _cbParseGates(text); return `<div class="nb-t-block"${_cbGateAttrs(readLevel,writeLevel)} data-period="${query.replace(/"/g,'&quot;')}"><span class="nb-spin">⟳</span></div>`; },
                renderOne: async el => _loadTBlock(el),
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
                renderOne: async el => _loadNbBlock(el),
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
                renderOne: async el => _loadGitBlock(el),
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
                lang: 'claude',
                // Same underlying mechanism as `tui` (identical PTY/xterm wiring,
                // `_tuiBuildHtml`/`_tuiWire` reused verbatim) -- own lang tag so a
                // reader knows what this is at a glance, and own gate-group
                // ('claude', not 'tui') so access defaults can be configured
                // independently. Empty body defaults to a fresh `claude` --
                // `-c`/continue-last-session doesn't recognize headless -p
                // sessions as continuable (verified: "No conversation found
                // to continue"), so real continuity from the modal's own
                // Q&A goes through an explicit --resume <session_id>
                // instead -- see _CLAUDE_WRITE_GUIDANCE / api_claude_ask's
                // placeholder-substitution in app.py.
                html: text => {
                    const {readLevel, writeLevel, query} = _cbParseGates(text);
                    const lines  = query.trim().split('\n');
                    const height = (query.match(/^#\s*height[=:]\s*(\d+)/m) || [])[1] || '400';
                    const body   = lines.filter(l => !l.startsWith('#')).join(' ').trim();
                    const pipe   = body.indexOf('|');
                    const cmd    = (pipe >= 0 ? body.slice(0, pipe) : body).trim() || 'claude';
                    const label  = pipe >= 0 ? body.slice(pipe + 1).trim() : '';
                    return `<div class="nb-claude-block"${_cbGateAttrs(readLevel,writeLevel)}>${_tuiBuildHtml(cmd, label, parseInt(height) || 400)}</div>`;
                },
                render: async container => {
                    const outers = [...container.querySelectorAll('.nb-claude-block > .nb-tui-outer:not([data-tui-wired])')];
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
                        const block = outer.closest('.nb-claude-block');
                        if (block && !_cbCan(block, 'claude', 'read')) {
                            _cbDenyRead(block);
                            NbWeb.statusPill?.tick();
                            continue;
                        }
                        outer.dataset.tuiWired = '1';
                        try { _tuiWire(outer); }
                        catch (e) {
                            console.error('[claude] wire error:', e);
                            outer.innerHTML = `<div style="padding:8px;color:var(--red,#ef4444);font-size:12px">⚠ claude error: ${_esc(String(e))}</div>`;
                        } finally {
                            NbWeb.statusPill?.tick();
                        }
                    }
                },
            },
            {
                lang: 'claude_code',
                // Same mechanism as `claude` (identical PTY/xterm wiring),
                // but reachable as a frontmatter key too -- _buildFmBlocks
                // (main.js) already lets any codeblock lang double as a
                // same-named FM key, rendering into #nb-fm-blocks (the FM
                // strip) instead of the note body. `claude_code: <cmd>|label`
                // in frontmatter behaves exactly like a fenced
                // ```claude_code block with that same content -- own lang
                // tag (not `claude`) so it doesn't collide with the
                // existing claude: FM key, which already means something
                // else (badge + model cascade). Own wrapper class, same
                // reason `claude` needed one distinct from `tui`.
                html: text => {
                    const {readLevel, writeLevel, query} = _cbParseGates(text);
                    const lines  = query.trim().split('\n');
                    const height = (query.match(/^#\s*height[=:]\s*(\d+)/m) || [])[1] || '400';
                    const body   = lines.filter(l => !l.startsWith('#')).join(' ').trim();
                    const pipe   = body.indexOf('|');
                    const cmd    = (pipe >= 0 ? body.slice(0, pipe) : body).trim() || 'claude';
                    const label  = pipe >= 0 ? body.slice(pipe + 1).trim() : 'Claude';
                    return `<div class="nb-claude-code-block"${_cbGateAttrs(readLevel,writeLevel)}>${_tuiBuildHtml(cmd, label, parseInt(height) || 400)}</div>`;
                },
                render: async container => {
                    const outers = [...container.querySelectorAll('.nb-claude-code-block > .nb-tui-outer:not([data-tui-wired])')];
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
                        const block = outer.closest('.nb-claude-code-block');
                        if (block && !_cbCan(block, 'claude', 'read')) {
                            _cbDenyRead(block);
                            NbWeb.statusPill?.tick();
                            continue;
                        }
                        outer.dataset.tuiWired = '1';
                        try { _tuiWire(outer); }
                        catch (e) {
                            console.error('[claude_code] wire error:', e);
                            outer.innerHTML = `<div style="padding:8px;color:var(--red,#ef4444);font-size:12px">⚠ claude_code error: ${_esc(String(e))}</div>`;
                        } finally {
                            NbWeb.statusPill?.tick();
                        }
                    }
                },
            },
            {
                lang:   'check',
                html:   text => {
                    const {readLevel,writeLevel,query} = _cbParseGates(text);
                    const isList = /^list(\s|$)/.test(query.trim());
                    const extraCls = isList ? ' nb-collapsed' : '';
                    const extraAttr = isList ? ' data-init-collapsed' : '';
                    return `<div class="nb-test-block${extraCls}"${_cbGateAttrs(readLevel,writeLevel)} data-query="${query.replace(/"/g,'&quot;')}"${extraAttr}></div>`;
                },
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
            {
                lang:   'gallery',
                html:   text => { const {query} = _cbParseGates(text); return `<div class="nb-gallery-block" data-query="${query.replace(/"/g,'&quot;')}"><span class="nb-spin">⟳</span></div>`; },
                renderOne: async el => _loadGalleryBlock(el),
                render: async container => {
                    const blocks = [...container.querySelectorAll('.nb-gallery-block')];
                    if (!blocks.length) return;
                    NbWeb.statusPill?.add(blocks.length);
                    await Promise.all(blocks.map(async el => { try { await _loadGalleryBlock(el); } finally { NbWeb.statusPill?.tick(); } }));
                },
            },
            {
                lang:   'toc',
                html:   () => `<div class="nb-toc-block"><span class="nb-spin">⟳</span></div>`,
                renderOne: el => _loadTocBlock(el),
                render: async container => {
                    const blocks = [...container.querySelectorAll('.nb-toc-block')];
                    if (!blocks.length) return;
                    NbWeb.statusPill?.add(blocks.length);
                    blocks.forEach(el => { try { _loadTocBlock(el); } finally { NbWeb.statusPill?.tick(); } });
                },
            },
            {
                lang:      'sysadmin',
                html:      text => {
                    const mode = (text || '').trim() || 'inventory';
                    return `<div class="nb-sysadmin-block" data-mode="${_esc(mode)}"><span class="nb-spin">⟳</span></div>`;
                },
                renderOne: async el => _dispatchSysadminBlock(el),
                render:    async container => {
                    const blocks = [...container.querySelectorAll('.nb-sysadmin-block')];
                    await Promise.all(blocks.map(el => _dispatchSysadminBlock(el)));
                },
            },
            {
                lang:      'csv',
                // Body codeblocks contain multi-line CSV data; FM values are single-line
                // token lists, optionally with a trailing integer scroll limit.
                // e.g. "materials" or "materials 10"
                // Return false for body blocks so marked falls through to
                // <pre><code class="language-csv"> which _renderCsvBlocks in main.js picks up.
                html: text => {
                    if (text.includes('\n')) return false;
                    const parts = text.trim().split(/\s+/);
                    const last  = parts[parts.length - 1];
                    const hasLimit = /^\d+$/.test(last);
                    const limit  = hasLimit ? last : '8';
                    const tokens = hasLimit ? parts.slice(0, -1).join(',') : parts.join(',');
                    return `<div class="nb-csv-catalog" data-csv-tokens="${_esc(tokens)}" data-csv-limit="${_esc(limit)}"></div>`;
                },
                renderOne: async el => _loadCsvCatalogBlock(el),
            },
        ],

    });

    // Sysadmin block links — open note on [data-open] clicks inside sysadmin blocks.
    document.addEventListener('click', e => {
        const link = e.target.closest('.nb-sa-link[data-open]');
        if (!link) return;
        e.preventDefault();
        const sel = link.dataset.open;
        if (sel) NbMain.openNote(sel);
    });

    // CBQL DELIVERED button — write > DELIVERED: marker into the project source note.
    document.addEventListener('click', async e => {
        const btn = e.target.closest('.nb-timeline-deliver-btn[data-marker]');
        if (!btn) return;
        e.stopPropagation();
        const sourceSel = btn.dataset.sourceSel || '';
        const milestoneRef = btn.dataset.ref || '';
        if (!sourceSel) return;
        const note = prompt(`Delivery note for "${milestoneRef}" (optional):`);
        if (note === null) return;  // cancelled
        btn.disabled = true;
        const prev = btn.textContent;
        btn.textContent = '…';
        try {
            const r = await fetch('/api/project/write-marker', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    selector: sourceSel,
                    marker: 'DELIVERED',
                    ref: (milestoneRef + (note.trim() ? ` — ${note.trim()}` : '')).trim(),
                    position: 'before_today',
                }),
            });
            if (!r.ok) throw new Error(await r.text());
            btn.textContent = '✓ delivered';
            btn.classList.add('nb-timeline-delivered');
        } catch (err) {
            btn.disabled = false;
            btn.textContent = prev;
            alert(`Could not write DELIVERED marker: ${err.message}`);
        }
    });

    // Re-render CBQL blocks when the timeline block broadcasts a timeframe change.
    document.addEventListener('nb-timeframe-changed', e => {
        const { timeframe } = e.detail || {};
        if (!timeframe) return;
        document.querySelectorAll('.nb-timedot-block[data-cbql]').forEach(el => {
            el.dataset.activeTimeframe = timeframe;
            _loadTimedotCBQLBlock(el);
        });
        document.querySelectorAll('.nb-tw-block[data-cbql]').forEach(el => {
            el.dataset.activeTimeframe = timeframe;
            _loadTwCBQLBlock(el);
        });
        document.querySelectorAll('.nb-timeline-block[data-cbql]').forEach(el => {
            if (el.dataset.activeTimeframe === timeframe) return; // already current
            el.dataset.activeTimeframe = timeframe;
            const tfSel = el.querySelector('.nb-timeline-tf-sel');
            if (tfSel) tfSel.value = timeframe;
            _renderTimelineFromData(el, timeframe);
        });
        document.querySelectorAll('.nb-hl-block[data-cbql]').forEach(el => {
            el.dataset.activeTimeframe = timeframe;
            _loadHledgerCBQLBlock(el);
        });

        // Recalc journals from the CBQL source note so non-CBQL hl blocks and
        // inline queries reflect the same data as the CBQL blocks.
        _recalcSourceJournals();
    });

    // Rebuild timedot + labour journal from the CBQL source note on demand.
    // Mirrors the timedot block save sync; called on timeframe change.
    async function _recalcSourceJournals() {
        const note = typeof NbMain !== 'undefined' ? NbMain.activeNote?.() : null;
        if (!note) return;
        const sourceFM = note.meta?.source || note.effective_fm?.source || '';
        if (!sourceFM) return;

        const noteSel  = note.selector || '';
        const sourceSel = (typeof _cbqlResolveSel === 'function')
            ? _cbqlResolveSel(sourceFM, noteSel)
            : sourceFM;

        let sourceNote;
        try {
            const r = await fetch(`/api/note?selector=${encodeURIComponent(sourceSel)}`);
            if (!r.ok) return;
            sourceNote = await r.json();
        } catch { return; }

        const raw      = (sourceNote.raw || sourceNote.body || '');
        const meta     = sourceNote.meta || {};
        const effFm    = sourceNote.effective_fm || {};
        const project  = meta.project || '';
        const rate     = parseFloat(meta.rate || effFm.rate) || 0;
        const journalKey = meta.journal || effFm.journal || '';
        const syncFile   = meta.timedot_file || effFm.timedot_file
                        || (journalKey ? journalKey.replace(/\.journal$/, '-gen.timedot') : '');
        if (!syncFile) return;

        const _write = (file, content) => fetch('/api/t/timedot/write', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file, content }),
        }).catch(() => {});

        const genHdr   = `; DO NOT HAND EDIT — generated from note blocks. Edit source in nb-web.\n`;
        await _write(syncFile, genHdr + _timedotExtractFile(raw, project));
        const labourFile = journalKey ? journalKey.replace(/\.journal$/, '-gen.labour.journal') : '';
        if (rate && labourFile)
            await _write(labourFile, _timedotExtractLabourJournal(raw, project, rate));
    }

    // Export FM utilities so main.js can use them in the card-footer Changes button
    // without duplicating the helpers.
    NbWeb.fmUtils = {
        parseFields: _fmParseFields, patch: _fmPatch, widget: _fmWidget,
        buildFmSkeleton(block, lang) {
            block.innerHTML = '';
            block.dataset.fmLazy = '1';
            const { hdr, meta } = _buildBarHeader(block, { lang, cls: lang === 'cfg' ? 'config' : undefined });
            meta.textContent = '…';
            block.appendChild(hdr);
        },
    };

})();

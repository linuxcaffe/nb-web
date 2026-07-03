// NbWeb-specialty — typed note headers for service/project/business FM types.
// Global plugin — no detect(), active for all notebooks.
// Plugins extend this via window.NbSpecialty.register() and .getActions().
// @name     NbWeb Specialty
// @version  0.1.0
// @type     core

(() => {

    const _esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    // Core type registry — plugins may add entries via NbSpecialty.register()
    const _cfg = {
        tools:     { icon: '🔧', label: 'Tool Inventory' },
        materials: { icon: '📦', label: 'Materials Catalog' },
        transport: { icon: '🚗', label: 'Transport' },
        quote:     { icon: '📋', label: 'Quote' },
        budget:    { icon: '💰', label: 'Budget' },
        project:   { icon: '🏗️', label: 'Project' },
        report:    { icon: '📊', label: 'Report'   },
        reports:   { icon: '📊', label: 'Reports'  },
        invoice:   { icon: '🧾', label: 'Invoice' },
        dashboard: { icon: '🗂️', label: 'Dashboard' },
        dotfile:   { icon: '⚙️', label: 'Config'    },
    };

    // Type help popover — `help: <topic>` in note FM → ? button on specialty header
    // Fetches .lib:help-type-<topic>.md and renders it as a popover via _showLibHelp pattern.
    function _showTypeHelp(trigger, topic) {
        if (trigger._helpPop) {
            trigger._helpPop.remove();
            trigger._helpPop = null;
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

        fetch(`/api/note?selector=${encodeURIComponent(`.lib:help-type-${topic}.md`)}`)
            .then(r => r.json())
            .then(d => {
                const body = d.body || '';
                if (body) {
                    pop.innerHTML = NbMain.renderMarkdown(body, d.selector || '');
                    NbMain.enrichRendered(pop, d);
                } else {
                    pop.innerHTML = '<em style="padding:8px;display:block;color:var(--text-muted)">No help available</em>';
                }
                const pr = pop.getBoundingClientRect();
                if (pr.right > window.innerWidth - 8)
                    pop.style.left = Math.max(8, rect.right - pr.width) + 'px';
                if (pr.bottom > window.innerHeight - 8)
                    pop.style.top  = Math.max(8, rect.top - pr.height - 4) + 'px';
            })
            .catch(() => { pop.innerHTML = '<em style="padding:8px;display:block">Error loading help</em>'; });

        trigger._helpPop = pop;
        const dismiss = () => {
            pop.remove();
            trigger._helpPop = null;
            trigger.classList.remove('nb-lib-btn-active');
            document.removeEventListener('click', outside, true);
        };
        const outside = e => { if (!pop.contains(e.target) && e.target !== trigger) dismiss(); };
        setTimeout(() => document.addEventListener('click', outside, true), 0);
    }

    // Inject the nearest preceding date heading into timedot blocks that have no date line.
    function _injectDateContext(body) {
        const lines = body.split('\n');
        let currentDate = null;
        const result = [];
        let inBlock = false, blockHeader = '', blockLines = [];
        for (const line of lines) {
            if (!inBlock) {
                const m = line.match(/^#{1,6}\s+(\d{4}-\d{2}-\d{2})/);
                if (m) currentDate = m[1];
                if (/^```timedot/.test(line)) { inBlock = true; blockHeader = line; blockLines = []; }
                else result.push(line);
            } else {
                if (line.startsWith('```')) {
                    const hasDate = blockLines.some(l => /^\d{4}[-/]\d{2}[-/]\d{2}/.test(l.trim()));
                    result.push(blockHeader);
                    if (!hasDate && currentDate) result.push(currentDate);
                    result.push(...blockLines, line);
                    inBlock = false;
                } else {
                    blockLines.push(line);
                }
            }
        }
        return result.join('\n');
    }

    async function _appendTodayAndEdit(note) {
        const today   = new Date().toISOString().slice(0, 10);
        const heading = `## ${today}`;
        const body    = note.body || '';

        if (!body.includes(heading)) {
            const todayM     = /^> TODAY:/m.exec(body);
            const milestoneM = /^> MILESTONE:/m.exec(body);

            let newBody;
            if (todayM) {
                // Insert immediately above > TODAY: marker
                newBody = body.slice(0, todayM.index).trimEnd()
                    + `\n\n${heading}\n\n`
                    + body.slice(todayM.index);
            } else if (milestoneM) {
                // No TODAY marker — insert before first planned milestone
                newBody = body.slice(0, milestoneM.index).trimEnd()
                    + `\n\n${heading}\n\n`
                    + body.slice(milestoneM.index);
            } else {
                newBody = body.trimEnd() + `\n\n${heading}\n\n`;
            }

            // Preserve FM: note.raw = full file; FM ends at second ---
            const raw = note.raw || '';
            let fullContent = newBody;
            if (raw.startsWith('---')) {
                const fmClose = raw.indexOf('\n---', 3);
                if (fmClose !== -1)
                    fullContent = raw.slice(0, fmClose + 4) + '\n' + newBody;
            }

            await fetch('/api/note', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ selector: note.selector, content: fullContent }),
            });
        }
        NbMain.openEditor(note.selector);

        // After openEditor re-fetches and populates the textarea, position the
        // cursor on the blank line just below the inserted heading (before > TODAY:).
        let attempts = 0;
        const positionCursor = () => {
            const ta = document.getElementById('nb-editor');
            if (ta && ta.value.includes(heading)) {
                const pos = ta.value.indexOf(heading) + heading.length + 1; // past \n
                ta.setSelectionRange(pos, pos);
                ta.focus();
                return;
            }
            if (++attempts < 60) requestAnimationFrame(positionCursor);
        };
        requestAnimationFrame(positionCursor);
    }

    // Derive the selector for a paired note by swapping the filename suffix.
    function _pairedSel(note, newFilename) {
        const sel = note.selector || '';
        const fn  = note.filename  || '';
        return (sel && fn) ? sel.slice(0, sel.length - fn.length) + newFilename : '';
    }

    function _selNotebook(sel) {
        const i = sel.indexOf(':');
        return i > 0 ? sel.slice(0, i) : 'home';
    }

    async function _patchFMSource(noteSel, sourceFilename) {
        const r = await fetch(`/api/note?selector=${encodeURIComponent(noteSel)}`);
        const d = await r.json();
        if (!r.ok || d.error) return false;
        let raw = d.raw || '';
        if (/^source:\s*$/m.test(raw))
            raw = raw.replace(/^source:\s*$/m, `source: ${sourceFilename}`);
        else if (/^source:/m.test(raw))
            raw = raw.replace(/^source:.*$/m, `source: ${sourceFilename}`);
        else
            raw = raw.replace(/^(type:\s*\S.*)$/m, `$1\nsource: ${sourceFilename}`);
        const pr = await fetch('/api/note', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selector: noteSel, content: raw }),
        });
        return !!(await pr.json()).success;
    }

    async function _fetchTemplateContent(name) {
        const r = await fetch(`/api/template?path=${encodeURIComponent(`/home/djp/.nb/.templates/${name}.md`)}`);
        if (!r.ok) return null;
        return (await r.json()).content || null;
    }

    let _pairPopup = null;
    function _closePairPopup() { _pairPopup?.remove(); _pairPopup = null; }

    function _showPairPopup(anchor, html) {
        _closePairPopup();
        const pop = document.createElement('div');
        pop.className = 'nb-pair-popup';
        pop.innerHTML = html;
        pop.addEventListener('click', e => e.stopPropagation());
        document.body.appendChild(pop);
        _pairPopup = pop;
        const rect = anchor.getBoundingClientRect();
        pop.style.top  = `${rect.bottom + 6}px`;
        pop.style.left = `${Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8)}px`;
        setTimeout(() => document.addEventListener('click', _closePairPopup, { once: true }), 0);
        return pop;
    }

    async function _offerCreateReports(anchor, targetSel, projectTitle, sourceFile, notebook) {
        // Filename is always derived from targetSel (chip points to stem-reports.md).
        // Never slug from the title — titles change, filenames don't.
        const reportsFilename = targetSel.replace(/^.*:/, '');
        const reportsTitle    = projectTitle ? `${projectTitle} — Reports` : 'Reports';
        const pop = _showPairPopup(anchor, `
            <div class="nb-pair-popup-msg">Create <strong>${_esc(reportsTitle)}</strong> in <em>${_esc(notebook)}</em>?</div>
            <div class="nb-pair-popup-btns">
                <button class="nb-pair-cancel">Cancel</button>
                <button class="nb-pair-confirm">Create reports page</button>
            </div>`);
        pop.querySelector('.nb-pair-cancel').onclick  = () => _closePairPopup();
        pop.querySelector('.nb-pair-confirm').onclick = async () => {
            _closePairPopup();
            let tplContent = await _fetchTemplateContent('project-reports');
            if (tplContent && sourceFile)
                tplContent = tplContent.replace(/^source:\s*$/m, `source: ${sourceFile}`);
            const r = await fetch('/api/notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notebook, title: reportsTitle,
                    filename: reportsFilename, template_content: tplContent || '' }),
            });
            const d = await r.json();
            if (d?.selector) NbMain.openNote(d.selector);
        };
    }

    async function _offerCreateOrLink(anchor, targetSel, notebook, reportsNoteSel) {
        const pop = _showPairPopup(anchor, `
            <div class="nb-pair-popup-msg">Project note not found.</div>
            <div class="nb-pair-popup-btns">
                <button class="nb-pair-cancel">Cancel</button>
                <button class="nb-pair-create">Create project</button>
                <button class="nb-pair-link">Link existing…</button>
            </div>`);
        pop.querySelector('.nb-pair-cancel').onclick = () => _closePairPopup();
        pop.querySelector('.nb-pair-create').onclick = async () => {
            _closePairPopup();
            const tplContent     = await _fetchTemplateContent('project');
            const projectFilename = targetSel.replace(/^.*:/, '');
            const stem           = projectFilename.replace(/\.md$/i, '');
            const r = await fetch('/api/notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notebook, title: stem,
                    filename: projectFilename, template_content: tplContent || '' }),
            });
            const d = await r.json();
            if (d?.selector && reportsNoteSel)
                await _patchFMSource(reportsNoteSel, d.selector.replace(/^.*:/, ''));
            if (d?.selector) NbMain.openNote(d.selector);
        };
        pop.querySelector('.nb-pair-link').onclick = () => {
            _closePairPopup();
            _showProjectPicker(anchor, notebook, async filename => {
                if (reportsNoteSel) await _patchFMSource(reportsNoteSel, filename);
                NbMain.openNote(reportsNoteSel || `${notebook}:${filename}`);
            });
        };
    }

    async function _showProjectPicker(anchor, notebook, onSelect) {
        const r  = await fetch(`/api/notes?notebook=${encodeURIComponent(notebook)}`);
        const d  = await r.json();
        const notes = Array.isArray(d) ? d : (d.notes || []);
        const projects = notes.filter(n => n.type === 'project' || n.meta?.type === 'project');
        if (!projects.length) {
            _showPairPopup(anchor,
                '<div class="nb-pair-popup-msg" style="color:var(--text-muted)">No project notes in this notebook.</div>');
            return;
        }
        const items = projects.map(n =>
            `<button class="nb-pair-pick-item" data-file="${_esc(n.filename)}">${_esc(n.title || n.filename)}</button>`
        ).join('');
        const pop = _showPairPopup(anchor, `
            <div class="nb-pair-popup-msg">Link to project:</div>
            <div class="nb-pair-pick-list">${items}</div>`);
        pop.querySelectorAll('.nb-pair-pick-item').forEach(btn => {
            btn.onclick = () => { _closePairPopup(); onSelect(btn.dataset.file); };
        });
    }

    function _renderSpecialtyNote(note) {
        const { icon, label } = _cfg[note.type] || { icon: '📋', label: note.type };
        let pills = [], pillsHtml = '';
        if (note.type === 'invoice') {
            const statusCls = note.meta?.status === 'paid' ? ' nb-pill-paid' : ' nb-pill-due';
            if (note.meta?.invoice_num) pills.push(`<span class="nb-specialty-pill">${_esc(note.meta.invoice_num)}</span>`);
            if (note.meta?.due)         pills.push(`<span class="nb-specialty-pill">due: ${_esc(note.meta.due)}</span>`);
            if (note.meta?.status)      pills.push(`<span class="nb-specialty-pill${statusCls}">${_esc(note.meta.status)}</span>`);
            pillsHtml = pills.join('');
        } else {
            if (note.meta?.status)       pills.push(note.meta.status);
            if (note.meta?.billing_type) pills.push(note.meta.billing_type);
            if (note.meta?.client)       pills.push(String(note.meta.client).replace(/^contacts:/, '').replace(/\.md$/, ''));
            pillsHtml = pills.map(p => `<span class="nb-specialty-pill">${_esc(p)}</span>`).join('');
        }
        // Project ↔ Reports pair chip — smart: pre-flights existence, offers create/link on miss
        let pairLink = '', sourceWarn = '';
        if (note.type === 'project') {
            const stem = (note.filename || '').replace(/\.md$/i, '');
            const reportSel = _pairedSel(note, `${stem}-reports.md`);
            if (reportSel) pairLink = `<a class="nb-specialty-link nb-pair-chip" href="#"
                data-open="${_esc(reportSel)}"
                data-pair="reports"
                data-notebook="${_esc(note.notebook || '')}"
                data-pair-title="${_esc(String(note.meta?.title || stem))}"
                data-source-file="${_esc(note.filename || '')}">reports</a>`;
        } else if (note.type === 'reports') {
            const sourceFile = String(note.meta?.source || '').trim();
            const stem = (note.filename || '').replace(/-reports\.md$/i, '').replace(/\.md$/i, '');
            const projectSel = sourceFile
                ? _pairedSel(note, sourceFile)
                : _pairedSel(note, `${stem}.md`);
            if (projectSel) pairLink = `<a class="nb-specialty-link nb-pair-chip" href="#"
                data-open="${_esc(projectSel)}"
                data-pair="project"
                data-notebook="${_esc(note.notebook || '')}"
                data-reports-sel="${_esc(note.selector || '')}"
                data-pair-title="${_esc(String(note.meta?.title || stem))}">project</a>`;
            if (!sourceFile)
                sourceWarn = `<span class="nb-source-warn">no source <button class="nb-specialty-action nb-link-source-btn" data-reports-sel="${_esc(note.selector || '')}" data-notebook="${_esc(note.notebook || '')}">link…</button></span>`;
        }

        const todayBtn     = note.type === 'project'
            ? `<button class="nb-specialty-today" title="Append today's entry and edit">+ Today</button>`
            : '';
        const extraActions = window.NbSpecialty?.getActions?.(note) ?? '';
        const helpTopic    = note.meta?.help;
        const helpBtn      = helpTopic
            ? `<button class="nb-specialty-action nb-specialty-help-btn" data-help-topic="${_esc(helpTopic)}" title="Help">?</button>`
            : '';
        let body = note.type === 'project' ? _injectDateContext(note.body || '') : (note.body || '');
        body = body.replace(/^> ([A-Z]{2,}:.*)$/gm, (_, content) => {
            const markerType = (content.match(/^([A-Z]+):/) || [])[1]?.toLowerCase() || 'marker';
            if (markerType === 'today' && !content.replace(/^TODAY:\s*/i, '').trim()) {
                const n = new Date();
                const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
                const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
                const h = n.getHours(), m = String(n.getMinutes()).padStart(2,'0');
                content = `TODAY: ${days[n.getDay()]} ${months[n.getMonth()]} ${n.getDate()}, ${n.getFullYear()} — ${h % 12 || 12}:${m}${h >= 12 ? 'pm' : 'am'}`;
            }
            return `<div class="nb-project-marker" data-marker="${markerType}">${content}</div>\n`;
        });
        return `<div class="nb-specialty-header" data-selector="${_esc(note.selector || '')}">
            <span class="nb-specialty-icon">${icon}</span>
            <span class="nb-specialty-label">${_esc(label)}</span>
            ${pairLink}${sourceWarn}${pillsHtml}${todayBtn}${extraActions}${helpBtn}
        </div>` + NbMain.renderMarkdown(body, note.selector);
    }

    function _renderDotfileNote(note) {
        const filename = note.filename || '';
        const path     = note.path    || '';

        // Scope: count path components after .nb/
        // global=1 (.nb/.nb.md), notebook=2 (.nb/djp/.djp.md), folder=3+ (.nb/djp/sub/.sub.md)
        const parts = path.replace(/^.*\/\.nb\//, '').split('/').filter(Boolean);
        const depth  = parts.length;
        const scope  = depth <= 1 ? 'global' : depth === 2 ? 'notebook' : 'folder';
        const parent = depth >= 2 ? parts[depth - 2] : '';

        const label   = note.meta?.title
            || filename.replace(/^\./, '').replace(/\.md$/i, '') + (scope === 'global' ? ' (global)' : '');
        const keyCount = note.meta
            ? Object.keys(note.meta).filter(k => k !== 'type' && k !== 'title').length
            : 0;

        // Dashboard pair: remove leading dot from selector filename to get the front-of-house note
        const dashSel = note.selector ? note.selector.replace(/(:|\/)\.([\w.-]+\.md)$/, '$1$2') : '';
        const dashLink = dashSel
            ? `<a class="nb-specialty-link" href="#" data-open="${_esc(dashSel)}">dashboard</a>`
            : '';

        const scopePill  = `<span class="nb-specialty-pill">${scope}</span>`;
        const parentPill = parent ? `<span class="nb-specialty-pill">${_esc(parent)}</span>` : '';
        const keysPill   = keyCount ? `<span class="nb-specialty-pill">${keyCount} keys</span>` : '';

        return `<div class="nb-specialty-header" data-selector="${_esc(note.selector || '')}">
            <span class="nb-specialty-icon">⚙️</span>
            <span class="nb-specialty-label">${_esc(label)}</span>
            ${dashLink}
            ${scopePill}${parentPill}${keysPill}
        </div>` + NbMain.renderMarkdown(note.body || '', note.selector);
    }

    async function _renderDashboardNote(note) {
        const nb     = note.notebook || '';
        const domain = note.meta?.domain || nb;
        const access = note.effective_access || note.meta?.access || '';

        const [listData, syncData] = await Promise.all([
            fetch(`/api/notes?notebook=${encodeURIComponent(nb)}`).then(r => r.json()).catch(() => ({})),
            nb ? fetch(`/api/nb/sync/status?notebook=${encodeURIComponent(nb)}`).then(r => r.json()).catch(() => ({}))
               : Promise.resolve({}),
        ]);

        const items       = listData.notes || [];
        const fileCount   = items.filter(n => n.type !== 'folder').length;
        const folderCount = items.filter(n => n.type === 'folder').length;

        const changes  = syncData.changes  ?? 0;
        const unpushed = syncData.unpushed ?? 0;
        const dirty    = changes - unpushed;
        let syncLabel, syncCls;
        if (!syncData.has_remote) {
            syncLabel = 'local';  syncCls = '';
        } else if (changes === 0) {
            syncLabel = 'synced'; syncCls = ' nb-pill-synced';
        } else {
            const parts = [];
            if (unpushed) parts.push(`↑${unpushed}`);
            if (dirty)    parts.push(`${dirty} unsaved`);
            syncLabel = parts.join(' '); syncCls = ' nb-pill-dirty';
        }

        // Config file: prepend "." to the selector filename (e.g. djp:djp.md → djp:.djp.md)
        const configSel = note.selector
            ? note.selector.replace(/(:|\/)([\w.-]+\.md)$/, '$1.$2')
            : '';
        const configLink = configSel
            ? `<a class="nb-specialty-link" href="#" data-open="${_esc(configSel)}">config</a>`
            : '';

        // Sync + access right-justified
        // TODO: sync click is basic; needs progress feedback, error handling, conflict UI
        const syncPill = `<span class="nb-specialty-pill nb-sync-pill${syncCls}" data-notebook="${_esc(nb)}" title="Click to sync">${_esc(syncLabel)}</span>`;
        const accessBadge = access
            ? `<span class="nb-specialty-pill nb-pill-access nb-pill-access-${_esc(access)}">${_esc(access)}</span>`
            : '';

        return `<div class="nb-specialty-header" data-selector="${_esc(note.selector || '')}">
            <span class="nb-specialty-icon">🗂️</span>
            <span class="nb-specialty-label">${_esc(domain)}</span>
            ${configLink}
            <span class="nb-specialty-pill">${fileCount} files</span>
            <span class="nb-specialty-pill">${folderCount} folders</span>
            <span class="nb-specialty-right">
                <button class="nb-specialty-theme-btn" data-notebook="${_esc(nb)}" title="Choose theme">🎨</button>
                ${syncPill}${accessBadge}
            </span>
        </div>` + NbMain.renderMarkdown(note.body || '', note.selector);
    }

    // ── Reports note renderer ────────────────────────────────────────────────
    // Async: fetches source markers to build the timeframe dropdown.

    const _timeframeState = new Map();  // reportsSel → selected timeframe value

    function _parseSourceMarkers(body) {
        const markers = [];
        for (const m of body.matchAll(/^> ([A-Z]{2,}):\s*(\S+)/gm))
            markers.push({ type: m[1], ref: m[2], full: `${m[1]}: ${m[2]}` });
        return markers;
    }

    async function _fetchSourceMarkers(note) {
        const sourceFile = String(note.meta?.source || '').trim();
        if (!sourceFile) return [];
        const projectSel = _pairedSel(note, sourceFile);
        if (!projectSel) return [];
        const r = await fetch(`/api/note?selector=${encodeURIComponent(projectSel)}`);
        if (!r.ok) return [];
        return _parseSourceMarkers((await r.json()).body || '');
    }

    function _timeframeDropdown(markers, selected, reportsSel) {
        const opt = (val, label) =>
            `<option value="${_esc(val)}"${selected === val ? ' selected' : ''}>${_esc(label)}</option>`;
        // TODAY first (= current phase), then markers in document order, All time last
        const parts = [opt('current', 'TODAY')];
        if (markers.length) {
            parts.push('<option disabled>──────────</option>');
            for (const m of markers)
                parts.push(opt(m.full, m.full));
        }
        parts.push('<option disabled>──────────</option>');
        parts.push(opt('all', 'All time'));
        return `<select class="nb-timeframe-select" data-reports-sel="${_esc(reportsSel)}">${parts.join('')}</select>`;
    }

    async function _renderReportsNote(note) {
        const { icon, label } = _cfg['reports'];
        const sourceFile = String(note.meta?.source || '').trim();
        const stem = (note.filename || '').replace(/-reports\.md$/i, '').replace(/\.md$/i, '');
        const projectSel = sourceFile ? _pairedSel(note, sourceFile) : _pairedSel(note, `${stem}.md`);

        let pairLink = '', sourceWarn = '';
        if (projectSel)
            pairLink = `<a class="nb-specialty-link nb-pair-chip" href="#"
                data-open="${_esc(projectSel)}"
                data-pair="project"
                data-notebook="${_esc(note.notebook || '')}"
                data-reports-sel="${_esc(note.selector || '')}"
                data-pair-title="${_esc(String(note.meta?.title || stem))}">project</a>`;
        if (!sourceFile)
            sourceWarn = `<span class="nb-source-warn">no source <button class="nb-specialty-action nb-link-source-btn" data-reports-sel="${_esc(note.selector || '')}" data-notebook="${_esc(note.notebook || '')}">link…</button></span>`;

        let pills = [];
        if (note.meta?.status) pills.push(note.meta.status);
        const pillsHtml = pills.map(p => `<span class="nb-specialty-pill">${_esc(p)}</span>`).join('');

        const extraActions = window.NbSpecialty?.getActions?.(note) ?? '';
        const helpTopic    = note.meta?.help;
        const helpBtn      = helpTopic
            ? `<button class="nb-specialty-action nb-specialty-help-btn" data-help-topic="${_esc(helpTopic)}" title="Help">?</button>`
            : '';

        return `<div class="nb-specialty-header" data-selector="${_esc(note.selector || '')}">
            <span class="nb-specialty-icon">${icon}</span>
            <span class="nb-specialty-label">${_esc(label)}</span>
            ${pairLink}${sourceWarn}${pillsHtml}${extraActions}${helpBtn}
        </div>` + NbMain.renderMarkdown(note.body || '', note.selector);
    }

    // Timeframe dropdown change → persist state + broadcast event
    document.addEventListener('change', e => {
        const sel = e.target.closest('.nb-timeframe-select');
        if (!sel) return;
        const timeframe  = sel.value;
        const reportsSel = sel.dataset.reportsSel || '';
        _timeframeState.set(reportsSel, timeframe);
        document.dispatchEvent(new CustomEvent('nb-timeframe-changed', {
            detail: { timeframe, selector: reportsSel },
        }));
    });

    NbWeb.registerModule('specialty', {
        label:                'NbWeb Specialty',
        description:          'Typed note headers for project, invoice, quote, budget and related FM types.',
        previewRendererDetect: note => !!_cfg[note.type],
        previewRenderer: note => {
            if (note.type === 'dashboard') return _renderDashboardNote(note);
            if (note.type === 'dotfile')   return _renderDotfileNote(note);
            if (note.type === 'reports')   return _renderReportsNote(note);
            return _cfg[note.type] ? _renderSpecialtyNote(note) : null;
        },
        previewTypes: Object.keys(_cfg),
    });

    document.addEventListener('click', e => {
        if (!e.target.closest('.nb-specialty-today')) return;
        e.preventDefault();
        const note = NbMain.activeNote();
        if (note) _appendTodayAndEdit(note);
    });

    document.addEventListener('click', async e => {
        const chip = e.target.closest('.nb-pair-chip[data-open]');
        if (chip) {
            e.preventDefault();
            const targetSel    = chip.dataset.open;
            const pairType     = chip.dataset.pair;
            const notebook     = chip.dataset.notebook || _selNotebook(targetSel);
            const reportsNoteSel = chip.dataset.reportsSel  || '';
            const projectTitle   = chip.dataset.pairTitle   || '';
            const sourceFile     = chip.dataset.sourceFile  || '';
            const resp = await fetch(`/api/note?selector=${encodeURIComponent(targetSel)}`);
            if (resp.ok) { NbMain.openNote(targetSel); return; }
            if (pairType === 'reports')
                _offerCreateReports(chip, targetSel, projectTitle, sourceFile, notebook);
            else if (pairType === 'project')
                _offerCreateOrLink(chip, targetSel, notebook, reportsNoteSel);
            return;
        }
        const link = e.target.closest('.nb-specialty-link[data-open]');
        if (!link) return;
        e.preventDefault();
        NbMain.openNote(link.dataset.open);
    });

    document.addEventListener('click', e => {
        const btn = e.target.closest('.nb-link-source-btn');
        if (!btn) return;
        e.stopPropagation();
        const reportsNoteSel = btn.dataset.reportsSel || '';
        const notebook       = btn.dataset.notebook   || '';
        if (!reportsNoteSel || !notebook) return;
        _showProjectPicker(btn, notebook, async filename => {
            await _patchFMSource(reportsNoteSel, filename);
            NbMain.openNote(reportsNoteSel);
        });
    });

    document.addEventListener('click', e => {
        const btn = e.target.closest('.nb-specialty-help-btn[data-help-topic]');
        if (!btn) return;
        e.stopPropagation();
        _showTypeHelp(btn, btn.dataset.helpTopic);
    });

    document.addEventListener('click', async e => {
        const pill = e.target.closest('.nb-sync-pill[data-notebook]');
        if (!pill) return;
        e.preventDefault();
        const nb = pill.dataset.notebook;
        if (!nb) return;
        const prev = pill.textContent;
        pill.textContent = '⟳ syncing…';
        pill.classList.remove('nb-pill-synced', 'nb-pill-dirty');
        try {
            const r = await fetch('/api/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notebook: nb }),
            });
            const d = await r.json();
            pill.textContent = d.success ? 'synced' : (d.error || 'error');
            pill.classList.toggle('nb-pill-synced', !!d.success);
            pill.classList.toggle('nb-pill-dirty',  !d.success);
        } catch(_) {
            pill.textContent = 'error';
            pill.classList.add('nb-pill-dirty');
        }
    });

    // ── Theme picker ──────────────────────────────────────────────────────────
    let _themePopup     = null;
    let _pickerNotebook = null;

    function _closeThemePopup() {
        _themePopup?.remove();
        _themePopup = null;
    }

    async function _openThemePicker(btn, notebook) {
        _closeThemePopup();
        _pickerNotebook = notebook;
        const themes  = await NbTheme.listThemes();
        const current = NbTheme.getSlug();
        const mode    = NbTheme.getMode();

        const popup = document.createElement('div');
        popup.className = 'nb-theme-popup';
        popup.innerHTML = `
            <div class="nb-theme-popup-toolbar">
                <span class="nb-theme-popup-title">Theme</span>
                <button class="nb-theme-new-btn" title="New theme">+</button>
                <button class="nb-theme-mode-toggle" title="Toggle light/dark">${mode === 'dark' ? '☀ Light' : '☾ Dark'}</button>
            </div>
            <div class="nb-theme-cards"></div>`;

        const cards = popup.querySelector('.nb-theme-cards');
        for (const t of themes) {
            const vars = t[mode] || {};
            const card = document.createElement('button');
            card.className = 'nb-theme-card' + (t.slug === current ? ' nb-theme-card-active' : '');
            card.dataset.slug = t.slug;
            card.innerHTML = `
                <span class="nb-theme-swatches">
                    <span style="background:${vars.bg     || '#000'}"></span>
                    <span style="background:${vars.bg2    || '#111'}"></span>
                    <span style="background:${vars.accent || '#48f'}"></span>
                    <span style="background:${vars.green  || '#4a4'}"></span>
                    <span style="background:${vars.red    || '#a44'}"></span>
                </span>
                <span class="nb-theme-card-name">${_esc(t.name)}</span>
                <button class="nb-theme-card-edit" title="Edit theme">✏</button>`;
            card.addEventListener('click', async () => {
                await NbTheme.apply(t.slug, NbTheme.getMode());
                await NbTheme.saveToNotebook(t.slug, notebook);
                _closeThemePopup();
            });
            card.querySelector('.nb-theme-card-edit').addEventListener('click', async e => {
                e.stopPropagation();
                _closeThemePopup();
                const data = await NbTheme.getTheme(t.slug);
                _openThemeEditor(t.slug, data);
            });
            cards.appendChild(card);
        }

        popup.querySelector('.nb-theme-new-btn').addEventListener('click', () => {
            _closeThemePopup();
            _openThemeEditor(null, null);
        });

        popup.querySelector('.nb-theme-mode-toggle').addEventListener('click', async () => {
            await NbTheme.toggleMode();
            _closeThemePopup();
            _openThemePicker(btn, notebook);
        });

        popup.addEventListener('click', e => e.stopPropagation());

        document.body.appendChild(popup);
        _themePopup = popup;
        const r = btn.getBoundingClientRect();
        popup.style.top  = `${r.bottom + 6}px`;
        popup.style.left = `${Math.min(r.left, window.innerWidth - popup.offsetWidth - 8)}px`;
    }

    document.addEventListener('click', e => {
        const btn = e.target.closest('.nb-specialty-theme-btn');
        if (btn) {
            e.stopPropagation();
            if (_themePopup) { _closeThemePopup(); return; }
            _openThemePicker(btn, btn.dataset.notebook);
            return;
        }
        if (_themePopup && !_themePopup.contains(e.target)) _closeThemePopup();
    });

    document.addEventListener('nb-theme-changed', () => {
        if (!_themePopup) return;
        _themePopup.querySelectorAll('.nb-theme-card').forEach(c => {
            c.classList.toggle('nb-theme-card-active', c.dataset.slug === NbTheme.getSlug());
        });
    });

    // ── Theme editor ──────────────────────────────────────────────────────────
    const _TEE_VARS = ['bg','bg2','bg3','border','text','text-muted','text-dim',
                       'accent','accent-dim','green','red','yellow','alert','alert-bg','alert-border'];

    let _teeOverlay = null;
    let _teeSlug    = null;
    let _teeIsBI    = false;
    let _teeSnap    = null;
    let _teeMode    = 'dark';
    let _teeState   = null;
    let _teeName    = '';
    let _teeDesc    = '';

    function _teeModeDefaults(dark) {
        return dark
            ? { bg:'#1a1e24', bg2:'#22272e', bg3:'#2b3038', text:'#cdd9e5',
                accent:'#5b9bd5', green:'#57ab5a', red:'#e5534b', yellow:'#c69026',
                alert:'#c69026', borderColor:'#ffffff', borderAlpha:0.08 }
            : { bg:'#f5f5f5', bg2:'#ffffff', bg3:'#ebebeb', text:'#1a1a1a',
                accent:'#3d8fd4', green:'#2a9d5c', red:'#d94040', yellow:'#c47a00',
                alert:'#c47a00', borderColor:'#000000', borderAlpha:0.12 };
    }

    function _teeParseColor(color) {
        if (!color) return { hex: '#888888', alpha: 1 };
        if (color.startsWith('#')) return { hex: color.slice(0, 7), alpha: 1 };
        const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (m) {
            const hex = '#' + [m[1], m[2], m[3]].map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
            return { hex, alpha: m[4] !== undefined ? parseFloat(m[4]) : 1 };
        }
        return { hex: '#888888', alpha: 1 };
    }

    function _teeHexRgba(hex, a) {
        if (a >= 1) return hex;
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r},${g},${b},${a})`;
    }

    function _teeVarsFromData(vars) {
        const bc = _teeParseColor(vars.border);
        return {
            bg:          vars.bg          || '#1a1e24',
            bg2:         vars.bg2         || '#22272e',
            bg3:         vars.bg3         || '#2b3038',
            text:        vars.text        || '#cdd9e5',
            accent:      vars.accent      || '#5b9bd5',
            green:       vars.green       || '#57ab5a',
            red:         vars.red         || '#e5534b',
            yellow:      vars.yellow      || '#c69026',
            alert:       vars.alert       || vars.yellow || '#c69026',
            borderColor: bc.hex,
            borderAlpha: bc.alpha,
        };
    }

    function _teeCompute(s) {
        return {
            bg:             s.bg,
            bg2:            s.bg2,
            bg3:            s.bg3,
            border:         _teeHexRgba(s.borderColor, s.borderAlpha),
            text:           s.text,
            'text-muted':   _teeHexRgba(s.text, 0.45),
            'text-dim':     _teeHexRgba(s.text, 0.25),
            accent:         s.accent,
            'accent-dim':   _teeHexRgba(s.accent, 0.18),
            green:          s.green,
            red:            s.red,
            yellow:         s.yellow,
            alert:          s.alert,
            'alert-bg':     _teeHexRgba(s.alert, 0.12),
            'alert-border': _teeHexRgba(s.alert, 0.38),
        };
    }

    function _teeRefresh() {
        if (!_teeOverlay) return;
        const vars = _teeCompute(_teeState[_teeMode]);
        _teeOverlay.querySelectorAll('[data-d]').forEach(el => {
            el.style.background = vars[el.dataset.d] || 'transparent';
        });
        const sw = _teeOverlay.querySelector('.nb-tee-preview-swatches');
        if (sw) {
            [vars.bg, vars.bg2, vars.accent, vars.green, vars.red].forEach((c, i) => {
                if (sw.children[i]) sw.children[i].style.background = c;
            });
        }
        NbTheme.applyRaw(vars);
    }

    function _teeLoadInputs() {
        if (!_teeOverlay) return;
        const s = _teeState[_teeMode];
        _teeOverlay.querySelectorAll('[data-k]').forEach(inp => {
            const k = inp.dataset.k;
            if (inp.type === 'range') inp.value = s[k] ?? 1;
            else inp.value = s[k] || '#888888';
        });
        _teeRefresh();
    }

    async function _openThemeEditor(slug, themeData) {
        if (_teeOverlay) _closeThemeEditor(true);
        _teeSlug = slug;
        _teeIsBI = slug === 'default';
        _teeMode = NbTheme.getMode();

        const style = getComputedStyle(document.documentElement);
        _teeSnap = Object.fromEntries(_TEE_VARS.map(k => [k, style.getPropertyValue(`--${k}`).trim()]));

        if (themeData && slug) {
            _teeState = {
                dark:  _teeVarsFromData(themeData.dark  || {}),
                light: _teeVarsFromData(themeData.light || {}),
            };
            _teeName = themeData.name || slug;
            _teeDesc = themeData.desc || '';
        } else {
            _teeState = { dark: _teeModeDefaults(true), light: _teeModeDefaults(false) };
            _teeName  = '';
            _teeDesc  = '';
        }

        const overlay = document.createElement('div');
        overlay.className = 'nb-tee-overlay';
        overlay.innerHTML = `
<div class="nb-tee-modal">
  <div class="nb-tee-header">
    <input type="text" class="nb-tee-name" placeholder="Theme name" value="${_esc(_teeName)}"/>
    <button class="nb-tee-close" title="Close">×</button>
  </div>
  <div class="nb-tee-tabs">
    <button class="nb-tee-tab${_teeMode==='dark'?' active':''}" data-m="dark">☾ Dark</button>
    <button class="nb-tee-tab${_teeMode==='light'?' active':''}" data-m="light">☀ Light</button>
    <div class="nb-tee-preview-wrap">
      <span class="nb-tee-preview-label">Preview</span>
      <span class="nb-tee-preview-swatches"><span></span><span></span><span></span><span></span><span></span></span>
    </div>
  </div>
  <div class="nb-tee-grid">
    <div class="nb-tee-section">Surfaces</div>
    <label class="nb-tee-item">bg<input type="color" data-k="bg"/></label>
    <label class="nb-tee-item">bg2<input type="color" data-k="bg2"/></label>
    <label class="nb-tee-item">bg3<input type="color" data-k="bg3"/></label>
    <div class="nb-tee-section">Text</div>
    <label class="nb-tee-item">text<input type="color" data-k="text"/></label>
    <div class="nb-tee-item nb-tee-derived"><span class="nb-tee-dswatch" data-d="text-muted"></span>muted</div>
    <div class="nb-tee-item nb-tee-derived"><span class="nb-tee-dswatch" data-d="text-dim"></span>dim</div>
    <div class="nb-tee-section">Chrome</div>
    <div class="nb-tee-border-item">border
      <input type="color" data-k="borderColor"/>
      <input type="range" min="0" max="1" step="0.01" data-k="borderAlpha" class="nb-tee-alpha" title="Opacity"/>
    </div>
    <label class="nb-tee-item">accent<input type="color" data-k="accent"/></label>
    <div class="nb-tee-item nb-tee-derived"><span class="nb-tee-dswatch" data-d="accent-dim"></span>dim</div>
    <div class="nb-tee-section">Semantic</div>
    <label class="nb-tee-item">green<input type="color" data-k="green"/></label>
    <label class="nb-tee-item">red<input type="color" data-k="red"/></label>
    <label class="nb-tee-item">yellow<input type="color" data-k="yellow"/></label>
    <div class="nb-tee-section">Alert</div>
    <label class="nb-tee-item">alert<input type="color" data-k="alert"/></label>
    <div class="nb-tee-item nb-tee-derived"><span class="nb-tee-dswatch" data-d="alert-bg"></span>bg</div>
    <div class="nb-tee-item nb-tee-derived"><span class="nb-tee-dswatch" data-d="alert-border"></span>border</div>
  </div>
  <textarea class="nb-tee-desc" placeholder="Description (optional)">${_esc(_teeDesc)}</textarea>
  <div class="nb-tee-footer">
    <button class="nb-tee-save">Save theme</button>
    <button class="nb-tee-cancel">Cancel</button>
    ${!_teeIsBI && slug ? '<button class="nb-tee-delete">Delete</button>' : ''}
  </div>
</div>`;

        overlay.querySelector('.nb-tee-close').addEventListener('click',  () => _closeThemeEditor(true));
        overlay.querySelector('.nb-tee-cancel').addEventListener('click', () => _closeThemeEditor(true));
        overlay.querySelector('.nb-tee-name').addEventListener('input', e => { _teeName = e.target.value; });
        overlay.querySelector('.nb-tee-desc').addEventListener('input', e => { _teeDesc = e.target.value; });

        overlay.querySelectorAll('.nb-tee-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                _teeMode = btn.dataset.m;
                overlay.querySelectorAll('.nb-tee-tab').forEach(b => b.classList.toggle('active', b === btn));
                _teeLoadInputs();
            });
        });

        overlay.querySelectorAll('[data-k]').forEach(inp => {
            inp.addEventListener('input', () => {
                const k = inp.dataset.k;
                _teeState[_teeMode][k] = inp.type === 'range' ? parseFloat(inp.value) : inp.value;
                _teeRefresh();
            });
        });

        overlay.querySelector('.nb-tee-save').addEventListener('click', _teeSave);
        overlay.querySelector('.nb-tee-delete')?.addEventListener('click', _teeDelete);

        document.body.appendChild(overlay);
        _teeOverlay = overlay;
        _teeLoadInputs();
    }

    function _closeThemeEditor(restoreVars) {
        if (!_teeOverlay) return;
        if (restoreVars && _teeSnap) {
            const root = document.documentElement;
            for (const [k, v] of Object.entries(_teeSnap))
                root.style.setProperty(`--${k}`, v);
        }
        _teeOverlay.remove();
        _teeOverlay = null;
    }

    async function _teeSave() {
        const name = _teeName.trim() || 'Untitled';
        const slug = _teeSlug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'theme';
        const dark  = _teeCompute(_teeState.dark);
        const light = _teeCompute(_teeState.light);
        try {
            const r = await fetch('/api/theme-save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ slug, name, desc: _teeDesc.trim(), dark, light }),
            });
            if (!r.ok) throw new Error(await r.text());
            NbTheme.clearCache();
            await NbTheme.apply(slug, _teeMode);
            _closeThemeEditor(false);
        } catch (err) {
            alert('Could not save theme: ' + err.message);
        }
    }

    async function _teeDelete() {
        if (!_teeSlug || _teeIsBI) return;
        if (!confirm(`Delete theme "${_teeName}"?`)) return;
        try {
            const r = await fetch(`/api/theme-delete/${encodeURIComponent(_teeSlug)}`, { method: 'DELETE' });
            if (!r.ok) throw new Error(await r.text());
            NbTheme.clearCache();
            await NbTheme.apply('default', _teeMode);
            _closeThemeEditor(true);
        } catch (err) {
            alert('Could not delete theme: ' + err.message);
        }
    }

    // Public API — plugins call these after this script loads
    window.NbSpecialty = {
        cfg: _cfg,
        register(type, config) { _cfg[type] = config; },
        getActions: () => '',   // overridable: fn(note) => HTML string
    };

})();

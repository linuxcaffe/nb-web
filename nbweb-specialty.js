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
            return `<div class="nb-project-marker" data-marker="${markerType}">${content}</div>`;
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
        const parts = [opt('current', 'Current phase'), opt('all', 'All time')];
        if (markers.length) {
            parts.push('<option disabled>──────────</option>');
            for (let i = markers.length - 1; i >= 0; i--)
                parts.push(opt(markers[i].full, `Since ${markers[i].full}`));
        }
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

        let dropdownHtml = '';
        if (sourceFile) {
            const markers = await _fetchSourceMarkers(note);
            const sel = _timeframeState.get(note.selector || '') || 'current';
            dropdownHtml = _timeframeDropdown(markers, sel, note.selector || '');
        }

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
            ${pairLink}${sourceWarn}${dropdownHtml}${pillsHtml}${extraActions}${helpBtn}
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
        label:        'NbWeb Specialty',
        description:  'Typed note headers for project, invoice, quote, budget and related FM types.',
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

    // Theme picker popup
    let _themePopup = null;

    function _closeThemePopup() {
        _themePopup?.remove();
        _themePopup = null;
    }

    async function _openThemePicker(btn, notebook) {
        _closeThemePopup();
        const themes = await NbTheme.listThemes();
        const current = NbTheme.getSlug();
        const mode    = NbTheme.getMode();

        const popup = document.createElement('div');
        popup.className = 'nb-theme-popup';
        popup.innerHTML = `
            <div class="nb-theme-popup-toolbar">
                <span class="nb-theme-popup-title">Theme</span>
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
                <span class="nb-theme-card-name">${_esc(t.name)}</span>`;
            card.addEventListener('click', async () => {
                await NbTheme.apply(t.slug, NbTheme.getMode());
                await NbTheme.saveToNotebook(t.slug, notebook);
                _closeThemePopup();
            });
            cards.appendChild(card);
        }

        popup.querySelector('.nb-theme-mode-toggle').addEventListener('click', async () => {
            await NbTheme.toggleMode();
            _closeThemePopup();
            _openThemePicker(btn, notebook);
        });

        // Stop ALL clicks inside the popup from reaching document-level handlers
        popup.addEventListener('click', e => e.stopPropagation());

        document.body.appendChild(popup);
        _themePopup = popup;   // set before positioning so any stray event finds it set
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
        // Refresh active-card highlight if popup is open
        if (!_themePopup) return;
        _themePopup.querySelectorAll('.nb-theme-card').forEach(c => {
            c.classList.toggle('nb-theme-card-active', c.dataset.slug === NbTheme.getSlug());
        });
    });

    // Public API — plugins call these after this script loads
    window.NbSpecialty = {
        cfg: _cfg,
        register(type, config) { _cfg[type] = config; },
        getActions: () => '',   // overridable: fn(note) => HTML string
    };

})();

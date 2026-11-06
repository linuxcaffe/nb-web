// nb-web tw-add.js — NbTwAdd: add a Taskwarrior task with tw-web's own Add dialog, then make
// its note (tw-nb-interop M6).
//
// nb-web doesn't copy tw-web's dialog: it frames tw-web's /embed-add, which adds the task with
// tw-web's own endpoint (hooks, recurrence, parent links), then posts the new uuid back here.
// nb-web then calls /api/tw/note, which runs `nb tw note <uuid>`, and opens the note.
//
// Needs: the `tw_web_url` setting (tw-web's address as the browser sees it, maybe with a
// proxy path such as /tw), and tw-web's `nb` annotation launcher pointing at this nb-web's
// origin (that's what lets tw-web be framed here). Either missing shows a message in the overlay saying which, never a silent nothing.
//
// Callers: the add bar's ☑ Task chip (nav.js), the task header's + and its Task #ID (edit).

const NbTwAdd = (() => {
    const READY_MS = 6000;   // tw-web must say it's ready within this, or we explain why not

    function _esc(s) {
        return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // open({description, project, tags, notebook}) → resolves with
    // {selector, created} once the note exists, or null if closed / it failed.
    // open({edit: uuid}) opens tw-web's Edit dialog on that task instead (/embed-edit) and
    // resolves with {saved: true, uuid} after a save; no note is made.
    async function open(opts = {}) {
        // Ask first (M7 a): tw-web down is said at once, not after the 6 s ready wait
        const health = await NbWeb.twHealth({ fresh: true });
        const { twWeb } = health;
        const url = twWeb.url;

        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'nb-tw-add-overlay';
            overlay.tabIndex = -1;
            document.body.appendChild(overlay);
            overlay.focus();   // the modal takes focus (invariant 60); the frame does once ready

            let done = false, readyTimer = null;
            const finish = result => {
                if (done) return;
                done = true;
                clearTimeout(readyTimer);
                window.removeEventListener('message', onMessage);
                overlay.remove();
                resolve(result);
            };

            // A message in place of the dialog: the overlay's own card, Close focused (inv. 60)
            const explain = html => {
                overlay.innerHTML = `<div class="nb-tw-add-card" role="alertdialog">${html}
                    <div class="nb-tw-add-btns">
                      <button type="button" class="nb-tool-btn nb-tw-add-close">Close</button>
                    </div></div>`;
                const btn = overlay.querySelector('.nb-tw-add-close');
                btn.addEventListener('click', () => finish(null));
                btn.focus();
            };

            overlay.addEventListener('keydown', e => {
                // ui-chrome's global Escape would click any visible Cancel (invariant 60)
                if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); finish(null); }
            });
            overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });

            // tw-web not up (M7 c): nb-web's own form, saying it's the fallback and why
            if (twWeb.state !== 'up') {
                ownForm(overlay, opts, health, explain, finish);
                return;
            }

            const q = new URLSearchParams();
            if (opts.edit) q.set('uuid', opts.edit);
            else for (const k of ['description', 'project', 'tags']) if (opts[k]) q.set(k, opts[k]);
            const frame = document.createElement('iframe');
            frame.className = 'nb-tw-add-frame';
            frame.title = opts.edit ? 'Edit task (tw-web)' : 'Add task (tw-web)';
            frame.src = `${url}/${opts.edit ? 'embed-edit' : 'embed-add'}${q.toString() ? '?' + q : ''}`;
            overlay.appendChild(frame);

            // tw_web_url may carry a path (tw-web behind a proxy at /tw on this origin, M7):
            // a message's origin is only scheme://host[:port]
            const twOrigin = new URL(url, location.href).origin;
            async function onMessage(e) {
                if (e.origin !== twOrigin || e.source !== frame.contentWindow) return;
                const m = e.data || {};
                if (m.type === 'tw-add-ready') {
                    clearTimeout(readyTimer);
                    frame.focus();
                } else if (m.type === 'tw-add-closed') {
                    finish(null);
                } else if (m.type === 'tw-task-saved') {
                    finish({ saved: true, uuid: m.uuid });
                } else if (m.type === 'tw-edit-failed') {
                    clearTimeout(readyTimer);
                    window.removeEventListener('message', onMessage);
                    explain(`<h4>Edit task</h4><p>tw-web couldn't open task
                        <code>${_esc(String(m.uuid || '').slice(0, 8))}</code>: it isn't in this
                        Taskwarrior (purged, or not synced here yet).</p>`);
                } else if (m.type === 'tw-task-added' && typeof m.uuid === 'string' && opts.note === false) {
                    finish({ added: true, uuid: m.uuid });           // a plain task: no note (the tw block's +)
                } else if (m.type === 'tw-task-added' && typeof m.uuid === 'string') {
                    window.removeEventListener('message', onMessage);
                    frame.remove();
                    explain(`<h4>Add task</h4><p><span class="nb-spin"></span> Making the note for
                        “${_esc(m.description)}”…</p>`);
                    try {
                        const r = await fetch('/api/tw/note', {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ uuid: m.uuid, notebook: opts.notebook || '' }),
                        });
                        const d = await r.json().catch(() => ({}));
                        if (r.ok && d.selector) { finish(d); return; }
                        explain(`<h4>Task added, note not made</h4>
                            <p>“${_esc(m.description)}” is in Taskwarrior, but its note failed:
                            ${_esc(d.error || r.status)}.</p>
                            <p>Make it later with <code>nb tw note ${_esc(m.uuid.slice(0, 8))}</code>.</p>`);
                    } catch (err) {
                        explain(`<h4>Task added, note not made</h4><p>${_esc(err.message)}</p>`);
                    }
                }
            }
            window.addEventListener('message', onMessage);

            // No "ready" in time: tw-web is down, or it refused to be framed here (its `nb`
            // launcher names a different nb-web origin), and the browser won't say which.
            readyTimer = setTimeout(() => {
                if (done) return;
                window.removeEventListener('message', onMessage);
                const title = opts.edit ? 'Edit task' : 'Add task';
                if (twWeb.state === 'up') {
                    // It answered the health probe, so it's running: it refused to be framed here
                    // (its nb launcher names another nb-web origin, e.g. the bundle's :5080 while
                    // this page is :5001). Say that, and carry on with nb-web's own form (djp).
                    explain(`<h4>${title}</h4><p>tw-web is running but won't show its dialog here: it
                        lets only the nb-web its <code>nb</code> annotation launcher names frame it,
                        and this page is <code>${_esc(location.origin)}</code>.</p>
                        <p>Open nb-web at that address (with the bundle, its own one), or use
                        nb-web's form.</p>
                        <p><button type="button" class="nb-tool-btn nb-btn-primary nb-tw-add-own">Use nb-web's form</button></p>`);
                    overlay.querySelector('.nb-tw-add-own')?.addEventListener('click',
                        () => ownForm(overlay, opts, health, explain, finish));
                    return;
                }
                explain(`<h4>${title}</h4><p>tw-web didn't answer at <code>${_esc(url)}</code>.</p>
                    <ul><li>Is tw-web running? <a href="${_esc(url)}" target="tw-web">Open it</a>.</li>
                    <li>tw-web only lets the nb-web its <code>nb</code> annotation launcher points
                    at frame it; this page is <code>${_esc(location.origin)}</code>.</li></ul>`);
            }, READY_MS);
        });
    }

    // nb-web's own Add/Edit form (tw-nb-interop M7 c): the tw block's fields, as a modal. Add goes
    // through `nb tw add` (task and note in one step, hooks on); Edit through /api/tw/note-edit,
    // keyed by the note (invariant 83). opts.note === false adds a plain task (the tw block's +).
    function _localDate(stamp) {    // 20261201T050000Z → this machine's date (invariant 75)
        const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp || '');
        return m ? NbWeb.isoDate(new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]))) : '';
    }

    async function ownForm(overlay, opts, health, explain, finish) {
        const editing = !!opts.edit;
        const title = editing ? 'Edit task' : 'Add task';
        const why = health.twWeb.state === 'unset' ? NbWeb.TW_MISSING.unset : NbWeb.TW_MISSING.down;
        if (!health.task.ok) {
            explain(`<h4>${title}</h4><p>${_esc(why)}, and ${_esc(health.task.error || NbWeb.TW_MISSING.task)},
                so the task can't be ${editing ? 'changed' : 'added'} from here.</p>`);
            return;
        }
        if (!editing && opts.note !== false && !health.plugin.ok) {
            // What needs an nb-plugin installs it, here on a click (djp 2026-11-05); admin and up,
            // as the endpoint (it fetches code from the network)
            const admin = window.NbAuth && NbAuth.is('admin');
            explain(`<h4>${title}</h4><p>${_esc(why)}, and ${_esc(NbWeb.TW_MISSING.plugin)}, so the task's
                note can't be made here.</p>${admin
                    ? `<p><button type="button" class="nb-tool-btn nb-tw-install-plugin">Install it</button>
                       <span class="nb-tw-install-why"></span></p>`
                    : '<p>An admin can install it from here.</p>'}`);
            const btn = overlay.querySelector('.nb-tw-install-plugin');
            btn?.addEventListener('click', async () => {
                const say = overlay.querySelector('.nb-tw-install-why');
                btn.disabled = true;
                say.innerHTML = '<span class="nb-spin"></span> Installing…';
                const d = await fetch('/api/tw/install-plugin', { method: 'POST' })
                    .then(r => r.json()).catch(e => ({ ok: false, error: String(e) }));
                if (d.ok) {
                    ownForm(overlay, opts, { ...health, plugin: { ok: true } }, explain, finish);
                } else {
                    btn.disabled = false;
                    say.textContent = `Not installed: ${d.error || 'unknown error'}`;
                }
            });
            btn?.focus();
            return;
        }
        if (editing && !opts.selector) {
            explain(`<h4>${title}</h4><p>${_esc(why)}, and nb-web edits a task only from its note.</p>`);
            return;
        }
        let cur = { description: opts.description || '', project: opts.project || '', due: '',
                    priority: '', tags: opts.tags || '' };
        if (editing) {
            const r = await fetch('/api/tw/note-tasks?selector=' + encodeURIComponent(opts.selector)).catch(() => null);
            const d = r ? await r.json().catch(() => ({})) : {};
            const t = (d.tasks || []).find(x => x.uuid === opts.edit);
            if (!t) {
                explain(`<h4>${title}</h4><p>${_esc(d.error || "This note's task isn't in this Taskwarrior")}.</p>`);
                return;
            }
            cur = { description: t.description || '', project: t.project || '', due: _localDate(t.due),
                    priority: t.priority || '', tags: (t.tags || []).join(', ') };
        }
        const card = document.createElement('div');
        card.className = 'nb-tw-add-card nb-tw-own';
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'true');
        card.setAttribute('aria-label', title);
        card.innerHTML = `<h4>${title}</h4>
            <p class="nb-tw-own-why">${_esc(why)}: using nb-web's form.</p>
            <input type="text" class="nb-tw-inp nb-tw-f-desc" placeholder="Description" autocomplete="off">
            <div class="nb-tw-addform-row">
              <input type="text" class="nb-tw-inp nb-tw-f-project" placeholder="project">
              <input type="text" class="nb-tw-inp nb-tw-f-due" placeholder="due: tomorrow, 2026-12-01">
              <input type="date" class="nb-tw-datepick-hidden" tabindex="-1">
              <button type="button" class="nb-tw-btn nb-tw-f-pick" title="Pick a date">📅</button>
              <input type="text" class="nb-tw-inp nb-tw-f-priority" placeholder="priority">
            </div>
            <input type="text" class="nb-tw-inp nb-tw-f-tags" placeholder="tag1, tag2">
            <p class="nb-tw-form-status" aria-live="polite"></p>`;
        const f = name => card.querySelector(`.nb-tw-f-${name}`);
        f('desc').value = cur.description; f('project').value = cur.project; f('due').value = cur.due;
        f('priority').value = cur.priority; f('tags').value = cur.tags;
        const picker = card.querySelector('.nb-tw-datepick-hidden');
        f('pick').addEventListener('click', () => picker.showPicker ? picker.showPicker() : picker.click());
        picker.addEventListener('change', () => { f('due').value = picker.value; NbWeb.formDirty(card); });
        const status = card.querySelector('.nb-tw-form-status');

        const save = async () => {
            const body = { description: f('desc').value.trim(), project: f('project').value.trim(),
                           due: f('due').value.trim(), priority: f('priority').value.trim(),
                           tags: f('tags').value.trim() };
            if (!body.description) { f('desc').focus(); return; }
            status.textContent = 'Saving…';
            let url, payload;
            if (editing) { url = '/api/tw/note-edit'; payload = { ...body, selector: opts.selector, uuid: opts.edit }; }
            else if (opts.note === false) {
                url = '/api/task-add';
                payload = { description: body.description, project: body.project, date_field: 'due',
                            date_value: body.due, priority: body.priority, tags: body.tags };
            } else { url = '/api/tw/note-add'; payload = { ...body, notebook: opts.notebook || '' }; }
            try {
                const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                             body: JSON.stringify(payload) });
                const d = await r.json().catch(() => ({}));
                if (!r.ok || d.error || d.success === false) {
                    status.textContent = '✗ ' + (d.error || d.stderr || r.status);
                    return;
                }
                NbWeb.formDirty(card, false);
                finish(editing ? { saved: true, uuid: opts.edit }
                       : opts.note === false ? { added: true } : d);
            } catch (err) { status.textContent = '✗ ' + err.message; }
        };
        const { row, saveBtn, cancelBtn } = NbWeb.formActions({
            saveLabel: editing ? 'Save' : 'Add', onSave: save, onCancel: () => finish(null) });
        card.appendChild(row);
        overlay.innerHTML = '';
        overlay.appendChild(card);
        NbWeb.formKeys(card, saveBtn, cancelBtn);
        NbWeb.formDirty(card, false);
        f('desc').focus();
        f('desc').addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); save(); }
        });
    }

    return { open };
})();

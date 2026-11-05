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
        const { twWeb } = await NbWeb.twHealth({ fresh: true });
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

            if (!url) {
                explain(`<h4>Add task</h4><p>nb-web doesn't know where tw-web is.</p>
                    <p>Set <code>tw_web_url</code> in <code>nb-settings.json</code> to tw-web's
                    address as this browser reaches it, e.g. <code>http://localhost:5000</code>.</p>`);
                return;
            }
            if (twWeb.state === 'down') {
                explain(`<h4>Add task</h4><p>${_esc(NbWeb.TW_MISSING.down)} at <code>${_esc(url)}</code>,
                    so it can't add the task from here.</p>
                    <p>Start it, then try again (<a href="${_esc(url)}" target="tw-web">open it</a>
                    to check).</p>`);
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
                explain(`<h4>Add task</h4><p>tw-web didn't answer at <code>${_esc(url)}</code>.</p>
                    <ul><li>Is tw-web running? <a href="${_esc(url)}" target="tw-web">Open it</a>.</li>
                    <li>tw-web only lets the nb-web its <code>nb</code> annotation launcher points
                    at frame it; this page is <code>${_esc(location.origin)}</code>.</li></ul>`);
            }, READY_MS);
        });
    }

    return { open };
})();

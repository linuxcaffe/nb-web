// nb-web terminal.js — extracted from main.js (tier-1 modularization, 2026-07-06), verbatim, no logic changes.
// 2026-07-12: added xterm-addon-fit (the terminal never resized to its
// container before this -- confirmed real, a fixed 80x24 grid regardless
// of how large the panel actually was) and finished the height-persistence
// feature that was already half-built (pty_height/nb-pty-height was read
// but never applied or made adjustable).

// ── Terminal + Settings-in-preview ────────────────────────────────
const NbTerminal = (() => {
    let _term = null;
    let _ws   = null;
    let _resizeObserver = null;
    // Drag-handle listeners are added fresh each open() (this panel's DOM
    // doesn't exist until then, unlike NbDragHandles' static handles) --
    // tracked here so close() can actually remove them instead of letting
    // them accumulate on `document` across repeated open/close cycles.
    let _dragMove = null, _dragEnd = null, _dragTouchMove = null, _dragTouchEnd = null;

    function _previewEl()  { return document.getElementById('nb-preview-content'); }
    function _toolbarEl()  { return document.getElementById('nb-preview-toolbar'); }

    function openSettings(anchor = '') {
        const el = _previewEl();
        if (!el) return;
        _toolbarEl().hidden = true;
        el.innerHTML = `<iframe src="/settings.html${anchor ? '#' + anchor : ''}" style="width:100%;height:100%;min-height:600px;border:none"></iframe>`;
    }

    async function run(cmd) {
        if (_ws?.readyState === WebSocket.OPEN) {
            _ws.send(cmd + '\r');
            return;
        }
        await open(cmd);
    }

    async function open(extraCmd = '') {
        const el = _previewEl();
        if (!el) return;

        // Toggle off if already showing terminal (only via plain open(), not run())
        if (!extraCmd && el.querySelector('#nb-pty-wrap')) {
            close();
            return;
        }

        _toolbarEl().hidden = true;

        // Lazy-load xterm + the fit addon (a separate small bundle -- xterm's
        // own core doesn't include it). Both are plain UMD scripts that
        // attach a global (window.Terminal, window.FitAddon) rather than
        // ES modules, matching how the rest of nb-web loads vendored libs.
        const loads = [];
        if (!window.Terminal) {
            loads.push(new Promise(r => { const s = document.createElement('script'); s.src = '/xterm.js'; s.onload = r; document.head.appendChild(s); }));
            loads.push(new Promise(r => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/xterm.css'; l.onload = r; document.head.appendChild(l); }));
        }
        if (!window.FitAddon) {
            loads.push(new Promise(r => { const s = document.createElement('script'); s.src = '/xterm-addon-fit.js'; s.onload = r; document.head.appendChild(s); }));
        }
        if (loads.length) await Promise.all(loads);

        // Load terminal settings
        let cfg = { pty_height: 320, pty_cwd: '', pty_init: '' };
        try { const r = await fetch('/api/nb-settings'); Object.assign(cfg, await r.json()); } catch {}
        const initH = parseInt(localStorage.getItem('nb-pty-height') || '0') || cfg.pty_height;

        el.innerHTML = `
            <div id="nb-pty-wrap" style="display:flex;flex-direction:column;height:${initH}px;background:#0a0a0a">
                <div id="nb-pty-titlebar" style="display:flex;align-items:center;justify-content:space-between;
                     padding:4px 12px;background:#111;color:#aaa;font-size:12px;flex-shrink:0">
                    <span>terminal</span>
                    <button id="nb-pty-close" style="background:none;border:none;color:#aaa;cursor:pointer;font-size:1.1em;padding:2px 6px">×</button>
                </div>
                <div id="nb-pty-container" style="flex:1;overflow:hidden;padding:4px 6px"></div>
                <div id="nb-pty-drag-handle" title="Drag to resize"></div>
            </div>`;

        document.getElementById('nb-pty-close').addEventListener('click', close);

        const wrap      = document.getElementById('nb-pty-wrap');
        const container = document.getElementById('nb-pty-container');
        const term = new window.Terminal({
            rows: 24, cols: 80,
            fontSize: 13,
            fontFamily: "'JetBrains Mono','Fira Code',monospace",
            theme: { background: '#0a0a0a', foreground: '#d4d4d8' },
            convertEol: true, scrollback: 500,
        });
        _term = term;
        const fitAddon = new window.FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        term.open(container);
        fitAddon.fit();
        term.focus();

        // Keep the character grid matched to the container's real pixel
        // size -- covers first layout, a browser window resize, and the
        // drag handle below, all through one mechanism rather than three.
        // fitAddon.fit() calls term.resize() internally, which the
        // existing term.onResize() handler already reports to the PTY, so
        // the actual shell's rows/cols (via TIOCSWINSZ) stay in sync too.
        _resizeObserver = new ResizeObserver(() => fitAddon.fit());
        _resizeObserver.observe(container);

        // Drag handle -- same row-resize/min-max-clamp/persist-on-release
        // pattern as NbDragHandles' annotation split handle, reimplemented
        // locally since this panel's DOM is built fresh each open() rather
        // than existing statically in index.html.
        const handle = document.getElementById('nb-pty-drag-handle');
        let dragging = false, startY = 0, startH = 0;

        function applyHeight(px) {
            const min = 120, max = Math.max(min, el.offsetHeight - 40);
            wrap.style.height = Math.max(min, Math.min(px, max)) + 'px';
        }
        function startDrag(cy) {
            dragging = true;
            startY = cy;
            startH = wrap.offsetHeight;
            handle.classList.add('dragging');
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'row-resize';
        }
        function moveDrag(cy) {
            if (dragging) applyHeight(startH + (cy - startY));
        }
        function endDrag() {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            localStorage.setItem('nb-pty-height', wrap.offsetHeight);
        }

        _dragMove = e => moveDrag(e.clientY);
        _dragEnd  = endDrag;
        _dragTouchMove = e => { if (dragging) { e.preventDefault(); moveDrag(e.touches[0].clientY); } };
        _dragTouchEnd  = endDrag;

        handle.addEventListener('mousedown', e => { e.preventDefault(); startDrag(e.clientY); });
        document.addEventListener('mousemove', _dragMove);
        document.addEventListener('mouseup', _dragEnd);
        handle.addEventListener('touchstart', e => { e.preventDefault(); startDrag(e.touches[0].clientY); }, { passive: false });
        document.addEventListener('touchmove', _dragTouchMove, { passive: false });
        document.addEventListener('touchend', _dragTouchEnd);

        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${proto}://${location.host}/ws/pty`);
        _ws = ws;

        ws.onopen = () => {
            const cols = term.cols, rows = term.rows;
            // Codeblock launches bypass the init script — just run the app directly.
            const init = extraCmd || cfg.pty_init || '';
            ws.send(JSON.stringify({ cwd: cfg.pty_cwd || '', init, cols, rows }));
        };
        ws.onmessage = e => term.write(e.data);
        ws.onclose   = ()  => { term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n'); setTimeout(close, 1500); };
        ws.onerror   = ()  => term.write('\r\n\x1b[31m[connection error]\x1b[0m\r\n');

        term.onData(data => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
        term.onResize(({ cols, rows }) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(`\x00resize:${cols},${rows}`);
        });
    }

    function close() {
        if (_resizeObserver) { _resizeObserver.disconnect(); _resizeObserver = null; }
        if (_dragMove)      { document.removeEventListener('mousemove', _dragMove);      _dragMove = null; }
        if (_dragEnd)       { document.removeEventListener('mouseup',   _dragEnd);       _dragEnd = null; }
        if (_dragTouchMove) { document.removeEventListener('touchmove', _dragTouchMove); _dragTouchMove = null; }
        if (_dragTouchEnd)  { document.removeEventListener('touchend',  _dragTouchEnd);  _dragTouchEnd = null; }
        if (_ws)   { _ws.close();   _ws   = null; }
        if (_term) { _term.dispose(); _term = null; }
        const el = _previewEl();
        if (el) el.innerHTML = '';
        _toolbarEl().hidden = false;
        NbNav.reexecute();
        const sel = NbMain.activeSelector();
        if (sel) NbMain.openNote(sel, false);
    }

    return { open, close, run, openSettings };
})();

// nb-web terminal.js — extracted from main.js (tier-1 modularization, 2026-07-06), verbatim, no logic changes.

// ── Terminal + Settings-in-preview ────────────────────────────────
const NbTerminal = (() => {
    let _term = null;
    let _ws   = null;

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

        // Lazy-load xterm
        if (!window.Terminal) {
            await Promise.all([
                new Promise(r => { const s = document.createElement('script'); s.src = '/xterm.js'; s.onload = r; document.head.appendChild(s); }),
                new Promise(r => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/xterm.css'; l.onload = r; document.head.appendChild(l); }),
            ]);
        }

        // Load terminal settings
        let cfg = { pty_height: 320, pty_cwd: '', pty_init: '' };
        try { const r = await fetch('/api/nb-settings'); Object.assign(cfg, await r.json()); } catch {}
        const initH = parseInt(localStorage.getItem('nb-pty-height') || '0') || cfg.pty_height;

        el.innerHTML = `
            <div id="nb-pty-wrap" style="display:flex;flex-direction:column;height:100%;background:#0a0a0a">
                <div id="nb-pty-titlebar" style="display:flex;align-items:center;justify-content:space-between;
                     padding:4px 12px;background:#111;color:#aaa;font-size:12px;flex-shrink:0">
                    <span>terminal</span>
                    <button id="nb-pty-close" style="background:none;border:none;color:#aaa;cursor:pointer;font-size:1.1em;padding:2px 6px">×</button>
                </div>
                <div id="nb-pty-container" style="flex:1;overflow:hidden;padding:4px 6px"></div>
            </div>`;

        document.getElementById('nb-pty-close').addEventListener('click', close);

        const container = document.getElementById('nb-pty-container');
        const term = new window.Terminal({
            rows: 24, cols: 80,
            fontSize: 13,
            fontFamily: "'JetBrains Mono','Fira Code',monospace",
            theme: { background: '#0a0a0a', foreground: '#d4d4d8' },
            convertEol: true, scrollback: 500,
        });
        _term = term;
        term.open(container);
        term.focus();

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


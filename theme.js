// nb-web theme engine
// Themes live in ~/.nb/.themes/*.md — FM defines dark:/light: color var maps.
// NbTheme is global; called from main.js and nbweb-specialty.js.

const NbTheme = (() => {
    let _slug = localStorage.getItem('nb-theme-slug') || 'default';
    let _mode = localStorage.getItem('nb-theme-mode') || 'dark';
    let _cache = {};     // slug → { name, dark:{}, light:{} }
    let _allThemes = null;

    function _applyVars(vars) {
        const root = document.documentElement;
        for (const [k, v] of Object.entries(vars || {}))
            root.style.setProperty(`--${k}`, v);
        // Cache rendered vars for no-flash init on next load
        localStorage.setItem('nb-theme-vars', JSON.stringify(vars || {}));
    }

    async function _fetchOne(slug) {
        if (_cache[slug]) return _cache[slug];
        try {
            const r = await fetch(`/api/theme/${encodeURIComponent(slug)}`);
            if (!r.ok) return null;
            const d = await r.json();
            _cache[slug] = d;
            return d;
        } catch { return null; }
    }

    async function apply(slug, mode) {
        slug = slug || _slug;
        mode = mode || _mode;
        const theme = await _fetchOne(slug);
        if (!theme) return;
        _applyVars(theme[mode] || {});
        _slug = slug;
        _mode = mode;
        localStorage.setItem('nb-theme-slug', slug);
        localStorage.setItem('nb-theme-mode', mode);
        // Native controls (select popups, scrollbars, date pickers) don't read our
        // --vars -- they follow color-scheme directly. _applyVars never touches it,
        // so without this it stays stuck at styles.css :root's hardcoded 'dark'
        // forever, regardless of the mode actually applied here.
        document.documentElement.style.colorScheme = mode;
        // Prism stylesheet
        const prism = document.getElementById('nb-prism-theme');
        if (prism) prism.href = mode === 'light' ? 'vendor/prism-light.min.css' : 'vendor/prism-tomorrow.min.css';
        // Mode toggle button label
        const btn = document.getElementById('nb-mode-toggle');
        if (btn) btn.textContent = mode === 'dark' ? '☀' : '☾';
        // Remove CSS-fallback data-theme attr (JS vars now drive everything)
        document.documentElement.removeAttribute('data-theme');
        // Notify specialty picker if open
        document.dispatchEvent(new CustomEvent('nb-theme-changed', { detail: { slug, mode } }));
    }

    function toggleMode() {
        apply(_slug, _mode === 'dark' ? 'light' : 'dark');
    }

    async function listThemes() {
        if (_allThemes) return _allThemes;
        try {
            const r = await fetch('/api/themes');
            _allThemes = r.ok ? await r.json() : [];
        } catch { _allThemes = []; }
        return _allThemes;
    }

    async function saveToNotebook(slug, notebook) {
        if (!notebook) return;
        await fetch('/api/theme-set-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notebook, key: 'theme', value: slug }),
        });
    }

    function applyRaw(vars) {
        _applyVars(vars);
    }

    async function getTheme(slug) {
        return await _fetchOne(slug);
    }

    function clearCache() {
        _cache = {};
        _allThemes = null;
    }

    function getSlug() { return _slug; }
    function getMode() { return _mode; }

    async function init() {
        await apply(_slug, _mode);
    }

    return { apply, applyRaw, getTheme, clearCache, toggleMode, listThemes, saveToNotebook, getSlug, getMode, init };
})();

// Top-level `const` does not become a `window` property, so a same-origin child
// frame (settings.html, loaded via terminal.js's iframe) reaching for
// window.parent.NbTheme would otherwise always see undefined. Explicit assignment
// needed for any cross-frame caller.
window.NbTheme = NbTheme;

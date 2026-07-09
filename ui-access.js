// nb-web ui-access.js — client-side UI access gating (tier-4a, 2026-07-08).
// NbUiAccess: NbAuth.is() by named UI group, mirroring the codeblock plugin's
// _cbAccess/_cbCan/_cbGateAttrs pattern (nbweb-codeblocks.js) for non-codeblock
// UI actions. Zero dependencies — loads right after nav.js.
//
// Config source: ui_access key in nb-settings.json (schema + admin UI are
// tier-4b, not yet built — _uiAccess is {} until then, so every can() call is
// permissive by default, same fail-open behaviour as _cbAccess/_cbCan today).
// Per-element override: data-ui-<mode>="<level>" (e.g. data-ui-use="office").
//
// This pass wires can() into tier-4a's own actions only (pin, delete, edit,
// template groups). It does NOT gate the kernel's Edit/Delete buttons — that's
// tier-4b, deliberately deferred (see claude:mainjs-split-design.md § Tier 4).

const NbUiAccess = (() => {

    let _uiAccess = {};
    fetch('/api/nb-settings').then(r => r.json()).then(s => { _uiAccess = s.ui_access || {}; }).catch(() => {});

    function _attrName(mode) {
        return 'ui' + mode.charAt(0).toUpperCase() + mode.slice(1);
    }

    function _level(el, group, mode) {
        const attr = el?.dataset?.[_attrName(mode)];
        if (attr) return attr;
        return (_uiAccess[group] || {})[mode] || null;
    }

    function can(el, group, mode = 'use') {
        const level = _level(el, group, mode);
        if (!level) return true;
        return window.NbAuth?.is(level) ?? true;
    }

    return { can };
})();

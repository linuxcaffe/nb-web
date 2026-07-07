// nb-web drag-handles.js — extracted from main.js (tier-2a modularization, 2026-07-06).
// NbDragHandles: list-pane resize handle + annotation-split resize handle.
// Pure DOM/localStorage widgets, zero coupling to NbMain state (confirmed by inventory).

const NbDragHandles = (() => {
    // ── Annotation split drag handle ───────────────────────────────

    function initAnnDragHandle() {
        const handle  = document.getElementById('nb-ann-drag-handle');
        const content = document.getElementById('nb-preview-content');
        const pane    = document.getElementById('nb-preview-pane');
        const KEY     = 'nb-ann-split-h';
        if (!handle || !content) return;

        let dragging = false, startY = 0, startH = 0;

        function applyHeight(px) {
            const min = 80;
            const max = pane.offsetHeight - handle.offsetHeight - 120;
            content.style.flexBasis = Math.max(min, Math.min(px, max)) + 'px';
        }

        function startDrag(cy) {
            dragging = true;
            startY = cy;
            startH = content.offsetHeight;
            handle.classList.add('dragging');
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'row-resize';
        }

        function moveDrag(cy) {
            if (!dragging) return;
            applyHeight(startH + (cy - startY));
        }

        function endDrag() {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            localStorage.setItem(KEY, content.offsetHeight);
        }

        handle.addEventListener('mousedown',  e => { e.preventDefault(); startDrag(e.clientY); });
        document.addEventListener('mousemove', e => moveDrag(e.clientY));
        document.addEventListener('mouseup',   endDrag);
        handle.addEventListener('touchstart',  e => { e.preventDefault(); startDrag(e.touches[0].clientY); }, { passive: false });
        document.addEventListener('touchmove', e => { if (dragging) { e.preventDefault(); moveDrag(e.touches[0].clientY); } }, { passive: false });
        document.addEventListener('touchend',  endDrag);
    }

    // ── Drag handle ────────────────────────────────────────────────

    function initDragHandle() {
        const handle   = document.getElementById('nb-drag-handle');
        const listPane = document.getElementById('nb-list-pane');
        if (!handle || !listPane) return;

        const KEY_W = 'nb-list-w';
        const KEY_H = 'nb-list-h';

        function isMobile() { return window.innerWidth <= 700; }

        function applySize(px) {
            if (isMobile()) {
                listPane.style.width     = '';
                listPane.style.maxHeight = Math.max(80, Math.min(px, window.innerHeight * 0.75)) + 'px';
            } else {
                listPane.style.maxHeight = '';
                listPane.style.width     = Math.max(150, Math.min(px, window.innerWidth * 0.65)) + 'px';
            }
        }

        // Restore saved size
        const savedW = localStorage.getItem(KEY_W);
        const savedH = localStorage.getItem(KEY_H);
        if (!isMobile() && savedW) applySize(Number(savedW));
        if (isMobile()  && savedH) applySize(Number(savedH));

        // Re-apply correct size when crossing the mobile/desktop threshold
        let _wasMobile = isMobile();
        window.addEventListener('resize', () => {
            const mobile = isMobile();
            if (mobile === _wasMobile) return;
            _wasMobile = mobile;
            if (mobile) {
                listPane.style.maxHeight = '';
                listPane.style.width = '';
                const h = localStorage.getItem(KEY_H);
                if (h) applySize(Number(h));
            } else {
                listPane.style.maxHeight = '';
                listPane.style.width = '';
                const w = localStorage.getItem(KEY_W);
                if (w) applySize(Number(w));
            }
        });

        let dragging = false, startX = 0, startY = 0, startW = 0, startH = 0;

        function startDrag(cx, cy) {
            dragging = true;
            startX = cx; startY = cy;
            startW = listPane.offsetWidth;
            startH = listPane.offsetHeight;
            handle.classList.add('dragging');
            document.body.style.userSelect = 'none';
            document.body.style.cursor = isMobile() ? 'row-resize' : 'col-resize';
        }

        function moveDrag(cx, cy) {
            if (!dragging) return;
            applySize(isMobile() ? startH + (cy - startY) : startW + (cx - startX));
        }

        function endDrag() {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
            const size = isMobile() ? listPane.offsetHeight : listPane.offsetWidth;
            localStorage.setItem(isMobile() ? KEY_H : KEY_W, size);
        }

        handle.addEventListener('mousedown', e => { e.preventDefault(); startDrag(e.clientX, e.clientY); });
        document.addEventListener('mousemove', e => moveDrag(e.clientX, e.clientY));
        document.addEventListener('mouseup', endDrag);

        handle.addEventListener('touchstart', e => {
            e.preventDefault();
            startDrag(e.touches[0].clientX, e.touches[0].clientY);
        }, {passive: false});
        document.addEventListener('touchmove', e => {
            if (dragging) { e.preventDefault(); moveDrag(e.touches[0].clientX, e.touches[0].clientY); }
        }, {passive: false});
        document.addEventListener('touchend', endDrag);
    }


    function init() {
        initDragHandle();
        initAnnDragHandle();
    }

    return { init, initDragHandle, initAnnDragHandle };
})();

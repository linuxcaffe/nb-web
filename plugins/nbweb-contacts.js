// NbWeb-contacts — contact card renderer and VCF browser for the contacts notebook
// @name     NbWeb Contacts
// @version  0.1.0
// @type     bundled
// @homepage
(() => {

    const _esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    // ── Contact rendering helpers ─────────────────────────────────────────────

    function _contactFields(field) {
        if (!field) return [];
        if (typeof field === 'string') return [{ label: 'email', value: field }];
        if (Array.isArray(field))      return field.flatMap(_contactFields);
        if (typeof field === 'object') return Object.entries(field).map(([label, value]) => ({ label, value: String(value) }));
        return [];
    }

    function _contactInitials(name) {
        return (name || '?').split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase() || '?';
    }

    function _contactColor(name) {
        let h = 0;
        for (let i = 0; i < (name || '').length; i++) h = (h * 31 + (name || '').charCodeAt(i)) & 0xffff;
        return `hsl(${h % 360},40%,38%)`;
    }

    function _renderContact(note) {
        const m    = note.meta || {};
        const name = m.name || m.fn || note.title || '';
        const emails  = _contactFields(m.email);
        const phones  = _contactFields(m.phone);
        const tags    = Array.isArray(m.tags) ? m.tags : (m.tags ? String(m.tags).split(',').map(t => t.trim()) : []);

        const avatar = `<div class="nb-contact-avatar" style="background:${_contactColor(name)}">${_esc(_contactInitials(name))}</div>`;
        const sub    = [m.title, m.org].filter(Boolean).map(_esc).join(' · ');

        let rows = '';
        emails.forEach(({ label, value }) => {
            rows += `<div class="nb-contact-row"><span class="nb-contact-label">${_esc(label)}</span>` +
                    `<a class="nb-contact-value" href="mailto:${_esc(value)}">${_esc(value)}</a></div>`;
        });
        phones.forEach(({ label, value }) => {
            const href = 'tel:' + value.replace(/\s/g, '');
            rows += `<div class="nb-contact-row"><span class="nb-contact-label">${_esc(label)}</span>` +
                    `<a class="nb-contact-value" href="${_esc(href)}">${_esc(value)}</a></div>`;
        });
        if (m.address) {
            const addr = typeof m.address === 'string' ? m.address
                : Object.values(m.address).filter(Boolean).join(', ');
            const mq = `https://maps.google.com/?q=${encodeURIComponent(addr)}`;
            rows += `<div class="nb-contact-row"><span class="nb-contact-label">address</span>` +
                    `<a class="nb-contact-value" href="${mq}" target="_blank" rel="noopener">${_esc(addr)}</a></div>`;
        }
        if (m.url) {
            rows += `<div class="nb-contact-row"><span class="nb-contact-label">web</span>` +
                    `<a class="nb-contact-value" href="${_esc(m.url)}" target="_blank" rel="noopener">${_esc(m.url)}</a></div>`;
        }
        if (m.birthday) {
            rows += `<div class="nb-contact-row"><span class="nb-contact-label">birthday</span>` +
                    `<span class="nb-contact-value">${_esc(String(m.birthday))}</span></div>`;
        }

        const tagHtml = tags.length
            ? `<div class="nb-contact-tags">${tags.map(t => `<span class="nb-tag-link">#${_esc(t)}</span>`).join('')}</div>`
            : '';

        const bodyHtml = note.body?.trim()
            ? `<div class="nb-contact-notes">${NbMain.renderMarkdown(note.body)}</div>` : '';

        return `<div class="nb-contact-card">
  <div class="nb-contact-header">${avatar}
    <div class="nb-contact-name-block">
      <div class="nb-contact-name">${_esc(name)}</div>
      ${sub ? `<div class="nb-contact-sub">${sub}</div>` : ''}
    </div>
  </div>
  ${rows ? `<div class="nb-contact-fields">${rows}</div>` : ''}
  ${tagHtml}
  ${bodyHtml}
</div>`;
    }

    // ── VCF browser ───────────────────────────────────────────────────────────

    let _vcfContacts  = null;
    let _vcfSelected  = null;
    let _vcfShownList = [];

    function _vcfDisplayName(c) {
        return c.name || c.fn || c.org || Object.values(c.email || {})[0] || '(no name)';
    }

    function _initVcfBrowser() {
        if (document.getElementById('nb-vcf-backdrop')) return;
        const el = document.createElement('div');
        el.id        = 'nb-vcf-backdrop';
        el.className = 'nb-vcf-backdrop';
        el.style.display = 'none';
        el.innerHTML =
            `<div class="nb-vcf-dialog">` +
              `<div class="nb-vcf-header">` +
                `<span>📇 Browse Contacts</span>` +
                `<input id="nb-vcf-search" type="text" placeholder="Search…" autocomplete="off">` +
                `<button class="nb-vcf-done" id="nb-vcf-done">Done</button>` +
                `<button class="nb-vcf-close" id="nb-vcf-close">×</button>` +
              `</div>` +
              `<div class="nb-vcf-body">` +
                `<div class="nb-vcf-list" id="nb-vcf-list"></div>` +
                `<div class="nb-vcf-detail" id="nb-vcf-detail">` +
                  `<div class="nb-vcf-empty">Select a contact</div>` +
                `</div>` +
              `</div>` +
            `</div>`;
        document.body.appendChild(el);

        el.addEventListener('click', e => { if (e.target === el) _closeVcfBrowser(); });
        document.getElementById('nb-vcf-close').addEventListener('click', _closeVcfBrowser);
        document.getElementById('nb-vcf-done').addEventListener('click', _closeVcfBrowser);
        document.getElementById('nb-vcf-search').addEventListener('input', e => {
            _vcfRenderList(e.target.value.trim().toLowerCase());
        });
        document.addEventListener('keydown', e => {
            const backdrop = document.getElementById('nb-vcf-backdrop');
            if (!backdrop || backdrop.style.display === 'none') return;
            const nav = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 };
            if (!(e.key in nav)) return;
            e.preventDefault();
            const n = _vcfShownList.length;
            if (!n) return;
            const cur = _vcfSelected ? _vcfShownList.indexOf(_vcfSelected) : -1;
            _vcfSelectByIndex(cur < 0 ? (nav[e.key] > 0 ? 0 : n - 1) : cur + nav[e.key]);
        });
    }

    function _vcfSelectByIndex(i) {
        const n = _vcfShownList.length;
        if (!n) return;
        i = Math.max(0, Math.min(i, n - 1));
        const items = document.querySelectorAll('.nb-vcf-item');
        if (!items[i]) return;
        items[i].scrollIntoView({ block: 'nearest' });
        _vcfShowDetail(_vcfShownList[i], items[i]);
    }

    function _vcfRenderList(filter = '') {
        const list = document.getElementById('nb-vcf-list');
        if (!list || !_vcfContacts) return;
        const shown = filter
            ? _vcfContacts.filter(c => {
                const hay = [c.fn, c.name, c.org, ...Object.values(c.email || {}),
                             ...Object.values(c.phone || {})].join(' ').toLowerCase();
                return hay.includes(filter);
              })
            : _vcfContacts;
        _vcfShownList = shown;
        list.innerHTML = '';
        if (!shown.length) {
            list.innerHTML = '<div class="nb-vcf-empty">No matches</div>';
            return;
        }
        shown.forEach((c, i) => {
            const div = document.createElement('div');
            div.className = 'nb-vcf-item' + (c === _vcfSelected ? ' active' : '');
            div.textContent = _vcfDisplayName(c);
            div.dataset.idx = i;
            div.addEventListener('click', () => _vcfShowDetail(c, div));
            list.appendChild(div);
        });
    }

    function _vcfShowDetail(c, itemEl) {
        _vcfSelected = c;
        document.querySelectorAll('.nb-vcf-item').forEach(el => el.classList.remove('active'));
        if (itemEl) itemEl.classList.add('active');

        const detail = document.getElementById('nb-vcf-detail');
        if (!detail) return;

        function field(label, val) {
            if (!val) return '';
            if (typeof val === 'object') {
                return Object.entries(val).map(([k, v]) =>
                    `<div class="nb-vcf-field"><span class="nb-vcf-label">${_esc(label)}</span>` +
                    `<span class="nb-vcf-value">${_esc(v)} <em style="opacity:0.5">${_esc(k)}</em></span></div>`
                ).join('');
            }
            return `<div class="nb-vcf-field"><span class="nb-vcf-label">${_esc(label)}</span>` +
                   `<span class="nb-vcf-value">${_esc(String(val))}</span></div>`;
        }

        detail.innerHTML =
            `<div class="nb-vcf-detail-name">${_esc(_vcfDisplayName(c))}</div>` +
            field('Email',   c.email) +
            field('Phone',   c.phone) +
            field('Org',     c.org) +
            field('Title',   c.title) +
            field('Address', c.address) +
            field('Birthday',c.birthday) +
            field('URL',     c.url) +
            field('Note',    c.note) +
            `<div class="nb-vcf-create">` +
              `<button id="nb-vcf-create-btn">Create Contact Note</button>` +
            `</div>`;

        document.getElementById('nb-vcf-create-btn').addEventListener('click', async () => {
            const btn = document.getElementById('nb-vcf-create-btn');
            btn.disabled = true;
            btn.textContent = 'Creating…';
            try {
                const r = await fetch('/api/contacts/from-vcf', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contact: _vcfSelected }),
                });
                const d = await r.json();
                if (d.success) {
                    btn.textContent = '✓ Created!';
                    btn.style.background = 'var(--green, #2ecc71)';
                    setTimeout(() => {
                        btn.textContent = 'Create Contact Note';
                        btn.style.background = '';
                        btn.disabled = false;
                    }, 1800);
                } else {
                    btn.textContent = 'Error: ' + (d.error || 'could not create note');
                    btn.style.background = 'var(--red, #e74c3c)';
                    setTimeout(() => {
                        btn.textContent = 'Create Contact Note';
                        btn.style.background = '';
                        btn.disabled = false;
                    }, 2500);
                }
            } catch(e) {
                btn.textContent = 'Error — retry?';
                btn.style.background = '';
                btn.disabled = false;
            }
        });
    }

    async function _openVcfBrowser() {
        _initVcfBrowser();
        const el = document.getElementById('nb-vcf-backdrop');
        if (!el) return;
        el.style.display = 'flex';
        document.getElementById('nb-vcf-search').value = '';
        document.getElementById('nb-vcf-detail').innerHTML = '<div class="nb-vcf-empty">Select a contact</div>';
        _vcfSelected = null;

        const listEl = document.getElementById('nb-vcf-list');
        listEl.innerHTML = '<div class="nb-vcf-empty">Loading…</div>';
        document.getElementById('nb-vcf-search').focus();

        try {
            const r = await fetch('/api/contacts/vcf');
            const d = await r.json();
            if (!r.ok) {
                listEl.innerHTML = `<div class="nb-vcf-empty">${_esc(d.error || 'Could not load VCF')}</div>`;
                return;
            }
            _vcfContacts = d.contacts || [];
            _vcfRenderList();
        } catch(e) {
            listEl.innerHTML = '<div class="nb-vcf-empty">Network error</div>';
        }
    }

    function _closeVcfBrowser() {
        const el = document.getElementById('nb-vcf-backdrop');
        if (el) el.style.display = 'none';
        NbMain.loadNotes();
    }

    // ── Plugin registration ───────────────────────────────────────────────────

    NbWeb.registerModule('contacts', {

        label:       'NbWeb-contacts',
        description: 'Contact card renderer, last-name sort, and VCF importer for the contacts notebook',
        helpUrl:     '/plugins/nbweb-contacts.md',

        detect: (notebooks) => notebooks.filter(nb => nb.name === 'contacts'),

        listDefaults: { listType: 'note', sortOrder: 'lastname' },

        sortOptions: [
            {
                id:    'lastname',
                label: 'Last name',
                sort:  (notes) => [...notes].sort((a, b) => {
                    const ln = n => {
                        const name = n.meta?.name || n.meta?.fn || n.title || '';
                        const parts = name.trim().split(/\s+/);
                        return (parts.length > 1 ? parts[parts.length - 1] : parts[0]).toLowerCase();
                    };
                    return ln(a).localeCompare(ln(b));
                }),
            },
        ],

        previewRenderer: (note) => {
            if (note.type !== 'contact') return null;
            return _renderContact(note);
        },

        listButtons: [
            {
                id:     'nbwc-vcf',
                icon:   '📇',
                title:  'Browse VCF contacts',
                action: (_notebook, _btn) => _openVcfBrowser(),
            },
        ],

    });

})();

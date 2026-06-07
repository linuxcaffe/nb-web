// NbWeb-quartz — nb-web plugin for nb-quartz publishing
// Activates for any notebook that has a .nb-website.json with a quartz_path.
(() => {

    const _esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    function _renderItem(note) {
        const m      = note.meta || {};
        const nb     = note.notebook || (note.selector || '').split(':')[0];
        const title  = String(m.title || note.title || '');
        const status = String(m.status || 'available');
        const statusLabel = status === 'available' ? 'Available' : status === 'sold' ? 'Sold' : status;
        const statusClass = status === 'available' ? 'nb-item-status--available' : 'nb-item-status--sold';

        const imgSels = (m.image || '').split(',').map(s => s.trim()).filter(Boolean).map(p => {
            if (p.startsWith('../images/')) p = p.slice(3);
            else if (p.startsWith('./')) p = 'items/' + p.slice(2);
            else if (!p.startsWith('images/')) p = `images/${p}`;
            return `${nb}:${p}`;
        });
        const imgsHtml = imgSels.length
            ? `<div class="nb-item-imgs">${imgSels.map(sel =>
                `<img class="nb-item-img" src="/api/file?selector=${encodeURIComponent(sel)}" alt="${_esc(title)}">`
              ).join('')}</div>`
            : '';

        const row = (label, val) => val
            ? `<div class="nb-contact-row"><span class="nb-contact-label">${_esc(label)}</span><span class="nb-contact-value">${_esc(String(val))}</span></div>`
            : '';
        const linkRow = (label, href, text) => href
            ? `<div class="nb-contact-row"><span class="nb-contact-label">${_esc(label)}</span><a class="nb-contact-value" href="${_esc(href)}" target="_blank" rel="noopener">${_esc(text)}</a></div>`
            : '';

        const fields = [
            row('category',  m.category),
            m.qtty && String(m.qtty) !== '1' ? row('qty', m.qtty) : '',
            row('price',     m.price),
            row('date',      m.date instanceof Date
                ? m.date.toLocaleDateString('en-CA', {year:'numeric',month:'short',day:'numeric'})
                : m.date),
            row('size',      m.size),
            row('condition', m.condition),
            row('shipping',  m.shipping),
            linkRow('listing', m.listing, `View on ${m.platform || m.listing}`),
            !m.listing && m.platform ? row('platform', m.platform) : '',
        ].join('');

        const tags = Array.isArray(m.tags) ? m.tags : (m.tags ? String(m.tags).split(',').map(t => t.trim()) : []);
        const tagHtml = tags.length
            ? `<div class="nb-contact-tags">${tags.map(t => `<span class="nb-tag-link">#${_esc(t)}</span>`).join('')}</div>`
            : '';

        const cleanBody = (note.body || '')
            .replace(/^!\[.*?\]\(.*?\)\s*\n?/m, '')
            .replace(/<!--.*?-->/gs, '')
            .trim();
        const bodyHtml = cleanBody && typeof marked !== 'undefined'
            ? `<div class="nb-contact-notes">${marked.parse(cleanBody)}</div>` : '';

        const caption = m.caption ? `<div class="nb-item-caption">${_esc(String(m.caption))}</div>` : '';
        const desc    = m.description ? `<div class="nb-item-description">${_esc(String(m.description))}</div>` : '';

        return `<div class="nb-item-card">
  <div class="nb-item-body">
    <div class="nb-item-header">
      <div class="nb-item-name">${_esc(title)}</div>
      <span class="nb-item-status ${statusClass}">${_esc(statusLabel)}</span>
    </div>
    ${caption}${desc}
    ${fields ? `<div class="nb-contact-fields">${fields}</div>` : ''}
    ${tagHtml}
    ${imgsHtml}
    ${bodyHtml}
  </div>
</div>`;
    }

    NbWeb.registerModule('quartz', {

        label:        'NbWeb-quartz',
        description:  'Publish nb notebooks as Quartz static sites',
        helpUrl:      '/plugins/nbweb-quartz.md',
        listDefaults: { listType: 'note', sortOrder: 'default' },

        detect: (notebooks) => notebooks.filter(nb => nb.website?.quartz_path),

        previewRenderer: (note) => {
            if (!note.selector || !/:items\//.test(note.selector)) return null;
            return _renderItem(note);
        },

        listButtons: [
            {
                id:     'nbwq-publish',
                icon:   '🌐',
                title:  'Publish site',
                action: (notebook, btn) => NbWeb.publishWebsite(notebook, btn),
            },
            {
                id:    'nbwq-open',
                icon:  '↗',
                title: 'Open site in new tab',
                action: (_notebook, _btn, ctx) => {
                    const url = ctx?.website?.url;
                    if (url) window.open(url, '_blank');
                },
            },
        ],

        notebookSection: (notebook) => {
            const w = notebook.website;
            if (!w) return null;
            return {
                label: 'NbWeb-quartz',
                rows: [
                    { key: 'Site',   value: w.url,         link: w.url },
                    { key: 'Quartz', value: w.quartz_path  },
                ],
                actions: [
                    {
                        id:      'nbwq-nb-publish',
                        icon:    '🌐',
                        label:   'Publish',
                        primary: true,
                        fn:      (nb, btn) => NbWeb.publishWebsite(nb.name, btn),
                    },
                    {
                        id:    'nbwq-nb-open',
                        icon:  '↗',
                        label: 'Open site',
                        fn:    (nb) => { if (nb.website?.url) window.open(nb.website.url, '_blank'); },
                    },
                ],
            };
        },

        templates: [
            {
                name:        '_meta.md',
                filename:    '_meta.md',
                description: 'Site-wide config (tagline, footer, social links)',
                singleton:   true,
                content: (notebook) => {
                    const title = notebook.website?.url
                        ? notebook.website.url.replace(/^https?:\/\//, '').replace(/\/$/, '')
                        : notebook.name;
                    const year = new Date().getFullYear();
                    return `---
tagline:
description:
SEO:
copyright: "© ${year} ${title}"
instagram: ""
ebay: ""
etsy: ""
---

Site-wide configuration for ${title}.
Edit this note to update the site header tagline, footer copyright, and social links.
Fields left empty ("") are not shown on the site.

**tagline** — shown in the site header on pages that have no caption of their own
**description** — site-wide meta description used in search engine results
**SEO** — additional keywords for search engines
**copyright** — footer copyright line
**instagram / ebay / etsy** — platform handles (no @ or URL prefix) for footer links
`;
                },
            },
            {
                name:        'Page',
                description: 'Content page with Quartz frontmatter',
                scope:       'notebook',
                content:     '---\ntitle: \ncaption: \ntags: []\n---\n\n',
            },
            {
                name:        'Post',
                description: 'Dated blog post',
                scope:       'notebook',
                content: () => {
                    const date = new Date().toISOString().slice(0, 10);
                    return `---\ntitle: \ndate: ${date}\ntags: []\n---\n\n`;
                },
            },
            {
                name:        'Item',
                filename:    'item.md',
                description: 'Shop item listing',
                scope:       'folder:items',
                content: () => {
                    const date = new Date().toISOString().slice(0, 10);
                    return `---\ntitle: \nprice: \nstatus: available\ncategory: \nimage: \ncaption: \ntags: []\ndate: ${date}\n---\n\n`;
                },
            },
        ],

        // TODO: addFormExtras — category, status, price, image fields

    });

})();

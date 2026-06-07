// NbWeb-quartz — nb-web plugin for nb-quartz publishing
// Activates for any notebook that has a .nb-website.json with a quartz_path.
(() => {

    const _esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    // Known fields — shown in fixed order or handled explicitly; not repeated in extras.
    const _KNOWN = new Set([
        'title', 'status', 'image', 'caption', 'description',
        'category', 'qtty', 'price', 'date', 'size', 'condition', 'shipping', 'listing', 'platform',
        'tags', 'SEO', 'with_tags', 'footnote', 'draft',
        'tagline', 'copyright', 'instagram', 'ebay', 'etsy',
    ]);

    // Unified renderer for all quartz-format notes: shop items and content pages.
    // Items are identified by path (/:items\//); pages by quartz-specific frontmatter fields.
    // Sections are omitted when the relevant fields are absent, so both note types
    // share one code path with no explicit branching on type.
    function _renderQuartzNote(note) {
        const m      = note.meta || {};
        const nb     = note.notebook || (note.selector || '').split(':')[0];
        const isItem = note.selector && /:items\//.test(note.selector);
        const title  = String(m.title || note.title || '');

        // Status badge — present on items; omitted for plain pages
        const status = m.status ? String(m.status) : null;
        const statusLabel = status === 'available' ? 'Available' : status === 'sold' ? 'Sold' : status;
        const statusCls   = status === 'available' ? 'nb-item-status--available'
                          : status === 'sold'      ? 'nb-item-status--sold' : '';
        const statusHtml  = status
            ? `<span class="nb-item-status ${statusCls}">${_esc(statusLabel)}</span>` : '';

        // Images — item field; omitted for pages
        const imgSels = (m.image || '').split(',').map(s => s.trim()).filter(Boolean).map(p => {
            if (p.startsWith('../images/')) p = p.slice(3);
            else if (p.startsWith('./'))    p = 'items/' + p.slice(2);
            else if (!p.startsWith('images/')) p = `images/${p}`;
            return `${nb}:${p}`;
        });
        const imgsHtml = imgSels.length
            ? `<div class="nb-item-imgs">${imgSels.map(sel =>
                `<img class="nb-item-img" src="/api/file?selector=${encodeURIComponent(sel)}" alt="${_esc(title)}">`
              ).join('')}</div>`
            : '';

        const caption = m.caption     ? `<div class="nb-item-caption">${_esc(String(m.caption))}</div>`     : '';
        const desc    = m.description ? `<div class="nb-item-description">${_esc(String(m.description))}</div>` : '';

        // Known fields in fixed order
        const row = (label, val) => val != null && String(val).trim()
            ? `<div class="nb-contact-row"><span class="nb-contact-label">${_esc(label)}</span><span class="nb-contact-value">${_esc(String(val))}</span></div>`
            : '';
        const linkRow = (label, href, text) => href
            ? `<div class="nb-contact-row"><span class="nb-contact-label">${_esc(label)}</span><a class="nb-contact-value" href="${_esc(href)}" target="_blank" rel="noopener">${_esc(text)}</a></div>`
            : '';

        const knownRows = [
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
            row('SEO',       m.SEO),
        ].join('');

        // Dynamic extras — any frontmatter field not in the known set
        const extraRows = Object.entries(m)
            .filter(([k]) => !_KNOWN.has(k))
            .map(([k, v]) => {
                const raw = (v != null && typeof v === 'object') ? JSON.stringify(v) : String(v ?? '');
                const display = raw.includes('\n')
                    ? `<pre class="nb-wp-field-pre">${_esc(raw)}</pre>`
                    : `<span class="nb-contact-value">${_esc(raw)}</span>`;
                return `<div class="nb-contact-row"><span class="nb-contact-label">${_esc(k)}</span>${display}</div>`;
            }).join('');

        const fieldsHtml = (knownRows + extraRows)
            ? `<div class="nb-contact-fields">${knownRows}${extraRows}</div>` : '';

        // Tags
        const tags = Array.isArray(m.tags) ? m.tags
            : (m.tags ? String(m.tags).split(',').map(t => t.trim()).filter(Boolean) : []);
        const tagHtml = tags.length
            ? `<div class="nb-contact-tags">${tags.map(t => `<span class="nb-tag-link">#${_esc(t)}</span>`).join('')}</div>`
            : '';

        // with_tags — quartz cross-notebook tag feature
        const withTagsList = Array.isArray(m.with_tags) ? m.with_tags
            : (m.with_tags ? String(m.with_tags).split(',').map(t => t.trim()).filter(Boolean) : []);
        const withTagsHtml = withTagsList.length
            ? `<div class="nb-contact-fields"><div class="nb-contact-row">` +
              `<span class="nb-contact-label">with_tags</span>` +
              `<span class="nb-contact-value">${withTagsList.map(t => `<span class="nb-tag-link">#${_esc(t)}</span>`).join(' ')}</span>` +
              `</div></div>` : '';

        // Body and footnote — use NbMain.renderMarkdown for wikilink support
        const renderMd = text => NbMain.renderMarkdown(text);

        const cleanBody = (note.body || '')
            .replace(/^!\[.*?\]\(.*?\)\s*\n?/m, '')
            .replace(/<!--.*?-->/gs, '')
            .trim();
        const bodyHtml = cleanBody
            ? `<div class="nb-wp-body">${renderMd(cleanBody)}</div>` : '';
        const footnote = m.footnote
            ? `<div class="nb-wp-footnote">${renderMd(String(m.footnote))}</div>` : '';

        return `<div class="${isItem ? 'nb-item-card' : 'nb-wp-card'}">
  <div class="nb-item-body">
    <div class="nb-item-header">
      <div class="nb-item-name">${_esc(title)}</div>
      ${statusHtml}
    </div>
    ${caption}${desc}
    ${fieldsHtml}
    ${tagHtml}
    ${withTagsHtml}
    ${imgsHtml}
    ${bodyHtml}
    ${footnote}
  </div>
</div>`;
    }

    NbWeb.registerModule('quartz', {

        label:        'NbWeb-quartz',
        description:  'Publish nb notebooks as Quartz static sites',
        helpUrl:      '/plugins/nbweb-quartz.md',
        listDefaults: { listType: 'note', sortOrder: 'default' },

        detect: (notebooks) => notebooks.filter(nb => nb.website?.quartz_path),

        // Handles both shop items (by path) and quartz content pages (by frontmatter).
        previewRenderer: (note) => {
            const m      = note.meta || {};
            const isItem = note.selector && /:items\//.test(note.selector);
            const isPage = !isItem && ('caption' in m || 'SEO' in m || 'footnote' in m || 'with_tags' in m);
            if (!isItem && !isPage) return null;
            return _renderQuartzNote(note);
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

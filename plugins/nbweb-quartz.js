// NbWeb-quartz — nb-web plugin for nb-quartz publishing
// Activates for any notebook that has a .nb-website.json with a quartz_path.
NbWeb.registerModule('quartz', {

    label:        'NbWeb-quartz',
    description:  'Publish nb notebooks as Quartz static sites',
    helpUrl:      '/plugins/nbweb-quartz.md',
    listDefaults: { listType: 'note', sortOrder: 'default' },

    detect: (notebooks) => notebooks.filter(nb => nb.website?.quartz_path),

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
    ],

    // TODO: previewRenderer — shop item preview (image + meta fields)
    // TODO: listExcerpt    — item-specific excerpt (status, price)
    // TODO: addFormExtras  — category, status, price, image fields

});

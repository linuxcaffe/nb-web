// NbWeb-quartz — nb-web plugin for nb-quartz publishing
// Activates for any notebook that has a .nb-website.json with a quartz_path.
NbWeb.registerModule('quartz', {

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

    // TODO: previewRenderer — shop item preview (image + meta fields)
    // TODO: listExcerpt    — item-specific excerpt (status, price)
    // TODO: addFormExtras  — category, status, price, image fields

});

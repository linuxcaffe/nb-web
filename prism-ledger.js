// Prism.js grammar for hledger / ledger journal files.
// Token types derived from vimwiki-ledger/syntax/ledger.vim.
Prism.languages.ledger = {
    // Full-line comment: ; ...
    'comment': /^;.*/m,

    // Directive keywords at line start: account, payee, commodity, tag, include, apply end
    'keyword': /^(account|payee|commodity|tag|include|apply\s+\w+|end\s+apply)\b.*/m,

    // Transaction date: YYYY/MM/DD or YYYY-MM-DD at line start, optionally with =edate
    'number': {
        pattern: /^\d[\d\/.=-]+(?:\s*=\s*[\d\/.=-]+)?(?=\s)/m,
        greedy: true,
    },

    // Cleared/pending status marker: * or ! after date (on transaction line)
    'operator': /(?<=^\d[\d\/.=-]+\s+)[*!]/m,

    // Inline tags: :tagname: style
    'tag': /:[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*:/,

    // Amount: currency symbol or commodity code + number, or bare number with decimal
    // Matches things like $1,234.56  -€42  1000 USD  -50.00
    'variable': /(?:[-+]?\s*(?:[A-Z]{1,5}\s+)?[-+]?\d[\d,.']*(?:\.\d+)?(?:\s+[A-Z]{1,5})?|(?:[-+]?\s*[$€£¥₹]\s*[-+]?\d[\d,.']*(?:\.\d+)?))/,

    // Account name: indented line, everything up to two-space/tab separator or EOL
    'string': {
        pattern: /^[ \t]+[^ \t;][^\t]*?(?=(?:  |\t|$))/m,
        greedy: true,
    },
};
Prism.languages.journal = Prism.languages.ledger;
Prism.languages.hledger = Prism.languages.ledger;

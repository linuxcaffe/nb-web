// NbWeb-hledger — plain-text accounting with domain knowledge
// Chart of accounts wizard, Canadian tax mappings, journal health, account autocomplete.
// AGPL v3 — https://github.com/linuxcaffe/nbweb-hledger
(() => {

// ── Utilities ────────────────────────────────────────────────────────────────

function _esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Province configuration ────────────────────────────────────────────────────

const _PROVINCES = {
    AB: { label: 'Alberta',           regime: 'gst',     gst: 5,   pst: 0,    hst: 0    },
    BC: { label: 'British Columbia',  regime: 'gst_pst', gst: 5,   pst: 7,    hst: 0    },
    MB: { label: 'Manitoba',          regime: 'gst_pst', gst: 5,   pst: 7,    hst: 0    },
    NB: { label: 'New Brunswick',     regime: 'hst',     gst: 0,   pst: 0,    hst: 15   },
    NL: { label: 'Newfoundland',      regime: 'hst',     gst: 0,   pst: 0,    hst: 15   },
    NS: { label: 'Nova Scotia',       regime: 'hst',     gst: 0,   pst: 0,    hst: 15   },
    NT: { label: 'Northwest Terr.',   regime: 'gst',     gst: 5,   pst: 0,    hst: 0    },
    NU: { label: 'Nunavut',           regime: 'gst',     gst: 5,   pst: 0,    hst: 0    },
    ON: { label: 'Ontario',           regime: 'hst',     gst: 0,   pst: 0,    hst: 13   },
    PE: { label: 'PEI',               regime: 'hst',     gst: 0,   pst: 0,    hst: 15   },
    QC: { label: 'Quebec',            regime: 'gst_qst', gst: 5,   pst: 0,    hst: 0,   qst: 9.975 },
    SK: { label: 'Saskatchewan',      regime: 'gst_pst', gst: 5,   pst: 6,    hst: 0    },
    YT: { label: 'Yukon',             regime: 'gst',     gst: 5,   pst: 0,    hst: 0    },
};

// ── Chart of accounts domain packs ───────────────────────────────────────────

function _personalAccounts(opts, province) {
    const prov = _PROVINCES[province] || _PROVINCES.BC;
    const a = [];

    // Assets
    a.push({ account: 'Assets', type: 'asset' });
    if (opts.chequing)
        a.push({ account: 'Assets:Bank:Chequing', type: 'asset',
                 desc: 'Day-to-day chequing account' });
    if (opts.savings)
        a.push({ account: 'Assets:Bank:Savings', type: 'asset',
                 desc: 'High-interest savings' });
    a.push({ account: 'Assets:Cash', type: 'asset',
             desc: 'Physical cash on hand' });
    if (opts.tfsa)
        a.push({ account: 'Assets:Investments:TFSA', type: 'asset',
                 desc: 'Tax-Free Savings Account — contributions after-tax, growth and withdrawals tax-free' });
    if (opts.rrsp)
        a.push({ account: 'Assets:Investments:RRSP', type: 'asset',
                 desc: 'Registered Retirement Savings Plan — contributions tax-deductible, withdrawals taxable income' });
    if (opts.fhsa)
        a.push({ account: 'Assets:Investments:FHSA', type: 'asset',
                 desc: 'First Home Savings Account — tax-deductible contributions, tax-free withdrawal for first home purchase' });
    if (opts.investments)
        a.push({ account: 'Assets:Investments:Taxable', type: 'asset',
                 desc: 'Non-registered investments — capital gains and dividends are taxable' });
    if (opts.mortgage)
        a.push({ account: 'Assets:Property:Home', type: 'asset',
                 desc: 'Fair market value of primary residence (optional, for net worth tracking)' });

    // Liabilities
    a.push({ account: 'Liabilities', type: 'liability' });
    if (opts.credit_card)
        a.push({ account: 'Liabilities:CreditCard', type: 'liability' });
    if (opts.mortgage)
        a.push({ account: 'Liabilities:Loan:Mortgage', type: 'liability',
                 desc: 'Outstanding mortgage principal balance' });
    if (opts.auto_loan)
        a.push({ account: 'Liabilities:Loan:Auto', type: 'liability' });

    // Equity
    a.push({ account: 'Equity', type: 'equity' });
    a.push({ account: 'Equity:OpeningBalances', type: 'equity',
             desc: 'Use once to establish initial balances when starting hledger' });

    // Income
    a.push({ account: 'Income', type: 'income' });
    a.push({ account: 'Income:Employment:Salary',  type: 'income', cra_t1: '10100', cra_label: 'Employment income' });
    a.push({ account: 'Income:Employment:Bonus',   type: 'income', cra_t1: '10100', cra_label: 'Employment income (bonus)' });
    if (opts.investments) {
        a.push({ account: 'Income:Investments:Dividends:Eligible',   type: 'income', cra_t1: '12000', cra_label: 'Taxable amount of eligible dividends' });
        a.push({ account: 'Income:Investments:Dividends:Ineligible', type: 'income', cra_t1: '12010', cra_label: 'Taxable amount of ineligible dividends' });
        a.push({ account: 'Income:Investments:CapitalGains',         type: 'income', cra_t1: '13200', cra_label: 'Taxable capital gains' });
        a.push({ account: 'Income:Investments:Interest',             type: 'income', cra_t1: '12100', cra_label: 'Interest and other investment income' });
    }
    if (opts.rental)
        a.push({ account: 'Income:Rental', type: 'income', cra_t1: '12599', cra_label: 'Gross rental income' });
    a.push({ account: 'Income:Other', type: 'income' });

    // Expenses — Housing
    a.push({ account: 'Expenses', type: 'expense' });
    if (opts.mortgage) {
        a.push({ account: 'Expenses:Housing:Mortgage:Interest',   type: 'expense',
                 desc: 'Interest portion of mortgage payment' });
        a.push({ account: 'Expenses:Housing:Mortgage:Principal',  type: 'expense',
                 desc: 'Principal repayment — not a tax expense; reduces Liabilities:Loan:Mortgage' });
    } else {
        a.push({ account: 'Expenses:Housing:Rent', type: 'expense' });
    }
    a.push({ account: 'Expenses:Housing:Strata',            type: 'expense' });
    a.push({ account: 'Expenses:Housing:Utilities:Hydro',   type: 'expense' });
    a.push({ account: 'Expenses:Housing:Utilities:Gas',     type: 'expense' });
    a.push({ account: 'Expenses:Housing:Utilities:Internet',type: 'expense' });
    a.push({ account: 'Expenses:Housing:Utilities:Phone',   type: 'expense' });
    a.push({ account: 'Expenses:Housing:Maintenance',       type: 'expense' });
    a.push({ account: 'Expenses:Housing:Insurance',         type: 'expense' });
    a.push({ account: 'Expenses:Housing:PropertyTax',       type: 'expense' });

    // Food, transport, health, personal
    a.push({ account: 'Expenses:Food:Groceries',         type: 'expense' });
    a.push({ account: 'Expenses:Food:Dining',            type: 'expense' });
    a.push({ account: 'Expenses:Transport:Fuel',         type: 'expense' });
    a.push({ account: 'Expenses:Transport:Insurance',    type: 'expense' });
    a.push({ account: 'Expenses:Transport:Maintenance',  type: 'expense' });
    a.push({ account: 'Expenses:Transport:Transit',      type: 'expense' });
    a.push({ account: 'Expenses:Health:Insurance',       type: 'expense' });
    a.push({ account: 'Expenses:Health:Dental',          type: 'expense' });
    a.push({ account: 'Expenses:Health:Prescriptions',   type: 'expense' });
    a.push({ account: 'Expenses:Health:Fitness',         type: 'expense' });
    a.push({ account: 'Expenses:Personal:Clothing',      type: 'expense' });
    a.push({ account: 'Expenses:Personal:Grooming',      type: 'expense' });
    a.push({ account: 'Expenses:Entertainment:Streaming',type: 'expense' });
    a.push({ account: 'Expenses:Entertainment:Events',   type: 'expense' });
    a.push({ account: 'Expenses:Entertainment:Hobbies',  type: 'expense' });
    a.push({ account: 'Expenses:Education:Tuition',      type: 'expense', cra_t1: '32300', cra_label: 'Tuition fees' });
    a.push({ account: 'Expenses:Education:Books',        type: 'expense' });
    a.push({ account: 'Expenses:Childcare',              type: 'expense', cra_t1: '21400', cra_label: 'Child care expenses' });
    a.push({ account: 'Expenses:Gifts:Charitable',       type: 'expense', cra_t1: '34900', cra_label: 'Donations and gifts' });
    a.push({ account: 'Expenses:Gifts:Personal',         type: 'expense' });

    // Taxes
    a.push({ account: 'Expenses:Taxes:Federal',   type: 'expense' });
    a.push({ account: 'Expenses:Taxes:Provincial', type: 'expense' });
    a.push({ account: 'Expenses:Taxes:CPP',        type: 'expense', cra_t1: '30800', cra_label: 'CPP or QPP contributions through employment' });
    a.push({ account: 'Expenses:Taxes:EI',         type: 'expense', cra_t1: '31200', cra_label: 'Employment insurance premiums' });

    a.push({ account: 'Expenses:Banking:Fees',   type: 'expense' });
    a.push({ account: 'Expenses:Subscriptions',  type: 'expense' });
    a.push({ account: 'Expenses:Uncategorised',  type: 'expense',
             desc: 'Temporary holding account — review and re-categorise monthly, should always net zero at close' });

    return a;
}

function _smallbizAccounts(opts, province) {
    const prov = _PROVINCES[province] || _PROVINCES.BC;
    const a = [];

    // Assets
    a.push({ account: 'Assets', type: 'asset' });
    a.push({ account: 'Assets:Bank:Business:Chequing', type: 'asset',
             desc: 'Primary business chequing — keep separate from personal' });
    if (opts.savings)
        a.push({ account: 'Assets:Bank:Business:Savings', type: 'asset' });
    a.push({ account: 'Assets:AccountsReceivable', type: 'asset',
             desc: 'Amounts owed by clients — invoice date, not payment date' });
    if (opts.petty_cash)
        a.push({ account: 'Assets:PettyCash', type: 'asset' });

    // Tax asset accounts — regime-dependent
    if (prov.regime === 'hst') {
        a.push({ account: 'Assets:HST:InputTaxCredits', type: 'asset',
                 desc: `HST paid on business purchases (ITCs) — ${prov.hst}% in ${_PROVINCES[province]?.label || province}` });
    } else if (prov.regime === 'gst_pst') {
        a.push({ account: 'Assets:GST:InputTaxCredits', type: 'asset',
                 desc: 'GST paid on business purchases (ITCs) — 5% federal, recoverable' });
        a.push({ account: 'Assets:PST:Paid', type: 'asset',
                 desc: `PST paid on purchases — ${prov.pst}% in ${_PROVINCES[province]?.label || province}. NOT recoverable — expense it here` });
    } else if (prov.regime === 'gst_qst') {
        a.push({ account: 'Assets:GST:InputTaxCredits', type: 'asset', desc: 'GST ITCs — 5% federal' });
        a.push({ account: 'Assets:QST:InputTaxCredits', type: 'asset', desc: 'QST ITCs — 9.975% Quebec' });
    } else {
        a.push({ account: 'Assets:GST:InputTaxCredits', type: 'asset', desc: 'GST paid on business purchases (ITCs) — 5% federal' });
    }

    // Liabilities
    a.push({ account: 'Liabilities', type: 'liability' });
    a.push({ account: 'Liabilities:AccountsPayable', type: 'liability',
             desc: 'Amounts owed to suppliers — invoice date, not payment date' });
    if (opts.credit_card)
        a.push({ account: 'Liabilities:CreditCard:Business', type: 'liability' });
    if (opts.line_of_credit)
        a.push({ account: 'Liabilities:Loan:BusinessLine', type: 'liability' });
    a.push({ account: 'Liabilities:DeferredRevenue', type: 'liability',
             desc: 'Pre-payments received for work not yet delivered' });

    // Tax liability accounts — regime-dependent
    if (prov.regime === 'hst') {
        a.push({ account: 'Liabilities:HST:Collected', type: 'liability',
                 desc: `HST collected from clients — ${prov.hst}%. Remit quarterly or annually to CRA` });
        a.push({ account: 'Liabilities:HST:Owing', type: 'liability',
                 desc: 'Net HST remittance = HST:Collected minus Assets:HST:InputTaxCredits' });
    } else if (prov.regime === 'gst_pst') {
        a.push({ account: 'Liabilities:GST:Collected', type: 'liability', desc: 'GST collected from clients — 5%' });
        a.push({ account: 'Liabilities:GST:Owing',     type: 'liability', desc: 'Net GST = Collected minus ITCs. Remit to CRA' });
    } else if (prov.regime === 'gst_qst') {
        a.push({ account: 'Liabilities:GST:Collected', type: 'liability', desc: 'GST collected — 5%' });
        a.push({ account: 'Liabilities:GST:Owing',     type: 'liability' });
        a.push({ account: 'Liabilities:QST:Collected', type: 'liability', desc: 'QST collected — 9.975%' });
        a.push({ account: 'Liabilities:QST:Owing',     type: 'liability' });
    } else {
        a.push({ account: 'Liabilities:GST:Collected', type: 'liability', desc: 'GST collected — 5%' });
        a.push({ account: 'Liabilities:GST:Owing',     type: 'liability' });
    }

    // Equity
    a.push({ account: 'Equity', type: 'equity' });
    a.push({ account: 'Equity:Owner:Equity',    type: 'equity' });
    a.push({ account: 'Equity:Owner:Draws',     type: 'equity',
             desc: 'Owner withdrawals — not an expense, reduces equity' });
    a.push({ account: 'Equity:RetainedEarnings',type: 'equity' });
    a.push({ account: 'Equity:OpeningBalances', type: 'equity' });

    // Income
    a.push({ account: 'Income', type: 'income' });
    a.push({ account: 'Income:Services:Consulting', type: 'income', cra_t2125: '8000', cra_label: 'Gross professional fees' });
    if (opts.retainer)
        a.push({ account: 'Income:Services:Retainer', type: 'income', cra_t2125: '8000' });
    if (opts.products)
        a.push({ account: 'Income:Products:Sales', type: 'income', cra_t2125: '8000', cra_label: 'Gross sales' });
    a.push({ account: 'Income:Reimbursements', type: 'income',
             desc: 'Expense pass-through billed to clients — not revenue, nets to zero' });

    // Expenses
    a.push({ account: 'Expenses', type: 'expense' });
    a.push({ account: 'Expenses:Professional:Legal',       type: 'expense', cra_t2125: '8860', cra_label: 'Legal, accounting, other professional fees' });
    a.push({ account: 'Expenses:Professional:Accounting',  type: 'expense', cra_t2125: '8860' });
    a.push({ account: 'Expenses:Professional:Contractors', type: 'expense', cra_t2125: '8860' });
    a.push({ account: 'Expenses:Office:Supplies',          type: 'expense', cra_t2125: '8810', cra_label: 'Office expenses' });
    a.push({ account: 'Expenses:Software:Subscriptions',   type: 'expense', cra_t2125: '8810' });
    a.push({ account: 'Expenses:Software:Licences',        type: 'expense', cra_t2125: '8810' });
    a.push({ account: 'Expenses:Marketing:Advertising',    type: 'expense', cra_t2125: '8520', cra_label: 'Advertising' });
    a.push({ account: 'Expenses:Marketing:WebHosting',     type: 'expense', cra_t2125: '8810' });
    a.push({ account: 'Expenses:Meals:Entertainment',      type: 'expense', cra_t2125: '8523',
             desc: 'Meals and entertainment — track gross amount; CRA allows 50% deduction. Do NOT net it here.' });
    a.push({ account: 'Expenses:Travel:Accommodation',     type: 'expense', cra_t2125: '9270', cra_label: 'Travel expenses' });
    a.push({ account: 'Expenses:Travel:Airfare',           type: 'expense', cra_t2125: '9270' });
    a.push({ account: 'Expenses:Travel:Meals',             type: 'expense', cra_t2125: '9270',
             desc: 'Meals while travelling — 50% deductible, same as Entertainment:Meals' });
    if (opts.home_office) {
        a.push({ account: 'Expenses:HomeOffice:Utilities', type: 'expense', cra_t2125: '9220', cra_label: 'Business-use-of-home expenses' });
        a.push({ account: 'Expenses:HomeOffice:Internet',  type: 'expense', cra_t2125: '9220' });
        a.push({ account: 'Expenses:HomeOffice:Rent',      type: 'expense', cra_t2125: '9220' });
    }
    if (opts.auto) {
        a.push({ account: 'Expenses:Auto:Fuel',         type: 'expense', cra_t2125: '9281', cra_label: 'Motor vehicle expenses' });
        a.push({ account: 'Expenses:Auto:Insurance',    type: 'expense', cra_t2125: '9281' });
        a.push({ account: 'Expenses:Auto:Maintenance',  type: 'expense', cra_t2125: '9281',
                 desc: 'Track business-use percentage separately; apply to all auto accounts at year end' });
    }
    if (opts.payroll) {
        a.push({ account: 'Expenses:Wages:Gross',        type: 'expense', cra_t2125: '9060', cra_label: 'Salaries, wages, benefits' });
        a.push({ account: 'Expenses:Wages:CPP:Employer', type: 'expense', cra_t2125: '9060' });
        a.push({ account: 'Expenses:Wages:EI:Employer',  type: 'expense', cra_t2125: '9060' });
    }
    if (opts.cca) {
        a.push({ account: 'Expenses:CCA:Class8',  type: 'expense', cra_t2125: '9936',
                 desc: 'CCA Class 8 — office furniture & equipment (20% declining balance)' });
        a.push({ account: 'Expenses:CCA:Class10', type: 'expense', cra_t2125: '9936',
                 desc: 'CCA Class 10 — automotive (30% declining balance)' });
        a.push({ account: 'Expenses:CCA:Class50', type: 'expense', cra_t2125: '9936',
                 desc: 'CCA Class 50 — computer hardware post-2018 (55% declining balance)' });
    }
    a.push({ account: 'Expenses:Banking:Fees',  type: 'expense', cra_t2125: '8710', cra_label: 'Interest and bank charges' });
    a.push({ account: 'Expenses:Uncategorised', type: 'expense',
             desc: 'Temporary — should net zero after monthly review' });

    return a;
}

const _COA_DOMAINS = {
    personal: {
        label: 'Personal Finance',
        options: [
            { id: 'chequing',    label: 'Chequing account',            default: true  },
            { id: 'savings',     label: 'Savings account',             default: true  },
            { id: 'tfsa',        label: 'TFSA',                        default: false },
            { id: 'rrsp',        label: 'RRSP',                        default: false },
            { id: 'fhsa',        label: 'FHSA (First Home Savings)',   default: false },
            { id: 'investments', label: 'Non-registered investments',  default: false },
            { id: 'credit_card', label: 'Credit card',                 default: false },
            { id: 'mortgage',    label: 'Mortgage',                    default: false },
            { id: 'auto_loan',   label: 'Auto loan',                   default: false },
            { id: 'rental',      label: 'Rental income',               default: false },
        ],
        build: _personalAccounts,
    },
    smallbiz: {
        label: 'Small Business',
        options: [
            { id: 'savings',        label: 'Business savings account',  default: false },
            { id: 'petty_cash',     label: 'Petty cash',                default: false },
            { id: 'credit_card',    label: 'Business credit card',      default: true  },
            { id: 'line_of_credit', label: 'Business line of credit',   default: false },
            { id: 'retainer',       label: 'Retainer income',           default: false },
            { id: 'products',       label: 'Product sales',             default: false },
            { id: 'home_office',    label: 'Home office deduction',     default: false },
            { id: 'auto',           label: 'Business vehicle',          default: false },
            { id: 'payroll',        label: 'Employees / payroll',       default: false },
            { id: 'cca',            label: 'Capital cost allowance',    default: false },
        ],
        build: _smallbizAccounts,
    },
};

// ── Account autocomplete ──────────────────────────────────────────────────────

let _accountCache = {};   // notebook → {ts, accounts}

async function _getAccounts(notebook) {
    const now = Date.now();
    const hit = _accountCache[notebook];
    if (hit && now - hit.ts < 60000) return hit.accounts;
    try {
        const d = await fetch(`/api/hledger/accounts?notebook=${encodeURIComponent(notebook)}`).then(r => r.json());
        const accounts = d.accounts || [];
        _accountCache[notebook] = { ts: now, accounts };
        return accounts;
    } catch (_) { return []; }
}

// ── Journal health ────────────────────────────────────────────────────────────

async function _journalHealth(notebook) {
    try {
        const [cfg, stats] = await Promise.all([
            fetch(`/api/hledger/config?notebook=${encodeURIComponent(notebook)}`).then(r => r.json()),
            fetch(`/api/hledger-query?q=${encodeURIComponent(`-f ${notebook} stats`)}`).then(r => r.json()).catch(() => null),
        ]);
        return { config: cfg.config, journal: cfg.journal, journal_ok: cfg.journal_ok, stats };
    } catch (_) { return null; }
}

// ── Account note generation ───────────────────────────────────────────────────

// Slug matching api_create_note: re.sub(r'[^\w]+', '_', title).strip('_').lower()
function _accountSlug(accountPath) {
    return accountPath.replace(/[^\w]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
}

function _noteBodyForAccount(acct, allAccounts, journalPath, notebook) {
    const leafName   = acct.account.split(':').pop();
    const parentPath = acct.account.includes(':')
        ? acct.account.split(':').slice(0, -1).join(':')
        : null;
    // HTML <a> tags survive marked.parse() intact — markdown link syntax breaks
    // on URLs containing spaces (hledger flags) or curly-brace placeholders.
    const jFlag = journalPath ? ` -f ${journalPath}` : '';
    const balLink = `<a href="term:hledger${jFlag} bal '{title}'">balance</a>`;
    const regLink = `<a href="term:hledger${jFlag} reg '{title}'">register</a>`;

    const fm = [
        '---',
        `title: "${acct.account}"`,
        'type: account',
        `hledger_account: "${acct.account}"`,
    ];
    if (acct.cra_label) fm.push(`cra_label: "${acct.cra_label}"`);
    if (acct.cra_t1)    fm.push(`cra_line_t1: "${acct.cra_t1}"`);
    if (acct.cra_t2125) fm.push(`cra_line_t2125: "${acct.cra_t2125}"`);
    fm.push('---', '');

    const body = [`## ${leafName}`, ''];

    if (acct.desc) body.push(acct.desc, '');

    // Wikilinks: use notebook:slug — colon in account paths misleads nb-web's
    // wikilink resolver into treating them as notebook:selector pairs.
    if (parentPath && notebook) {
        const slug = _accountSlug(parentPath);
        body.push(`**Parent:** [[${notebook}:${slug}.md]]`, '');
    }

    if (acct.cra_t1) {
        const url = 'https://www.canada.ca/en/revenue-agency/services/forms-publications/tax-packages-years/general-income-tax-benefit-package.html';
        body.push(`**CRA T1 line ${acct.cra_t1}** — ${acct.cra_label || ''}`);
        body.push(`<a href="term:xdg-open ${url}">T1 General Guide</a>`, '');
    } else if (acct.cra_t2125) {
        const url = 'https://www.canada.ca/en/revenue-agency/services/forms-publications/forms/t2125.html';
        body.push(`**CRA T2125 line ${acct.cra_t2125}** — ${acct.cra_label || ''}`);
        body.push(`<a href="term:xdg-open ${url}">T2125 form</a>`, '');
    }

    body.push(`${balLink} · ${regLink}`);

    return fm.join('\n') + body.join('\n');
}

async function _createAccountNotes(notebook, accounts, journalPath, progressCb) {
    let created = 0;
    let errors  = 0;

    // Seed note template only if it doesn't exist yet — don't overwrite user edits
    const jFlag = journalPath ? ` -f ${journalPath}` : '';
    const existingTpl = await fetch(`/api/templates?notebook=${encodeURIComponent(notebook)}`).then(r => r.json()).catch(() => ({}));
    const tplExists = (existingTpl.templates || []).some(t => t.name === 'account' && t.scope === 'local');
    if (!tplExists) {
        const noteTemplate = [
            '---',
            'title: "{{title}}"',
            'type: account',
            'hledger_account: "{{title}}"',
            '---',
            '## {{title}}',
            '',
            '{{content}}',
            '',
            `<a href="term:hledger${jFlag} bal '{{title}}'">balance</a>` +
                ` · <a href="term:hledger${jFlag} reg '{{title}}'">register</a>`,
        ].join('\n');
        try {
        await fetch('/api/templates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                scope:    'local',
                notebook: notebook,
                name:     'account',
                content:  noteTemplate,
            }),
        });
        } catch (_) {}
    } // end if (!tplExists)
    try {
        await fetch('/api/templates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                scope:    'annotation',
                notebook: notebook,
                content:  '## Private details\n\nInstitution: \nAccount number: \nOnline banking: \nNotes: \n',
            }),
        });
    } catch (_) {}

    for (const acct of accounts) {
        try {
            const body = _noteBodyForAccount(acct, accounts, journalPath, notebook);
            const r = await fetch('/api/notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    notebook,
                    title:            acct.account,
                    template_content: body,
                }),
            });
            if (r.ok) { created++; } else { errors++; }
        } catch (_) { errors++; }
        if (progressCb) progressCb(created, errors, accounts.length);
    }
    return { created, errors };
}

// ── CoA wizard UI ─────────────────────────────────────────────────────────────

function _buildCoaWizard(el, notebook, config) {
    const domains  = Object.entries(_COA_DOMAINS);
    const provinces = Object.entries(_PROVINCES);

    el.innerHTML = `
        <div class="nb-plugin-section nb-hl-coa-wizard">
            <div class="nb-plugin-section-title">Chart of Accounts Setup</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
                <label style="font-size:12px;color:var(--text-dim)">Domain</label>
                <select id="nb-hl-domain" class="nb-scope-select">
                    ${domains.map(([id, d]) =>
                        `<option value="${id}">${_esc(d.label)}</option>`).join('')}
                </select>
                <label style="font-size:12px;color:var(--text-dim)">Province</label>
                <select id="nb-hl-province" class="nb-scope-select">
                    ${provinces.map(([code, p]) =>
                        `<option value="${code}"${code === (config?.province || 'ON') ? ' selected' : ''}>${_esc(p.label)}</option>`).join('')}
                </select>
            </div>
            <div id="nb-hl-coa-opts" style="display:grid;grid-template-columns:1fr 1fr;gap:2px 16px;margin-bottom:10px;font-size:13px"></div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <button id="nb-hl-coa-preview" class="nb-tool-btn">Preview accounts</button>
                <button id="nb-hl-coa-generate" class="nb-tool-btn nb-btn-primary">Generate accounts.journal</button>
                <button id="nb-hl-coa-notes" class="nb-tool-btn">Create account notes</button>
                <button id="nb-hl-coa-rebuild" class="nb-tool-btn" style="color:var(--orange,#e07b39)" title="Delete all type:account notes from this notebook">✕ Delete all accounts</button>
                <span id="nb-hl-coa-status" style="font-size:12px;color:var(--text-dim)"></span>
            </div>
            <pre id="nb-hl-coa-preview-text" style="display:none;font-size:11px;max-height:200px;overflow-y:auto;
                 background:var(--bg-alt,#1a1a1a);padding:8px;border-radius:4px;margin-top:8px;color:var(--text-dim)"></pre>
            <div id="nb-hl-coa-result" style="display:none;margin-top:8px"></div>
        </div>`;

    const domainSel    = el.querySelector('#nb-hl-domain');
    const provinceSel  = el.querySelector('#nb-hl-province');
    const optsEl       = el.querySelector('#nb-hl-coa-opts');
    const previewBtn   = el.querySelector('#nb-hl-coa-preview');
    const generateBtn  = el.querySelector('#nb-hl-coa-generate');
    const createNotesBtn = el.querySelector('#nb-hl-coa-notes');
    const rebuildBtn   = el.querySelector('#nb-hl-coa-rebuild');
    const statusEl     = el.querySelector('#nb-hl-coa-status');
    const previewText  = el.querySelector('#nb-hl-coa-preview-text');
    const resultEl     = el.querySelector('#nb-hl-coa-result');
    let _lastAccounts  = [];

    function getOpts() {
        const opts = {};
        optsEl.querySelectorAll('input[type=checkbox]').forEach(cb => {
            opts[cb.dataset.id] = cb.checked;
        });
        return opts;
    }

    function buildAccounts() {
        const domain   = _COA_DOMAINS[domainSel.value];
        const province = provinceSel.value;
        const opts     = getOpts();
        return domain?.build(opts, province) || [];
    }

    function renderOpts() {
        const domain = _COA_DOMAINS[domainSel.value];
        if (!domain) return;
        optsEl.innerHTML = domain.options.map(opt =>
            `<label style="display:flex;gap:6px;align-items:center;cursor:pointer;padding:2px 0">
                <input type="checkbox" data-id="${opt.id}"${opt.default ? ' checked' : ''}>
                <span>${_esc(opt.label)}</span>
            </label>`
        ).join('');
    }

    domainSel.addEventListener('change', () => { renderOpts(); previewText.style.display = 'none'; resultEl.style.display = 'none'; });
    renderOpts();

    previewBtn.addEventListener('click', () => {
        const accounts = buildAccounts();
        previewText.textContent = accounts.map(a => `account ${a.account}`).join('\n');
        previewText.style.display = 'block';
        statusEl.textContent = `${accounts.length} accounts`;
    });

    generateBtn.addEventListener('click', async () => {
        const accounts = buildAccounts();
        if (!accounts.length) { statusEl.textContent = 'No accounts to generate'; return; }
        generateBtn.disabled = true;
        statusEl.textContent = 'Writing…';

        const domain   = _COA_DOMAINS[domainSel.value];
        const province = _PROVINCES[provinceSel.value];
        const header   = `Generated by NbWeb-hledger\nDomain: ${domain?.label}\nProvince: ${province?.label || provinceSel.value}\nDo not edit this file by hand — regenerate from the plugin page`;

        try {
            const r = await fetch('/api/hledger/coa-generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notebook, accounts, header }),
            });
            const d = await r.json();
            if (d.error) {
                statusEl.textContent = '✗ ' + d.error;
            } else {
                _lastAccounts = accounts;
                statusEl.textContent = `✓ ${accounts.length} accounts written`;
                previewText.style.display = 'none';
                createNotesBtn.style.display = '';
                resultEl.style.display = 'block';
                resultEl.innerHTML = `
                    <div style="font-size:12px;background:var(--bg-alt,#1a1a1a);padding:8px;border-radius:4px;border:1px solid var(--border,#333)">
                        <div style="color:var(--green,#4caf50);margin-bottom:4px">✓ Written to <code>${_esc(d.path)}</code></div>
                        ${d.include_needed ? `
                        <div style="margin-top:6px;color:var(--text-dim)">Add this line to your main journal:</div>
                        <code style="display:block;margin-top:4px;padding:4px 8px;background:var(--bg,#111);border-radius:3px">${_esc(d.include_line)}</code>
                        ` : '<div style="color:var(--text-dim);margin-top:4px">✓ Main journal already includes accounts.journal</div>'}
                    </div>`;
            }
        } catch (e) {
            statusEl.textContent = '✗ ' + e.message;
        }
        generateBtn.disabled = false;
    });

    createNotesBtn.addEventListener('click', async () => {
        const accounts = _lastAccounts.length ? _lastAccounts : buildAccounts();
        if (!accounts.length) { statusEl.textContent = 'No accounts'; return; }
        createNotesBtn.disabled = true;
        const journalPath = config?.journal || null;
        statusEl.textContent = `Creating notes… 0 / ${accounts.length}`;
        const { created, errors } = await _createAccountNotes(
            notebook, accounts, journalPath,
            (done, errs, total) => {
                statusEl.textContent = `Creating notes… ${done + errs} / ${total}`;
            }
        );
        statusEl.textContent = `✓ ${created} notes created${errors ? ` (${errors} errors)` : ''}`;
        createNotesBtn.disabled = false;
        if (typeof NbWeb !== 'undefined') NbWeb.refreshList?.();
    });

    rebuildBtn.addEventListener('click', async () => {
        rebuildBtn.disabled = true;
        statusEl.textContent = 'Deleting account notes…';
        try {
            const r = await fetch('/api/hledger/clear-account-notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notebook }),
            });
            const d = await r.json();
            if (d.error) { statusEl.textContent = '✗ ' + d.error; return; }
            statusEl.textContent = `✓ Deleted ${d.deleted} account notes`;
            if (typeof NbWeb !== 'undefined') NbWeb.refreshList?.();
        } catch (e) {
            statusEl.textContent = '✗ ' + e.message;
        } finally {
            rebuildBtn.disabled = false;
        }
    });
}

// ── pluginContent ─────────────────────────────────────────────────────────────

async function _buildPluginContent(el, notebook, config) {
    const journal = config?.journal || '(not set)';
    const province = config?.province || '—';
    const entity   = config?.entity   || '—';
    const prov     = _PROVINCES[province];

    // Health summary
    const summaryHtml = `
        <div class="nb-plugin-section">
            <div class="nb-plugin-section-title">Journal</div>
            <table style="font-size:12px;border-collapse:collapse;width:100%">
                <tr><td style="color:var(--text-dim);padding:2px 8px 2px 0">File</td>
                    <td><code>${_esc(journal)}</code></td></tr>
                <tr><td style="color:var(--text-dim);padding:2px 8px 2px 0">Province</td>
                    <td>${_esc(prov?.label || province)}</td></tr>
                <tr><td style="color:var(--text-dim);padding:2px 8px 2px 0">Entity</td>
                    <td>${_esc(entity)}</td></tr>
                ${config?.commodity ? `<tr><td style="color:var(--text-dim);padding:2px 8px 2px 0">Commodity</td>
                    <td>${_esc(config.commodity)}</td></tr>` : ''}
            </table>
        </div>`;

    el.innerHTML = summaryHtml;
    _buildCoaWizard(el, notebook, config);

    // Async: fetch account count
    _getAccounts(notebook).then(accounts => {
        if (!accounts.length) return;
        const table = el.querySelector('table');
        if (!table) return;
        const row = document.createElement('tr');
        row.innerHTML = `<td style="color:var(--text-dim);padding:2px 8px 2px 0">Accounts</td>
                         <td>${accounts.length} defined</td>`;
        table.appendChild(row);
    });
}

// ── previewRenderer ───────────────────────────────────────────────────────────

function _renderAccountNote(note) {
    if (note.type !== 'account' || !note.meta) return null;
    const m = note.meta;
    const rows = [
        ['Account',  m.hledger_account || note.title],
        ['Type',     m.account_type],
        ['Domain',   m.domain],
        m.cra_t1     && ['CRA T1 line', `${m.cra_t1}${m.cra_label ? ' — ' + m.cra_label : ''}`],
        m.cra_t2125  && ['CRA T2125',   `${m.cra_t2125}${m.cra_label ? ' — ' + m.cra_label : ''}`],
        m.deductible_rate && ['Deductible', `${m.deductible_rate * 100}%`],
    ].filter(Boolean);

    const tableHtml = rows.map(([k, v]) => v
        ? `<tr><td style="color:var(--text-dim);padding:2px 12px 2px 0;white-space:nowrap">${_esc(k)}</td>
               <td>${_esc(String(v))}</td></tr>`
        : ''
    ).join('');

    // Preprocess wikilinks before marked so _enrichRendered can wire click handlers.
    // Also substitute {title} so hledger codeblocks get the actual account name.
    const acctName = m.hledger_account || note.title || '';
    let body = (note.body || '').trim().replace(/\{title\}/g, acctName);
    body = body.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) =>
        `<span class="nb-wiki-link" data-selector="${_esc(target)}"${label ? '' : ' data-autolabel="1"'}>${_esc(label || target)}</span>`);
    const bodyHtml = body
        ? `<div class="nb-rendered" style="margin-top:12px">${typeof marked !== 'undefined' ? marked.parse(body) : `<pre>${_esc(body)}</pre>`}</div>`
        : '';

    return `<div class="nb-hl-account-note">
        <table style="font-size:13px;border-collapse:collapse;margin-bottom:8px">${tableHtml}</table>
        ${bodyHtml}
    </div>`;
}

// ── Plugin registration ───────────────────────────────────────────────────────

NbWeb.registerModule('hledger', {
    label:              'NbWeb-hledger',
    contentButtonIcon:  '⚡',
    contentButtonLabel: 'Wizard',
    description: 'Plain-text accounting with domain knowledge — Canadian CoA, tax mappings, journal health',
    helpUrl:     '/plugins/nbweb-hledger.md',

    detect: notebooks => notebooks.filter(nb => nb.hledger != null),

    requirementCheck: async () => {
        const w = await NbWeb.checkWhich('hledger');
        if (!w.found)
            return { ok: false, markdownFile: '/plugins/requirements/hledger-requirements.md' };
        const hledgerNbs = NbWeb.notebooks().filter(nb => nb.hledger != null);
        if (!hledgerNbs.length)
            return { ok: false, markdownFile: '/plugins/requirements/hledger-setup.md' };
        return { ok: true };
    },

    pluginContent: async (el) => {
        const hledgerNbs = NbWeb.notebooks().filter(nb => nb.hledger != null);
        if (!hledgerNbs.length) return;
        const nb = hledgerNbs[0];
        await _buildPluginContent(el, nb.name, nb.hledger);
    },

    listDefaults: { listType: 'account', sortOrder: 'account-hierarchy' },

    sortOptions: [
        {
            id:    'account-hierarchy',
            label: 'Account hierarchy',
            sort:  notes => [...notes].sort((a, b) =>
                (a.meta?.hledger_account || a.title || '').localeCompare(
                 b.meta?.hledger_account || b.title || '')),
        },
        {
            id:    'cra-line',
            label: 'CRA line',
            sort:  notes => [...notes].sort((a, b) => {
                const la = Number(a.meta?.cra_t1 || a.meta?.cra_t2125 || 99999);
                const lb = Number(b.meta?.cra_t1 || b.meta?.cra_t2125 || 99999);
                return la - lb;
            }),
        },
    ],

    listItemIcon: note => {
        if (note.type === 'account')  return '📒';
        if (note.type === 'template') return '📋';
        if (note.type === 'period')   return '📅';
        if (note.type === 'report')   return '📊';
        return null;
    },

    listTitle: note => {
        if (note.type !== 'account' || !note.meta) return null;
        const acct = note.meta.hledger_account || note.title || '';
        const lbl  = note.meta.cra_label ? ` — ${note.meta.cra_label}` : '';
        return acct + lbl || null;
    },

    previewRenderer: note => {
        if (note.type === 'account') return _renderAccountNote(note);
        return null;
    },
});

// Expose accounts getter so NbWeb-codeblocks can wire autocomplete
window.NbHledger = { getAccounts: _getAccounts };

})();

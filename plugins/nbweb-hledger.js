// NbWeb-hledger — plain-text accounting with domain knowledge
// Chart of accounts wizard, Canadian tax mappings, journal health, account autocomplete.
// AGPL v3 — https://github.com/linuxcaffe/nbweb-hledger
// @name     NbWeb hledger
// @version  0.1.0
// @type     ecosystem
// @homepage
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

let _bkPanelMode = localStorage.getItem('nb-hl-panel-mode') || 'bookkeeper';

// ── Account note generation ───────────────────────────────────────────────────

// Slug matching api_create_note: re.sub(r'[^\w]+', '_', title).strip('_').lower()
function _accountSlug(accountPath) {
    return accountPath.replace(/[^\w]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
}

// Returns the {{content}} portion for a single account — desc, parent link, CRA info.
// Does NOT include term: links or codeblocks; those live in the template.
function _accountContent(acct, allAccounts, notebook) {
    const parentPath = acct.account.includes(':')
        ? acct.account.split(':').slice(0, -1).join(':') : null;

    // Direct children only (one level deeper, no further nesting)
    const children = allAccounts.filter(a => {
        if (!a.account.startsWith(acct.account + ':')) return false;
        const rest = a.account.slice(acct.account.length + 1);
        return !rest.includes(':');
    });

    const lines = [];
    if (acct.desc) lines.push(acct.desc, '');
    if (parentPath && notebook) {
        const slug = _accountSlug(parentPath);
        lines.push(`**Parent:** [[${notebook}:accounts/${slug}.md]]`, '');
    }
    if (children.length && notebook) {
        const childLinks = children
            .map(c => `[[${notebook}:accounts/${_accountSlug(c.account)}.md]]`)
            .join(' · ');
        lines.push(`**Sub-accounts:** ${childLinks}`, '');
    }
    if (acct.cra_t1) {
        const url = 'https://www.canada.ca/en/revenue-agency/services/forms-publications/tax-packages-years/general-income-tax-benefit-package.html';
        lines.push(`**CRA T1 line ${acct.cra_t1}** — ${acct.cra_label || ''}`);
        lines.push(`<a href="term:xdg-open ${url}">T1 General Guide</a>`, '');
    } else if (acct.cra_t2125) {
        const url = 'https://www.canada.ca/en/revenue-agency/services/forms-publications/forms/t2125.html';
        lines.push(`**CRA T2125 line ${acct.cra_t2125}** — ${acct.cra_label || ''}`);
        lines.push(`<a href="term:xdg-open ${url}">T2125 form</a>`, '');
    }
    return lines.join('\n').trimEnd();
}

// Build frontmatter only — body comes from the template.
function _accountFrontmatter(acct) {
    const fm = ['---', `title: "${acct.account}"`, 'type: account',
                `hledger_account: "${acct.account}"`];
    if (acct.type)      fm.push(`account_type: "${acct.type}"`);
    if (acct.cra_label) fm.push(`cra_label: "${acct.cra_label}"`);
    if (acct.cra_t1)    fm.push(`cra_line_t1: "${acct.cra_t1}"`);
    if (acct.cra_t2125) fm.push(`cra_line_t2125: "${acct.cra_t2125}"`);
    fm.push('---');
    return fm.join('\n');
}

function _expandAccountTree(accounts) {
    const byPath = new Map(accounts.map(a => [a.account, a]));
    const extra  = [];
    for (const acct of accounts) {
        const parts = acct.account.split(':');
        for (let i = 1; i < parts.length; i++) {
            const ancestor = parts.slice(0, i).join(':');
            if (!byPath.has(ancestor)) {
                byPath.set(ancestor, { account: ancestor, type: acct.type });
                extra.push({ account: ancestor, type: acct.type });
            }
        }
    }
    // Insert ancestors before their children so parent notes exist first
    const sorted = [...extra, ...accounts];
    sorted.sort((a, b) => a.account.localeCompare(b.account));
    return sorted;
}

async function _createAccountNotes(notebook, accounts, journalPath, progressCb) {
    let created = 0;
    let errors  = 0;
    accounts = _expandAccountTree(accounts);

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

    // Fetch the account template once — all notes are built from it.
    // Falls back to a minimal inline body if the template is missing.
    let tplBody = null;
    try {
        const tplList = await fetch(`/api/templates?notebook=${encodeURIComponent(notebook)}`).then(r => r.json());
        const tplMeta = (tplList.templates || []).find(t => t.name === 'account' && t.scope === 'local');
        if (tplMeta?.path) {
            const tplData = await fetch(`/api/template?path=${encodeURIComponent(tplMeta.path)}`).then(r => r.json());
            tplBody = tplData.content || null;
        }
    } catch (_) {}

    for (const acct of accounts) {
        try {
            const content = _accountContent(acct, accounts, notebook);
            let noteText;
            if (tplBody) {
                // Substitute {{title}} and {{content}} into the template.
                // Frontmatter is rebuilt from scratch so CRA fields are included.
                const bodyPart = tplBody
                    .replace(/^---[\s\S]*?---\n?/, '')   // strip template's own FM
                    .replace(/\{\{title\}\}/g, acct.account)
                    .replace(/\{\{content\}\}/g, content);
                noteText = _accountFrontmatter(acct) + '\n' + bodyPart;
            } else {
                // Minimal fallback if template missing
                noteText = _accountFrontmatter(acct) + '\n## ' + acct.account.split(':').pop() + '\n\n' + content;
            }
            const r = await fetch('/api/notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notebook, folder: 'accounts', title: acct.account, template_content: noteText }),
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

// ── Shared helpers ────────────────────────────────────────────────────────────

function _dateFromActiveNote() {
    const fn = typeof NbMain !== 'undefined' ? (NbMain.activeFilename() || '') : '';
    const m  = fn.match(/^(\d{4})(\d{2})(\d{2})\b/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : new Date().toISOString().slice(0, 10);
}

function _negateAmt(s) {
    s = (s || '').trim();
    return s.startsWith('-') ? s.slice(1).trim() : s ? '-' + s : '';
}

// ── Setup panel (journal info + CoA wizard) ───────────────────────────────────

// ── Aliases panel ─────────────────────────────────────────────────────────────

async function _buildAliasesPanel(containerEl, notebook) {
    const wrap = document.createElement('div');
    wrap.className = 'nb-plugin-section';
    wrap.innerHTML = `
        <div class="nb-plugin-section-title">Import Aliases
            <span style="font-size:11px;color:var(--text-dim);font-weight:normal;margin-left:8px">
                payee pattern → account mapping for CSV import
            </span>
        </div>
        <div id="nb-hl-aliases-list" style="margin-bottom:8px"></div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
            <input id="nb-hl-alias-pattern" type="text" placeholder="AMAZON.*"
                   style="width:160px;font-size:12px;padding:2px 6px;background:var(--bg-input,#2a2a2a);
                          color:var(--text);border:1px solid var(--border,#444);border-radius:3px">
            <span style="font-size:12px;color:var(--text-dim)">=</span>
            <input id="nb-hl-alias-account" type="text" placeholder="Expenses:Shopping"
                   style="width:200px;font-size:12px;padding:2px 6px;background:var(--bg-input,#2a2a2a);
                          color:var(--text);border:1px solid var(--border,#444);border-radius:3px">
            <button id="nb-hl-alias-add" class="nb-tool-btn">Add</button>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
            <button id="nb-hl-aliases-save" class="nb-tool-btn nb-btn-primary">Save aliases.journal</button>
            <span id="nb-hl-aliases-status" style="font-size:12px;color:var(--text-dim)"></span>
        </div>`;
    containerEl.appendChild(wrap);

    let aliases = [];

    function _renderList() {
        const list = wrap.querySelector('#nb-hl-aliases-list');
        if (!aliases.length) {
            list.innerHTML = '<span style="font-size:12px;color:var(--text-dim)">No aliases yet — add one above.</span>';
            return;
        }
        list.innerHTML = aliases.map((a, i) =>
            `<div style="display:flex;gap:8px;align-items:center;margin-bottom:3px;font-size:12px">
                <code style="color:var(--text-dim)">${_esc(a.pattern)}</code>
                <span style="color:var(--text-dim)">→</span>
                <code>${_esc(a.account)}</code>
                <button class="nb-tool-btn nb-hl-alias-del" data-idx="${i}"
                        style="padding:0 5px;font-size:11px;line-height:1.4;color:var(--orange,#e07b39)">✕</button>
            </div>`
        ).join('');
        list.querySelectorAll('.nb-hl-alias-del').forEach(btn => {
            btn.addEventListener('click', () => {
                aliases.splice(Number(btn.dataset.idx), 1);
                _renderList();
            });
        });
    }

    const status = wrap.querySelector('#nb-hl-aliases-status');

    // Load existing aliases
    try {
        const data = await fetch(`/api/hledger/aliases?notebook=${encodeURIComponent(notebook)}`).then(r => r.json());
        aliases = data.aliases || [];
        if (data.include_needed && data.include_line) {
            status.textContent = `Tip: add "${data.include_line}" to your main journal to activate aliases`;
        }
    } catch (_) {}
    _renderList();

    wrap.querySelector('#nb-hl-alias-add').addEventListener('click', () => {
        const pattern = wrap.querySelector('#nb-hl-alias-pattern').value.trim();
        const account = wrap.querySelector('#nb-hl-alias-account').value.trim();
        if (!pattern || !account) return;
        aliases.push({ pattern, account });
        wrap.querySelector('#nb-hl-alias-pattern').value = '';
        wrap.querySelector('#nb-hl-alias-account').value = '';
        _renderList();
    });

    // Enter key in account field triggers add
    wrap.querySelector('#nb-hl-alias-account').addEventListener('keydown', e => {
        if (e.key === 'Enter') wrap.querySelector('#nb-hl-alias-add').click();
    });

    wrap.querySelector('#nb-hl-aliases-save').addEventListener('click', async () => {
        const saveBtn = wrap.querySelector('#nb-hl-aliases-save');
        saveBtn.disabled = true;
        status.textContent = 'Saving…';
        try {
            const r = await fetch('/api/hledger/aliases', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notebook, aliases }),
            });
            const d = await r.json();
            if (d.ok) {
                status.textContent = `Saved to ${d.path.split('/').pop()}`;
                if (d.include_needed) {
                    status.textContent += ` — add "${d.include_line}" to your main journal`;
                }
            } else {
                status.textContent = `Error: ${d.error}`;
            }
        } catch (e) {
            status.textContent = `Error: ${e.message}`;
        }
        saveBtn.disabled = false;
    });
}

function _buildSetupPanel(el, notebook, config) {
    const journal  = config?.journal || '(not set)';
    const province = config?.province || '—';
    const entity   = config?.entity   || '—';
    const prov     = _PROVINCES[province];

    el.innerHTML = `
        <div class="nb-plugin-section">
            <div class="nb-plugin-section-title">Journal</div>
            <table id="nb-hl-setup-info" style="font-size:12px;border-collapse:collapse;width:100%">
                <tr><td style="color:var(--text-dim);padding:2px 8px 2px 0">File</td>
                    <td><code>${_esc(journal)}</code></td></tr>
                <tr><td style="color:var(--text-dim);padding:2px 8px 2px 0">Province</td>
                    <td>${_esc(prov?.label || province)}</td></tr>
                <tr><td style="color:var(--text-dim);padding:2px 8px 2px 0">Entity</td>
                    <td>${_esc(entity)}</td></tr>
                ${config?.commodity ? `<tr><td style="color:var(--text-dim);padding:2px 8px 2px 0">Commodity</td>
                    <td>${_esc(config.commodity)}</td></tr>` : ''}
            </table>
        </div>
        <div id="nb-hl-coa-container"></div>`;

    _buildCoaWizard(el.querySelector('#nb-hl-coa-container'), notebook, config);
    _buildAliasesPanel(el.querySelector('#nb-hl-coa-container'), notebook);

    _getAccounts(notebook).then(accounts => {
        if (!accounts.length) return;
        const table = el.querySelector('#nb-hl-setup-info');
        if (!table) return;
        const row = document.createElement('tr');
        row.innerHTML = `<td style="color:var(--text-dim);padding:2px 8px 2px 0">Accounts</td>
                         <td>${accounts.length} defined</td>`;
        table.appendChild(row);
    });
}

// ── Bookkeeper: inline add-transaction form ────────────────────────────────────

function _buildBkAddSection(container, notebook, config) {
    const journal = config?.journal || '';

    function makeRow() {
        const row = document.createElement('div');
        row.className = 'nb-hl-posting-row';
        row.innerHTML = `
            <input type="text" class="nb-hl-inp nb-hl-acc-inp" placeholder="account" autocomplete="off" spellcheck="false">
            <input type="text" class="nb-hl-inp nb-hl-amt-inp" placeholder="amount">
            <button class="nb-tw-btn nb-hl-rm-row" title="Remove">✕</button>`;
        row.querySelector('.nb-hl-rm-row').addEventListener('click', () => {
            if (postings.querySelectorAll('.nb-hl-posting-row').length > 2) row.remove();
        });
        return row;
    }

    container.innerHTML = `
        <div class="nb-hl-addform-top">
            <input type="date" class="nb-hl-inp nb-hl-date-inp" value="${_dateFromActiveNote()}">
            <input type="text" class="nb-hl-inp nb-hl-desc-inp" placeholder="Description" autocomplete="off">
        </div>
        <div class="nb-hl-postings"></div>
        <div class="nb-hl-addform-footer">
            <button class="nb-tw-btn nb-hl-btn nb-hl-add-row">+ row</button>
            <input type="text" class="nb-hl-inp nb-hl-comment-inp" placeholder="; comment (optional)" autocomplete="off" spellcheck="false">
            <button class="nb-btn-primary nb-hl-save-btn">Save</button>
            <button class="nb-tw-btn nb-hl-bk-add-close" title="Close">✕</button>
            <span class="nb-hl-form-status"></span>
        </div>`;

    const postings = container.querySelector('.nb-hl-postings');
    const row1 = makeRow(); postings.appendChild(row1);
    const row2 = makeRow(); postings.appendChild(row2);
    const amt1 = row1.querySelector('.nb-hl-amt-inp');
    const amt2 = row2.querySelector('.nb-hl-amt-inp');
    amt1.addEventListener('input', () => { if (!amt2._edited) amt2.value = _negateAmt(amt1.value); });
    amt2.addEventListener('input', () => { amt2._edited = amt2.value !== '' && amt2.value !== _negateAmt(amt1.value); });

    container.querySelector('.nb-hl-add-row').addEventListener('click', () => postings.appendChild(makeRow()));
    container.querySelector('.nb-hl-bk-add-close').addEventListener('click', () => {
        container.hidden = true;
        container.closest('.nb-hl-bk-add-wrap')?.querySelector('.nb-hl-bk-add-btn')?.classList.remove('nb-active');
    });

    container.querySelector('.nb-hl-save-btn').addEventListener('click', async () => {
        const status = container.querySelector('.nb-hl-form-status');
        const date    = container.querySelector('.nb-hl-date-inp').value;
        const desc    = container.querySelector('.nb-hl-desc-inp').value.trim();
        const comment = container.querySelector('.nb-hl-comment-inp').value.trim();
        const rows    = [...postings.querySelectorAll('.nb-hl-posting-row')].map(r => ({
            account: r.querySelector('.nb-hl-acc-inp').value.trim(),
            amount:  r.querySelector('.nb-hl-amt-inp').value.trim(),
        })).filter(p => p.account);
        if (!date || !desc) { status.textContent = 'Date and description required'; return; }
        if (!rows.length)   { status.textContent = 'At least one posting required'; return; }
        status.textContent = 'Saving…';
        try {
            const r = await fetch('/api/hledger-add', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({date, description: desc, postings: rows,
                    ...(comment && {comment}),
                    ...(journal && {file: journal})})
            });
            const d = await r.json();
            if (d.error) { status.textContent = '✗ ' + d.error; return; }
            status.textContent = '✓ Saved';
            container.querySelector('.nb-hl-desc-inp').value = '';
            container.querySelector('.nb-hl-comment-inp').value = '';
            postings.querySelectorAll('.nb-hl-amt-inp').forEach(i => { i.value = ''; i._edited = false; });
            postings.querySelectorAll('.nb-hl-acc-inp').forEach(i => i.value = '');
            [...postings.querySelectorAll('.nb-hl-posting-row')].slice(2).forEach(r => r.remove());
            container.querySelector('.nb-hl-desc-inp').focus();
        } catch (e) { status.textContent = '✗ ' + e.message; }
    });

    // Account autocomplete (best-effort)
    fetch(`/api/hledger/accounts?notebook=${encodeURIComponent(notebook)}`).then(r => r.json()).then(d => {
        const accounts = d.accounts || [];
        if (!accounts.length || !container.isConnected) return;
        const dlId = 'nb-hl-bk-acc-dl';
        let dl = document.getElementById(dlId);
        if (!dl) {
            dl = document.createElement('datalist'); dl.id = dlId;
            accounts.forEach(a => { const o = document.createElement('option'); o.value = a; dl.appendChild(o); });
            container.appendChild(dl);
        }
        container.querySelectorAll('.nb-hl-acc-inp').forEach(i => i.setAttribute('list', dlId));
    }).catch(() => {});

    container.querySelector('.nb-hl-desc-inp').focus();
}

// ── Files panel (import / export) ─────────────────────────────────────────────

async function _buildFilesPanel(el, notebook, config) {
    const today     = new Date().toISOString().slice(0, 10);
    const yearStart = today.slice(0, 4) + '-01-01';
    const defOut    = (config?.journal || '').replace(/(\.[^.]+)$/, `.${today.slice(0, 4)}$1`) || '';

    el.innerHTML = `
        <div class="nb-plugin-section">
            <div class="nb-plugin-section-title">Export — Daily Notes → File</div>
            <div class="nb-hl-files-row">
                <label class="nb-hl-files-lbl">From</label>
                <input type="date" class="nb-hl-inp nb-hl-files-from" value="${yearStart}">
                <label class="nb-hl-files-lbl">To</label>
                <input type="date" class="nb-hl-inp nb-hl-files-to" value="${today}">
            </div>
            <div class="nb-hl-files-row" style="margin-top:5px">
                <label class="nb-hl-files-lbl">Output</label>
                <input type="text" class="nb-hl-inp nb-hl-files-out" style="flex:1"
                       placeholder="~/path/to/export.journal" value="${_esc(defOut)}">
            </div>
            <div class="nb-hl-files-row" style="margin-top:8px">
                <button class="nb-btn-primary nb-hl-files-exp-btn">Export</button>
                <span class="nb-hl-files-status nb-hl-exp-status"></span>
            </div>
        </div>
        <div class="nb-plugin-section">
            <div class="nb-plugin-section-title">Import — File → Daily Notes</div>
            <div class="nb-hl-files-row">
                <label class="nb-hl-files-lbl">File</label>
                <input type="text" class="nb-hl-inp nb-hl-files-in" style="flex:1"
                       placeholder="~/path/to/import.journal">
            </div>
            <div class="nb-hl-files-row" style="margin-top:5px">
                <label class="nb-hl-files-lbl">From</label>
                <input type="date" class="nb-hl-inp nb-hl-files-ifrom">
                <label class="nb-hl-files-lbl">To</label>
                <input type="date" class="nb-hl-inp nb-hl-files-ito">
            </div>
            <div class="nb-hl-files-row" style="margin-top:8px">
                <button class="nb-btn-primary nb-hl-files-imp-btn">Import</button>
                <span class="nb-hl-files-status nb-hl-imp-status"></span>
            </div>
            <div style="font-size:11px;color:var(--text-dim);margin-top:6px">
                Transactions are appended to existing daily notes, or new notes are created.
            </div>
        </div>`;

    el.querySelector('.nb-hl-files-exp-btn').addEventListener('click', async () => {
        const st  = el.querySelector('.nb-hl-exp-status');
        const out = el.querySelector('.nb-hl-files-out').value.trim();
        if (!out) { st.textContent = 'Output path required'; return; }
        st.textContent = 'Exporting…';
        try {
            const r = await fetch('/api/hledger/export-daily', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({notebook,
                    from: el.querySelector('.nb-hl-files-from').value,
                    to:   el.querySelector('.nb-hl-files-to').value,
                    output: out})
            });
            const d = await r.json();
            if (d.error) { st.textContent = '✗ ' + d.error; return; }
            st.textContent = `✓ ${d.blocks} block${d.blocks !== 1 ? 's' : ''} → ${d.path}`;
        } catch (e) { st.textContent = '✗ ' + e.message; }
    });

    el.querySelector('.nb-hl-files-imp-btn').addEventListener('click', async () => {
        const st   = el.querySelector('.nb-hl-imp-status');
        const file = el.querySelector('.nb-hl-files-in').value.trim();
        if (!file) { st.textContent = 'File path required'; return; }
        st.textContent = 'Importing…';
        try {
            const r = await fetch('/api/hledger/import-daily', {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({notebook, file,
                    from: el.querySelector('.nb-hl-files-ifrom').value || undefined,
                    to:   el.querySelector('.nb-hl-files-ito').value   || undefined})
            });
            const d = await r.json();
            if (d.error) { st.textContent = '✗ ' + d.error; return; }
            const errs = d.errors?.length ? ` (${d.errors.length} error${d.errors.length !== 1 ? 's' : ''})` : '';
            st.textContent = `✓ ${d.created} created, ${d.updated} updated${errs}`;
        } catch (e) { st.textContent = '✗ ' + e.message; }
    });
}

// ── Bookkeeper panel (daily use) ──────────────────────────────────────────────

async function _buildBookkeeperPanel(el, notebook, config) {
    const journal = config?.journal;
    if (!journal) {
        el.innerHTML = `<div class="nb-plugin-section" style="color:var(--text-dim);font-size:13px">
            No journal configured — use the <strong>Setup</strong> tab to configure your journal.</div>`;
        return;
    }

    const q = cmd => `/api/hledger-query?q=${encodeURIComponent(journal + ' ' + cmd)}&format=text`;

    el.innerHTML = `
        <div class="nb-hl-bk-add-wrap nb-plugin-section" style="padding-bottom:4px">
            <button class="nb-tw-btn nb-hl-bk-add-btn" style="width:100%;text-align:left">+ Add Transaction</button>
            <div class="nb-hl-addform nb-hl-bk-add-form" hidden></div>
        </div>
        <div class="nb-plugin-section" id="nb-hl-bk-health">
            <div class="nb-plugin-section-title">Journal Health</div>
            <div id="nb-hl-bk-health-body" class="nb-hl-bk-loading">Checking…</div>
        </div>
        <div class="nb-plugin-section" id="nb-hl-bk-period">
            <div class="nb-plugin-section-title">This Month</div>
            <div id="nb-hl-bk-period-body" class="nb-hl-bk-loading">Loading…</div>
        </div>
        <div class="nb-plugin-section" id="nb-hl-bk-recent">
            <div class="nb-plugin-section-title">Transactions This Month</div>
            <div id="nb-hl-bk-recent-body" class="nb-hl-bk-loading">Loading…</div>
        </div>`;

    // Wire add-transaction toggle
    const addBtn  = el.querySelector('.nb-hl-bk-add-btn');
    const addForm = el.querySelector('.nb-hl-bk-add-form');
    let   _addBuilt = false;
    addBtn.addEventListener('click', () => {
        const showing = !addForm.hidden;
        addForm.hidden = showing;
        addBtn.classList.toggle('nb-active', !showing);
        if (!showing && !_addBuilt) {
            _addBuilt = true;
            _buildBkAddSection(addForm, notebook, config);
        } else if (!showing) {
            addForm.querySelector('.nb-hl-date-inp').value = _dateFromActiveNote();
            addForm.querySelector('.nb-hl-desc-inp')?.focus();
        }
    });

    const [healthR, periodR, recentR] = await Promise.allSettled([
        fetch(q('check')).then(r => r.json()),
        fetch(q('is -p thismonth')).then(r => r.json()),
        fetch(q('reg -p thismonth')).then(r => r.json()),
    ]);

    const healthBody = el.querySelector('#nb-hl-bk-health-body');
    if (healthR.status === 'fulfilled' && !healthR.value?.error) {
        healthBody.innerHTML = '<span style="color:var(--green,#4caf50)">✓ No errors found</span>';
    } else {
        const msg = (healthR.status === 'fulfilled' ? healthR.value?.error : healthR.reason?.message) || 'check failed';
        healthBody.innerHTML = `<pre class="nb-hl-bk-pre" style="color:var(--orange,#e07b39)">${_esc(msg)}</pre>`;
    }

    function _renderText(r, fallback) {
        if (r.status !== 'fulfilled') return `<span class="nb-hl-empty">${_esc(r.reason?.message || 'request failed')}</span>`;
        if (r.value?.error)           return `<span class="nb-hl-empty">${_esc(r.value.error)}</span>`;
        const raw = r.value?.text;
        if (!raw || !raw.trim())      return `<span class="nb-hl-empty">${fallback}</span>`;
        return `<pre class="nb-hl-bk-pre">${_esc(raw)}</pre>`;
    }

    el.querySelector('#nb-hl-bk-period-body').innerHTML  = _renderText(periodR, 'No transactions this month');
    el.querySelector('#nb-hl-bk-recent-body').innerHTML  = _renderText(recentR, 'No transactions found');
}

// ── pluginContent ─────────────────────────────────────────────────────────────

async function _buildTutorialPanel(el, notebook) {
    el.innerHTML = '<div style="padding:8px;color:var(--text-dim);font-size:12px">Loading tutorial…</div>';
    try {
        const r = await fetch(`/api/list?notebook=${encodeURIComponent(notebook)}&folder=tutorial&limit=50`);
        const d = await r.json();
        const notes = (d.notes || []).filter(n => n.type !== 'folder');
        if (!notes.length) {
            el.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--text-dim)">No tutorial notes found in <code>tutorial/</code>.</div>';
            return;
        }
        el.innerHTML = notes.map(n => {
            const title = (n.title || n.filename || n.selector).replace(/^\d+_/, '').replace(/_/g, ' ');
            return `<div class="nb-hl-tut-item" data-selector="${_esc(n.selector)}"
                        style="padding:5px 10px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border-dim,#333);
                               display:flex;align-items:center;gap:6px">
                        <span style="color:var(--text-dim);font-size:11px;font-family:var(--font-mono)">${_esc(n.id || '')}</span>
                        <span>${_esc(n.title || title)}</span>
                    </div>`;
        }).join('');
        el.querySelectorAll('.nb-hl-tut-item').forEach(item => {
            item.addEventListener('mouseenter', () => item.style.background = 'var(--bg-hover,#2a2a2a)');
            item.addEventListener('mouseleave', () => item.style.background = '');
            item.addEventListener('click', () => NbMain.openNote(item.dataset.selector));
        });
    } catch (e) {
        el.innerHTML = `<div style="padding:12px;font-size:12px;color:var(--text-dim)">Error: ${_esc(e.message)}</div>`;
    }
}

async function _buildPluginContent(el, notebook, config) {
    el.innerHTML = `
        <div class="nb-hl-panel-tabs">
            <button class="nb-hl-panel-tab${_bkPanelMode === 'bookkeeper' ? ' nb-active' : ''}" data-mode="bookkeeper">Bookkeeper</button>
            <button class="nb-hl-panel-tab${_bkPanelMode === 'tutorial'   ? ' nb-active' : ''}" data-mode="tutorial">Tutorial</button>
            <button class="nb-hl-panel-tab${_bkPanelMode === 'setup'      ? ' nb-active' : ''}" data-mode="setup">Setup</button>
            <button class="nb-hl-panel-tab${_bkPanelMode === 'files'      ? ' nb-active' : ''}" data-mode="files">Files</button>
        </div>
        <div id="nb-hl-panel-body"></div>`;

    el.querySelectorAll('.nb-hl-panel-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            _bkPanelMode = btn.dataset.mode;
            localStorage.setItem('nb-hl-panel-mode', _bkPanelMode);
            _buildPluginContent(el, notebook, config);
        });
    });

    const body = el.querySelector('#nb-hl-panel-body');
    if (_bkPanelMode === 'setup') {
        _buildSetupPanel(body, notebook, config);
    } else if (_bkPanelMode === 'tutorial') {
        await _buildTutorialPanel(body, notebook);
    } else if (_bkPanelMode === 'files') {
        await _buildFilesPanel(body, notebook, config);
    } else {
        await _buildBookkeeperPanel(body, notebook, config);
    }
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

// ── Chart codeblock ───────────────────────────────────────────────────────────

let _chartJsLoading = false;
let _chartJsReady   = false;
const _chartJsCallbacks = [];

function _loadChartJs(cb) {
    if (_chartJsReady) { cb(); return; }
    _chartJsCallbacks.push(cb);
    if (_chartJsLoading) return;
    _chartJsLoading = true;
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js';
    s.onload = () => {
        _chartJsReady = true;
        _chartJsCallbacks.splice(0).forEach(fn => fn());
    };
    document.head.appendChild(s);
}

function _fmtCcy(v) {
    const abs = Math.abs(v);
    const s   = abs >= 1000 ? abs.toLocaleString(undefined, {maximumFractionDigits: 0})
                            : abs.toFixed(2);
    return (v < 0 ? '-' : '') + s;
}

function _drawChart(canvas, report, data, altView = false) {
    const labels = data.labels;

    const green  = 'rgba(100,200,100,0.8)';
    const red    = 'rgba(250,100,100,0.8)';
    const blue   = 'rgba(100,140,250,1)';
    const teal   = 'rgba(80,200,200,0.8)';
    const purple = 'rgba(180,100,250,0.8)';

    const baseOpts = {
        plugins: {
            legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
            tooltip: {
                callbacks: {
                    label: ctx => ` ${ctx.dataset.label}: ${_fmtCcy(ctx.parsed.y)}`
                }
            }
        },
        scales: {
            y: { ticks: { callback: v => _fmtCcy(v) } }
        }
    };

    if (report === 'cashflow') {
        new Chart(canvas, {
            data: {
                labels,
                datasets: [
                    { type: 'bar',   label: 'Income',     data: data.income,     backgroundColor: green },
                    { type: 'bar',   label: 'Expenses',   data: data.expenses,   backgroundColor: red },
                    { type: 'line',  label: 'Net change',  data: data.cumulative, borderColor: blue,
                      backgroundColor: 'transparent', pointRadius: 3, tension: 0.3 },
                ]
            },
            options: { ...baseOpts, scales: { y: { stacked: false, ticks: { callback: v => _fmtCcy(v) } } } }
        });

    } else if (report === 'networth') {
        new Chart(canvas, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    { label: 'Net Worth',    data: data.networth,    borderColor: blue,   fill: false, tension: 0.3, pointRadius: 3 },
                    { label: 'Assets',       data: data.assets,      borderColor: green,  fill: false, tension: 0.3, pointRadius: 2 },
                    { label: 'Liabilities',  data: data.liabilities, borderColor: red,    fill: false, tension: 0.3, pointRadius: 2 },
                ]
            },
            options: baseOpts
        });

    } else if (report === 'expenses') {
        const palette = [red, purple, teal, 'rgba(250,180,50,0.8)', 'rgba(50,180,250,0.8)',
                         'rgba(250,120,50,0.8)', 'rgba(130,200,80,0.8)', 'rgba(200,80,180,0.8)'];
        if (altView) {
            // Alt: doughnut of period totals
            const totals = data.series.map(s => s.data.reduce((a, b) => a + b, 0));
            const grand  = totals.reduce((a, b) => a + b, 0);
            new Chart(canvas, {
                type: 'doughnut',
                data: {
                    labels: data.series.map(s => s.label),
                    datasets: [{ data: totals, backgroundColor: palette }]
                },
                options: {
                    aspectRatio: 2,
                    plugins: {
                        legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
                        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${_fmtCcy(ctx.parsed)} (${(100*ctx.parsed/grand).toFixed(1)}%)` } }
                    }
                }
            });
        } else {
            new Chart(canvas, {
                type: 'bar',
                data: {
                    labels,
                    datasets: data.series.map((s, i) => ({
                        label: s.label, data: s.data,
                        backgroundColor: palette[i % palette.length], stack: 'expenses',
                    }))
                },
                options: { ...baseOpts, scales: { y: { stacked: true, ticks: { callback: v => _fmtCcy(v) } } } }
            });
        }

    } else if (report.endsWith('-pie')) {
        const palette = [red, green, blue, purple, teal,
                         'rgba(250,180,50,0.85)', 'rgba(50,180,250,0.85)',
                         'rgba(250,120,50,0.85)', 'rgba(130,200,80,0.85)', 'rgba(200,80,180,0.85)'];
        const total = data.values.reduce((a, b) => a + b, 0);
        if (altView) {
            // Alt: horizontal bar
            new Chart(canvas, {
                type: 'bar',
                data: {
                    labels: data.labels,
                    datasets: [{ data: data.values, backgroundColor: palette, label: report.replace('-pie','') }]
                },
                options: {
                    indexAxis: 'y',
                    plugins: {
                        legend: { display: false },
                        tooltip: { callbacks: { label: ctx => ` ${_fmtCcy(ctx.parsed.x)} (${(100*ctx.parsed.x/total).toFixed(1)}%)` } }
                    },
                    scales: { x: { ticks: { callback: v => _fmtCcy(v) } } }
                }
            });
        } else {
            new Chart(canvas, {
                type: 'doughnut',
                data: {
                    labels: data.labels,
                    datasets: [{ data: data.values, backgroundColor: palette }]
                },
                options: {
                    aspectRatio: 2,
                    plugins: {
                        legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } },
                        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${_fmtCcy(ctx.parsed)} (${(100*ctx.parsed/total).toFixed(1)}%)` } }
                    }
                }
            });
        }
    }
}

const _CHART_QUICK_PERIODS = [
    { key: 'thismonth', label: 'mo' },
    { key: 'thisyear',  label: 'yr' },
    { key: 'lastyear',  label: 'prev' },
];

const _CHART_APPS = new Set(['hledger']);

async function _loadChartBlock(el) {
    const raw   = el.dataset.query || '';
    const parts = raw.trim().split(/\s+/);

    // Syntax: "chart [app] <report> [period] [depth:N]"
    // app is optional — defaults to 'hledger' for backward compat
    let app = 'hledger', reportIdx = 0;
    if (parts[0] && _CHART_APPS.has(parts[0])) { app = parts[0]; reportIdx = 1; }
    const report = parts[reportIdx] || 'cashflow';

    // Parse remaining args: period, depth
    let initPeriod = 'thisyear';
    let depth      = '2';
    for (let i = reportIdx + 1; i < parts.length; i++) {
        if (parts[i] === '-p' && parts[i + 1])  { initPeriod = parts[++i]; }
        else if (parts[i].startsWith('depth:'))  { depth = parts[i].slice(6); }
        else if (/^[a-z0-9]/.test(parts[i]))    { initPeriod = parts[i]; }
    }

    const notebook   = (typeof NbNav !== 'undefined' ? NbNav.notebook : '') || '';
    let   activePeriod = initPeriod;

    const canAlt = report.endsWith('-pie') || report === 'expenses';
    // default view: pie reports start as doughnut, expenses starts as bar
    let   altView = false;

    const buildUrl = () =>
        `/api/hledger/chart?notebook=${encodeURIComponent(notebook)}`
        + `&report=${encodeURIComponent(report)}&period=${encodeURIComponent(activePeriod)}`
        + `&depth=${encodeURIComponent(depth)}`;

    const altLabel = () => {
        if (report.endsWith('-pie')) return altView ? '◕' : '▦';
        return altView ? '▦' : '◕';  // expenses: default bar → shows pie icon
    };

    el.innerHTML = `
        <div class="nb-chart-header">
            <span class="nb-chart-toggle">▾</span>
            <span class="nb-chart-title">
                ${reportIdx > 0 ? `<span class="nb-chart-app">${app}</span> ` : ''}<span class="nb-chart-report">${report}</span>
            </span>
            <span class="nb-chart-pickers">${
                _CHART_QUICK_PERIODS.map(p =>
                    `<button class="nb-chart-p${p.key === initPeriod ? ' nb-chart-p-on' : ''}"
                             data-p="${p.key}">${p.label}</button>`
                ).join('')
            }</span>
            ${canAlt ? `<button class="nb-chart-viewbtn" title="Toggle chart type">${altLabel()}</button>` : ''}
            <button class="nb-chart-refresh" title="Reload">↺</button>
        </div>
        <div class="nb-chart-body">
            <div class="nb-chart-loading">Loading chart…</div>
        </div>`;

    el.classList.add('nb-chart-block');

    const toggle  = el.querySelector('.nb-chart-toggle');
    const title   = el.querySelector('.nb-chart-title');
    const body    = el.querySelector('.nb-chart-body');
    const refresh = el.querySelector('.nb-chart-refresh');
    const pickers = el.querySelector('.nb-chart-pickers');
    const viewBtn = el.querySelector('.nb-chart-viewbtn');

    let _lastData = null;

    const draw = data => {
        body.innerHTML = '<canvas></canvas>';
        _loadChartJs(() => _drawChart(body.querySelector('canvas'), report, data, altView));
    };

    const load = () => {
        body.innerHTML = '<div class="nb-chart-loading">Loading…</div>';
        _lastData = null;
        fetch(buildUrl())
            .then(r => r.json())
            .then(data => {
                if (data.error) { body.innerHTML = `<div class="nb-chart-err">${data.error}</div>`; return; }
                _lastData = data;
                draw(data);
            })
            .catch(e => { body.innerHTML = `<div class="nb-chart-err">${e.message}</div>`; });
    };

    const collapse = () => {
        el.classList.toggle('nb-chart-collapsed');
        toggle.textContent = el.classList.contains('nb-chart-collapsed') ? '▸' : '▾';
    };

    toggle.addEventListener('click', collapse);
    title.addEventListener('click',  collapse);
    refresh.addEventListener('click', () => { el.classList.remove('nb-chart-collapsed'); toggle.textContent = '▾'; load(); });

    pickers.addEventListener('click', e => {
        const btn = e.target.closest('.nb-chart-p');
        if (!btn) return;
        activePeriod = btn.dataset.p;
        pickers.querySelectorAll('.nb-chart-p').forEach(b =>
            b.classList.toggle('nb-chart-p-on', b.dataset.p === activePeriod));
        el.classList.remove('nb-chart-collapsed');
        toggle.textContent = '▾';
        load();
    });

    if (viewBtn) {
        viewBtn.addEventListener('click', () => {
            altView = !altView;
            viewBtn.textContent = altLabel();
            el.classList.remove('nb-chart-collapsed');
            toggle.textContent = '▾';
            if (_lastData) draw(_lastData);  // redraw without re-fetching
        });
    }

    load();
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

    codeblockRenderers: [
        {
            lang: 'chart',
            html: text => `<div class="nb-chart-block" data-query="${text.trim().replace(/"/g, '&quot;')}"><div class="nb-chart-loading">Loading chart…</div></div>`,
            render: async container => {
                const blocks = [...container.querySelectorAll('.nb-chart-block[data-query]')];
                if (!blocks.length) return;
                NbWeb.statusPill?.add(blocks.length);
                for (const el of blocks) {
                    await _loadChartBlock(el);
                    NbWeb.statusPill?.tick();
                }
            },
        },
    ],
});

// Expose accounts getter so NbWeb-codeblocks can wire autocomplete
window.NbHledger = { getAccounts: _getAccounts };

})();

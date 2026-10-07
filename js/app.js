/* Uživatelské rozhraní kalkulačky: formulář, plán mimořádných splátek, graf a tabulky. */
(function () {
  'use strict';

  const { calculate, aggregateByYear } = window.HypoCalc;

  // ---------- Formátování ----------
  const nf0 = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 });
  const nfDec = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 3 });
  const nfRate = new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  const nfCompact = new Intl.NumberFormat('cs-CZ', { notation: 'compact', maximumFractionDigits: 1 });
  const dfLong = new Intl.DateTimeFormat('cs-CZ', { month: 'long', year: 'numeric' });

  const czk = (v) => nf0.format(Math.round(v) || 0) + ' Kč';
  const pct = (v) => nfRate.format(v) + ' %';

  function plural(n, one, few, many) {
    if (n === 1) return one;
    if (n >= 2 && n <= 4) return few;
    return many;
  }

  function duration(months) {
    const y = Math.floor(months / 12);
    const m = months % 12;
    const parts = [];
    if (y) parts.push(`${y} ${plural(y, 'rok', 'roky', 'let')}`);
    if (m) parts.push(`${m} ${plural(m, 'měsíc', 'měsíce', 'měsíců')}`);
    return parts.join(' a ') || '0 měsíců';
  }

  // Datum k-té splátky (k = 1 je první splátka).
  const monthDate = (start, k) => new Date(start.y, start.m - 1 + k - 1, 1);
  function fmtMonth(start, k) {
    const d = monthDate(start, k);
    return String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
  }
  const fmtMonthLong = (start, k) => dfLong.format(monthDate(start, k));

  // ---------- DOM pomocníci ----------
  const $ = (id) => document.getElementById(id);

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false || c === '') continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  /** Odstavec, kde objekty {b: '…'} jsou tučně. */
  function rich(parts) {
    return el('p', null, parts.map((p) => (typeof p === 'string' ? p : el('strong', null, p.b))));
  }

  const SCENARIOS = [
    { key: 'none', label: 'Bez mimořádných splátek', color: '--series-base' },
    { key: 'plan', label: 'Váš plán', color: '--series-1' },
    { key: 'payment', label: 'Vše na nižší splátku', color: '--series-2', ref: true },
    { key: 'term', label: 'Vše na kratší dobu', color: '--series-3', ref: true },
  ];
  const MODE_LABEL = { payment: 'nižší splátka', term: 'kratší doba' };
  const keyEl = (key) => el('span', { class: `key key-${key}`, 'aria-hidden': 'true' });

  // ---------- Vstupy ----------
  function parseNum(raw) {
    const s = String(raw == null ? '' : raw)
      .replace(/[\s  ]/g, '')
      .replace(/kč|%/gi, '')
      .replace(',', '.');
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }

  const FIELDS = {
    principal: { min: 10000, max: 1e9, required: true, msg: 'Zadejte částku alespoň 10 000 Kč.' },
    rate: { min: 0, max: 30, required: true, msg: 'Zadejte sazbu od 0 do 30 %.' },
    term: { min: 1, max: 50, required: true, msg: 'Zadejte 1 až 50 let.' },
    fix: { min: 1 / 12, max: 50, required: true, msg: 'Zadejte délku fixace v letech (např. 5).' },
    firstFix: { min: 1 / 12, max: 50, required: false, msg: 'Zadejte kladný počet let, nebo nechte prázdné.' },
    nextRate: { min: 0, max: 30, required: false, msg: 'Zadejte sazbu od 0 do 30 %, nebo nechte prázdné.' },
    extraAmount: { min: 0, max: 1e9, required: false, msg: 'Zadejte částku 0 Kč nebo vyšší.' },
    extraYears: { min: 0, max: 50, required: false, integer: true, msg: 'Zadejte celý počet let, nebo nechte prázdné.' },
    limitPct: { min: 0, max: 100, required: true, msg: 'Zadejte 0 až 100 %.' },
    originalPrincipal: { min: 10000, max: 1e9, required: false, msg: 'Zadejte částku alespoň 10 000 Kč, nebo nechte prázdné.' },
  };

  // Názvy parametrů v adrese stránky (aby šel výpočet sdílet odkazem).
  const URL_KEYS = {
    principal: 'castka',
    rate: 'sazba',
    term: 'doba',
    fix: 'fixace',
    firstFix: 'konecFixace',
    nextRate: 'dalsiSazba',
    extraAmount: 'mimoradna',
    extraYears: 'let',
    limitPct: 'limit',
    originalPrincipal: 'puvodni',
  };
  const OPTIONAL_FIELDS = ['firstFix', 'nextRate', 'extraYears', 'originalPrincipal'];
  const MODE_URL = { payment: 'splatka', term: 'doba' };
  const BASE_URL = { original: 'puvodni', balance: 'zustatek' };

  const state = {
    rateOverrides: {}, // {indexFixace: sazba}
    extraOverrides: {}, // {indexVýročí: {amount?, mode?}}
    metric: 'balance',
    last: null,
  };

  const form = $('form');
  const results = $('results');
  const planBody = $('plan-table').tBodies[0];
  const ratesBody = $('rates-editor').tBodies[0];

  function formatFieldValue(input, v) {
    if (v == null || Number.isNaN(v)) return input.value;
    return input.dataset.format === 'money' ? nf0.format(v) : nfDec.format(v);
  }

  function parseStart(raw) {
    let m = /^(\d{4})-(\d{1,2})$/.exec(raw.trim());
    if (m) return { y: +m[1], m: +m[2] };
    m = /^(\d{1,2})\s*[./]\s*(\d{4})$/.exec(raw.trim());
    if (m) return { y: +m[2], m: +m[1] };
    return null;
  }

  function selectedRadio(name) {
    const checked = document.querySelector(`input[name="${name}"]:checked`);
    return checked ? checked.value : null;
  }

  function readInput() {
    const errors = {};
    const v = {};
    for (const [name, rule] of Object.entries(FIELDS)) {
      const n = parseNum($(name).value);
      v[name] = n;
      if (n === null) {
        if (rule.required) errors[name] = rule.msg;
      } else if (Number.isNaN(n) || n < rule.min || n > rule.max || (rule.integer && !Number.isInteger(n))) {
        errors[name] = rule.msg;
      }
    }

    const termMonths = Math.round((v.term || 0) * 12);
    const fixMonths = Math.max(1, Math.round((v.fix || 0) * 12));
    const firstFixMonths = v.firstFix == null ? fixMonths : Math.max(1, Math.round(v.firstFix * 12));
    if (!errors.term && !errors.firstFix && v.firstFix != null && firstFixMonths > termMonths) {
      errors.firstFix = 'Fixace nemůže končit až po konci splácení.';
    }

    const start = parseStart($('start').value);
    if (!start || start.m < 1 || start.m > 12) errors.start = 'Zadejte měsíc a rok první splátky (např. 11/2026).';

    return {
      errors,
      start,
      input: {
        principal: v.principal,
        termMonths,
        firstFixMonths,
        fixMonths,
        rate: v.rate,
        nextRate: v.nextRate,
        rateOverrides: state.rateOverrides,
        extraAmount: v.extraAmount || 0,
        extraYears: v.extraYears,
        extraMode: selectedRadio('extraMode'),
        extraOverrides: state.extraOverrides,
        limitPct: v.limitPct,
        limitBase: $('limitBase').value,
        originalPrincipal: v.originalPrincipal,
      },
    };
  }

  function showErrors(errors) {
    for (const name of [...Object.keys(FIELDS), 'start']) {
      const input = $(name);
      const msg = errors[name] || '';
      $(`${name}-error`).textContent = msg;
      if (msg) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', `${name}-error`);
      } else {
        input.removeAttribute('aria-invalid');
        input.removeAttribute('aria-describedby');
      }
    }
  }

  // ---------- Editor sazeb ----------
  function renderRatesEditor(periods, start) {
    ratesBody.replaceChildren(
      ...periods.map((p) =>
        el('tr', null,
          el('td', null, `${p.index + 1}. fixace`,
            el('span', { class: 'period-dates' }, `${fmtMonth(start, p.startMonth + 1)} – ${fmtMonth(start, p.endMonth)}`)),
          el('td', null,
            el('input', {
              type: 'text',
              inputmode: 'decimal',
              value: nfDec.format(p.rate),
              'data-index': p.index,
              'aria-label': `Sazba ${p.index + 1}. fixace v procentech`,
              class: state.rateOverrides[p.index] != null ? 'is-custom' : null,
            }))),
      ),
    );
  }

  // ---------- Plán mimořádných splátek ----------
  function renderPlanStructure(extras, start) {
    planBody.replaceChildren(
      ...extras.map((e) => {
        const ov = state.extraOverrides[e.index] || {};
        const amountInput = el('input', {
          type: 'text',
          inputmode: 'numeric',
          value: nf0.format(e.amount),
          'data-index': e.index,
          'data-format': 'money',
          'aria-label': `Mimořádná splátka k ${e.index + 1}. výročí v Kč`,
          class: ov.amount != null ? 'is-custom' : null,
        });
        const modeName = `mode-${e.index}`;
        const modeRadio = (value, text) =>
          el('label', null,
            el('input', { type: 'radio', name: modeName, value, checked: e.mode === value, 'data-index': e.index }),
            el('span', null, text));
        return el(
          'tr',
          { 'data-index': e.index },
          el('th', { scope: 'row' }, `${e.index + 1}. výročí`,
            el('span', { class: 'period-dates' }, fmtMonth(start, e.month)),
            e.isFixEnd ? el('span', { class: 'badge' }, 'konec fixace') : null),
          el('td', { 'data-cell': 'limit' }),
          el('td', null, el('div', { class: 'input-unit' }, amountInput, el('span', null, 'Kč'))),
          el('td', null,
            el('div', {
              class: `segmented segmented-mini${ov.mode ? ' is-custom' : ''}`,
              role: 'radiogroup',
              'aria-label': `Použití ${e.index + 1}. mimořádné splátky`,
            }, modeRadio('payment', 'nižší splátku'), modeRadio('term', 'kratší dobu'))),
          el('td', { 'data-cell': 'applied' }),
          el('td', { 'data-cell': 'payment' }),
          el('td', { 'data-cell': 'end' }),
        );
      }),
    );
  }

  function setCell(td, text, note, cls) {
    td.className = cls || '';
    td.replaceChildren(text, note ? el('span', { class: 'cell-note' }, note) : '');
  }

  function updatePlanResults(res, start) {
    const byIndex = new Map(res.plan.extras.map((x) => [x.index, x]));
    for (const tr of planBody.rows) {
      const i = +tr.dataset.index;
      const x = byIndex.get(i);
      const cell = (name) => tr.querySelector(`[data-cell="${name}"]`);
      const done = !x || x.balanceBefore <= 0;
      tr.classList.toggle('is-off', done);
      if (done) {
        setCell(cell('limit'), '—', null, 'muted');
        setCell(cell('applied'), 'úvěr splacen', null, 'muted');
        setCell(cell('payment'), '—', null, 'muted');
        setCell(cell('end'), '—', null, 'muted');
        continue;
      }
      if (x.limit === Infinity) setCell(cell('limit'), 'bez limitu', null, 'muted');
      else setCell(cell('limit'), czk(x.limit));

      if (x.applied <= 0) {
        if (x.capped) setCell(cell('applied'), czk(0), 'sníženo na limit', 'warn');
        else setCell(cell('applied'), '—', null, 'muted');
        setCell(cell('payment'), '—', null, 'muted');
        setCell(cell('end'), '—', null, 'muted');
        continue;
      }
      const note = x.paidOff ? 'doplaceno' : x.capped ? 'sníženo na limit' : null;
      setCell(cell('applied'), czk(x.applied), note, x.capped ? 'warn' : null);
      setCell(cell('payment'), x.paidOff ? '—' : czk(x.paymentAfter), null, x.paidOff ? 'muted' : null);
      setCell(cell('end'), fmtMonth(start, x.endMonthAfter));
    }
  }

  function planDisplayAmount(input) {
    const i = +input.dataset.index;
    const e = state.last && state.last.res.extras[i];
    return e ? nf0.format(e.amount) : input.value;
  }

  // ---------- Výsledky ----------
  const appliedExtras = (sim) => sim.extras.filter((x) => x.applied > 0);

  // Poslední mimořádná splátka, po které úvěr ještě běží (kvůli „splátce poté“).
  function lastRunningExtra(sim) {
    const list = appliedExtras(sim).filter((x) => !x.paidOff);
    return list.length ? list[list.length - 1] : null;
  }

  function renderVerdict(res, start) {
    const { none, plan, payment, term } = res;
    const box = $('verdict');
    if (plan.totalPrepaid <= 0) {
      box.replaceChildren(
        rich(['Zadejte ', { b: 'částku mimořádné splátky' }, ' – bez ní se splácení nijak nezmění.']),
      );
      return;
    }
    const save = none.totalInterest - plan.totalInterest;
    const shorter = none.months - plan.months;
    const count = appliedExtras(plan).length;

    const first = [
      'S vaším plánem mimořádně splatíte celkem ',
      { b: czk(plan.totalPrepaid) },
      ` (${count} ${plural(count, 'splátka', 'splátky', 'splátek')}) a na úrocích ušetříte `,
      { b: czk(save) },
    ];
    if (shorter > 0) first.push('. Hypotéku splatíte o ', { b: duration(shorter) }, ' dřív');
    first.push('.');
    const lastRun = lastRunningExtra(plan);
    if (lastRun && plan.firstPayment - lastRun.paymentAfter >= 1) {
      first.push(' Měsíční splátka klesne z ', { b: czk(plan.firstPayment) }, ' až na ', { b: czk(lastRun.paymentAfter) }, '.');
    }

    const second = [
      'Pro srovnání se stejnými částkami: kdyby všechny šly na kratší dobu, ušetří se ',
      { b: czk(none.totalInterest - term.totalInterest) },
      ` a úvěr skončí ${fmtMonth(start, term.months)}; kdyby všechny šly na nižší splátku, ušetří se `,
      { b: czk(none.totalInterest - payment.totalInterest) },
      ` a úvěr skončí ${fmtMonth(start, payment.months)}.`,
    ];

    const parts = [rich(first), rich(second)];
    if (plan.cappedCount > 0) {
      const n = plan.cappedCount;
      parts.push(
        rich([
          `${n} ${plural(n, 'splátka přesahuje', 'splátky přesahují', 'splátek přesahuje')} bezplatný limit, kalkulačka ${n === 1 ? 'ji' : 'je'} proto snížila na limit.`,
        ]),
      );
    }
    box.replaceChildren(...parts);
  }

  function stat(label, value, notes) {
    return el(
      'div',
      { class: 'stat' },
      el('span', { class: 'stat-label' }, label),
      el('span', { class: 'stat-value' }, value),
      (notes || []).filter(Boolean).map((n) =>
        el('span', { class: typeof n === 'string' ? 'stat-note' : `stat-note ${n.cls}` }, typeof n === 'string' ? n : n.text),
      ),
    );
  }

  function card(key, title, sub, stats) {
    return el(
      'article',
      { class: 'panel card' },
      el('div', { class: 'card-head' }, keyEl(key), el('h3', null, title)),
      el('p', { class: 'card-sub' }, sub),
      el('div', { class: 'card-stats' }, stats),
    );
  }

  function renderCards(res, start) {
    const { none, plan } = res;
    const save = none.totalInterest - plan.totalInterest;
    const shorter = none.months - plan.months;
    const hasExtra = plan.totalPrepaid > 0;
    const count = appliedExtras(plan).length;
    const lastRun = lastRunningExtra(plan);
    const drop = lastRun ? plan.firstPayment - lastRun.paymentAfter : 0;

    $('cards').replaceChildren(
      card('none', 'Bez mimořádných splátek', 'srovnávací varianta', [
        stat('Měsíční splátka', czk(none.firstPayment)),
        stat('Zaplacené úroky', czk(none.totalInterest), [`celkem zaplatíte ${czk(none.totalPaid)}`]),
        stat('Doba splácení', duration(none.months), [`poslední splátka ${fmtMonthLong(start, none.months)}`]),
      ]),
      card(
        'plan',
        'Váš plán',
        hasExtra
          ? `${count} ${plural(count, 'mimořádná splátka', 'mimořádné splátky', 'mimořádných splátek')}, celkem ${czk(plan.totalPrepaid)}`
          : 'zatím bez mimořádných splátek',
        [
          stat('Ušetřené úroky', czk(save), [
            hasExtra && none.totalInterest > 0
              ? { cls: 'good', text: `o ${nfDec.format(Math.round((save / none.totalInterest) * 1000) / 10)} % méně na úrocích` }
              : null,
            `zaplacené úroky ${czk(plan.totalInterest)}`,
          ]),
          stat('Doba splácení', duration(plan.months), [
            shorter > 0 ? { cls: 'good', text: `o ${duration(shorter)} kratší` } : 'beze změny',
            `poslední splátka ${fmtMonthLong(start, plan.months)}`,
          ]),
          stat('Měsíční splátka po poslední mimořádné', czk(lastRun ? lastRun.paymentAfter : plan.firstPayment), [
            drop >= 1 ? { cls: 'good', text: `o ${czk(drop)} méně než na začátku` } : null,
            `na začátku ${czk(plan.firstPayment)}`,
          ]),
        ],
      ),
    );
  }

  function scenarioHeaderCells() {
    return SCENARIOS.map((s) =>
      el('th', { scope: 'col' }, el('span', { class: 'th-key' }, keyEl(s.key), s.label)),
    );
  }

  function renderSummary(res, start) {
    const sims = SCENARIOS.map((s) => res[s.key]);
    const none = res.none;
    const dash = '—';

    const rows = [
      ['Měsíční splátka na začátku', (s) => czk(s.firstPayment)],
      ['Měsíční splátka po 1. mimořádné splátce', (s) => {
        const x = appliedExtras(s)[0];
        if (!x) return dash;
        return x.paidOff ? 'úvěr doplacen' : czk(x.paymentAfter);
      }],
      ['Měsíční splátka po poslední mimořádné splátce', (s) => {
        const x = lastRunningExtra(s);
        return x ? czk(x.paymentAfter) : dash;
      }],
      ['Doba splácení', (s) => duration(s.months)],
      ['Poslední splátka', (s) => fmtMonth(start, s.months)],
      ['Počet mimořádných splátek', (s) => (s === none ? dash : String(appliedExtras(s).length))],
      ['Mimořádně splaceno celkem', (s) => (s === none ? dash : czk(s.totalPrepaid))],
      ['Zaplacené úroky', (s) => czk(s.totalInterest)],
      ['Celkem zaplaceno bance', (s) => czk(s.totalPaid)],
      ['Úspora na úrocích', (s) => (s === none ? dash : { text: czk(none.totalInterest - s.totalInterest), cls: 'good' })],
      [
        'Úspora na každých 100 000 Kč mimořádných splátek',
        (s) => (s === none || s.totalPrepaid <= 0 ? dash : czk(((none.totalInterest - s.totalInterest) / s.totalPrepaid) * 100000)),
      ],
      ['Zkrácení doby splácení', (s) => (s === none || s.months >= none.months ? dash : duration(none.months - s.months))],
    ];

    $('summary-table').replaceChildren(
      el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Ukazatel'), scenarioHeaderCells())),
      el(
        'tbody',
        null,
        rows.map(([label, fn]) =>
          el('tr', null, el('th', { scope: 'row' }, label),
            sims.map((s) => {
              const v = fn(s);
              return typeof v === 'string'
                ? el('td', { class: v === dash ? 'muted' : null }, v)
                : el('td', { class: v.cls }, v.text);
            })),
        ),
      ),
    );
  }

  function renderSchedule(res, start) {
    const sim = res[selectedRadio('scenario')];
    const byYear = selectedRadio('granularity') === 'year';
    const modeAt = new Map(appliedExtras(sim).map((x) => [x.month, x.mode]));

    const headCells = byYear
      ? ['Rok', 'Období', 'Sazba', 'Splátky', 'z toho úrok', 'z toho jistina', 'Mimořádná splátka', 'Zůstatek']
      : ['Splátka č.', 'Měsíc', 'Sazba', 'Splátka', 'z toho úrok', 'z toho jistina', 'Mimořádná splátka', 'Zůstatek'];

    const rows = byYear
      ? aggregateByYear(sim.rows).map((y) => [
          `${y.year}.`,
          `${fmtMonth(start, y.fromMonth)} – ${fmtMonth(start, y.toMonth)}`,
          y,
          modeAt.get(y.toMonth),
        ])
      : sim.rows.map((r) => [`${r.month}.`, fmtMonth(start, r.month), r, modeAt.get(r.month)]);

    const sum = (k) => sim.rows.reduce((s, r) => s + r[k], 0);

    $('schedule-table').replaceChildren(
      el('thead', null, el('tr', null, headCells.map((h) => el('th', { scope: 'col' }, h)))),
      el(
        'tbody',
        null,
        rows.map(([a, b, r, mode]) =>
          el(
            'tr',
            { class: !byYear && r.prepayment > 0 ? 'prepay-row' : null },
            el('th', { scope: 'row' }, a),
            el('td', null, b),
            el('td', null, pct(r.rate)),
            el('td', null, czk(r.payment)),
            el('td', null, czk(r.interest)),
            el('td', null, czk(r.principal)),
            r.prepayment > 0
              ? el('td', null, czk(r.prepayment), mode ? el('span', { class: 'cell-note' }, MODE_LABEL[mode]) : null)
              : el('td', { class: 'muted' }, '—'),
            el('td', null, czk(r.balance)),
          ),
        ),
      ),
      el(
        'tfoot',
        null,
        el(
          'tr',
          null,
          el('th', { scope: 'row' }, 'Celkem'),
          el('td'),
          el('td'),
          el('td', null, czk(sum('payment'))),
          el('td', null, czk(sum('interest'))),
          el('td', null, czk(sum('principal'))),
          el('td', null, czk(sum('prepayment'))),
          el('td'),
        ),
      ),
    );
  }

  function exportCsv() {
    if (!state.last) return;
    const { res, start } = state.last;
    const key = selectedRadio('scenario');
    const sim = res[key];
    const modeAt = new Map(appliedExtras(sim).map((x) => [x.month, x.mode]));
    const num = (v) => (Math.round(v * 100) / 100).toFixed(2).replace('.', ',');
    const lines = [
      ['Splátka č.', 'Měsíc', 'Sazba (%)', 'Splátka (Kč)', 'Úrok (Kč)', 'Jistina (Kč)', 'Mimořádná splátka (Kč)', 'Použito na', 'Zůstatek (Kč)'].join(';'),
      ...sim.rows.map((r) =>
        [
          r.month,
          fmtMonth(start, r.month),
          String(r.rate).replace('.', ','),
          num(r.payment),
          num(r.interest),
          num(r.principal),
          num(r.prepayment),
          modeAt.has(r.month) ? MODE_LABEL[modeAt.get(r.month)] : '',
          num(r.balance),
        ].join(';'),
      ),
    ];
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const names = { none: 'bez-mimoradnych-splatek', plan: 'vas-plan', payment: 'vse-nizsi-splatka', term: 'vse-kratsi-doba' };
    const a = el('a', { href: url, download: `splatkovy-kalendar-${names[key]}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------- Graf ----------
  let chart = null;

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const CAPTIONS = {
    balance: 'Zůstatek úvěru po každé splátce. Svislé linky označují konce fixací.',
    payment: 'Řádná měsíční splátka (bez mimořádných splátek). Po splacení úvěru je splátka nulová.',
    interest: 'Kolik jste od začátku splácení zaplatili na úrocích.',
  };

  const visibleScenarios = () => SCENARIOS.filter((s) => !s.ref || $('show-refs').checked);

  function buildSeries(sim, principal, metric, horizon) {
    const rows = sim.rows;
    const data = [];
    let cum = 0;
    if (metric !== 'payment') data.push({ x: 0, y: metric === 'balance' ? principal : 0 });
    for (let k = 1; k <= horizon; k++) {
      const row = rows[k - 1];
      let y;
      if (metric === 'balance') y = row ? row.balance : 0;
      else if (metric === 'payment') y = row ? row.payment : 0;
      else {
        if (row) cum += row.interest;
        y = cum;
      }
      data.push({ x: k, y });
    }
    return data;
  }

  // Svislé linky na koncích fixací.
  const markersPlugin = {
    id: 'fixMarkers',
    beforeDatasetsDraw(c, args, opts) {
      const { ctx, chartArea, scales } = c;
      ctx.save();
      ctx.strokeStyle = opts.color;
      ctx.lineWidth = 1;
      for (const m of opts.months || []) {
        const x = Math.round(scales.x.getPixelForValue(m)) + 0.5;
        if (x < chartArea.left || x > chartArea.right) continue;
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
      }
      ctx.restore();
    },
  };

  // Svislý kurzor v místě aktivní položky tooltipu.
  const crosshairPlugin = {
    id: 'crosshair',
    afterDatasetsDraw(c, args, opts) {
      const active = c.tooltip && c.tooltip.getActiveElements();
      if (!active || !active.length) return;
      const { ctx, chartArea } = c;
      const x = Math.round(active[0].element.x) + 0.5;
      ctx.save();
      ctx.strokeStyle = opts.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.restore();
    },
  };

  function yearTicks(start, horizon, width) {
    const spanYears = horizon / 12;
    const maxTicks = Math.max(3, Math.floor(width / 64));
    const step = [1, 2, 5, 10].find((s) => spanYears / s <= maxTicks) || 10;
    const ticks = [];
    // Index splátky, která připadne na leden roku Y.
    for (let y = start.y + 1; ; y++) {
      if (step > 1 && y % step !== 0) continue;
      const k = (y - start.y) * 12 - (start.m - 1) + 1;
      if (k > horizon) break;
      ticks.push({ value: k, label: String(y) });
    }
    return ticks;
  }

  function renderLegend() {
    $('legend').replaceChildren(...visibleScenarios().map((s) => el('li', null, keyEl(s.key), s.label)));
  }

  function renderChart() {
    if (!state.last || typeof window.Chart === 'undefined') return;
    const { res, input, start } = state.last;
    const metric = state.metric;
    const scen = visibleScenarios();
    const horizon = Math.max(...scen.map((s) => res[s.key].months));

    const colors = {
      ink: cssVar('--ink'),
      ink2: cssVar('--ink-2'),
      muted: cssVar('--muted'),
      grid: cssVar('--grid'),
      axis: cssVar('--axis'),
      surface: cssVar('--surface'),
      border: cssVar('--border-strong'),
    };

    const datasets = scen.map((s, i) => {
      const color = cssVar(s.color);
      return {
        label: s.label,
        data: buildSeries(res[s.key], input.principal, metric, horizon),
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHitRadius: 10,
        pointHoverBorderWidth: 2,
        pointHoverBorderColor: colors.surface,
        pointHoverBackgroundColor: color,
        stepped: metric === 'payment',
        tension: 0,
        // Váš plán kreslíme nahoru, srovnávací šedou dospod.
        order: s.key === 'plan' ? 0 : s.key === 'none' ? 9 : i + 1,
      };
    });

    const fixMonths = res.periods.filter((p) => !p.isLast).map((p) => p.endMonth);
    const planExtraAt = new Map(appliedExtras(res.plan).map((x) => [x.month, x]));

    const width = $('chart').parentElement.clientWidth || 600;
    const ticks = yearTicks(start, horizon, width);
    const tickLabels = new Map(ticks.map((t) => [t.value, t.label]));

    const options = {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      normalized: true,
      interaction: { mode: 'index', intersect: false, axis: 'x' },
      layout: { padding: { top: 6, right: 8 } },
      plugins: {
        legend: { display: false },
        fixMarkers: { months: fixMonths, color: colors.axis },
        crosshair: { color: colors.muted },
        tooltip: {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          borderWidth: 1,
          titleColor: colors.ink,
          bodyColor: colors.ink,
          footerColor: colors.ink2,
          titleFont: { weight: '600' },
          footerFont: { weight: '400' },
          padding: 10,
          boxWidth: 14,
          boxHeight: 3,
          boxPadding: 6,
          caretSize: 0,
          itemSort: (a, b) => a.datasetIndex - b.datasetIndex,
          callbacks: {
            title(items) {
              const k = items[0].parsed.x;
              if (k === 0) return 'Začátek (před první splátkou)';
              return `${fmtMonthLong(start, k)} · ${k}. splátka`;
            },
            label(item) {
              return `${czk(item.parsed.y)}  ${item.dataset.label}`;
            },
            // Klíč řady jako krátká čárka v barvě čáry.
            labelColor(item) {
              const c = item.dataset.borderColor;
              return { borderColor: c, backgroundColor: c, borderWidth: 0, borderRadius: 1.5 };
            },
            footer(items) {
              const x = planExtraAt.get(items[0].parsed.x);
              return x ? `Váš plán: mimořádná splátka ${czk(x.applied)} → ${MODE_LABEL[x.mode]}` : '';
            },
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: metric === 'payment' ? 1 : 0,
          max: horizon,
          grid: { display: false },
          border: { color: colors.axis },
          afterBuildTicks(axis) {
            axis.ticks = ticks.map((t) => ({ value: t.value }));
          },
          ticks: {
            color: colors.muted,
            autoSkip: false,
            maxRotation: 0,
            callback: (v) => tickLabels.get(v) || '',
          },
        },
        y: {
          beginAtZero: true,
          grid: { color: colors.grid, drawTicks: false },
          border: { display: false },
          ticks: {
            color: colors.muted,
            padding: 8,
            maxTicksLimit: 6,
            callback: (v) => (v === 0 ? '0' : nfCompact.format(v) + ' Kč'),
          },
        },
      },
    };

    if (!chart) {
      chart = new window.Chart($('chart'), {
        type: 'line',
        data: { datasets },
        options,
        plugins: [markersPlugin, crosshairPlugin],
      });
    } else {
      chart.data.datasets = datasets;
      chart.options = options;
      chart.update('none');
    }
    renderLegend();
    $('chart-caption').textContent = CAPTIONS[metric];
  }

  // ---------- Adresa stránky ----------
  function writeUrl() {
    const p = new URLSearchParams();
    for (const [name, key] of Object.entries(URL_KEYS)) {
      const v = parseNum($(name).value);
      if (v != null && !Number.isNaN(v)) p.set(key, String(v));
    }
    p.set('start', $('start').value);
    p.set('pouziti', MODE_URL[selectedRadio('extraMode')]);
    p.set('zaklad', BASE_URL[$('limitBase').value]);
    const rates = Object.entries(state.rateOverrides).map(([i, r]) => `${i}:${r}`).join(',');
    if (rates) p.set('sazby', rates);
    const plan = Object.entries(state.extraOverrides)
      .map(([i, o]) => `${i}:${o.amount != null ? o.amount : ''}:${o.mode ? MODE_URL[o.mode] : ''}`)
      .join(',');
    if (plan) p.set('plan', plan);
    const hash = '#' + p.toString();
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  function readUrl() {
    const raw = location.hash.slice(1);
    if (!raw) return;
    const p = new URLSearchParams(raw);
    for (const [name, key] of Object.entries(URL_KEYS)) {
      const input = $(name);
      if (!p.has(key)) {
        // Volitelná pole, která v adrese chybí, mají zůstat prázdná.
        if (OPTIONAL_FIELDS.includes(name)) input.value = '';
        continue;
      }
      const v = parseNum(p.get(key));
      input.value = v == null || Number.isNaN(v) ? '' : formatFieldValue(input, v);
    }
    const start = p.get('start') && parseStart(p.get('start'));
    if (start) $('start').value = `${start.y}-${String(start.m).padStart(2, '0')}`;
    const mode = p.get('pouziti') === MODE_URL.term ? 'term' : 'payment';
    form.querySelector(`input[name="extraMode"][value="${mode}"]`).checked = true;
    $('limitBase').value = p.get('zaklad') === BASE_URL.balance ? 'balance' : 'original';

    for (const part of (p.get('sazby') || '').split(',')) {
      const [i, rate] = part.split(':');
      const idx = parseInt(i, 10);
      const r = parseNum(rate);
      if (idx >= 0 && r != null && !Number.isNaN(r) && r >= 0 && r <= 30) state.rateOverrides[idx] = r;
    }
    for (const part of (p.get('plan') || '').split(',')) {
      const [i, amount, m] = part.split(':');
      const idx = parseInt(i, 10);
      if (!(idx >= 0)) continue;
      const o = {};
      const a = parseNum(amount);
      if (a != null && !Number.isNaN(a) && a >= 0) o.amount = a;
      if (m === MODE_URL.payment) o.mode = 'payment';
      if (m === MODE_URL.term) o.mode = 'term';
      if (Object.keys(o).length) state.extraOverrides[idx] = o;
    }
  }

  // ---------- Hlavní přepočet ----------
  function update(rebuild) {
    const { errors, input, start } = readInput();
    showErrors(errors);
    const ok = Object.keys(errors).length === 0;
    results.classList.toggle('is-stale', !ok);
    $('invalid-note').hidden = ok;
    $('original-field').hidden = $('limitBase').value !== 'original';
    if (!ok) return;

    const res = calculate(input);
    state.last = { res, input, start };
    if (rebuild) {
      renderRatesEditor(res.periods, start);
      renderPlanStructure(res.extras, start);
    }
    $('firstFix').placeholder = nfDec.format(input.fixMonths / 12);
    $('originalPrincipal').placeholder = nf0.format(input.principal);
    updatePlanResults(res, start);
    renderVerdict(res, start);
    renderCards(res, start);
    renderChart();
    renderSummary(res, start);
    renderSchedule(res, start);
    writeUrl();
  }

  let timer = null;
  function scheduleUpdate(rebuild) {
    clearTimeout(timer);
    timer = setTimeout(() => update(rebuild), 120);
  }

  /** Uloží ruční úpravu; hodnota shodná s výchozí (nebo prázdná) úpravu zruší. */
  function setOverride(store, i, field, value, defaultValue) {
    const o = store[i] || {};
    if (value == null || value === defaultValue) delete o[field];
    else o[field] = value;
    if (Object.keys(o).length) store[i] = o;
    else delete store[i];
  }

  function init() {
    // Výchozí první splátka: příští měsíc.
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    $('start').value = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
    $('start').placeholder = 'RRRR-MM';

    readUrl();

    form.addEventListener('input', (e) => {
      if (ratesBody.contains(e.target)) return;
      scheduleUpdate(true);
    });
    form.addEventListener('change', (e) => {
      if (ratesBody.contains(e.target)) return;
      if (e.target.type === 'radio' || e.target.tagName === 'SELECT') update(true);
    });
    form.addEventListener('submit', (e) => e.preventDefault());

    // Po opuštění pole hezky naformátovat číslo (mezery mezi tisíci, desetinná čárka).
    document.addEventListener('focusout', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement) || t.type !== 'text' || t.getAttribute('aria-invalid') === 'true') return;
      if (planBody.contains(t)) {
        t.value = planDisplayAmount(t);
      } else if (ratesBody.contains(t)) {
        const p = state.last && state.last.res.periods[+t.dataset.index];
        if (p) t.value = nfDec.format(p.rate);
      } else if (t.id in FIELDS) {
        const v = parseNum(t.value);
        if (v != null && !Number.isNaN(v)) t.value = formatFieldValue(t, v);
      }
    });

    // Sazby jednotlivých fixací
    ratesBody.addEventListener('input', (e) => {
      const t = e.target;
      const i = +t.dataset.index;
      const v = parseNum(t.value);
      if (v !== null && (Number.isNaN(v) || v < 0 || v > 30)) {
        t.setAttribute('aria-invalid', 'true');
        return;
      }
      t.removeAttribute('aria-invalid');
      if (v === null) delete state.rateOverrides[i];
      else state.rateOverrides[i] = v;
      t.classList.toggle('is-custom', v !== null);
      scheduleUpdate(false);
    });
    $('reset-rates').addEventListener('click', () => {
      state.rateOverrides = {};
      update(true);
    });
    if (Object.keys(state.rateOverrides).length) $('rates-details').open = true;

    // Plán mimořádných splátek
    planBody.addEventListener('input', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement) || t.type !== 'text') return;
      const i = +t.dataset.index;
      const extra = state.last && state.last.res.extras[i];
      const v = parseNum(t.value);
      if (v !== null && (Number.isNaN(v) || v < 0)) {
        t.setAttribute('aria-invalid', 'true');
        return;
      }
      t.removeAttribute('aria-invalid');
      setOverride(state.extraOverrides, i, 'amount', v, extra ? extra.defaultAmount : null);
      t.classList.toggle('is-custom', !!(state.extraOverrides[i] && state.extraOverrides[i].amount != null));
      scheduleUpdate(false);
    });
    planBody.addEventListener('change', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement) || t.type !== 'radio') return;
      const i = +t.dataset.index;
      const extra = state.last && state.last.res.extras[i];
      setOverride(state.extraOverrides, i, 'mode', t.value, extra ? extra.defaultMode : null);
      t.closest('.segmented').classList.toggle('is-custom', !!(state.extraOverrides[i] && state.extraOverrides[i].mode));
      update(false);
    });
    $('reset-plan').addEventListener('click', () => {
      state.extraOverrides = {};
      update(true);
    });

    document.querySelectorAll('.tabs [role="tab"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.metric = btn.dataset.metric;
        document.querySelectorAll('.tabs [role="tab"]').forEach((b) =>
          b.setAttribute('aria-selected', String(b === btn)),
        );
        renderChart();
      });
    });
    $('show-refs').addEventListener('change', renderChart);

    document.querySelectorAll('input[name="scenario"], input[name="granularity"]').forEach((r) =>
      r.addEventListener('change', () => state.last && renderSchedule(state.last.res, state.last.start)),
    );

    $('export-csv').addEventListener('click', exportCsv);

    $('copy-link').addEventListener('click', async () => {
      const status = $('copy-status');
      try {
        await navigator.clipboard.writeText(location.href);
        status.textContent = 'Odkaz zkopírován.';
      } catch (err) {
        status.textContent = 'Zkopírujte adresu z adresního řádku.';
      }
      setTimeout(() => (status.textContent = ''), 3000);
    });

    // Při přepnutí světlého/tmavého režimu překreslit graf novými barvami.
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', renderChart);

    // Při změně šířky přepočítat rozestup popisků let.
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(renderChart, 150);
    });

    update(true);
  }

  init();
})();

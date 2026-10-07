/* Uživatelské rozhraní kalkulačky: formulář, karty, graf a tabulky. */
(function () {
  'use strict';

  const { calculate, aggregateByYear } = window.HypoCalc;

  // ---------- Formátování ----------
  const nf0 = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 });
  const nfDec = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 3 });
  const nfRate = new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  const nfCompact = new Intl.NumberFormat('cs-CZ', { notation: 'compact', maximumFractionDigits: 1 });
  const dfLong = new Intl.DateTimeFormat('cs-CZ', { month: 'long', year: 'numeric' });

  const kc = (v) => nf0.format(Math.round(v) || 0);
  const czk = (v) => kc(v) + '\u00a0Kč';
  const pct = (v) => nfRate.format(v) + '\u00a0%';

  function plural(n, one, few, many) {
    if (n === 1) return one;
    if (n >= 2 && n <= 4) return few;
    return many;
  }

  function duration(months) {
    const y = Math.floor(months / 12);
    const m = months % 12;
    const parts = [];
    if (y) parts.push(`${y}\u00a0${plural(y, 'rok', 'roky', 'let')}`);
    if (m) parts.push(`${m}\u00a0${plural(m, 'měsíc', 'měsíce', 'měsíců')}`);
    return parts.join(' a ') || '0\u00a0měsíců';
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
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  /** Odstavec, kde objekty {b: '…'} jsou tučně. */
  function rich(parts) {
    return el('p', null, parts.map((p) => (typeof p === 'string' ? p : el('strong', null, p.b))));
  }

  const SCENARIOS = [
    { key: 'none', label: 'Bez předčasné splátky', short: 'Bez předč.', color: '--series-base' },
    { key: 'payment', label: 'Snížení splátky', short: 'Snížení', color: '--series-1' },
    { key: 'term', label: 'Zkrácení doby', short: 'Zkrácení', color: '--series-2' },
  ];
  const keyEl = (key) => el('span', { class: `key key-${key}`, 'aria-hidden': 'true' });

  // ---------- Vstupy ----------
  function parseNum(raw) {
    const s = String(raw == null ? '' : raw)
      .replace(/[\s\u00a0 ]/g, '')
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
    prepayment: { min: 0, max: 1e9, required: false, msg: 'Zadejte částku 0 Kč nebo vyšší.' },
  };

  // Názvy parametrů v adrese stránky (aby šel výpočet sdílet odkazem).
  const URL_KEYS = {
    principal: 'castka',
    rate: 'sazba',
    term: 'doba',
    fix: 'fixace',
    firstFix: 'konecFixace',
    nextRate: 'dalsiSazba',
    prepayment: 'splatka',
  };

  const state = {
    overrides: {}, // {index: {rate?, prepayment?}}
    metric: 'balance',
    last: null,
  };

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

  function readInput() {
    const errors = {};
    const v = {};
    for (const [name, rule] of Object.entries(FIELDS)) {
      const n = parseNum($(name).value);
      v[name] = n;
      if (n === null) {
        if (rule.required) errors[name] = rule.msg;
      } else if (Number.isNaN(n) || n < rule.min || n > rule.max) {
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
        prepayment: v.prepayment || 0,
        prepayWhen: form.querySelector('input[name="when"]:checked').value,
        overrides: state.overrides,
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

  // ---------- Editor fixačních období ----------
  function renderEditor(periods, start) {
    const tbody = $('periods-editor').tBodies[0];
    tbody.replaceChildren(
      ...periods.map((p) => {
        const ov = state.overrides[p.index] || {};
        const rateVal = ov.rate != null ? ov.rate : p.defaultRate;
        const rateInput = el('input', {
          type: 'text',
          inputmode: 'decimal',
          value: nfDec.format(rateVal),
          'data-index': p.index,
          'data-field': 'rate',
          'aria-label': `Sazba ${p.index + 1}. fixace v procentech`,
          class: ov.rate != null ? 'is-custom' : null,
        });
        let prepayCell;
        if (p.isLast) {
          prepayCell = el('td', { class: 'na' }, 'konec úvěru');
        } else {
          const prepVal = ov.prepayment != null ? ov.prepayment : p.defaultPrepayment;
          prepayCell = el(
            'td',
            null,
            el('div', { class: 'input-unit' },
              el('input', {
                type: 'text',
                inputmode: 'numeric',
                value: nf0.format(prepVal),
                'data-index': p.index,
                'data-field': 'prepayment',
                'data-format': 'money',
                'aria-label': `Předčasná splátka na konci ${p.index + 1}. fixace v Kč`,
                class: ov.prepayment != null ? 'is-custom' : null,
              }),
              el('span', null, 'Kč'),
            ),
          );
        }
        return el(
          'tr',
          null,
          el('td', null, `${p.index + 1}. fixace`,
            el('span', { class: 'period-dates' }, `${fmtMonth(start, p.startMonth + 1)} – ${fmtMonth(start, p.endMonth)}`)),
          el('td', null, rateInput),
          prepayCell,
        );
      }),
    );
  }

  function editorDisplayValue(input) {
    const i = +input.dataset.index;
    const field = input.dataset.field;
    const ov = state.overrides[i] || {};
    const p = state.last && state.last.res.periods[i];
    if (!p) return input.value;
    const val = ov[field] != null ? ov[field] : field === 'rate' ? p.defaultRate : p.defaultPrepayment;
    return field === 'rate' ? nfDec.format(val) : nf0.format(val);
  }

  // ---------- Výsledky ----------
  function firstPrepayIndex(sim) {
    return sim.periods.findIndex((p) => p.prepayment > 0);
  }

  function renderVerdict(res) {
    const { none, payment, term } = res;
    const box = $('verdict');
    if (payment.totalPrepaid <= 0) {
      box.replaceChildren(
        rich(['Zadejte ', { b: 'částku předčasné splátky' }, ' – bez ní vycházejí všechny varianty stejně.']),
      );
      return;
    }
    const saveP = none.totalInterest - payment.totalInterest;
    const saveT = none.totalInterest - term.totalInterest;
    const shorter = none.months - term.months;
    const diff = saveT - saveP;

    const first = [
      'Zkrácením doby ušetříte na úrocích ',
      { b: czk(saveT) },
      shorter > 0 ? ' a hypotéku splatíte o ' : '',
      shorter > 0 ? { b: duration(shorter) } : '',
      shorter > 0 ? ' dřív' : '',
      '. Snížením splátky ušetříte ',
      { b: czk(saveP) },
      payment.months < none.months
        ? ` (i tady úvěr skončí o ${duration(none.months - payment.months)} dřív, protože předčasná splátka doplatí celý zbytek dluhu).`
        : '.',
    ];

    const second = [];
    if (Math.abs(diff) >= 1) {
      second.push(
        diff > 0 ? 'Zkrácení doby tedy vychází na úrocích o ' : 'Snížení splátky tu vychází na úrocích o ',
        { b: czk(Math.abs(diff)) },
        ' lépe. ',
      );
    }
    const j = firstPrepayIndex(payment);
    const after = payment.periods[j + 1];
    const afterNone = none.periods[j + 1];
    if (after && afterNone) {
      second.push(
        'Snížení splátky zase uleví rozpočtu: po první předčasné splátce budete platit o ',
        { b: czk(afterNone.payment - after.payment) },
        ' měsíčně méně.',
      );
    }
    box.replaceChildren(rich(first), second.length ? rich(second) : '');
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
      stats,
    );
  }

  function renderCards(res, start) {
    const { none, payment, term } = res;
    const saveP = none.totalInterest - payment.totalInterest;
    const saveT = none.totalInterest - term.totalInterest;
    const shorter = none.months - term.months;
    const hasPrepay = payment.totalPrepaid > 0;

    const j = firstPrepayIndex(payment);
    const after = hasPrepay ? payment.periods[j + 1] : null;
    const afterNone = hasPrepay ? none.periods[j + 1] : null;
    const paymentChanges = Math.abs(none.lastPayment - none.firstPayment) >= 1;

    $('cards').replaceChildren(
      card('none', 'Bez předčasné splátky', 'srovnávací varianta', [
        stat('Měsíční splátka', czk(none.firstPayment), [
          paymentChanges ? `v poslední fixaci ${czk(none.lastPayment)}` : null,
        ]),
        stat('Zaplacené úroky', czk(none.totalInterest), [`celkem zaplatíte ${czk(none.totalPaid)}`]),
        stat('Doba splácení', duration(none.months), [`poslední splátka ${fmtMonthLong(start, none.months)}`]),
      ]),
      card('payment', 'Snížení splátky', payment.months < none.months ? 'předčasná splátka doplatí celý úvěr' : 'doba splácení zůstává stejná', [
        after && afterNone
          ? stat('Splátka po 1. předčasné splátce', czk(after.payment), [
              { cls: 'good', text: `o ${czk(afterNone.payment - after.payment)} měsíčně méně` },
              payment.periods.length > j + 2 ? `v poslední fixaci ${czk(payment.lastPayment)}` : null,
            ])
          : stat('Měsíční splátka', czk(payment.firstPayment)),
        stat('Zaplacené úroky', czk(payment.totalInterest), [
          hasPrepay ? { cls: 'good', text: `úspora ${czk(saveP)}` } : null,
        ]),
        stat('Předčasně splaceno', czk(payment.totalPrepaid), [`poslední splátka ${fmtMonthLong(start, payment.months)}`]),
      ]),
      card('term', 'Zkrácení doby', 'měsíční splátka zůstává stejná', [
        stat('Doba splácení', duration(term.months), [
          shorter > 0 ? { cls: 'good', text: `o ${duration(shorter)} kratší` } : null,
          `poslední splátka ${fmtMonthLong(start, term.months)}`,
        ]),
        stat('Zaplacené úroky', czk(term.totalInterest), [
          hasPrepay ? { cls: 'good', text: `úspora ${czk(saveT)}` } : null,
        ]),
        stat('Předčasně splaceno', czk(term.totalPrepaid), [
          term.totalPrepaid < payment.totalPrepaid - 0.5 ? 'méně než u snížení splátky – úvěr skončí dřív' : null,
        ]),
      ]),
    );
  }

  function scenarioHeaderCells(extraClassFirst, short) {
    return SCENARIOS.map((s, i) =>
      el('th', { scope: 'col', class: i === 0 ? extraClassFirst : null, title: s.label },
        el('span', { class: 'th-key' }, keyEl(s.key), short ? s.short : s.label)),
    );
  }

  function renderSummary(res, start) {
    const sims = SCENARIOS.map((s) => res[s.key]);
    const none = res.none;
    const j = firstPrepayIndex(res.payment);

    const rows = [
      ['Měsíční splátka na začátku', (s) => czk(s.firstPayment)],
      [
        'Měsíční splátka po 1. předčasné splátce',
        (s) => {
          const p = j >= 0 ? s.periods[j + 1] : null;
          return p ? czk(p.payment) : '—';
        },
      ],
      ['Měsíční splátka v poslední fixaci', (s) => czk(s.lastPayment)],
      ['Doba splácení', (s) => duration(s.months)],
      ['Poslední splátka', (s) => fmtMonth(start, s.months)],
      ['Předčasně splaceno celkem', (s) => czk(s.totalPrepaid)],
      ['Zaplacené úroky', (s) => czk(s.totalInterest)],
      ['Celkem zaplaceno bance', (s) => czk(s.totalPaid)],
      [
        'Úspora na úrocích',
        (s) => (s === none ? '—' : { text: czk(none.totalInterest - s.totalInterest), cls: 'good' }),
      ],
      [
        'Úspora na každých 100 000 Kč předčasné splátky',
        (s) =>
          s === none || s.totalPrepaid <= 0
            ? '—'
            : czk(((none.totalInterest - s.totalInterest) / s.totalPrepaid) * 100000),
      ],
      ['Zkrácení doby splácení', (s) => (s === none || s.months >= none.months ? '—' : duration(none.months - s.months))],
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
                ? el('td', { class: v === '—' ? 'muted' : null }, v)
                : el('td', { class: v.cls }, v.text);
            })),
        ),
      ),
    );
  }

  function renderPeriodsTable(res, start) {
    const sims = SCENARIOS.map((s) => res[s.key]);
    const head = el(
      'thead',
      null,
      el('tr', null,
        el('th', { scope: 'col', rowspan: 2 }, 'Fixace'),
        el('th', { scope: 'col', rowspan: 2 }, 'Sazba'),
        el('th', { scope: 'col', rowspan: 2 }, 'Předčasná splátka', el('br'), 'na konci (Kč)'),
        el('th', { scope: 'colgroup', colspan: 3, class: 'group-start' }, 'Měsíční splátka (Kč)'),
        el('th', { scope: 'colgroup', colspan: 3, class: 'group-start' }, 'Zůstatek na konci fixace (Kč)'),
      ),
      el('tr', null, scenarioHeaderCells('group-start', true), scenarioHeaderCells('group-start', true)),
    );

    const body = el(
      'tbody',
      null,
      res.periods.map((p) => {
        const pays = sims.map((s, i) => {
          const pr = s.periods[p.index];
          const cls = i === 0 ? 'group-start' : null;
          return pr ? el('td', { class: cls }, kc(pr.payment)) : el('td', { class: `muted ${cls || ''}` }, '—');
        });
        const bals = sims.map((s, i) => {
          const pr = s.periods[p.index];
          const cls = i === 0 ? 'group-start' : '';
          if (!pr) return el('td', { class: `muted ${cls}` }, 'splaceno');
          if (pr.paidOff) return el('td', { class: `good ${cls}` }, ['splaceno', el('span', { class: 'period-dates' }, fmtMonth(start, pr.endMonth))]);
          return el('td', { class: cls || null }, kc(pr.endBalance));
        });
        return el(
          'tr',
          null,
          el('th', { scope: 'row' }, `${p.index + 1}. fixace`,
            el('span', { class: 'muted period-dates' }, `${fmtMonth(start, p.startMonth + 1)} – ${fmtMonth(start, p.endMonth)}`)),
          el('td', null, pct(p.rate)),
          el('td', { class: p.isLast || !p.prepayment ? 'muted' : null }, p.isLast ? '—' : kc(p.prepayment)),
          pays,
          bals,
        );
      }),
    );
    $('periods-table').replaceChildren(head, body);
  }

  function selectedRadio(name) {
    const checked = document.querySelector(`input[name="${name}"]:checked`);
    return checked ? checked.value : null;
  }

  function renderSchedule(res, start) {
    const sim = res[selectedRadio('scenario')];
    const byYear = selectedRadio('granularity') === 'year';
    const table = $('schedule-table');

    const headCells = byYear
      ? ['Rok', 'Období', 'Sazba', 'Splátky', 'z toho úrok', 'z toho jistina', 'Předčasná splátka', 'Zůstatek']
      : ['Splátka č.', 'Měsíc', 'Sazba', 'Splátka', 'z toho úrok', 'z toho jistina', 'Předčasná splátka', 'Zůstatek'];

    const rows = byYear
      ? aggregateByYear(sim.rows).map((y) => [
          `${y.year}.`,
          `${fmtMonth(start, y.fromMonth)} – ${fmtMonth(start, y.toMonth)}`,
          y,
        ])
      : sim.rows.map((r) => [`${r.month}.`, fmtMonth(start, r.month), r]);

    const sum = (k) => sim.rows.reduce((s, r) => s + r[k], 0);

    table.replaceChildren(
      el('thead', null, el('tr', null, headCells.map((h) => el('th', { scope: 'col' }, h)))),
      el(
        'tbody',
        null,
        rows.map(([a, b, r]) =>
          el(
            'tr',
            { class: r.prepayment > 0 ? 'prepay-row' : null },
            el('th', { scope: 'row' }, a),
            el('td', null, b),
            el('td', null, pct(r.rate)),
            el('td', null, czk(r.payment)),
            el('td', null, czk(r.interest)),
            el('td', null, czk(r.principal)),
            el('td', { class: r.prepayment > 0 ? null : 'muted' }, r.prepayment > 0 ? czk(r.prepayment) : '—'),
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
    const num = (v) => (Math.round(v * 100) / 100).toFixed(2).replace('.', ',');
    const lines = [
      ['Splátka č.', 'Měsíc', 'Sazba (%)', 'Splátka (Kč)', 'Úrok (Kč)', 'Jistina (Kč)', 'Předčasná splátka (Kč)', 'Zůstatek (Kč)'].join(';'),
      ...sim.rows.map((r) =>
        [r.month, fmtMonth(start, r.month), String(r.rate).replace('.', ','), num(r.payment), num(r.interest), num(r.principal), num(r.prepayment), num(r.balance)].join(';'),
      ),
    ];
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const names = { none: 'bez-predcasne-splatky', payment: 'snizeni-splatky', term: 'zkraceni-doby' };
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
    balance: 'Zůstatek úvěru po každé splátce. Svislé linky označují konce fixací s předčasnou splátkou.',
    payment: 'Řádná měsíční splátka (bez předčasných splátek). Po splacení úvěru je splátka nulová.',
    interest: 'Kolik jste od začátku splácení zaplatili na úrocích.',
  };

  function buildSeries(res, input, metric, horizon) {
    return SCENARIOS.map((s) => {
      const rows = res[s.key].rows;
      const data = [];
      let cum = 0;
      if (metric !== 'payment') data.push({ x: 0, y: metric === 'balance' ? input.principal : 0 });
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
    });
  }

  // Svislé linky v měsících předčasných splátek.
  const markersPlugin = {
    id: 'prepayMarkers',
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
      if (y % step !== 0 && step > 1) continue;
      const k = (y - start.y) * 12 - (start.m - 1) + 1;
      if (k > horizon) break;
      ticks.push({ value: k, label: String(y) });
    }
    return ticks;
  }

  function renderChart() {
    if (!state.last || typeof window.Chart === 'undefined') return;
    const { res, input, start } = state.last;
    const metric = state.metric;
    const horizon = Math.max(res.none.months, res.payment.months, res.term.months);
    const series = buildSeries(res, input, metric, horizon);

    const colors = {
      ink: cssVar('--ink'),
      ink2: cssVar('--ink-2'),
      muted: cssVar('--muted'),
      grid: cssVar('--grid'),
      axis: cssVar('--axis'),
      surface: cssVar('--surface'),
      border: cssVar('--border-strong'),
    };

    const datasets = SCENARIOS.map((s, i) => {
      const color = cssVar(s.color);
      return {
        label: s.label,
        data: series[i],
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
        // Šedou srovnávací variantu kreslíme pod barevné.
        order: s.key === 'none' ? 3 : i === 1 ? 2 : 1,
      };
    });

    const prepayMonths = res.periods.filter((p) => !p.isLast && p.prepayment > 0).map((p) => p.endMonth);
    const prepayAt = (k) => {
      const amounts = ['payment', 'term'].map((key) => (res[key].rows[k - 1] || {}).prepayment || 0);
      return Math.max(...amounts);
    };

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
        prepayMarkers: { months: prepayMonths, color: colors.axis },
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
              const k = items[0].parsed.x;
              const amt = k > 0 ? prepayAt(k) : 0;
              return amt > 0 ? `Konec fixace: předčasná splátka ${czk(amt)}` : '';
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
            callback: (v) => (v === 0 ? '0' : nfCompact.format(v) + '\u00a0Kč'),
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
    $('chart-caption').textContent = CAPTIONS[metric];
  }

  function renderLegend() {
    $('legend').replaceChildren(...SCENARIOS.map((s) => el('li', null, keyEl(s.key), s.label)));
  }

  // ---------- Adresa stránky ----------
  function writeUrl() {
    const p = new URLSearchParams();
    for (const [name, key] of Object.entries(URL_KEYS)) {
      const v = parseNum($(name).value);
      if (v != null && !Number.isNaN(v)) p.set(key, String(v));
    }
    p.set('start', $('start').value);
    p.set('kdy', selectedRadio('when'));
    const ov = Object.entries(state.overrides)
      .filter(([, o]) => o.rate != null || o.prepayment != null)
      .map(([i, o]) => `${i}:${o.rate != null ? o.rate : ''}:${o.prepayment != null ? o.prepayment : ''}`)
      .join(',');
    if (ov) p.set('upravy', ov);
    const hash = '#' + p.toString();
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  function readUrl() {
    const raw = location.hash.slice(1);
    if (!raw) return;
    const p = new URLSearchParams(raw);
    for (const [name, key] of Object.entries(URL_KEYS)) {
      if (!p.has(key)) continue;
      const input = $(name);
      const v = parseNum(p.get(key));
      input.value = v == null || Number.isNaN(v) ? '' : formatFieldValue(input, v);
    }
    // Volitelná pole, která v adrese chybí, mají zůstat prázdná.
    for (const name of ['firstFix', 'nextRate']) if (!p.has(URL_KEYS[name])) $(name).value = '';
    const start = p.get('start') && parseStart(p.get('start'));
    if (start) $('start').value = `${start.y}-${String(start.m).padStart(2, '0')}`;
    const when = p.get('kdy');
    const radio = when && form.querySelector(`input[name="when"][value="${when === 'first' ? 'first' : 'every'}"]`);
    if (radio) radio.checked = true;
    const ov = p.get('upravy');
    if (ov) {
      for (const part of ov.split(',')) {
        const [i, rate, prep] = part.split(':');
        const idx = parseInt(i, 10);
        if (!(idx >= 0)) continue;
        const o = {};
        const r = parseNum(rate);
        const pp = parseNum(prep);
        if (r != null && !Number.isNaN(r) && r >= 0 && r <= 30) o.rate = r;
        if (pp != null && !Number.isNaN(pp) && pp >= 0) o.prepayment = pp;
        if (Object.keys(o).length) state.overrides[idx] = o;
      }
    }
  }

  // ---------- Hlavní přepočet ----------
  const form = $('form');
  const results = $('results');

  function update(rebuildEditor) {
    const { errors, input, start } = readInput();
    showErrors(errors);
    const ok = Object.keys(errors).length === 0;
    results.classList.toggle('is-stale', !ok);
    $('invalid-note').hidden = ok;
    if (!ok) return;

    const res = calculate(input);
    state.last = { res, input, start };
    if (rebuildEditor) renderEditor(res.periods, start);
    $('firstFix').placeholder = nfDec.format(input.fixMonths / 12);
    renderVerdict(res);
    renderCards(res, start);
    renderChart();
    renderSummary(res, start);
    renderPeriodsTable(res, start);
    renderSchedule(res, start);
    writeUrl();
  }

  let timer = null;
  function scheduleUpdate(rebuildEditor) {
    clearTimeout(timer);
    timer = setTimeout(() => update(rebuildEditor), 120);
  }

  function init() {
    // Výchozí první splátka: příští měsíc.
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    $('start').value = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
    $('start').placeholder = 'RRRR-MM';

    readUrl();
    renderLegend();

    const editorBody = $('periods-editor').tBodies[0];

    form.addEventListener('input', (e) => {
      if (editorBody.contains(e.target)) return;
      scheduleUpdate(true);
    });
    form.addEventListener('change', (e) => {
      if (editorBody.contains(e.target)) return;
      if (e.target.name === 'when') update(true);
    });
    form.addEventListener('submit', (e) => e.preventDefault());

    // Po opuštění pole hezky naformátovat číslo (mezery mezi tisíci, desetinná čárka).
    form.addEventListener('focusout', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement) || t.type !== 'text') return;
      if (editorBody.contains(t)) {
        if (t.getAttribute('aria-invalid') !== 'true') t.value = editorDisplayValue(t);
        return;
      }
      if (t.id in FIELDS) {
        const v = parseNum(t.value);
        if (v != null && !Number.isNaN(v)) t.value = formatFieldValue(t, v);
      }
    });

    editorBody.addEventListener('input', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement)) return;
      const i = +t.dataset.index;
      const field = t.dataset.field;
      const v = parseNum(t.value);
      const valid = v === null || (!Number.isNaN(v) && v >= 0 && (field !== 'rate' || v <= 30));
      if (!valid) {
        t.setAttribute('aria-invalid', 'true');
        return;
      }
      t.removeAttribute('aria-invalid');
      const ov = state.overrides[i] || {};
      if (v === null) delete ov[field];
      else ov[field] = v;
      if (Object.keys(ov).length) state.overrides[i] = ov;
      else delete state.overrides[i];
      t.classList.toggle('is-custom', v !== null);
      scheduleUpdate(false);
    });

    $('reset-overrides').addEventListener('click', () => {
      state.overrides = {};
      update(true);
    });

    if (Object.keys(state.overrides).length) $('periods-details').open = true;

    document.querySelectorAll('.tabs [role="tab"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.metric = btn.dataset.metric;
        document.querySelectorAll('.tabs [role="tab"]').forEach((b) =>
          b.setAttribute('aria-selected', String(b === btn)),
        );
        renderChart();
      });
    });

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

// Spuštění: npm test  (nebo node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { annuity, nper, buildPeriods, buildExtras, calculate, aggregateByYear } = require('../js/calc.js');

const base = {
  principal: 4000000,
  termMonths: 360,
  firstFixMonths: 60,
  fixMonths: 60,
  rate: 4.5,
  nextRate: null,
  extraAmount: 100000,
  extraMode: 'payment',
  extraYears: null,
  limitPct: 25,
  limitBase: 'original',
  originalPrincipal: null,
};

const close = (a, b, tol = 0.01) =>
  assert.ok(Math.abs(a - b) <= tol, `očekáváno ${b}, vyšlo ${a}`);
const conserves = (s, principal) => close(s.totalPaid, principal + s.totalInterest, 1e-4);
const applied = (s) => s.extras.filter((e) => e.applied > 0);

test('anuitní splátka odpovídá známé hodnotě', () => {
  close(annuity(4000000, 0.045 / 12, 360), 20267.42);
  close(annuity(1200, 0, 12), 100);
});

test('nper je inverzí k annuity', () => {
  const r = 0.05 / 12;
  close(nper(2500000, r, annuity(2500000, r, 217)), 217, 1e-6);
  close(nper(1200, 0, 100), 12, 1e-9);
});

test('fixační období pokryjí celou dobu splácení, sazby jdou upravit', () => {
  const periods = buildPeriods({ ...base, firstFixMonths: 24, fixMonths: 84, nextRate: 5, rateOverrides: { 2: 3.9 } });
  assert.deepEqual(
    periods.map((p) => [p.startMonth, p.endMonth]),
    [[0, 24], [24, 108], [108, 192], [192, 276], [276, 360]],
  );
  assert.deepEqual(periods.map((p) => p.rate), [4.5, 5, 3.9, 5, 5]);
});

test('výročí jdou po roce a jedno připadne na konec fixace', () => {
  const extras = buildExtras(base, buildPeriods(base));
  assert.equal(extras.length, 29);
  assert.deepEqual(extras.slice(0, 3).map((e) => e.month), [12, 24, 36]);
  assert.deepEqual(extras.filter((e) => e.isFixEnd).map((e) => e.month), [60, 120, 180, 240, 300]);

  const running = { ...base, firstFixMonths: 30 };
  const ex2 = buildExtras(running, buildPeriods(running));
  assert.deepEqual(ex2.slice(0, 4).map((e) => [e.month, e.isFixEnd]), [[6, false], [18, false], [30, true], [42, false]]);
});

test('výchozí částka jen v prvních N letech, ruční úpravy mají přednost', () => {
  const o = { ...base, extraYears: 3, extraOverrides: { 1: { mode: 'term' }, 5: { amount: 50000 } } };
  const extras = buildExtras(o, buildPeriods(o));
  assert.deepEqual(extras.slice(0, 7).map((e) => e.amount), [100000, 100000, 100000, 0, 0, 50000, 0]);
  assert.deepEqual(extras.slice(0, 3).map((e) => e.mode), ['payment', 'term', 'payment']);
});

test('bez mimořádných splátek: splaceno přesně za dobu splatnosti', () => {
  const { none } = calculate(base);
  assert.equal(none.months, 360);
  assert.equal(none.totalPrepaid, 0);
  assert.equal(none.extras.length, 0);
  assert.equal(none.rows.at(-1).balance, 0);
  close(none.firstPayment, 20267.42);
  conserves(none, base.principal);
});

test('snížení splátky: doba zůstává, splátka po každé mimořádné splátce klesá', () => {
  const { none, payment } = calculate({ ...base, extraYears: 10 });
  assert.equal(payment.months, 360);
  const after = applied(payment).map((e) => e.paymentAfter);
  assert.equal(after.length, 10);
  for (let i = 1; i < after.length; i++) assert.ok(after[i] < after[i - 1]);
  for (const e of applied(payment)) assert.equal(e.endMonthAfter, 360);
  assert.ok(payment.totalInterest < none.totalInterest);
  conserves(payment, base.principal);
  // po první mimořádné splátce = anuita ze zůstatku na zbylých 348 měsíců
  const first = payment.extras[0];
  close(first.paymentAfter, annuity(first.balanceAfter, 0.045 / 12, 348));
});

test('zkrácení doby: splátka zůstává, úvěr skončí dřív a ušetří víc na úrocích', () => {
  const { payment, term } = calculate(base);
  for (const e of applied(term).filter((x) => !x.paidOff)) close(e.paymentAfter, term.firstPayment, 1e-6);
  assert.ok(term.months < 360);
  assert.ok(term.totalInterest < payment.totalInterest);
  conserves(term, base.principal);
  assert.equal(term.rows.at(-1).balance, 0);
  // termín po poslední mimořádné splátce odpovídá skutečnému konci
  assert.equal(applied(term).at(-1).endMonthAfter, term.months);
  // výročí po splacení úvěru už nic nesplácí
  assert.ok(term.extras.every((e) => e.month <= term.months));
});

test('plán se smíšenou volbou: každá splátka působí podle své volby', () => {
  const o = { ...base, extraOverrides: { 0: { mode: 'term' } } };
  const { plan } = calculate({ ...o, extraYears: 2 });
  const [first, second] = plan.extras;
  // 1. splátka zkrátí dobu, splátka zůstane
  close(first.paymentAfter, plan.firstPayment, 1e-6);
  assert.ok(first.endMonthAfter < 360);
  // 2. splátka sníží splátku, termín zůstane
  assert.ok(second.paymentAfter < first.paymentAfter);
  assert.equal(second.endMonthAfter, first.endMonthAfter);
  assert.equal(plan.months, first.endMonthAfter);
  conserves(plan, base.principal);
});

test('plán se všemi splátkami na zkrácení = varianta „vše na zkrácení doby“', () => {
  const { plan, term } = calculate({ ...base, extraMode: 'term' });
  assert.equal(plan.months, term.months);
  close(plan.totalInterest, term.totalInterest, 1e-6);
});

test('limit 25 % z původní výše úvěru, na konci fixace bez limitu', () => {
  const big = { amount: 1500000 };
  const { plan } = calculate({ ...base, extraAmount: 0, extraOverrides: { 0: big, 4: big } });
  const [first] = plan.extras;
  assert.equal(first.limit, 1000000);
  assert.equal(first.applied, 1000000);
  assert.ok(first.capped);
  const fixEnd = plan.extras[4];
  assert.ok(fixEnd.isFixEnd);
  assert.equal(fixEnd.limit, Infinity);
  assert.equal(fixEnd.applied, 1500000);
  assert.ok(!fixEnd.capped);
  conserves(plan, base.principal);
});

test('limit lze počítat z aktuálního zůstatku nebo z jiné původní výše', () => {
  const { plan } = calculate({ ...base, extraAmount: 2000000, limitBase: 'balance' });
  const [first] = plan.extras;
  close(first.limit, 0.25 * first.balanceBefore, 1e-9);
  close(first.applied, first.limit, 1e-9);

  const res2 = calculate({ ...base, extraAmount: 2000000, originalPrincipal: 5000000, limitPct: 10 });
  assert.equal(res2.plan.extras[0].limit, 500000);
});

test('změna sazby: splátka se přepočítá, termín zůstane', () => {
  const res = calculate({ ...base, nextRate: 6.2, extraMode: 'term', extraAmount: 50000 });
  assert.equal(res.none.months, 360);
  assert.equal(res.payment.months, 360);
  for (const s of [res.none, res.plan, res.payment, res.term]) {
    conserves(s, base.principal);
    assert.equal(s.rows.at(-1).balance, 0);
  }
  // termín po poslední splátce platí i přes změnu sazby
  assert.equal(applied(res.term).at(-1).endMonthAfter, res.term.months);
  // vyšší sazba po fixaci → vyšší splátka i ve variantě zkrácení doby
  const atFixEnd = res.term.extras.find((e) => e.month === 60);
  assert.ok(atFixEnd.paymentAfter > res.term.firstPayment);
});

test('mimořádná splátka vyšší než zůstatek úvěr doplatí', () => {
  const res = calculate({ ...base, principal: 300000, extraAmount: 1000000, limitPct: 100 });
  for (const s of [res.plan, res.term, res.payment]) {
    assert.equal(s.months, 12);
    assert.ok(s.extras[0].paidOff);
    assert.equal(s.extras[0].paymentAfter, 0);
    conserves(s, 300000);
  }
});

test('nulová sazba', () => {
  const res = calculate({ ...base, rate: 0, principal: 360000, extraAmount: 12000 });
  close(res.none.firstPayment, 1000);
  assert.equal(res.none.totalInterest, 0);
  // 360 000 − 12 × 1000 − 12 000 = 336 000 na zbylých 348 měsíců
  close(res.payment.extras[0].paymentAfter, 336000 / 348);
  // zkrácení: každý rok 12 000 řádně + 12 000 mimořádně → 15 let
  assert.equal(res.term.months, 180);
});

test('roční přehled sedí na měsíční řádky', () => {
  const { plan } = calculate({ ...base, extraMode: 'term' });
  const years = aggregateByYear(plan.rows);
  assert.equal(years.length, Math.ceil(plan.months / 12));
  const sum = (arr, k) => arr.reduce((s, x) => s + x[k], 0);
  close(sum(years, 'interest'), plan.totalInterest, 1e-6);
  close(sum(years, 'prepayment'), plan.totalPrepaid, 1e-6);
  assert.equal(years.at(-1).balance, 0);
});

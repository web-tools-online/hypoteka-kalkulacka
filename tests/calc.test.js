// Spuštění: npm test  (nebo node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const { annuity, nper, buildPeriods, calculate, aggregateByYear } = require('../js/calc.js');

const base = {
  principal: 4000000,
  termMonths: 360,
  firstFixMonths: 60,
  fixMonths: 60,
  rate: 4.5,
  nextRate: null,
  prepayment: 300000,
  prepayWhen: 'every',
  overrides: {},
};

const close = (a, b, tol = 0.01) =>
  assert.ok(Math.abs(a - b) <= tol, `očekáváno ${b}, vyšlo ${a}`);

test('anuitní splátka odpovídá známé hodnotě', () => {
  close(annuity(4000000, 0.045 / 12, 360), 20267.42);
  close(annuity(1200, 0, 12), 100);
});

test('nper je inverzí k annuity', () => {
  const r = 0.05 / 12;
  close(nper(2500000, r, annuity(2500000, r, 217)), 217, 1e-6);
  close(nper(1200, 0, 100), 12, 1e-9);
});

test('fixační období pokryjí celou dobu splácení', () => {
  const periods = buildPeriods({ ...base, firstFixMonths: 24, fixMonths: 84 });
  assert.deepEqual(
    periods.map((p) => [p.startMonth, p.endMonth]),
    [[0, 24], [24, 108], [108, 192], [192, 276], [276, 360]],
  );
  assert.equal(periods.at(-1).prepayment, 0, 'na konci úvěru už předčasná splátka není');
});

test('jen první fixace: předčasná splátka pouze jednou', () => {
  const periods = buildPeriods({ ...base, prepayWhen: 'first' });
  assert.deepEqual(periods.map((p) => p.prepayment), [300000, 0, 0, 0, 0, 0]);
});

test('ruční úpravy období mají přednost před výchozími hodnotami', () => {
  const periods = buildPeriods({ ...base, nextRate: 5, overrides: { 1: { rate: 3.9, prepayment: 0 } } });
  assert.deepEqual(periods.map((p) => p.rate), [4.5, 3.9, 5, 5, 5, 5]);
  assert.deepEqual(periods.map((p) => p.prepayment), [300000, 0, 300000, 300000, 300000, 0]);
});

test('bez předčasné splátky: splaceno přesně za dobu splatnosti', () => {
  const { none } = calculate(base);
  assert.equal(none.months, 360);
  assert.equal(none.totalPrepaid, 0);
  assert.equal(none.rows.at(-1).balance, 0);
  close(none.firstPayment, 20267.42);
  close(none.totalPaid, base.principal + none.totalInterest, 1e-4);
});

test('snížení splátky: doba zůstává, splátka po každé předčasné splátce klesá', () => {
  const { none, payment } = calculate(base);
  assert.equal(payment.months, 360);
  const pays = payment.periods.map((p) => p.payment);
  for (let i = 1; i < pays.length; i++) assert.ok(pays[i] < pays[i - 1]);
  assert.ok(payment.totalInterest < none.totalInterest);
  assert.equal(payment.totalPrepaid, 5 * 300000);
  close(payment.totalPaid, base.principal + payment.totalInterest, 1e-4);
  // po první předčasné splátce = anuita ze zůstatku na zbylých 300 měsíců
  const afterFirst = payment.periods[0].endBalance;
  close(payment.periods[1].payment, annuity(afterFirst, 0.045 / 12, 300));
});

test('zkrácení doby: splátka zůstává, úvěr skončí dříve a ušetří víc na úrocích', () => {
  const { payment, term } = calculate(base);
  const pays = term.periods.map((p) => p.payment);
  for (const p of pays) close(p, pays[0], 1e-6);
  assert.ok(term.months < 360);
  assert.ok(term.totalInterest < payment.totalInterest);
  close(term.totalPaid, base.principal + term.totalInterest, 1e-4);
  assert.equal(term.rows.at(-1).balance, 0);
  assert.ok(term.rows.at(-1).payment <= pays[0] + 1e-6, 'poslední splátka nepřesáhne řádnou');
});

test('změna sazby: všechny scénáře doběhnou nejpozději v termínu', () => {
  const input = { ...base, nextRate: 6.2 };
  const res = calculate(input);
  assert.equal(res.none.months, 360);
  assert.equal(res.payment.months, 360);
  assert.ok(res.term.months <= 360);
  for (const s of [res.none, res.payment, res.term]) {
    close(s.totalPaid, base.principal + s.totalInterest, 1e-4);
    assert.equal(s.rows.at(-1).balance, 0);
  }
  // Zkrácení doby: po změně sazby se splátka přepočte, jako by předčasná splátka nebyla
  const t = res.term;
  const p0 = t.periods[0];
  const balanceBeforePrepay = p0.endBalance + p0.prepayment;
  close(t.periods[1].payment, annuity(balanceBeforePrepay, 0.062 / 12, 300));
});

test('předčasná splátka vyšší než zůstatek úvěr doplatí', () => {
  const res = calculate({ ...base, principal: 500000, prepayment: 1000000 });
  for (const s of [res.payment, res.term]) {
    assert.equal(s.months, 60);
    assert.equal(s.rows.at(-1).balance, 0);
    close(s.totalPrepaid, s.rows.at(-1).prepayment, 1e-9);
    close(s.totalPaid, 500000 + s.totalInterest, 1e-4);
  }
});

test('nulová sazba', () => {
  const res = calculate({ ...base, rate: 0, principal: 360000, prepayment: 60000 });
  close(res.none.firstPayment, 1000);
  assert.equal(res.none.totalInterest, 0);
  // 360 000 − 60×1000 − 60 000 = 240 000 na zbylých 300 měsíců
  close(res.payment.periods[1].payment, 800);
  // 1000 Kč/měs.: 300 000 → 240 000 → 180 000 → 120 000 → 60 000 → 0
  close(res.term.periods[1].payment, 1000);
  assert.equal(res.term.months, 180);
});

test('roční přehled sedí na měsíční řádky', () => {
  const { term } = calculate(base);
  const years = aggregateByYear(term.rows);
  assert.equal(years.length, Math.ceil(term.months / 12));
  const sum = (arr, k) => arr.reduce((s, x) => s + x[k], 0);
  close(sum(years, 'interest'), term.totalInterest, 1e-6);
  close(sum(years, 'prepayment'), term.totalPrepaid, 1e-6);
  assert.equal(years.at(-1).balance, 0);
});

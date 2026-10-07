/*
 * Výpočetní jádro kalkulačky – bez závislosti na DOM, aby šlo testovat v Node.js.
 *
 * Model:
 *  - anuitní splácení, měsíční úrok = zůstatek × (roční sazba / 12),
 *  - úvěr je rozdělen na fixační období; na začátku každého období se splátka
 *    přepočítá podle nové sazby tak, aby úvěr skončil v aktuálně platném termínu,
 *  - jednou ročně k výročí lze mimořádně splatit až stanovené procento úvěru
 *    (typicky 25 %); na konci fixace limit neplatí,
 *  - u každé mimořádné splátky se volí, jestli:
 *      'payment' … sníží měsíční splátku (doba splácení zůstane),
 *      'term'    … zkrátí dobu splácení (měsíční splátka zůstane).
 *
 * Scénáře (strategy):
 *   'none'    … bez mimořádných splátek (srovnávací základ),
 *   'plan'    … mimořádné splátky podle plánu, každá se svou volbou,
 *   'payment' … stejné částky, ale všechny snižují splátku,
 *   'term'    … stejné částky, ale všechny zkracují dobu.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HypoCalc = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Zůstatek pod půl haléře považujeme za splacený (ochrana proti chybám v plovoucí čárce).
  const EPS = 0.005;

  /** Anuitní měsíční splátka. `months` může být i neceločíselné. */
  function annuity(balance, monthlyRate, months) {
    if (balance <= 0) return 0;
    if (months <= 0) return balance;
    if (monthlyRate === 0) return balance / months;
    return (balance * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -months));
  }

  /** Počet (i neceločíselný) měsíců potřebných ke splacení zůstatku danou splátkou. */
  function nper(balance, monthlyRate, payment) {
    if (balance <= 0) return 0;
    if (monthlyRate === 0) return balance / payment;
    const x = 1 - (balance * monthlyRate) / payment;
    if (x <= 0) return Infinity;
    return -Math.log(x) / Math.log(1 + monthlyRate);
  }

  /**
   * Rozdělí dobu splácení na fixační období.
   *
   * @param {object} o
   * @param {number} o.termMonths       doba splácení v měsících
   * @param {number} o.firstFixMonths   za kolik měsíců končí první (aktuální) fixace
   * @param {number} o.fixMonths        délka každé další fixace v měsících
   * @param {number} o.rate             sazba první fixace (% p. a.)
   * @param {number|null} [o.nextRate]  sazba dalších fixací (% p. a.), null = stejná jako první
   * @param {Object<number,number>} [o.rateOverrides] ruční sazby podle pořadí fixace
   */
  function buildPeriods(o) {
    const overrides = o.rateOverrides || {};
    const periods = [];
    let start = 0;
    let i = 0;
    while (start < o.termMonths) {
      const len = i === 0 ? o.firstFixMonths : o.fixMonths;
      const end = Math.min(start + len, o.termMonths);
      const defaultRate = i === 0 || o.nextRate == null ? o.rate : o.nextRate;
      periods.push({
        index: i,
        startMonth: start, // počet měsíců uplynulých před začátkem období
        endMonth: end, // poslední měsíc období (pořadí splátky, 1 = první)
        isLast: end >= o.termMonths,
        defaultRate,
        rate: overrides[i] != null ? overrides[i] : defaultRate,
      });
      start = end;
      i++;
    }
    return periods;
  }

  /**
   * Výročí, ke kterým lze mimořádně splácet. Jdou po 12 měsících a jedno z nich
   * připadne na konec první fixace (u nového úvěru tedy 12., 24., 36. … měsíc).
   *
   * @param {object} o
   * @param {number} o.extraAmount       výchozí částka mimořádné splátky (Kč)
   * @param {'payment'|'term'} o.extraMode  výchozí použití
   * @param {number|null} [o.extraYears] kolik prvních výročí splácet (null = všechna)
   * @param {Object<number,{amount?:number,mode?:string}>} [o.extraOverrides] ruční úpravy
   */
  function buildExtras(o, periods) {
    const overrides = o.extraOverrides || {};
    const fixEnds = new Set(periods.filter((p) => !p.isLast).map((p) => p.endMonth));
    const first = ((o.firstFixMonths - 1) % 12) + 1;
    const extras = [];
    for (let m = first, i = 0; m < o.termMonths; m += 12, i++) {
      const ov = overrides[i] || {};
      const defaultAmount = o.extraYears == null || i < o.extraYears ? o.extraAmount : 0;
      extras.push({
        index: i,
        month: m,
        isFixEnd: fixEnds.has(m),
        defaultAmount,
        defaultMode: o.extraMode,
        amount: ov.amount != null ? ov.amount : defaultAmount,
        mode: ov.mode || o.extraMode,
      });
    }
    return extras;
  }

  /**
   * Simuluje splácení pro jeden scénář.
   *
   * @param {{principal:number, termMonths:number}} loan
   * @param {ReturnType<typeof buildPeriods>} periods
   * @param {ReturnType<typeof buildExtras>} extras
   * @param {'none'|'plan'|'payment'|'term'} strategy
   * @param {{pct:number, base:'original'|'balance', original:number}} limits
   */
  function simulate(loan, periods, extras, strategy, limits) {
    const T = loan.termMonths;
    let balance = loan.principal;
    let n = T; // zbývající doba splácení podle aktuálního rozpisu (může být neceločíselná)
    let payment = 0;
    let r = 0;
    let pi = -1;
    let pending = null; // mimořádná splátka, které ještě neznáme následnou splátku

    const byMonth = new Map();
    if (strategy !== 'none') for (const e of extras) byMonth.set(e.month, e);

    const rows = [];
    const extraResults = [];
    let totalInterest = 0;
    let totalPayments = 0;
    let totalPrepaid = 0;

    for (let m = 1; m <= T && balance > 0; m++) {
      if (pi < 0 || m > periods[pi].endMonth) {
        pi++;
        r = periods[pi].rate / 100 / 12;
        payment = annuity(balance, r, n);
      }
      if (pending) {
        pending.paymentAfter = payment;
        pending = null;
      }

      const interest = balance * r;
      let pay = payment;
      let principalPart = pay - interest;
      if (principalPart >= balance - EPS || m >= T) {
        principalPart = balance;
        pay = balance + interest;
      }
      balance -= principalPart;
      if (balance < EPS) balance = 0;
      n -= 1;

      let prepaid = 0;
      const e = byMonth.get(m);
      if (e) {
        const res = {
          index: e.index,
          month: m,
          isFixEnd: e.isFixEnd,
          mode: strategy === 'plan' ? e.mode : strategy,
          requested: e.amount,
          limit: Infinity,
          applied: 0,
          capped: false,
          paidOff: false,
          balanceBefore: balance,
          balanceAfter: balance,
          paymentAfter: null,
          endMonthAfter: null,
        };
        if (balance > 0) {
          if (!e.isFixEnd) {
            res.limit = (limits.pct / 100) * (limits.base === 'balance' ? balance : limits.original);
          }
          if (e.amount > 0) {
            prepaid = Math.min(e.amount, res.limit, balance);
            res.capped = e.amount > res.limit + EPS;
            balance -= prepaid;
            if (balance < EPS) balance = 0;
            res.applied = prepaid;
            res.balanceAfter = balance;
            if (balance === 0) {
              res.paidOff = true;
              res.paymentAfter = 0;
              res.endMonthAfter = m;
            } else {
              if (res.mode === 'term') n = nper(balance, r, payment);
              else payment = annuity(balance, r, n);
              res.endMonthAfter = Math.min(T, m + Math.ceil(n - 1e-6));
              pending = res;
            }
          }
        }
        extraResults.push(res);
      }

      totalInterest += interest;
      totalPayments += pay;
      totalPrepaid += prepaid;
      rows.push({
        month: m,
        rate: periods[pi].rate,
        payment: pay,
        interest,
        principal: principalPart,
        prepayment: prepaid,
        balance,
      });
    }

    const applied = extraResults.filter((x) => x.applied > 0);
    return {
      strategy,
      rows,
      extras: extraResults,
      months: rows.length,
      firstPayment: rows.length ? rows[0].payment : 0,
      // Řádná splátka po první a po poslední mimořádné splátce.
      paymentAfterFirst: applied.length ? applied[0].paymentAfter : null,
      paymentAfterLast: applied.length ? applied[applied.length - 1].paymentAfter : null,
      cappedCount: extraResults.filter((x) => x.capped).length,
      totalInterest,
      totalPayments,
      totalPrepaid,
      totalPaid: totalPayments + totalPrepaid,
    };
  }

  /** Spočítá všechny scénáře najednou. */
  function calculate(input) {
    const periods = buildPeriods(input);
    const extras = buildExtras(input, periods);
    const loan = { principal: input.principal, termMonths: input.termMonths };
    const limits = {
      pct: input.limitPct,
      base: input.limitBase,
      original: input.originalPrincipal || input.principal,
    };
    const run = (strategy) => simulate(loan, periods, extras, strategy, limits);
    return {
      periods,
      extras,
      none: run('none'),
      plan: run('plan'),
      payment: run('payment'),
      term: run('term'),
    };
  }

  /** Sečte měsíční řádky po letech splácení (1. rok = splátky 1–12). */
  function aggregateByYear(rows) {
    const years = [];
    for (const row of rows) {
      const y = Math.floor((row.month - 1) / 12);
      if (!years[y]) {
        years[y] = {
          year: y + 1,
          fromMonth: row.month,
          toMonth: row.month,
          rate: row.rate,
          payment: 0,
          interest: 0,
          principal: 0,
          prepayment: 0,
          balance: row.balance,
        };
      }
      const acc = years[y];
      acc.toMonth = row.month;
      acc.rate = row.rate;
      acc.payment += row.payment;
      acc.interest += row.interest;
      acc.principal += row.principal;
      acc.prepayment += row.prepayment;
      acc.balance = row.balance;
    }
    return years.filter(Boolean);
  }

  return { annuity, nper, buildPeriods, buildExtras, simulate, calculate, aggregateByYear };
});

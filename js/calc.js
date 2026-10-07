/*
 * Výpočetní jádro kalkulačky – bez závislosti na DOM, aby šlo testovat v Node.js.
 *
 * Model:
 *  - anuitní splácení, měsíční úrok = zůstatek × (roční sazba / 12),
 *  - úvěr je rozdělen na fixační období; na začátku každého období se splátka
 *    přepočítá podle aktuální sazby,
 *  - předčasná splátka se provede na konci fixačního období (hned po řádné
 *    splátce v posledním měsíci fixace),
 *  - scénáře:
 *      'none'    … bez předčasných splátek (srovnávací základ),
 *      'payment' … po předčasné splátce se sníží splátka, doba splatnosti zůstává,
 *      'term'    … po předčasné splátce zůstává splátka, zkrátí se doba splácení.
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
   * @param {number} o.firstFixMonths   délka první (aktuální) fixace v měsících
   * @param {number} o.fixMonths        délka každé další fixace v měsících
   * @param {number} o.rate             sazba první fixace (% p. a.)
   * @param {number|null} o.nextRate    sazba dalších fixací (% p. a.), null = stejná jako první
   * @param {number} o.prepayment       výchozí předčasná splátka (Kč)
   * @param {'every'|'first'} o.prepayWhen  na konci každé fixace / jen první
   * @param {Object<number,{rate?:number,prepayment?:number}>} [o.overrides] ruční úpravy po obdobích
   */
  function buildPeriods(o) {
    const overrides = o.overrides || {};
    const periods = [];
    let start = 0;
    let i = 0;
    while (start < o.termMonths) {
      const len = i === 0 ? o.firstFixMonths : o.fixMonths;
      const end = Math.min(start + len, o.termMonths);
      const isLast = end >= o.termMonths;
      const defaultRate = i === 0 || o.nextRate == null ? o.rate : o.nextRate;
      const defaultPrepayment =
        !isLast && (o.prepayWhen === 'every' || i === 0) ? o.prepayment : 0;
      const ov = overrides[i] || {};
      periods.push({
        index: i,
        startMonth: start, // počet měsíců uplynulých před začátkem období
        endMonth: end, // poslední měsíc období (1-based index splátky)
        isLast,
        defaultRate,
        defaultPrepayment,
        rate: ov.rate != null ? ov.rate : defaultRate,
        prepayment: isLast ? 0 : ov.prepayment != null ? ov.prepayment : defaultPrepayment,
      });
      start = end;
      i++;
    }
    return periods;
  }

  /**
   * Simuluje splácení pro jeden scénář.
   *
   * @param {{principal:number, termMonths:number}} loan
   * @param {ReturnType<typeof buildPeriods>} periods
   * @param {'none'|'payment'|'term'} mode
   */
  function simulate(loan, periods, mode) {
    const termMonths = loan.termMonths;
    let balance = loan.principal;
    let balanceBeforePrepay = balance;
    let payment = 0;
    let remaining = termMonths; // zbývající (neceločíselná) doba – jen pro režim 'term'
    let m = 0;

    const rows = [];
    const periodResults = [];
    let totalInterest = 0;
    let totalPayments = 0;
    let totalPrepaid = 0;

    for (const p of periods) {
      if (balance <= 0) break;
      const r = p.rate / 100 / 12;

      if (mode === 'term') {
        if (p.index === 0) {
          payment = annuity(balance, r, termMonths);
          remaining = termMonths;
        } else {
          // Splátka, jaká by platila bez předčasné splátky (zohlední případnou novou sazbu)…
          payment = annuity(balanceBeforePrepay, r, remaining);
          // …a předčasná splátka pak zkrátí zbývající dobu.
          remaining = nper(balance, r, payment);
        }
      } else {
        payment = annuity(balance, r, termMonths - m);
      }

      const startBalance = balance;
      let periodInterest = 0;
      let periodPrepaid = 0;
      let lastMonth = m;

      while (m < p.endMonth && balance > 0) {
        m++;
        const interest = balance * r;
        let pay = payment;
        let principalPart = pay - interest;
        if (principalPart >= balance - EPS || m >= termMonths) {
          principalPart = balance;
          pay = balance + interest;
        }
        balance -= principalPart;
        if (balance < EPS) balance = 0;
        if (mode === 'term') remaining -= 1;

        balanceBeforePrepay = balance;
        let prepaid = 0;
        if (mode !== 'none' && m === p.endMonth && balance > 0 && p.prepayment > 0) {
          prepaid = Math.min(p.prepayment, balance);
          balance -= prepaid;
          if (balance < EPS) balance = 0;
        }

        totalInterest += interest;
        totalPayments += pay;
        totalPrepaid += prepaid;
        periodInterest += interest;
        periodPrepaid += prepaid;
        lastMonth = m;

        rows.push({
          month: m,
          rate: p.rate,
          payment: pay,
          interest,
          principal: principalPart,
          prepayment: prepaid,
          balance,
        });
      }

      periodResults.push({
        index: p.index,
        startMonth: p.startMonth,
        endMonth: lastMonth,
        plannedEndMonth: p.endMonth,
        paidOff: balance <= 0,
        rate: p.rate,
        payment,
        startBalance,
        interest: periodInterest,
        prepayment: periodPrepaid,
        endBalance: balance,
      });
    }

    return {
      mode,
      rows,
      periods: periodResults,
      months: rows.length,
      firstPayment: periodResults.length ? periodResults[0].payment : 0,
      lastPayment: periodResults.length ? periodResults[periodResults.length - 1].payment : 0,
      totalInterest,
      totalPayments,
      totalPrepaid,
      totalPaid: totalPayments + totalPrepaid,
    };
  }

  /** Spočítá všechny tři scénáře najednou. */
  function calculate(input) {
    const periods = buildPeriods(input);
    const loan = { principal: input.principal, termMonths: input.termMonths };
    return {
      periods,
      none: simulate(loan, periods, 'none'),
      payment: simulate(loan, periods, 'payment'),
      term: simulate(loan, periods, 'term'),
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

  return { annuity, nper, buildPeriods, simulate, calculate, aggregateByYear };
});

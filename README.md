# Předčasná splátka hypotéky – kalkulačka

Statická webová kalkulačka (GitHub Pages), která ukazuje, jak se projeví mimořádná
splátka hypotéky na konci fixace (kdy je zdarma). Srovnává tři varianty:

- **Bez předčasné splátky:** srovnávací základ.
- **Snížení splátky:** po předčasné splátce se měsíční splátka přepočítá a doba splácení zůstane stejná.
- **Zkrácení doby:** měsíční splátka zůstane stejná a úvěr skončí dřív.

Výstupy:

- shrnutí a karty s hlavními čísly (splátka, doba splácení, zaplacené úroky, úspora),
- graf v čase (zůstatek úvěru, měsíční splátka, kumulativně zaplacené úroky),
- souhrnná srovnávací tabulka, přehled po fixačních obdobích a splátkový kalendář
  (po letech nebo po měsících) s exportem do CSV.

Pro každou fixaci jde nastavit vlastní sazbu i výši předčasné splátky. U běžící
hypotéky stačí zadat zbývající jistinu, zbývající dobu splácení a za jak dlouho končí
aktuální fixace. Všechna zadání se ukládají do adresy stránky, takže výpočet jde sdílet odkazem.

## Zveřejnění na GitHub Pages

1. V repozitáři otevřete **Settings → Pages**.
2. V části *Build and deployment* zvolte **Source: Deploy from a branch**.
3. Vyberte větev s kódem (např. `main`) a složku **`/ (root)`** a uložte.
4. Za minutu dvě bude kalkulačka na adrese
   `https://<uživatel-nebo-organizace>.github.io/hypoteka-kalkulacka/`.

Nic se nesestavuje (žádný build). Stránka je čisté HTML, CSS a JavaScript
a knihovna [Chart.js](https://www.chartjs.org/) je přiložená ve složce `vendor/`.

## Lokální spuštění

```sh
python3 -m http.server 8000   # nebo: npm start
# pak otevřete http://localhost:8000
```

Soubor `index.html` jde otevřít i přímo v prohlížeči.

## Testy výpočtu

```sh
npm test
```

## Struktura

| Soubor | Obsah |
| --- | --- |
| `index.html` | stránka |
| `styles.css` | vzhled (světlý i tmavý režim) |
| `js/calc.js` | výpočetní jádro (bez závislosti na prohlížeči, testované v Node.js) |
| `js/app.js` | formulář, graf a tabulky |
| `tests/calc.test.js` | testy výpočtu |
| `vendor/chart.umd.min.js` | Chart.js 4.5.1 (licence MIT) |

## Předpoklady výpočtu

- Anuitní splácení s měsíční splátkou. Úrok za měsíc se počítá jako zůstatek × roční sazba / 12.
- Předčasná splátka proběhne v posledním měsíci fixace, hned po řádné splátce.
- Na začátku každé fixace se splátka přepočítá podle sazby pro dané období.
- Varianta *zkrácení doby*: při změně sazby se splátka přepočítá tak, jak by se přepočítala
  bez předčasné splátky. Předčasná splátka pak zkrátí zbývající dobu splácení.
- Splátky se nezaokrouhlují na celé koruny. Poplatky, pojištění ani daňový odpočet úroků
  výpočet nezahrnuje. Výsledky jsou orientační.

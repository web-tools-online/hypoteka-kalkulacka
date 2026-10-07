# Mimořádné splátky hypotéky – kalkulačka

Statická webová kalkulačka (GitHub Pages), která ukazuje, co přinesou mimořádné splátky
hypotéky. Během fixace lze jednou ročně k výročí splatit zdarma až čtvrtinu úvěru
(limit jde nastavit) a na konci fixace libovolnou částku. **U každé mimořádné splátky
se volí, jestli sníží měsíční splátku, nebo zkrátí dobu splácení.**

Výstupy:

- shrnutí a karty s hlavními čísly (ušetřené úroky, doba splácení, měsíční splátka),
- **plán mimořádných splátek**: tabulka po výročích, kde jde u každé splátky změnit částku
  i volbu „nižší splátka / kratší doba“. Hned ukazuje limit zdarma, kolik se skutečně splatí,
  novou měsíční splátku a nový konec splácení,
- graf v čase (zůstatek úvěru, měsíční splátka, kumulativně zaplacené úroky) s volitelným
  srovnáním, kdyby všechny splátky šly jen na nižší splátku, nebo jen na kratší dobu,
- souhrnná srovnávací tabulka (bez mimořádných splátek / váš plán / vše na nižší splátku /
  vše na kratší dobu),
- splátkový kalendář po letech nebo po měsících s exportem do CSV.

Dál jde nastavit sazbu pro každou fixaci, odhad sazby pro další fixace a limit zdarma
(procento z původní výše úvěru, nebo z aktuálního zůstatku). U běžící hypotéky stačí zadat
zbývající jistinu, zbývající dobu splácení, za jak dlouho končí aktuální fixace a původní
výši úvěru. Všechna zadání se ukládají do adresy stránky, takže výpočet jde sdílet odkazem.

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
| `js/app.js` | formulář, plán splátek, graf a tabulky |
| `tests/calc.test.js` | testy výpočtu |
| `vendor/chart.umd.min.js` | Chart.js 4.5.1 (licence MIT) |

## Předpoklady výpočtu

- Anuitní splácení s měsíční splátkou. Úrok za měsíc se počítá jako zůstatek × roční sazba / 12.
- Mimořádná splátka proběhne jednou ročně k výročí, hned po řádné splátce v daném měsíci.
  Výročí jdou po 12 měsících a jedno z nich připadá na konec fixace.
- Limit zdarma je nastavené procento (výchozí 25 %) z původní výše úvěru, nebo z aktuálního
  zůstatku. Na konci fixace limit neplatí. Částky nad limit kalkulačka sníží na limit.
- *Nižší splátka*: splátka se přepočítá tak, aby úvěr skončil v dosavadním termínu.
  *Kratší doba*: splátka zůstane a úvěr skončí dřív.
- Na začátku každé fixace se splátka přepočítá podle nové sazby tak, aby úvěr skončil
  v termínu platném v tu chvíli.
- Splátky se nezaokrouhlují na celé koruny. Poplatky, pojištění ani daňový odpočet úroků
  výpočet nezahrnuje. Výsledky jsou orientační.

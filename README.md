# Fiszki

Aplikacja webowa do nauki słówek (EN ↔ PL) z algorytmem powtórek (spaced repetition).

## Funkcje

- Ekran nauki: słowo, przycisk „Odsłuchaj” (Text-to-Speech przeglądarki), przycisk „Sprawdź”
- Po sprawdzeniu: tłumaczenie + ocena własnej wiedzy („Nie znam” / „Średnio znam” / „Znam”)
- Algorytm SRS: karty słabo znane wracają szybko w tej samej sesji, dobrze znane trafiają
  do archiwum z rosnącym interwałem powtórek (14 → 30 → 60 → 90 dni)
- Zestawy tematyczne + możliwość dodawania własnych słówek
- Statystyki, passa dni (streak), nauka dwukierunkowa EN→PL / PL→EN
- Postęp zapisywany lokalnie w przeglądarce (`localStorage`) — bez konta i bez backendu

## Uruchomienie lokalnie

Wymaga zainstalowanego [Node.js](https://nodejs.org) (wersja 18+).

```bash
npm install
npm run dev
```

Otwórz adres, który pojawi się w terminalu (domyślnie `http://localhost:5173`).

## Publikacja na GitHub Pages

Repozytorium zawiera gotowy workflow (`.github/workflows/deploy.yml`), który buduje
i publikuje stronę automatycznie po każdym `push` na branch `main`.

Jednorazowo trzeba włączyć GitHub Pages w ustawieniach repozytorium:

1. Wejdź w zakładkę **Settings** repozytorium na GitHub.
2. W menu po lewej wybierz **Pages**.
3. W sekcji **Build and deployment → Source** wybierz **GitHub Actions**.
4. Zapisz. Po najbliższym pushu strona pojawi się pod adresem:
   `https://<twoja-nazwa-użytkownika>.github.io/Fiszki/`

## Struktura projektu

```
├── index.html
├── src/
│   ├── main.jsx      # punkt wejścia
│   └── App.jsx        # cała logika i UI aplikacji
├── .github/workflows/deploy.yml
└── vite.config.js
```

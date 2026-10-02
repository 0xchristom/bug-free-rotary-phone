# Bunndly

Solana Multi-Wallet Buyer: statyczna aplikacja SPA (bez backendu) do zarządzania flotą portfeli Solany i zakupu tokenów przez Jupiter. Pełna specyfikacja: [`docs/SPEC.md`](docs/SPEC.md).

> Status: szkielet projektu (sprint 1). Funkcje produktu dochodzą w kolejnych zadaniach.

## Wymagania

- Node.js `>=22.13` (zalecany aktualny LTS, patrz `.nvmrc`: `nvm use`)
- npm 10+

## Uruchomienie lokalne

```bash
npm i && npm run dev
```

Wersja produkcyjna (statyczny build) lokalnie:

```bash
npm run build && npm run preview
```

## Skrypty

| Skrypt                 | Co robi                                    |
| ---------------------- | ------------------------------------------ |
| `npm run dev`          | serwer deweloperski Vite                   |
| `npm run build`        | typecheck + statyczny build do `dist/`     |
| `npm run preview`      | podgląd zbudowanej wersji                  |
| `npm run lint`         | ESLint (type-aware, reguły bezpieczeństwa) |
| `npm run typecheck`    | `tsc -b` bez emisji                        |
| `npm test`             | Vitest (środowisko Node)                   |
| `npm run format`       | Prettier, zapis zmian                      |
| `npm run format:check` | Prettier, tylko sprawdzenie                |

## Struktura

```
src/
  core/        czyste TS, bez DOM: derywacja, keystore, typy, maszyna stanów, limiter
  chain/       klient RPC (Helius + fallback), salda, statusy sygnatur
  jupiter/     klient Swap API V2
  watcher/     WebSocket, detektory launchpadów (detectors/), deduplikacja
  executor/    kolejka, token bucket, potok, retry, idempotencja
  worker/      Web Worker spinający watcher i executor
  storage/     File System Access API + fallback
  ui/          komponenty React
tests/         testy jednostkowe i integracyjne (Vitest, Node)
docs/          SPEC.md, DECISIONS.md
```

## Bezpieczeństwo

Klucze prywatne i mnemonik nigdy nie trafiają do `localStorage`, `sessionStorage`, IndexedDB, logów ani konsoli (SPEC 6). Lint blokuje te API w `src/`. Pliki `*.keystore.json` są w `.gitignore`.

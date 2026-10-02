# Decyzje techniczne

Rejestr decyzji i rozbieżności z dokumentacją zewnętrzną. Nowe wpisy dopisujemy na końcu.

## Szablon

```
## D-NNN: <tytuł>
- Data: RRRR-MM-DD
- Zadanie: BUNNDLY-<n>
- Kontekst: …
- Decyzja: …
- Konsekwencje / alternatywy: …
```

---

## D-001: React zamiast Svelte

- Data: 2026-10-02
- Zadanie: BUNNDLY-1
- Kontekst: SPEC 2.1 dopuszcza React lub Svelte (z uzasadnieniem).
- Decyzja: React 19 + Vite 8.
- Konsekwencje / alternatywy: domyślny wybór SPEC, największy ekosystem i dojrzałe reguły lintu (react-hooks, react-refresh). Svelte nie daje tu przewagi, która uzasadniałaby odejście od SPEC.

## D-002: TypeScript 6.0.x zamiast 7.x

- Data: 2026-10-02
- Zadanie: BUNNDLY-1
- Kontekst: najnowszy TypeScript to 7.0.2, ale `typescript-eslint` 8.71.0 ma peer `typescript >=4.8.4 <6.1.0`. Lint type-aware jest wymagany.
- Decyzja: `typescript` 6.0.3 (najnowsza 6.0.x).
- Konsekwencje / alternatywy: aktualizacja do 7.x dopiero, gdy `typescript-eslint` ją obsłuży.

## D-003: Vitest jako runner testów

- Data: 2026-10-02
- Zadanie: BUNNDLY-1
- Kontekst: moduły `core`, `executor`, `jupiter` mają być testowalne w Node (SPEC 4).
- Decyzja: Vitest 5, środowisko `node`, konfiguracja w `vite.config.ts` (ten sam pipeline transformacji co aplikacja). Testy w `tests/**/*.test.ts`.
- Konsekwencje / alternatywy: brak osobnej konfiguracji Babel/ts-jest. Jeśli kiedyś potrzebne będą testy komponentów z DOM, środowisko ustawimy per plik.

## D-004: ESLint flat config z regułami bezpieczeństwa

- Data: 2026-10-02
- Zadanie: BUNNDLY-1
- Kontekst: SPEC 5 (zero `any`) i SPEC 6.1 (brak sekretów w storage i konsoli).
- Decyzja: ESLint 10, `eslint.config.js` przez `defineConfig` z `eslint/config` (`tseslint.config` jest przestarzałe), `typescript-eslint` `strictTypeChecked` z `projectService`. W `src/` jako błąd: `no-explicit-any`, `no-console`, `no-eval`, `no-implied-eval` (bazowa i wersja `@typescript-eslint`), `no-new-func`, `no-restricted-globals` / `no-restricted-properties` dla `localStorage`, `sessionStorage`, `indexedDB` (także przez `window.`, `globalThis.`, `self.`). W `src/{core,executor,jupiter}` dodatkowo zakaz `window` i `document`.
- Konsekwencje / alternatywy: Prettier działa osobno (`format:check`). `eslint-config-prettier` pominięty, bo ani `strictTypeChecked`, ani ESLint 10 `recommended` nie zawierają reguł formatowania (brak konfliktów, mniej zależności).

## D-005: Wersje Node i tsconfig

- Data: 2026-10-02
- Zadanie: BUNNDLY-1
- Kontekst: zadanie wymaga `engines.node >=22.12`, `.nvmrc` 24.
- Decyzja: jak w zadaniu. Uwaga: ESLint 10 wymaga Node `^22.13` na linii 22, więc lint na Node 22.12.0 nie zadziała (aplikacja i testy tak). `@types/node` 24.x, zgodnie z `.nvmrc`. Trzy projekty TS (`tsconfig.app.json` z DOM dla `src/`, `tsconfig.test.json` bez DOM dla `tests/`, `tsconfig.node.json` dla `vite.config.ts`), wspólne opcje w `tsconfig.base.json`; poza wymaganymi `strict` i `noUncheckedIndexedAccess` włączone też `exactOptionalPropertyTypes`, `noUnusedLocals/Parameters`, `noImplicitOverride`.

## D-006: `engines.node >=22.13`

- Data: 2026-10-02
- Zadanie: BUNNDLY-2
- Kontekst: uwaga z review BUNNDLY-1 (D-005): ESLint 10 wymaga Node `^22.13` na linii 22.
- Decyzja: `engines.node` podniesione z `>=22.12` do `>=22.13`.
- Konsekwencje / alternatywy: na Node 22 działają teraz wszystkie skrypty, łącznie z lintem.

## D-007: CI w GitHub Actions

- Data: 2026-10-02
- Zadanie: BUNNDLY-2
- Kontekst: SPEC 6.5 (`npm audit` w CI), SPEC 8.4 (brak sekretów).
- Decyzja: jeden job w `.github/workflows/ci.yml` na `pull_request` i `push` do `main`. Akcje przypięte do pełnego SHA odczytanego z tagów w repozytoriach (`git ls-remote`): `actions/checkout` v7.0.1 = `3d3c42e5aac5ba805825da76410c181273ba90b1`, `actions/setup-node` v7.0.0 = `820762786026740c76f36085b0efc47a31fe5020`. `permissions: contents: read`, `concurrency` z `cancel-in-progress` per gałąź, `timeout-minutes: 15`. Checkout z `persist-credentials: false`, żeby token nie zostawał w `.git/config` podczas `npm ci` i skryptów.
- Konsekwencje / alternatywy: aktualizacje akcji ręcznie (Dependabot poza zakresem).

## D-008: Błędy nie zawierają danych wejściowych (zasada projektu)

- Data: 2026-10-02
- Zadanie: BUNNDLY-3
- Kontekst: SPEC 5 (typowane błędy, komunikaty po polsku) i SPEC 6.1 (sekrety nigdy w komunikatach błędów ani logach).
- Decyzja: **komunikat i pola błędu nie zawierają danych wejściowych, które mogą być sekretem** (mnemonik, hasło, klucze prywatne, plaintext). Obowiązuje cały projekt.
  - `AppError` (`src/core/errors.ts`) przyjmuje tylko `code` i opcjonalne `cause`. Treść komunikatu zawsze pochodzi z mapy `ERROR_MESSAGES`, nigdy od wywołującego.
  - `toUserMessage` dla `AppError` zwraca komunikat z mapy po `code`, a dla każdego innego błędu ogólny komunikat. Nigdy nie zwraca `e.message` ani treści `cause`.
  - `cause` służy tylko do debugowania i nie jest pokazywane użytkownikowi. Nie przekazujemy jako `cause` niczego, co może zawierać sekret.
  - Nowe moduły dopisują kody do `ERROR_MESSAGES`. Unia `ErrorCode` wynika z kluczy tej mapy, więc kod bez komunikatu albo literówka w kodzie to błąd kompilacji.
- Konsekwencje / alternatywy: brak kontekstu typu „błędne słowo nr 5” w komunikacie. Taki kontekst, jeśli będzie potrzebny, może trafić tylko jako dane niesekretne (np. numer pozycji) w osobnym, typowanym polu, po decyzji w review.

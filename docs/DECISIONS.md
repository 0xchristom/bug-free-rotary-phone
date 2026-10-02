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

## D-009: Biblioteki do mnemonika i derywacji

- Data: 2026-10-02
- Zadanie: BUNNDLY-4
- Kontekst: SPEC 2.3 (audytowane biblioteki, adresy zgodne z Phantomem), SPEC 6.5 (minimalna liczba paczek).
- Decyzja: trzy bezpośrednie zależności w dokładnych wersjach, wszystkie od jednego autora (Paul Miller):
  - `@scure/bip39` 2.4.0 (audytowana), z angielską listą słów. Generowanie mnemonika: 256 bitów, czyli 24 słowa. Seed powstaje przez `mnemonicToSeedSync` z pustą passphrase, jak w Phantomie.
  - `micro-key-producer` 0.10.2, import tylko `micro-key-producer/slip10.js` (SLIP-0010 ed25519, wskazana w SPEC 2.3). **Paczka nie ma własnego audytu.** Opiera się na audytowanych `@noble/curves`, `@noble/hashes` i `@scure/base`. `slip10.js` importuje wyłącznie `@noble/curves` (ed25519), `@noble/hashes` (hmac, sha2, ripemd160) i lokalne `utils.js`. Kod SLIP-0010 jest krótki (deriveChild to jeden HMAC-SHA512) i przeczytałem go w całości. Poprawność potwierdzają oficjalne wektory SLIP-0010 (TV1 i TV2, 12 ścieżek) i wektory adresów Solany.
  - `@scure/base` 2.4.0 (audytowana) do base58.
- Zależności przechodnie: `@noble/hashes`, `@noble/curves` i `@noble/ciphers` są audytowane. `micro-packed` nie jest audytowany, ale `slip10.js` go nie importuje. `npm audit`: 0 podatności.
- Konsekwencje / alternatywy:
  - Własna implementacja SLIP-0010 na `@noble/hashes` + `@noble/curves` dałaby o jedną nieaudytowaną paczkę mniej. Byłaby to jednak nasza własna, też nieaudytowana kryptografia. Wybrałem bibliotekę ze SPEC, bo jej kod i nasze testy wektorowe dają tę samą pewność przy mniejszym ryzyku błędu.
  - Derywacja idzie krok po kroku (`deriveChild`), żeby wyzerować pośrednie klucze. Zerowanie (`wipe`) jest best effort: JS i biblioteki mogą trzymać kopie (np. bufor HMAC w `deriveChild`).
  - Błędny mnemonik daje `INVALID_MNEMONIC` bez `cause`, bo komunikaty bibliotek mogą zawierać słowa z wejścia (D-008).

## D-010: Szyfrowanie keystore: scrypt + AES-256-GCM

- Data: 2026-10-02
- Zadanie: BUNNDLY-5
- Kontekst: SPEC 3.1 (format pól `kdf`, `cipher`, `ciphertext`), SPEC 6.3 (scrypt + AES-GCM, losowy IV, uwierzytelnienie tagiem), SPEC 6.5 (audytowane paczki).
- Decyzja:
  - **KDF:** `scryptAsync` z `@noble/hashes` 2.4.0 (audytowana). Dodałem ją jako bezpośrednią zależność w tej samej wersji, która była już przechodnio, więc lockfile nie przybył o nową paczkę. Domyślnie `N=2^17, r=8, p=1, dkLen=32`, sól 16 B z `crypto.getRandomValues`. `maxmem` liczę ze wzoru noble `128·r·(N+p+1)`, ograniczonego walidacją (ok. 1 GiB przy N=2^20).
  - **Szyfr:** WebCrypto AES-256-GCM, losowy IV 12 B przy każdym szyfrowaniu, tag 128 bitów. Klucz importuję jako non-extractable. `ciphertext` to base64 z szyfrogramu i dołączonego na końcu tagu, tak jak zwraca WebCrypto. Base64 robię przez `@scure/base`.
  - **Walidacja przed scrypt:** dozwolone są tylko `scrypt` i `AES-GCM`, `N` jako potęga 2 w zakresie 2^17–2^20, `r = 8`, `p` od 1 do 4, sól 16 B i IV 12 B. Wszystko inne daje `KEYSTORE_UNSUPPORTED_KDF`, zanim ruszy scrypt. To samo sprawdzenie obowiązuje przy szyfrowaniu.
  - **Błędy:** złe hasło, dowolna zmiana danych oraz za krótki albo nie-base64 ciphertext dają `KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED`, bez `cause` (D-008).
  - **Hasło:** normalizuję NFKC i koduję UTF-8. Minimum 12 znaków liczę jako znaki widziane przez użytkownika (grafemy, `Intl.Segmenter`) po NFKC, więc „ą” w NFD to jeden znak. Przy odszyfrowaniu długości nie sprawdzam.
  - **Zerowanie (best effort):** zeruję bajty hasła, klucz z scrypt, jego kopię dla `importKey` i kopię plaintextu. Wynik `decryptSecrets` zeruje wywołujący. Kopii w WebCrypto ani w stringu hasła JS nie da się wyzerować.
- Konsekwencje / alternatywy:
  - Parametry KDF nie są związane z szyfrogramem jako AAD. Zmiana `N`, `p` albo soli i tak zmienia klucz, więc GCM odrzuca dane (testy na zmianę soli).
  - Argon2id byłby mocniejszy, ale SPEC wskazuje scrypt.

## D-011: Format pliku keystore v1 i kontrola spójności

- Data: 2026-10-02
- Zadanie: BUNNDLY-6
- Kontekst: SPEC 3.1 (format pliku, część `public` jawna), SPEC 6.1 i 6.3.
- Decyzja:
  - **Plik:** `KeystoreFileV1` ma dokładnie pola z SPEC 3.1, w tej kolejności. `parseKeystoreFile` waliduje ściśle:
    - plik powyżej 1 MB (liczone w bajtach UTF-8) odrzucam przed `JSON.parse`;
    - zestaw kluczy na każdym poziomie musi być dokładny, nieznany klucz daje `KEYSTORE_INVALID_FORMAT`;
    - `version` inna niż 1 daje `KEYSTORE_UNSUPPORTED_VERSION`, brak `version` daje `KEYSTORE_INVALID_FORMAT`;
    - sprawdzam base64 (sól, IV, ciphertext) i base58 (adres musi mieć 32 B);
    - indeksy muszą być unikalne i mieścić się w 0..99, a `derivationPath` musi odpowiadać indeksowi;
    - etykieta ma 1–32 znaki bez znaków kontrolnych, a `createdAt` musi być w kanonicznym ISO-8601 (`toISOString`).
  - **Zakres parametrów kryptograficznych** (N, r, p, nazwy algorytmów) sprawdza dopiero `decryptSecrets` (D-010) i daje wtedy `KEYSTORE_UNSUPPORTED_KDF`.
  - **Nazwa floty:** 1–64 znaki, dozwolone litery (Unicode), cyfry, spacja, `.`, `-` i `_`. Nazwa nie może zaczynać się kropką ani spacją ani kończyć kropką lub spacją, bo z niej powstaje `<nazwa>.keystore.json`. Zła nazwa w pliku daje `KEYSTORE_INVALID_FORMAT`, a przy tworzeniu nowy kod `INVALID_FLEET_NAME`.
  - **Sekrety (`KeystoreSecretsV1`):**
    - `mnemonic`;
    - `wallets: { index, secretKey (base58, 64 B) }[]`;
    - `settings: { maxSpend: { index, lamports }[] }`: lamporty w pamięci jako `bigint`, w JSON jako string dziesiętny bez zer wiodących, zakres 0..2^64−1, a indeks musi należeć do floty;
    - `apiKeys: { helius?, jupiter? }`.
  - **Kontrola spójności po odszyfrowaniu (`openKeystore`):**
    - każdy klucz prywatny musi być identyczny bajt po bajcie z kluczem wyprowadzonym z mnemonika dla jego indeksu;
    - lista `public.wallets` musi mieć te same indeksy i adresy;
    - każda niezgodność daje `KEYSTORE_TAMPERED`;
    - `buildKeystore` robi to samo przed zaszyfrowaniem, więc nie da się zbudować pliku z niespójnych sekretów;
    - część `public` zawsze wyliczam z sekretów, nigdy nie przyjmuję jej od wywołującego.
  - **Zerowanie:** `secretKey` z `deriveWallets` zeruję zaraz po zakodowaniu do base58 i po porównaniu (uwaga Andy'ego z review BUNNDLY-4), podobnie bufory plaintextu. Sekrety jako stringi JS (mnemonik, klucze base58) w `KeystoreSecretsV1` nie dadzą się wyzerować. Dlatego ma je trzymać tylko Web Worker (sprint 2).
- Konsekwencje / alternatywy: podpis części `public` (np. HMAC kluczem z hasła) wymagałby hasła do podglądu, więc nie dawałby nic więcej niż kontrola spójności po odblokowaniu. Podgląd bez hasła pokazuje adresy niezweryfikowane. UI musi to zaznaczyć, a adres depozytu pokazywać dopiero po odblokowaniu (do zrobienia w sprincie 2).

## D-012: CI tylko ręcznie do odwołania (brak minut GitHub Actions)

- Data: 2026-10-02
- Zadanie: BUNNDLY-18
- Kontekst: skończył się pakiet minut GitHub Actions. Krystian zdecydował 2026-10-02, że automatyczne uruchamianie CI jest wstrzymane do odwołania.
- Decyzja: w `.github/workflows/ci.yml` wyzwalacze `pull_request` i `push` (D-007) zastąpiłem samym `workflow_dispatch`. Workflow można uruchomić ręcznie. Kroki, akcje przypięte do SHA, `permissions`, `concurrency` i `timeout-minutes` zostały bez zmian. Workflow nie jest usunięty.
- Konsekwencje:
  - bramką jakości są lokalne kontrole przed PR: `npm ci && npm run lint && npm run typecheck && npm test && npm run build && npm run format:check && npm audit --audit-level=high`, z wynikiem w opisie PR, oraz review Andy'ego, który uruchamia je ponownie;
  - `npm audit` z SPEC 6.5 działa tymczasowo tylko lokalnie;
  - nie pushujemy commitów tylko po to, żeby wywołać CI.
- Przywrócenie: w `ci.yml` zamienić `workflow_dispatch:` na wyzwalacze z D-007 (instrukcja jest w komentarzu w pliku) i usunąć uwagę z README.

## D-013: Sejf w Web Workerze, API wyłącznie domenowe

- Data: 2026-10-02
- Zadanie: BUNNDLY-7
- Kontekst: SPEC 6.1 (jawne klucze tylko w pamięci Web Workera) i 6.2 (podpisywanie wyłącznie lokalne).
- Decyzja:
  - **Zasada bezpieczeństwa:** worker nie udostępnia generycznego podpisywania bajtów ani eksportu kluczy bez hasła. Jego API (`src/worker/protocol.ts`) to wyłącznie operacje domenowe: `create`, `unlock`, `lock`, `status`, `saveSettings`, `addWallets`, `setArmed` i `activity`. Podpisywanie transakcji dojdzie w sprincie 3 jako operacja domenowa (np. zakup z limitem max spend), a nie „podpisz te bajty”. Eksport jawny (BUNNDLY-11) wymaga ponownego hasła. Dzięki temu XSS w wątku UI nie zmusi workera do podpisania dowolnej transakcji ani do wydania klucza.
  - **Co wraca do UI:** tekst zaszyfrowanego pliku (do zapisu) i `VaultInfo`, czyli nazwa floty, `createdAt`, publiczne portfele (indeks, adres, ścieżka, etykieta), ustawienia i klucze API. Klucze API traktuję jako ustawienia, bo UI ustawień i Test połączeń ich potrzebują. Nie są sekretem portfeli. Nigdy nie wraca mnemonik ani klucz prywatny (test przeszukuje wszystkie odpowiedzi).
  - **Hasło nie jest przechowywane.** Po `create` i `unlock` worker trzyma `KeystoreSession`: non-extractable `CryptoKey` AES-GCM (encrypt i decrypt) oraz parametry KDF. `saveSettings` i `addWallets` szyfrują ponownie tym kluczem: ta sama sól i parametry, nowy IV. W `core/keystore` doszły `createSession`, `unlockSession`, `encryptWithSession`, `decryptWithSession` i `buildKeystoreWithSession`.
  - **Sekrety w workerze trzymam jako bajty** (mnemonik w UTF-8, klucze 64 B). `lock` i auto-lock je zerują i porzucają `CryptoKey`. Stringi z odszyfrowanego JSON-a i te tworzone na chwilę przy ponownym szyfrowaniu nie dadzą się wyzerować (best effort).
  - **Auto-lock:** domyślnie 15 min bezczynności, sprawdzany co 15 s przez timer workera, a dodatkowo na początku każdego żądania. Dzięki temu uśpiony timer nie przedłuży sesji. `status` nie liczy się jako aktywność, więc odpytywanie nie blokuje auto-locka. UI zgłasza aktywność przez `activity`. Flaga `armed` wstrzymuje auto-lock.
  - **Błędy przez `postMessage`:** przechodzi tylko `code`, a klient odtwarza `AppError`. Nieznany błąd i nieznany kod dają `INTERNAL_ERROR`. Błędne żądania (zły typ, zły kształt) też dają `INTERNAL_ERROR`. Brak odpowiedzi daje `VAULT_TIMEOUT`: 120 s dla `create` i `unlock` (scrypt), 30 s dla reszty.
  - **Kolejka:** żądania wykonują się po kolei, więc dwa równoległe `addWallets` nie nadpiszą się nawzajem.
  - **Lint:** `src/worker` jest objęty zakazem `window` i `document`, tak jak `core`.
- Konsekwencje / alternatywy: `postMessage` przenosi `bigint` (structured clone), więc lamporty idą jako `bigint`. Worker nie ma typów `lib.webworker`, bo jest kompilowany w projekcie `app`. Nie używa jednak DOM, co pilnuje lint.

## D-014: Zapis i odczyt pliku keystore (File System Access API + fallback)

- Data: 2026-10-02
- Zadanie: BUNNDLY-8
- Kontekst: SPEC 3.1 (zapis do wskazanego folderu, fallback pobierania w Firefoksie i Safari).
- Decyzja:
  - **Zapis:** `src/storage/keystore-file.ts` używa `showDirectoryPicker({ id, mode: 'readwrite' })`. Istnienie pliku sprawdzam przez `getFileHandle(name)` (`NotFoundError` oznacza nowy plik). Istniejący plik nadpisuję tylko po `confirmOverwrite`. Zapisuję przez `createWritable()`, które pisze do pliku tymczasowego i podmienia cel dopiero przy `close()`. Przy błędzie zapisu wołam `abort()`, więc stary plik zostaje nienaruszony. Bez API plik jest pobierany przez `Blob` i `<a download>`, a `revokeObjectURL` idzie zaraz po kliknięciu, w `finally`.
  - **Odczyt:** `showOpenFilePicker` z filtrem `.json` albo `<input type="file" accept=".json,application/json">`. Zdarzenie `cancel` oznacza anulowanie. Limit 1 MB sprawdzam na `file.size` przed `text()`, co daje nowy kod `STORAGE_FILE_TOO_LARGE`.
  - **Kody błędów:** `AbortError` daje `STORAGE_CANCELLED`, odmowa nadpisania też. `NotAllowedError` i `SecurityError` dają `STORAGE_PERMISSION_DENIED`. Inne błędy dają `STORAGE_WRITE_FAILED` albo `STORAGE_READ_FAILED`. Komunikat przeglądarki nie przechodzi dalej (D-008).
  - **Wstrzykiwane środowisko (`StorageEnv`):** logika jest testowalna w Node na mockach. Prawdziwe środowisko z DOM jest w `src/storage/browser.ts`, którego testy nie importują. Typy File System Access API są zdefiniowane strukturalnie, bo nie ma ich w `lib.dom` TypeScriptu.
  - **Import z `core`:** storage potrzebuje `AppError`, żeby rzucać kody błędów. Walidację nazwy floty i limit 1 MB przeniosłem do bezzależnościowego `core/keystore/limits.ts` (`format.ts` je re-eksportuje). Dzięki temu storage nie ciągnie kryptografii.
  - **Nazwa floty:** reguły z D-011 rozszerzyłem o zarezerwowane nazwy urządzeń Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM0–9`, `LPT0–9`, także z rozszerzeniem). Takich plików nie da się utworzyć na Windows.
- Konsekwencje: w trybie pobierania przeglądarka sama decyduje o folderze i nazwie przy konflikcie (np. `Flota (1).keystore.json`), więc nie pytamy o nadpisanie.

## D-015: Szkielet UI i infrastruktura testów komponentów

- Data: 2026-10-02
- Zadanie: BUNNDLY-17
- Kontekst: SPEC 3.1, 5 i 6.1 (nic w storage ani w URL).
- Decyzja:
  - **Nawigacja:** ekrany (Start, Kreator, Flota, Ustawienia) są stanem React w `App`, bez biblioteki routingu, bez historii i bez fragmentów URL. Ekrany Flota i Ustawienia nie renderują się bez odblokowanej floty, a po zablokowaniu UI wraca na Start.
  - **Stan sejfu:** `App` dostaje `VaultClient` jako prop (w `main.tsx` jest to `spawnVaultWorker()`, w testach mock) i udostępnia go ekranom przez kontekst (`ui/vault-state.ts`).
    - Status jest odpytywany co 5 s. `status` nie liczy się jako aktywność, więc odpytywanie nie blokuje auto-locka.
    - Aktywność użytkownika (`pointerdown`, `keydown`) zgłaszam do workera najwyżej raz na 30 s i tylko przy odblokowanej flocie.
    - Po auto-locku UI pokazuje komunikat i wraca na Start w ciągu jednego cyklu odpytywania (≤ 5 s).
    - Awaria workera (`error` / `messageerror` na obiekcie `Worker`) natychmiast odrzuca wszystkie oczekujące żądania kodem `INTERNAL_ERROR`, zamiast czekać 30–120 s na timeout. `VaultPort` ma do tego opcjonalne `addFailureListener`, podpinane w `spawn.ts`. UI pokazuje polski komunikat.
  - **Paczki w UI:** UI importuje z `core` tylko `errors.ts`, a z workera tylko `protocol.ts`, `vault-client.ts` i `spawn.ts`. `DEFAULT_AUTO_LOCK_MS` przeniosłem do `protocol.ts`, żeby nie ciągnąć `vault.ts`. Kryptografia trafia wyłącznie do pakietu workera, a główny pakiet urósł o ok. 7 kB.
  - **Style:** zwykły CSS (`ui/app.css`) z ciemnym motywem, bez frameworka UI. Układ jest elastyczny i bez przewijania w poziomie od 320 px.
  - **Testy UI:** jsdom włączany per plik przez `// @vitest-environment jsdom`, a reszta testów zostaje w Node (test dymny pilnuje, że `window` nie istnieje). Testy UI mają osobny projekt TS `tsconfig.ui-test.json` (DOM + JSX), a `tsconfig.test.json` je wyklucza.
- Zależności (dev, dokładne wersje):
  - **`@testing-library/react` 16.3.3** daje renderowanie i zapytania po rolach. Wybrałem go, bo testuje UI tak, jak widzi je użytkownik.
  - **`@testing-library/dom` 10.4.2** jest wymaganym peerem `@testing-library/react` od wersji 16 i nie instaluje się sam. To jedyna paczka spoza listy w zadaniu.
  - **`@testing-library/user-event` 14.6.7** symuluje klik i klawiaturę realistyczniej niż `fireEvent`.
  - **`jsdom` 29.1.1, a nie najnowszy 30.x:** 30.x wymaga Node `^22.22.2 || ^24.15`, a nasze `engines` to `>=22.13`. 29.1.1 ma `engines` `^22.13 || >=24`, czyli dokładnie nasz zakres.

## D-017: Kreator floty i niezapisany plik

- Data: 2026-10-02
- Zadanie: BUNNDLY-9
- Kontekst: SPEC 3.1, 5 i 6.1. D-016 jest zarezerwowane dla decyzji o kluczach API (BUNNDLY-15).
- Decyzja:
  - **Sekrety w formularzu:** hasło, powtórzenie hasła i mnemonik są w stanie React tylko do wysłania żądania `create`. Zaraz potem formularz je czyści. Nic nie trafia do storage, URL ani konsoli.
  - **Długość hasła:** liczona w grafemach po NFKC (`passwordLength` w bezzależnościowym `core/keystore/limits.ts`), tak samo w UI i w `crypto.ts`. UI nie importuje kryptografii.
  - **Wskaźnik siły hasła:** prosta heurystyka (`ui/password-strength.ts`): długość, klasy znaków, kary za powtórzenia, sekwencje i popularne słowa. Bez zewnętrznej biblioteki (zxcvbn ma ok. 800 kB). Blokuje tylko hasło krótsze niż 12 znaków, resztę opisuje.
  - **Postęp scrypt:** worker wysyła `{ id, progress }` tylko przy zmianie pełnego procenta. Klient przekazuje to do `onProgress` i nie kończy na tym żądania.
  - **Zapis pliku:** dopiero po kliknięciu „Zapisz plik floty”, nigdy automatycznie. Dopóki plik nie jest zapisany:
    - wyjście z kreatora wymaga potwierdzenia, a zamknięcie karty uruchamia ostrzeżenie przeglądarki (`beforeunload`);
    - auto-lock nie zamyka kreatora: zaszyfrowany plik zostaje w pamięci UI i nadal można go zapisać (nie zawiera jawnych sekretów);
    - po utworzeniu floty aplikacja nie przechodzi sama na ekran Flota.
  - **Pobieranie:** `revokeObjectURL` po 60 s (`DOWNLOAD_URL_TTL_MS`), bo niektóre przeglądarki zaczynają pobieranie asynchronicznie. Od razu tylko wtedy, gdy kliknięcie rzuci wyjątek.
- Konsekwencje: zaszyfrowany plik może zostać w pamięci karty po auto-locku, dopóki użytkownik go nie zapisze albo nie opuści kreatora.

## D-018: Podgląd pliku bez hasła i adresy niezweryfikowane

- Data: 2026-10-02
- Zadanie: BUNNDLY-10
- Kontekst: SPEC 3.1 i 6.1. Jawna część pliku (`public.wallets`) nie jest podpisana i każdy może ją zmienić. Kontrola spójności adresów (BUNNDLY-6) działa dopiero po odszyfrowaniu.
- Decyzja:
  - **Adresy przed odblokowaniem są oznaczone jako „niezweryfikowane”.** Przyciski „Kopiuj” i „QR” są wtedy nieaktywne. Kopiowanie adresu depozytu i kod QR są dostępne tylko na ekranie Flota, który pokazuje adresy z workera po odblokowaniu i kontroli spójności. Bez tego podmieniony plik mógłby skłonić użytkownika do wpłaty na adres atakującego.
  - **`KEYSTORE_TAMPERED` ma osobne, wyraźne ostrzeżenie** („plik floty mógł zostać podmieniony”, „Nie wysyłaj środków na adresy z tego pliku”). Pozostałe błędy pokazuję zwykłym komunikatem z `toUserMessage`.
  - **Podgląd parsuje worker:** nowe żądanie `preview { fileText }` uruchamia `parseKeystoreFile` i zwraca tylko część publiczną (`VaultPreview`). Nie zmienia stanu sejfu i nie liczy się jako aktywność. Dzięki temu UI nie importuje `format.ts`, który ciągnie derywację i listę słów BIP39 (D-015).
  - **Hasło** jest czyszczone z pola po każdej próbie odblokowania, udanej i nieudanej.
  - **„Dodaj portfele”:** liczba od 1 do `100 − obecna liczba`. Worker dopisuje kolejne indeksy i szyfruje plik kluczem sesji, a UI zapisuje go dopiero po kliknięciu „Zapisz zaktualizowany plik floty” (jak w D-017). Dopóki plik nie jest zapisany:
    - „Zablokuj”, wyjście z ekranu i zamknięcie karty wymagają potwierdzenia;
    - auto-lock odrzuca niezapisany plik. To akceptowalne: nowe portfele wynikają deterministycznie z mnemonika, więc ponowne dodanie daje te same adresy.
  - **Kod QR:** paczka `qr` 0.7.2 (Paul Miller, autor `@noble` i `@scure`, zero zależności). Rysuję ją jako SVG z macierzy modułów (`'raw'`), bez wstrzykiwania HTML, więc działa przy ścisłym CSP. Wybrałem ją, bo pochodzi od tego samego autora co nasze paczki kryptograficzne i nie ma zależności. Test dekoduje narysowany kod z powrotem do adresu.
- Konsekwencje: główny pakiet urósł o ok. 24 kB (262 kB, gzip 84 kB), w tym biblioteka QR. Kryptografia dalej jest tylko w pakiecie workera.

## D-016: Klucze API tylko do zapisu, poza workerem ich nie ma

- Data: 2026-10-02
- Zadanie: BUNNDLY-15 (decyzja Andy'ego z review BUNNDLY-7)
- Kontekst: SPEC 2.1 i 6.1. Klucze Helius i Jupiter dają dostęp do płatnych usług. Do BUNNDLY-15 `VaultInfo` oddawał je do UI, więc trafiały do stanu React.
- Decyzja:
  - **Klucze nie wychodzą z workera.** Wywołania, które ich potrzebują (Helius HTTP i WSS, Jupiter), wykona worker (BUNNDLY-12, 13, 16).
  - **`VaultInfo.apiKeys` to tylko flagi** (`ApiKeyFlags`): czy ustawiono klucz Helius, klucz Jupiter, własny URL RPC i własny URL WebSocket.
  - **Własne URL-e Helius** zawierają klucz, więc podlegają tej samej zasadzie. Są przechowywane obok kluczy (`ApiKeysV1.heliusRpcUrl`, `heliusWsUrl`). Walidacja: RPC tylko `https:`, WebSocket tylko `wss:`, bez użytkownika i hasła w URL.
  - **`saveSettings.apiKeys` to zmiany:** brak pola zostawia wartość, `null` ją usuwa, a tekst zastępuje. Nieprawidłowa wartość daje `INVALID_SETTINGS`.
  - **UI:**
    - puste pole oznacza brak zmian;
    - usunięcie to osobny przycisk („Usuń” / „Cofnij usunięcie”);
    - „Pokaż” dotyczy tylko tekstu wpisywanego teraz;
    - po wysłaniu pola są od razu czyszczone.
  - **Klucze nigdy nie trafiają** do zmiennych builda, `localStorage`, URL aplikacji ani logów.
  - **Test w workerze** przeszukuje serializowane odpowiedzi wszystkich operacji pod kątem kluczy i URL-i, tak jak w BUNNDLY-7 dla mnemonika.
- Konsekwencje: test połączeń (BUNNDLY-16) i zapytania RPC (BUNNDLY-12, 13) muszą iść przez worker.

## D-019: Format ustawień w keystore i walidacja

- Data: 2026-10-02
- Zadanie: BUNNDLY-15 (decyzja z review BUNNDLY-6)
- Kontekst: SPEC 3.1, 3.2 i 3.3.
- Decyzja:
  - **`settings` w `KeystoreSecretsV1`** ma teraz trzy pola:
    - `maxSpend` bez zmian;
    - `active: { index, active }[]` (portfel bez wpisu jest aktywny, flaga dla BUNNDLY-14);
    - `global: GlobalSettingsV1`.
  - **`version` zostaje 1,** bo nie ma jeszcze prawdziwych plików. Brak `active` lub `global`, a także brak pojedynczego pola w `global`, oznacza wartości domyślne. Pole obecne, ale spoza zakresu, oraz nieznany klucz oznaczają `KEYSTORE_INVALID_FORMAT`, bo plik jest wtedy uszkodzony. **Od pierwszego prawdziwego użycia każda zmiana formatu to nowa wersja i migracja.**
  - **Pola i wartości domyślne (SPEC 3.3):**
    - `minReserveLamports`: 0,015 SOL, zakres 0,001–1 SOL, w pliku jako tekst dziesiętny jak `lamports`;
    - `maxAttempts`: 3, zakres 1–10;
    - `priceCeilingPercent`: 50, zakres 1–1000;
    - `noRouteWindowMs`: 20 s, zakres 1–120 s;
    - backoff: 500 → 2000 ms (początkowy 100–10 000 ms, maksymalny 100–30 000 ms i nie mniejszy niż początkowy);
    - `mode`: `one-shot` albo `continuous`; przełączenie na ciągły wymaga potwierdzenia ostrzeżenia;
    - `explorer`: `solscan`, `orb` albo `solana-explorer`;
    - `autoLockMinutes`: 15, zakres 1–120;
    - `jupiterPlan` i `orderRpm`.
  - **Plan Jupitera:** w pliku jest limit `/order` na minutę, a `ORDER_RPS = orderRpm / 60`. Tabela planów (Keyless 30, Free 60, Developer 600, Launch 3000, Pro 9000 na minutę) ma link do dokumentacji w kodzie. Dla nazwanego planu limit musi się zgadzać z tabelą, a plan „Własny” przyjmuje 1–100 000 na minutę.
  - **Jedna walidacja dla UI i workera:** `validateGlobalSettings` w bezzależnościowym `core/settings.ts` zwraca listę `{ field, message }` z polskimi komunikatami.
    - UI pokazuje je przy polach i blokuje przycisk „Zapisz ustawienia”.
    - Worker odrzuca całe żądanie kodem `INVALID_SETTINGS` (nie `KEYSTORE_INVALID_FORMAT`) i nie zmienia stanu.
  - **Auto-lock** w workerze korzysta z `autoLockMinutes` odblokowanej floty. Opcja `autoLockMs` handlera zostaje tylko do testów.
  - **Zapis pliku** po zmianie ustawień działa jak w D-017 i D-018: sejf ma nowe ustawienia od razu, a plik zapisuje się po kliknięciu, z ochroną przed utratą przy blokadzie i zamknięciu karty.
- Konsekwencje: `FleetSettingsV1` zawsze zawiera wszystkie pola (domyślne uzupełnia parser), więc kod dalej nie musi sprawdzać braków.

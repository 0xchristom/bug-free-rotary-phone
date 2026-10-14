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
  - **Własne URL-e Helius** zawierają klucz, więc podlegają tej samej zasadzie. Są przechowywane obok kluczy (`ApiKeysV1.heliusRpcUrl`, `heliusWsUrl`). Walidacja: RPC tylko `https:`, WebSocket tylko `wss:`, bez użytkownika i hasła w URL, host tylko `helius-rpc.com` albo jego subdomena (dopisane w BUNNDLY-12, patrz D-020).
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
- Zmiany po review BUNNDLY-15 (wprowadzone w BUNNDLY-14):
  - **Dolna granica `MIN_RESERVE_SOL` to 0,005 SOL**, a nie 0,001. Rezerwa musi pokryć rent konta tokenu (ok. 0,00204 SOL dla SPL, więcej dla Token-2022 z rozszerzeniami), priority fee i późniejszą sprzedaż. Formularz i worker odrzucają mniejszą wartość z komunikatem „Minimalna rezerwa musi wynosić od 0,005 do 1 SOL.”
  - **Tolerancyjny odczyt ustawień globalnych z pliku.** Wartość spoza aktualnego zakresu albo złego typu przyjmuje wartość domyślną zamiast `KEYSTORE_INVALID_FORMAT`.
    - Plik jest uwierzytelniony (AES-GCM), więc taka wartość może pochodzić tylko ze starszej wersji aplikacji, a zmiana zakresu nie może nikomu zablokować floty.
    - Pary sprawdzane razem są resetowane razem: oba odstępy ponowień oraz plan Jupitera z limitem `/order`.
    - Nieznane klucze dalej oznaczają uszkodzony plik.
    - Zresetowane pola trafiają do `settings.resetFields`, nigdy nie są zapisywane i znikają po następnym zapisie ustawień.
    - UI (ekrany Flota i Ustawienia) pokazuje informację, które ustawienia przyjęły wartości domyślne.

## D-020: Odczyty z sieci: `@solana/kit`, backoff i fallback w workerze

- Data: 2026-10-02
- Zadanie: BUNNDLY-12
- Kontekst: SPEC 2.2, 3.2 i 6.1 oraz D-016 (klucz Helius nie wychodzi z workera). Plan Helius Free daje 10 zapytań/s i 1 mln kredytów miesięcznie.
- Decyzja:
  - **`@solana/kit` 8.4.0 (dokładna wersja):** oficjalny, modularny następca `@solana/web3.js` od Anza, z typami, `bigint` dla lamportów i tree-shakingiem.
    - Używam tylko `createSolanaRpcFromTransport`, `createDefaultRpcTransport`, `address` i błędów transportu.
    - Paczka jest wyłącznie w pakiecie workera (+25 kB), w głównym pakiecie jej nie ma.
    - Zależności to wyłącznie paczki `@solana/*` tego samego wydania.
  - **Gdzie działa:** `src/chain` to czysty moduł (bez DOM, testy w Node). Wywołuje go tylko worker sejfu w nowym żądaniu `refreshBalances`, bo tylko worker zna klucz.
    - URL: własny URL RPC, jeśli jest ustawiony; inaczej adres z dokumentacji Helius z kluczem; bez klucza `HELIUS_KEY_MISSING` i żadnego zapytania.
    - Odpowiedź zawiera tylko `{ index, lamports }[]`, źródło (`helius` albo `fallback`) i czas odczytu.
  - **`refreshBalances` nie jest aktywnością** (tak jak `status`), więc cykliczne odświeżanie nie wyłącza auto-locka.
    - W kolejce workera idzie tylko szybkie przygotowanie (sprawdzenie odblokowania, URL, adresy). Sam odczyt sieciowy idzie poza kolejką, więc `lock` nie czeka na sieć.
    - Jeśli w trakcie odczytu flota zostanie zablokowana, wynik jest odrzucany (`VAULT_LOCKED`).
  - **Paczkowanie:** `getMultipleAccounts` po maksymalnie 100 adresów, paczki kolejno, wyniki w kolejności wejścia. Brak konta liczy się jako `0n`. `dataSlice` o długości 0, bo potrzebne są tylko lamporty.
  - **Backoff i fallback:**
    - 429, 5xx i błąd sieci dają do 3 powtórzeń z opóźnieniem 250 → 500 → 1000 ms;
    - inny błąd (np. 401 przy złym kluczu) od razu przechodzi do fallbacku;
    - fallback to `https://api.mainnet.solana.com`, tylko do odczytów i tylko po błędzie Helius;
    - UI pokazuje, że salda pochodzą z publicznego RPC.
  - **Błędy bez klucza:** każdy błąd końcowy to `RPC_UNAVAILABLE` bez `cause`, bo oryginalny błąd `fetch` lub transportu może zawierać URL z kluczem. Do logów jest `redactUrl`, który obcina część query.
  - **Odświeżanie w UI** (`useBalances`):
    - co 12 s (konfigurowalne, SPEC: 10–15 s) i przyciskiem „Odśwież salda”;
    - tylko gdy ekran Flota jest zamontowany (czyli flota odblokowana) i karta jest widoczna;
    - powrót karty do widoku odświeża od razu;
    - najwyżej jedno zapytanie naraz.
  - **Testy bez sieci:** plik startowy testów (`tests/helpers/no-network.ts`) podmienia `fetch` i `WebSocket` na funkcje rzucające błąd. Testy używają tylko mocków transportu.
  - **Własne URL-e tylko w domenie Helius** (wymaganie Andy'ego z review BUNNDLY-15):
    - host musi być dokładnie `helius-rpc.com` albo jego subdomeną (`mainnet.helius-rpc.com`, `*.helius-rpc.com`);
    - podobne nazwy, np. `helius-rpc.com.evil.example` i `evilhelius-rpc.com`, są odrzucane;
    - powód: CSP (SPEC 6.4) przepuści w `connect-src` tylko Helius, `api.jup.ag` i awaryjny RPC, więc inny host w buildzie z CSP po cichu by nie działał;
    - jedna reguła (`endpointUrlProblem` w `core/settings.ts`) daje polski komunikat w formularzu, a worker i parser pliku odrzucają takie URL-e (`INVALID_SETTINGS`, `KEYSTORE_INVALID_FORMAT`);
    - awaryjny `https://api.mainnet.solana.com` jest stałą w kodzie, nie ustawieniem.
- Konsekwencje:
  - BUNNDLY-13 (salda tokenów) dołoży do tego samego mechanizmu kolejne zapytania.
  - CSP aplikacji (`connect-src`) musi obejmować `https://*.helius-rpc.com`, `wss://*.helius-rpc.com` i `https://api.mainnet.solana.com`.

## D-021: Salda tokenów: stałe programów i układ kont

- Data: 2026-10-02
- Zadanie: BUNNDLY-13
- Kontekst: SPEC 3.2 (saldo tokenu dla SPL Token i Token-2022). Zadanie zabrania ciężkich zależności dla samych stałych.
- Decyzja:
  - **Adresy programów jako stałe z oficjalnej dokumentacji** (linki w `src/chain/tokens.ts`), bez nowych paczek:
    - Token `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` (https://spl.solana.com/token);
    - Token-2022 `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` (https://spl.solana.com/token-2022);
    - Associated Token `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` (https://spl.solana.com/associated-token-account).
  - **ATA** wyprowadzam przez `getProgramDerivedAddress` z `@solana/kit` (już w projekcie, D-020) z ziarnami `[właściciel, program tokenów, mint]`. Test sprawdza zgodność z kontami z mainnetu dla obu programów.
  - **Mint:** program wynika z właściciela konta. Rozpoznawane są tylko Token i Token-2022, a każdy inny właściciel lub brak konta daje nowy kod `NOT_A_TOKEN_MINT` z komunikatem po polsku.
    - SPL: dokładnie 82 bajty;
    - Token-2022: 82 bajty albo więcej niż 165 z bajtem typu konta `1` (Mint) na pozycji 165;
    - w obu przypadkach `is_initialized` (bajt 45) musi być 1, a `decimals` to bajt 44.
    - Konto tokenowe podane jako mint jest odrzucane.
  - **Saldo:** czytam tylko 72 bajty bazowej części konta (`dataSlice`: mint, właściciel, kwota u64 LE na pozycji 64). Rozszerzenia Token-2022 leżą za bajtem 165, więc nie wpływają na odczyt.
    - Sprawdzam właściciela konta (program tokenów) i pole mint.
    - Brak ATA oznacza `0n`.
    - ATA zasilony SOL-em przed utworzeniem konta tokenowego (konto System Program bez danych) też oznacza `0n`. Program ATA obsługuje ten stan przy tworzeniu konta ([program/src/tools/account.rs](https://github.com/solana-program/associated-token-account/blob/main/program/src/tools/account.rs), gałąź `new_pda_account.lamports() > 0`), a każdy inny nieoczekiwany stan pod adresem ATA daje `INTERNAL_ERROR`, nie błąd sieci.
    - Liczone są tylko ATA: tokeny na innych kontach tokenowych tego samego właściciela nie są widoczne. Jupiter wysyła tokeny floty na ATA, ale zaimportowany mnemonik może mieć tokeny gdzie indziej.
    - Kwota jest `bigint` (`DataView.getBigUint64`), bez utraty precyzji.
  - **Worker:** `refreshBalances { mint? }` zwraca dodatkowo `token: { mint, program, decimals, balances: { index, amount }[] }`. Działa tym samym transportem z backoffem i fallbackiem (D-020), nie jest aktywnością, a odpowiedź nie zawiera klucza.
  - **Fixtures:** `tests/fixtures/token-accounts.mainnet.json` to prawdziwe konta z mainnetu pobrane przez Helius (`getMultipleAccounts`, base64; slot i źródło są w pliku):
    - mint USDC (SPL) i jego ATA;
    - mint PYUSD (Token-2022 z rozszerzeniami) i jego ATA z rozszerzeniami;
    - ATA losowego adresu, którego nie ma;
    - ATA zasilony przed utworzeniem: stan po `simulateTransaction` przelewu 650240 lamportów (`sigVerify: false`, nic nie zostało wysłane, slot w pliku).

    Wartości kontrolne (decimals, kwoty, rozszerzenia) pochodzą z niezależnego parsera Helius (`jsonParsed`). Klucz był tylko w zmiennej środowiska `HELIUS_API_KEY` i nie trafił do repo.
- Konsekwencje: BUNNDLY-14 pokaże salda tokenu z `decimals`. Przy pierwszym zakupie (BUNNDLY-16 i dalej) ten sam kod wyprowadzi ATA do sprawdzenia rezultatu.

## D-022: Tabela floty

- Data: 2026-10-02
- Zadanie: BUNNDLY-14 (część 1: tabela; akcje zbiorcze i pasek podsumowania w osobnym PR)
- Kontekst: SPEC 3.2. Maksymalnie 100 portfeli, salda odświeżane co 12 s (D-020).
- Decyzja:
  - **Kolumny:** #, etykieta, adres (kopiuj i QR, tylko po odblokowaniu, D-018), saldo SOL, max spend (edytowalny, w SOL), rezerwa, saldo tokenu (z `decimals`, po wpisaniu adresu mintu, D-021) i aktywny.
  - **Pole „Adres tokenu (mint)” nad tabelą** (decyzja z review BUNNDLY-13): służy do podglądu sald tokenu przez `refreshBalances { mint }`. W sprincie 3 to samo pole wykorzysta „Kupuj teraz”. Mint nie jest ustawieniem i nie trafia do pliku floty. `NOT_A_TOKEN_MINT` jest pokazywany przy polu, nie zamiast tabeli, a po tym błędzie odświeżanie idzie bez mintu, więc salda SOL dalej się aktualizują, aż użytkownik poprawi adres.
  - **Arytmetyka na `bigint`** (`ui/fleet-math.ts`):
    - rezerwa = saldo − max spend;
    - portfel jest gotowy do zakupu, gdy jest aktywny, ma max spend większy od 0, znane saldo i rezerwę ≥ `MIN_RESERVE_SOL` (rezerwa dokładnie równa minimum jest w porządku);
    - zbyt mała rezerwa (także max spend większy niż saldo) daje czerwony wiersz.
  - **Pole max spend:** przecinek albo kropka, najwyżej 9 miejsc po przecinku, bez wartości ujemnych, z osobnymi komunikatami po polsku; puste pole oznacza brak max spend. Kwota większa niż saldo jest tylko ostrzeżeniem, bo max spend często ustawia się przed wpłatą.
  - **Zapis:**
    - „Zapisz zmiany w tabeli” wysyła `saveSettings` z `maxSpend`, flagami `active` (zapisuję tylko nieaktywne, bo brak wpisu oznacza aktywny, D-019) i bieżącymi ustawieniami globalnymi;
    - plik zapisuje się po kliknięciu, jak w D-017 i D-018;
    - niezapisane zmiany w tabeli i niezapisany plik chronią przed blokadą, wyjściem i zamknięciem karty;
    - zmiany porównuję po wartości, więc „0.5” i „0,5” to to samo.
  - **Wydajność przy 100 wierszach:**
    - wiersz to `React.memo` z prostymi propsami (`bigint` porównuje się po wartości) i stabilnymi callbackami;
    - odświeżenie sald przerysowuje tylko wiersze, których liczby się zmieniły;
    - test liczy rendery każdego wiersza przez testowy hook `rowProbe`.
  - **Akcje zbiorcze (część 2):**
    - „Max spend dla wszystkich” ustawia tę samą kwotę w każdym wierszu;
    - „Max spend jako % salda” daje `floor(saldo × bp / 10 000)`, więc zaokrąglenie nigdy nie przekracza udziału. Procent ma zakres 0,01–100 i najwyżej 2 miejsca po przecinku. Portfele bez odczytanego salda są pomijane, z informacją ile;
    - „Zaznacz/Odznacz wszystkie” zmienia flagi aktywności;
    - akcje zmieniają tylko szkic tabeli. Zapis do sejfu i pliku zostaje osobnym krokiem.
  - **Pasek podsumowania (część 2):** łącznie SOL (znane salda), łącznie do wydania (max spend gotowych portfeli), liczba gotowych portfeli i łącznie tokenów (z `decimals`). Wszystko na `bigint`, ze szkicu tabeli, więc widać skutek zmian przed zapisem. Średnia cena wejścia dojdzie w sprincie 3.
- Konsekwencje: kolumny zakupu (status, Tx) dojdą w sprincie 3. Akcje zbiorcze i pasek podsumowania są w drugim PR tego zadania.

## D-023: Eksport jawny mnemonika i kluczy

- Data: 2026-10-02
- Zadanie: BUNNDLY-11
- Kontekst: SPEC 3.1 i 6.1, D-013 (w workerze nie ma eksportu kluczy bez hasła). Eksport jawny to jedyna droga do kopii zapasowej mnemonika, bo kreator nigdy go nie pokazuje (review BUNNDLY-6).
- Decyzja:
  - **Nowe żądanie workera `exportPlain { password, format: 'txt' | 'json' }`.** To jedyna odpowiedź workera z sekretami i wyjątek opisany w D-013: działa tylko z hasłem.
  - **Weryfikacja hasła:** worker szyfruje bieżący stan kluczem sesji, a potem otwiera ten plik podanym hasłem przez `openKeystore`, czyli pełną derywację scrypt, odszyfrowanie AES-GCM i kontrolę spójności adresów. Nic nie jest porównywane z pamięcią, bo worker hasła nie przechowuje. Złe hasło daje `KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED`, także przy wiadomości wysłanej prosto do workera.
  - **Treść:** ostrzeżenie, nazwa floty, data, mnemonik oraz dla każdego portfela etykieta, indeks, ścieżka, adres i klucz prywatny base58 (64 bajty: seed i klucz publiczny, format importu Phantom i Solflare). Plik `<flota>.EKSPORT-JAWNY.txt` albo `.json`.
  - **UI:**
    - dialog z ostrzeżeniem, checkboxem „Rozumiem, że ten plik daje pełny dostęp do środków” i ponownym hasłem; przycisk jest aktywny dopiero przy obu;
    - hasło jest czyszczone po każdej próbie;
    - treść z odpowiedzi idzie od razu do pobrania (`Blob`, `revokeObjectURL` po 60 s, D-017) i nigdy nie trafia do stanu React, DOM, storage ani logów; zostaje tylko nazwa pliku;
    - eksport jest zawsze pobraniem, nigdy zapisem do wybranego folderu, żeby jawny plik nie trafił przypadkiem obok pliku floty.
  - **Dostęp:** z ekranu Flota („Kopia zapasowa”) i z ekranu końcowego kreatora („Zrób kopię zapasową mnemonika”), w obu miejscach ten sam dialog.
  - **Timeout klienta** jak dla `create` i `unlock` (scrypt).
- Konsekwencje: test „brak sekretów w odpowiedziach” w workerze dalej obejmuje wszystkie inne operacje; `exportPlain` ma osobne testy.

## D-024: Test połączeń i nagłówki limitów Jupitera

- Data: 2026-10-02
- Zadanie: BUNNDLY-16
- Kontekst: SPEC 3.3 („Test połączeń”), 2.2 i 3.5 (limiter `/order` w sprincie 3), D-016 (klucze API tylko w workerze).
- Decyzja:
  - **Gdzie działa:** nowe żądanie workera `testConnections`. Jak w `refreshBalances`, w kolejce idzie tylko odczyt kluczy; trzy testy biegną równolegle poza kolejką, więc `lock` nie czeka na sieć. Kliknięcie to aktywność użytkownika. Zablokowanie floty w trakcie testu odrzuca wynik (`VAULT_LOCKED`).
  - **Wynik:** dla każdej usługi `ok`, czas w ms, kod problemu i status HTTP oraz dane publiczne: slot, czas połączenia i pierwszego zdarzenia WSS, `outAmount`, `router`, nagłówki `x-ratelimit-*`. Nigdy klucz ani URL. Oryginalne błędy `fetch` i `WebSocket` są odrzucane, bo mogą zawierać URL z kluczem. Polskie komunikaty są w `core/connection.ts` (`CONNECTION_PROBLEMS`), wspólne dla workera i UI.
  - **Helius HTTP:** `getHealth`, potem `getSlot` (POST JSON-RPC na URL z kluczem albo własny URL RPC). Bez klucza: `KEY_MISSING` i żadnego zapytania.
  - **Helius WSS:** `slotSubscribe` → pierwsze `slotNotification` → `slotUnsubscribe` → zamknięcie; mierzę czas do `open` i do pierwszego zdarzenia. Przeglądarka nie podaje powodu nieudanego handshake'u (401 i zły host wyglądają tak samo), więc socket, który się nie otworzył, to `WS_REFUSED` z podpowiedzią (klucz, adres, limit połączeń).
  - **Jupiter:** `GET https://api.jup.ag/swap/v2/order`, SOL → USDC, 0,01 SOL, **bez `taker`**. Według dokumentacji odpowiedź ma wtedy `transaction: null`, czyli to sam quote; odpowiedź z transakcją jest odrzucana jako nieoczekiwana. Nagłówek `x-api-key` tylko z kluczem; bez klucza plan Keyless. Nigdy `/execute`.
  - **Minty:** wrapped SOL `So11111111111111111111111111111111111111112` z `declare_id!` w `solana-program/token` (`interface/src/native_mint.rs`); USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` ze strony Circle (u mnie zablokowana, link w kodzie) i z przykładu SOL → USDC w dokumentacji Jupitera. To ten sam mint co w fixtures BUNNDLY-13 (SPL, 6 miejsc).
  - **Limit czasu:** 10 s na test (`TIMEOUT`).
  - **Nagłówki limitów są czytelne w przeglądarce (sprawdzone 2026-10-02):**
    - preflight `OPTIONS /swap/v2/order` z `Origin` i `Access-Control-Request-Headers: x-api-key` daje `access-control-allow-headers: x-api-key` i `access-control-allow-origin` równe origin strony;
    - `GET` Keyless (bez klucza, bez `taker`) daje 200 z `access-control-expose-headers: x-ratelimit-remaining, x-ratelimit-current, x-ratelimit-reset, x-api-gateway-request-id, server-timing`, więc `fetch` w przeglądarce i w workerze odczyta wszystkie trzy;
    - według dokumentacji nagłówki są tylko przy 200 i 429 (nie przy 401, 403, 5xx) i mogą zniknąć przy planach bez limitu; `x-ratelimit-reset` to sekundy Unix, kiedy zwalnia się jedno miejsce w oknie 60 s;
    - wniosek dla limitera (sprint 3): nagłówki służą do korekty, nie są podstawą, bo bywają nieobecne. Podstawą jest budżet okna z 10% zapasu (seria na start), zgodnie z decyzją Krystiana z 2026-10-02 zapisaną w BUNNDLY-20; szczegóły dopiszemy przy tamtym zadaniu.
  - **Rozbieżności z opisem zadania i SPEC (wygrywa dokumentacja):**
    - Keyless: nagłówki nie pasują do tabeli planów (30/min). Moje zapytanie dało `x-ratelimit-current: 1` i `x-ratelimit-remaining: 4`. Spike Andy'ego (BUNNDLY-30) to wyjaśnia:
      - `x-ratelimit-reset` wypada po ok. 10 s, czyli nagłówki opisują okno 10 s z 5 zapytaniami;
      - serie 8 i 12 równoległych zapytań przeszły bez 429;
      - liczniki są niespójne między odpowiedziami, a `x-ratelimit-limit` nie jest wysyłany.

      Dlatego test pokazuje surowe wartości tych nagłówków, które przyszły, nie wylicza z nich planu ani okna, a brak nagłówków nie jest błędem. Test ręczny z kluczem Krystiana pokaże wartości dla planu z kluczem.

    - Helius WebSocket: według aktualnej dokumentacji otwarcie połączenia kosztuje 1 kredyt, a strumień 2 kredyty za 0,1 MB danych. „1 kredyt za zdarzenie” dotyczy Parsed Streams. Limit planu Free: 5 równoczesnych połączeń i 10 zapytań/s. Test trwa ułamek sekundy i używa jednego połączenia.
- Konsekwencje:
  - CSP (`connect-src`) musi obejmować również `https://api.jup.ag` (D-020 wymienia Helius HTTPS/WSS i awaryjny RPC).
  - Test ręczny z prawdziwymi kluczami robi Krystian (etykieta `blocked:krystian`); wynik i nagłówki opisujemy w komentarzu zadania.

## D-025: Wdrożenie na Cloudflare Pages i nagłówki bezpieczeństwa

- Data: 2026-10-02
- Zadanie: BUNNDLY-31
- Kontekst: SPEC 2.1, 6.4, 6.6, 7 (kryterium MVP „build statyczny działa lokalnie i po wdrożeniu, z nagłówkami CSP”), 8 i 10 (etap 5). Strona `developers.cloudflare.com` jest w moim środowisku zablokowana, więc dokumentację Cloudflare czytałem ze źródeł w repozytorium `cloudflare/cloudflare-docs` (gałąź `production`): Pages `headers`, `serving-pages`, `build-image`, `preview-deployments`, `known-issues`, `branch-build-controls` oraz Zero Trust `one-time-pin` i `policies`.
- Decyzja:
  - **Cloudflare Pages z integracją Git:** polecenie `npm run build`, katalog `dist`, Node z `.nvmrc` (Pages czyta ten plik sam). W repozytorium nie ma `wrangler.jsonc`, sekretów ani zmiennych środowiskowych. CI zostaje ręczne (D-012).
  - **SPA fallback bez konfiguracji:** według dokumentacji Pages, jeśli w buildzie nie ma `404.html`, każda ścieżka dostaje `index.html`. Nie dodaję `_redirects`; test pilnuje, że `public/404.html` nie istnieje.
  - **`public/_headers` to jedno źródło nagłówków.** Vite kopiuje go bez zmian do `dist/_headers`, a Cloudflare stosuje go do każdej odpowiedzi (reguła `/*`, także do skryptu workera, którego CSP obowiązuje w workerze).
    - `Content-Security-Policy`: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://*.helius-rpc.com wss://*.helius-rpc.com https://api.jup.ag https://api.mainnet.solana.com; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. Bez `unsafe-inline` i `unsafe-eval`. `form-action 'none'` dodałem ponad opis zadania: wszystkie formularze są obsługiwane w JS (`preventDefault`), więc żaden nie wysyła danych.
    - `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`.
    - `Permissions-Policy`: wyłączone `camera`, `microphone`, `geolocation`, `payment`, `usb`, `serial`, `hid`, `midi`, `display-capture`; `screen-wake-lock=(self)` dla watchera (sprint 4). `bluetooth` usunąłem, bo Chromium zgłasza go w konsoli jako nieznaną funkcję.
  - **`vite preview` wysyła te same nagłówki:** plugin `deploy/headers.ts` parsuje `public/_headers` (komentarze, wzorce dokładne i z jednym `*` na końcu, łączenie powtórzonych nagłówków przecinkiem jak w Cloudflare) i ustawia je w middleware podglądu. Testy w Chromium w kolejnych zadaniach działają więc z produkcyjnym CSP. `npm run dev` nie dostaje CSP, bo podgląd na żywo Vite i plugin React wymagają skryptów inline.
  - **Cloudflare Access:** konfiguruje Krystian według README. Według dokumentacji przycisk „Enable access policy” w Pages chroni tylko wdrożenia podglądowe; główny adres `*.pages.dev` wymaga usunięcia `*` z hostname tej aplikacji i ponownego włączenia polityki. Logowanie: One-time PIN na e-mail, polityka `Allow` z `Include: Emails` tylko z adresem Krystiana. Własna domena: najpierw domena, potem osobna aplikacja Access (Access na domenie blokuje jej dodanie).
  - **Vercel:** tylko wzmianka w README, bez `vercel.json` (SPEC 8.3).
- Konsekwencje:
  - Każdy merge do `main` wdraża produkcję; inne gałęzie tworzą wdrożenia podglądowe (chronione przez Access albo wyłączone w ustawieniach gałęzi).
  - Nowe domeny w `connect-src` (np. dla watchera w sprincie 4) dopisujemy w `public/_headers` i w teście `tests/deploy/headers.test.ts`.

## D-026: Klient Jupiter Swap API V2

- Data: 2026-10-02
- Zadanie: BUNNDLY-19
- Kontekst: SPEC 0.1, 2.2 i 3.5; dokumentacja `order-and-execute.md`, `rate-limits.md`, `gasless.md` i specyfikacja OpenAPI `openapi-spec/swap/v2/swap.yaml`; spike Andy'ego (BUNNDLY-30 i komentarz w BUNNDLY-19).
- Decyzja:
  - **`src/jupiter/client.ts` to jedyny moduł, który zna kształt `/order` i `/execute`.** Test połączeń (D-024) używa tego samego klienta (`getOrder` bez `taker`).
  - **Bez wyjątków:** każde wywołanie zwraca `{ ok: true, value, rateLimit }` albo `{ ok: false, code, httpStatus, rateLimit, signature }`. Kody: `RATE_LIMITED`, `SERVER_ERROR`, `TIMEOUT`, `NETWORK`, `NO_ROUTE`, `BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `HTTP_ERROR`, `INVALID_RESPONSE`. W wyniku nie ma URL-a, klucza ani tekstu błędu od Jupitera; polskie komunikaty są w `src/jupiter/messages.ts`. Decyzje o ponowieniu podejmuje executor (BUNNDLY-23).
  - **`/order` tylko w trybie ultra:** `inputMint` (wrapped SOL), `outputMint`, `amount` (lamporty), `taker`; żadnych parametrów opcjonalnych. `x-api-key` tylko z kluczem. Kwota ≤ 0 daje `BAD_REQUEST` bez zapytania. Limit czasu 10 s.
  - **Walidacja odpowiedzi `/order`:** wymagane `requestId`, `router`, `inputMint`, `outputMint`, `inAmount`, `outAmount` i obecne `signatureFeePayer` (może być `null`). Kwoty, `otherAmountThreshold` i `lastValidBlockHeight` to stringi dziesiętne zamieniane na `bigint`; `expireAt` (RFQ) to sekundy Unix. Zachowuję też płatników opłat, `gasless`, `feeMint`, `feeBps` i `priceImpactPct`. Nadmiarowe pola nie są błędem. `transaction` to base64 (najwyżej 4096 znaków), `null` (bez `taker`) albo `""` z `errorCode`. Pole o złym typie daje `INVALID_RESPONSE`.
  - **`transaction: ""`** mapuję na powód według pary (`router`, `errorCode`) z dokumentacji: dla `metis`, `dflow` i `okx` kod 1 to brak środków, 2 brak SOL na opłatę, 3 kwota poniżej minimum gasless; dla `jupiterz` kod 1 to brak środków, 2 brak ATA, 3 quote, którego nie da się zbudować; inna para daje `OTHER`.
  - **`/execute`:** POST z `signedTransaction`, `requestId` i opcjonalnym `lastValidBlockHeight` (string). Limit czasu 60 s, bo Jupiter czeka na potwierdzenie. Każdy z 14 udokumentowanych kodów ma własny wynik (`SUCCESS`, `ORDER_NOT_FOUND`, … `RFQ_SWAP_REJECTED`), nieznany kod daje `UNDOCUMENTED`. HTTP 400 z liczbowym `code` to typowany wynik `Failed`; bez kodu `BAD_REQUEST`. HTTP 500 zachowuje `signature`, jeśli Jupiter ją podał, bo transakcja może jeszcze wylądować (stan UNKNOWN w BUNNDLY-23).
- Ustalenia z prawdziwego API (Keyless, 2026-10-02, tylko `/order`, fixtures w `tests/fixtures/jupiter-order.mainnet.json`):
  - **„brak trasy”** to HTTP 400 z `{"requestId": …, "error": "Failed to get quotes"}`: dla mintu bez płynności (wrapped SOL w Token-2022) i dla kwoty 1 lamport. Rozpoznaję go po tekście błędu (`failed to get quotes` albo `no route`), bo innego sygnału nie ma. Pozostałe 400 to `BAD_REQUEST`: zły mint daje `"Invalid outputMint"`, kwota 0 daje `"Invalid amount"`. Adres portfela zamiast mintu dał HTTP 500 (`SERVER_ERROR`).
  - **Nagłówki `x-ratelimit-*` przychodzą także przy 400 i 500**, wbrew `rate-limits.md` (tylko 200 i 429). Klient czyta je przy każdej odpowiedzi.
  - **Router:** dla 0,01 SOL wygrał `metis`, dla 1 SOL i 20 SOL `jupiterz`. Odpowiedź `jupiterz` ma `gasless: true`, `signatureFeePayer` równe adresowi market makera (inne niż `taker`) i `expireAt` zamiast `lastValidBlockHeight`. To trzeba uwzględnić w kontrolach przed podpisem (BUNNDLY-22).
  - **Pusty portfel:** `transaction: ""`, `errorCode: 1`, `gasless: true`, `signatureFeePayer: null`.
  - Przy szukaniu publicznego adresu z SOL `getBlock` na Helius odrzucił `maxSupportedTransactionVersion: 0`, bo w bloku były **transakcje w wersji 1**. Jupiter dokumentuje transakcje v0; dekoder przed podpisem (BUNNDLY-22) powinien sprawdzać wersję.
  - Fixtures `/execute` (`tests/fixtures/jupiter-execute.docs.json`) są zbudowane z dokumentacji, bo `/execute` na prawdziwym API nie wołamy.
- Konsekwencje: limiter (BUNNDLY-20) dostaje `rateLimit` z każdej odpowiedzi, a executor (BUNNDLY-21, 23) kody błędów, powody `buildError` i wyniki `/execute`.

## D-027: Limiter `/order` i `/execute`

- Data: 2026-10-02
- Zadanie: BUNNDLY-20
- Kontekst: SPEC 3.5 mówi o token buckecie z tempem `ORDER_RPS` (ok. 1/s z marginesem). Dokumentacja Jupitera (`rate-limits.md`) opisuje okno przesuwne 60 s, a spike Andy'ego (BUNNDLY-30) pokazał, że nagłówki bez klucza opisują okno 10 s z 5 zapytaniami, liczniki są niespójne, a serie 8 i 12 zapytań przeszły bez 429. Krystian zdecydował 2026-10-02 („tak”, komentarz w BUNNDLY-20): budżet okna z 10% zapasu i seria na start.
- Decyzja:
  - **Odstępstwo od SPEC 3.5:** zamiast równego tempa ~1/s limiter `/order` daje **budżet 90% limitu planu na 60 s**: Keyless 27, Free 54, Developer 540, Launch 2700, Pro 8100, plan własny 90% `orderRpm` (co najmniej 1). Dokumentacja Jupitera wygrywa ze SPEC (SPEC 0.1).
  - **Seria na start:** pierwsze min(budżet, N) wywołań rusza od razu; potem w żadnym przesuwnym oknie 60 s nie ma więcej startów niż budżet. Kolejne ruszają, gdy najstarszy start wypada z okna.
  - **Korekta z nagłówków, nie podstawa:**
    - `x-ratelimit-remaining ≤ 0` (przy dowolnym statusie) albo 429 wstrzymuje nowe `/order` do `x-ratelimit-reset`;
    - bez użytecznego resetu (brak nagłówka, reset w przeszłości) backoff 1 s → 2 s → 4 s → 8 s → maks. 10 s; odpowiedź bez błędu (status < 400) zeruje backoff;
    - reset dalej niż 60 s od teraz przycinam do 60 s (przesunięcie zegara albo zły nagłówek);
    - brak nagłówków nie zmienia budżetu; po pauzie limiter dalej pilnuje okna.
  - **`/execute`:** osobny limiter, 90% puli na sekundę: Keyless 18, Free 45, plany płatne 90. Plan własny przypisuję według `orderRpm` (do 30 Keyless, do 60 Free, wyżej płatny). Nie zużywa budżetu `/order`.
  - **Tryb równego tempa** (`steady`): jeden start co 60 s / budżet. Opcja konstruktora bez UI, na wypadek gdyby test BUNNDLY-30 pokazał 429 przy seriach.
  - **Przerwanie:** `acquire(signal)` zwraca `false` po `abort` (STOP) i zwalnia miejsce w kolejce; nigdy nie rzuca.
  - **Czysta logika** w `src/executor/limiter.ts` ze wstrzykiwanym zegarem (`now`, `sleep`), bez DOM. Kolejność oczekujących FIFO.
- Konsekwencje: executor (BUNNDLY-21) woła `acquire` przed każdym `/order` i `/execute` oraz `report` z `httpStatus` i `rateLimit` z wyniku klienta (D-026). Jeśli nagłówki okażą się wiarygodne (BUNNDLY-30), korektę można rozszerzyć bez zmiany budżetu.

## D-028: Podpis transakcji z `/order` w sejfie i kontrole przed podpisem

- Data: 2026-10-02
- Zadanie: BUNNDLY-22
- Kontekst: SPEC 2.3, 6.1 i 6.2, D-013 (sejf ma tylko operacje domenowe, nie ma „podpisz bajty”), D-026 (klient Jupitera), `order-and-execute.md` („Sign the transaction”: podpis częściowy) i `gasless.md`.
- Decyzja:
  - **`VaultHandler.signOrder(walletIndex, { outputMint, amount }, order)`** to metoda dla executora, który działa w tym samym workerze. Nie ma jej w `handle` ani w protokole wiadomości; żądania `signOrder`, `sign` i `signTransaction` z UI dają `INTERNAL_ERROR` (test). Nigdy nie rzuca: zwraca podpisaną transakcję albo kod problemu.
  - **Kontrole są osobną, czystą funkcją bez klucza** (`src/executor/order-check.ts`), więc da się je uruchomić na prawdziwych transakcjach bez żadnego klucza (BUNNDLY-30 część B). Kolejność i kody:
    - `/order` dał transakcję (`NO_TRANSACTION`);
    - `taker` odpowiedzi to adres portfela (`TAKER_MISMATCH`), `inputMint` to SOL, `outputMint` to zlecony mint;
    - `inAmount` nie przekracza max spend portfela, który sejf bierze **z własnych ustawień**, nie od wywołującego (`OVER_MAX_SPEND`), i równa się zleconej kwocie (`AMOUNT_MISMATCH`);
    - bajty dają się zdekodować przez `@solana/kit` (`UNDECODABLE`), liczba podpisów zgadza się z nagłówkiem;
    - wersja wiadomości to 0 (`NOT_V0`: legacy i v1 są odrzucane, choć na mainnecie są już transakcje v1, D-026);
    - najwyżej 2 wymagane podpisy (`TOO_MANY_SIGNERS`): taker oraz ewentualnie market maker JupiterZ albo sponsor gasless;
    - portfel jest sygnatariuszem, a jego miejsce na podpis jest puste;
    - pierwszy klucz (płatnik opłaty) to `signatureFeePayer`, a gdy go nie ma, taker (`FEE_PAYER_MISMATCH`).
  - **Podpis:** `createKeyPairFromBytes` z 64-bajtowego klucza sejfu (sprawdza też zgodność połówek), `getAddressFromPublicKey` musi dać adres takera, `signBytes` na `messageBytes`. Wypełniam tylko miejsce takera; pozostałe podpisy zostają bajt w bajt (przy JupiterZ market maker podpisuje w `/execute`). Wynik: transakcja w base64 i sygnatura transakcji, gdy taker płaci opłatę (pierwszy podpis), a w przeciwnym razie `null`.
  - **Blokada w trakcie podpisu** zeruje klucz; wynik jest wtedy odrzucany (`VAULT_LOCKED`), a niespodziewany błąd daje `SIGNING_FAILED` bez szczegółów.
  - **Granica zaufania:** API Jupitera (HTTPS do `api.jup.ag`) jest zaufane. Kontrole chronią przed pomyłkami (inny portfel, inne zlecenie, inna kwota, uszkodzone dane), a nie przed złośliwym Jupiterem: nie interpretują instrukcji swapu. Twardą granicę wydatku daje max spend z sejfu.
- Konsekwencje: executor (BUNNDLY-21) woła `signOrder` po każdym `/order` z transakcją; sygnatura z wyniku (albo z `/execute` przy JupiterZ) służy do śledzenia stanu UNKNOWN (BUNNDLY-23). Test „brak sekretów w odpowiedziach” obejmuje wynik `signOrder`.

## D-029: Executor, tryb DRY-RUN i sterowanie zakupem z workera

- Data: 2026-10-02
- Zadanie: BUNNDLY-21 (obejmuje dawne BUNNDLY-26 DRY-RUN i fałszywego Jupitera z BUNNDLY-29)
- Kontekst: SPEC 3.4, 3.5 i 6; D-013 (sejf ma tylko operacje domenowe), D-026 (klient Jupitera), D-027 (limiter), D-028 (podpis w sejfie).
- Decyzja:
  - **Maszyna stanów** (`src/executor/states.ts`): IDLE → QUEUED → QUOTING → SIGNING → SUBMITTED → CONFIRMED, z odgałęzieniami do QUEUED (ponowienie), FAILED, UNKNOWN i SKIPPED. Tabela `TRANSITIONS` jest jedynym źródłem dozwolonych przejść; niedozwolone przejście rzuca `IllegalTransitionError` (błąd programisty, test). Stany końcowe: CONFIRMED, FAILED, UNKNOWN, SKIPPED. Każdy stan końcowy poza CONFIRMED ma powód z kodem i komunikatem po polsku.
  - **Kolejka FIFO i potok:** dyspozytor bierze następny portfel, gdy limiter `/order` da miejsce, i nie czeka na inne portfele. Próba to `/order` → kontrole i podpis w sejfie → `/execute`; `/execute` różnych portfeli idą równolegle (osobny limiter, D-027). Portfel jest najwyżej w jednej próbie naraz (test). Ponowienie wraca na koniec kolejki.
  - **Polityka po każdym kroku** jest osobnym modułem (`src/executor/policy.ts`), żeby BUNNDLY-23 mogło ją zmienić bez ruszania kolejki:
    - `/order`: 429 wraca do kolejki bez liczenia próby; 5xx, timeout, sieć i brak trasy wracają z liczeniem próby; inne błędy kończą FAILED;
    - `transaction: ""`: brak środków albo SOL na opłatę daje SKIPPED; inne powody wracają do kolejki;
    - `/execute` bez odpowiedzi, 5xx i kody „nieznany wynik” (-1001, -2001) dają **UNKNOWN i nigdy nie są ponawiane** w tym zadaniu; kody błędu po naszej stronie (-2, -3, -1002, -1003, -2002) oraz 400/401/403 dają FAILED; 429 wraca do kolejki bez liczenia próby; pozostałe udokumentowane porażki wracają do kolejki z liczeniem próby;
    - po `maxAttempts` próbach portfel kończy FAILED (`MAX_ATTEMPTS`).
  - **Tymczasowość:** ponowienie po porażce zgłoszonej przez `/execute` nie sprawdza jeszcze łańcucha. Dodaje to BUNNDLY-23 (sprawdzenie sygnatury i salda przed ponowieniem, okno „no route”, sufit ceny). **Trybu na żywo nie używamy przed BUNNDLY-23.**
  - **DRY-RUN** (`GlobalSettingsV1.dryRun`) jest domyślnie włączony. Plik bez tego pola (sprzed BUNNDLY-21) też oznacza DRY-RUN, bez komunikatu o resecie. Wartość złego typu też daje DRY-RUN, z komunikatem. W DRY-RUN executor robi prawdziwe `/order`, kontrole i podpis, a potem wyrzuca podpisaną transakcję: `/execute` nie jest wołane na żadnej ścieżce (test zlicza wywołania), a portfel kończy SKIPPED (`DRY_RUN`). Wyłączenie DRY-RUN w Ustawieniach wymaga potwierdzenia z ostrzeżeniem.
  - **Kontrola przed `/order`:** portfel bez odczytanego salda SOL kończy SKIPPED (`BALANCE_UNKNOWN`); saldo mniejsze niż max spend + rezerwa daje SKIPPED (`INSUFFICIENT_SOL`). Salda pochodzą z ostatniego `refreshBalances` w workerze.
  - **STOP:** nowe `/order` nie startują, portfele w kolejce kończą SKIPPED (`STOPPED`), a próby w toku kończą się normalnie. `/execute`, które już wyszło, nie jest przerywane.
  - **Worker:** żądania `startBuy { mint }` i `stop` w protokole. `startBuy` sprawdza adres mintu (nie SOL) i bierze aktywne portfele z max spend > 0 (`INVALID_MINT_ADDRESS`, `NO_WALLETS_TO_BUY`, `BUY_RUNNING`). `armed` wynika z trwającego zakupu, a żądanie `setArmed` usunąłem: UI nie może uzbroić sejfu bez zakupu. W trakcie zakupu nie ma auto-locku, a `lock`, `create` i `unlock` dają `BUY_RUNNING`. Blokada i nowa flota unieważniają sesję, więc spóźniony podpis z poprzedniej sesji jest odrzucany.
  - **Zdarzenia:** worker wysyła `{ event }` bez `id` (stan portfela, próba, powód, quote, wynik, czasy; początek, zatrzymanie i koniec zakupu). Klient przekazuje je słuchaczom `onEvent`. W zdarzeniach nie ma kluczy, mnemonika ani podpisanych transakcji (test).
  - **Testy:** fałszywy zegar (`tests/helpers/fake-clock.ts`) i fałszywy Jupiter (`tests/helpers/fake-jupiter.ts`) z opóźnieniami, wstrzykiwanymi błędami i prawdziwymi transakcjami v0, więc sejf naprawdę podpisuje.
- Konsekwencje: BUNNDLY-23 zmienia tylko `policy.ts` i rozwiązywanie UNKNOWN; BUNNDLY-25 dopina wynik i dziennik do zdarzeń; BUNNDLY-27 (UI) słucha `onEvent` i woła `startBuy` / `stop`.

## D-030: Ponowienia bez podwójnego zakupu, okno „no route” i sufit ceny

- Data: 2026-10-02
- Zadanie: BUNNDLY-23 (obejmuje dawne BUNNDLY-24 oraz niezmienniki z BUNNDLY-29)
- Kontekst: SPEC 3.3, 3.5 i 7; dokumentacja Jupitera `order-and-execute.md` (Transaction validity, kody `/execute`) i `gasless.md`; D-026 (klient), D-029 (executor). Zastępuje tymczasową politykę z D-029.
- Decyzja:
  - **Zasada:** po wywołaniu `/execute` portfel wraca do kolejki tylko wtedy, gdy Jupiter powiedział na pewno, że nic nie wysłał, albo gdy łańcuch pokazał, że transakcja nie wylądowała i już nie wyląduje. Wszystko inne przechodzi przez sprawdzenie łańcucha (`src/executor/policy.ts`):
    - FAILED bez ponowienia (nasz błąd, nic nie poszło): `-2`, `-3`, `-1002`, `-1003`, `-2002` oraz HTTP 400, 401 i 403;
    - nowe `/order` od razu, z liczeniem próby (Jupiter odmówił przed wysłaniem): `-1`, `-1004`, `-2003`, `-2004`; 429 na `/execute` bez liczenia próby;
    - sprawdzenie łańcucha: `-1000`, `-2000` (failed to land), `-1001`, `-2001` (unknown), `status: Failed` z kodem spoza tabeli (np. slippage po wylądowaniu), brak odpowiedzi, timeout, błąd sieci, 5xx i nieczytelna odpowiedź.
  - **Sprawdzenie łańcucha** (`src/chain/landing.ts`, co 2 s; portfel jest w tym czasie UNKNOWN z powodem `EXECUTE_NO_ANSWER`):
    - sygnatura znana (taker płaci opłatę albo `/execute` ją zwrócił): `getSignatureStatuses` z historią; `confirmed`/`finalized` bez błędu to CONFIRMED, z błędem to „wylądowała z błędem”, `processed` to „jeszcze nie wiadomo”;
    - sygnatura nieznana (JupiterZ, gasless: identyfikatorem jest podpis market makera): `getSignaturesForAddress` takera (limit 25, `confirmed`) od chwili wysłania minus 120 s zapasu na zegar, a potem `getTransaction` każdego kandydata. Nasza transakcja to ta, która niesie **własny podpis takera**, który sami złożyliśmy;
    - **odstępstwo od opisu zadania: nie używam salda tokenu.** Dopasowanie po podpisie takera jest dokładne, a wzrost salda może pochodzić od cudzego przelewu tokenów, co fałszywie zablokowałoby portfel albo, przy odwrotnej logice, pozwoliło na ponowienie;
    - wygaśnięcie: wysokość bloku (`confirmed`) powyżej `lastValidBlockHeight` dla agregatora; dla RFQ bez wysokości bloku: po `expireAt` i dopiero gdy `isBlockhashValid` mówi, że blockhash transakcji już nie działa. Wygaśnięcie czytam **przed** wyszukaniem transakcji, więc transakcja, która zdążyła wylądować, jest już widoczna;
    - każda wątpliwość to „jeszcze nie wiadomo”: kandydat jeszcze niewidoczny, pełna strona nowych wpisów (starsze mogły się nie zmieścić), błąd RPC. Ponowienia wtedy nie ma;
    - wylądowała bez błędu: CONFIRMED. Wylądowała z błędem albo wygasła: ponowienie z liczeniem próby. Po 180 s bez rozstrzygnięcia (np. RPC nie działa) portfel zostaje UNKNOWN na stałe (`LANDING_UNRESOLVED`) i nigdy nie jest ponawiany; użytkownik sprawdza go w eksploratorze.
  - **Każda próba zaczyna z czystym wynikiem:** sygnatura z poprzedniej próby nie może zostać pomylona z bieżącą.
  - **Tryb na żywo wymaga klucza Helius** (`HELIUS_KEY_MISSING` przy `startBuy`), bo bez RPC nie ma sprawdzenia łańcucha. DRY-RUN nie woła `/execute`, więc go nie potrzebuje.
  - **„Brak trasy”** (`NO_ROUTE`, HTTP 400 „Failed to get quotes”, D-026):
    - okno liczy się **dla każdego portfela** od jego pierwszego „no route”, nie od startu floty. Przy Keyless (27 `/order` na minutę) późniejsze portfele dostają pierwszą odpowiedź dopiero po minucie i inaczej nie miałyby żadnego okna;
    - w oknie portfel czeka (500 ms, potem 1 s, 2 s i dalej 2 s, z ustawień) poza kolejką, nie blokując innych, i nie zużywa prób; po oknie kończy FAILED (`NO_ROUTE`);
    - odstępstwo od SPEC 3.5 („licznik prób +1”): limit 3 prób skończyłby się po około 2 s, a okno z ustawień ma 20 s;
    - STOP w czasie oczekiwania od razu kończy portfel jako SKIPPED (`STOPPED`).
  - **Sufit ceny:** cena wejścia floty to `totalInputAmount / totalOutputAmount` z pierwszego CONFIRMED, który ma te kwoty (potwierdzenie z łańcucha ich nie ma i nie ustala ceny). Każdy następny quote sprawdzam po `/order`, przed podpisem, przez mnożenie na krzyż na `bigint`: `in × wejście_out × 100 > wejście_in × out × (100 + sufit)` daje SKIPPED (`PRICE_CEILING`); `outAmount` = 0 też. Przed pierwszym zakupem sufitu nie ma.
  - **STOP:** transakcje w trakcie sprawdzania są śledzone do końca. Wylądowała: CONFIRMED; nie wylądowała: SKIPPED (`STOPPED`), bez nowego `/order`.
  - **Symulacja niezmienników:**
    - fałszywy łańcuch (`tests/helpers/fake-chain.ts`) przyjmuje transakcję tylko przed jej wygaśnięciem i jest źródłem prawdy dla niezmienników;
    - scenariusze: 50 i 100 portfeli, Keyless i Free, na żywo i DRY-RUN, losowe błędy z ziarnem, STOP w losowej chwili;
    - sprawdzam:
      - stan końcowy z powodem;
      - najwyżej jeden zakup na portfel;
      - wydatek ≤ max spend;
      - CONFIRMED wtedy i tylko wtedy, gdy zakup jest na łańcuchu;
      - budżet `/order` w każdym oknie 60 s;
      - zero `/execute` w DRY-RUN;
      - żadnego `/order` po STOP;
      - jedno wywołanie naraz na portfel;
    - `npm test` uruchamia 50 ziaren, a `npm run test:sim` 5000;
    - test pokrycia pilnuje, że przebiegi przeszły przez wszystkie ścieżki;
    - kontrola mutacją: ponowienie bez czekania na łańcuch daje 38 z 52 testów zestawu na czerwono (podwójne zakupy, przekroczony max spend).
- Konsekwencje: tryb na żywo jest od strony logiki gotowy, ale **dalej go nie używamy**, dopóki Krystian nie zgodzi się na transakcje na mainnecie (smoke test BUNNDLY-28). BUNNDLY-25 dopisze do dziennika wynik i sygnaturę z łańcucha; BUNNDLY-27 pokaże UNKNOWN jako „sprawdzam łańcuch”, a `LANDING_UNRESOLVED` z linkiem do eksploratora.

## D-031: Wynik zakupu, potwierdzenie saldem tokenu i dziennik operacji

- Data: 2026-10-02
- Zadanie: BUNNDLY-25
- Kontekst: SPEC 3.5, 3.6 i 6.1; `order-and-execute.md` (odpowiedź `/execute`: `totalInputAmount` to SOL zabrany z portfela, `totalOutputAmount` to tokeny, które do niego trafiły, po opłacie po stronie wyjścia); D-021 (salda tokenów), D-029 i D-030.
- Decyzja:
  - **Wynik:** zdarzenie CONFIRMED niesie sygnaturę, slot, `totalInputAmount` i `totalOutputAmount` jako `bigint`. Każde zdarzenie ma teraz czas `at` (Unix ms, zegar executora).
  - **Cena efektywna** (`formatPrice`) to SOL za cały token: `lamporty × 10^decimals / (jednostki × 10^9)`, liczona na `bigint`, zaokrąglona w dół do 12 miejsc, z przecinkiem.
  - **Potwierdzenie saldem tokenu** (`src/executor/verify.ts`, tylko tryb na żywo):
    - punkt odniesienia to salda tokenu całej floty, czytane raz, równolegle z pierwszym `/order`; nie ma dodatkowego czekania na ścieżce krytycznej;
    - po każdym CONFIRMED odczyt salda portfela, do 5 razy co 2 s, aż wzrost zgadza się z `totalOutputAmount`;
    - wyniki:
      - `MATCH`: wzrost zgadza się z `totalOutputAmount`;
      - `INCREASED`: saldo wzrosło, ale ilość jest nieznana (potwierdzenie z łańcucha, D-030);
      - `MISMATCH`: wzrost o inną ilość;
      - `NO_INCREASE`: saldo nie wzrosło;
      - `UNVERIFIABLE`: brak punktu odniesienia albo błędy RPC;
    - **punkt odniesienia odczytany w slocie równym albo późniejszym niż slot zakupu mógł już zawierać zakup**, więc wtedy wynik to `UNVERIFIABLE` zamiast fałszywego alarmu. Dlatego `fetchTokenBalances` zwraca też najniższy slot odczytu;
    - wynik to zdarzenie `verify` (ostrzeżenie w dzienniku, a w UI od BUNNDLY-27). **Stan portfela się nie zmienia.** Treść błędu RPC nie wychodzi.
  - **Dziennik operacji** (`src/executor/oplog.ts`):
    - jeden wpis na zdarzenie (start, zatrzymanie i koniec zakupu, każde przejście stanu portfela, weryfikacja);
    - pola: czas ISO, portfel i jego publiczny adres z chwili zdarzenia, stan, powód z kodem, szczegółem i komunikatem, próba, quote, router, sygnatura, slot, wydany SOL, kupione tokeny, cena, czasy kroków, oczekiwany i zaobserwowany wzrost;
    - zdarzenia nie niosą sekretów (D-029), a dziennik dokłada tylko adresy publiczne.
  - **Eksport:**
    - **CSV** wg RFC 4180 (przecinek, CRLF, cudzysłowy). Komórka zaczynająca się od `=`, `+`, `-`, `@`, tabulatora albo CR dostaje prefiks `'` (OWASP „CSV injection”); dlatego ujemne kody w szczegółach, np. `-1000`, też go dostają;
    - **JSON**: tablica, `bigint` jako napisy dziesiętne;
    - kwoty zawsze jako pełne liczby całkowite (lamporty, jednostki tokena);
    - nazwa pliku: `bunndly-log-<zakup>-<czas UTC>.csv|json`.
  - **UI:**
    - dziennik żyje w pamięci karty przez całą sesję, poza stanem React, więc przetrwa zmianę ekranu i auto-lock po zakupie;
    - nie trafia do storage (SPEC 6.1);
    - panel „Dziennik operacji” na ekranie Flota pokazuje liczbę wpisów i ma przyciski „Pobierz CSV” i „Pobierz JSON” (pobranie jak w BUNNDLY-11). BUNNDLY-27 przeniesie go do widoku postępu.
- Konsekwencje: BUNNDLY-27 pokazuje cenę i ostrzeżenia `MISMATCH`, `NO_INCREASE` i `UNVERIFIABLE` przy portfelu.

## D-032: UI trybu A i widok postępu

- Data: 2026-10-02
- Zadanie: BUNNDLY-27
- Kontekst: SPEC 1, 3.4 (tryb A), 3.6 i 7; D-022 (pole mintu), D-029 do D-031.
- Decyzja:
  - **Start zakupu:**
    - mint do zakupu to ten, który worker już sprawdził: jego saldo tokenu jest na ekranie po „Pokaż saldo tokenu”, a zły adres daje `NOT_A_TOKEN_MINT`;
    - „Kupuj teraz” jest aktywny tylko przy takim mincie, co najmniej jednym gotowym portfelu, zapisanej tabeli (zakup bierze ustawienia z sejfu) i, w trybie na żywo, z kluczem Helius;
    - podsumowanie pokazuje też limity Jupitera, które faktycznie obowiązują (Keyless bez klucza, D-033);
    - nie dodaję drugiego potwierdzenia przy samym starcie. Potwierdzenie jest przy przejściu na tryb na żywo, a w DRY-RUN nic nie jest wysyłane.
  - **Tryb:**
    - etykieta DRY-RUN (zielona) albo NA ŻYWO (czerwona) jest stale przy panelu zakupu;
    - przejście na tryb na żywo wymaga potwierdzenia w dialogu (`role="alertdialog"`, w treści strony, bez `window.confirm`), który podaje łączną kwotę i liczbę gotowych portfeli;
    - powrót do DRY-RUN nie wymaga potwierdzenia;
    - tryb jest ustawieniem floty (D-029), więc zmiana zapisuje się w sejfie, a ekran proponuje zapis pliku floty jak przy innych ustawieniach;
    - w Ustawieniach pole wyboru też wymaga potwierdzenia (BUNNDLY-21).
  - **Postęp:**
    - zdarzenia z workera trafiają do bufora i są stosowane raz na klatkę (`requestAnimationFrame`, a bez niego co 16 ms);
    - czysty reducer (`reduceBuy`) podmienia obiekt wiersza tylko dla portfela, który dostał zdarzenie, więc pozostałe wiersze tabeli (`memo`) się nie przerysowują (test na 100 portfelach);
    - widok zakupu i dziennik żyją w `App`, więc przetrwają zmianę ekranu w trakcie zakupu;
    - dziennik jest w widoku postępu, pod paskiem;
    - tokeny, cenę i dziennik formatuję wg `decimals` mintu z zakupu. `App` pamięta `decimals` każdego mintu odczytanego przez worker w tej sesji, więc inny mint wpisany później w pole niczego nie zmienia (uwaga z review BUNNDLY-25).
  - **Liczniki:**
    - potwierdzone;
    - w trakcie: kolejka, wycena, podpis, wysłane oraz UNKNOWN w trakcie sprawdzania łańcucha;
    - nieudane albo pominięte: FAILED, SKIPPED (także DRY-RUN) i UNKNOWN po limicie;
    - czasy od startu do pierwszego i do ostatniego CONFIRMED.
  - **Kolumny zakupu** pojawiają się w tabeli floty dopiero po pierwszym zakupie w sesji:
    - status jako tekst z kolorem i powodem po polsku;
    - czas, próby, kupione tokeny (w DRY-RUN „≈” z wyceny), wydany SOL, cena, wynik sprawdzenia saldem tokenu;
    - link do transakcji w eksploratorze z Ustawień (`solscan.io`, `orb.helius.dev`, `explorer.solana.com`), budowany tylko z poprawnej sygnatury base58, z `rel="noopener noreferrer"`.
  - **STOP:** duży czerwony przycisk przez cały zakup. Po kliknięciu pokazuje „Zatrzymywanie…” do końca przebiegu.
  - **Karta otwarta:**
    - w trakcie zakupu widać ostrzeżenie, a zamknięcie lub przeładowanie karty wywołuje pytanie przeglądarki (`beforeunload`);
    - koniec przebiegu (zdarzenie `finished`) od razu odświeża status sejfu.
- Konsekwencje: tryb B (sprint 4) użyje tego samego widoku postępu.

## D-033: Bez klucza Jupitera obowiązują limity Keyless

- Data: 2026-10-02
- Zadanie: poprawka wymagana w review PR #22 (BUNNDLY-21 i 23)
- Kontekst: D-027 (limiter). Plan z Ustawień (domyślnie Free) był używany także bez klucza Jupitera. Bez klucza API Jupiter liczy jednak każde zapytanie jako Keyless. Przebieg DRY-RUN Andy'ego na prawdziwym API (30 portfeli) dał przy planie Free 6 × 429, a przy Keyless 0 × 429.
- Decyzja:
  - `effectiveJupiterPlan(global, maKluczJupitera)` zwraca plan z Ustawień tylko wtedy, gdy klucz Jupitera jest zapisany. Bez klucza zwraca Keyless: budżet `/order` 27 na 60 s, `/execute` 18 na sekundę.
  - `startBuy` bierze limitery dla tego planu.
  - Podsumowanie przed startem (BUNNDLY-27) pokazuje plan, który faktycznie obowiązuje.

## D-034: Sprawdzanie łańcucha czyta też transakcje v1

- Data: 2026-10-02
- Zadanie: poprawka wymagana w review PR #22 (BUNNDLY-23)
- Kontekst: D-030 (sygnatura nieznana: `getTransaction` każdego kandydata z historii portfela). Około 10% transakcji na mainnecie to v1 (D-026). Z `maxSupportedTransactionVersion: 0` Helius odpowiada wtedy błędem -32015. Sprawdzenie RFQ nie mogło się rozstrzygnąć i kończyło jako UNKNOWN, nawet gdy nasza transakcja (v0) leżała obok.
- Decyzja: `getTransaction` w sprawdzaniu łańcucha używa `maxSupportedTransactionVersion: 1`. kit 8.4 dekoduje v1 poprawnie (Andy sprawdził na prawdziwej transakcji). Kontrole przed podpisem nadal przyjmują tylko v0 (D-028). Test: fałszywe RPC odpowiada -32015 dla zapytania z wersją 0.

## D-035: Świeży mint: HTTP 500 jak „brak trasy” i bramka mintu

- Data: 2026-10-02
- Zadanie: BUNNDLY-38. Uzupełnia D-030 i zastępuje jego okno „no route” liczone osobno dla każdego portfela.
- Kontekst: pomiar Andy'ego (BUNNDLY-30) na prawdziwych tokenach pump.fun, czas od logu `processed`:
  - +2 ms: HTTP 500 „Something unexpected occurred”;
  - do ok. +2 s: 400 „Failed to get quotes”;
  - od +0,3 do +3 s: 200 z trasą;
  - mint, którego nie ma na łańcuchu, daje zawsze 500.

  Wcześniej 500 zużywał próby: 3 w 0,3–0,6 s, potem MAX_ATTEMPTS. Każdy portfel ponawiał osobno, więc przy Keyless pierwsze 27 zapytań bez trasy wyczerpywało budżet na minutę.

- Decyzja:
  - **Klasyfikacja:** `SERVER_ERROR` z `/order` idzie tą samą drogą co `NO_ROUTE`: okno `noRouteWindowMs`, backoff 500 ms → 2 s, bez zużywania prób. Po oknie portfel kończy jako FAILED `NO_ROUTE` z ostatnim kodem w `detail`. To bezpieczne, bo przed `/execute` nic nie zostało wysłane. Klient Jupitera (D-026) bez zmian. `TIMEOUT` i `NETWORK` dalej zużywają próby.
  - **Bramka mintu (jedna na przebieg):**
    - zamknięta bramka: w locie najwyżej jedno `/order` (sonda), a pozostałe portfele czekają w QUEUED bez zapytań i bez prób;
    - sonda, która trafia na brak trasy, czeka backoff i idzie jako pierwsza w kolejce;
    - zapytanie, które było już w locie, gdy bramka się zamknęła, wraca na koniec kolejki;
    - odpowiedź 200 z trasą (także z błędem budowy dla danego portfela) otwiera bramkę, a reszta rusza w kolejności kolejki przez limiter;
    - kolejny brak trasy albo 500 zamyka bramkę ponownie.
  - **Bramka startuje zamknięta:** pierwsze `/order` przebiegu jest sondą.
    - Zadanie mówi, że bramkę zamyka pierwszy brak trasy. Wtedy jednak cała seria startowa (do budżetu limitera) poszłaby, zanim wróci pierwsza odpowiedź, i zużyłaby budżet Keyless na zapytania bez trasy, czyli dokładnie problem z zadania.
    - Kryterium „łącznie co najwyżej 30 + liczba sond” też da się spełnić tylko tak.
    - Koszt w trybie A dla tokenu z trasą: jedna odpowiedź `/order` (ok. 0,1–0,3 s) opóźnienia dla portfeli 2…N.
  - **Okno** (decyzja z review PR #25):
    - pierwsze okno, gdy bramka jeszcze nigdy nie była otwarta, liczy się od pierwszego braku trasy w przebiegu;
    - gdy bramka była już choć raz otwarta, każde ponowne zamknięcie zaczyna nowe okno `noRouteWindowMs`, liczone od tego zamknięcia. Pojedynczy 500 w długim przebiegu nie kończy więc czekających;
    - czas, w którym gotowa sonda czeka na limiter `/order`, nie liczy się do okna (początek okna przesuwa się o ten czas). Bez tego przy Keyless sonda czekała ok. 60 s na miejsce w limiterze, a jej jedna odpowiedź 500 kończyła okno i wszystkich czekających. Wykryła to symulacja z losowym 5% 503;
    - po końcu okna wszystkie czekające portfele kończą jako FAILED `NO_ROUTE` bez dalszych zapytań. Dotyczy to też sytuacji, w której odpowiedź sondy przyszła już po końcu okna; sonda w backoffie nie wysyła już zapytania.
  - **STOP przy zamkniętej bramce:** czekające portfele i sonda w backoffie od razu dostają SKIPPED `STOPPED`, bez nowych `/order`.
- Testy: scenariusz świeżego mintu; stałe 500; STOP; ponowne zamknięcie z nowym oknem; trasa znika na stałe po otwarciu; sonda w locie przez koniec okna; sonda czekająca na limiter Keyless. Symulacja (5000 ziaren, losowe 5% 503): 0 portfeli FAILED `NO_ROUTE`.

## D-036: Strumień logów twórcy (Helius WebSocket)

- Data: 2026-10-02
- Zadanie: BUNNDLY-32
- Kontekst: SPEC 3.4. Dokumentacja Helius WebSocket (`/docs/api-reference/rpc/websocket/llms.txt`): plan Free to 5 połączeń i 10 zapytań/s, połączenie zamyka się po 10 min bez aktywności, zalecany ping co 30–60 s. D-016, D-020, D-024 (URL z kluczem tylko w workerze, błędy WebSocket nie są czytane).
- Decyzja:
  - **`src/watcher/stream.ts`** (`startStream`): jedno połączenie, `logsSubscribe` z `{ mentions: [twórca] }` i `{ commitment: "processed" }`. Gniazdo, odczyt sygnatur, zegar i losowość są wstrzykiwane. Uruchomienie w workerze (uzbrajanie) dochodzi w BUNNDLY-34.
  - **Powiadomienia:**
    - z `err` różnym od `null` są pomijane;
    - każda sygnatura przechodzi raz (pamięć ostatnich 2000);
    - zdarzenie niesie log, źródło (`logs` albo `catch-up`) i `receivedAt` z `performance.now()` w workerze.
  - **Podtrzymanie:**
    - przeglądarkowy WebSocket nie wysyła ramek ping, więc co 30 s idzie żądanie JSON-RPC `getHealth`;
    - to nie jest metoda pubsub, więc serwer od razu odpowiada błędem. Tyle wystarczy: każda odpowiedź z naszym `id` dowodzi, że połączenie żyje, a żądanie niczego nie subskrybuje i nie może ruszyć naszej subskrypcji;
    - odrzuciłem `*Unsubscribe` z nieistniejącym id, bo id naszej subskrypcji może mieć tę samą wartość, oraz subskrypcję z natychmiastowym anulowaniem, bo to dwa zapytania i ryzyko powiadomień;
    - brak odpowiedzi przez 10 s zamyka połączenie i uruchamia ponowne łączenie, więc martwe połączenie jest wykryte najpóźniej po 40 s.
  - **Ponowne łączenie:**
    - backoff wykładniczy z jitterem: krok 0,5 s × 2^(n−1), limit 30 s, opóźnienie od połowy do całego kroku, nie mniej niż 0,5 s;
    - po każdym otwarciu ponowne `logsSubscribe`;
    - **`connected` dopiero po potwierdzeniu subskrypcji** (review PR #26): odpowiedź na `logsSubscribe` z `result` (id subskrypcji) daje `connected`, zeruje backoff i uruchamia podtrzymanie i nadrabianie. Odpowiedź z błędem albo brak odpowiedzi przez 10 s działa jak utrata połączenia (backoff, ponowne łączenie). Nie ma więc stanu „połączono” bez subskrypcji;
    - na zewnątrz tylko stany `connecting`, `connected`, `reconnecting` (z numerem próby) i `disconnected` oraz czas ostatniej wiadomości.
  - **Nadrabianie przerwy:**
    - przy uzbrojeniu najnowsza sygnatura twórcy (`getSignaturesForAddress`, `limit: 1`; przy błędzie RPC z ponowieniami) staje się dolną granicą;
    - po każdym potwierdzeniu subskrypcji (także pierwszym, co zamyka lukę między uzbrojeniem a subskrypcją) sygnatury `until` granicy (`confirmed`, strony po 1000 z `before`) przechodzą od najstarszej ze źródłem `catch-up`, bez logów (detektory użyją `getTransaction`, BUNNDLY-33);
    - nieudane transakcje są pomijane;
    - **granica tylko z historii `confirmed`** (review PR #26): ustawiają ją wyłącznie linia bazowa i najnowszy wynik nadrabiania, nigdy log `processed`. Sygnatury z logu może jeszcze nie być w `confirmed` albo nie będzie jej wcale (blok odpadnie), a `getSignaturesForAddress` z `until` spoza historii nie zatrzymuje się (Andy sprawdził na prawdziwym RPC: pełna strona). Ze stronicowaniem poszłaby cała historia twórcy, a w BUNNDLY-34 mógłby z tego wyjść zakup starego tokenu. Podwójne przekazanie tej samej sygnatury i tak blokuje deduplikacja;
    - **twarda granica czasu** (review PR #26):
      - przechodzą tylko sygnatury z `blockTime` ≥ czas uzbrojenia − 60 s;
      - `blockTime: null` traktujemy jak nową, bo stare transakcje zawsze ją mają;
      - stronicowanie kończy się na stronie, która sięga starszych sygnatur (lista jest od najnowszej);
      - najwyżej 10 stron (10 000 sygnatur);
    - bez granicy (RPC nie odpowiada od uzbrojenia) niczego nie przekazujemy, bo nie wiadomo, gdzie zaczyna się przerwa; przechodzą tylko logi na żywo.
  - **Klucz:** URL z kluczem zna tylko moduł. Zdarzenia nie niosą URL-a ani treści błędów; test sprawdza zserializowane zdarzenia, także gdy utworzenie gniazda rzuca wyjątek z URL-em. CSP już zezwala na `wss://*.helius-rpc.com`.

## D-037: Detektory nowego mintu (szybka i wolna ścieżka)

- Data: 2026-10-03
- Zadanie: BUNNDLY-33
- Kontekst: SPEC 3.4. Oficjalne IDL pump.fun, Meteora DBC i Raydium LaunchLab (linki w `src/watcher/detectors/programs.ts`). Fixtures z prawdziwych transakcji mainnetu (`tests/fixtures/detectors.mainnet.json`), pobrane skryptami poza testami przez Helius; testy działają bez sieci. Ustalenia na prawdziwych transakcjach:
  - pump.fun zapisuje `CreateEvent` w logu (`Program data:`), ale długi log bywa ucięty przez runtime („Log truncated”);
  - Meteora DBC emituje `EvtInitializePool` przez self-CPI (`emit_cpi!`), więc zdarzenia nie ma w logu;
  - transakcje tworzące LaunchLab są v1 (tablice adresów), więc `getTransaction` wymaga `maxSupportedTransactionVersion`;
  - program SPL Token (p-token) nie loguje już nazw instrukcji, więc `InitializeMint` rozpoznajemy tylko z danych instrukcji;
  - Moonshot: w ostatnich 287 transakcjach programu nie było tworzenia, a oficjalnego IDL nie udało się potwierdzić. Jego tokeny łapie ścieżka ogólna.
- Decyzja:
  - **Szybka ścieżka (log, bez RPC):**
    - tylko pump.fun `CreateEvent`;
    - `Program data:` liczy się tylko wtedy, gdy według stosu `invoke` pochodzi z programu pump.fun, więc inny program nie podrobi zdarzenia;
    - `user` w zdarzeniu musi być obserwowanym adresem.
  - **Wolna ścieżka (`getTransaction`):**
    - parametry: `json`, `confirmed`, `maxSupportedTransactionVersion: 1`; pytanie co 200 ms do 15 s, bo transakcja z logu `processed` nie jest od razu czytelna. Po limicie zdarzenie `transaction-unavailable`;
    - najpierw instrukcje launchpadów z IDL: pump.fun `create` i `create_v2` (mint na koncie 0), DBC `initialize_virtual_pool_*` (konto 3), LaunchLab `initialize*` (konto 6), także instrukcje wewnętrzne;
    - potem ścieżka ogólna: `InitializeMint` (0) i `InitializeMint2` (20) programów Token i Token-2022, mint na koncie 0;
    - obserwowany adres musi podpisać transakcję; transakcja z `meta.err` nic nie wykrywa; WSOL, USDC i USDT nigdy nie są nowym mintem.
  - **Każda sygnatura przechodzi wolną ścieżkę**, także po szybkiej. Wolna ścieżka wykrywa to, czego log nie pokaże (DBC, LaunchLab, ścieżka ogólna, nadrabianie przerwy, ucięty log), i sprawdza szybką. Niezgodność to ostrzeżenie (`verified` z `match: false`), nie zatrzymanie, bo zakup już ruszył.
  - **Jeden mint raz na uzbrojenie**, niezależnie od tego, która ścieżka zobaczy go pierwsza.
  - **Fixtures:** oczekiwany mint to token z `postTokenBalances`, którego nie było w `preTokenBalances`, a nie wynik detektora. Przypadek „nie podpisujący” to prawdziwe tworzenie sprawdzane z obserwowanym adresem, który nie podpisał. W fixtures nie ma `api-key` (test to sprawdza).
- Testy: dodatnie i ujemne przypadki wolnej ścieżki na prawdziwych transakcjach (pump.fun, DBC, LaunchLab v1, oba `InitializeMint`, kupno, nieudane tworzenie, nie podpisujący), szybka ścieżka na trzech prawdziwych `logsNotification`, podrobione `Program data:` spod innego programu, detektor z fałszywym zegarem (szybka ścieżka przed RPC, transakcja dostępna po kilku próbach, limit 15 s, deduplikacja logu i nadrabiania, ostrzeżenie o niezgodności).

## D-038: Tryb B: uzbrojenie, wykrycie, automatyczny zakup i czas reakcji

- Data: 2026-10-03
- Zadanie: BUNNDLY-34. Łączy D-036 (strumień), D-037 (detektory) i executor (D-029, D-035).
- Decyzja:
  - **Moduł `src/watcher/watch.ts`** (`startWatch`): czysta logika jednego uzbrojenia ze wstrzykniętymi zależnościami (gniazdo, odczyty RPC, zegar, `startBuy`). W workerze żądania `arm { creator }` i `disarm`, a status sejfu ma pole `watch`: twórca, czas uzbrojenia, tryb, czy uzbrojony, stan połączenia, ostatnia wiadomość, wykrycia i kolejka. Pole zostaje po rozbrojeniu (ostatnie uzbrojenie tej sesji) i znika przy blokadzie.
  - **Walidacja `arm`** (każdy błąd ma polski komunikat):
    - twórca to base58 dekodowany do 32 bajtów i różny od mintu SOL, inaczej `INVALID_CREATOR_ADDRESS`;
    - potrzebny jest URL WebSocket (klucz Helius albo własny `heliusWsUrl`) i URL HTTP, bo `getTransaction` i odczyt sald idą przez RPC; bez nich `HELIUS_KEY_MISSING` (komunikat obejmuje teraz salda, zakup na żywo i obserwację);
    - te same kontrole portfeli co zakup (`NO_WALLETS_TO_BUY`, a na żywo także RPC);
    - w trakcie zakupu `BUY_RUNNING`, a przy już uzbrojonym watcherze `WATCH_ARMED`.
  - **Salda przed uzbrojeniem:** `arm` najpierw czyta salda floty (jedno `getMultipleAccounts` na 100 portfeli) i dopiero potem otwiera gniazdo; błąd odczytu kończy `arm` kodem `RPC_UNAVAILABLE`. Potem odczyt idzie co 30 s, a jego błędy są pomijane (zostaje ostatni odczyt). Powód: executor bez znanego salda pomija portfel (`BALANCE_UNKNOWN`), więc wykrycie w pierwszej sekundzie po uzbrojeniu nic by nie kupiło. Wyszło to w teście z RPC odpowiadającym po 1 s.
  - **Wykrycie → zakup:**
    - ten sam `startBuy` co w trybie A (DRY-RUN, limitery, bramka świeżego mintu), wywołany synchronicznie z obsługi wiadomości gniazda, bez żadnego `await` na sieć przed pierwszym `/order`;
    - szybka ścieżka nie czeka na weryfikację, a wolna (`getTransaction`) startuje zakup od razu po swoim wykryciu;
    - Jupiter nie dostaje zapytań, dopóki nie ma wykrycia;
    - czasy w widoku postępu liczą się od wykrycia: `RunOptions.triggeredAt`, a `sinceStartMs` mierzy od niego.
  - **Ochrona przed starym tokenem** (druga warstwa po granicy czasu w nadrabianiu z D-036, review PR #26):
    - wykrycie z transakcji, której `blockTime` jest wcześniejszy niż uzbrojenie − 60 s, nigdy nie uruchamia zakupu;
    - trafia do dziennika jako `stale` (zdarzenie `stale`, `problem: STALE`, komunikat po polsku) i nie rozbraja trybu `one-shot`, bo to nie jest nowy token;
    - dotyczy ścieżek `transaction` i `catch-up`. Log z szybkiej ścieżki przychodzi na żywo po uzbrojeniu, więc jest nowy z definicji;
    - `blockTime` z `getTransaction` przechodzi w wykryciu (`Detection.blockTime`), a brak `blockTime` liczy się jak nowa transakcja.
  - **Zegar strumienia to czas Unix w ms** (`Date.now()`, uwaga z review PR #26): granica nadrabiania i kontrola `stale` porównują `clock.now()` z `blockTime × 1000`. `performance.now()` zaczyna się blisko 0, więc przepuściłby wszystko. `startStream` i `startWatch` odrzucają zegar wskazujący czas sprzed 2020 (`assertUnixMsClock`), a `arm` kończy się wtedy błędem zamiast cichego przepuszczania. Czas reakcji mierzy osobny `perfNow` (`performance.now()`).
  - **Czytniki RPC** (`src/chain/watch-rpc.ts`): `getTransaction` z `encoding: "json"`, `commitment: "confirmed"`, `maxSupportedTransactionVersion: 1`; `getSignaturesForAddress` z `confirmed`, `until` i `before`, z `blockTime` w wyniku. Test sprawdza dokładne parametry.
  - **Kolejka:** wykrycie w trakcie zakupu (z trybu A albo B) czeka w kolejce FIFO, jeden wpis na mint (detektor i tak wykrywa mint raz na uzbrojenie), i startuje, gdy bieżący przebieg się skończy. STOP zatrzymuje tylko bieżący zakup: watcher zostaje uzbrojony, a kolejka rusza po jego końcu. `disarm` zamyka gniazdo, kończy odpytywanie `getTransaction` i opróżnia kolejkę (wpisy dostają `problem: DISARMED`).
  - **Tryby** (`mode` czytany przy uzbrojeniu; zmiana ustawień działa od następnego `arm`):
    - `one-shot`: pierwsze wykrycie rozbraja watcher i zamyka gniazdo, a zakup trwa. Wolna ścieżka tej sygnatury kończy jeszcze weryfikację, ale nowych wykryć już nie ma;
    - `continuous`: watcher zostaje uzbrojony.
  - **Blokada:** uzbrojony watcher albo wykrycie w kolejce wyłącza auto-lock. `lock`, `create` i `unlock` dostają `WATCH_ARMED` z prośbą o rozbrojenie.
  - **`reactionMs`:**
    - liczony od `receivedAt` logu (`performance.now()` w workerze, D-036) do wywołania `getOrder` pierwszego `/order` przebiegu;
    - pomiar robi cienka nakładka na klienta Jupitera, wołana zaraz po wysłaniu zapytania;
    - zdarzenie `detection` wychodzi właśnie wtedy i niesie `reactionMs` i `runId`, a status i dziennik mają tę samą wartość;
    - wykrycie, które czeka w kolejce, dostaje osobne zdarzenie `queued`, a jego `reactionMs` obejmuje czekanie;
    - gdy zakup nie wysłał żadnego `/order` (STOP od razu, błąd startu), `detection` ma `reactionMs: null` i ewentualny kod błędu.
  - **Zdarzenia i dziennik:**
    - worker wysyła zdarzenia `kind: "watch"`: `armed`, `disarmed` (`user` albo `one-shot`), `connection`, `queued`, `detection`, `stale`, `verified`;
    - dziennik operacji ma kolumny `mint`, `source`, `path`, `reactionMs`, a `runId` jest pusty dla wpisów bez zakupu;
    - niezgodność weryfikacji to wpis z ostrzeżeniem;
    - bez kluczy i URL-i (test sprawdza zdarzenia i status).
  - **Poprawka przy okazji:** klient workera przekazywał do UI tylko zdarzenia `wallet` i `run`, więc zdarzenia `verify` z BUNNDLY-25 (potwierdzenie saldem) nie docierały do UI. Ta sama linia przepuszcza teraz `verify` i `watch`.
- Testy:
  - kontroler na prawdziwych logach i transakcjach pump.fun: transakcja sprzed uzbrojenia z nadrabiania (`stale`, 0 zakupów, one-shot dalej uzbrojony) i z ostatnich 60 s (zakup), one-shot, czekanie za zakupem trybu A, continuous z kolejką i deduplikacją, `disarm`, błąd startu, zakup bez `/order`, salda co 30 s, brak klucza w zdarzeniach;
  - worker z prawdziwym sejfem, fałszywym gniazdem i RPC odpowiadającym po 1 s:
    - pierwsze `/order` dla właściwego mintu w tej samej chwili co log;
    - `reactionMs` w zdarzeniu, statusie i dzienniku;
    - prawdziwy zegar: poniżej 50 ms;
    - transakcja sprzed uzbrojenia: wpis `stale` w dzienniku, 0 zakupów i 0 `/order`;
    - one-shot, continuous, STOP bez rozbrojenia, DRY-RUN bez `/execute`, auto-lock i `WATCH_ARMED`, walidacja.

## D-039: UI trybu B: uzbrojenie, stan połączenia, alarm i Wake Lock

- Data: 2026-10-03
- Zadanie: BUNNDLY-35. Uzupełnia D-032 (UI trybu A) i D-038 (tryb B w workerze).
- Decyzja:
  - **Jeden panel zakupu z przełącznikiem** „Tryb A: mint” i „Tryb B: obserwacja twórcy”. Wspólne są etykieta DRY-RUN/NA ŻYWO, przejście na tryb na żywo, podsumowanie, STOP, postęp i dziennik. Zakładka B otwiera się sama, gdy watcher jest uzbrojony.
  - **Tryb B (`WatchPanel`):**
    - pole adresu twórcy (base58, 32 bajty, inny niż mint SOL) i ostrzeżenie, gdy to adres z floty;
    - wybór jednorazowy/ciągły jako ustawienie `mode`, zapisywany w sejfie jak przełącznik DRY-RUN. Tryb ciągły wymaga potwierdzenia (SPEC 3.3), a przy uzbrojonym watcherze wybór jest zablokowany, bo worker czyta `mode` przy `arm`;
    - przycisk UZBRÓJ podaje, czego brakuje: zapisanej tabeli, klucza Helius (URL WS i HTTP), gotowego portfela, poprawnego adresu albo końca trwającego zakupu;
    - w trybie na żywo uzbrojenie wymaga dialogu `role="alertdialog"` z kwotą i liczbą portfeli, a „Anuluj” nic nie wysyła. W DRY-RUN nie ma dialogu.
  - **Stan z workera:** UI czyta `status.watch` (D-038). Każde zdarzenie `watch` (zmiana połączenia, wykrycie, weryfikacja) od razu odświeża status, więc baner i lista nie czekają na odpytywanie co 5 s. Czas ostatniej wiadomości pochodzi teraz z gniazda na bieżąco (`Stream.lastMessageAt()`), także z odpowiedzi na podtrzymanie.
  - **Uzbrojony watcher zamraża ustawienia** (review PR #28): automatyczny zakup idzie z tym, co użytkownik potwierdził przy uzbrojeniu. Worker odrzuca `saveSettings` i `addWallets` kodem `WATCH_ARMED`, dopóki watcher jest aktywny (uzbrojony albo z wykryciem w kolejce). UI w tym czasie zamiast przełącznika DRY-RUN/na żywo pokazuje „Rozbrój watcher, żeby zmienić tryb lub ustawienia.”, a „Zapisz zmiany w tabeli”, „Dodaj portfele” i „Zapisz ustawienia” są nieaktywne z tym samym powodem. Bez tego dało się uzbroić w DRY-RUN, potem przełączyć na tryb na żywo i kupić bez potwierdzenia trybu B. Blokadę w workerze złagodziło D-046 (BUNNDLY-68).
  - **`WatchGuard` w `App`, na każdym ekranie:**
    - utrata połączenia przy uzbrojonym watcherze (`reconnecting` albo `disconnected`) daje czerwony baner `role="alert"` i dźwięk co 3 s. Baner jest przyklejony do góry ekranu (`position: sticky`), więc widać go także po przewinięciu do ROZBRÓJ (review PR #28);
    - dźwięk milknie po powrocie połączenia albo po „Wycisz”, a następna utrata znowu dzwoni;
    - przy uzbrojonym watcherze zamknięcie karty pyta przeglądarkę (`beforeunload`).
  - **Dźwięk:** Web Audio, oscylator 880 Hz przez 0,4 s, bez plików i zasobów zewnętrznych (CSP bez zmian). `AudioContext` powstaje przy kliknięciu UZBRÓJ (polityka autoplay). Błąd urządzenia audio nie psuje strony: zostaje baner.
  - **Wake Lock:**
    - `navigator.wakeLock.request("screen")` przy uzbrojeniu;
    - ponowne żądanie po `visibilitychange`, bo przeglądarka zwalnia blokadę przy ukryciu karty;
    - zwolnienie po rozbrojeniu;
    - brak API albo odmowa to stan, nie błąd: panel dopisuje „Ekran może zgasnąć”. `screen-wake-lock=(self)` już jest w `_headers` (D-025);
    - Web Audio i Wake Lock są wstrzykiwane do `App` (`watchBrowser`), więc testy używają mocków.
  - **Lista wykryć:**
    - kolumny: czas, skrócony mint z kopiowaniem, źródło, ścieżka (log, transakcja, nadrabianie), `reactionMs`, weryfikacja i wynik;
    - wynik to: `zakup #n`, „w kolejce”, „transakcja sprzed uzbrojenia, bez zakupu” albo komunikat błędu.
  - **Postęp:** zakup z wykrycia używa tego samego widoku. Gdy przebieg należy do wykrycia, opis czasu brzmi „Od wykrycia…”, bo worker liczy czasy od wykrycia (D-038).
  - **Weryfikacja w Chromium:**
    - `page.routeWebSocket` nie przechwytuje gniazda otwartego w Web Workerze, bo Playwright podmienia `WebSocket` tylko w stronie. Sprawdziłem to osobną próbą;
    - zamiast tego test uruchamia lokalny serwer WSS, a Chromium kieruje na niego prawdziwą nazwę `mainnet.helius-rpc.com` (`--host-resolver-rules`, certyfikat testowy). Aplikacja łączy się więc z tym samym URL-em i pod tym samym CSP;
    - zapytania HTTP (RPC, Jupiter) podstawia `context.route`, jak w BUNNDLY-27.

## D-040: Końce linii LF wymuszone przez `.gitattributes`

- Data: 2026-10-11
- Zadanie: BUNNDLY-39
- Kontekst: Na Windows z `core.autocrlf=true` (ustawienie systemowe gita) pliki w drzewie roboczym mają końce CRLF. Prettier oczekuje LF, więc `npm run format:check` padał na każdym pliku, także w świeżym klonie i w worktree odbioru. Sprawdzone 2026-10-11: `prettier --check README.md src/main.tsx package.json` daje 3 ostrzeżenia przy `i/lf w/crlf`.
- Decyzja: `.gitattributes` z `* text=auto eol=lf`. Każdy klon i każdy worktree dostaje LF niezależnie od ustawień maszyny. W indeksie pliki już były w LF, więc treść commitów się nie zmienia.
- Konsekwencje / alternatywy: Istniejące drzewo robocze trzeba raz odświeżyć (nowy worktree albo ponowny checkout). Odrzucone: `endOfLine: "auto"` w Prettierze (dopuszcza mieszane końce w repo) i lokalne `core.autocrlf=false` (działa tylko na jednej maszynie i tylko dopóki ktoś o nim pamięta).

## D-041: Sieć Mainnet / Devnet jako ustawienie floty

- Data: 2026-10-12
- Zadanie: BUNNDLY-44
- Źródła (odczyt 2026-10-12):
  - Helius, adresy: <https://www.helius.dev/docs/api-reference/endpoints>. Mainnet `https://mainnet.helius-rpc.com/?api-key=…` i `wss://mainnet.helius-rpc.com/?api-key=…`, devnet `https://devnet.helius-rpc.com/?api-key=…` i `wss://devnet.helius-rpc.com/?api-key=…`. Strona podaje oba adresy z tym samym parametrem klucza, ale nie mówi wprost, że jeden klucz działa na obu sieciach. **Niesprawdzone prawdziwym kluczem.**
  - Publiczny RPC: <https://solana.com/docs/references/clusters>. `https://api.mainnet.solana.com` i `https://api.devnet.solana.com`; devnet ma limit 100 zapytań na 10 s z jednego IP (40 na metodę).
  - Jupiter: indeks dokumentacji <https://developers.jup.ag/docs/llms.txt> nie wymienia devnetu dla Swap API. Odczyt Andy'ego z publicznego RPC devnetu: pod adresem programu Jupitera nie ma tam programu.
  - Orb: <https://www.helius.dev/docs/orb>. Adres `https://orbmarkets.io`, devnet przez `?cluster=devnet`.
  - Raydium LaunchLab na devnecie: `DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6` (tabela adresów programów w dokumentacji Raydium, ustalenie Andy'ego). pump.fun i Meteora DBC mają na devnecie ten sam identyfikator co na mainnecie.
- Decyzja:
  - **Jedno źródło prawdy:** `src/core/network.ts`. Adresy Helius, zapasowy publiczny RPC, linki eksploratorów, etykiety `Mainnet` / `Devnet` i droga zakupu są wybierane stamtąd. Żaden inny moduł w `src` nie zawiera hosta sieci (pilnuje tego test).
  - **Gdzie jest zapisana:** pole `network` w ustawieniach floty (`GlobalSettingsV1`, zaszyfrowana część pliku), domyślnie `mainnet`. Plik bez pola to `mainnet` bez komunikatu; nieznana wartość to `mainnet` z wpisem w `resetFields`, jak inne ustawienia spoza zakresu (D-019). Sieć należy więc do floty: flota testowa zostaje na devnecie, a prawdziwa na mainnecie, także na innym komputerze.
  - **Przełącznik:** żądanie `setNetwork` w workerze zmienia tylko to pole i zwraca nowy tekst pliku. Sieć działa od razu, a nagłówek pokazuje komunikat z przyciskiem zapisu pliku. Zablokowana flota pokazuje `Mainnet` z nieaktywnym przełącznikiem, bo wtedy aplikacja nie czyta niczego z sieci.
  - **Blokady:** worker odrzuca zmianę sieci kodem `BUY_RUNNING` w trakcie zakupu (także gdy przychodzi w `saveSettings`) i `WATCH_ARMED` przy aktywnym watcherze. UI sprawdza to samo przed wysłaniem i nie przełącza też wtedy, gdy ekran trzyma niezapisany plik floty, bo ten plik nie znałby nowej sieci.
  - **Salda:** odpowiedź `refreshBalances` niesie sieć, z której pochodzi. UI czyści salda w chwili przełączenia i odrzuca odpowiedź z innej sieci; worker nie przyjmuje takiej odpowiedzi jako sald do kontroli przed zakupem.
  - **Własne adresy Helius:** obowiązują tylko na sieci, na którą wskazuje host (`devnet.helius-rpc.com` to devnet, każdy inny host Helius to mainnet). Na drugiej sieci używany jest adres z klucza; bez klucza brak adresu (`HELIUS_KEY_MISSING`).
  - **Zakup na devnecie:** `buyRouteOf(network)` zwraca `'jupiter'` dla mainnetu i `null` dla devnetu. Bez drogi zakupu worker odrzuca `startBuy` i `arm` kodem `NO_BUY_ROUTE_ON_NETWORK`, test połączeń nie odpytuje Jupitera (`jupiter: null`), a UI wyłącza „Kupuj teraz” i UZBRÓJ z jednym zdaniem. Późniejszy zakup bezpośrednio przez launchpad to nowa wartość `BuyRoute` i jej obsługa w `startBuy`, bez zmian w przełączniku.
  - **Detektory:** `mintInstructions(network)` podstawia identyfikator LaunchLab z devnetu. Układ instrukcji i dyskryminatory na devnecie **nie są potwierdzone prawdziwą transakcją**; dopóki uzbrojenie jest tam wyłączone, ta ścieżka nie działa.
  - **Linki:** `transactionUrl` i `addressUrl` dodają `?cluster=devnet`. Orb dostał adres z dokumentacji (`orbmarkets.io` zamiast `orb.helius.dev`), także dla mainnetu. Parametru `?cluster=devnet` dla Solscan i Solana Explorer nie znalazłem w ich dokumentacji, więc sprawdziłem go w przeglądarce 2026-10-12 na prawdziwej transakcji z devnetu (sygnatura z `getSignaturesForAddress` publicznego RPC): Solscan pokazuje znacznik „DEVNET”, Solana Explorer „Devnet”, Orb „You are currently looking at devnet”.
  - **Dziennik:** każdy wpis ma `network` (ostatnia kolumna CSV, żeby nie przesuwać dotychczasowych); wpis bez sieci czyta się jako `mainnet`.
  - **CSP:** dopisany tylko `https://api.devnet.solana.com`. Hosty Helius devnetu mieszczą się w `*.helius-rpc.com`.
- Konsekwencje / alternatywy:
  - Każde przełączenie tworzy nowy plik floty do zapisania. Odrzucone: `localStorage` (lint celowo blokuje to API w `src`, a wybór byłby wspólny dla wszystkich flot w przeglądarce) i sieć trzymana tylko w pamięci sesji (nie byłaby zapamiętana).
  - Starsza wersja aplikacji nie otworzy pliku z polem `network` (nieznany klucz ustawień), tak samo jak przy `dryRun`.
  - USDC ma na devnecie inny mint (znany mi adres `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, niesprawdzony w dokumentacji Circle ani w łańcuchu), a lista `KNOWN_MINTS` w detektorach zawiera minty z mainnetu. Dotyczy BUNNDLY-43.

## D-042: Interfejs wyłącznie po angielsku; format liczb i nazwa pliku eksportu

- Data: 2026-10-12
- Zadanie: BUNNDLY-50
- Kontekst: Decyzja Krystiana z 12.10.2026: interfejs wyłącznie po angielsku, bez wyboru języka (SPEC sekcja 5). Zadanie wymaga liczb i dat w formacie angielskim. Kilka zmian wykracza przez to poza sam tekst na ekranie.
- Decyzja:
  - **Teksty:** zwykłe napisy w kodzie, bez biblioteki i18n i bez ustawienia języka. Jeden termin ma jedno słowo w całej aplikacji; słownik jest w opisie PR. Test `tests/ui/english-only.test.ts` skanuje `src` poza komentarzami i `index.html`.
  - **Liczby:** kwoty SOL i tokenów, czasy i limity są pokazywane z kropką dziesiętną, bez separatora tysięcy. Pola kwot i procentów nadal przyjmują kropkę i przecinek (parsowanie bez zmian), więc dotychczasowy nawyk wpisywania `0,5` działa.
  - **Godziny:** `toLocaleTimeString('en-GB')`, czyli format 24 h, jak dotąd.
  - **Eksport dziennika:** pole `price` w CSV i JSON ma teraz kropkę (`0.00012` zamiast `0,00012`), bo ta sama funkcja formatuje cenę w tabeli. Kwoty w lamportach i jednostkach bazowych były i są liczbami całkowitymi. Nazwy kolumn bez zmian.
  - **Eksport jawny:** plik nazywa się `<flota>.PLAIN-EXPORT.txt` albo `.json` (było `.EKSPORT-JAWNY`); etykiety w pliku tekstowym są po angielsku, klucze JSON bez zmian. Ten wpis zastępuje nazwę pliku podaną w starszym wpisie o eksporcie jawnym.
  - **Bez zmian:** kody błędów, pola formatu pliku floty, nazwy kolumn dziennika, zachowanie i układ ekranów.
- Konsekwencje / alternatywy:
  - Arkusz albo skrypt, który czytał `price` z przecinkiem, trzeba dostosować. Odrzucone: osobny formater ceny dla eksportu (dwa formaty tej samej liczby w jednej aplikacji).
  - Test „kreator nie pokazuje mnemonika” sprawdza teraz, że na stronie nie ma żadnych trzech kolejnych słów mnemonika. Poprzednia wersja sprawdzała pojedyncze słowa, a angielski interfejs zawiera słowa z listy BIP39 (np. „cloud”, „wallet”), więc dawała fałszywy alarm.
  - Dokumenty w `docs/`, `PROGRESS.md` i komentarze w Plane zostają po polsku (`CLAUDE.md`).

## D-043: System wizualny: tokeny, Geist z własnej domeny, własne komponenty i ikony

- Data: 2026-10-13
- Zadanie: BUNNDLY-54
- Kontekst: Interfejs miał jeden arkusz `app.css` z kolorami wpisanymi w regułach i surowe `<button>` / `<input>` na ekranach. Makieta v2 (`fleet-dashboard.html`, poza repo) wymaga spójnego systemu, a CSP (`style-src 'self'`, brak `font-src`, czyli `default-src 'self'`) nie pozwala na zewnętrzne arkusze ani czcionki.
- Decyzja:
  - **Tokeny:** `src/ui/tokens.css` jest jedynym plikiem w `src/ui` z literałami kolorów. Pilnuje tego test (`tests/ui/tokens.test.ts`), który liczy też kontrast WCAG 2.x każdej pary tekst / tło z wartości tokenów (własny wzór w teście, próg 4,5:1; obrys fokusu 3:1). Kod QR ma osobne tokeny `--qr-paper` / `--qr-ink`, bo czyta go aparat: zawsze czarny na białym.
  - **Czcionka:** Geist (zmienna, 100–900, podzbiór latin), licencja SIL OFL 1.1. Plik `src/ui/fonts/geist-latin-wght.woff2` (29 400 B) pochodzi z paczki npm `@fontsource-variable/geist@5.3.0` i leży w repo razem z `OFL.txt`; paczka **nie** jest zależnością projektu, więc lockfile się nie zmienia. Jeden krój wszędzie, także dla adresów i liczb (`tabular-nums`); kroju mono nie ma. Podzbiór latin wystarcza, bo interfejs jest po angielsku (D-042); znak spoza podzbioru bierze czcionkę systemową z listy zapasowej.
  - **Komponenty:** własny zestaw w `src/ui/kit/` (Button, IconButton, Chip, Input, NumberInput, Segmented, Checkbox, Popover, Modal, Toast, Tooltip, ProgressBar, Skeleton, Avatar) bez biblioteki UI. `IconButton` wymaga `label` w typie, więc przycisk z samą ikoną bez nazwy nie przechodzi `typecheck`. Avatar portfela jest liczony z adresu (siatka 5×5 odbita lustrzanie), bez sieci.
  - **Ikony:** własne SVG w `src/ui/kit/icons.tsx` (siatka 16 px, kreska 1,6 px, `currentColor`), bez paczki ikon.
  - **Powłoka:** górny pasek, przewijana treść i dolny pasek stanu w jednej ramce. Trzy potwierdzenia (tryb na żywo, tryb ciągły, uzbrojenie na żywo) są prawdziwymi oknami modalnymi (`role="alertdialog"`, pułapka Tab, Esc, powrót fokusu do przycisku, który je otworzył). Eksport jawny zostaje dialogiem w treści strony, tak jak dotąd, ale dostaje fokus po otwarciu. Escape zamyka każdy z tych dialogów i kod QR w tabeli, a fokus wraca do przycisku, który je otworzył; Escape działa jak „Cancel”, więc nie zamyka eksportu w trakcie sprawdzania hasła.
  - **Pasek stanu mówi tylko to, co zmierzono:** źródło i czas ostatniego odczytu sald. Czas liczy UI od wysłania żądania do workera do odpowiedzi (worker nie mierzy czasu RPC; bez zmian w protokole). Odpowiedź z publicznego RPC jest nazwana „Fallback RPC (public)”, nigdy „Helius”. Odczyt z innej sieci albo sprzed zablokowania floty nie jest pokazywany.
  - **Wersja:** `__APP_VERSION__` z `package.json` wstawiane przy buildzie (`vite.config.ts`, `define`); dziś `0.0.0`.
  - **Ruch:** przy `prefers-reduced-motion: reduce` wszystkie animacje i przejścia są wyłączone jedną regułą w `kit.css`.
- Konsekwencje / alternatywy:
  - Rozmiar `dist` (gzip -9, względem stanu przed zadaniem): JS 104 491 → 107 117 B, CSS 2 002 → 4 933 B, czcionka 29 400 B (limit z zadania: 150 kB). Worker bez zmian.
  - Odrzucone: `@fontsource-variable/geist` jako zależność (nowa paczka w lockfile dla jednego pliku), Google Fonts (zewnętrzny host, wbrew CSP i SPEC 6.4), biblioteka komponentów albo ikon (rozmiar, style wstrzykiwane w czasie działania kłócą się z `style-src 'self'`).
  - Układ ekranu floty z makiety v2 (pasek celu, zakładki filtrów, pasek poleceń, kolumny tabeli) to BUNNDLY-55; tu ekrany dostały tylko nowe komponenty i tokeny.
  - Nagłówek tabeli portfeli nie jest jeszcze przyklejony przy przewijaniu strony (tabela przewija się w poziomie we własnym kontenerze); do rozwiązania razem z układem w BUNNDLY-55.

## D-044: Sprzedaż tokenu flotą przez Jupitera

- Data: 2026-10-13
- Zadanie: BUNNDLY-60
- Źródła (odczyt 2026-10-13):
  - <https://developers.jup.ag/docs/swap/order-and-execute.md> i <https://developers.jup.ag/docs/openapi-spec/swap/v2/swap.yaml>. `/order` wymaga `inputMint`, `outputMint` i `amount` („The amount to swap in the smallest unit of the input token”); `taker` daje transakcję. Sprzedaż to te same parametry z tokenem jako `inputMint` i mintem SOL jako `outputMint`. `swapMode` ma tylko `ExactIn`.
  - `/execute`: `totalInputAmount` to „Total input token amount deducted from the user's wallet, including the fee if feeMint is the input mint”, `totalOutputAmount` to „Final output token amount reflected in the user's wallet, after any fee collected in the output mint”. Opłata w mincie wejściowym = `totalInputAmount` − `inputAmountResult`.
  - Prawdziwa wycena z mainnetu (Keyless, bez `taker`, 2026-10-13 09:27 UTC, HTTP 200): 1 USDC → 9 333 744 lamportów, `feeMint` = mint SOL, router `jupiterz`; nagłówki `x-ratelimit-remaining: 19`, `x-ratelimit-current: 1`. Zapisana w `tests/fixtures/jupiter-order-sell.mainnet.json`.
  - **Czego dokumentacja nie mówi:** w jakiej postaci SOL ze sprzedaży trafia do portfela, gdy nie ma parametru `receiver` (natywny czy opakowany) i czy zostaje konto do zamknięcia. Jedyne zdanie o tym stoi przy `receiver` („For SOL output: native SOL is transferred directly to the receiver”); `wrapAndUnwrapSol` istnieje tylko w `/build`. O opłacie transferowej Token-2022 nie ma osobnego zdania. **Niesprawdzone prawdziwą transakcją** (wymaga portfela z tokenem; smoke test Krystiana).
- Decyzja:
  - **Jeden executor, dwie strony.** `RunOptions.side` (`buy` domyślnie, `sell`). Kolejka, limiter, bramka mintu, ponowienia, kontrola łańcucha po `UNKNOWN`, STOP i DRY-RUN są wspólne. Sprzedaż różni się w trzech miejscach: zapytanie ma odwrócone minty; portfel z planem 0 jest pomijany przed jakimkolwiek zapytaniem (`SKIPPED: NO_TOKENS`); nie ma sufitu ceny ani jego odpowiednika (decyzja tymczasowa z zadania: przed złym kursem chroni slippage Jupitera).
  - **Kupno bez zmian w zapytaniach.** `OrderRequest.inputMint` jest opcjonalny; bez niego adres `/order` jest znak w znak taki jak przed zmianą (test porównuje cały adres).
  - **Plan sprzedaży:** `floor(saldo × procent / 100)` na surowych jednostkach (`src/executor/sell-plan.ts`). Saldo pochodzi z odczytu wykonanego w `startSell`, tylko dla wskazanych portfeli; późniejsze zmiany salda nie zmieniają planu. Każde zlecenie portfela, także ponowione, prosi o dokładnie tę ilość, a ponowienie następuje dopiero, gdy łańcuch pokaże, że poprzednia transakcja nie weszła i już nie wejdzie. Stąd portfel nie sprzeda w jednym przebiegu więcej niż plan.
  - **Plan trzyma sejf, nie executor.** `signOrder` podpisuje zlecenie sprzedaży tylko wtedy, gdy trwa sprzedaż tego mintu, mint wyjściowy to SOL, a `inAmount` nie przekracza planu portfela (`NO_SELL_PLAN`, `OVER_MAX_SPEND`). To odpowiednik max spend przy kupnie: niezależny od tego, o co poprosił executor.
  - **Żądanie `startSell`:** `mint`, `wallets` (indeksy, każdy raz) i opcjonalny `percent` (liczba całkowita 1–100, domyślnie 100). **Decyzja tymczasowa:** procent w żądaniu, dopóki BUNNDLY-58 nie da ustawienia na portfel. Lista portfeli jest brana dosłownie: `active` i max spend dotyczą kupna i sprzedaży nie ograniczają. Sprzedaż potrzebuje odczytu sald także w DRY-RUN (`HELIUS_KEY_MISSING` bez klucza). W trakcie sprzedaży nie rusza kupno ani druga sprzedaż (`BUY_RUNNING`); przy uzbrojonym watcherze sprzedaż jest odrzucana (`WATCH_ARMED`), bo wykrycie startuje kupno bez pytania.
  - **Opłata w SOL:** bez własnej kontroli przed zleceniem. Jupiter może sponsorować opłatę (w wycenie z mainnetu `gasless: true`), więc próg liczony lokalnie odrzucałby portfele, które mogą sprzedać. Portfel bez SOL na opłatę kończy jako `SKIPPED: INSUFFICIENT_SOL_FOR_GAS` na podstawie kodu z `/order`.
  - **Kontrola wyniku:** saldo tokenu musi spaść o `totalInputAmount`, a saldo SOL wzrosnąć względem odczytu ze startu przebiegu. Tylko „wzrosnąć”: dokładnej kwoty nie porównuję, bo dokumentacja nie mówi, jak SOL wraca, a opłaty i czynsz konta ją przesuwają. Oznaczenia te same co przy kupnie (`MATCH`, `INCREASED`, `MISMATCH`, `NO_INCREASE`, `UNVERIFIABLE`) z osobnymi komunikatami. Bez odczytu SOL wynik to `UNVERIFIABLE`, nigdy `MATCH`. Zdarzenie niesie `solChange`.
  - **Pole `side` w zdarzeniach i statusie występuje tylko przy sprzedaży** (decyzja tymczasowa). Zdarzenia kupna są takie same jak przed zmianą. Dziennik ma kolumnę `side` (`buy` / `sell`, pusta dla wpisów watchera) przed kolumną `network`; przy sprzedaży `spent` to sprzedane jednostki tokenu, `received` to lamporty, a cena dalej jest w SOL za cały token.
- Konsekwencje / alternatywy:
  - Odrzucone: osobny executor sprzedaży (kopiowałby kolejkę i ponowienia, czyli miejsce, gdzie powstają podwójne transakcje) i plan liczony w executorze bez kontroli w sejfie (błąd w executorze mógłby sprzedać więcej).
  - Nowe komunikaty (`NO_TOKENS`, `NO_WALLETS_TO_SELL`, komunikaty kontroli sprzedaży) są po angielsku, jak reszta interfejsu (D-042).
  - Kolumna `side` przesuwa `network` o jedną pozycję w CSV.
  - Sprzedaż drogą bezpośrednią (BUNNDLY-63) dojdzie jako kolejna droga, nie jako zmiana tego przebiegu.

## D-045: Parametry handlu na portfel (etap 1, silnik)

- Data: 2026-10-14
- Zadanie: BUNNDLY-58
- Źródła (odczyt 2026-10-14):
  - <https://developers.jup.ag/docs/openapi-spec/swap/v2/swap.yaml>, GET `/order`: `slippageBps` to liczba całkowita 0–10000; bez niej slippage dobiera Jupiter. Jest też `priorityFeeLamports` („Setting this overrides the automatic optimisation”) i `broadcastFeeType` (`maxCap` / `exactFee`).
  - <https://developers.jup.ag/docs/swap/order-and-execute.md>: nie wymienia `priorityFeeLamports`; macierz wpływu na routing nie obejmuje opłaty ani slippage, jest tylko zdanie, że parametry opcjonalne mogą zawęzić routery.
  - **Rozbieżność z zadaniem:** zadanie zakładało, że `/order` nie ma parametru opłaty priorytetowej. Specyfikacja OpenAPI go ma.
- Decyzja:
  - **Format:** w zaszyfrowanych ustawieniach floty dochodzi opcjonalne `trade` z `fleet` (wartości domyślne floty) i `wallets` (własne wartości portfeli). Brak pola we wpisie portfela oznacza wartość domyślną floty, `null` oznacza „Auto”. Opłaty zapisuję jako lamporty w tekście, slippage w punktach bazowych (10–10000, czyli 0,1–100%). Kwota kupna w SOL zostaje w `maxSpend`; procent salda to `buyPercent`. Oba naraz dla jednego portfela są niedozwolone.
  - **Zgodność:** plik bez `trade` czyta się jako wartości domyślne (brak domyślnej kwoty, sprzedaż 100%, wszędzie Auto). Domyślne `trade` nie jest zapisywane, więc taki plik otwiera się też w wersji sprzed zmiany. Wartości spoza zakresu w pliku są zastępowane domyślnymi i zgłaszane w `resetTradeFields`, jak w D-019. Kształt (klucze, indeksy portfeli) pozostaje ścisły. **Decyzja tymczasowa:** bez podbicia `KEYSTORE_VERSION`, tak jak przy `network` w D-041.
  - **Kwota procentowa:** `min(floor(saldo × p / 100), saldo − MIN_RESERVE)` z ostatniego odczytu salda w chwili startu (`src/executor/buy-plan.ts`). Kwota 0 daje `SKIPPED: INSUFFICIENT_SOL` bez zapytania.
  - **Sejf trzyma plan przebiegu po obu stronach:** przy podpisie kupna limitem jest kwota portfela zamrożona na starcie przebiegu, a nie bieżące ustawienia. W trakcie przebiegu `saveSettings`, który zmienia parametry portfela biorącego w nim udział (także przez wartość domyślną, z której portfel korzysta), kończy się `WALLET_IN_RUN` (**decyzja tymczasowa** co do kodu). Zmiany innych portfeli przechodzą.
  - **Slippage** trafia do `/order` jako `slippageBps` tylko wtedy, gdy nie jest Auto. Kupno bierze wartość kupna, sprzedaż wartość sprzedaży. Sprzedaż bez `percent` w żądaniu bierze część z ustawień portfela.
  - **Opłata priorytetowa** jest zapisywana i walidowana (1 lamport–0,1 SOL), ale na drodze Jupitera nie trafia do `/order`. **Decyzja tymczasowa** do czasu sprawdzenia na prawdziwym API, czy ustawiona opłata zmienia router albo wyłącza darmowy gas.
  - `saveSettings` bez `trade` zostawia zapisane parametry handlu. Dzięki temu ekrany, które ich nie znają, niczego nie kasują.
- Konsekwencje / alternatywy:
  - Odrzucone: kwota w SOL przeniesiona z `maxSpend` do `trade`. Wymagałoby to migracji, a pliki sprzed zmiany kupowałyby inaczej niż dotąd.
  - Etap 2 (pola w tabeli, „Set for selected”, ustawienia domyślne na ekranie) korzysta z tych pól bez zmiany formatu.

## D-046: Grupy portfeli w silniku

- Data: 2026-10-14
- Zadanie: BUNNDLY-68
- Decyzja:
  - **Format:** w zaszyfrowanych ustawieniach floty dochodzi opcjonalne `groups`, lista `{ id, name, wallets }`. `id` nadaje aplikacja (`g1`, `g2`, …, bez ponownego użycia). Nazwa ma 1–32 znaki, nie ma spacji na końcach i nie powtarza się bez względu na wielkość liter. Każdy portfel jest w dokładnie jednej grupie. Grupa może być pusta. Grup jest najwyżej 64. Zasady siedzą w `src/core/groups.ts`, wspólnym dla formularza i sejfu (D-019).
  - **Zgodność:** pusta lista oznacza jedną grupę `g1` „All wallets” ze wszystkimi portfelami i nie jest zapisywana, więc plik otwiera się też w wersji sprzed zmiany. Złamana zasada w pliku (portfel w dwóch grupach albo w żadnej, powtórzona nazwa) przywraca tę jedną grupę i zgłasza to w `resetGroups`. Kształt pozostaje ścisły. **Decyzja tymczasowa:** bez podbicia `KEYSTORE_VERSION`, jak w D-045.
  - **Sejf:** przebieg kupna albo sprzedaży, jego plan podpisu i watcher należą do grupy. `startBuy`, `startSell`, `arm`, `disarm` i `stop` niosą `group`. Przy jednej grupie pole można pominąć; przy kilku jego brak albo nieznana grupa to `INTERNAL_ERROR`, bo to błąd interfejsu. Sprzedaż przyjmuje tylko portfele swojej grupy. Podpis bierze plan przebiegu grupy, do której należy portfel. Limitery Jupitera są wspólne dla całej aplikacji (SPEC 2.2). Automatyczna blokada, `lock`, `unlock` i `create` czekają, aż żadna grupa nie działa.
  - **Skład grupy, która działa** (kupuje, sprzedaje albo ma uzbrojony watcher), się nie zmienia: `saveSettings` albo `addWallets`, które by go zmieniły, kończą się `GROUP_RUNNING`. Zmiana nazwy przechodzi. Nowe portfele trafiają do pierwszej grupy na liście.
  - **Skład grup zmienia `saveSettings`** z opcjonalnym `groups` (bez pola skład zostaje). Nie ma osobnych żądań tworzenia, zmiany nazwy, usuwania i przenoszenia; sejf waliduje całość naraz (Andy, 14.10).
  - **Status:** `groups` z `{ id, armed, buy, watch }` dla każdej grupy. Pola `buy` i `watch` sprzed zmiany pokazują pierwszy trwający przebieg i pierwsze uzbrojenie, dopóki interfejs (BUNNDLY-69) nie przejdzie na `groups`.
  - **D-039 złagodzone (Andy, 14.10):** uzbrojony watcher blokuje tylko to, od czego zależy jego kupno.
    - Ustawienia globalne poza eksploratorem i czasem automatycznej blokady, klucze API i `setNetwork` kończą się `WATCH_ARMED`.
    - Kwota, aktywność i parametry handlu portfeli uzbrojonej grupy, także wartość domyślna floty, którą biorą, kończą się `WALLET_IN_RUN`, tak jak portfele trwającego przebiegu (D-045).
    - Portfele pozostałych grup można zmieniać.
    - `addWallets` przechodzi, gdy pierwsza grupa nie działa; w przeciwnym razie kończy się `GROUP_RUNNING` (na teraz, jak wyżej).
- Konsekwencje / alternatywy:
  - Odrzucone: osobne limitery na grupę (dwie grupy razem przekroczyłyby limit planu) i grupy zapisane poza zaszyfrowanym plikiem (nazwy grup zdradzałyby układ floty).
  - Nazwy i skład grup nie trafiają do zdarzeń ani do jawnej części pliku.

## D-047: Tabela portfeli w układzie makiety v2: etykiety „Wallet N”, zaznaczenie zamiast „Active”, zakładki filtrów, sortowanie

- Data: 2026-10-13, układ v2: 2026-10-14
- Zadanie: BUNNDLY-55 (zaczął Mark 13.10, dokończył Kamil 14.10 według komentarza Andy'ego „Zmiany po makiecie v2”)
- Kontekst: SPEC 11.1 i 11.2 oraz makieta v2 wymagają zwartej tabeli i nazw „Wallet 0, Wallet 1, …”. Dotychczasowa tabela miała do 17 kolumn tekstowych, pełny adres w komórce i etykiety `W01`, `W02`, ….
- Decyzja:
  - **Etykiety:** `defaultWalletLabel(index)` zwraca `Wallet <index>` (od 0). Etykieta jest zapisana w części jawnej pliku floty (`public.wallets[].label`), więc pliki sprzed zmiany pokazują swoje `W01`, …; aplikacja niczego nie przemianowuje. Flota, do której dodano portfele po zmianie, ma obok siebie stare i nowe nazwy (np. `W03`, `Wallet 3`). Format pliku, protokół workera i format ustawień bez zmian.
  - **Zaznaczenie = `active`:** pole wyboru w wierszu zastępuje kolumnę „Active” i zapisuje się tą samą drogą co dotąd (`saveSettings` po „Save table changes”, D-019: zapisywane są tylko portfele wyłączone). Pole w nagłówku ma trzy stany i działa na portfele, które tabela pokazuje po filtrze i wyszukiwaniu; kliknięcie w stanie pośrednim zaznacza wszystkie widoczne. Przyciski „Select all” / „Deselect all” z akcji zbiorczych zniknęły.
  - **Kolumny:** zaznaczenie, Wallet (avatar, nazwa, adres 4…4, kopiowanie, eksplorator), Balance (znak SOL i kwota; „—” przed pierwszym odczytem), Buy amount (pole max spend), Tokens (saldo pokazanego tokenu), Status, Last transaction (od 1500 px szerokości okna), narzędzia wiersza (kod QR). Wiersz ma 68 px. Kolumny rezerwy nie ma: za mała rezerwa jest opisana pod polem kwoty („Leaves X SOL; the minimum reserve is Y SOL.”).
  - **Kolumny z makiety v2 w innych zadaniach:** Fill i segmenty „Fleet fill” robi BUNNDLY-56, Priority fee i Slippage oraz „Edit selected” i akcję wiersza Edit robi BUNNDLY-71, akcje wiersza Buy i Sell robi BUNNDLY-59. Tabela nie ma pustych kolumn ani nieczynnych przycisków na zapas (decyzja tymczasowa, BUNNDLY-55 w Plane).
  - **Status bez zakupu** mówi, czego brakuje: „Not selected”, „No amount”, „No balance yet”, „Low reserve”, „Ready”. W trakcie i po zakupie chip pokazuje stan zakupu, a pod nim stoi ostatni komunikat portfela: wynik kontroli łańcucha („Chain: confirmed”, „Chain: different amount”, …) albo powód.
  - **Bez rozwijanego wiersza** (makieta v2). Podpis transakcji z linkiem i czas od startu są w „Last transaction”, pełny adres w Popoverze kodu QR. Liczba prób, wydany SOL i cena są tylko w dzienniku operacji (CSV/JSON); kupione tokeny wracają do wiersza z paskiem wypełnienia w BUNNDLY-56.
  - **Zakładki filtrów** z licznikami: All wallets, Selected, In flight (od czekania w przebiegu do wysłania oraz wysłana transakcja w trakcie kontroli łańcucha), Filled (kupione i potwierdzone saldem: MATCH albo INCREASED), Needs attention (nieudane, nieznany wynik, pominięte poza DRY-RUN, rozjazd z łańcuchem, za mała rezerwa). Znaczenia siedzą w jednym miejscu, `src/ui/wallet-filters.ts`, żeby pasek wypełnienia (BUNNDLY-56) korzystał z tych samych. Zakładki to przyciski z `aria-pressed` w grupie, a nie `tablist`, bo nie przełączają paneli.
  - **Wyszukiwarka** szuka w nazwie i w adresie, bez względu na wielkość liter.
  - **Sortowanie** po Wallet, Balance, Buy amount i Tokens: pierwsze kliknięcie kolumny wartości daje największe na górze, kolumny Wallet pierwszy portfel; drugie odwraca. Brak wartości (saldo nieodczytane, pusta kwota) zawsze na końcu; przy równych wartościach zostaje kolejność portfeli. Nagłówek ma `aria-sort`.
  - **Pasek podsumowania pod tabelą** (makieta v2): Selected („N of M”), Fleet balance, Planned buy, Tokens held, First and last fill (czas od startu ostatniego zakupu do pierwszego i ostatniego potwierdzenia).
  - **Kod QR** otwiera się w `Popover` (fokus wchodzi do środka, Escape zamyka i oddaje fokus przyciskowi, naciśnięcie poza nim zamyka). Zastępuje to obsługę Escape na poziomie dokumentu z D-043.
  - **Kopiowanie** potwierdza Toast „Address copied”; odmowa schowka zostaje błędem na ekranie (Toast znika sam, więc nie niesie błędów).
  - **Odnośniki** do eksploratora (adres i transakcja) są elementami `<a href>` (otwierają kartę), a nie przyciskami; pozostałe narzędzia wiersza są przyciskami. Każde ma w nazwie dostępnej nazwę portfela.
  - **„Create wallets”:** Popover obok zakładek filtrów z liczbą od 1 do wolnego miejsca (limit 100), pole puste na starcie. Poza zakresem przycisk „Create” jest wyłączony, a powód stoi przy polu. Gdy tworzyć nie wolno (uzbrojony watcher, niezapisane zmiany, pełna flota), wyłączony jest przycisk otwierający, a powód stoi obok niego.
  - **Przyklejony nagłówek bez własnego przewijania tabeli:** przy oknie od 1280 px tabela nie ma własnego kontenera przewijania; nagłówek przykleja się do przewijanej treści aplikacji, a Popover ostatniego wiersza nie jest przycinany. Poniżej 1280 px (poza zakresem, aplikacja jest tylko na PC) tabela przewija się w poziomie we własnym kontenerze.
  - **Krój o stałej szerokości dla adresów:** `--font-mono` to systemowy stos (`ui-monospace`, Cascadia Mono, Consolas), bez pliku czcionki. Zmienia to zdanie z D-043 „kroju mono nie ma”; Geist zostaje jedynym krojem ładowanym z domeny.
  - **Avatar** rysuje jedną ścieżkę zamiast kwadratu na komórkę: tabela 100 portfeli ma o ok. 1 200 węzłów DOM mniej.
- Konsekwencje / alternatywy:
  - Z ekranu znikają liczba prób, wydany SOL i cena portfela (pierwotny warunek zadania mówił, że nic nie znika; komentarz v2 przenosi pełną historię do dziennika). Dziennik da się dziś tylko pobrać. Do potwierdzenia przez Andy'ego (BUNNDLY-55 w Plane).
  - Wiersz jest cięższy niż dawny (ok. 40 węzłów DOM zamiast ok. 15). W przeglądarce bez znaczenia; w jsdom zapytania po roli na stronie ze 100 portfelami są wolne, więc testy „100 wallets” szukają wierszy zapytaniem DOM (BUNNDLY-65).
  - Filtr i wyszukiwanie nie renderują ponownie wierszy, które zostają na ekranie (`memo`, test z sondą przy 100 portfelach).
  - Odrzucone: własny kontener przewijania tabeli jak w makiecie (przycinałby Popover kodu QR w krótkiej tabeli albo wymagał pozycjonowania `fixed` liczonego w skrypcie), przemianowanie etykiet w istniejących plikach (zadanie tego zabrania), keystore jako plik fixture w repo (zasada „żadnych keystore w repo”; test buduje plik z etykietą `W03` zapisaną jawnie).

## D-048: Zakup i uzbrojenie na portfelach z żądania; worker sprawdza rodzaj celu

- Data: 2026-10-14
- Zadanie: BUNNDLY-59
- Kontekst: pasek komend działa na portfelach zaznaczonych w tabeli, także tych, których zaznaczenia jeszcze nie zapisano. Dotąd `startBuy` i `arm` brały portfele z zapisanego pola `active`. Pole celu przyjmuje mint albo portfel twórcy, a worker nie sprawdzał, co dostał.
- Decyzja:
  - `startBuy { mint, wallets?, group? }` i `arm { creator, wallets?, group? }`: `wallets` to indeksy portfeli, wszystkie z grupy żądania (D-046), tak jak w `startSell` (D-044). Z listą kupują portfele z listy, które mają kwotę kupna (D-045); zapisane `active` nie bierze w tym udziału i zostaje zapamiętanym zaznaczeniem tabeli (D-019, D-047). Bez listy kupują aktywne portfele grupy, jak przed zmianą. Pasek komend zawsze wysyła listę. Lista spoza grupy, z powtórzeniem albo nie-tablica to zniekształcone żądanie (`INTERNAL_ERROR`, jak inne). Pusta lista albo brak portfela z kwotą: `NO_WALLETS_TO_BUY`.
  - `arm` zamraża listę do rozbrojenia, tak jak ustawienia (D-039). Każde wykrycie w tej grupie kupuje tą listą.
  - Nowe żądanie `classifyTarget { address }` jednym odczytem `getMultipleAccounts` zwraca `mint` (z programem: SPL Token albo Token-2022) albo `wallet`. Portfel to konto System Program bez danych albo adres bez konta. Konto tokenowe, program wykonywalny i każde inne konto dają błąd z nazwą: `TARGET_IS_TOKEN_ACCOUNT`, `TARGET_IS_PROGRAM`, `TARGET_UNSUPPORTED`. Zły tekst adresu: `INVALID_TARGET_ADDRESS`.
  - Ręczny `startBuy` i `arm` sprawdzają rodzaj celu tą samą funkcją. Zły rodzaj daje `TARGET_KIND_MISMATCH`, zanim cokolwiek pójdzie do Jupitera albo otworzy się gniazdo. Kupno wywołane przez detektor nie sprawdza celu: mint pochodzi z detekcji.
  - Wynik „mint” worker pamięta do zablokowania floty (mint nie zmienia rodzaju). Zakup po sprawdzeniu w pasku nie czyta więc konta drugi raz. Wynik „wallet” nie jest pamiętany, bo pod adresem bez konta może jeszcze powstać mint.
  - Odczyt idzie przez Helius, z publicznym RPC jako zapasem. Bez klucza Helius idzie przez publiczne RPC, bo DRY-RUN działa bez klucza.
- Konsekwencje / alternatywy:
  - Ręczny zakup ma o jedno zapytanie RPC więcej, gdy mintu nie sprawdzono wcześniej w pasku. Uzbrojenie ma zawsze jedno zapytanie więcej, przed odczytem sald.
  - Kwoty max spend dalej pochodzą z zapisanych ustawień. Dopóki kwoty w tabeli nie są zapisane, zakup i uzbrojenie są wyłączone. Zmiana samego zaznaczenia ich nie blokuje.
  - Odrzucone: rozpoznanie rodzaju tylko w UI (worker przyjąłby żądanie wysłane z pominięciem paska) i zgadywanie po długości danych bez sprawdzenia właściciela.

## D-049: Grupy portfeli w dashboardzie

- Data: 2026-10-14
- Zadanie: BUNNDLY-69
- Kontekst: silnik (D-046) uruchamia, zatrzymuje i uzbraja każdą grupę osobno, a dashboard pokazywał jedną flotę. Pasek komend (D-048) wysyłał żądania bez grupy, więc przy więcej niż jednej grupie worker je odrzucał.
- Decyzja:
  - Nad tabelą jest zakładka na grupę: nazwa, liczba portfeli, suma znanych sald SOL i stan z `status.groups`: Idle, Armed, Buying, Selling albo Stopped (przebieg po STOP, którego wysłane transakcje jeszcze się kończą). Zakładka **All** pokazuje wszystkie portfele z kolumną Group.
  - Pasek komend działa w wybranej zakładce. BUY, SELL i ARM wysyłają `group` i zaznaczone portfele tej grupy, a STOP i DISARM wysyłają tylko `group`. Okno potwierdzenia trybu na żywo podaje nazwę grupy. Każda zakładka pamięta własny tekst pola celu, a przełączenie zakładki nie wysyła żadnego żądania.
  - W **All** przy kilku grupach ARM, BUY, SELL i STOP są wyłączone z powodem „Pick a group tab”. Przy jednej grupie działają na nią. Przycisk ▶ w wierszu zawsze kupuje w grupie swojego portfela.
  - **Move to group** przenosi zaznaczone portfele widoczne w zakładce do istniejącej albo nowej grupy (nowa dostaje kolejny identyfikator). **Rename** zmienia nazwę pokazanej grupy. **Delete group** oddaje jej portfele pierwszej grupie, więc pierwszej grupy nie da się usunąć. Każda zmiana idzie przez `saveSettings.groups` i czeka na zapis pliku floty jak inne zmiany ustawień. Pusta grupa zostaje.
  - Dla grupy, która kupuje, sprzedaje albo jest uzbrojona, te akcje są wyłączone i podają powód. Worker zabrania zmiany składu takiej grupy (`GROUP_RUNNING`). UI blokuje też zmianę jej nazwy. Przycisk ▶ jest wyłączony tylko w wierszach tej grupy. Pole kwoty blokuje się według D-050: portfele z przebiegu i cała grupa z uzbrojonym watcherem.
- Konsekwencje / alternatywy:
  - Postęp w tabeli dalej pokazuje najnowszy przebieg (D-032). Gdy dwie grupy kupują naraz, wiersze starszego przebiegu wracają do stanu spoczynku, a jego stan widać na zakładce grupy.
  - Domyślna grupa floty sprzed grup nazywa się „All wallets” (D-046) i po pierwszym podziale zostaje pod tą nazwą, dopóki właściciel jej nie zmieni.
  - Odrzucone: komendy w **All** dla wszystkich grup naraz (jedno kliknięcie uruchamiałoby kilka grup z jednym celem) i usuwanie grupy razem z jej portfelami (portfel musi należeć do grupy, D-046).

## D-050: Parametry handlu w tabeli (etap 2): zapis od razu, blokada w trakcie akcji, „Edit selected”

- Data: 2026-10-14
- Zadanie: BUNNDLY-71
- Decyzja:
  - **Zapis od razu:** kwota w wierszu zapisuje się w sejfie (`saveSettings` z `maxSpend` i `trade`) po Enter albo po wyjściu z pola i przycisku jednostki. Popover „Trade settings” (przycisk edycji w wierszu i „Edit selected” nad tabelą, układ z makiety `fleet-dashboard.html`) zapisuje przyciskiem „Apply” jeden portfel albo wszystkie zaznaczone jednym żądaniem. Szkice kwot i „Save table changes” dla kwot zniknęły; przycisk zapisuje już tylko zaznaczenie (**decyzja tymczasowa:** zaznaczenie zostaje szkicem, jak dotąd). Plik floty nadal zapisuje się osobnym kliknięciem (D-017).
  - **Kolejka zapisów:** zapisy idą po kolei, każdy z ustawień, które zostawił poprzedni. Dwie szybkie zmiany nie nadpisują się nawzajem.
  - **Wartość domyślna:** puste pole kwoty w wierszu to wartość domyślna floty (wpis znika). W Popoverze puste pole zostawia obecną wartość każdego portfela (jak w makiecie), a słowo „Default” przywraca wartość floty. „Auto” w polu slippage to `null` (D-045). Kwota w SOL usuwa procent i odwrotnie.
  - **Blokada:** pole kwoty i Popover są wyłączone dla portfeli z trwającego zakupu albo sprzedaży swojej grupy (wiersze przebiegu w `buyView` i `buy` grupy w statusie) i dla wszystkich portfeli grupy z uzbrojonym watcherem. Podpowiedź: „Can be changed after the run finishes or after STOP.”. Odpowiedź `WALLET_IN_RUN` z workera przywraca zapisaną wartość i pokazuje tę samą podpowiedź.
  - **Kolumny** jak w makiecie: Priority fee i Slippage za kwotą, każda jako dwie plakietki (kupno zielona ze strzałką do środka, sprzedaż czerwona ze strzałką na zewnątrz; `title` mówi to samo). Opłata priorytetowa jest tylko do odczytu, bo na drodze Jupitera nie jest wysyłana (D-045); pola w Popoverze i w Ustawieniach są wyłączone. Części sprzedaży nie ma w makiecie: nie ma kolumny, jest pole „Sell part” w Popoverze pod siatką.
  - **Kwota w wierszu zostaje polem z przyciskiem jednostki**, choć makieta pokazuje w tej kolumnie sam tekst: polecenie Krystiana z 14.10.2026 („modyfikowalne pole żeby móc wpisać nową wartość cały czas”) wygrywa z makietą (potwierdził Andy 14.10.2026). Pole wygląda jak `.amt` z makiety: znak SOL i sama liczba, a ramka pola i przycisku pojawia się dopiero po najechaniu albo przy fokusie.
  - **„Max spend for all” i „% of balance”** (dawne akcje zbiorcze, BUNNDLY-14) zastępuje „Edit selected” z kwotą w SOL albo w %. Procent jest teraz parametrem portfela liczonym na starcie przebiegu (D-045), a nie kwotą wyliczoną z salda w chwili kliknięcia.
  - **Wartości domyślne floty** w Ustawieniach („Trade defaults”) zapisuje „Save settings” razem z resztą ustawień. Puste pole slippage oznacza Auto, a pusta kwota oznacza brak kwoty domyślnej.
  - **Gotowość w pasku komend (D-048):** BUY i ARM liczą jako gotowy zaznaczony portfel z kwotą kupna, własną albo domyślną, w SOL albo w %, a nie tylko z wpisem `maxSpend`. Kwota do wydania w podsumowaniu i w potwierdzeniu liczy procent z ostatniego odczytu salda. Kwoty zapisują się od razu, więc nie ma już blokady „najpierw zapisz max spend”.
- Konsekwencje / alternatywy:
  - Każda zmiana kwoty daje nowy tekst pliku do zapisania; „Create wallets” czeka na zapis pliku jak dotąd.
  - Odrzucone: zapis kwot przyciskiem „Save table changes” (zadanie wymaga zapisu po Enter) i blokada całej tabeli w trakcie przebiegu (portfele spoza przebiegu i spoza uzbrojonej grupy wolno zmieniać, D-046).

## D-051: Zapamiętana flota i okno bez hasła: wszystko w workerze, klucz pliku jako nieeksportowalny CryptoKey

- Data: 2026-10-14
- Zadanie: BUNNDLY-52
- Decyzja:
  - **Co i gdzie:** IndexedDB strony (baza `bunndly`, magazyn `remember`) ma trzy rekordy: `account` (tekst zaszyfrowanego pliku floty, ten sam co na dysk, i `fileId` = nazwa floty i czas utworzenia), `session` (okno bez hasła) i `prefs` (czy pamiętać i jak długo okno). Czyta je i zapisuje **wyłącznie worker** (`src/worker/remember.ts`, `src/storage/remember-idb.ts`). Do interfejsu trafia tylko nazwa floty, liczba portfeli i ustawienia (`remembered`).
  - **Wariant B okna:** rekord `session` trzyma klucz pliku floty z sesji (już dziś `extractable: false`, użycia `encrypt` i `decrypt`) jako `CryptoKey` oraz znacznik AES-GCM nad pustym tekstem z danymi uwierzytelnionymi `{v, fileId, expiresAt}`. Zmieniony czas wygaśnięcia albo rekord innego pliku nie przechodzi znacznika i rekord znika. Wznowienie otwiera plik tym kluczem bez hasła i bez scrypt (`openKeystoreWithKey`). Okno z limitem liczy się od ostatniej aktywności, tak jak automatyczna blokada (polecenie Andy'ego z 14.10.2026): aktywność przy otwartej flocie zapisuje rekord od nowa z `expiresAt` = teraz + okno, najwyżej raz na minutę, w kolejce workera po bieżącym żądaniu. Wariant A z zadania (klucz opakowujący i zaszyfrowane nim surowe bajty klucza ze scrypt) odrzucony po dowodzie w Chromium z 14.10.2026 (komentarz w BUNNDLY-52). Właściwości są takie same, ale A wymaga wydania surowych bajtów klucza z `crypto.ts`, a kopia profilu daje w A te bajty na zawsze; w B tylko możliwość użycia klucza w tej przeglądarce. Andy potwierdził B, a Krystian brzmienie SPEC 6.9 („Tak”, 14.10.2026).
  - **Kto usuwa rekord okna:** Lock, „Forget this device”, wyłączenie pamiętania, otwarcie innego pliku, upływ okna (przy wznowieniu) i każdy błąd odszyfrowania. Automatyczna blokada usuwa okno ograniczone czasem. Okna bez limitu (polecenie Krystiana: „wyłączenie auto-lock w ustawieniach do ponownego włączenia”, wariant „Window without a limit”) automatyczna blokada nie usuwa: zeruje tylko klucze w pamięci workera. Potwierdził to Andy 14.10.2026, a Ustawienia pokazują wtedy ostrzeżenie (SPEC 6.9). Zmiany hasła aplikacja nie ma, więc ten przypadek z zadania nie występuje.
  - **Okno:** 15 min, 1 h, 2 h albo bez limitu, w Ustawieniach („This device”). **Decyzja tymczasowa (14.10.2026):** domyślnie 15 min — do potwierdzenia przez Krystiana. Pamiętanie jest domyślnie włączone (Krystian, 12.10.2026); opcja jest przy tworzeniu floty, przy otwieraniu pliku i w Ustawieniach.
  - **Spójność z plikiem na dysku:** każdy zapis, który daje nowy tekst pliku (ustawienia, sieć, nowe portfele), aktualizuje też kopię w IndexedDB, jeśli to ta sama flota. Ostrzeżenie o niezapisanym pliku na dysku działa jak dotąd.
  - **Przeglądarka bez IndexedDB** (np. okno prywatne odrzuca bazę): pierwszy błąd wyłącza funkcję, opcja jest wyłączona z wyjaśnieniem, reszta działa jak dotąd (`REMEMBER_UNAVAILABLE`).
  - Reguła ESLint `no-restricted-globals` dla `indexedDB` zostaje; jedyne dozwolone użycie ma wyłączenie w dwóch liniach `remember-idb.ts` z odsyłaczem do tej decyzji.
- Konsekwencje / alternatywy:
  - `prefs` zostaje w IndexedDB także przy wyłączonym pamiętaniu (`{remember: false, windowMs}`), żeby wybór przetrwał odświeżenie. Nie ma w nim danych floty.
  - Kod uruchomiony na stronie w czasie okna może otworzyć flotę bez hasła (SPEC 6.9). Bez okna kopia profilu daje tylko szyfrogram, jak plik na dysku.
  - Odrzucone: zapis czegokolwiek w `localStorage` albo `sessionStorage`, zapis z wątku interfejsu i trzymanie surowych bajtów klucza (wariant A).

## D-052: Stairs w silniku i w workerze: kroki o stałych godzinach, pauza bez zmiany kroków już rozpoczętych

- Data: 2026-10-14
- Zadanie: BUNNDLY-61 (PR 1: harmonogram; ekran w PR 2)
- Decyzja:
  - **Krok:** stała liczba portfeli (`perStep`, co najmniej 1) w stałym odstępie (`intervalMs`, 1 s do 24 h, liczba całkowita ms); potwierdzone przez Krystiana („tak”, komentarz Andy'ego w BUNNDLY-61). Złe parametry worker odrzuca kodem `INVALID_STAIRS` przed jakimkolwiek zapytaniem; executor odrzuca je też sam (`RangeError`), bo `perStep` 0 budowałby kroki bez końca.
  - **Godziny kroków są bezwzględne:** krok k zaczyna się w chwili startu przebiegu + k × odstęp. Długi krok (ponowienia, wolne `/execute`) nie przesuwa następnych. W trybie B start liczy się od wykrycia, tak jak dotąd (`triggeredAt`).
  - **Kroki budowane z portfeli gotowych do zakupu:** portfel pominięty przed `/order` (brak salda, brak odczytu, brak tokenów) nie zajmuje miejsca w kroku.
  - **Stan `SCHEDULED`** (między `IDLE` a `QUEUED`): portfel czeka na swój krok, zdarzenie niesie `scheduledAt`. Wznowienie po pauzie wysyła `SCHEDULED` jeszcze raz z nową godziną.
  - **Pauza** (`pauseStairs`, `resumeStairs`, z grupą jak `stop`): wstrzymuje następne kroki i każde nowe `/order`, także portfeli już w kolejce. Transakcje wysłane kończą się normalnie. Wznowienie przesuwa wszystkie kroki jeszcze nierozpoczęte o czas pauzy. Pauza przebiegu Immediate albo po starcie ostatniego kroku nic nie zmienia. Nazwy różnią się od `resume` z BUNNDLY-52 (wznowienie zapamiętanej sesji).
  - **STOP** pomija portfele z kroków jeszcze nierozpoczętych jako `SKIPPED:STOPPED`, bez zapytań.
  - **Grupy:** harmonogram dotyczy jednej grupy (polecenie Andy'ego); pauza i STOP jednej grupy nie zmieniają kroków innej. Limiter `/order` jest nadal wspólny dla planu, więc krok większy niż budżet okna czeka na limiter jak przy Immediate.
- Konsekwencje / alternatywy:
  - Odrzucone: kroki liczone od końca poprzedniego kroku (jeden wolny portfel opóźniałby całą flotę) i kroki budowane ze wszystkich zaznaczonych portfeli (pominięte dawałyby puste kroki).
  - Przełącznik Immediate / Stairs na pasku komend robi Mark w BUNNDLY-73; ekran postępu kroków, pauza i wznowienie w UI to PR 2 tego zadania.

## D-053: Zakup bezpośredni przez Meteora DBC, etap 1: własny moduł na `@solana/kit`, matematyka przeniesiona z SDK (MIT)

- Data: 2026-10-14
- Zadanie: BUNNDLY-47 (etap 2: podpis w workerze i podłączenie do executora, BUNNDLY-48)
- Decyzja:
  - **Bez SDK Meteory** (bramka 1, decyzja Andy'ego): `@meteora-ag/dynamic-bonding-curve-sdk` stoi na `@solana/web3.js`, Anchorze i `bn.js`, czyli na drugim stosie Solany obok `@solana/kit`. Moduł `src/direct/meteora-dbc` nie dodaje żadnej paczki.
  - **Źródło kodu:** matematyka kupna (`swapQuoteExactIn` dla quote → base, krzywa, opłaty: harmonogram liniowy i wykładniczy, rate limiter, opłata dynamiczna, limit 99%) przeniesiona na `bigint` z SDK 1.5.13 (licencja MIT, copyright Meteory w nagłówku `math.ts`). Commit źródła: `a07966db9067c86a15135fb8088b95fc95a2924a` w `MeteoraAg/dynamic-bonding-curve-sdk` (24.09.2026, ustawia wersję 1.5.13; paczka z npm nie ma `gitHead`, więc pliki z paczki porównane z tym commitem bajt w bajt: wszystkie przeniesione pliki `src/math/**` i IDL są identyczne). Z repozytorium programu (`MeteoraAg/dynamic-bonding-curve`, licencja niekomercyjna) nic nie jest przenoszone.
  - **Układ kont, dyskryminatory, konta `swap2`:** IDL `dynamic_bonding_curve` 0.2.1 z tej samej paczki. W repo SDK 14.10.2026 pojawił się IDL 0.2.2: `swap`, `swap2`, `VirtualPool` i dyskryminatory bez zmian, a `PoolConfig` dostał pola opłaty transferowej Token-2022 (`transfer_fee_basis_points`, `transfer_fee_flag` i dwa inne) w miejscu dawnego `padding_0` (offsety 208–221), więc pola czytane przez moduł się nie przesuwają.
  - **Kupno to `swap2` z trybem ExactIn** (`amount_0` = lamporty, `amount_1` = minimum, `swap_mode` 0), tak jak prawdziwe zakupy na mainnecie. Kolejność instrukcji: limit i cena jednostek obliczeń, idempotentne ATA dla wrapped SOL i tokenu, przelew SOL i `SyncNative`, `swap2`, zamknięcie konta wrapped SOL do płatnika. Konto polecającego jest puste (Anchor: adres programu).
  - **Wydatek** = kwota wejściowa + opłata sieci + rent nowego ATA tokenu; rent konta wrapped SOL wraca przy zamknięciu. Rent bierze się z łańcucha, nie ze stałej: na devnecie 14.10.2026 ATA (165 B) kosztował 1 488 440 lamportów, nie 2 039 280. Istniejące konto wrapped SOL płatnika też zostanie zamknięte, a jego saldo wróci jako SOL.
  - **Pierwsze kupno z minimalną opłatą** (`enable_first_swap_with_min_fee`) dotyczy tylko kupna w transakcji tworzącej pulę; moduł zawsze liczy pełną opłatę. Gdyby program dał niższą, kupujący dostanie więcej, nie mniej.
  - **Jawne wyniki zamiast wyceny:** `no-pool`, `graduated` (pula po migracji albo rezerwa na progu migracji), `insufficient-liquidity` (kwota większa niż reszta krzywej), `not-active` (przed `activation_point`), `unsupported-quote` (pula kwotowana nie w SOL; decyzja tymczasowa z 12.10.2026 w zadaniu), `unsupported-token` (mint Token-2022 z opłatą transferową, hookiem, domyślnym zamrożeniem, nieprzenaszalny albo z pauzą; numery rozszerzeń z `solana-program/token-2022`, `interface/src/extension/mod.rs`).
  - **Pula z mintu:** PDA puli wymaga adresu configu (seed `pool`, config, większy mint, mniejszy mint), więc moduł czyta `getProgramAccounts` programu DBC z filtrami `dataSize` 424 i `memcmp` na `base_mint` (offset 136), a każde znalezione konto sprawdza z PDA. Helius obsługuje te filtry na mainnecie. Koszt według cennika Heliusa (docs „Credits”, odczyt 14.10.2026): `getProgramAccounts` 10 kredytów za wywołanie, zwykłe wywołanie RPC 1 kredyt, stronicowane `getProgramAccountsV2` 1 kredyt. W etapie 2 główną drogą będzie pula z wykrycia watchera, a `getProgramAccounts` zostanie zapasem (decyzja Andy'ego).
  - **Punkt czasu dla opłat:** slot albo czas bloku, zależnie od `activation_type` w configu.
  - **Bez podpisu i bez wysyłki w etapie 1:** `src/worker/**` nietknięte. Devnet sprawdzony `simulateTransaction` bez podpisów (`sigVerify: false`) z publicznym adresem portfela głównego devnet jako płatnikiem.
- Konsekwencje / alternatywy:
  - Fixtures (`tests/fixtures/meteora-dbc.mainnet.json`: 4 zakupy, opłata z tokenu; `meteora-dbc.devnet.json`: 2 zakupy, opłata z SOL, tryb PartialFill, który przy kwocie mieszczącej się na krzywej daje to samo co ExactIn): stan puli odczytany po jej najnowszej sygnaturze i pierwsza udana transakcja po tym odczycie. Oczekiwana liczba tokenów pochodzi z sald płatnika w meta transakcji. Przy zbieraniu każda wycena zgadzała się też z `output_amount` i `next_sqrt_price` ze zdarzenia `EvtSwap2`.
  - Sprzedaż, pule po migracji (DAMM) i tokeny z hookiem transferowym są poza zakresem.
  - Odrzucone: SDK jako zależność (drugi stos Solany, `bn.js`), `swap` v1 (prawdziwe zakupy używają `swap2`).

## D-054: Dashboard w układzie makiety v2, dziennik i wykrycia na ekranie Activity

- Data: 2026-10-14
- Zadanie: BUNNDLY-73
- Kontekst: ekran floty miał pod paskiem komend panel zakupu (tryb, plan Jupitera, postęp, przełącznik trybu na żywo), panel obserwatora (tryb one-shot/continuous, stan połączenia, tabela wykryć), pole bulk i dziennik operacji. Makieta `fleet-dashboard.html` ma jeden ekran: górny pasek → pasek celu → zakładki → pasek narzędzi → tabela → podsumowanie → stopka.
- Decyzja:
  - Ekran nazywa się w nawigacji **Dashboard**, obok są **Activity** i **Settings**. Na Dashboardzie górny pasek ma przełącznik **DRY-RUN** (`role="switch"`; tryb na żywo przez to samo okno potwierdzenia co wcześniej, powrót bez pytania) i chip salda floty: suma znanych sald wszystkich portfeli, „—” przed pierwszym odczytem, kliknięcie czyta salda od nowa. Na pozostałych ekranach zostaje sam chip „Mode: DRY-RUN/LIVE”. Oba elementy renderuje ekran floty w miejscach górnego paska (portal), żeby stan trybu i sald miał jedno źródło.
  - Pasek celu: pole **Target**, etykieta rodzaju adresu, chip wykrycia, linia stanu (puls, „Armed · watching … · połączenie · last message N s ago”) i **Arm**/**Disarm**. **Arm** pojawia się tylko, gdy celem jest portfel twórcy, jak w makiecie. Komunikaty paska (powód wyłączenia, adres z floty, uzbrojony watcher, trwający zakup) są krótkimi liniami pod nim.
  - Pasek narzędzi: **Move to group**, **Create wallets**, **Edit selected** (BUNNDLY-71, D-050), tryb wykonania (**Immediate**; **Stairs** wyłączone do zadania Stairs), **Buy**, **Sell**, **Stop** ze skrótami B, S, Esc. Etykiety przycisków jak w makiecie, z wielkiej litery.
  - Postęp przebiegu (potwierdzone, w trakcie, nieudane, czasy od startu albo od wykrycia) jest polem **Fleet fill** z paskiem w pasku podsumowania („Fleet fill · N of M filled · …”), a czas odczytu sald jest w pasku stanu na dole („Balances as of …”). Komunikaty zapisu pliku floty, zapasowego RPC i błędów są liniami pod podsumowaniem.
  - **Activity**: dziennik operacji z **Download CSV**/**Download JSON** i tabela **Detections** wszystkich grup z kolumną Group, najnowsze na górze.
  - Tryb one-shot/continuous ustawia się tylko w **Settings** (był w obu miejscach). Limit Jupitera, z którym pójdzie zakup (Keyless bez klucza, D-033), pokazuje **Settings** przy planie Jupitera. **Plain export** przechodzi do stopki, do pozycji Backup.
  - Wiersz portfela jak w makiecie: skrócony adres z kopiowaniem i eksploratorem, a kliknięcie adresu otwiera kod QR (makieta nie ma przycisku QR). Po prawej **Buy** (zielony, ↙), **Sell** (czerwony, ↗) i **Trade settings** (✎). **Buy** i **Sell** w wierszu działają jednym portfelem w jego grupie, także niezaznaczonym; **Sell** ma te same powody wyłączenia co SELL na pasku (mint, klucz Helius, działająca albo uzbrojona grupa), a w trybie na żywo pyta w tym samym oknie co SELL.
- Konsekwencje / alternatywy:
  - Stare elementy → nowe miejsca: Buy Mode A/B → jedno pole **Target** (D-048); przełącznik trybu na żywo → przełącznik **DRY-RUN** w górnym pasku; panel obserwatora → linia stanu na pasku celu i **Arm**; one-shot/continuous → **Settings**; pole mintu z „Show token balance” → pole **Target** (kolumna tokenu po rozpoznaniu mintu); „Refresh balances” → chip salda floty; podsumowanie „Before the buy” → **Planned buy** w podsumowaniu i limit Jupitera w **Settings**; postęp → pole **Fleet fill**; Operations log i Detections → **Activity**; bulk → **Edit selected** (D-050); Plain export → stopka.
  - Odrzucone: zostawienie panelu zakupu pod tabelą (makieta go nie ma, a tabela przy 1920 px zaczynała się poniżej pierwszego ekranu) i osobny ekran obserwatora (stan uzbrojenia musi być widać przy komendach).

## D-055: Salda na żywo: `accountSubscribe` na portfel, odpytywanie jako zapas

- Data: 2026-10-14
- Zadanie: BUNNDLY-57
- Kontekst: SPEC 11.2, 11.6, 2.2 i 3.4. Dokumentacja Helius sprawdzona 14.10.2026:
  - `accountSubscribe` (`/docs/api-reference/rpc/websocket/accountsubscribe`): parametry to adres i `{ encoding, commitment }`, odpowiedź to numer subskrypcji, a powiadomienie `accountNotification` ma `params.result.context.slot`, `params.result.value.lamports` i `params.subscription`. Standardowe metody Solany działają na każdym planie, a „Enhanced” wymagają planu płatnego.
  - FAQ WebSocket (`/docs/faqs/websockets`): wiele subskrypcji `accountSubscribe` na jednym połączeniu jest dozwolone; plan Free ma 5 równoczesnych połączeń; połączenie zamyka się po 10 min bez ruchu; ping co minutę; otwarcie połączenia kosztuje 1 kredyt.
  - Strona limitów (`/docs/billing/rate-limits`): Free to 10 zapytań RPC/s i do 1000 subskrypcji na połączenie (tabela „LaserStream WebSocket”, typ „Standard”). To odpowiada na otwarte pytanie zadania. Wartości nie zmierzyłem.
  - `accountUnsubscribe`: Helius go nie opisuje; dokumentacja Solany (`solana.com/docs/rpc/websocket/accountunsubscribe`) przyjmuje numer subskrypcji i zwraca `true`. Aplikacja go nie używa (niżej).
- Decyzja:
  - **Jedno połączenie, subskrypcja na portfel:** worker otwiera jedno gniazdo Helius na sieć floty i wysyła `accountSubscribe` dla każdego portfela z `commitment: confirmed` i `encoding: base64`. Powiadomienie zmienia saldo tylko swojego portfela (zdarzenie `balance` typu `sol`). Ze 100 portfelami to 100 subskrypcji na jednym połączeniu, daleko od 1000. Razem z watcherem trybu B zajęte są najwyżej 2 z 5 połączeń.
  - **Stan „Live” tylko po potwierdzeniu wszystkich subskrypcji.** W każdym innym przypadku (łączenie, utrata połączenia, brak klucza) stan to „Polling”. Pasek stanu i nagłówek kolumny salda mówią to słowami. UI zaczyna od „Polling” i przechodzi na „Live” dopiero po zdarzeniu z workera.
  - **Odpytywanie zostaje:** w stanie „Polling” pełny odczyt `getMultipleAccounts` co 12 s, jak dotąd. W stanie „Live” co 30 s jako uzgodnienie. Każde przejście na „Live” daje od razu jeden pełny odczyt, bo w przerwie powiadomienia mogły przepaść.
  - **Utrzymanie i ponowne łączenie** jak w watcherze (D-036): `getHealth` co 30 s, brak odpowiedzi w 10 s to martwe połączenie, backoff 0,5–30 s z jitterem, subskrypcja bez odpowiedzi w 10 s albo odrzucona to utrata połączenia. Stałe i funkcję backoffu bierzemy z `src/watcher/stream.ts`; kod watchera się nie zmienia.
  - **Zamykanie:** blokada sejfu, zmiana sieci i zmiana klucza albo adresu WebSocket zamykają gniazdo, a wraz z nim wszystkie subskrypcje. Dlatego `accountUnsubscribe` nie jest potrzebne. Ekran floty prosi o zasilanie przy otwarciu (`balanceFeed { on: true }`) i zamyka je przy wyjściu. Nowe portfele dostają subskrypcje na tym samym gnieździe.
  - **Strażnik sieci** (jak w BUNNDLY-44) działa w trzech miejscach: gniazdo ma numer generacji, więc wiadomość z gniazda zamkniętego albo zastąpionego nie przechodzi; worker przepuszcza tylko zdarzenia aktualnego strumienia, tej samej sesji i tej samej sieci; zdarzenie niesie sieć, a UI odrzuca zdarzenie z sieci, której nie ma na ekranie.
  - **Saldo tokenu po transakcji:** gdy portfel ma `CONFIRMED`, worker od razu czyta jego konto tokenowe i wysyła zdarzenie `balance` typu `token`. Portfele, które wylądują blisko siebie, dzielą jeden odczyt, a odczyty dzieli co najmniej 1 s (`TOKEN_READ_GAP_MS`). Jeden odczyt to 2 zapytania HTTP (mint i konta), więc mieści się w 10/s.
  - **Precyzja:** `lamports` w powiadomieniu to liczba JSON. Wartość powyżej 2^53 traci cyfry, więc jest pomijana, a dokładną kwotę daje następne uzgodnienie.
  - **Podświetlenie** zmienionej komórki salda trwa 1,2 s i jest wyłączone przy `prefers-reduced-motion`. Pierwsza wartość wiersza nie miga. Wiersz renderuje się raz na zmianę.
- Konsekwencje / alternatywy:
  - Kredyty: 1 za otwarcie połączenia plus strumień danych. Pełny odczyt co 30 s zamiast co 12 s zmniejsza liczbę zapytań HTTP przy działającym gnieździe.
  - Odrzucone: `signatureSubscribe` dla każdej transakcji (nie pokazuje wpłat z zewnątrz), osobne połączenie na portfel (limit 5 połączeń), drugi klucz albo dostawca (zakazane w zadaniu i w SPEC 2.2).

## D-056: Automatyczna blokada opcjonalna: domyślnie wyłączona, do wyboru 15 min, 1 h albo 2 h

- Data: 2026-10-14
- Zadanie: BUNNDLY-51
- Kontekst: polecenie Krystiana z 12.10.2026: „blokada 15 minutowa interfejsu nie może być automatyczna i z góry narzucona – może być natomiast aktywowana jako ustawienie oraz musi pozwalać na wybór po jakim czasie blokować interfejs z możliwością wyboru 15 minut, 1 godzina, 2 godziny”. Zmienia D-013 i D-019 (domyślne 15 min, zakres 1–120) oraz SPEC 3.1.
- Decyzja:
  - `autoLockMinutes` przyjmuje `null` (wyłączona, domyślnie) albo 15, 60 lub 120. W ustawieniach jest lista z czterema pozycjami zamiast pola liczbowego. Inna wartość w `saveSettings` daje `INVALID_SETTINGS`.
  - Przy wyłączonej blokadzie worker nie blokuje sejfu z powodu bezczynności; timer workera dalej sprawdza warunek co 15 s, ale wynik jest zawsze „nie”. Ręczna blokada działa jak dotąd. Po włączeniu blokada działa jak w D-013: liczy od ostatniej aktywności, zeruje klucze i nie działa przy uzbrojonym watcherze ani w trakcie zakupu lub sprzedaży.
  - Pasek stanu mówi „Auto-lock: off” albo „Auto-lock after 15 min / 1 h / 2 h of inactivity”; przy uzbrojeniu z włączoną blokadą „Armed: auto-lock is paused”.
  - **Decyzja tymczasowa (2026-10-12, z zadania), do potwierdzenia przez Krystiana:** w istniejących plikach zapisane 15, 60 i 120 zostają jako włączona blokada, także dotychczasowe domyślne 15. Każda inna wartość przechodzi na wyłączoną i jest zgłaszana raz przez `SettingsResetNotice` (mechanizm D-019) do następnego zapisu. Plik bez pola otwiera się z blokadą wyłączoną, bez informacji.
  - Okno bez hasła (D-051) się nie zmienia: automatyczna blokada nadal usuwa tylko okno ograniczone czasem, a przy wyłączonej blokadzie nic go nie usuwa poza Lock, „Forget this device” i upływem okna.
- Konsekwencje: przy wyłączonej blokadzie odblokowany sejf zostaje w pamięci karty do ręcznej blokady albo zamknięcia karty (SECURITY.md). SPEC 3.1 zmienia Andy (tekst w BUNNDLY-51).

## D-057: Mainnet bez publicznego zapasu RPC: `api.mainnet.solana.com` odmawia stronie

- Data: 2026-10-14
- Zadanie: BUNNDLY-78 (znalezione w odbiorze BUNNDLY-77)
- Kontekst: D-020 i D-025 ustaliły `https://api.mainnet.solana.com` jako awaryjny odczyt po błędzie Helius i bez klucza. Sprawdzenie 14.10.2026: `POST https://api.mainnet.solana.com` (`getHealth`) z nagłówkiem `Origin: https://bug-free-rotary-phone.pages.dev` daje **HTTP 403** „Access forbidden”, z przeglądarki na pages.dev i z PowerShella. To samo zapytanie bez nagłówka `Origin` daje `{"result":"ok"}`, a `https://api.devnet.solana.com` z tym samym `Origin` daje `ok`. Strona zawsze wysyła `Origin`, więc na mainnecie zapas nie ma szans zadziałać, a bez klucza Helius aplikacja pokazywała ogólne „Could not read data…”.
- Decyzja:
  - Mainnet nie ma publicznego zapasu (`publicRpcUrl('mainnet')` to `null`). Bez klucza Helius odczyty na mainnecie (salda, sprawdzenie celu, zakup także w DRY-RUN) dają `HELIUS_KEY_MISSING` bez żadnego zapytania. Po błędzie Helius zostaje `RPC_UNAVAILABLE` bez próby publicznego hosta.
  - Devnet zachowuje zapas `api.devnet.solana.com`; odpowiedź z niego jest nadal opisana jako „Fallback”.
  - Odpowiedź 401 albo 403 z publicznego RPC daje nowy błąd `PUBLIC_RPC_REFUSED` („The public Solana RPC refuses requests from this page. Add the Helius API key in Settings…”), a nie `RPC_UNAVAILABLE`, bo to odmowa, nie awaria.
  - `api.mainnet.solana.com` znika z `connect-src` w `public/_headers`; poza `src/core/network.ts` żaden moduł (watcher, salda, executor) nie nazywał tego hosta.
- Konsekwencje / alternatywy:
  - Na mainnecie klucz Helius jest potrzebny do każdego odczytu z sieci. Zmienia D-020 i D-025 w części mainnetu; tabela usług w SPEC sekcja 2 dalej wymienia publiczny mainnet jako zapas; według Andy'ego (BUNNDLY-78) ta zmiana SPEC nie zmienia.
  - Odrzucone: inny publiczny dostawca albo drugi klucz (SPEC 2.2), własny serwer pośredniczący (brak backendu, SPEC 2.1).

## D-058: Zapamiętana flota wie, że pliku na dysku brakuje albo jest starszy

- Data: 2026-10-14
- Zadanie: BUNNDLY-80 (znalezione w odbiorze BUNNDLY-77)
- Kontekst: ekrany wiedziały o niezapisanym pliku floty tylko w pamięci karty. Po odświeżeniu strony flota otwierała się z zapisu w przeglądarce bez żadnego ostrzeżenia, choć zapis w przeglądarce bywał jedyną kopią zmian, a „Forget this device” usuwał go bez śladu.
- Decyzja (tymczasowa z 14.10.2026, do potwierdzenia przy odbiorze):
  - Worker trzyma w pamięci najnowszy tekst pliku otwartej floty, dopóki żaden zapis na dysk mu nie odpowiada. Tekst powstaje przy utworzeniu floty i przy każdej przebudowie pliku. Znacznik znika przy otwarciu floty z pliku i po żądaniu `fileSaved` z dokładnie tym tekstem. Starszy tekst znacznika nie zdejmuje.
  - Rekord `account` w IndexedDB (D-051) dostaje pole `unsaved: boolean`, bez sekretów. Rekord bez pola czyta się jako zapisany. `resume` i `unlockRemembered` przywracają znacznik z rekordu.
  - Nowe żądanie `pendingFile` zwraca tekst i nazwę floty albo `null`. App pyta o nie po każdym otwarciu floty i za każdym razem, gdy żaden ekran ani przełącznik sieci nie trzyma własnego, nowszego pliku. Pokazuje wtedy ostrzeżenie z przyciskiem zapisu; Lock pyta, a zamknięcie karty prosi przeglądarkę o potwierdzenie.
  - Wszystkie cztery zapisy pliku (kreator, flota, ustawienia, sieć) wysyłają `fileSaved` przed zdjęciem własnego znacznika ekranu. Żądania idą jedną kolejką, więc następne `pendingFile` widzi już zapis.
  - „Forget this device” na starcie i w ustawieniach oraz wyłączenie „Remember this fleet on this device” czytają znacznik od nowa i przy `unsaved` pytają zdaniem, że przeglądarka ma jedyną kopię zmian.
- Konsekwencje: otwarcie innego pliku albo utworzenie nowej floty z zapamiętaniem nadal zastępuje zapamiętaną flotę bez pytania o znacznik; poza zakresem BUNNDLY-80.

## D-059: STOP rozbraja grupę z uzbrojonym watcherem

- Data: 2026-10-14
- Zadanie: BUNNDLY-87 (z inwentarza makiety v2, BUNNDLY-77 cz. 3)
- Kontekst: D-038 ustaliło, że STOP zatrzymuje tylko bieżący zakup, a watcher zostaje uzbrojony. Przy samym uzbrojeniu przycisk Stop był więc wyłączony („Nothing is running.”), Esc nic nie robił, a obserwację kończył tylko Disarm. Makieta v2 (linie 642, 722–729) ma Stop aktywny także przy uzbrojonej grupie: zatrzymuje przebieg i rozbraja.
- Decyzja:
  - STOP grupy najpierw rozbraja jej watcher (jak `disarm`: gniazdo zamknięte, kolejka wykryć opróżniona), a potem zatrzymuje jej zakup albo sprzedaż, jeśli trwa. Inne grupy nie są dotykane.
  - Stop i Esc są aktywne, gdy grupa kupuje, sprzedaje albo jest uzbrojona.
  - Disarm działa jak dotąd.
- Konsekwencje: zmienia D-038 w części STOP („watcher zostaje uzbrojony, a kolejka rusza po jego końcu”). Kto chce przerwać zakup i dalej obserwować twórcę, uzbraja grupę od nowa.

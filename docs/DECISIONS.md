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
  - **`WatchGuard` w `App`, na każdym ekranie:**
    - utrata połączenia przy uzbrojonym watcherze (`reconnecting` albo `disconnected`) daje czerwony baner `role="alert"` i dźwięk co 3 s;
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

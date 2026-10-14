# SPEC: Bunndly — Solana Multi-Wallet Buyer

> Wspólna specyfikacja produktu dla agentów: **Andy** (architekt, review, Plane) oraz **Mark** i **Kamil** (implementacja). Właściciel projektu: **Krystian**.
> Ten plik leży w repozytorium jako `docs/SPEC.md` i jest źródłem prawdy o produkcie. Zmienia go tylko Andy, po uzgodnieniu z Krystianem.
> Zasady współpracy i workflow na Plane opisuje `CLAUDE.md` w katalogu głównym repo. Role nadaje sesjom Krystian.

## 0. Zasady obowiązujące przez cały projekt

1. **Nie zgaduj API.** Przed napisaniem integracji przeczytaj aktualną dokumentację:
   - Jupiter: `https://developers.jup.ag/docs/llms.txt` (indeks), potem konkretne strony `.md`. Wymagane: Swap API V2 (`/swap/v2/order`, `/swap/v2/execute`), Rate Limits, API Keys.
   - Helius: dokumentacja RPC i WebSocket (`logsSubscribe`, `accountSubscribe`), limity planu Free.
   - Programy launchpadów (pump.fun, Raydium LaunchLab, Meteora DBC). Program ID i dyskryminatory instrukcji bierz wyłącznie z oficjalnych źródeł (IDL, repozytoria, dokumentacja). Nigdy z pamięci.
   - Jeśli dokumentacja przeczy temu briefowi, wygrywa dokumentacja. Zapisz rozbieżność w `docs/DECISIONS.md`.
2. **Bezpieczeństwo kluczy jest wymaganiem nadrzędnym** (sekcja 6). Żadna funkcja nie może go osłabiać.
3. Praca etapami (sekcja 10). Każdy etap to jeden sprint (cycle) na Plane. Po każdym zadaniu: działające testy, wpis w `PROGRESS.md`, commit.
4. Gdy decyzja jest nieodwracalna albo wymaga wydania prawdziwych środków, zatrzymaj się i zapytaj Krystiana.

---

## 1. Cel produktu

Narzędzie do zarządzania flotą (domyślnie 30, konfigurowalnie 1–100) portfeli Solany, które:

1. Generuje portfele i zapisuje ich klucze oraz seed do wskazanego folderu i pliku.
2. Pokazuje panel koordynacji: adres depozytu, saldo, „max spend”, rezerwę na opłaty i saldo tokenu dla każdego portfela.
3. Po podaniu **adresu mintu tokenu** albo **adresu portfela do obserwacji** kupuje token wszystkimi aktywnymi portfelami przez Jupiter. W trybie obserwacji robi to w chwili, gdy obserwowany portfel utworzy nowy token.
4. **Warunek konieczny:** na żywo pokazuje postęp zakupu każdego portfela oraz liczbę kupionych tokenów.

---

## 2. Decyzje architektoniczne (już podjęte, nie zmieniaj bez uzasadnienia)

### 2.1 Aplikacja w 100% po stronie klienta (static SPA, bez backendu)

- Jedna baza kodu: **TypeScript + Vite + React** (lub Svelte, jeśli uzasadnisz). Build daje statyczne pliki.
- **Wersja lokalna:** `npm run dev` / `npm run preview` na `localhost`.
- **Wersja hostowana:** ten sam build wdrożony jako statyczne pliki na Cloudflare (Workers Static Assets albo Pages) lub Vercel Hobby.
- **Brak serwera, brak serverless functions.** Uzasadnienie:
  - Klucze prywatne nigdy nie mogą opuścić przeglądarki użytkownika.
  - Watcher wymaga stałego połączenia WebSocket, czego darmowe funkcje serverless nie utrzymają (limity CPU/czasu).
  - Statyczny hosting na obu platformach jest darmowy i nielimitowany lub hojnie limitowany.
- Klucze API (Helius, Jupiter) **nie trafiają do zmiennych środowiskowych builda.** Użytkownik wpisuje je w ustawieniach aplikacji. Są przechowywane zaszyfrowane razem z keystore.

### 2.2 Zewnętrzne usługi

| Usługa | Do czego | Uwagi |
|---|---|---|
| **Jupiter Swap API V2**, ścieżka Meta-Aggregator: `GET /swap/v2/order` + `POST /swap/v2/execute` | Quote, budowa transakcji, wysyłka i potwierdzenie | Bez własnego RPC do wysyłki. Slippage automatyczny (RTSE). Nagłówek `x-api-key`. Limit `/order` zależy od planu (Free ~1 RPS, Developer ~10 RPS) i jest liczony **na organizację**, nie na klucz. `/execute` ma osobną, wyższą pulę. Zweryfikuj aktualne wartości. |
| **Helius RPC** (jeden klucz, plan Free wystarcza) | WebSocket do obserwacji portfela, odczyt sald, weryfikacja sygnatur | NIE wysyłamy przez niego transakcji swapów (Free ma ~1 sendTransaction/s). Grupuj odczyty (`getMultipleAccounts`). |
| Publiczny `api.mainnet.solana.com` | Tylko jako awaryjny fallback do odczytów | Nie do produkcji. Niskie limity per IP. |

**Zakazane:** obchodzenie limitów przez wiele kont lub kluczy u tego samego dostawcy. Limit Jupitera i tak jest per organizacja.

### 2.3 Biblioteki (preferowane, zweryfikuj aktualność)

- `@solana/kit` (nowe web3.js) do RPC, transakcji i podpisów. Ewentualnie `@solana/web3.js` 1.x, jeśli przykłady Jupitera tego wymagają.
- `@scure/bip39` do mnemonika, derywacja ed25519 SLIP-0010 (np. `micro-key-producer` lub równoważna, audytowana biblioteka) na ścieżce `m/44'/501'/{i}'/0'`. **Musi** dawać te same adresy co Phantom/Solflare dla tego samego mnemonika.
- `@noble/hashes` (scrypt) + WebCrypto `AES-GCM` do szyfrowania keystore.
- Bez SDK analityki, trackerów ani zewnętrznych skryptów z CDN.

---

## 3. Moduły i wymagania funkcjonalne

### 3.1 Generator portfeli i keystore

- Kreator: liczba portfeli (domyślnie 30), etykieta floty, hasło (min. 12 znaków, wskaźnik siły, powtórzenie).
- Generuje **jeden mnemonik BIP39 (24 słowa)** i wyprowadza N portfeli ścieżką `m/44'/501'/{i}'/0'` (i = 0..N-1).
- Opcja: import istniejącego mnemonika i dodanie kolejnych indeksów do floty.
- **Zapis do wybranego folderu:** File System Access API (`showDirectoryPicker`). Użytkownik wskazuje folder, aplikacja zapisuje plik `<nazwa-floty>.keystore.json`. Fallback (Firefox/Safari): pobranie pliku.
- **Format keystore (zaszyfrowany, domyślny):**
  ```json
  {
    "version": 1,
    "fleetName": "string",
    "createdAt": "ISO-8601",
    "kdf": { "name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "base64" },
    "cipher": { "name": "AES-GCM", "iv": "base64" },
    "ciphertext": "base64",
    "public": {
      "wallets": [ { "index": 0, "address": "base58", "derivationPath": "m/44'/501'/0'/0'", "label": "W01" } ]
    }
  }
  ```
  `ciphertext` zawiera: mnemonik, klucze prywatne (base58, format importowalny do Phantom), ustawienia floty (max spend per portfel) oraz klucze API.
  Część `public` jest jawna, żeby dało się podglądać adresy bez hasła.
- **Eksport jawny** (mnemonik i klucze prywatne w czystym tekście, `.txt`/`.json`): tylko po ponownym wpisaniu hasła i potwierdzeniu ostrzeżenia. Nigdy domyślnie.
- Otwieranie istniejącego keystore: wybór pliku, hasło, odszyfrowanie do pamięci.
- **Auto-lock** po X minutach bezczynności (domyślnie 15). Czyści klucze z pamięci. Nie działa podczas uzbrojonej operacji.

### 3.2 Panel floty (tabela)

Kolumny dla każdego portfela:

| # | Etykieta | Adres depozytu (kopiuj + QR) | Saldo SOL | Max spend (SOL, edytowalne) | Rezerwa = saldo − max spend | Token: saldo | Status zakupu | Tx (link do explorera) | Aktywny (checkbox) |

- Walidacja max spend: rezerwa ≥ `MIN_RESERVE_SOL` (domyślnie 0,015 SOL, konfigurowalne). Rezerwa pokrywa rent konta tokenowego, priority fee i późniejszą sprzedaż. Wiersz z za małą rezerwą jest oznaczony na czerwono i wykluczony z zakupu.
- Akcje zbiorcze: „ustaw max spend dla wszystkich”, „ustaw jako % salda”, zaznacz/odznacz wszystkie.
- Odświeżanie sald: `getMultipleAccounts` w paczkach (max 100 kont na zapytanie), co 10–15 s i na żądanie.
- Saldo tokenu: wyprowadź ATA dla właściwego programu tokenów. Program odczytaj z właściciela konta mintu: obsłuż **SPL Token i Token-2022**. Pobierz paczką przez `getMultipleAccounts`.
- Pasek podsumowania: łącznie SOL, łącznie do wydania, liczba portfeli gotowych, łącznie kupionych tokenów, średnia cena wejścia.

### 3.3 Ustawienia

- Klucz Helius (RPC HTTP + WSS URL), klucz Jupiter, wybrany plan Jupitera (wyznacza `ORDER_RPS`, można też wpisać ręcznie).
- `MIN_RESERVE_SOL`, maks. liczba prób na portfel (domyślnie 3), sufit ceny (maks. odchylenie ceny portfela od ceny pierwszego udanego zakupu floty, domyślnie 50%), okno ponawiania „no route” dla świeżych tokenów (domyślnie 20 s, backoff 500 ms → 2 s).
- Tryb **one-shot** (domyślny): po pierwszym wykrytym tokenie watcher się rozbraja. Opcjonalnie tryb ciągły, z potwierdzeniem ostrzeżenia.
- Przycisk „Test połączeń”: ping Helius HTTP + WSS, Jupiter (np. quote SOL→USDC bez wykonania), pokaż wynik i odczytane nagłówki limitów (`x-ratelimit-*`).

### 3.4 Watcher (wyzwalacz)

Dwa tryby, przełączane w UI, z dużym przyciskiem **UZBRÓJ / ROZBRÓJ**:

**A. Bezpośredni mint.** Użytkownik wkleja adres mintu i klika „Kupuj teraz”. Walidacja: adres base58, konto istnieje, jest mintem.

**B. Obserwacja portfela.** Użytkownik podaje adres twórcy.
- Helius WebSocket `logsSubscribe` z filtrem `mentions: [creator]`, commitment `processed` (szybkość). Weryfikacja przez pobranie transakcji (`getTransaction`, `maxSupportedTransactionVersion: 0`).
- Wykrycie utworzenia tokenu, w kolejności:
  1. Instrukcje create znanych launchpadów (pump.fun, Raydium LaunchLab, Meteora DBC, Moonshot). Program ID i dyskryminatory weź z oficjalnych IDL, każdy jako osobny, testowany „detektor” w `src/watcher/detectors/`.
  2. Fallback generyczny: w transakcji podpisanej przez twórcę jest `InitializeMint`/`InitializeMint2` (SPL lub Token-2022) dla nowego konta mintu.
- Wyciągnij adres mintu, zaloguj źródło detekcji, przekaż do executora. Deduplikacja po mincie.
- Automatyczne ponowne łączenie WebSocket (backoff, ping/heartbeat). Wyraźny wskaźnik stanu połączenia w UI. Utrata połączenia przy uzbrojonym watcherze to alarm wizualny i dźwiękowy.
- Watcher i executor działają w **Web Workerze**, żeby throttling kart w tle nie spowalniał reakcji. Użyj Wake Lock API, gdy watcher jest uzbrojony. UI ostrzega, że karta musi pozostać otwarta.

### 3.5 Executor (orkiestrator zakupu)

Kluczowe wymagania: **każdy aktywny portfel ma kupić, portfele nie blokują się nawzajem, nikt nie kupuje dwa razy.**

- **Kolejka FIFO** z wszystkimi aktywnymi portfelami. **Token bucket** na `GET /swap/v2/order` z tempem `ORDER_RPS` (z lekkim marginesem, np. 90%). Reaguj na nagłówki `x-ratelimit-*` i 429 (respektuj reset).
- **Potok, nie paczka:** portfel, który dostał order, natychmiast podpisuje lokalnie i woła `POST /swap/v2/execute`. Wywołania `/execute` lecą równolegle, bo mają osobną pulę limitu. Nie czekaj na quote'y wszystkich portfeli.
- Parametry `/order`: `inputMint = So11111111111111111111111111111111111111112` (SOL), `outputMint = mint`, `amount = maxSpend w lamportach`, `taker = adres portfela`. Pozostałe pola zgodnie z aktualną dokumentacją. Nie przekazuj parametrów, które wyłączają routery, chyba że dokumentacja wskaże powód.
- **Maszyna stanów na portfel:** `IDLE → QUEUED → QUOTING → SIGNING → SUBMITTED → CONFIRMED | FAILED | UNKNOWN | SKIPPED`
  - `UNKNOWN`: timeout lub błąd sieci po wysłaniu. **Przed jakimkolwiek ponowieniem** sprawdź sygnaturę przez RPC (`getSignatureStatuses`, z historią). Jeśli wylądowała, przejdź do `CONFIRMED`. Jeśli wygasł jej blockhash i jej nie ma, możesz ponowić.
  - `FAILED` z błędem przejściowym (slippage, „no route” w oknie świeżego tokenu, 5xx): portfel wraca **na koniec kolejki**, licznik prób +1. Po przekroczeniu limitu prób: `FAILED` z jasnym powodem.
  - `SKIPPED`: za mało SOL, przekroczony sufit ceny, ręczne zatrzymanie.
- **Idempotencja:** jeden portfel może mieć najwyżej jedną transakcję „w locie”. Suma wydana przez portfel nigdy nie przekracza jego max spend (licz także transakcje o statusie UNKNOWN).
- **Sufit ceny:** po pierwszym `CONFIRMED` zapamiętaj cenę wejścia floty. Kolejne portfele porównują cenę z quote'a. Jeśli odchylenie przekracza próg, `SKIPPED (price cap)`.
- **Globalny przycisk STOP:** opróżnia kolejkę, nie przerywa transakcji już wysłanych, ale je śledzi do końca.
- **Wynik:** z odpowiedzi `/execute` zapisz sygnaturę oraz faktyczne kwoty wejścia i wyjścia (nazwy pól wg dokumentacji). Następnie potwierdź saldo tokenu odczytem RPC. W UI pokazuj wartość z `/execute` od razu, a po odczycie RPC oznacz ją jako potwierdzoną.
- **Dziennik operacji:** wpis z timestampem dla każdego przejścia stanu, eksportowalny do CSV/JSON. Bez kluczy prywatnych i bez kluczy API.

### 3.6 Widok postępu (warunek konieczny)

- Pasek postępu floty: X/N potwierdzonych, Y w trakcie, Z nieudanych.
- W tabeli: kolorowy status z ikoną, czas od wyzwolenia, liczba prób, kupione tokeny, wydany SOL, cena efektywna, link do transakcji (Solscan/Orb/Solana Explorer, wybór w ustawieniach).
- Licznik czasu od wykrycia tokenu do pierwszego i ostatniego potwierdzenia.
- Aktualizacje na żywo przez komunikaty z Web Workera, bez blokowania UI.

### 3.7 Funkcje opcjonalne (etap 6, po akceptacji MVP)

- Rozesłanie SOL z jednego portfela źródłowego do floty (z podglądem i potwierdzeniem).
- Zebranie SOL i tokenów z floty z powrotem do jednego adresu.
- Sprzedaż tokenu przez flotę (te same mechanizmy: kolejka, limiter, maszyna stanów).

---

## 4. Struktura repozytorium (proponowana)

```
/src
  /core         # czyste TS, bez DOM: derywacja, keystore crypto, typy, maszyna stanów, limiter
  /chain        # klient RPC (Helius + fallback), odczyt sald, statusy sygnatur
  /jupiter      # klient Swap V2: order, execute, obsługa limitów i błędów
  /watcher      # WebSocket, detektory launchpadów (/detectors), dedup
  /executor     # kolejka, token bucket, potok, retry, idempotencja
  /worker       # Web Worker spinający watcher + executor, protokół wiadomości
  /storage      # File System Access API + fallback download/upload
  /ui           # komponenty React: kreator, tabela floty, ustawienia, panel uzbrajania, log
/tests          # unit + integracyjne z mockami
/public/_headers   # nagłówki bezpieczeństwa (Cloudflare)
vercel.json        # nagłówki bezpieczeństwa (Vercel)
wrangler.jsonc     # jeśli Workers Static Assets
/docs              # SPEC.md, DECISIONS.md
README.md, PROGRESS.md, SECURITY.md, CLAUDE.md
```

Moduły `core`, `executor` i `jupiter` piszemy tak, by dało się je testować w Node bez przeglądarki.

---

## 5. Wymagania niefunkcjonalne

- TypeScript `strict`. ESLint i Prettier. Zero `any` w modułach `core`, `executor`, `jupiter`.
- Wszystkie kwoty w lamportach / jednostkach bazowych jako `bigint`. Konwersja do wyświetlania tylko w UI, z uwzględnieniem `decimals` mintu.
- Obsługa błędów z typowanymi kodami. Każdy błąd widoczny dla użytkownika ma zrozumiały komunikat po angielsku.
- UI wyłącznie po angielsku, bez wyboru języka. Działa na desktopie (Chrome/Edge jako docelowe). Wersji mobilnej nie ma: układów dla telefonu nie budujemy i nie testujemy (decyzja Krystiana, 12.10.2026).
- Wydajność: reakcja watcher → pierwsze `/order` poniżej 300 ms od otrzymania logu (pomiar w logu).

---

## 6. Bezpieczeństwo (wymagania twarde)

1. Klucze prywatne i mnemonik istnieją w postaci jawnej **wyłącznie w pamięci Web Workera** po odblokowaniu. Nigdy w `localStorage`, `sessionStorage`, IndexedDB, URL, logach, konsoli ani komunikatach błędów. Wyjątkiem są dwa pliki zapisywane na dysk na polecenie użytkownika: eksport jawny (3.1) i plik jawny w folderze kopii zapasowej (11.1). Ich treść powstaje w workerze i nie trafia do stanu aplikacji, do strony ani do magazynów przeglądarki.
2. Podpisywanie wyłącznie lokalnie. Do Jupitera i RPC trafiają tylko podpisane transakcje i adresy publiczne.
3. Keystore: scrypt (parametry jak w 3.1, możliwość podniesienia) + AES-GCM z losowym IV, uwierzytelnienie przez tag GCM. Błędne hasło daje czytelny komunikat, bez wycieku informacji.
4. **Content-Security-Policy:** `default-src 'self'`; `connect-src` tylko do domen Helius, `api.jup.ag` i ewentualnie fallback RPC; brak `unsafe-eval`, brak zewnętrznych skryptów. Plus `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy` minimalne.
5. Zależności przypięte (lockfile), `npm audit` w CI, minimalna liczba paczek. Każda paczka kryptograficzna musi być znana i audytowana.
6. **Wdrożenie hostowane musi być chronione dostępem.** Na Cloudflare: Cloudflare Access (Zero Trust, plan darmowy) z logowaniem tylko dla Krystiana. Na Vercel Hobby: brak darmowej ochrony hasłem całego projektu, więc opisz ryzyko w `SECURITY.md` i zarekomenduj Cloudflare.
7. `SECURITY.md` opisuje model zagrożeń: XSS, supply chain, złośliwe rozszerzenia przeglądarki, utrata pliku keystore, zapomniane hasło (brak odzyskania bez mnemonika).
8. Brak telemetrii.
9. **Zapamiętana flota i okno bez hasła** (BUNNDLY-52, D-051, zgoda Krystiana 12.10 i 14.10.2026):
   - Na życzenie użytkownika przeglądarka przechowuje w IndexedDB zaszyfrowany plik konta (ten sam szyfrogram co plik na dysku). Nie przechowuje hasła ani niczego jawnego: po powrocie na stronę konto odblokowuje się hasłem. Skutek: kto ma dostęp do profilu przeglądarki, ma dostęp do szyfrogramu, tak samo jak do pliku na dysku; ochroną jest hasło i scrypt. Użytkownik może w każdej chwili usunąć zapis z urządzenia.
   - Na życzenie użytkownika przeglądarka może przez wybrany czas (15 min, 1 h lub 2 h, domyślnie 15 min) otwierać konto po odświeżeniu strony bez hasła. Przechowuje wtedy w IndexedDB klucz pliku konta jako nieeksportowalny klucz WebCrypto; nie przechowuje hasła, mnemonika ani kluczy prywatnych. Skutek: w tym czasie kod uruchomiony na tej stronie albo osoba z dostępem do profilu przeglądarki może otworzyć konto bez hasła. Lock, automatyczna blokada i „Forget this device” natychmiast usuwają ten zapis.
   - Użytkownik może w Ustawieniach wybrać okno bez limitu czasu: wtedy rekord zostaje do Lock, »Forget this device«, otwarcia innego pliku albo błędu odszyfrowania, a każdy, kto ma dostęp do tego profilu przeglądarki, otwiera konto bez hasła. Ustawienia pokazują to ostrzeżenie przy wyborze tej opcji.

---

## 7. Testy i kryteria akceptacji

**Testy jednostkowe (wymagane):**
- Derywacja: dla znanego mnemonika testowego adresy z indeksów 0–2 zgadzają się z wektorami referencyjnymi (Phantom/Solana CLI `solana-keygen` z `--derivation-path`). Wektory zapisz w testach.
- Keystore: szyfrowanie i deszyfrowanie (round-trip), złe hasło, uszkodzony plik.
- Token bucket: przy `ORDER_RPS=1` i 30 portfelach żadne wywołanie nie przekracza limitu. Reakcja na 429.
- Maszyna stanów executora z mockiem Jupitera i RPC:
  - wszystkie sukces,
  - losowe błędy slippage (portfel wraca na koniec, wszyscy w końcu kończą),
  - timeout po wysłaniu, gdy transakcja jednak wylądowała (brak podwójnego zakupu),
  - „no route” przez pierwsze 5 s (ponawianie w oknie),
  - przekroczony sufit ceny,
  - STOP w trakcie.
- Detektory watchera: na zapisanych prawdziwych transakcjach (fixtures JSON pobrane z mainnetu) dla każdego launchpadu i dla fallbacku generycznego.

**Tryb DRY-RUN (wymagany):** cały potok z prawdziwym `/order`, ale bez `/execute`. Pokazuje, co by się stało, i czasy. Domyślnie włączony przy pierwszym uruchomieniu.

**Smoke test na mainnecie (Jupiter nie działa na devnecie).** Zatrzymaj się i poproś Krystiana o zgodę oraz zasilenie:
1. 2–3 portfele po ~0,03 SOL, zakup SOL→USDC za 0,005 SOL każdy (tryb A).
2. Tryb B z portfelem testowym Krystiana na wybranym launchpadzie, małe kwoty.

**Kryteria akceptacji MVP:**
- [ ] Kreator tworzy 30 portfeli, zapisuje zaszyfrowany keystore do folderu wskazanego przez użytkownika, plik da się ponownie otworzyć hasłem.
- [ ] Adresy zgodne z Phantomem po imporcie mnemonika.
- [ ] Tabela pokazuje salda SOL i tokenu, max spend, rezerwę i walidację.
- [ ] Tryb A i tryb B uruchamiają zakup wszystkimi aktywnymi portfelami.
- [ ] Na żywo widać status, liczbę prób, kupione tokeny i link do transakcji każdego portfela.
- [ ] Żaden portfel nie przekracza max spend, brak podwójnych zakupów w testach.
- [ ] Brak 429 przy zgodnym ustawieniu planu.
- [ ] Build statyczny działa lokalnie i po wdrożeniu, z nagłówkami CSP.

---

## 8. Wdrożenie

1. **Lokalnie:** `npm i && npm run dev`. Opisz w README także `npm run build && npm run preview`.
2. **Cloudflare (rekomendowane):** statyczne pliki przez Workers Static Assets (`wrangler deploy`) albo Pages (połączenie z repo). Skonfiguruj SPA fallback, nagłówki z `_headers`, a następnie Cloudflare Access na domenie aplikacji. Instrukcja krok po kroku w README.
3. **Vercel Hobby (alternatywa):** wdrożenie statyczne z `vercel.json` (nagłówki, rewrites dla SPA). W README zaznacz, że plan Hobby jest tylko do użytku osobistego, niekomercyjnego.
4. Żadnych sekretów w repozytorium ani w zmiennych środowiskowych.

---

## 9. Poza zakresem (nie rób w v1)

- Backend, serwer, przechowywanie kluczy poza przeglądarką.
- Bundle Jito i ścieżka `/build` (ewentualnie v2, po osobnej decyzji).
- Obchodzenie limitów API, rotacja kont, scraping.
- Automatyczna sprzedaż i strategie take-profit (poza opcjonalnym etapem 6).

---

## 10. Etapy pracy

1. **Fundament:** repo, Vite + TS, struktura, CI (lint, testy, audit), `core`: derywacja + keystore + testy.
2. **Flota i salda:** kreator, zapis i odczyt keystore (File System Access), tabela, ustawienia, odczyt sald SOL i tokenów, „Test połączeń”.
3. **Executor + Jupiter:** klient Swap V2, token bucket, maszyna stanów, retry, idempotencja, DRY-RUN, widok postępu, testy z mockami. Następnie stop i prośba o smoke test na mainnecie (tryb A).
4. **Watcher:** WebSocket, detektory z fixtures, Web Worker, Wake Lock, alarmy. Następnie stop i smoke test trybu B.
5. **Wdrożenie:** nagłówki, Cloudflare + Access (lub Vercel), README, SECURITY.md.
6. **Opcjonalnie (po akceptacji MVP przez Krystiana):** rozsyłanie i zbieranie SOL, sprzedaż.

Po każdym etapie Andy raportuje Krystianowi: co działa, co przetestowano, otwarte pytania, rozbieżności z dokumentacją.

---

## 11. Dashboard floty (Epik 3)

> Decyzja Krystiana z 12.10.2026. Wzór wyglądu i gęstości: panel zadań serwisu Bloom. Zakres produktu: tworzenie portfeli, koordynacja wielu portfeli i parametry handlu. Gdzie ta sekcja mówi co innego niż 3.2, 3.6, 3.7 i 9, rozstrzyga ta sekcja.

### 11.1 Portfele

- „Create wallets” pyta o liczbę i tworzy portfele jednym kliknięciem. Domyślne nazwy: `Wallet 0`, `Wallet 1`, … (numer to indeks derywacji).
- Folder kopii zapasowej: użytkownik wskazuje go raz. Po każdej zmianie zbioru portfeli aplikacja sama zapisuje tam dwa pliki: zaszyfrowany plik konta oraz plik z frazą odzyskiwania i kluczami prywatnymi jawnym tekstem (decyzja Krystiana z 13.10.2026, tymczasowa), i sprawdza oba zapisy odczytem. Plik jawny daje pełny dostęp do środków każdemu, kto ma dostęp do folderu; aplikacja mówi to przy włączaniu folderu i w pasku stanu. Portfel bez potwierdzonej kopii nie bierze udziału w komendach. Brak dostępu do folderu jest stanem alarmowym widocznym na każdym ekranie.

### 11.2 Tabela

Kolumny: zaznaczenie, portfel (nazwa, skrócony adres, kopiuj, eksplorator), saldo SOL z ikoną, saldo tokenu, kwota, slippage (kupno / sprzedaż), opłata priorytetowa (kupno / sprzedaż), postęp, liczba tokenów, status, akcje wiersza.

- Saldo SOL zmienia się w tabeli najpóźniej 2 s po potwierdzeniu wpływu w sieci.
- Postęp: pasek 0–100%, czyli wykonana część zlecenia portfela potwierdzona w łańcuchu do części zaplanowanej. 100% pojawia się dopiero po potwierdzeniu transakcji i odczycie salda z RPC. W trakcie pasek pokazuje etap (kolejka, wycena, podpis, wysłano). DRY-RUN nigdy nie wygląda jak zakup.
- Obok paska liczba kupionych albo sprzedanych tokenów odczytana z łańcucha.

### 11.3 Parametry handlu

Na portfel, z wartościami domyślnymi floty i edycją zbiorczą: kwota kupna (SOL albo procent salda), część sprzedaży (procent salda tokenu), slippage kupna i sprzedaży, opłata priorytetowa kupna i sprzedaży. Parametr, którego dana droga zakupu nie przyjmuje, jest pokazany jako „Auto”, nigdy jako liczba, która nie działa.

### 11.4 Komendy floty

Jeden cel: adres mintu albo adres portfela twórcy; aplikacja rozpoznaje, czym jest adres. Komendy: ARM (czekaj na token twórcy i kup), BUY, SELL, STOP. Działają na zaznaczone portfele. Sprzedaż używa tych samych mechanizmów co kupno (kolejka, limiter, maszyna stanów, idempotencja): portfel nigdy nie sprzedaje więcej niż zaplanowana część.

### 11.5 Tryby wykonania

- **Immediate:** wszystkie zaznaczone portfele od razu; tempo ogranicza tylko limiter drogi zakupu.
- **Stairs:** portfele po kolei, jeden krok co ustawiony odstęp, w kroku ustawiona liczba portfeli. Pauza, wznowienie i STOP. Dotyczy kupna i sprzedaży, także po wykryciu tokenu w trybie obserwacji.

### 11.6 Reakcja interfejsu

- Kliknięcie komendy zmienia stan wierszy od razu, przed odpowiedzią sieci.
- Zdarzenia z workera są nanoszone najpóźniej w następnej klatce; przy 100 portfelach odświeżają się tylko zmienione wiersze.
- Stały pasek stanu: sieć, źródło danych, opóźnienie RPC, stan WebSocketu, stan folderu kopii.

### 11.7 Poza zakresem

Copy trading, zlecenia z limitem, śledzenie cudzych portfeli, strategie take-profit, bundle Jito i napiwki.

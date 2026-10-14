# Bunndly

Solana Multi-Wallet Buyer: statyczna aplikacja SPA (bez backendu) do zarządzania flotą portfeli Solany i zakupu tokenów przez Jupiter. Pełna specyfikacja: [`docs/SPEC.md`](docs/SPEC.md). Bezpieczeństwo i model zagrożeń: [`SECURITY.md`](SECURITY.md).

> Status: flota, salda, ustawienia, test połączeń i zakup w trybie A (domyślnie DRY-RUN) działają. Obserwacja portfela (tryb B) dojdzie w sprincie 4.

> **Ważne:**
>
> - **Mnemonik i plik floty dają dostęp do środków.** Hasła floty nie da się odzyskać; bez hasła zostaje tylko import mnemonika. Zrób kopię zapasową mnemonika zaraz po utworzeniu floty.
> - **Klucze API (Helius, Jupiter) wpisujesz w aplikacji, nigdy w kodzie ani w zmiennych środowiskowych.** Są zaszyfrowane w pliku floty.
> - Nie wklejaj mnemonika ani kluczy prywatnych nigdzie poza aplikacją.

## Spis treści

- [Uruchomienie lokalne](#uruchomienie-lokalne)
- [Wdrożenie na Cloudflare Pages](#wdrożenie-na-cloudflare-pages)
- [Cloudflare Access: dostęp tylko dla Ciebie](#cloudflare-access-dostęp-tylko-dla-ciebie)
- [Pierwsze kroki w aplikacji](#pierwsze-kroki-w-aplikacji)
- [Sieć: Mainnet i Devnet](#sieć-mainnet-i-devnet)
- [Zakup: tryb A](#zakup-tryb-a)
- [Zakup: tryb B](#zakup-tryb-b)
- [Dla programistów](#dla-programistów)

## Uruchomienie lokalne

Wymagania: Node.js `>=22.13` (zalecana wersja z `.nvmrc`: `nvm use`) i npm 10+.

```bash
npm i && npm run dev
```

Wersja produkcyjna (statyczny build) lokalnie, **z tymi samymi nagłówkami bezpieczeństwa co po wdrożeniu** (CSP i pozostałe z `public/_headers`):

```bash
npm run build && npm run preview
```

Serwer deweloperski (`npm run dev`) nie wysyła nagłówka CSP, bo podgląd na żywo Vite wymaga skryptów inline. Do sprawdzania zachowania produkcyjnego używaj `npm run preview`.

## Wdrożenie na Cloudflare Pages

Aplikacja to statyczne pliki z `dist/`. Cloudflare Pages buduje je z repozytorium po każdym pushu do `main`. W repozytorium nie ma sekretów ani zmiennych środowiskowych; konfiguracja to:

| Co                      | Gdzie                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Polecenie builda        | `npm run build`                                                                            |
| Katalog wynikowy        | `dist`                                                                                     |
| Wersja Node.js          | z pliku `.nvmrc` (Pages czyta go sam)                                                      |
| Nagłówki bezpieczeństwa | `public/_headers`, kopiowany do `dist/_headers`                                            |
| SPA fallback            | automatyczny: w `dist` nie ma `404.html`, więc Pages kieruje każdą ścieżkę do `index.html` |

### Krok po kroku (jednorazowo)

1. Zaloguj się na [dash.cloudflare.com](https://dash.cloudflare.com/) (konto Free wystarczy).
2. Przejdź do **Workers & Pages**, wybierz **Create application** > **Pages** > **Connect to Git**.
3. Zaloguj się do GitHuba i zezwól Cloudflare Pages na dostęp do repozytorium z Bunndly (wystarczy to jedno repozytorium). Wybierz je z listy i kliknij **Begin setup**.
4. W **Set up builds and deployments**:
   - **Project name:** np. `bunndly`. Z niego powstanie adres `https://bunndly.pages.dev`.
   - **Production branch:** `main`.
   - **Framework preset:** `None` (albo `React (Vite)`; ważne są dwa pola niżej).
   - **Build command:** `npm run build`.
   - **Build output directory:** `dist`.
   - **Root directory:** zostaw puste.
   - **Environment variables:** nie dodawaj żadnych.
5. Kliknij **Save and Deploy** i poczekaj na koniec builda (ok. 1–2 minuty). Dostaniesz adres `https://<project>.pages.dev`.
6. **Zanim zaczniesz korzystać ze strony, włącz Cloudflare Access** (następna sekcja). Do tego czasu strona jest publiczna.
7. Sprawdź nagłówki: otwórz stronę, w narzędziach deweloperskich (F12) zakładka **Network** > żądanie strony głównej > **Response Headers**. Powinny tam być `content-security-policy`, `x-frame-options: DENY`, `referrer-policy: no-referrer`, `x-content-type-options: nosniff` i `permissions-policy`. W zakładce **Console** nie powinno być błędów CSP.

Od tej chwili każdy merge do `main` wdraża się sam. Pushe na inne gałęzie tworzą wdrożenia podglądowe (`<hash>.<project>.pages.dev`). Jeśli ich nie chcesz, w **Settings** > **Builds & deployments** ustaw kontrolę gałęzi podglądowych (preview branch control) na **None**.

### Wersja Node.js

Pages bierze wersję z `.nvmrc`. Jeśli build zgłosi błąd wersji Node, dodaj w **Settings** > **Environment variables** zmienną `NODE_VERSION` z tą samą wartością co w `.nvmrc`. To nie jest sekret.

### Vercel (alternatywa, bez konfiguracji w repo)

Da się też wdrożyć na Vercel Hobby (SPEC 8.3), ale plan Hobby jest tylko do użytku osobistego i niekomercyjnego, a Vercel nie ma darmowej ochrony hasłem całego projektu (patrz [SECURITY.md](SECURITY.md#wersja-hostowana)). Repozytorium nie zawiera konfiguracji dla Vercel; rekomendujemy Cloudflare.

## Cloudflare Access: dostęp tylko dla Ciebie

Cloudflare Access (Zero Trust, plan Free) wymaga logowania przed wejściem na stronę. Według dokumentacji Cloudflare przycisk w ustawieniach Pages chroni najpierw tylko wdrożenia podglądowe, więc adres `*.pages.dev` trzeba dodać osobno.

**A. Sposób logowania: kod jednorazowy na e-mail**

1. W panelu Cloudflare przejdź do **Zero Trust**. Przy pierwszym wejściu wybierz nazwę zespołu i plan **Free**.
2. **Zero Trust** > **Integrations** > **Identity providers** > **Add new identity provider** > **One-time PIN**. Zapisz.

**B. Ochrona wdrożeń podglądowych i adresu `*.pages.dev`**

1. **Workers & Pages** > Twój projekt > **Settings** > **General** > **Enable access policy**. To chroni wdrożenia podglądowe (`*.<project>.pages.dev`).
2. Kliknij **Manage** przy utworzonej polityce. Otworzy się **Zero Trust** > **Access** > **Applications** z aplikacją Twojego projektu.
3. Wybierz aplikację > **Configure**. W **Public hostname**, w polu **Subdomain**, usuń gwiazdkę (`*`) i zapisz. Jeśli pojawi się błąd, zmień też **Application name**, np. na `bunndly-prod`. Teraz chroniony jest główny adres `<project>.pages.dev`.
4. Wróć do projektu Pages: **Settings** > **General** i jeszcze raz wybierz **Enable access policy**. Powstanie druga aplikacja dla wdrożeń podglądowych.
5. W **Zero Trust** > **Access** > **Applications** powinny być dwie aplikacje: dla `<project>.pages.dev` i dla `*.<project>.pages.dev`.

**C. Tylko Twój e-mail**

W każdej z dwóch aplikacji otwórz politykę (**Policies**) i ustaw:

- **Action:** `Allow`;
- **Include:** `Emails` z Twoim adresem e-mail (tylko jednym);
- zapisz.

**D. Sprawdzenie**

Otwórz `https://<project>.pages.dev` w oknie prywatnym. Powinna się pokazać strona logowania Cloudflare Access. Po wpisaniu Twojego e-maila przyjdzie kod, a po jego wpisaniu otworzy się Bunndly. Inny adres e-mail nie dostanie dostępu.

**Własna domena (opcjonalnie):** domenę dodajesz w projekcie Pages (**Custom domains**). Według dokumentacji Cloudflare nie da się dodać domeny, na której Access jest już włączony, więc najpierw dodaj domenę, a potem w **Zero Trust** > **Access** > **Applications** > **Create new application** > **Self-hosted** dodaj publiczny hostname tej domeny z taką samą polityką jak w kroku C.

## Pierwsze kroki w aplikacji

1. **Utwórz flotę:** na ekranie startowym **Create a new fleet**. Podaj liczbę portfeli (domyślnie 30), nazwę floty i hasło (min. 12 znaków; wskaźnik siły podpowiada). Kliknij **Create the fleet** i poczekaj na szyfrowanie.
2. **Zapisz plik floty:** **Save the fleet file** i wskaż folder (w Chrome i Edge; w innych przeglądarkach plik się pobierze). Plik `<nazwa>.keystore.json` jest zaszyfrowany.
3. **Kopia zapasowa mnemonika** (w aplikacji „recovery phrase”)**:** **Back up the recovery phrase**, wpisz hasło, potwierdź ostrzeżenie i zapisz plik offline. To jedyny sposób na odzyskanie floty bez pliku lub bez hasła.
4. **Klucze API:** **Settings** > wpisz klucz Helius (i ewentualnie Jupiter; bez niego aplikacja używa planu Keyless) > **Save settings** > **Save the updated fleet file**.
5. **Test połączeń:** w **Settings** kliknij **Test connections**. Zobaczysz wynik i czas dla Helius HTTP, Helius WebSocket i Jupitera oraz nagłówki limitów Jupitera.
6. **Zasil portfele:** na ekranie **Dashboard** każdy portfel ma w wierszu skrócony adres (4 pierwsze i 4 ostatnie znaki), ikonę kopiowania pełnego adresu i ikonę eksploratora. Kliknięcie skróconego adresu otwiera okienko z kodem QR i pełnym adresem. Wyślij SOL z własnego portfela na wybrane adresy. Salda odświeżają się co ok. 12 s.
7. **Tabela floty:** wpisz kwotę zakupu portfela w kolumnie **Buy amount** (w SOL albo jako % salda; przycisk obok pola przełącza jednostkę) i naciśnij Enter albo wyjdź z pola: kwota od razu zapisuje się w sejfie. Puste pole oznacza wartość domyślną floty. Kolumny **Priority fee** i **Slippage** pokazują wartości kupna (zielona plakietka) i sprzedaży (czerwona). Slippage, część sprzedaży i kwotę zmienisz przyciskiem edycji w wierszu (**Trade settings**) albo przyciskiem **Edit selected** dla wszystkich zaznaczonych portfeli naraz: puste pole zostawia obecną wartość, „Auto” to Auto, a „Default” przywraca wartość floty. Wartości domyślne floty są w Ustawieniach (**Trade defaults**). W trakcie zakupu, sprzedaży albo uzbrojonej obserwacji pola portfeli z tej akcji są wyłączone. Zaznacz portfele, które mają brać udział w zakupie (pole wyboru w wierszu; pole w nagłówku zaznacza albo odznacza wszystkie portfele widoczne w tabeli) i zapisz zaznaczenie przyciskiem **Save table changes**. Zakładki nad tabelą (**All wallets**, **Selected**, **In flight**, **Filled**, **Needs attention**) i pole **Search wallets** zawężają listę; kliknięcie nagłówka **Wallet**, **Balance**, **Buy amount** albo **Tokens** sortuje tabelę. Rezerwa (saldo − kwota) musi wynosić co najmniej `MIN_RESERVE_SOL` (domyślnie 0,015 SOL); za małą rezerwę aplikacja opisuje pod polem kwoty. Na koniec **Save the updated fleet file**.
8. **Kolejne portfele:** **Create wallets** nad tabelą, wpisz liczbę, **Create**, potem **Save the updated fleet file**. Nowe portfele nazywają się **Wallet N** (numer od 0); portfele z wcześniej zapisanych plików zachowują swoje nazwy (np. W01).
9. **Saldo tokenu:** wklej adres mintu w pole **Target** na pasku celu. Gdy aplikacja rozpozna mint, tabela pokaże kolumnę z saldem tokenu.
10. **Później:** **Open a fleet file** > wybierz plik > sprawdź podgląd adresów > wpisz hasło. Po 15 minutach bezczynności flota blokuje się sama.

## Sieć: Mainnet i Devnet

W nagłówku, na każdym ekranie, jest przełącznik **Mainnet / Devnet**. Nowa flota pracuje na Mainnecie.

1. **Przełączenie:** otwórz flotę i kliknij **Devnet** albo **Mainnet**. Sieć zmienia się od razu: salda są czytane od nowa, a linki do transakcji prowadzą do stron wybranej sieci.
2. **Zapis:** sieć jest ustawieniem floty, więc po przełączeniu kliknij **Save the fleet file with the new network**. Stary plik otworzy flotę na poprzedniej sieci.
3. **Kiedy się nie da:** w trakcie zakupu, przy uzbrojonym watcherze i gdy czeka niezapisany plik floty. Aplikacja mówi, co trzeba najpierw zrobić.
4. **Devnet służy do testów:** zakup (**Buy**) i watcher (**Arm**) są tam wyłączone, bo Jupiter działa tylko na Mainnecie; aplikacja nie wysyła wtedy do Jupitera żadnego zapytania. **Test connections** sprawdza na Devnecie sam Helius.
5. **Klucz Helius:** aplikacja używa na obu sieciach tego samego klucza z **Settings**. Własne adresy RPC i WebSocket z **Settings** działają tylko na tej sieci, na którą wskazuje ich host (`devnet.helius-rpc.com` to Devnet, każdy inny to Mainnet); na drugiej sieci aplikacja używa adresu zbudowanego z klucza.
6. **Powrót na Mainnet z wyłączonym DRY-RUN** wymaga potwierdzenia, bo następny zakup wyda prawdziwe SOL.

Sieć jest też w dzienniku operacji (kolumna `network` w CSV i JSON) i w dialogach potwierdzenia trybu na żywo.

## Zakup: tryb A

Tryb A kupuje token od razu portfelami zaznaczonymi w tabeli, które mają kwotę kupna (w SOL albo jako % salda; portfel z rezerwą poniżej `MIN_RESERVE_SOL` jest pomijany). Każdy portfel kupuje za swoją kwotę (procent liczony z salda odczytanego na starcie), najwyżej raz.

Ekran **Dashboard** ma od góry (makieta v2, D-054): górny pasek z przełącznikiem **DRY-RUN** i chipem salda floty (suma wszystkich portfeli; kliknięcie czyta salda od nowa), pasek celu z polem **Target**, stanem obserwacji i przyciskiem **Arm**, zakładki grup i filtrów, pasek narzędzi z **Create wallets**, **Edit selected** (kwota, slippage i część sprzedaży dla zaznaczonych portfeli), trybem wykonania i przyciskami **Buy**, **Sell**, **Stop**, tabelę portfeli i pasek podsumowania. Dziennik operacji i lista wykryć są na ekranie **Activity**. Przycisk, który nie może teraz zadziałać, jest wyłączony, a zdanie pod paskiem celu (i opis przycisku) mówi dlaczego. **Sell** (skrót **S**) sprzedaje token z pola celu zaznaczonymi portfelami: każdy portfel sprzedaje ustawioną dla niego część salda tokenu (domyślnie 100%). Sprzedaż czyta najpierw salda tokenu, więc wymaga klucza Helius, także w DRY-RUN, i nie rusza, gdy watcher jest uzbrojony. W trybie na żywo dialog **Sell in live mode?** podaje liczbę portfeli i sprzedawaną część i czeka na **Yes, sell**.

Nad tabelą są **zakładki grup portfeli**: każda podaje liczbę portfeli, sumę SOL i stan grupy (**Idle**, **Armed**, **Buying**, **Selling**, **Stopped**). Pasek komend działa w wybranej grupie i każda grupa pamięta własny cel, więc jedną grupę można uruchomić, a inna w tym czasie stoi. W zakładce **All** przy kilku grupach komendy paska są wyłączone, a przyciski **Buy** i **Sell** w wierszu działają w grupie tego portfela. **Move to group** przenosi zaznaczone portfele do innej albo nowej grupy, **Rename** zmienia nazwę grupy, a **Delete group** oddaje jej portfele pierwszej grupie. Grupy, która działa, nie da się zmienić ani zmienić kwot jej portfeli, dopóki nie skończy. Zmiany grup trzeba potem zapisać w pliku floty (D-049).

1. **Cel:** wklej w pole **Target** adres tokenu. Aplikacja sama sprawdza w łańcuchu, czym jest adres, i pokazuje etykietę: **Token · SPL**, **Token · Token-2022** albo **Creator wallet**. Adres konta tokenowego, programu albo innego konta zostaje odrzucony z opisem przy polu. Dopiero mint włącza **Buy**.
2. **Podsumowanie:** pasek pod tabelą pokazuje zaznaczone portfele i łączną kwotę do wydania (**Planned buy**). Limit zapytań Jupitera, z którym pójdzie zakup, jest w **Settings** przy planie Jupitera. Zakup wydaje kwoty zapisane w sejfie, więc niezapisane zmiany kwot blokują **Buy** do **Save table changes**. Zmiana zaznaczenia nie wymaga zapisu.
3. **DRY-RUN (domyślnie):** przełącznik **DRY-RUN** w górnym pasku jest włączony. Aplikacja pyta Jupitera o cenę (`/order`), sprawdza i podpisuje transakcje, ale **niczego nie wysyła**. Każdy portfel kończy jako „DRY-RUN” z wyceną i czasami. Tak sprawdzisz klucze, limity i salda bez wydawania środków.
4. **Tryb na żywo:**
   - wyłączasz przełącznik **DRY-RUN** w górnym pasku Dashboardu;
   - dialog podaje kwotę i liczbę portfeli i wymaga potwierdzenia **Yes, switch to live mode**;
   - na innych ekranach górny pasek pokazuje **Mode: LIVE**;
   - tryb na żywo wymaga klucza Helius, bo przed każdym ponowieniem aplikacja sprawdza w łańcuchu, czy poprzednia transakcja nie wylądowała;
   - powrót: włącz przełącznik **DRY-RUN**, bez potwierdzenia;
   - tryb zapisuje się w pliku floty, więc potem kliknij **Save the updated fleet file**.
5. **Buy** (skrót **B**, poza polem tekstowym): start zaznaczonymi portfelami; ich wiersze od razu pokazują „Queued”. Gdy aplikacja odmówi startu, wiersze wracają do poprzedniego stanu, a pod paskiem pojawia się powód. Przycisk **Buy** w wierszu (zielony) kupuje tylko tym jednym portfelem, a **Sell** (czerwony) sprzedaje jego ustawioną część salda tokenu; obok jest **Trade settings**. W trybie na żywo dialog **Buy in live mode?** podaje liczbę portfeli, łączną kwotę, sieć i tryb, a zakup rusza dopiero po **Yes, buy**. **Nie zamykaj ani nie przeładowuj karty** do końca zakupu: klucze i zakup działają tylko w niej, a przeglądarka zapyta przed zamknięciem.
6. **Postęp:**
   - pole **Fleet fill** w pasku podsumowania pokazuje potwierdzone, w trakcie oraz nieudane albo pominięte, a także czas od startu do pierwszego i do ostatniego potwierdzenia;
   - w tabeli floty kolumna **Status** pokazuje stan zakupu portfela (kolor i tekst), a pod nim ostatni komunikat portfela: powód albo wynik sprawdzenia saldem tokenu („Chain: confirmed” albo ostrzeżenie). Kolumna **Last transaction** (w oknie od 1500 px) ma skrócony podpis z linkiem do eksploratora z **Settings** i czas od startu. Liczba prób, wydany SOL i cena (SOL za token) są w dzienniku operacji;
   - „Checking the chain” znaczy, że wynik wysłanej transakcji nie jest jeszcze znany. Portfel nie spróbuje ponownie, dopóki łańcuch nie pokaże, że transakcja nie wylądowała.
7. **Stop** (skrót **Esc**)**:** przycisk na pasku narzędzi, aktywny przez cały zakup. Zatrzymuje nowe zapytania; transakcje już wysłane są śledzone do końca, a reszta portfeli kończy jako „Skipped”.
8. **Dziennik operacji:** ekran **Activity**, sekcja **Operations log**, przyciski **Download CSV** i **Download JSON**:
   - każda zmiana stanu każdego portfela z czasem, kwotami (lamporty i jednostki tokena, bez zaokrągleń), routerem, sygnaturą i powodem;
   - bez kluczy i podpisanych transakcji;
   - dziennik żyje do zamknięcia karty.

## Zakup: tryb B

Tryb B obserwuje portfel twórcy i kupuje sam, gdy ten portfel utworzy token. Przełącznik DRY-RUN, **Stop**, postęp i dziennik są te same co w trybie A.

1. **Adres twórcy:** wklej adres portfela twórcy w to samo pole **Target**; etykieta pokaże **Creator wallet**, a obok pojawi się **Arm**. Gdy to adres z Twojej floty, ekran to pokaże. **Buy** czeka wtedy na token tego twórcy: najnowsze wykrycie pojawia się na pasku celu jako etykieta **Detected …**, a **Buy** kupuje ten token.
2. **Po wykryciu** (**Settings** > **Mode**)**:**
   - **one-shot** (domyślny): pierwszy wykryty token rozbraja watcher, a zakup trwa dalej;
   - **continuous**: watcher zostaje uzbrojony i kupuje każdy kolejny token twórcy, jeden zakup po drugim. Włączenie wymaga potwierdzenia, a zmiana zapisuje się w pliku floty.
3. **Arm:**
   - wymaga zapisanej tabeli, klucza Helius i co najmniej jednego gotowego portfela; przycisk mówi, czego brakuje;
   - watcher kupuje portfelami zaznaczonymi w chwili uzbrojenia; późniejsza zmiana zaznaczenia go nie zmienia;
   - w trybie na żywo dialog **Arm the watcher in live mode?** podaje liczbę portfeli, kwotę na jeden token, sieć i tryb i wymaga potwierdzenia **Yes, arm**; w DRY-RUN nic nie jest wysyłane, więc potwierdzenia nie ma;
   - przed uzbrojeniem aplikacja czyta salda portfeli, a potem odświeża je co 30 s, żeby zakup po wykryciu nie czekał na sieć.
4. **Stan połączenia** na pasku celu: „Connecting…”, „Connected”, „Reconnecting (attempt n)” albo „Disconnected”, z czasem od ostatniej wiadomości z Helius.
5. **Alarm:** utrata połączenia przy uzbrojonym watcherze pokazuje czerwony baner i co 3 s gra krótki dźwięk, dopóki połączenie nie wróci albo nie klikniesz **Mute**. Po powrocie połączenia aplikacja nadrabia przerwę: sprawdza transakcje twórcy z czasu rozłączenia.
6. **Ekran i karta:**
   - uzbrojony watcher prosi przeglądarkę, żeby ekran nie gasł (Wake Lock), i ponawia prośbę po powrocie do karty. Gdy przeglądarka odmówi, pasek celu pokaże „The screen may turn off”: wyłącz wtedy usypianie komputera;
   - **nie zamykaj ani nie przeładowuj karty**, dopóki watcher jest uzbrojony: obserwacja i zakup działają tylko w niej, a przeglądarka zapyta przed zamknięciem;
   - uzbrojony watcher wstrzymuje automatyczną blokadę; ręczna blokada wymaga wcześniejszego **Disarm**;
   - uzbrojony watcher zamraża ustawienia: tryb DRY-RUN/na żywo, tabelę, portfele i **Settings** zmienisz dopiero po **Disarm**, bo zakup po wykryciu idzie z tym, co potwierdziłeś przy uzbrojeniu.
7. **Wykrycia:** tabela **Detections** na ekranie **Activity** pokazuje czas, mint (skrócony, z przyciskiem **Copy**), grupę, źródło (pump.fun, LaunchLab, DBC, InitializeMint), ścieżkę, czas reakcji i weryfikację:
   - ścieżka **log**: mint odczytany od razu z logu transakcji (pump.fun), zakup rusza w kilka milisekund;
   - ścieżka **transaction**: mint odczytany z pełnej transakcji, gdy sieć ją potwierdzi (zwykle po kilkuset ms; LaunchLab, DBC, inne tokeny);
   - **catch-up**: transakcja z przerwy w połączeniu;
   - **verified**: pełna transakcja potwierdziła mint z logu;
   - „transaction from before arming”: stary token twórcy, bez zakupu.
8. **Czas reakcji** to czas od odebrania logu do wysłania pierwszego zapytania do Jupitera; trafia też do dziennika. Postęp zakupu z wykrycia liczy czasy od wykrycia.
9. **Disarm:** zamyka połączenie z Helius i usuwa wykrycia czekające w kolejce. Trwający zakup zatrzymuje tylko **Stop**.
10. **Limity Jupitera przy wielu portfelach:** każdy portfel to jedno zapytanie `/order`. Bez klucza (Keyless) aplikacja wysyła najwyżej 27 zapytań na minutę, na planie Free 54. Przy 30 portfelach Keyless kupi więc pierwszymi 27 portfelami od razu, a pozostałymi po upływie minuty. Do szybkiego zakupu całą flotą potrzebny jest wyższy plan i jego klucz.

## Dla programistów

### Kontrole przed PR

> **CI w GitHub Actions jest wstrzymane do odwołania** (brak minut, `docs/DECISIONS.md` D-012). Workflow da się uruchomić tylko ręcznie. Przed każdym PR uruchom lokalnie i wklej wynik do opisu PR:

```bash
npm ci && npm run lint && npm run typecheck && npm test && npm run build && npm run format:check && npm audit --audit-level=high
```

### Skrypty

| Skrypt                 | Co robi                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `npm run dev`          | serwer deweloperski Vite (bez nagłówka CSP)                |
| `npm run build`        | typecheck + statyczny build do `dist/` (z `dist/_headers`) |
| `npm run preview`      | podgląd zbudowanej wersji z nagłówkami z `public/_headers` |
| `npm run lint`         | ESLint (type-aware, reguły bezpieczeństwa)                 |
| `npm run typecheck`    | `tsc -b` bez emisji                                        |
| `npm test`             | Vitest (Node; testy UI w jsdom), bez prawdziwej sieci      |
| `npm run test:sim`     | długa symulacja niezmienników executora (5000 ziaren)      |
| `npm run format`       | Prettier, zapis zmian                                      |
| `npm run format:check` | Prettier, tylko sprawdzenie                                |

### Struktura

```
src/
  core/        czyste TS, bez DOM: derywacja, keystore, ustawienia, typy
  chain/       klient RPC (Helius + fallback), salda, test połączeń
  jupiter/     klient Swap API V2
  watcher/     WebSocket, detektory launchpadów (detectors/), deduplikacja
  executor/    kolejka, limiter, potok, retry, idempotencja
  direct/      zakup bezpośredni przez program launchpadu (meteora-dbc/: wycena i instrukcje, D-053)
  worker/      Web Worker sejfu (klucze tylko tutaj)
  storage/     File System Access API + fallback
  ui/          komponenty React
public/_headers  nagłówki bezpieczeństwa (Cloudflare Pages i vite preview)
deploy/        parser _headers i plugin vite preview
tests/         testy jednostkowe i integracyjne (Vitest)
docs/          SPEC.md, DECISIONS.md
```

### Bezpieczeństwo w kodzie

Klucze prywatne i mnemonik nigdy nie trafiają do `localStorage`, `sessionStorage`, IndexedDB, logów ani konsoli (SPEC 6). Lint blokuje te API w `src/`; jedyny wyjątek to zaszyfrowana zapamiętana flota w IndexedDB, zapisywana przez worker (D-051). Pliki `*.keystore.json` są w `.gitignore`. Szczegóły: [SECURITY.md](SECURITY.md).

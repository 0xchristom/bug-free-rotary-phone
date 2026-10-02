# Bezpieczeństwo Bunndly

Bunndly zarządza kluczami prywatnymi portfeli z prawdziwymi środkami. Ten dokument opisuje, gdzie są sekrety, czego aplikacja nie robi, przed czym chroni i przed czym nie umie chronić. Szczegóły techniczne i uzasadnienia są w [`docs/DECISIONS.md`](docs/DECISIONS.md) (numery D-0xx poniżej).

## Gdzie są klucze

| Co                                                    | Gdzie                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mnemonik (24 słowa) i klucze prywatne portfeli        | Jawnie **wyłącznie w pamięci Web Workera** („sejf”) po odblokowaniu, jako bajty zerowane przy blokadzie (D-013). Nigdy w `localStorage`, `sessionStorage`, IndexedDB, URL, logach, konsoli ani komunikatach błędów (SPEC 6.1, reguły ESLint D-004). |
| Plik floty `<nazwa>.keystore.json`                    | Na dysku użytkownika, w wybranym folderze. Sekrety są zaszyfrowane: scrypt (N=2^17, r=8, p=1) i AES-256-GCM z losowym IV; tag GCM wykrywa każdą zmianę (D-010, D-011). Jawna część zawiera tylko adresy publiczne i etykiety.                       |
| Klucze API (Helius, Jupiter) i własne URL-e z kluczem | Zaszyfrowane w pliku floty, w pamięci tylko w workerze. Do interfejsu trafia wyłącznie informacja, czy klucz jest ustawiony (D-016). Zapytania z kluczami wysyła worker (D-020, D-024).                                                             |
| Hasło floty                                           | Nigdzie. Worker trzyma tylko nieeksportowalny klucz AES z sesji (D-013).                                                                                                                                                                            |

- **Automatyczna blokada:** po 15 minutach bezczynności (ustawialne) worker zeruje klucze i porzuca klucz sesji. Blokada nie działa w trakcie uzbrojonej operacji (D-013).
- **Interfejs sejfu jest wyłącznie domenowy:** nie ma operacji „podpisz te bajty” ani „wydaj klucz bez hasła”, więc kod w wątku interfejsu nie wyciągnie klucza (D-013).
- **Eksport jawny** (mnemonik i klucze w czystym tekście, `.txt` albo `.json`) wymaga ponownego wpisania hasła, które worker sprawdza pełną derywacją scrypt, oraz potwierdzenia ostrzeżenia. Plik od razu się pobiera, a jego treść nie trafia do stanu aplikacji ani do strony (D-023). **Taki plik daje pełny dostęp do środków:** trzymaj go offline.

## Czego aplikacja nie robi

- **Nie ma backendu ani serwera.** To statyczne pliki; klucze nigdy nie opuszczają przeglądarki (SPEC 2.1).
- **Nie wysyła kluczy prywatnych, mnemonika ani hasła** nigdzie. Do Helius i Jupitera trafiają tylko adresy publiczne, a od sprintu 3 także podpisane transakcje (SPEC 6.2).
- **Łączy się tylko z** Helius (`*.helius-rpc.com`, HTTPS i WSS), `api.jup.ag` i awaryjnym `api.mainnet.solana.com`. Wymusza to nagłówek CSP (`connect-src`, D-025).
- **Nie ma telemetrii,** analityki, trackerów ani skryptów z zewnętrznych serwerów (SPEC 6.8).
- **Nie zapisuje kluczy API w zmiennych builda ani w repozytorium** (SPEC 2.1, 8.4).

## Model zagrożeń

### XSS (wstrzyknięcie skryptu do strony)

Ochrona:

- ścisłe CSP z `public/_headers`: tylko skrypty z własnej domeny, bez `unsafe-inline` i `unsafe-eval`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'` (D-025);
- React escapuje wszystkie dane, a aplikacja nie wstawia surowego HTML; kod QR jest rysowany jako SVG z macierzy (D-018);
- dane z sieci (np. odpowiedzi Jupitera) są walidowane przed użyciem (D-024).

Ryzyko resztkowe: wstrzyknięty skrypt działa w wątku interfejsu. Nie odczyta kluczy z workera, ale może wywoływać operacje sejfu dostępne dla interfejsu, w tym od sprintu 3 zakup w granicach ustawionego max spend. Dlatego aplikacja nie ładuje niczego z zewnątrz.

### Łańcuch dostaw (zależności)

- Wersje przypięte dokładnie w `package.json` i w `package-lock.json`; `npm audit --audit-level=high` przy każdym PR.
- Mało zależności. Kryptografia z audytowanych paczek `@noble/hashes`, `@noble/curves`, `@scure/bip39` i `@scure/base` (Paul Miller) oraz z WebCrypto (D-009, D-010). Wyjątek: `micro-key-producer` (SLIP-0010) nie ma własnego audytu. Używamy tylko krótkiego modułu `slip10.js` zbudowanego na audytowanych `@noble/*`; jego kod jest przeczytany w całości i sprawdzony oficjalnymi wektorami (D-009).
- Każda nowa paczka wymaga uzasadnienia w DECISIONS.

### Złośliwe rozszerzenia przeglądarki

Rozszerzenie z dostępem do strony może czytać i zmieniać to, co widać w interfejsie, i podsłuchać hasło przy wpisywaniu. **Aplikacja nie może się przed tym obronić.** Zalecenie: używaj Bunndly w osobnym profilu przeglądarki bez rozszerzeń.

### Utrata pliku floty

Bez pliku `keystore.json` flotę da się odtworzyć tylko z mnemonika. Zrób kopię zapasową mnemonika przyciskiem „Zrób kopię zapasową mnemonika” po utworzeniu floty, a także kopię samego pliku floty (jest zaszyfrowany, więc kopia nie ujawnia kluczy).

### Zapomniane hasło

**Hasła nie da się odzyskać ani zresetować.** Plik jest zaszyfrowany kluczem z hasła (scrypt). Bez hasła jedyną drogą jest import mnemonika do nowej floty z nowym hasłem.

### Przechwycenie klucza API

Klucze API są zaszyfrowane w pliku i używane tylko w workerze. Klucz Helius jest jednak częścią URL zapytań (tak działa Helius), więc widać go w narzędziach deweloperskich przeglądarki na tym komputerze. Klucz API daje dostęp do płatnej usługi, nie do środków w portfelach.

### Wersja hostowana

Wersja wdrożona na Cloudflare Pages **musi być chroniona przez Cloudflare Access** (logowanie tylko dla właściciela, SPEC 6.6). Instrukcja jest w [README](README.md#cloudflare-access-dostęp-tylko-dla-ciebie). Bez tego każdy może otworzyć stronę. Kluczy nikt z niej nie wyciągnie, bo są tylko w Twoim pliku i Twojej przeglądarce, ale ograniczamy powierzchnię ataku.

Vercel Hobby nie ma darmowej ochrony hasłem całego projektu. Jeśli używasz Vercel, strona jest publiczna; dlatego rekomendujemy Cloudflare.

## Zgłaszanie problemów bezpieczeństwa

Nie zakładaj publicznego issue. Zgłoś problem prywatnie właścicielowi repozytorium przez GitHub (zakładka **Security** > **Report a vulnerability**) albo bezpośrednio do właściciela projektu. Opisz, jak odtworzyć problem. Nie dołączaj prawdziwych kluczy, mnemonika ani pliku floty z prawdziwymi środkami.

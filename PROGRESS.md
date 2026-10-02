# Postęp

Jeden wpis na zakończone zadanie, najnowsze na górze.

Format: `RRRR-MM-DD · BUNNDLY-<n> · <co działa>`

---

- 2026-10-02 · BUNNDLY-17 · Szkielet UI: ekrany Start, Kreator, Flota i Ustawienia (bez routingu i URL), pasek z „Zablokuj” i informacją o auto-locku, odpytywanie statusu sejfu (auto-lock widoczny ≤ 5 s), zgłaszanie aktywności, natychmiastowe odrzucanie żądań przy awarii workera; testy UI w jsdom (Testing Library), testy core dalej w Node.
- 2026-10-02 · BUNNDLY-8 · `src/storage`: zapis `<nazwa>.keystore.json` do wybranego folderu (File System Access API, potwierdzenie nadpisania) albo pobranie; odczyt przez `showOpenFilePicker` lub `<input type=file>`, limit 1 MB przed odczytem; kody błędów po polsku. Sprawdzone w Chromium (OPFS, pobranie, input).
- 2026-10-02 · BUNNDLY-7 · Sejf w Web Workerze (`src/worker`): create, unlock, lock, status, saveSettings, addWallets, setArmed, activity; auto-lock 15 min (wstrzymany, gdy armed); klient z timeoutem; `KeystoreSession` w `core/keystore` (ponowne szyfrowanie bez hasła). Sprawdzone w Chromium.
- 2026-10-02 · BUNNDLY-18 · CI wstrzymane do odwołania: `ci.yml` tylko `workflow_dispatch` (brak minut GitHub Actions), lokalne kontrole przed PR opisane w README i D-012.
- 2026-10-02 · BUNNDLY-6 · `src/core/keystore/format.ts` i `keystore.ts`: plik v1 wg SPEC 3.1, `parseKeystoreFile` (ścisła walidacja, limit 1 MB), `createKeystore` / `buildKeystore` / `openKeystore` z kontrolą spójności adresów (`KEYSTORE_TAMPERED`); 78 testów.
- 2026-10-02 · BUNNDLY-5 · `src/core/keystore/crypto.ts`: `encryptSecrets` / `decryptSecrets` (scrypt N=2^17 + AES-256-GCM, WebCrypto), walidacja parametrów przed scrypt, hasło NFKC min. 12 znaków; 37 testów na domyślnych parametrach.
- 2026-10-02 · BUNNDLY-4 · `src/core/derivation.ts`: mnemonik BIP39 (generowanie 24 słów, import 12–24, normalizacja), derywacja `m/44'/501'/i'/0'` zgodna z Phantomem (wektory Andy'ego + oficjalne SLIP-0010), eksport klucza base58 (64 B), `wipe`; 45 testów.
- 2026-10-02 · BUNNDLY-3 · `src/core/errors.ts`: `AppError` z typowanym `code` i `cause`, komunikaty po polsku, `isAppError`, `toUserMessage` (bez wycieku treści nieznanych błędów); 24 testy.
- 2026-10-02 · BUNNDLY-2 · CI w GitHub Actions (lint, typecheck, test, build, npm audit) na PR i push do main; akcje przypięte do SHA; engines.node >=22.13.
- 2026-10-02 · BUNNDLY-1 · Szkielet Vite 8 + React 19 + TS 6.0, struktura katalogów wg SPEC 4, ESLint z regułami bezpieczeństwa, Prettier, Vitest (test dymny). lint / typecheck / test / build przechodzą.

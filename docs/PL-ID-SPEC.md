# Specyfikacja polskiego dowodu osobistego (dla OCR/walidacji)

Dokument referencyjny opisujący układ pól, formaty i cechy zabezpieczające polskiego
**dowodu osobistego**, z mapowaniem na logikę ekstrakcji i walidacji idswyft.

## Źródła (autorytatywne)

| Źródło | Co opisuje |
|--------|-----------|
| **Rozporządzenie MSWiA z 23.07.2025 r.**, Dz.U. 2025 poz. 1031 (Warszawa, 29.07.2025) | Aktualny **wzór dowodu osobistego** (załącznik nr 1), wymogi fotografii, tryb wydawania/utraty/unieważnienia. Wdraża rozporządzenie UE 2025/1208 z 12.06.2025 (poprawa zabezpieczeń dowodów obywateli UE). |
| Ustawa z 6.08.2010 r. o dowodach osobistych (Dz.U. 2022 poz. 671 z późn. zm.) | Podstawa prawna (art. 54 deleguje wzór). |
| PRADO (Rada UE) **POL-BO-03001**, **POL-BO-02003** | Publiczne wzory wcześniejszych wariantów (polwęglan 2019+ / wariant 2015). Strona blokuje boty (HTTP 403) — niedostępna automatycznie; opisana z wiedzy ogólnej. |

> **Uwaga:** wzór z poz. 1031 (2025) to najnowszy. W obiegu są równolegle starsze
> warianty (2015, 2019) — układ pól i formaty numeru są zgodne, więc reguły OCR
> obejmują wszystkie.

## Forma fizyczna

- Format karty **ID1**: **53,98 × 85,60 mm** (jak karta płatnicza).
- Materiał: **poliwęglan**, personalizacja **WIELKIMI LITERAMI**.
- Na rewersie nanoszony przy personalizacji **kod paskowy** (PDF417) zawierający
  **numer CAN** oraz **powtórzoną fotografię** posiadacza.

## Układ pól — AWERS (przód)

Czarne napisy, dwujęzyczne etykiety PL/EN:

| Pole (PL / EN) | Format / uwagi | Pole idswyft |
|----------------|----------------|--------------|
| NAZWISKO / SURNAME | wielkie litery, ogonki | `full_name` (część) |
| IMIONA / GIVEN NAMES | jedno lub więcej imion | `full_name` (część) |
| OBYWATELSTWO / NATIONALITY | `POLSKIE` → `POL` | `nationality` |
| DATA URODZENIA / DATE OF BIRTH | `DD.MM.RRRR` | `date_of_birth` |
| SERIA I NUMER DOKUMENTU / DOCUMENT NUMBER | **3 litery + 6 cyfr** (`^[A-Z]{3}\d{6}$`, np. `DFF362754`) | `document_number` |
| PŁEĆ / SEX | **`M`** (mężczyzna) / **`K`** (kobieta) | `sex` (`K`→`F`) |
| TERMIN WAŻNOŚCI / EXPIRY DATE | `DD.MM.RRRR` | `expiry_date` |
| PODPIS / SIGNATURE | lub `BRAK PODPISU / NO SIGNATURE` (osoby <12 lat lub niemogące podpisać) | — |
| NUMER CAN / CAN | 6 cyfr (Card Access Number, dostęp do warstwy elektronicznej) | — |

Cechy zabezpieczające awersu (nie-OCR): tło giloszowe z literami RP, godło RP, symbol
biometrii nadrukowany **farbą optycznie zmienną (OVI)**, transparentne litery „DO" w
**Braille'u**, dwuliterowy kod `PL` na niebieskim prostokącie otoczonym 12 żółtymi
gwiazdami (UE), mikrodruki, transparentny znak holograficzny, pole powtórzonej
fotografii + rok ważności, wypukłe linie giloszowe, nadruki **UV**.

## Układ pól — REWERS (tył)

| Pole (PL / EN) | Format / uwagi | Pole idswyft |
|----------------|----------------|--------------|
| NUMER PESEL / PERSONAL NUMBER | **11 cyfr**, walidowalna suma kontrolna; koduje datę ur. + płeć | `barcode_data.pesel` |
| MIEJSCE URODZENIA / PLACE OF BIRTH | miejscowość | `place_of_birth` |
| NAZWISKO RODOWE / FAMILY NAME | nazwisko rodowe | — |
| IMIONA RODZICÓW / PARENTS' GIVEN NAMES | imię ojca + matki | — |
| ORGAN WYDAJĄCY / ISSUING AUTHORITY | nazwa organu gminy | `issuing_authority` |
| SERIA I NUMER DOKUMENTU / DOCUMENT NUMBER | **powtórzony** numer z awersu (`^[A-Z]{3}\d{6}$`) | cross-check z awersem |
| DATA WYDANIA / DATE OF ISSUE | `DD.MM.RRRR` | `date_of_issue` |

Dodatkowo na rewersie: tło giloszowe (litery RP + napis `POLSKA`), mikrodruki,
**ciąg 15 transparentnych znaków alfanumerycznych** (cecha zabezpieczająca, ≠ MRZ),
nadruki UV oraz nadrukowany przy personalizacji **kod paskowy PDF417** (CAN + foto).

### MRZ

Polski dowód ma strefę **MRZ typu TD1** (**3 linie × 30 znaków**) **wyłącznie na rewersie**.
MRZ jest **autorytatywnym** źródłem dla idswyft (czystszy niż OCR pól):
- nazwisko, imiona, data urodzenia, płeć,
- numer dokumentu (`[A-Z]{3}\d{6}`),
- kod kraju `POL`.

PESEL **nie jest** częścią MRZ — odczytywany osobno z barcode/raw text rewersu.

## Konsekwencje dla pipeline'u idswyft

1. **Zawsze przekazuj `issuing_country: "PL"`** przy `initialize`. Bez tego engine idzie
   ścieżką `auto`, nie zna polskich etykiet i nie wyciągnie numeru/imienia z **przodu**
   (a MRZ jest tylko z tyłu). To była przyczyna „nie poznał polskiego dowodu".
2. **Przód jest „szumny"** dla OCR (giloszowe tło, OVI, hologram). Numer i imię z przodu
   bywają zniekształcone → engine ma tolerancyjne fallbacki (mylenia OCR:
   `O→0, I/L→1, S→5, B→8, Z→2, G→6`, tolerancja spacji w numerze).
3. **Tył (MRZ + barcode) jest autorytatywny.** Cross-validator preferuje tył; gdy tył
   nieczytelny, „MISSING ON BACK" nie blokuje (przód dostarcza dane).
4. **Płeć (`M`/`K`)** bywa sklejona z numerem dokumentu na przodzie (`DFF362754M`).
   Engine odcina sklejony marker płci (`^([A-Z]{3}\d{6})([MKF])$`) i ustawia `sex`
   (`K→F`, `M→M`). Numer pozostaje `DFF362754`.
5. **`OBYWATELSTWO`** bywa sklejone z datą urodzenia (`POLSKIE 19.07.1985`) — engine
   odcina końcową datę z pola obywatelstwa; `POLSKIE → POL`.
6. **PESEL** wyciągany osobno z rewersu do `barcode_data.pesel` (AML art. 36) — odrębny
   od numeru dokumentu.

## Mapowanie na kod

| Plik | Rola dla PL |
|------|-------------|
| `shared/src/providers/ocr/internationalIdFormats.ts` | format `PL` — etykiety, regex `^[A-Z]{3}\d{6}$` (dowód), `^[A-Z]{2}\d{7}$` (paszport) |
| `engine/src/routes/extract.ts` | fallbacki numeru/imienia/płci, strip sklejonego `M/K`, PESEL, strip daty z obywatelstwa |
| `engine/src/services/mrz.ts`, `backend/src/services/mrz.ts` | TD1 3×30, normalizacja `P0L→POL`, próg roku `yy≤50→2000s` |
| `backend/src/verification/cross-validator/{config,engine,normalizers}.ts` | tolerancja „MISSING ON BACK", `POLSKIE→POL` |
| `backend/src/.../NationalIdExtractor.ts` | polskie etykiety |

## Walidacja PESEL (referencja)

11 cyfr `RRMMDDPPPPK`. Miesiąc koduje stulecie (+20 dla 2000–2099, +40 dla 2100+, +60
dla 1800–1899). Cyfra 10 (P, przedostatnia) parzysta = kobieta, nieparzysta = mężczyzna —
**spójna z polem PŁEĆ**. Cyfra 11 = suma kontrolna (wagi `1,3,7,9,1,3,7,9,1,3`).
Może służyć do deterministycznego cross-checku DOB ↔ płeć ↔ numer dokumentu.

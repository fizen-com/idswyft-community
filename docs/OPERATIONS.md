# Operations / Runbook

Praktyczne procedury dla preprod (Fly) — analogicznie prod (GCP, przez `gcloud`/VM).

## Logi
```bash
fly logs -a idswyft-api-preprod              # API (auth, webhooki, cross-val)
fly logs -a idswyft-engine-preprod           # ENGINE (OCR, liveness — szczegóły per-check!)
fly logs -a idswyft-api-preprod --no-tail | grep -iE "liveness|Resend|restart"
```
> Liveness/OCR per-check (yaw, checki) są w logach **engine**, nie api.

## Restart maszyny / odświeżenie sekretu
```bash
fly secrets set KEY=VAL -a idswyft-api-preprod   # ustawia sekret + rolling restart
fly machine restart <id> -a idswyft-api-preprod
```
**Przejściowy „insufficient memory available" (capacity fra):** restart in-place bywa odrzucany, bo stara instancja trzyma RAM. Obejścia:
1. Maszyna ma auto-start → **hit endpoint** (`curl .../health`) budzi ją z czystego startu (RAM wolny) i ładuje nowy sekret.
2. Albo pętla ponawiająca `fly machine restart` co 30s.
3. Plan B: `flyctl deploy` (placement na innym hoście).

## Email / OTP
idswyft wysyła OTP **tylko przez Resend** (brak SMTP w kodzie).
- Skonfigurowane: `RESEND_API_KEY` + `EMAIL_FROM="Fizen <noreply@fizen.com>"`; domena `fizen.com` **verified** w Resend (DNS w Cloudflare, grey/DNS-only).
- Gdy działa: logi `Email sent via Resend: <id>`; OTP **nie** jest zwracany w odpowiedzi API.
- Gdy `RESEND_API_KEY` brak: API zwraca kod w body (`{code, self_hosted:true}`) i loguje — fallback dev.
- Wolny plan Resend: 3000/mc, 100/dzień, 1 domena, bez karty.

### Awaryjne wygenerowanie OTP (gdy mail nie działa)
Developer login:
```bash
curl -s -X POST https://idswyft-api-preprod.fly.dev/api/auth/developer/otp/send \
  -H "Content-Type: application/json" -d '{"email":"maciej@fizen.com"}'
# gdy email nieskonfigurowany → kod w odpowiedzi; gdy skonfigurowany → mail.
```
Reviewer/admin login: endpoint `/api/auth/reviewer/otp/send` (rate-limited).
Gdy rate-limit blokuje — można **wstrzyknąć własny kod** do `developer_otp_codes` (hash = `HMAC-SHA256(code, API_KEY_SECRET)`, `expires_at` w przyszłość, `used_at=null`).

## Wygenerowanie linku weryfikacji (test)
```bash
API=https://idswyft-api-preprod.fly.dev
KEY=ik_307eb9acc5192d1721a3693265d4aadabe94bc8f4bf3f14089f74e8798185363
USER=$(python3 -c "import uuid;print(uuid.uuid4())")
curl -s -X POST $API/api/v2/verify/initialize -H "Content-Type: application/json" -H "X-API-Key: $KEY" \
  -d "{\"user_id\":\"$USER\",\"document_type\":\"national_id\",\"issuing_country\":\"PL\",\"verification_mode\":\"full\"}"
# → verification_url = https://idswyft-web-preprod.fly.dev/user-verification?session=...
```
> Na telefonie `/user-verification` przekierowuje na `/verify/mobile` (natywny capture). Page Builder działa na obu.

## Dostęp do bazy preprod (Fly)
Brak psql lokalnie → przez kontener api (ma `pg` + `DATABASE_URL`):
```bash
# node-pg w kontenerze (przykład inspekcji)
fly ssh console -a idswyft-api-preprod -C "sh -lc 'cd /app/backend && node -e \"...\"'"
```
Prod (GCE VM): `gcloud compute ssh idswyft-postgres --tunnel-through-iap` → `docker exec pg psql -U idswyft -d idswyft`.

## Audyt schematu (po migracjach / przy podejrzeniu dryfu)
Metoda: sparsuj z `supabase/migrations/*.sql` wszystkie `ADD COLUMN IF NOT EXISTS` + kolumny z `CREATE TABLE`, porównaj z `information_schema.columns` w bazie, dodaj brakujące. Wynik z 2026-06-04 (preprod): **0 dryfu** (77 ADD COLUMN OK, 60 CREATE TABLE OK; jedyny „brak" = `api_key` celowo usunięty migracją 50).

## Znane pułapki
| Objaw | Przyczyna | Fix |
|-------|-----------|-----|
| `/restart` → ciche **409**, „Try Again" milczy | kod pisze `verification_requests.completed_at`, kolumny brak w migracjach; Supabase połyka błąd | migracja 61 (preprod ma; **prod NIE** — patrz DEPLOYMENT.md) |
| „Could not reach the API server" (prod) | URL-map LB bez host-rule `kyc-api`→api → oba hosty na web | dodać path-matcher/host-rule (zrobione) |
| `verification_url` wskazuje na host API, nie web | brak `FRONTEND_URL` | `fly secrets set FRONTEND_URL=...web...` |
| Polski dowód: puste imię/numer | brak `issuing_country: PL` (MRZ tylko z tyłu) | zawsze przekazuj `PL` przy initialize |
| OTP nie przychodzi | Resend: domena nieverified / brak `RESEND_API_KEY` | verify domeny w Resend; ustaw sekret |
| Liveness oblewa realną twarz | yaw zaniżony przez 2D landmarki | `MIN_YAW_DELTA` (już 5°), patrz CUSTOMIZATIONS §3 |
| `failed` przed liveness | słaby skan → cross-val critical mismatch | lepsze zdjęcie + „Try Again" |
| Refresh po porażce → „unable to load" | handoff session terminalny | użyć „Try Again" zamiast refresh (pełny fix = TODO) |

## Panele
- Developer portal: `https://idswyft-web-preprod.fly.dev/developer` (API keys, webhooki, **Page Builder** pod `/developer/page-builder`)
- Admin/MLRO: `https://idswyft-web-preprod.fly.dev/admin/login` (przegląd weryfikacji, approve/reject manual_review)
- Logowanie: OTP mailem (Resend) na `maciej@fizen.com`

## TODO / otwarte
- `full` E2E przez PYK (dotąd document_only).
- Webhook PYK **prod** (gdy PYK prod URL znany).
- Prod: aplikacja migracji (61) + sekrety Resend + HTTP→HTTPS redirect.
- Fix „unable to load" po porażce (handoff lifecycle).
- Opcjonalnie: wideo liveness (nowy feature — nagrywanie strumienia na froncie).

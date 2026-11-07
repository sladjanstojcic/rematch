# Rematch

A self-hosted remote-job matcher. Describe the job you want in plain English. Every
day Rematch collects fresh remote listings, uses Claude to read and score each one
against your description, and emails you a short digest of the best matches.

```
collect ──► enrich ──► prefilter ──► score ──► digest
job boards   Claude     location,     Claude     one email
+ ATS feeds  extracts   salary,       scores     per day,
             role,      seniority,    0–100      matches ≥ 70
             salary…    role rules
```

**Sources:** Greenhouse, Lever, Ashby and Recruitee company boards (companies seeded
from the [remoteintech](https://github.com/remoteintech/remote-jobs) list), plus
RemoteOK, We Work Remotely, Jobicy, Arbeitnow and Hacker News "Who is hiring".

**Stack:** Node 24 + TypeScript worker, Supabase (Postgres) for storage, the
Anthropic API (`claude-haiku-5-5`) for enrichment and scoring, any SMTP server for mail.

## How it works

1. **Collect.** Job boards are read in full each run, and every known company's ATS
   board is polled directly. An ATS link found on a job board adds that company
   automatically. The same job seen in several places becomes one job with
   several sources, merged only when the link, location or description agree.
2. **Enrich.** Claude reads each new job once and extracts facts: remote or not,
   allowed regions and countries, seniority, role family, technologies and salary
   (converted to USD per year).
3. **Prefilter.** Cheap rules drop pairs that can never match: not remote, wrong
   region, salary below your floor, wrong seniority or role. Unknown facts pass.
4. **Score.** Claude scores the remaining jobs 0–100 against your prompt, in
   batches, with a one-sentence reason addressed to you. A score of 70 or more is
   a match.
5. **Digest.** At most one email per day, with the best matches, the reason, the
   salary and age, and a credit link to every original listing.

ATS jobs close when their board stops listing them or returns 404; board-only jobs
age out after 14 days. Each job is scored once per subscriber, and delivery history
stops an emailed job from being sent again.

## Before you start

- **It costs money.** Every new job is sent to the Anthropic API. There is no spend
  cap; each run records token usage and estimated USD cost in `public.runs`.
- **It is a single-operator tool.** There is no web UI or signup. You add
  subscribers (yourself, maybe a friend) with one SQL insert.
- **It calls public job sources** once per run with a `RematchBot` user agent. Keep
  the schedule daily; don't hammer them.

## Quick start (local)

Requirements: Node 24, Docker (local Unix socket), the
[Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started),
and an [Anthropic API key](https://console.anthropic.com/).

```sh
git clone https://github.com/sladjanstojcic/rematch.git
cd rematch

# Start the local Supabase stack (Postgres, Studio, Mailpit) and apply migrations.
# Use this helper, not bare `supabase start`: it only touches this project's stack.
node supabase/local-db.mts start
node supabase/local-db.mts reset   # fresh DB only; erases this project's data

cd worker
npm ci
cp .env.example .env.local
```

Fill in `worker/.env.local`. Get the local `SUPABASE_SERVICE_ROLE_KEY` and `DB_URL`
(use it as `DATABASE_URL`) from `supabase status -o env`. Add your `ANTHROPIC_API_KEY`
and `OWNER_EMAIL`, and set `TZ` to your timezone (for example `Europe/Berlin`).

```sh
npm run seed   # resolve remoteintech companies to ATS boards
npm run once   # warm-up: collect and enrich jobs, no subscribers yet
```

Open Studio at <http://127.0.0.1:54323>. Check that the latest `public.runs.stats`
shows `enrich.failed` near 0, then add yourself in the SQL editor:

```sql
insert into public.subscribers (email, name, location, prompt)
values (
  'you@example.com', 'Your Name', 'Germany',
  'Senior backend role with Go or Rust, at least €70k per year, fully remote, EU timezone.'
);
```

```sh
npm run once   # scores jobs for you and sends your first digest
```

Locally, mail goes to Mailpit at <http://127.0.0.1:54324>, not your real inbox. To
keep it running daily, run `npm run build && npm start`. The process stays up and
runs at `RUN_CRON` (default 07:00) in `TZ`.

### Writing a good prompt

- `location` is where you live and can legally work from. It filters out jobs
  restricted to other regions.
- `prompt` is free text. Mention the stack, role, seniority, minimum salary with
  currency and period, and anything you refuse. The more specific, the better the scores.
- Changing `prompt` or `location` starts a fresh catch-up: your next digest
  re-evaluates the last 14 days of jobs (at most 15 items).

## Deploy on a VPS or Coolify

In production you need three things: a Postgres database with the Supabase API in
front of it, the worker container, and a real SMTP provider.

### 1. Database

Pick one:

- **Supabase Cloud** (easiest; the free tier is enough). Create a project, then from
  **Connect** copy the API URL, the `service_role` key and a connection string.
- **Self-hosted Supabase**, for example Coolify's one-click Supabase service. Use
  its Kong/API URL, its service-role key and the Postgres connection string.

> **`DATABASE_URL` must be a direct or *session-mode* connection.** The worker holds
> a Postgres advisory lock for the whole run, and a transaction-mode pooler
> (Supabase port `6543`) breaks it. On Supabase Cloud, the direct host
> (`db.<ref>.supabase.co`) is IPv6-only. From a Docker/Coolify network without IPv6,
> use the **Session pooler** string (`…pooler.supabase.com:5432`).

Apply the migrations from your machine. The URL must be percent-encoded:

```sh
supabase db push --db-url "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
```

### 2. Mail

Use any SMTP provider (Resend, Postmark, Amazon SES, Mailgun, your mail host).
Set `SMTP_HOST`, `SMTP_PORT` (`465` uses implicit TLS, `587` uses STARTTLS),
`SMTP_USER`, `SMTP_PASS`, and a `MAIL_FROM` on a domain you have verified with
that provider.

### 3a. Worker on Coolify

1. **New Resource → Application**, pointing at your fork of this repository.
2. Build pack **Dockerfile**, base directory `/worker`, Dockerfile `/Dockerfile`.
3. Leave the domain empty. The worker serves no HTTP, so turn off the health check.
4. Add the environment variables from the [configuration](#configuration) table
   as runtime variables.
5. Deploy. The logs should show `Next run: … (<your TZ>)`.
6. Open the container's **Terminal** in Coolify and run the first-time steps:

   ```sh
   node dist/seed/remoteintech.js   # seed companies
   node dist/main.js --once         # warm-up run; check runs.stats in Studio
   ```

   Insert your subscriber (SQL above) in the Supabase SQL editor, then run
   `node dist/main.js --once` again for your first digest. After that, the
   scheduler handles it daily.

### 3b. Worker on a plain VPS (Docker)

```sh
git clone https://github.com/sladjanstojcic/rematch.git && cd rematch
docker build -t rematch-worker worker
# Create worker/.env.production with the variables below (it is git-ignored).
docker run -d --name rematch --restart unless-stopped \
  --env-file worker/.env.production rematch-worker

docker exec rematch node dist/seed/remoteintech.js
docker exec rematch node dist/main.js --once
docker logs -f rematch
```

A manual `--once` and the scheduled run never overlap. Whichever starts second
returns `skipped`.

## Configuration

| Variable | Required | Default / notes |
| --- | --- | --- |
| `SUPABASE_URL` | yes | Supabase API URL (local: `http://127.0.0.1:54321`) |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-side key; never expose it to a browser |
| `DATABASE_URL` | yes | Direct or session-mode Postgres URL for the same database |
| `ANTHROPIC_API_KEY` | yes | Real calls are billed |
| `OWNER_EMAIL` | yes | Reply-To and `List-Unsubscribe` address in digests |
| `SMTP_HOST` | no | `127.0.0.1` (local Mailpit) |
| `SMTP_PORT` | no | `54325` (local Mailpit); `465` = implicit TLS |
| `SMTP_USER`, `SMTP_PASS` | no | Unset for Mailpit |
| `MAIL_FROM` | no | `Rematch <digest@rematch.local>` |
| `RUN_CRON` | no | `0 7 * * *` (daily at 07:00) |
| `TZ` | no | `UTC`. IANA name; sets the schedule and the one-digest-per-day boundary |

## Operating it

- **Each run** writes a row to `public.runs`: status (`ok`, `partial`, `failed`),
  per-stage counters, errors, tokens and estimated cost. Look there first.
- **Companies whose ATS board returns 404** on three consecutive runs are deactivated.
  To retry one, fix the slug and set `active = true, not_found_runs = 0`.
- **Pause someone** with `update public.subscribers set active = false where email = '…'`.
  Don't delete subscribers: that erases their delivery history, and old jobs
  would be sent again.
- **Back up the database.** Delivery history is what stops repeat emails.

See [`worker/README.md`](worker/README.md) for the full operator manual: run
semantics, catch-up and dedupe rules, failure handling, and warm-up before prompt changes.

## Development

```sh
cd worker
npm test            # fake AI, sources and mail against the local Supabase stack
npm run typecheck
npm run build
```

Tests **truncate the app tables** in the local database. They refuse to run when a
subscriber email isn't on `@example.test`, but don't run them on a database whose
data you want to keep. After changing migrations, regenerate the types with
`node supabase/local-db.mts types`.

## License

[MIT](LICENSE)

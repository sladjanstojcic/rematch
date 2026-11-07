# Rematch

**Tell it the job you want, in your own words. Every morning it emails you the remote jobs that fit.**

Rematch reads hundreds of fresh remote listings every day, from company career
pages and the big remote job boards. An AI reads each one the way you would and
scores it against your wish. You get one short email a day with only the jobs worth
your time, and a sentence on why each one fits.

```
Hi Sam,

Senior Backend Engineer — Acme
https://boards.greenhouse.io/acme/jobs/123
The role is fully remote in Europe and pays above your €70K floor.
€80K–€95K / year
Posted today
via Greenhouse, We Work Remotely
```

No accounts, no ads, no tracking. It runs on your own computer or server, with
your own keys.

---

## How it works

1. **Collect.** Every day Rematch checks the remote job boards (RemoteOK,
   We Work Remotely, Jobicy, Arbeitnow and Hacker News "Who is hiring") and the
   career pages of remote-friendly companies. It finds more companies as it goes,
   whenever a listing links to a company's own careers page.
2. **Read.** The AI reads each new job once and notes the facts: is it really
   remote, which countries can apply, the seniority, the tech stack and the salary.
3. **Filter.** Jobs that can never fit you are dropped right away. Examples are
   jobs closed to your country or paying below your minimum.
4. **Score.** The AI scores what is left from 0 to 100 against your wish. A score
   of 70 or more makes the cut.
5. **Email.** You get at most one email a day, best matches first. A job is never
   sent to you twice, and jobs taken down from a company's careers page drop out.

---

## What you need

Plan about **30–45 minutes** for the first setup. You need:

| What | Why | Cost |
| --- | --- | --- |
| A computer or server that can run [Docker](https://www.docker.com/products/docker-desktop/) | Runs Rematch | Free |
| A [Supabase](https://supabase.com) account | Stores jobs and your settings | Free plan is enough |
| An [Anthropic API key](https://console.anthropic.com/) | The AI that reads and scores jobs | Pay as you go (see below) |
| An email-sending service, such as [Resend](https://resend.com) | Sends your daily email | Free plans are enough |

**What the AI costs.** Rematch has no spending cap of its own, so set a monthly
limit in the Anthropic console. The first run reads every current job and is the
most expensive: in our test, about 900 jobs cost **$0.34**. After that, each day
only new jobs are read. Every run records its cost, so you can always check.

> **Your computer must be on** at the scheduled time (07:00 by default) for the daily
> email to go out. For a set-and-forget setup, use a small server instead
> (see [Running it on a server](#running-it-on-a-server)).

---

## Setup, step by step

### Step 1. Get the code

Download this repository (green **Code** button → **Download ZIP**, then unzip it),
or clone it:

```sh
git clone https://github.com/sladjanstojcic/rematch.git
cd rematch
```

### Step 2. Create the database

1. Sign in to [Supabase](https://supabase.com/dashboard) and click **New project**.
   Pick a name, set a database password (save it), and choose a region near you.
2. When the project is ready, collect three values. Keep them private:
   - **Project URL:** for example `https://abcd1234.supabase.co`. It is shown when
     you click **Connect**, and under **Project Settings**.
   - **Secret key:** in **Project Settings → API Keys**. Use the secret
     (`service_role`) key, never the public `anon`/publishable one.
   - **Connection string:** click **Connect** at the top, choose **Session pooler**,
     and copy the URI. It ends in `:5432/postgres`. Put your database password in
     place of `[YOUR-PASSWORD]`.

   > Use the **Session pooler** string. The "Transaction pooler" (port `6543`) does
   > not work with Rematch. If your password contains symbols like `@`, `#` or `/`,
   > either change it to letters and numbers or
   > [URL-encode](https://www.urlencoder.org/) it.

3. Create Rematch's tables. In a terminal, inside the `rematch` folder, run this
   with your connection string. It needs [Node.js 24](https://nodejs.org/):

   ```sh
   npx supabase db push --db-url "postgresql://postgres.abcd1234:YOUR-PASSWORD@aws-0-eu-central-1.pooler.supabase.com:5432/postgres"
   ```

   Answer `Y` when it asks to apply the migrations.

### Step 3. Get your AI key

In the [Anthropic console](https://console.anthropic.com/), add a payment method,
set a monthly **spend limit** (for example $5), and create an **API key**. It starts
with `sk-ant-`.

### Step 4. Set up email sending

Rematch needs an SMTP service to send mail. With [Resend](https://resend.com), for example:

1. Add and verify your domain (Resend shows you the DNS records to add).
2. Create an API key. Your SMTP settings are then: host `smtp.resend.com`, port
   `465`, user `resend`, password = that API key.

Any other provider (Postmark, Mailgun, Amazon SES, your own mail host) works the
same way: you need a host, port, username, password, and a "from" address on a
domain the provider has verified.

### Step 5. Fill in your settings

Create a file called `rematch.env` in the `rematch` folder and fill it in:

```ini
# Database (Step 2)
SUPABASE_URL=https://abcd1234.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
DATABASE_URL=postgresql://postgres.abcd1234:YOUR-PASSWORD@aws-0-eu-central-1.pooler.supabase.com:5432/postgres

# AI (Step 3)
ANTHROPIC_API_KEY=sk-ant-...

# Email (Step 4)
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASS=your-resend-api-key
MAIL_FROM=Rematch <jobs@your-domain.com>
# Replies and unsubscribe requests go here:
OWNER_EMAIL=you@example.com

# When to send: every day at 07:00 in your timezone
RUN_CRON=0 7 * * *
TZ=Europe/Berlin
```

- Do **not** put quotes around the values. Docker would keep them as part of the value.
- `TZ` is your timezone, for example `Europe/London`, `America/New_York` or
  `Asia/Tokyo` ([full list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)).
- This file holds your secrets. Never share or commit it. `rematch.env` is already
  ignored by git.

### Step 6. Start Rematch

Open Docker Desktop, then in the `rematch` folder run:

```sh
docker build -t rematch worker
docker run -d --name rematch --restart unless-stopped --env-file rematch.env rematch
```

Rematch is now running in the background. Check that it started:

```sh
docker logs rematch
```

You should see a line like `Next run: … (Europe/Berlin)`.

### Step 7. Load the job sources (one time)

```sh
docker exec rematch node dist/seed/remoteintech.js   # finds company career pages; can take a few minutes
docker exec rematch node dist/main.js --once         # first collection; the AI reads all current jobs
```

The second command can take a while, because the first run reads every job.

### Step 8. Tell Rematch what you want

In Supabase, open **SQL Editor**, paste this, change it to describe yourself, and
click **Run**:

```sql
insert into public.subscribers (email, name, location, prompt)
values (
  'you@example.com',
  'Your Name',
  'Germany',
  'Senior backend role with Go or Rust, at least €70k per year, fully remote, EU timezone. No crypto or gambling.'
);
```

- **location** is the country you live in and can legally work from. Jobs closed
  to that country are left out.
- **prompt** is your wish, in plain words. See the tips below.

### Step 9. Get your first email

```sh
docker exec rematch node dist/main.js --once
```

Within a few minutes your first email arrives, with up to 15 of the best jobs
from the last 14 days. Check your spam folder the first time. From now on,
Rematch sends a fresh email every morning on its own.

---

## Writing a good wish

The AI only knows what you tell it. The more specific you are, the better the matches.

- **Role and level:** "senior frontend engineer", "junior data analyst", "engineering manager"
- **Skills:** "React and TypeScript", "Python, dbt, Snowflake"
- **Minimum pay, with currency and period:** "at least $120k per year", "€50 per hour"
- **Deal-breakers:** "no crypto", "no agencies", "no on-call"
- **Nice-to-haves:** "small product company", "four-day week"

> Good: *"Mid or senior product designer, Figma, B2B SaaS, at least €60k per year,
> fully remote within Europe. No agencies, no web3."*
>
> Too vague: *"design job"*

Changing your wish or location later is fine. Your next email then looks back
over the last 14 days with the new wish.

---

## Day to day

Run these in the Supabase **SQL Editor**.

| You want to… | Do this |
| --- | --- |
| Change what you're looking for | `update public.subscribers set prompt = '…' where email = 'you@example.com';` |
| Pause the emails | `update public.subscribers set active = false where email = 'you@example.com';` |
| Resume them | `update public.subscribers set active = true where email = 'you@example.com';` |
| Add a friend | Run the Step 8 insert again with their details |
| See how runs went, and what they cost | `select started_at, status, est_cost_usd, errors from public.runs order by started_at desc limit 10;` |

Don't delete people from `subscribers`. Their history is what stops jobs from being
sent twice. Pause them instead.

To stop Rematch completely: `docker stop rematch`. To start it again: `docker start rematch`.

---

## Something not working?

**No email arrived.**
Check spam first. Then look at the latest run (the "see how runs went" query above).
An email error usually means the SMTP settings are wrong or the `MAIL_FROM` domain
is not verified with your email provider.

**The run status says `partial`.**
Some sources or jobs failed, and everything else worked. This is normal now and
then; job sites go down. The `errors` column says what failed.

**The run status says `skipped`.**
Another run was already in progress. Wait until it finishes.

**It says a connection or lock failed.**
Make sure `DATABASE_URL` is the **Session pooler** string (port `5432`), not the
Transaction pooler (port `6543`).

**I changed `rematch.env` but nothing changed.**
Docker reads the file only when the container is created. Recreate it:
`docker rm -f rematch`, then run the `docker run` command from Step 6 again.

---

## Running it on a server

For a daily email that doesn't depend on your laptop, run Rematch on any small
Linux server with Docker, for example a basic VPS. Copy the folder and your
`rematch.env` there, then follow Steps 6–9 the same way.

**Coolify:** create an **Application** from this repository with build pack
**Dockerfile**, base directory `/worker`, no domain, and the health check off.
Paste the contents of `rematch.env` as environment variables and deploy. Run the
Step 7 and Step 9 commands from the container's **Terminal**.

---

## For developers

Rematch is a Node 24 + TypeScript worker with Supabase (Postgres) storage, the
Anthropic API (`claude-haiku-5-5`) and any SMTP server.

```sh
node supabase/local-db.mts start   # local Supabase stack with Studio and Mailpit
cd worker
npm ci
cp .env.example .env.local         # local values from: supabase status -o env
npm test                           # truncates the local app tables
npm run typecheck && npm run build
```

Tests truncate the app tables in the local database. They refuse to run while a
subscriber email isn't on `@example.test`. After changing migrations, regenerate
the types with `node supabase/local-db.mts types`.

The operator manual in [`worker/README.md`](worker/README.md) covers the full
details: run semantics, deduplication and catch-up rules, failure handling, and
all the counters in `public.runs`.

## License

[MIT](LICENSE)

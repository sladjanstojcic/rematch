# Rematch worker

Collect remote jobs, enrich them with Claude, match subscribers' preferences, and
send a daily SMTP digest. Requires Node 24, npm, Docker, and the Supabase CLI.

## Environment

Run npm commands from `worker/`. Create `worker/.env.local` for your checkout;
never commit it or print its contents. The `seed`, `once`, and `start` scripts load
it explicitly with `--env-file=.env.local`. Existing shell variables take
precedence, so remove conflicting exported values before using the local stack.
Build and test commands do not load this file; tests use the owned stack helper.

| Key | Required / default |
| --- | --- |
| `SUPABASE_URL` | Required; owned local API is `http://127.0.0.1:54321` |
| `SUPABASE_SERVICE_ROLE_KEY` | Required; backend service-role key from your local stack |
| `DATABASE_URL` | Required; direct PostgreSQL connection to the same DB, locally `127.0.0.1:54322/postgres` |
| `ANTHROPIC_API_KEY` | Required; real calls incur cost |
| `OWNER_EMAIL` | Required; reply address and `List-Unsubscribe` mailto destination |
| `SMTP_HOST` | `127.0.0.1` |
| `SMTP_PORT` | `54325` (Mailpit); port 465 uses implicit TLS |
| `SMTP_USER`, `SMTP_PASS` | Optional; leave unset for local Mailpit |
| `MAIL_FROM` | `Rematch <digest@rematch.local>` |
| `RUN_CRON` | `0 7 * * *` |
| `TZ` | `UTC`; IANA name such as `Europe/Berlin`. Sets the schedule and the digest calendar day |

`DATABASE_URL` must be a direct connection, not a transaction-mode pooler: the
worker holds one PostgreSQL session advisory lock for the entire run. API and
direct database credentials must address the same database. Keep keys private.

## Owned local flow

From the repository root, use the ownership-checked helper instead of bare
`supabase start`, `supabase db reset`, or global Docker cleanup:

```sh
node supabase/local-db.mts start
# New/disposable DB only: erases this project's app data and reapplies migrations.
node supabase/local-db.mts reset
node supabase/local-db.mts types
cd worker
npm ci
```

The helper operates only on `rematch-t1-20261105`, checks its receipt/container
and network identities, and binds services to loopback. Do not reset an existing
DB whose run results you want to retain. `types` regenerates `src/db.types.ts`.
Supply the environment values above in `.env.local`, then:

```sh
npm run seed
```

Seeding resolves the remoteintech company list to supported ATS identifiers,
prints `resolved X of Y companies`, and inserts only new `(ats, slug)` pairs.
Careers pages are best effort; unresolved companies are not polled.

## First real run

Finish all test runs before starting a real search. After clearing only disposable
fixtures with the owned reset helper, use this order:

1. Run `npm run seed` as above, with no subscriber rows in the DB.
2. Run `npm run once` with no subscribers to collect and enrich the fresh jobs
   before a catch-up cohort can send mail.
3. Inspect the latest `public.runs.stats` in Studio: `enrich.failed` should be
   about 0. Read and explain any `ai.failureReasons.*` counters. Resolve failures
   and repeat this warm-up until the fresh jobs are processed; do not add a
   subscriber while unexplained enrichment failures remain.
4. Insert your subscriber using the example below, then run `npm run once` again
   to score and send the catch-up. Check `score.suppressed` (expected 0 for a fully
   prepared first catch-up) and inspect the email in Mailpit.

Warm up before an evening prompt/location change too: pause the scheduler, note
which subscribers are active, temporarily set them inactive, run `npm run once`,
and check the enrichment counters as above. Then edit the prompt/location,
restore the previously active subscribers and resume the scheduler. The next
run creates the new catch-up. Never delete subscribers or reset the DB for this
warm-up: that would erase delivery history.

In the local Studio SQL editor at `http://127.0.0.1:54323`, add a subscriber:

```sql
insert into public.subscribers (email, name, location, prompt)
values (
  'you@example.com', 'Alex Morgan', 'Serbia',
  'Next.js, React role for frontend with good UI and UX. Mid to senior, at least $80k USD per year, remote.'
);
```

```sh
npm run once
```

Open Mailpit at `http://127.0.0.1:54324`. With default SMTP settings, messages
remain in local Mailpit; it does not deliver them to the recipient's real inbox.
Claude calls go to Anthropic, and collection/seed requests go to external job
sources. There is no spend cap; usage and estimated USD cost are recorded.
Inspect `public.runs` in Studio for status, stage counters, errors, timestamps,
input/output tokens and estimated cost. Input tokens include cache writes/reads.
`stats` includes `ai.failures` and `ai.failureReasons.*` counters.
`score.prefiltered.not_remote`, `.region`, `.salary`, `.seniority`, and `.role`
count the subscriber/job pairs this run's prefilter excluded, by their first
violated constraint, in that order. Every reason is present, 0 when none.
Rejections are not stored, so a job excluded today is evaluated and counted
again on each run while it stays fresh and unscored: read these as the current
excluded pool, not new rejections. Unknown salary/eligibility still passes.

## Daily operation

```sh
npm run build
npm start
```

Keep this process running; startup prints the next scheduled run time. The
default is 07:00 UTC. Croner uses `protect: true`; every invocation
also attempts the same DB advisory lock, so another scheduled or manual run
returns `skipped` without stages, mail, or a `runs` row. Every invocation gets a
new usage meter, caller and run log. The lock is released in `finally`, including
on failure, and PostgreSQL releases session locks on disconnect.

`--once` exits 0 for `ok`, `partial`, or `skipped`, and 1 for `failed` (including
infrastructure/startup failure). Item-level errors make a run `partial`. A thrown
stage makes it `failed`; other stages continue, except a failed prompt refresh
skips scoring and digests, and a failed scoring stage skips digests. Failure to
write the final run record is reported on stderr; its row can remain `running`.

An ATS HTTP 404 (Lever only after its EU fallback also returns 404) closes that
company's open ATS jobs at once, under the same rule as a successful empty
fetch; a later successful fetch reopens any that reappear. The error names the
company slug. `companies.not_found_runs` counts consecutive 404 runs and resets
on a successful fetch; the third consecutive 404 deactivates the company, and
`collect_dead_boards` counts these deactivations. Correct the slug if needed,
then set `active=true` and `not_found_runs=0` in Studio to retry. Other failures
remain active for the next run.

One invalid job in an ATS feed is skipped and reported (field and code only)
under `collect_skipped_records`; the rest of that company's jobs are kept. A
feed whose jobs are all invalid still fails that company for the run.

Each run also deactivates companies with no confirmed remote job for more than 60 days.
The age is measured from `last_remote_job_at`, or `created_at` if none exists;
new seeds get the full 60 days. This 60-day deactivation never closes jobs. Source absence
closes a job only under collection's successful-fetch stale-source rules.

## Catch-up and deduplication limits

- Only open jobs from the last 14 days are enriched/scored (`posted_at`, falling
  back to `first_seen_at`). Scores of at least 70 qualify.
- New or changed prompt/location creates a catch-up snapshot. Its first digest
  contains at most 15 items. After successful delivery, remaining unsent matches
  from that snapshot are suppressed; it is not a daily backlog of 15 items.
  Members scored after that first digest stay suppressed too (PF-07).
  `score.suppressed` counts newly inserted suppressed rows, including non-matches;
  `score.matched` counts only newly inserted unsuppressed qualifying matches.
- After bookkeeping succeeds, each subscriber receives at most one digest per
  calendar day in `TZ`. New matches from a same-day rerun wait for a later day.
  The same stored job is never sent again to that subscriber, even after a prompt
  change. Changing timezone changes the calendar-day boundary. Losing or resetting
  the DB removes delivery history.
- Collection uses source/external IDs, ATS links and normalized company/title
  matching. This is not a universal job identity: ambiguous listings can stay
  separate, and reposts or renamed listings may become new jobs. Delivery dedupe
  applies to stored job IDs. An ATS link is used only after this worker collected
  that job from the ATS; otherwise the email uses the board's job link and credit.
- Accepted gap: if SMTP succeeds but delivery bookkeeping fails, a same-day
  manual rerun can resend that digest. SMTP and PostgreSQL cannot commit together.
  The digest error records `delivery bookkeeping failed after SMTP success`.

## Tests and stopping

```sh
# From worker/: fake AI, sources and mail; real owned local DB.
npm test
npm run typecheck
npm run build
```

Tests **truncate application tables** in the owned local DB, including companies,
subscribers and delivery/run history. `resetDb` refuses when any subscriber email
does not end in `@example.test`. Use your own email (not the fixture domain) for
a real search. `REMATCH_ALLOW_TEST_RESET=1` explicitly bypasses this protection
and discards delivery history; use it only for disposable data. Do not run tests
while preserving a real local run. The separate local-db migration reset also
destroys data; the test guard does not protect that command.
After testing, re-run seed and insert your subscriber again before a real run;
test fixtures may remain, so clear disposable test data before that setup.
The suite does not truncate Supabase auth/storage/system schemas.

Stop the scheduler with Ctrl-C. From the repository root, stop only the owned
stack when you no longer need Mailpit or Studio:

```sh
node supabase/local-db.mts stop
```

This preserves its database volumes. Leave the stack running when handing off a
real run for inspection in Mailpit.

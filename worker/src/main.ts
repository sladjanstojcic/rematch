import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cron } from 'croner';
import { createCaller, UsageMeter } from './ai/client.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { createSmtpMailer } from './email/smtp.js';
import { runOnce, type RunResult } from './pipeline/run.js';

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cfg = loadConfig();
  const db = createDb(cfg);
  const mailer = createSmtpMailer(cfg.smtp, cfg.mailFrom);
  const invoke = async (): Promise<RunResult> => {
    const meter = new UsageMeter();
    try {
      const call = createCaller(cfg.anthropicApiKey, meter);
      const result = await runOnce({ db, call, meter, mailer, cfg });
      console.log(JSON.stringify({ ...result, inputTokens: meter.inputTokens + meter.cacheWriteTokens + meter.cacheReadTokens,
        outputTokens: meter.outputTokens, estCostUsd: meter.estCostUsd() }));
      return result;
    } catch {
      // Infrastructure failures may prevent a runs row from being finalized.
      console.error('Run failed outside stage handling; check database connectivity and the runs table.');
      return { runId: null, status: 'failed' };
    }
  };

  if (argv.includes('--once')) {
    const result = await invoke();
    process.exitCode = result.status === 'failed' ? 1 : 0;
    return;
  }
  const job = new Cron(cfg.runCron, { timezone: cfg.tz, protect: true }, async () => { await invoke(); });
  console.log(`Next run: ${job.nextRun()?.toISOString() ?? 'none'} (${cfg.tz})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Worker startup failed; check the required environment variables, timezone and cron expression.');
    process.exitCode = 1;
  });
}

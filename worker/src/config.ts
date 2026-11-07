export type Config = {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  databaseUrl: string;
  anthropicApiKey: string;
  smtp: { host: string; port: number; user?: string; pass?: string };
  mailFrom: string;
  ownerEmail: string;
  runCron: string;
  tz: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL', 'ANTHROPIC_API_KEY', 'OWNER_EMAIL'] as const;
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);

  const port = Number(env.SMTP_PORT ?? '54325');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT must be an integer between 1 and 65535');
  }
  return {
    supabaseUrl: env.SUPABASE_URL!,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!,
    databaseUrl: env.DATABASE_URL!,
    anthropicApiKey: env.ANTHROPIC_API_KEY!,
    smtp: {
      host: env.SMTP_HOST ?? '127.0.0.1',
      port,
      ...(env.SMTP_USER ? { user: env.SMTP_USER } : {}),
      ...(env.SMTP_PASS ? { pass: env.SMTP_PASS } : {}),
    },
    mailFrom: env.MAIL_FROM ?? 'Rematch <digest@rematch.local>',
    ownerEmail: env.OWNER_EMAIL!,
    runCron: env.RUN_CRON ?? '0 7 * * *',
    tz: env.TZ ?? 'UTC',
  };
}

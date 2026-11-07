import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { assertLocalUrls, sanitizeCliError } from '../../supabase/local-db.mjs';

const required = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role',
  DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:54322/postgres',
  ANTHROPIC_API_KEY: 'fixture-anthropic',
  OWNER_EMAIL: 'owner@example.test',
};

describe('loadConfig', () => {
  it('names every missing required variable without exposing values', () => {
    for (const name of Object.keys(required)) {
      expect(() => loadConfig({})).toThrow(name);
    }
  });

  it('provides the local daily-worker defaults', () => {
    expect(loadConfig(required)).toEqual({
      supabaseUrl: required.SUPABASE_URL,
      supabaseServiceRoleKey: required.SUPABASE_SERVICE_ROLE_KEY,
      databaseUrl: required.DATABASE_URL,
      anthropicApiKey: required.ANTHROPIC_API_KEY,
      ownerEmail: 'owner@example.test',
      runCron: '0 7 * * *',
      tz: 'UTC',
      smtp: { host: '127.0.0.1', port: 54325 },
      mailFrom: 'Rematch <digest@rematch.local>',
    });
  });

  it('reads explicit SMTP and schedule settings', () => {
    const config = loadConfig({ ...required, SMTP_HOST: 'smtp.example.test',
      SMTP_PORT: '2525', SMTP_USER: 'fixture-user', SMTP_PASS: 'fixture-pass',
      MAIL_FROM: 'Jobs <jobs@example.test>', RUN_CRON: '30 8 * * *', TZ: 'UTC' });
    expect(config.smtp).toEqual({ host: 'smtp.example.test', port: 2525,
      user: 'fixture-user', pass: 'fixture-pass' });
    expect(config.mailFrom).toBe('Jobs <jobs@example.test>');
    expect(config.runCron).toBe('30 8 * * *');
    expect(config.tz).toBe('UTC');
  });

  it('rejects blank required variables', () => {
    expect(() => loadConfig({ ...required, DATABASE_URL: '  ' })).toThrow('DATABASE_URL');
  });

  it.each(['0', '65536', '25.5', '25junk', 'NaN', ''])('rejects invalid SMTP_PORT %j', (port) => {
    expect(() => loadConfig({ ...required, SMTP_PORT: port })).toThrow('SMTP_PORT');
  });
});

describe('local tooling safeguards', () => {
  it.each([
    'postgresql://postgres:fixture@remote.example.test:54322/postgres',
    'postgresql://postgres:fixture@127.0.0.1:54323/postgres',
    'postgresql://postgres:fixture@127.0.0.1:54322/another_database',
    'postgresql://postgres:fixture@127.0.0.1:54322/postgres?host=remote.example.test',
    'postgresql://another_user:fixture@127.0.0.1:54322/postgres',
  ])('rejects an unowned database target %j', (url) => {
    expect(() => assertLocalUrls(url, 'http://127.0.0.1:54321')).toThrow('owned loopback');
  });

  it('rejects a nonlocal API even when the database URL is local', () => {
    expect(() => assertLocalUrls('postgresql://postgres:fixture@127.0.0.1:54322/postgres', 'https://example.test')).toThrow('owned loopback');
  });

  it('keeps actionable CLI errors while removing credential values', () => {
    const output = sanitizeCliError('ERROR: relation "jobs" does not exist (SQLSTATE 42P01)\nDATABASE_URL="postgresql://postgres:fixture-password@127.0.0.1:54322/postgres"\nSERVICE_ROLE_KEY="fixture-secret"\nAuthorization: Bearer fixture-token');
    expect(output).toContain('relation "jobs" does not exist (SQLSTATE 42P01)');
    expect(output).not.toContain('fixture-password');
    expect(output).not.toContain('fixture-secret');
    expect(output).not.toContain('fixture-token');
  });
});

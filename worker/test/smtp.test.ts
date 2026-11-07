import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { renderDigest } from '../src/email/render.js';
import { createSmtpMailer } from '../src/email/smtp.js';
import { testDb } from './helpers/db.js';

it('delivers multipart content, sender, recipient, unsubscribe and reply headers to owned Mailpit', async () => {
  testDb(); // Verify the owned loopback stack before using its SMTP/HTTP ports.
  const base = 'http://127.0.0.1:54324/api/v1';
  const info = await fetch(`${base}/info`).then((r) => r.json());
  expect(info.Version).toMatch(/^v1\./);
  const subject = `rematch-task9-${randomUUID()}`;
  const mailer = createSmtpMailer({ host: '127.0.0.1', port: 54325 }, 'Rematch <digest@rematch.local>');
  const rendered = renderDigest('Sam', [{ title: 'Senior backend engineer', company: 'Acme',
    url: 'https://boards.greenhouse.io/fixture/jobs/123', reason: 'The listed salary meets your floor.',
    salaryText: '$230K–$252K / year', postedDaysAgo: 1, dateLabel: 'First seen', credits: [
      { name: 'Greenhouse', url: 'https://boards.greenhouse.io/fixture/jobs/123' },
      { name: 'Remote OK', url: 'https://remoteok.com/remote-jobs/123' },
    ] }]);
  await mailer({ ...rendered, to: 'recipient@example.test', subject,
    headers: { 'List-Unsubscribe': '<mailto:owner@example.test?subject=STOP>', 'Reply-To': 'owner@example.test' } });
  let id: string | undefined;
  await expect.poll(async () => {
    const inbox = await fetch(`${base}/messages`).then((r) => r.json()) as { messages: { ID: string; Subject: string }[] };
    id = inbox.messages.find((m) => m.Subject === subject)?.ID;
    return id;
  }, { timeout: 5000 }).toBeDefined();
  const message = await fetch(`${base}/message/${id}`).then((r) => r.json());
  // SMTP canonicalizes body line endings to CRLF; compare all content after that conversion.
  expect(message.HTML.replace(/\r\n/g, '\n')).toBe(rendered.html);
  expect(message.Text.replace(/\r\n/g, '\n')).toBe(rendered.text);
  expect(message.HTML).toContain('First seen 1 day ago');
  expect(message.Text).toContain('First seen 1 day ago');
  expect(message).toMatchObject({ Subject: subject,
    From: { Address: 'digest@rematch.local', Name: 'Rematch' }, To: [{ Address: 'recipient@example.test' }] });
  const headers = await fetch(`${base}/message/${id}/headers`).then((r) => r.json());
  expect(headers['List-Unsubscribe']).toEqual(['<mailto:owner@example.test?subject=STOP>']);
  expect(headers['Reply-To']).toEqual(['owner@example.test']);
});

import { createTransport } from 'nodemailer';
import type { Config } from '../config.js';

export type Mailer = (msg: {
  to: string; subject: string; html: string; text: string; headers: Record<string, string>;
}) => Promise<void>;

export function createSmtpMailer(smtp: Config['smtp'], from: string): Mailer {
  const { host, port, user, pass } = smtp;
  const transport = createTransport({ host, port, secure: port === 465, auth: user ? { user, pass } : undefined });
  return async (msg) => { await transport.sendMail({ from, ...msg }); };
}

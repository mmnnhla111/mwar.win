import type { Env } from '../types';

/**
 * Minimal transactional mail via the Resend HTTP API (one fetch, no SDK).
 * Set the RESEND_API_KEY secret and the MAIL_FROM var to enable it. Without a key the message is only
 * logged (local dev / not configured yet) and the caller decides what to expose.
 */
export async function sendMail(env: Env, to: string, subject: string, html: string): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.log(`[mail:not-configured] to=${to} subject=${subject}`);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM || 'MWAR <no-reply@mwar.win>', to: [to], subject, html }),
    });
    if (!res.ok) console.warn('[mail] send failed', res.status, await res.text().catch(() => ''));
    return res.ok;
  } catch (err) {
    console.warn('[mail] send error', err);
    return false;
  }
}

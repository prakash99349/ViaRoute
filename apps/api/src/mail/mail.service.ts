import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config';

export interface MailBrand {
  name: string;
  color?: string;
}

interface ActionMail {
  to: string;
  subject: string;
  brand: MailBrand;
  heading: string;
  body: string;
  buttonText: string;
  url: string;
  footnote?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

@Injectable()
export class MailService {
  private readonly log = new Logger(MailService.name);
  private readonly transport: Transporter = nodemailer.createTransport(config.smtpUrl);

  /** Sends a branded email with one call-to-action button. Failures are logged, never thrown. */
  async sendAction(m: ActionMail) {
    const color = m.brand.color ?? '#2563eb';
    const html = `
<div style="background:#f1f5f9;padding:32px 12px;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px">
    <div style="font-weight:bold;font-size:18px;margin-bottom:24px">📞 ${esc(m.brand.name)}</div>
    <h1 style="font-size:22px;margin:0 0 12px">${esc(m.heading)}</h1>
    <p style="font-size:15px;line-height:1.6;color:#334155">${esc(m.body)}</p>
    <p style="margin:28px 0"><a href="${esc(m.url)}" style="background:${esc(color)};color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;display:inline-block">${esc(m.buttonText)}</a></p>
    <p style="font-size:12px;color:#64748b;line-height:1.5">${esc(m.footnote ?? '')}<br>If the button doesn't work, copy this link:<br><span style="word-break:break-all">${esc(m.url)}</span></p>
  </div>
</div>`;
    const text = `${m.heading}\n\n${m.body}\n\n${m.buttonText}: ${m.url}\n\n${m.footnote ?? ''}`;
    try {
      await this.transport.sendMail({ from: config.mailFrom, to: m.to, subject: m.subject, html, text });
    } catch (e) {
      this.log.error(`Failed to send "${m.subject}" to ${m.to}: ${(e as Error).message}`);
    }
  }
}

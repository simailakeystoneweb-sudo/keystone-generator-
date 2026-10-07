import { createHmac, timingSafeEqual } from "node:crypto";
import nodemailer from "nodemailer";
import type { Config } from "../config.js";
import type { Fetch } from "../leads/finder.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  unsubscribeUrl: string;
  /** Lead id echoed in tags/headers so webhooks can be matched even without provider ids. */
  leadId: number;
}

export interface SendResult {
  provider: string;
  providerId: string | null;
}

export interface EmailSender {
  readonly name: string;
  send(msg: EmailMessage): Promise<SendResult>;
}

/** Wrap the AI-written body with the legally required footer (CAN-SPAM: identity, address, opt-out). */
export function composeEmail(cfg: Config, body: string, unsubscribeUrl: string): { text: string; html: string } {
  const footerLines = [
    `${cfg.sender.company}${cfg.sender.physicalAddress ? ` · ${cfg.sender.physicalAddress}` : ""}`,
    `Not interested? Unsubscribe: ${unsubscribeUrl}`,
  ];
  const text = `${body.trim()}\n\n--\n${footerLines.join("\n")}\n`;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#222">` +
    body
      .trim()
      .split(/\n{2,}/)
      .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
      .join("") +
    `<p style="font-size:12px;color:#888;margin-top:24px">${esc(footerLines[0])}<br>` +
    `<a href="${esc(unsubscribeUrl)}" style="color:#888">Unsubscribe</a></p></div>`;
  return { text, html };
}

export class ResendSender implements EmailSender {
  readonly name = "resend";
  constructor(private cfg: Config, private fetchImpl: Fetch = fetch) {}

  async send(msg: EmailMessage): Promise<SendResult> {
    const res = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: this.cfg.emailFrom,
        to: [msg.to],
        reply_to: this.cfg.emailReplyTo || undefined,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        headers: {
          "List-Unsubscribe": `<${msg.unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
        tags: [{ name: "lead_id", value: String(msg.leadId) }],
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) throw new Error(`Resend ${res.status}: ${data.message ?? "send failed"}`);
    return { provider: this.name, providerId: data.id ?? null };
  }
}

export class GmailSender implements EmailSender {
  readonly name = "gmail";
  private transport;
  constructor(private cfg: Config) {
    // Gmail SMTP with an App Password (Google Account → Security → App passwords).
    this.transport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: cfg.gmailUser, pass: cfg.gmailAppPassword },
    });
  }

  async send(msg: EmailMessage): Promise<SendResult> {
    const info = await this.transport.sendMail({
      from: this.cfg.emailFrom || this.cfg.gmailUser,
      to: msg.to,
      replyTo: this.cfg.emailReplyTo || undefined,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      headers: { "X-Keystone-Lead": String(msg.leadId) },
      list: { unsubscribe: { url: msg.unsubscribeUrl, comment: "Unsubscribe" } },
    });
    return { provider: this.name, providerId: info.messageId ?? null };
  }
}

export class DryRunEmailSender implements EmailSender {
  readonly name = "dryrun-email";
  readonly sent: EmailMessage[] = [];
  async send(msg: EmailMessage): Promise<SendResult> {
    this.sent.push(msg);
    console.log(`[dry-run] email → ${msg.to}: ${msg.subject}`);
    return { provider: this.name, providerId: `dry-${Date.now()}-${this.sent.length}` };
  }
}

export function createEmailSender(cfg: Config): EmailSender | null {
  if (cfg.dryRun) return new DryRunEmailSender();
  if (cfg.emailProvider === "resend") {
    if (!cfg.resendApiKey || !cfg.emailFrom) throw new Error("Resend needs RESEND_API_KEY and EMAIL_FROM");
    return new ResendSender(cfg);
  }
  if (cfg.emailProvider === "gmail") {
    if (!cfg.gmailUser || !cfg.gmailAppPassword) throw new Error("Gmail needs GMAIL_USER and GMAIL_APP_PASSWORD");
    return new GmailSender(cfg);
  }
  return null;
}

/**
 * Verify a Resend webhook (Resend signs with Svix).
 * signed content = `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256 with the
 * base64 secret after the `whsec_` prefix; header holds space-separated `v1,<sig>`.
 */
export function verifyResendWebhook(
  secret: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  rawBody: string,
  now = Date.now(),
): boolean {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${headers.id}.${headers.timestamp}.${rawBody}`).digest();
  return headers.signature.split(" ").some((part) => {
    const [, sig] = part.split(",");
    if (!sig) return false;
    const got = Buffer.from(sig, "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

import { createHmac, timingSafeEqual } from "node:crypto";
import nodemailer from "nodemailer";
import type { Config } from "../config.js";
import type { CommProvider } from "../types.js";

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  unsubscribeUrl: string;
  /** Lead id echoed in tags/headers so webhooks can be matched even without provider ids. */
  leadId: number;
  campaignId?: string | null;
  /** Sent to providers that support it so a retried request can't send twice. */
  idempotencyKey?: string;
}

export interface SendResult {
  provider: CommProvider;
  providerMessageId: string | null;
}

/** A transport that delivers one email. Lead checks and CRM records live in sendLeadEmail. */
export interface EmailSender {
  readonly provider: CommProvider;
  send(msg: EmailMessage): Promise<SendResult>;
}

/** Raised by a sender when the provider rejects the email. `message` is safe to show to the user. */
export class EmailProviderError extends Error {
  constructor(message: string, readonly code: string | null = null, readonly status: number | null = null) {
    super(message);
    this.name = "EmailProviderError";
  }
}

// ---------- unsubscribe links (HMAC-signed, no login needed) ----------

export function unsubscribeToken(secret: string, leadId: number): string {
  return createHmac("sha256", secret).update(`unsub:${leadId}`).digest("base64url").slice(0, 32);
}

export function unsubscribeUrl(cfg: Pick<Config, "publicBaseUrl" | "appSecret">, leadId: number): string {
  return `${cfg.publicBaseUrl}/unsubscribe/${leadId}/${unsubscribeToken(cfg.appSecret, leadId)}`;
}

export function verifyUnsubscribeToken(secret: string, leadId: number, token: string): boolean {
  const expected = Buffer.from(unsubscribeToken(secret, leadId));
  const got = Buffer.from(token);
  return got.length === expected.length && timingSafeEqual(got, expected);
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

export class GmailSender implements EmailSender {
  readonly provider = "GMAIL" as const;
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
      from: msg.from || this.cfg.gmailUser,
      to: msg.to,
      replyTo: this.cfg.emailReplyTo || undefined,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      headers: { "X-Keystone-Lead": String(msg.leadId) },
      list: { unsubscribe: { url: msg.unsubscribeUrl, comment: "Unsubscribe" } },
    });
    return { provider: this.provider, providerMessageId: info.messageId ?? null };
  }
}

/** DRY_RUN=true: logs instead of delivering. Records are stored with provider DRY_RUN. */
export class DryRunEmailSender implements EmailSender {
  readonly provider = "DRY_RUN" as const;
  readonly sent: EmailMessage[] = [];
  async send(msg: EmailMessage): Promise<SendResult> {
    this.sent.push(msg);
    console.log(`[dry-run] email → ${msg.to}: ${msg.subject}`);
    return { provider: this.provider, providerMessageId: `dry-email-${Date.now()}-${this.sent.length}` };
  }
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

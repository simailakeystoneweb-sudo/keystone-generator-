import type { Config } from "../../config.js";
import { DryRunEmailSender, GmailSender, type EmailSender } from "../../channels/email.js";
import { ResendEmailSender } from "./resend.js";

export { sendLeadEmail, checkEmailContactable, handleResendEvent, ResendEmailSender } from "./resend.js";

/** Pick the email transport from config. DRY_RUN=true always wins, so nothing is delivered by accident. */
export function createEmailSender(cfg: Config): EmailSender | null {
  if (cfg.dryRun) return new DryRunEmailSender();
  if (cfg.emailProvider === "resend") {
    if (!cfg.resendApiKey) return null;
    if (!cfg.emailFrom) throw new Error("Resend is configured but OUTREACH_FROM_EMAIL is not set");
    return new ResendEmailSender({ apiKey: cfg.resendApiKey, replyTo: cfg.emailReplyTo });
  }
  if (cfg.emailProvider === "gmail") {
    if (!cfg.gmailUser || !cfg.gmailAppPassword) throw new Error("Gmail needs GMAIL_USER and GMAIL_APP_PASSWORD");
    return new GmailSender(cfg);
  }
  return null;
}

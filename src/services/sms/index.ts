import type { Config } from "../../config.js";
import { DryRunSmsSender, type SmsSender } from "../../channels/sms.js";
import { TwilioSmsSender } from "./twilio.js";

export { sendLeadSMS, checkSmsContactable, handleIncomingSms, handleTwilioStatus, validateTwilioWebhook } from "./twilio.js";

/** Pick the SMS transport from config. DRY_RUN=true always wins, so nothing is delivered by accident. */
export function createSmsSender(cfg: Config): SmsSender | null {
  if (cfg.dryRun) return new DryRunSmsSender();
  if (!cfg.twilioAccountSid || !cfg.twilioAuthToken) return null;
  return new TwilioSmsSender({
    accountSid: cfg.twilioAccountSid,
    authToken: cfg.twilioAuthToken,
    phoneNumber: cfg.twilioPhoneNumber,
    messagingServiceSid: cfg.twilioMessagingServiceSid,
  });
}

import type { RulesConfig } from "./config.js";
import { hostOf } from "./crm/db.js";
import type { Channel, Lead } from "./types.js";

export type Decision =
  | { action: "auto_approve"; reasons: string[] }
  | { action: "needs_approval"; reasons: string[] }
  | { action: "skip"; reasons: string[] };

/**
 * Approval rules: decide what happens to a freshly drafted lead.
 * Hard blocks → skip. Manual mode → always queue. Auto mode → approve high-fit
 * leads with a reachable email; everything else waits for a human.
 */
export function decideApproval(lead: Lead, rules: RulesConfig, isSuppressed: (v: string | null) => boolean): Decision {
  const block: string[] = [];
  if (lead.optedOut) block.push("lead opted out");
  if (isSuppressed(lead.email) || isSuppressed(lead.phone)) block.push("on suppression list");
  if (!lead.email && !lead.phone) block.push("no email or phone");
  const host = lead.email?.split("@")[1]?.toLowerCase() ?? (lead.website ? hostOf(lead.website) : null);
  if (host && rules.blockedDomains.some((d) => host === d || host.endsWith(`.${d}`))) block.push(`blocked domain ${host}`);
  const ind = (lead.industry ?? "").toLowerCase();
  if (ind && rules.blockedIndustries.some((b) => ind.includes(b))) block.push(`blocked industry ${lead.industry}`);
  if ((lead.score ?? 0) < rules.minScore) block.push(`score ${lead.score ?? 0} < min ${rules.minScore}`);
  if (block.length) return { action: "skip", reasons: block };

  if (rules.approvalMode === "manual") return { action: "needs_approval", reasons: ["approval mode is manual"] };

  const why: string[] = [];
  if ((lead.score ?? 0) < rules.autoApproveMinScore) why.push(`score ${lead.score} < auto-approve ${rules.autoApproveMinScore}`);
  if (!lead.email) why.push("no email (SMS-only leads always need review)");
  if (why.length) return { action: "needs_approval", reasons: why };
  return { action: "auto_approve", reasons: [`score ${lead.score} ≥ ${rules.autoApproveMinScore}`] };
}

/** Hour/weekday in a timezone, without external date libraries. */
export function localParts(now: Date, timeZone: string): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return { hour, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd) };
}

export function inSendWindow(now: Date, rules: RulesConfig): boolean {
  const { hour, weekday } = localParts(now, rules.timezone);
  if (!rules.sendOnWeekends && (weekday === 0 || weekday === 6)) return false;
  return hour >= rules.sendWindowStart && hour < rules.sendWindowEnd;
}

/** Midnight (UTC ISO) at the start of the current local day — used for daily caps. */
export function startOfLocalDayIso(now: Date, timeZone: string): string {
  const { hour } = localParts(now, timeZone);
  const minutes = Number(new Intl.DateTimeFormat("en-US", { timeZone, minute: "numeric" }).format(now));
  const start = new Date(now.getTime() - (hour * 60 + minutes) * 60_000 - now.getUTCSeconds() * 1000 - now.getUTCMilliseconds());
  return start.toISOString();
}

export interface SendCheckContext {
  now: Date;
  sentToday: Record<Channel, number>;
  isSuppressed: (v: string | null) => boolean;
  /** When the first outbound email was sent to this lead, if any. */
  firstEmailAt: Date | null;
  alreadySent: Record<Channel, boolean>;
  repliedOrBeyond: boolean;
}

/** Automation rules evaluated at send time, per channel. Returns null if OK, else why not. */
export function sendBlocker(channel: Channel, lead: Lead, rules: RulesConfig, ctx: SendCheckContext): string | null {
  if (lead.optedOut) return "opted out";
  if (ctx.repliedOrBeyond) return "lead already replied";
  if (ctx.alreadySent[channel]) return `${channel} already sent`;
  if (!inSendWindow(ctx.now, rules)) return "outside send window";
  if (channel === "email") {
    if (!lead.email) return "no email";
    if (ctx.isSuppressed(lead.email)) return "email suppressed";
    if (ctx.sentToday.email >= rules.dailyEmailLimit) return "daily email limit reached";
    return null;
  }
  if (!lead.phone) return "no phone";
  if (ctx.isSuppressed(lead.phone)) return "phone suppressed";
  if (rules.smsRequireConsent && !lead.smsConsent) return "no SMS consent on record (TCPA)";
  if (ctx.sentToday.sms >= rules.dailySmsLimit) return "daily SMS limit reached";
  if (lead.email && rules.smsDelayDays > 0) {
    if (!ctx.firstEmailAt) return "waiting for email to go out first";
    const due = ctx.firstEmailAt.getTime() + rules.smsDelayDays * 86_400_000;
    if (ctx.now.getTime() < due) return `SMS follow-up scheduled after ${new Date(due).toISOString()}`;
  }
  return null;
}

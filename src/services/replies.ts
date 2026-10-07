import type { CRM } from "../crm/db.js";
import type { ReplyClassification } from "../ai/claude.js";
import type { Channel, Lead, ReplyClassificationRecord } from "../types.js";

export type ReplyClassifier = (lead: Lead, text: string, channel: Channel) => Promise<ReplyClassification>;

export function toRecord(cls: ReplyClassification | Omit<ReplyClassificationRecord, "source" | "classifiedAt">, source: ReplyClassificationRecord["source"], now: Date): ReplyClassificationRecord {
  return {
    classification: cls.classification,
    sentiment: cls.sentiment,
    recommendedAction: cls.recommendedAction,
    shouldPauseSequence: cls.shouldPauseSequence,
    source,
    classifiedAt: now.toISOString(),
  };
}

/** Whole-message opt-out keywords honoured on every carrier (Twilio Advanced Opt-Out defaults, incl. the FCC 2025 additions). */
export const SMS_OPT_OUT_KEYWORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"] as const;
export const SMS_OPT_IN_KEYWORDS = ["START", "UNSTOP", "YES"] as const;
export const SMS_HELP_KEYWORDS = ["HELP", "INFO"] as const;

/** Normalize a message the way carriers match keywords: whole message, case/space/punctuation-insensitive. */
function keywordForm(text: string): string {
  return text.trim().toUpperCase().replace(/[\s.!?,'"]+/g, "");
}

export function smsKeyword(text: string): "OPT_OUT" | "OPT_IN" | "HELP" | null {
  const k = keywordForm(text);
  if ((SMS_OPT_OUT_KEYWORDS as readonly string[]).includes(k)) return "OPT_OUT"; // "Stop", "STOP!", "stop all", "opt out"
  if ((SMS_OPT_IN_KEYWORDS as readonly string[]).includes(k)) return "OPT_IN";
  if ((SMS_HELP_KEYWORDS as readonly string[]).includes(k)) return "HELP";
  return null;
}

/**
 * Unambiguous opt-out phrasing in free text ("please remove me", "stop texting me").
 * Deliberately does NOT match a message that merely starts with "end"/"cancel"
 * ("End of day works", "Cancel my 3pm?") — those go to Claude.
 */
export function isOptOutPhrase(text: string): boolean {
  if (smsKeyword(text) === "OPT_OUT") return true;
  const t = text.toLowerCase();
  return /\b(unsubscribe|opt (me )?out|remove me|take me off|do not (contact|text|email|message)|don'?t (contact|text|email|message)|stop (emailing|texting|messaging|contacting|calling))\b/.test(t);
}

/**
 * Move the lead through the CRM according to a classification. Free-text
 * UNSUBSCRIBE (e.g. "please stop contacting me") opts the lead out of BOTH channels.
 */
export function applyReplyClassification(crm: CRM, leadId: number, channel: Channel, cls: { classification: string; recommendedAction: string }, text = ""): void {
  switch (cls.classification) {
    case "UNSUBSCRIBE":
      crm.optOut(leadId, { email: true, sms: true }, `${channel} reply asked to stop: ${text.slice(0, 80)}`);
      break;
    case "NOT_INTERESTED":
      crm.setStatus(leadId, "replied");
      crm.setStatus(leadId, "lost", cls.recommendedAction);
      break;
    case "MEETING_BOOKED":
      crm.setStatus(leadId, "replied");
      crm.setStatus(leadId, "interested");
      crm.setStatus(leadId, "booked", cls.recommendedAction);
      break;
    case "INTERESTED":
      crm.setStatus(leadId, "replied");
      crm.setStatus(leadId, "interested", cls.recommendedAction);
      break;
    default: // QUESTION, WRONG_PERSON, OUT_OF_OFFICE, OTHER — a human should look
      crm.setStatus(leadId, "replied", cls.recommendedAction);
  }
}

/**
 * Classify a reply with Claude (or deterministic rules), store the result on the
 * communication and the lead, and apply it to the pipeline. Never throws: a failed
 * classification leaves the lead "replied" and logs why.
 */
export async function classifyAndApply(opts: {
  crm: CRM;
  lead: Lead;
  channel: Channel;
  text: string;
  communicationId: number;
  classify: ReplyClassifier | null;
  now: () => Date;
}): Promise<ReplyClassificationRecord | null> {
  const { crm, lead, channel, text, communicationId, classify, now } = opts;
  let record: ReplyClassificationRecord | null = null;
  if (isOptOutPhrase(text)) {
    record = toRecord(
      { classification: "UNSUBSCRIBE", sentiment: "NEGATIVE", recommendedAction: "Lead asked to stop. Do not contact again.", shouldPauseSequence: true },
      "keyword",
      now(),
    );
  } else if (classify) {
    try {
      record = toRecord(await classify(lead, text, channel), "claude", now());
    } catch (err) {
      crm.logEvent(lead.id, "reply.unclassified", `Claude classification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    crm.logEvent(lead.id, "reply.unclassified", "Claude is not configured (ANTHROPIC_API_KEY)");
  }
  if (!record) {
    crm.setStatus(lead.id, "replied", "reply needs manual review");
    return null;
  }
  crm.tx(() => {
    crm.setCommunicationClassification(communicationId, record!);
    crm.setLastReplyClassification(lead.id, record!);
    crm.logEvent(lead.id, `${channel}.reply_classified`, `${record!.classification} (${record!.sentiment}, ${record!.source}): ${record!.recommendedAction}`);
    applyReplyClassification(crm, lead.id, channel, record!, text);
  });
  return record;
}

import { PIPELINE, type CommProvider, type CommStatus, type EmailStatus, type LeadStatus, type SmsStatus } from "../types.js";
import type { CRM } from "../crm/db.js";

export type DeliveryUpdate = "SENT" | "DELIVERED" | "FAILED" | "UNDELIVERED" | "BOUNCED" | "COMPLAINED";

const COMM_RANK: Record<string, number> = { QUEUED: 0, SENT: 1, DELIVERED: 2, FAILED: 3, BOUNCED: 3 };
const stageIndex = (s: LeadStatus) => PIPELINE.indexOf(s as (typeof PIPELINE)[number]);

/**
 * Apply a provider delivery event (Resend webhook, Twilio status callback) to the
 * communication and the lead. Returns false when no matching communication exists.
 */
export function applyDeliveryUpdate(
  crm: CRM,
  ev: { provider: CommProvider; providerMessageId: string; update: DeliveryUpdate; error?: string | null },
): boolean {
  const comm = crm.findCommunicationByProviderId(ev.provider, ev.providerMessageId);
  if (!comm || comm.direction !== "OUTBOUND") return false;
  const leadId = comm.leadId;
  crm.tx(() => {
    if (ev.update === "COMPLAINED") {
      crm.setDeliveryStatus(leadId, "EMAIL", "COMPLAINED");
      crm.optOut(leadId, { email: true }, `spam complaint via ${ev.provider}`);
      crm.logEvent(leadId, "email.complained", ev.provider);
      return;
    }
    const commStatus: CommStatus = ev.update === "UNDELIVERED" ? "FAILED" : ev.update;
    if ((COMM_RANK[commStatus] ?? 0) >= (COMM_RANK[comm.status] ?? 0)) crm.setCommunicationStatus(comm.id, commStatus, ev.error ?? null);
    const leadStatus = comm.channel === "EMAIL" ? (ev.update as EmailStatus) : (ev.update as SmsStatus);
    if (ev.update !== "SENT") crm.setDeliveryStatus(leadId, comm.channel, leadStatus);
    crm.logEvent(leadId, `${comm.channel.toLowerCase()}.${ev.update.toLowerCase()}`, ev.error ?? ev.provider);

    if (ev.update === "DELIVERED") crm.setStatus(leadId, "delivered");
    if (ev.update === "BOUNCED") {
      const lead = crm.getLead(leadId)!;
      if (lead.email) crm.suppress(lead.email, "hard bounce");
      // Only mark the lead bounced if no other outbound message is still in play.
      const others = crm
        .communicationsForLead(leadId)
        .filter((m) => m.id !== comm.id && m.direction === "OUTBOUND" && (m.status === "SENT" || m.status === "DELIVERED"));
      if (!others.length && stageIndex(lead.status) < stageIndex("replied")) crm.setStatus(leadId, "bounced", ev.error ?? "bounced");
    }
  });
  return true;
}

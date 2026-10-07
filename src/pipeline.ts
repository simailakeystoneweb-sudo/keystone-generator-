import type { Config } from "./config.js";
import { CRM, type ContactPreferencesPatch } from "./crm/db.js";
import { auditWebsite, scoreLead } from "./leads/audit.js";
import { findContact } from "./leads/enrich.js";
import { searchGooglePlaces, type Fetch, type ImportedRow, type SearchQuery } from "./leads/finder.js";
import { leadToInput, type Personalizer, type ReplyClassification } from "./ai/personalize.js";
import type { AnalyzeLeadInput, ClaudeService, ColdEmail, ColdSms, FollowUp } from "./ai/claude.js";
import { composeEmail, unsubscribeUrl, verifyUnsubscribeToken, type EmailSender } from "./channels/email.js";
import { composeSms, type SmsSender } from "./channels/sms.js";
import { decideApproval, sendBlocker, startOfLocalDayIso } from "./rules.js";
import { checkEmailContactable, sendLeadEmail, type SendLeadEmailInput, type SendOptions } from "./services/email/resend.js";
import { checkSmsContactable, handleIncomingSms, sendLeadSMS, type IncomingSms, type SendLeadSmsInput } from "./services/sms/twilio.js";
import { toE164 } from "./services/sms/phone.js";
import { ProviderSendError, SendRejectedError, type Contactability } from "./services/errors.js";
import { classifyAndApply, isOptOutPhrase, type ReplyClassifier } from "./services/replies.js";
import type { Channel, Lead, LeadStatus, ReplyClassificationRecord } from "./types.js";
import { PIPELINE, toCommChannel } from "./types.js";

export interface PipelineDeps {
  cfg: Config;
  crm: CRM;
  personalizer: Personalizer | null;
  /** Server-side Claude service behind the Lead Details AI buttons. */
  claude?: ClaudeService | null;
  email: EmailSender | null;
  sms: SmsSender | null;
  fetchImpl?: Fetch;
  now?: () => Date;
}

const stageIndex = (s: LeadStatus) => PIPELINE.indexOf(s as (typeof PIPELINE)[number]);

/**
 * The whole flow:
 *   find → enrich (contact + website audit + score) → AI draft → approval rules
 *   → send email (Resend/Gmail) + SMS (Twilio) → webhooks advance the CRM:
 *   sent → delivered → replied → interested → booked → closed
 */
export class Pipeline {
  readonly crm: CRM;
  private cfg: Config;
  private fetchImpl: Fetch;
  private now: () => Date;

  constructor(private deps: PipelineDeps) {
    this.crm = deps.crm;
    this.cfg = deps.cfg;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => new Date());
  }

  // ---------- 1. Lead generator ----------

  async findLeads(q: SearchQuery): Promise<{ found: number; created: Lead[] }> {
    const businesses = await searchGooglePlaces(q, this.cfg.googlePlacesApiKey, this.fetchImpl);
    const created: Lead[] = [];
    for (const b of businesses) {
      const { lead, created: isNew } = this.crm.upsertBusiness(b);
      if (isNew) created.push(lead);
    }
    return { found: businesses.length, created };
  }

  importRows(rows: ImportedRow[]): Lead[] {
    const created: Lead[] = [];
    for (const r of rows) {
      const { lead, created: isNew } = this.crm.upsertBusiness(r);
      if (!isNew) continue;
      created.push(
        this.crm.updateLead(lead.id, {
          contactName: r.contactName ?? undefined,
          email: r.email?.toLowerCase() ?? undefined,
          smsConsent: r.smsConsent ?? undefined,
        }),
      );
    }
    return created;
  }

  // ---------- 2. Enrich: contact, website problems/opportunities, score ----------

  async enrich(leadId: number): Promise<Lead> {
    const lead = this.mustLead(leadId);
    const { audit, page } = await auditWebsite(lead.website, this.fetchImpl);
    const contact = await findContact(lead.website, page, { hunterApiKey: this.cfg.hunterApiKey, fetchImpl: this.fetchImpl });
    const email = lead.email ?? contact.email;
    const contactName = lead.contactName ?? contact.contactName;
    const phone = lead.phone ?? contact.phone;
    const score = scoreLead({ audit, email, phone, contactName, rating: lead.rating, reviewCount: lead.reviewCount });
    const updated = this.crm.updateLead(leadId, { audit, email, contactName, phone, score });
    this.crm.logEvent(leadId, "lead.enriched", `score ${score}, ${audit.findings.length} findings, email ${email ? "found" : "missing"}`);
    if (lead.status === "new") this.crm.setStatus(leadId, "enriched");
    return this.crm.getLead(updated.id)!;
  }

  // ---------- 3. AI personalization + 4. approval rules ----------

  async draft(leadId: number): Promise<{ lead: Lead; decision: ReturnType<typeof decideApproval> }> {
    if (!this.deps.personalizer) throw new Error("No AI personalizer configured (set ANTHROPIC_API_KEY)");
    let lead = this.mustLead(leadId);
    const isSuppressed = (v: string | null) => this.crm.isSuppressed(v);

    // Don't spend tokens on leads the rules would throw away anyway.
    const pre = decideApproval(lead, this.cfg.rules, isSuppressed);
    if (pre.action === "skip") {
      this.crm.setStatus(leadId, "skipped", pre.reasons.join("; "));
      return { lead: this.mustLead(leadId), decision: pre };
    }

    const out = await this.deps.personalizer.draft(lead);
    const draft = this.crm.saveDraft(leadId, out);
    this.crm.setStatus(leadId, "drafted");
    lead = this.mustLead(leadId);

    const decision = decideApproval(lead, this.cfg.rules, isSuppressed);
    if (decision.action === "auto_approve") {
      this.crm.decideDraft(draft.id, true, `auto: ${decision.reasons.join("; ")}`);
      this.crm.setStatus(leadId, "approved", `auto-approved: ${decision.reasons.join("; ")}`);
    } else if (decision.action === "needs_approval") {
      this.crm.setStatus(leadId, "pending_approval", decision.reasons.join("; "));
    } else {
      this.crm.setStatus(leadId, "skipped", decision.reasons.join("; "));
    }
    return { lead: this.mustLead(leadId), decision };
  }

  approve(leadId: number, edits: { emailSubject?: string; emailBody?: string; smsBody?: string; smsConsent?: boolean } = {}, by = "human"): Lead {
    const lead = this.mustLead(leadId);
    const draft = this.crm.latestDraft(leadId);
    if (!draft) throw new Error(`lead ${leadId} has no draft`);
    if (edits.emailSubject || edits.emailBody || edits.smsBody) this.crm.updateDraft(draft.id, edits);
    // Goes through the manual-preferences path, which refuses consent for an SMS opt-out.
    if (edits.smsConsent !== undefined) this.crm.setContactPreferences(leadId, { smsConsent: edits.smsConsent }, by);
    this.crm.decideDraft(draft.id, true, `approved by ${by}`);
    if (lead.status !== "approved") this.crm.setStatus(leadId, "approved", `approved by ${by}`, { force: lead.status === "skipped" });
    return this.mustLead(leadId);
  }

  reject(leadId: number, reason = "rejected", by = "human"): Lead {
    const draft = this.crm.latestDraft(leadId);
    if (draft) this.crm.decideDraft(draft.id, false, `${reason} (${by})`);
    this.crm.setStatus(leadId, "skipped", `${reason} (${by})`);
    return this.mustLead(leadId);
  }

  /** Throw away the current draft and ask the AI for a fresh one. */
  async redraft(leadId: number): Promise<Lead> {
    const lead = this.mustLead(leadId);
    if (!["drafted", "pending_approval", "approved", "skipped"].includes(lead.status)) throw new Error(`cannot redraft a lead in status ${lead.status}`);
    this.crm.setStatus(leadId, "enriched", "redraft requested", { force: true });
    return (await this.draft(leadId)).lead;
  }

  // ---------- 5. Send: EMAIL (Resend/Gmail) + TEXT (Twilio) ----------

  /** Send every message that is approved and allowed by the automation rules right now. */
  async sendDue(): Promise<{ sent: { leadId: number; channel: Channel }[]; held: { leadId: number; channel: Channel; reason: string }[] }> {
    const sent: { leadId: number; channel: Channel }[] = [];
    const held: { leadId: number; channel: Channel; reason: string }[] = [];
    const candidates = this.crm.listLeads({ status: ["approved", "sent", "delivered"], limit: 10_000 });
    for (const lead of candidates) {
      const draft = this.crm.latestDraft(lead.id);
      if (!draft?.approved) continue;
      for (const channel of ["email", "sms"] as const) {
        const reason = await this.trySend(lead.id, channel);
        if (reason === null) sent.push({ leadId: lead.id, channel });
        else if (!/already sent|no (email|phone)/.test(reason)) held.push({ leadId: lead.id, channel, reason });
      }
    }
    return { sent, held };
  }

  /**
   * Attempt a single channel for a single lead under the automation rules (send window,
   * daily caps, follow-up delay, sequence pause). The actual send goes through
   * sendLeadEmail / sendLeadSMS, so every contactability check applies here too.
   * Returns null if sent, else the reason it was held.
   */
  async trySend(leadId: number, channel: Channel): Promise<string | null> {
    const lead = this.mustLead(leadId);
    const draft = this.crm.latestDraft(leadId);
    if (!draft?.approved) return "draft not approved";
    const sender = channel === "email" ? this.deps.email : this.deps.sms;
    if (!sender) return `no ${channel} provider configured`;

    const now = this.now();
    const since = startOfLocalDayIso(now, this.cfg.rules.timezone);
    const history = this.crm.communicationsForLead(leadId).filter((m) => m.direction === "OUTBOUND" && m.status !== "FAILED");
    const firstEmail = history.find((m) => m.channel === "EMAIL");
    const blocker = sendBlocker(channel, lead, this.cfg.rules, {
      now,
      sentToday: { email: this.crm.countOutboundSince("EMAIL", since), sms: this.crm.countOutboundSince("SMS", since) },
      isSuppressed: (v) => this.crm.isSuppressed(v),
      firstEmailAt: firstEmail ? new Date(firstEmail.sentAt ?? firstEmail.createdAt) : null,
      alreadySent: { email: Boolean(firstEmail), sms: history.some((m) => m.channel === "SMS") },
      repliedOrBeyond: stageIndex(lead.status) >= stageIndex("replied") || stageIndex(lead.status) === -1,
    });
    if (blocker) return blocker;

    try {
      if (channel === "email") {
        await this.sendEmail({ leadId, email: lead.email!, subject: draft.emailSubject, body: draft.emailBody }, { draftId: draft.id });
      } else {
        await this.sendSms({ leadId, phone: lead.phone!, message: draft.smsBody }, { draftId: draft.id });
      }
      return null;
    } catch (err) {
      if (err instanceof SendRejectedError) return `rejected: ${err.message}`;
      if (err instanceof ProviderSendError) return `send failed: ${err.message}`;
      throw err;
    }
  }

  // ---------- explicit sends (confirmation modal, CLI) ----------

  /** sendLeadEmail with this pipeline's database, config and Resend transport. */
  sendEmail(input: SendLeadEmailInput, opts: SendOptions = {}) {
    return sendLeadEmail(input, { crm: this.crm, cfg: this.cfg, sender: this.deps.email, now: this.now }, opts);
  }

  /** sendLeadSMS with this pipeline's database, config and Twilio transport. */
  sendSms(input: SendLeadSmsInput, opts: SendOptions = {}) {
    return sendLeadSMS(input, { crm: this.crm, cfg: this.cfg, sender: this.deps.sms, now: this.now }, opts);
  }

  /** What the confirmation modals show: who it goes to, whether it can be sent, and the exact compliance text added. */
  sendPreview(leadId: number): {
    email: Contactability & { to: string | null; from: string; provider: string | null; dryRun: boolean; footer: string };
    sms: Contactability & { to: string | null; from: string; provider: string | null; dryRun: boolean; optOutText: string };
  } {
    const lead = this.mustLead(leadId);
    const emailCheck = checkEmailContactable(this.crm, lead);
    const smsCheck = checkSmsContactable(this.crm, this.cfg, lead, this.now());
    const footer = composeEmail(this.cfg, "", unsubscribeUrl(this.cfg, leadId)).text.trim();
    return {
      email: {
        ...(this.deps.email ? emailCheck : { ok: false, code: "NOT_CONFIGURED", message: "Email sending is not configured (set RESEND_API_KEY and OUTREACH_FROM_EMAIL)." }),
        ...(emailCheck.ok && this.deps.email && !this.cfg.emailFrom ? { ok: false, code: "NOT_CONFIGURED", message: "Set OUTREACH_FROM_EMAIL to send email." } : {}),
        to: lead.email,
        from: this.cfg.emailFrom,
        provider: this.deps.email?.provider ?? null,
        dryRun: this.deps.email?.provider === "DRY_RUN",
        footer,
      } as Contactability & { to: string | null; from: string; provider: string | null; dryRun: boolean; footer: string },
      sms: {
        ...(this.deps.sms ? smsCheck : { ok: false, code: "NOT_CONFIGURED", message: "SMS sending is not configured (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER)." }),
        to: toE164(lead.phone) ?? lead.phone,
        from: this.cfg.twilioPhoneNumber,
        provider: this.deps.sms?.provider ?? null,
        dryRun: this.deps.sms?.provider === "DRY_RUN",
        optOutText: composeSms("").trim(),
      } as Contactability & { to: string | null; from: string; provider: string | null; dryRun: boolean; optOutText: string },
    };
  }

  /** Manual change of opt-outs / consent / sequence from the dashboard (the only way to clear an opt-out). */
  setContactPreferences(leadId: number, patch: ContactPreferencesPatch, actor = "dashboard"): Lead {
    return this.crm.setContactPreferences(leadId, patch, actor);
  }

  // ---------- 6. CRM tracking: replies ----------

  /** Claude reply classifier, or null when Claude isn't configured. */
  get classifier(): ReplyClassifier | null {
    const p = this.deps.personalizer;
    return p ? (lead, text, channel) => p.classifyReply(lead, text, channel) : null;
  }

  /** Twilio inbound SMS webhook (see handleIncomingSms). */
  handleIncomingSms(params: IncomingSms) {
    return handleIncomingSms(params, { crm: this.crm, classify: this.classifier, now: this.now });
  }

  /**
   * An inbound email reply (Resend inbound or the generic hook): record it, mark replied,
   * pause the sequence, and classify. `classification` resolves when Claude is done.
   */
  handleInboundEmail(
    from: string,
    text: string,
    provider: "RESEND" | "INBOUND_HOOK",
    providerMessageId: string | null = null,
    subject: string | null = null,
  ): { lead: Lead | null; communicationId: number | null; classification: Promise<ReplyClassificationRecord | null> } {
    const address = extractAddress(from);
    const lead = this.crm.findLeadByEmail(address);
    if (!lead) {
      // Honour opt-outs even from addresses we don't know yet.
      if (isOptOutPhrase(text)) this.crm.suppress(address, "email opt-out from unknown sender");
      return { lead: null, communicationId: null, classification: Promise.resolve(null) };
    }
    if (providerMessageId && this.crm.findCommunicationByProviderId(provider, providerMessageId)) {
      return { lead, communicationId: null, classification: Promise.resolve(null) };
    }
    const comm = this.crm.tx(() => {
      const c = this.crm.recordCommunication({
        leadId: lead.id, direction: "INBOUND", channel: "EMAIL", provider, providerMessageId,
        sender: address, subject, body: text.slice(0, 20000), status: "RECEIVED", sentAt: this.now().toISOString(),
      });
      this.crm.markReplied(lead.id);
      return c;
    });
    const classification = classifyAndApply({ crm: this.crm, lead, channel: "email", text, communicationId: comm.id, classify: this.classifier, now: this.now });
    return { lead, communicationId: comm.id, classification };
  }

  /** Manual pipeline moves from the dashboard (e.g. booked → closed, or lost). */
  markStage(leadId: number, stage: LeadStatus, note?: string): Lead {
    const lead = this.mustLead(leadId);
    if (stage === "opted_out") this.crm.optOut(leadId, { all: true }, note ?? "marked opted out manually");
    else this.crm.setStatus(leadId, stage, note ?? `manual: ${lead.status} → ${stage}`, { force: true });
    return this.mustLead(leadId);
  }

  // ---------- Lead Details AI actions (generate + save for review; never send) ----------

  private requireClaude(): ClaudeService {
    if (!this.deps.claude) throw new Error("Claude is not configured: set ANTHROPIC_API_KEY on the server.");
    return this.deps.claude;
  }

  /** Run Claude's lead analysis, store it on the lead, and use its score as the lead's fit score. */
  async analyzeLead(leadId: number, overrides: Partial<Pick<AnalyzeLeadInput, "description" | "notes" | "knownWebsiteIssues">> = {}) {
    const lead = this.mustLead(leadId);
    if (overrides.description !== undefined || overrides.notes !== undefined) {
      this.crm.updateLead(leadId, { description: overrides.description, notes: overrides.notes });
    }
    const analysis = await this.requireClaude().analyzeLead(leadToInput(this.mustLead(leadId), overrides));
    this.crm.updateLead(leadId, { analysis: { ...analysis, analyzedAt: this.now().toISOString() }, score: analysis.leadScore });
    this.crm.logEvent(leadId, "ai.analyzed", `${analysis.quality} · lead ${analysis.leadScore} · website ${analysis.websiteScore} · ${analysis.recommendedChannel}`);
    if (lead.status === "new") this.crm.setStatus(leadId, "enriched", "analyzed by Claude");
    return analysis;
  }

  async generateEmail(leadId: number): Promise<ColdEmail> {
    const lead = this.mustLead(leadId);
    const email = await this.requireClaude().generateColdEmail({ lead: leadToInput(lead), analysis: lead.analysis ?? undefined });
    this.saveGenerated(leadId, { emailSubject: email.subject, emailBody: email.body }, "ai.email_generated");
    return email;
  }

  async generateSms(leadId: number): Promise<ColdSms> {
    const lead = this.mustLead(leadId);
    const sms = await this.requireClaude().generateColdSMS({ lead: leadToInput(lead), analysis: lead.analysis ?? undefined });
    this.saveGenerated(leadId, { smsBody: sms.message }, "ai.sms_generated");
    return sms;
  }

  /** Draft a follow-up from the lead's message history. Returned for review only — not saved as the outreach draft, not sent. */
  async generateFollowUp(leadId: number, channel: "EMAIL" | "SMS"): Promise<FollowUp> {
    const lead = this.mustLead(leadId);
    const history = this.crm.communicationsForLead(leadId).filter((m) => m.status !== "FAILED" && m.body);
    const outbound = history.filter((m) => m.direction === "OUTBOUND");
    const last = history.at(-1);
    const result = await this.requireClaude().generateFollowUp({
      lead: leadToInput(lead),
      analysis: lead.analysis ?? undefined,
      channel,
      followUpNumber: Math.max(1, outbound.length),
      previousMessages: history.slice(-10).map((m) => ({
        channel: m.channel,
        direction: m.direction,
        subject: m.subject ?? "",
        body: m.body.slice(0, 6000),
        sentAt: m.sentAt ?? m.createdAt,
      })),
      daysSinceLastMessage: last ? Math.floor((this.now().getTime() - new Date(last.sentAt ?? last.createdAt).getTime()) / 86_400_000) : undefined,
    });
    this.crm.logEvent(leadId, "ai.follow_up_generated", channel);
    return result;
  }

  /** Classify a reply pasted in by a human (e.g. one received outside the webhooks) and update the CRM. */
  async classifyLeadReply(leadId: number, replyText: string, channel: Channel = "email"): Promise<ReplyClassification> {
    const lead = this.mustLead(leadId);
    const claude = isOptOutPhrase(replyText) ? null : this.requireClaude();
    const cls: ReplyClassification = claude
      ? await claude.classifyReply({ replyText, channel: channel === "email" ? "EMAIL" : "SMS", businessName: lead.businessName })
      : { classification: "UNSUBSCRIBE", sentiment: "NEGATIVE", recommendedAction: "Lead asked to stop. Do not contact again.", shouldPauseSequence: true };
    const comm = this.crm.tx(() => {
      const c = this.crm.recordCommunication({
        leadId, direction: "INBOUND", channel: toCommChannel(channel), provider: "MANUAL",
        sender: channel === "email" ? lead.email : lead.phone, body: replyText, status: "RECEIVED", sentAt: this.now().toISOString(),
      });
      this.crm.markReplied(leadId);
      return c;
    });
    // Reuse the stored-classification path with the result we already have.
    await classifyAndApply({
      crm: this.crm, lead, channel, text: replyText, communicationId: comm.id,
      classify: async () => cls, now: this.now,
    });
    return cls;
  }

  /**
   * Store generated copy as a NEW, unapproved draft (carrying over the other channel's text),
   * so it can be reviewed and edited. Because sending requires the latest draft to be
   * approved, generating new copy also holds any send that was previously approved.
   */
  private saveGenerated(leadId: number, patch: { emailSubject?: string; emailBody?: string; smsBody?: string }, event: string): void {
    const lead = this.mustLead(leadId);
    const prev = this.crm.latestDraft(leadId);
    const draft = this.crm.saveDraft(leadId, {
      emailSubject: patch.emailSubject ?? prev?.emailSubject ?? "",
      emailBody: patch.emailBody ?? prev?.emailBody ?? "",
      smsBody: patch.smsBody ?? prev?.smsBody ?? "",
      reasoning: lead.analysis?.reasonForContacting ?? prev?.reasoning ?? "",
    });
    this.crm.logEvent(leadId, event, `saved as unapproved draft ${draft.id}`);
    if (["new", "enriched"].includes(lead.status)) this.crm.setStatus(leadId, "drafted");
    else if (lead.status === "approved") this.crm.setStatus(leadId, "pending_approval", "new AI copy needs review", { force: true });
  }

  // ---------- unsubscribe links ----------

  unsubscribeUrl(leadId: number): string {
    return unsubscribeUrl(this.cfg, leadId);
  }

  /** Signed unsubscribe link: opts the lead out of email (permanently, until changed manually). */
  unsubscribe(leadId: number, token: string): boolean {
    if (!verifyUnsubscribeToken(this.cfg.appSecret, leadId, token)) return false;
    if (!this.crm.getLead(leadId)) return false;
    this.crm.optOut(leadId, { email: true }, "unsubscribe link");
    return true;
  }

  // ---------- full run ----------

  /** Run every stage for leads that are ready for it. */
  async runAll(opts: { query?: SearchQuery; send?: boolean } = {}): Promise<Record<string, unknown>> {
    const summary: Record<string, unknown> = {};
    if (opts.query) {
      const r = await this.findLeads(opts.query);
      summary.found = r.found;
      summary.newLeads = r.created.length;
    }
    let enriched = 0;
    for (const l of this.crm.listLeads({ status: "new", limit: 10_000 })) {
      await this.enrich(l.id).catch((e) => this.crm.logEvent(l.id, "enrich.failed", String(e)));
      enriched++;
    }
    summary.enriched = enriched;
    if (this.deps.personalizer) {
      const decisions: Record<string, number> = {};
      for (const l of this.crm.listLeads({ status: "enriched", limit: 10_000 })) {
        try {
          const { decision } = await this.draft(l.id);
          decisions[decision.action] = (decisions[decision.action] ?? 0) + 1;
        } catch (e) {
          this.crm.logEvent(l.id, "draft.failed", String(e));
          decisions.failed = (decisions.failed ?? 0) + 1;
        }
      }
      summary.drafts = decisions;
    }
    if (opts.send !== false) {
      const r = await this.sendDue();
      summary.sent = r.sent.length;
      summary.held = r.held.length;
    }
    return summary;
  }

  private mustLead(id: number): Lead {
    const l = this.crm.getLead(id);
    if (!l) throw new Error(`lead ${id} not found`);
    return l;
  }
}

export function extractAddress(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1] : from).trim().toLowerCase();
}

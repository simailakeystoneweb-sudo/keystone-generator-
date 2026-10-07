import { DatabaseSync } from "node:sqlite";
import type {
  CommChannel,
  CommProvider,
  CommStatus,
  Communication,
  Draft,
  EmailStatus,
  Lead,
  LeadAnalysisRecord,
  LeadStatus,
  RawBusiness,
  ReplyClassificationRecord,
  SmsStatus,
  WebsiteAudit,
} from "../types.js";
import { PIPELINE } from "../types.js";

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  industry TEXT,
  city TEXT,
  address TEXT,
  source TEXT NOT NULL,
  source_id TEXT,
  rating REAL,
  review_count INTEGER,
  audit_json TEXT,
  score INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  sms_consent INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS leads_source_uq ON leads(source, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_status_idx ON leads(status);
CREATE INDEX IF NOT EXISTS leads_email_idx ON leads(lower(email));
CREATE INDEX IF NOT EXISTS leads_phone_idx ON leads(phone);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  email_subject TEXT NOT NULL,
  email_body TEXT NOT NULL,
  sms_body TEXT NOT NULL,
  reasoning TEXT NOT NULL DEFAULT '',
  approved INTEGER NOT NULL DEFAULT 0,
  decision TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS communications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  draft_id INTEGER REFERENCES drafts(id),
  campaign_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('OUTBOUND','INBOUND')),
  channel TEXT NOT NULL CHECK (channel IN ('EMAIL','SMS')),
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  idempotency_key TEXT,
  recipient TEXT,
  sender TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  classification_json TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS communications_provider_msg_uq ON communications(provider, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS communications_idempotency_uq ON communications(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS communications_lead_idx ON communications(lead_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS events_lead_idx ON events(lead_id);

CREATE TABLE IF NOT EXISTS suppressions (
  value TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

type Row = Record<string, unknown>;

function rowToLead(r: Row): Lead {
  return {
    id: Number(r.id),
    businessName: String(r.business_name),
    contactName: (r.contact_name as string) ?? null,
    email: (r.email as string) ?? null,
    phone: (r.phone as string) ?? null,
    website: (r.website as string) ?? null,
    industry: (r.industry as string) ?? null,
    city: (r.city as string) ?? null,
    address: (r.address as string) ?? null,
    source: String(r.source),
    sourceId: (r.source_id as string) ?? null,
    rating: r.rating == null ? null : Number(r.rating),
    reviewCount: r.review_count == null ? null : Number(r.review_count),
    description: (r.description as string) ?? null,
    audit: r.audit_json ? (JSON.parse(String(r.audit_json)) as WebsiteAudit) : null,
    analysis: r.analysis_json ? (JSON.parse(String(r.analysis_json)) as LeadAnalysisRecord) : null,
    score: r.score == null ? null : Number(r.score),
    status: r.status as LeadStatus,
    smsConsent: Boolean(r.sms_consent),
    emailOptOut: Boolean(r.email_opt_out),
    smsOptOut: Boolean(r.sms_opt_out),
    doNotContact: Boolean(r.do_not_contact),
    emailStatus: (r.email_status as EmailStatus) ?? null,
    smsStatus: (r.sms_status as SmsStatus) ?? null,
    lastContactedAt: (r.last_contacted_at as string) ?? null,
    replied: Boolean(r.replied),
    sequencePaused: Boolean(r.sequence_paused),
    lastReplyClassification: r.last_reply_classification_json
      ? (JSON.parse(String(r.last_reply_classification_json)) as ReplyClassificationRecord)
      : null,
    notes: (r.notes as string) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function rowToDraft(r: Row): Draft {
  return {
    id: Number(r.id),
    leadId: Number(r.lead_id),
    emailSubject: String(r.email_subject),
    emailBody: String(r.email_body),
    smsBody: String(r.sms_body),
    reasoning: String(r.reasoning ?? ""),
    approved: Boolean(r.approved),
    decision: (r.decision as string) ?? null,
    createdAt: String(r.created_at),
  };
}

function rowToCommunication(r: Row): Communication {
  return {
    id: Number(r.id),
    leadId: Number(r.lead_id),
    draftId: r.draft_id == null ? null : Number(r.draft_id),
    campaignId: (r.campaign_id as string) ?? null,
    direction: r.direction as Communication["direction"],
    channel: r.channel as CommChannel,
    provider: r.provider as CommProvider,
    providerMessageId: (r.provider_message_id as string) ?? null,
    recipient: (r.recipient as string) ?? null,
    sender: (r.sender as string) ?? null,
    subject: (r.subject as string) ?? null,
    body: String(r.body),
    status: r.status as CommStatus,
    error: (r.error as string) ?? null,
    classification: r.classification_json ? (JSON.parse(String(r.classification_json)) as ReplyClassificationRecord) : null,
    sentAt: (r.sent_at as string) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/** Stages before first contact. Sending the first message moves these to "sent" (contacted). */
export const PRE_CONTACT_STAGES: readonly LeadStatus[] = ["new", "enriched", "drafted", "pending_approval", "approved"];

const DELIVERY_RANK: Record<string, number> = { SENT: 1, DELIVERED: 2, FAILED: 3, UNDELIVERED: 3, BOUNCED: 3, COMPLAINED: 4 };

export interface NewCommunication {
  leadId: number;
  draftId?: number | null;
  campaignId?: string | null;
  direction: Communication["direction"];
  channel: CommChannel;
  provider: CommProvider;
  providerMessageId?: string | null;
  idempotencyKey?: string | null;
  recipient?: string | null;
  sender?: string | null;
  subject?: string | null;
  body: string;
  status: CommStatus;
  error?: string | null;
  classification?: ReplyClassificationRecord | null;
  sentAt?: string | null;
}

export interface ContactPreferencesPatch {
  emailOptOut?: boolean;
  smsOptOut?: boolean;
  doNotContact?: boolean;
  smsConsent?: boolean;
  sequencePaused?: boolean;
}

export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits.length >= 9 ? digits : null;
  const d = digits.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`; // assume North America for bare 10-digit numbers
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d.length >= 9 ? `+${d}` : null;
}

/**
 * Whether moving a lead from `from` to `to` is allowed. Pipeline stages only
 * advance (a late "delivered" webhook must not undo a "replied"); side stages
 * are always reachable; nothing leaves opted_out except a manual override.
 */
export function canTransition(from: LeadStatus, to: LeadStatus): boolean {
  if (from === to) return false;
  if (from === "opted_out") return false;
  const fi = PIPELINE.indexOf(from as (typeof PIPELINE)[number]);
  const ti = PIPELINE.indexOf(to as (typeof PIPELINE)[number]);
  if (ti === -1) return true; // side stage
  if (fi === -1) return false; // leaving a side stage requires force
  return ti > fi;
}

export class CRM {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Versioned migrations (PRAGMA user_version). Each step is idempotent, so a fresh
   * database simply runs them as no-ops once.
   */
  private migrate(): void {
    const version = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    if (version >= SCHEMA_VERSION) return;
    this.tx(() => {
      const cols = new Set((this.db.prepare("PRAGMA table_info(leads)").all() as Row[]).map((r) => String(r.name)));
      const add = (name: string, type: string) => {
        if (!cols.has(name)) this.db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${type}`);
      };
      // v1: Claude analysis
      add("description", "TEXT");
      add("analysis_json", "TEXT");
      // v2: per-channel contact preferences, delivery state, reply tracking
      add("email_opt_out", "INTEGER NOT NULL DEFAULT 0");
      add("sms_opt_out", "INTEGER NOT NULL DEFAULT 0");
      add("do_not_contact", "INTEGER NOT NULL DEFAULT 0");
      add("email_status", "TEXT");
      add("sms_status", "TEXT");
      add("last_contacted_at", "TEXT");
      add("replied", "INTEGER NOT NULL DEFAULT 0");
      add("sequence_paused", "INTEGER NOT NULL DEFAULT 0");
      add("last_reply_classification_json", "TEXT");
      // The old single opt-out flag meant "never contact": carry it onto every new flag.
      if (cols.has("opted_out")) {
        this.db.exec("UPDATE leads SET email_opt_out = 1, sms_opt_out = 1, do_not_contact = 1 WHERE opted_out = 1");
      }
      // v2: messages → communications (uppercase enums, provider_message_id, sent_at)
      const hasMessages = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get();
      if (hasMessages) {
        this.db.exec(`
          INSERT INTO communications (lead_id, draft_id, direction, channel, provider, provider_message_id, recipient, subject, body, status, error, sent_at, created_at, updated_at)
          SELECT lead_id, draft_id, UPPER(direction), UPPER(channel),
                 CASE provider WHEN 'dryrun-email' THEN 'DRY_RUN' WHEN 'dryrun-sms' THEN 'DRY_RUN' WHEN 'inbound-hook' THEN 'INBOUND_HOOK' ELSE UPPER(provider) END,
                 provider_id, recipient, subject, body, UPPER(status), error,
                 CASE WHEN status = 'failed' THEN NULL ELSE created_at END, created_at, updated_at
          FROM messages ORDER BY id;
          DROP TABLE messages;
        `);
        this.db.exec(`
          UPDATE leads SET last_contacted_at = (SELECT MAX(sent_at) FROM communications c WHERE c.lead_id = leads.id AND c.direction = 'OUTBOUND')
          WHERE last_contacted_at IS NULL;
          UPDATE leads SET replied = 1, sequence_paused = 1 WHERE EXISTS (SELECT 1 FROM communications c WHERE c.lead_id = leads.id AND c.direction = 'INBOUND');
        `);
      }
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  private txDepth = 0;

  /** Run `fn` atomically. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth++;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------- leads ----------

  /** Insert a business, or return the existing lead if we've seen it (same source id, website or phone). */
  upsertBusiness(b: RawBusiness): { lead: Lead; created: boolean } {
    const phone = normalizePhone(b.phone);
    const website = b.website ? b.website.trim() : null;
    const existing = this.findDuplicate(b.source, b.sourceId ?? null, website, phone);
    if (existing) return { lead: existing, created: false };
    const res = this.db
      .prepare(
        `INSERT INTO leads (business_name, phone, website, industry, city, address, source, source_id, rating, review_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        b.businessName,
        phone,
        website,
        b.industry ?? null,
        b.city ?? null,
        b.address ?? null,
        b.source,
        b.sourceId ?? null,
        b.rating ?? null,
        b.reviewCount ?? null,
      );
    const lead = this.getLead(Number(res.lastInsertRowid))!;
    this.logEvent(lead.id, "lead.created", `from ${b.source}`);
    return { lead, created: true };
  }

  private findDuplicate(source: string, sourceId: string | null, website: string | null, phone: string | null): Lead | null {
    if (sourceId) {
      const r = this.db.prepare("SELECT * FROM leads WHERE source = ? AND source_id = ?").get(source, sourceId) as Row | undefined;
      if (r) return rowToLead(r);
    }
    const host = website ? hostOf(website) : null;
    if (host) {
      const rows = this.db.prepare("SELECT * FROM leads WHERE website IS NOT NULL").all() as Row[];
      const hit = rows.find((r) => hostOf(String(r.website)) === host);
      if (hit) return rowToLead(hit);
    }
    if (phone) {
      const r = this.db.prepare("SELECT * FROM leads WHERE phone = ?").get(phone) as Row | undefined;
      if (r) return rowToLead(r);
    }
    return null;
  }

  getLead(id: number): Lead | null {
    const r = this.db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToLead(r) : null;
  }

  listLeads(filter: { status?: LeadStatus | LeadStatus[]; limit?: number } = {}): Lead[] {
    const statuses = filter.status ? (Array.isArray(filter.status) ? filter.status : [filter.status]) : null;
    const where = statuses ? `WHERE status IN (${statuses.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(`SELECT * FROM leads ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...(statuses ?? []), filter.limit ?? 500) as Row[];
    return rows.map(rowToLead);
  }

  findLeadByEmail(email: string): Lead | null {
    const r = this.db.prepare("SELECT * FROM leads WHERE lower(email) = lower(?) ORDER BY id DESC").get(email.trim()) as Row | undefined;
    return r ? rowToLead(r) : null;
  }

  findLeadByPhone(phone: string): Lead | null {
    const p = normalizePhone(phone);
    if (!p) return null;
    const r = this.db.prepare("SELECT * FROM leads WHERE phone = ? ORDER BY id DESC").get(p) as Row | undefined;
    return r ? rowToLead(r) : null;
  }

  updateLead(
    id: number,
    patch: Partial<
      Pick<Lead, "contactName" | "email" | "phone" | "website" | "industry" | "city" | "description" | "audit" | "analysis" | "score" | "smsConsent" | "notes">
    >,
  ): Lead {
    const cols: string[] = [];
    const vals: (string | number | null)[] = [];
    const map: Record<string, string> = {
      contactName: "contact_name",
      email: "email",
      phone: "phone",
      website: "website",
      industry: "industry",
      city: "city",
      description: "description",
      score: "score",
      notes: "notes",
    };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (k === "audit" || k === "analysis") {
        cols.push(`${k}_json = ?`);
        vals.push(v == null ? null : JSON.stringify(v));
      } else if (k === "smsConsent") {
        cols.push("sms_consent = ?");
        vals.push(v ? 1 : 0);
      } else if (k === "phone") {
        cols.push("phone = ?");
        vals.push(normalizePhone(v as string));
      } else if (map[k]) {
        cols.push(`${map[k]} = ?`);
        vals.push(v as string | number | null);
      }
    }
    if (cols.length) {
      cols.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
      this.db.prepare(`UPDATE leads SET ${cols.join(", ")} WHERE id = ?`).run(...vals, id);
    }
    return this.getLead(id)!;
  }

  /** Move a lead through the pipeline. Returns false (and does nothing) if the move would go backwards. */
  setStatus(id: number, to: LeadStatus, detail?: string, opts: { force?: boolean } = {}): boolean {
    const lead = this.getLead(id);
    if (!lead) throw new Error(`lead ${id} not found`);
    if (!opts.force && !canTransition(lead.status, to)) return false;
    this.db
      .prepare("UPDATE leads SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(to, id);
    this.logEvent(id, `status.${to}`, detail ?? `${lead.status} → ${to}`);
    return true;
  }

  /**
   * Record an opt-out. `email`/`sms` are channel opt-outs; `all` sets do_not_contact.
   * Opt-outs are permanent: nothing in the app clears them except setContactPreferences
   * (a deliberate manual change). The lead's stage becomes opted_out only once no
   * channel is left to contact them on.
   */
  optOut(id: number, scope: { email?: boolean; sms?: boolean; all?: boolean }, reason: string): Lead | null {
    const lead = this.getLead(id);
    if (!lead) return null;
    const email = Boolean(scope.email || scope.all);
    const sms = Boolean(scope.sms || scope.all);
    this.tx(() => {
      this.db
        .prepare(
          `UPDATE leads SET
             email_opt_out = MAX(email_opt_out, ?), sms_opt_out = MAX(sms_opt_out, ?), do_not_contact = MAX(do_not_contact, ?),
             sms_consent = CASE WHEN ? THEN 0 ELSE sms_consent END,
             sequence_paused = 1,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = ?`,
        )
        .run(email ? 1 : 0, sms ? 1 : 0, scope.all ? 1 : 0, sms ? 1 : 0, id);
      if (email && lead.email) this.suppress(lead.email, reason);
      if (sms && lead.phone) this.suppress(lead.phone, reason);
      const which = scope.all ? "all contact" : [email && "email", sms && "SMS"].filter(Boolean).join(" + ");
      this.logEvent(id, "contact.opt_out", `${which}: ${reason}`);
      const after = this.getLead(id)!;
      const emailGone = after.doNotContact || after.emailOptOut || !after.email;
      const smsGone = after.doNotContact || after.smsOptOut || !after.phone;
      if (emailGone && smsGone && after.status !== "opted_out") this.setStatus(id, "opted_out", reason, { force: true });
    });
    return this.getLead(id);
  }

  /**
   * Manual change of contact preferences from the dashboard. This is the only path
   * that can clear an opt-out; clearing one also lifts that channel's suppression.
   */
  setContactPreferences(id: number, patch: ContactPreferencesPatch, actor: string): Lead {
    const lead = this.getLead(id);
    if (!lead) throw new Error(`lead ${id} not found`);
    const changes: string[] = [];
    this.tx(() => {
      const set = (col: string, v: boolean | undefined, current: boolean, label: string) => {
        if (v === undefined || v === current) return;
        this.db.prepare(`UPDATE leads SET ${col} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(v ? 1 : 0, id);
        changes.push(`${label} ${current} → ${v}`);
      };
      set("email_opt_out", patch.emailOptOut, lead.emailOptOut, "email_opt_out");
      set("sms_opt_out", patch.smsOptOut, lead.smsOptOut, "sms_opt_out");
      set("do_not_contact", patch.doNotContact, lead.doNotContact, "do_not_contact");
      set("sequence_paused", patch.sequencePaused, lead.sequencePaused, "sequence_paused");
      // Consent can't be recorded while the lead is opted out of SMS.
      const smsOut = patch.smsOptOut ?? lead.smsOptOut;
      if (patch.smsConsent && smsOut) throw new Error("cannot record SMS consent while the lead is opted out of SMS");
      set("sms_consent", patch.smsConsent, lead.smsConsent, "sms_consent");
      if (patch.emailOptOut === true && lead.email) this.suppress(lead.email, `manual opt-out by ${actor}`);
      if (patch.smsOptOut === true && lead.phone) this.suppress(lead.phone, `manual opt-out by ${actor}`);
      if (patch.emailOptOut === false && lead.email) this.unsuppress(lead.email);
      if (patch.smsOptOut === false && lead.phone) this.unsuppress(lead.phone);
      if (changes.length) this.logEvent(id, "contact.manual_change", `${actor}: ${changes.join(", ")}`);
    });
    return this.getLead(id)!;
  }

  /** After a successful send: delivery status SENT, last_contacted_at, and first contact moves the stage to "sent". */
  markContacted(id: number, channel: CommChannel, atIso: string): void {
    this.tx(() => {
      const col = channel === "EMAIL" ? "email_status" : "sms_status";
      this.db
        .prepare(`UPDATE leads SET ${col} = 'SENT', last_contacted_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
        .run(atIso, id);
      const lead = this.getLead(id)!;
      if (PRE_CONTACT_STAGES.includes(lead.status)) this.setStatus(id, "sent", `contacted by ${channel}`);
    });
  }

  /** Provider delivery updates. Never moves backwards (a late "sent" can't undo "delivered"). */
  setDeliveryStatus(id: number, channel: CommChannel, status: EmailStatus | SmsStatus): void {
    const lead = this.getLead(id);
    if (!lead) return;
    const current = channel === "EMAIL" ? lead.emailStatus : lead.smsStatus;
    if (current && (DELIVERY_RANK[status] ?? 0) < (DELIVERY_RANK[current] ?? 0)) return;
    const col = channel === "EMAIL" ? "email_status" : "sms_status";
    this.db.prepare(`UPDATE leads SET ${col} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(status, id);
  }

  /** Any reply: mark replied and pause automated follow-ups. */
  markReplied(id: number): void {
    this.db
      .prepare("UPDATE leads SET replied = 1, sequence_paused = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(id);
  }

  setLastReplyClassification(id: number, cls: ReplyClassificationRecord): void {
    this.db
      .prepare("UPDATE leads SET last_reply_classification_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(JSON.stringify(cls), id);
  }

  // ---------- suppression list ----------

  suppress(value: string, reason: string): void {
    const v = suppressionKey(value);
    if (!v) return;
    this.db.prepare("INSERT OR IGNORE INTO suppressions (value, reason) VALUES (?, ?)").run(v, reason);
  }

  unsuppress(value: string): void {
    const v = suppressionKey(value);
    if (v) this.db.prepare("DELETE FROM suppressions WHERE value = ?").run(v);
  }

  isSuppressed(value: string | null | undefined): boolean {
    const v = suppressionKey(value);
    if (!v) return false;
    return Boolean(this.db.prepare("SELECT 1 FROM suppressions WHERE value = ?").get(v));
  }

  // ---------- drafts ----------

  saveDraft(leadId: number, d: { emailSubject: string; emailBody: string; smsBody: string; reasoning: string }): Draft {
    const res = this.db
      .prepare("INSERT INTO drafts (lead_id, email_subject, email_body, sms_body, reasoning) VALUES (?, ?, ?, ?, ?)")
      .run(leadId, d.emailSubject, d.emailBody, d.smsBody, d.reasoning);
    this.logEvent(leadId, "draft.created", `draft ${res.lastInsertRowid}`);
    return this.getDraft(Number(res.lastInsertRowid))!;
  }

  getDraft(id: number): Draft | null {
    const r = this.db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToDraft(r) : null;
  }

  latestDraft(leadId: number): Draft | null {
    const r = this.db.prepare("SELECT * FROM drafts WHERE lead_id = ? ORDER BY id DESC LIMIT 1").get(leadId) as Row | undefined;
    return r ? rowToDraft(r) : null;
  }

  updateDraft(id: number, patch: Partial<Pick<Draft, "emailSubject" | "emailBody" | "smsBody">>): Draft {
    const d = this.getDraft(id);
    if (!d) throw new Error(`draft ${id} not found`);
    this.db
      .prepare("UPDATE drafts SET email_subject = ?, email_body = ?, sms_body = ? WHERE id = ?")
      .run(patch.emailSubject ?? d.emailSubject, patch.emailBody ?? d.emailBody, patch.smsBody ?? d.smsBody, id);
    return this.getDraft(id)!;
  }

  decideDraft(id: number, approved: boolean, decision: string): void {
    this.db.prepare("UPDATE drafts SET approved = ?, decision = ? WHERE id = ?").run(approved ? 1 : 0, decision, id);
  }

  // ---------- communications ----------

  recordCommunication(c: NewCommunication): Communication {
    const res = this.db
      .prepare(
        `INSERT INTO communications (lead_id, draft_id, campaign_id, direction, channel, provider, provider_message_id, idempotency_key,
           recipient, sender, subject, body, status, error, classification_json, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.leadId,
        c.draftId ?? null,
        c.campaignId ?? null,
        c.direction,
        c.channel,
        c.provider,
        c.providerMessageId ?? null,
        c.idempotencyKey ?? null,
        c.recipient ?? null,
        c.sender ?? null,
        c.subject ?? null,
        c.body,
        c.status,
        c.error ?? null,
        c.classification ? JSON.stringify(c.classification) : null,
        c.sentAt ?? null,
      );
    return this.getCommunication(Number(res.lastInsertRowid))!;
  }

  getCommunication(id: number): Communication | null {
    const r = this.db.prepare("SELECT * FROM communications WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToCommunication(r) : null;
  }

  findCommunicationByProviderId(provider: CommProvider, providerMessageId: string): Communication | null {
    const r = this.db
      .prepare("SELECT * FROM communications WHERE provider = ? AND provider_message_id = ?")
      .get(provider, providerMessageId) as Row | undefined;
    return r ? rowToCommunication(r) : null;
  }

  /** Successful send previously recorded under this idempotency key (used to make retries safe). */
  findCommunicationByIdempotencyKey(key: string): Communication | null {
    const r = this.db.prepare("SELECT * FROM communications WHERE idempotency_key = ?").get(key) as Row | undefined;
    return r ? rowToCommunication(r) : null;
  }

  setCommunicationStatus(id: number, status: CommStatus, error?: string | null): void {
    this.db
      .prepare("UPDATE communications SET status = ?, error = COALESCE(?, error), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(status, error ?? null, id);
  }

  setCommunicationClassification(id: number, cls: ReplyClassificationRecord): void {
    this.db
      .prepare("UPDATE communications SET classification_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(JSON.stringify(cls), id);
  }

  communicationsForLead(leadId: number): Communication[] {
    return (this.db.prepare("SELECT * FROM communications WHERE lead_id = ? ORDER BY id").all(leadId) as Row[]).map(rowToCommunication);
  }

  /** Outbound messages on `channel` sent since `sinceIso` (used for daily caps). */
  countOutboundSince(channel: CommChannel, sinceIso: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM communications WHERE channel = ? AND direction = 'OUTBOUND' AND status != 'FAILED' AND created_at >= ?")
      .get(channel, sinceIso) as Row;
    return Number(r.n);
  }

  // ---------- events / reporting ----------

  logEvent(leadId: number | null, type: string, detail?: string): void {
    this.db.prepare("INSERT INTO events (lead_id, type, detail) VALUES (?, ?, ?)").run(leadId, type, detail ?? null);
  }

  eventsForLead(leadId: number): { type: string; detail: string | null; createdAt: string }[] {
    return (this.db.prepare("SELECT type, detail, created_at FROM events WHERE lead_id = ? ORDER BY id").all(leadId) as Row[]).map((r) => ({
      type: String(r.type),
      detail: (r.detail as string) ?? null,
      createdAt: String(r.created_at),
    }));
  }

  /** Lead counts per status, plus funnel counts ("reached at least stage X"). */
  stats(): { byStatus: Record<string, number>; funnel: Record<string, number> } {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM leads GROUP BY status").all() as Row[];
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[String(r.status)] = Number(r.n);
    const reached = this.db
      .prepare("SELECT type, COUNT(DISTINCT lead_id) AS n FROM events WHERE type LIKE 'status.%' GROUP BY type")
      .all() as Row[];
    const funnel: Record<string, number> = {};
    for (const stage of ["sent", "delivered", "replied", "interested", "booked", "closed"]) funnel[stage] = 0;
    for (const r of reached) {
      const stage = String(r.type).slice("status.".length);
      if (stage in funnel) funnel[stage] = Number(r.n);
    }
    return { byStatus, funnel };
  }
}

export function hostOf(url: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function suppressionKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v.includes("@")) return v;
  return normalizePhone(v);
}

/**
 * Demo mode. These are scripted sample answers, NOT real AI. They let every screen,
 * download and voice flow be tested and shown before an API key is added.
 */

import { freelanceDraft, ndaDraft, employmentDraft, saleDraft, type Fill } from "./mockDrafts";
import { clientWords } from "../callTranscript";
import { readCall } from "../callReader";
import { guessType } from "../law";
import {
  STAGES,
  type ChatRequest,
  type ConversationReply,
  type DraftRequest,
  type LegalCheck,
  type Obligation,
  type Stage,
} from "./schemas";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---------------- conversation ---------------- */

const QUESTIONS: Record<Exclude<Stage, "confirm" | "terms">, string> = {
  background:
    "Thank you. First, tell me the background: why is this needed, how do you know the other person, and is anything already agreed or in writing?",
  parties:
    "Got it. Now the parties: what are the full legal names and addresses of both sides, and what is your own role?",
  "what-ifs":
    "Now the uncomfortable part. What if payment is late, someone wants to leave early, or something gets damaged? Who bears which cost?",
  "special conditions":
    "Almost there. Is there anything unusual to include or leave out, such as renewal, witnesses, or who keeps the original?",
};

const TERMS_QUESTION: Record<string, string> = {
  "Residential Rent Agreement":
    "Now the key terms: the monthly rent, due date, security deposit, start date, how long it runs, and the notice period.",
  "Freelance Services Agreement":
    "Now the key terms: the exact work to be delivered, the fee and payment schedule, deadlines, and how many revisions are included.",
  "Non-Disclosure Agreement":
    "Now the key terms: the purpose of sharing, what counts as confidential, how long it lasts, and what must be returned or destroyed.",
  "Employment Agreement":
    "Now the key terms: the role, salary and its parts, start date, probation, notice period, and work location.",
  "Sale of Movable Property":
    "Now the key terms: the item and its identifying details, the price, any advance, the payment mode, and the delivery date.",
};

const REQUIRED: Record<string, { key: string; label: string }[]> = {
  "Residential Rent Agreement": [
    { key: "landlord_name", label: "Landlord name" },
    { key: "tenant_name", label: "Tenant name" },
    { key: "property_address", label: "Property address" },
    { key: "monthly_rent", label: "Monthly rent" },
    { key: "security_deposit", label: "Security deposit" },
    { key: "start_date", label: "Start date" },
  ],
  "Freelance Services Agreement": [
    { key: "client_name", label: "Client name" },
    { key: "freelancer_name", label: "Freelancer name" },
    { key: "scope", label: "Scope of work" },
    { key: "fee", label: "Fee" },
    { key: "deadline", label: "Deadline" },
  ],
  "Non-Disclosure Agreement": [
    { key: "disclosing_party", label: "Disclosing party" },
    { key: "receiving_party", label: "Receiving party" },
    { key: "purpose", label: "Purpose" },
    { key: "duration", label: "Duration" },
  ],
  "Employment Agreement": [
    { key: "employer_name", label: "Employer name" },
    { key: "employee_name", label: "Employee name" },
    { key: "role", label: "Role" },
    { key: "salary", label: "Salary" },
    { key: "start_date", label: "Start date" },
  ],
  "Sale of Movable Property": [
    { key: "seller_name", label: "Seller name" },
    { key: "buyer_name", label: "Buyer name" },
    { key: "item", label: "Item" },
    { key: "price", label: "Price" },
    { key: "delivery_date", label: "Delivery date" },
  ],
};

function amountAfter(text: string, word: RegExp): string | null {
  const m = text.match(
    new RegExp(`${word.source}[^\\d]{0,40}(?:rs\\.?|₹|inr)?\\s?(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k|thousand|lakh|lakhs)?`, "i"),
  );
  if (!m) return null;
  const mult = /^k|thousand/i.test(m[2] ?? "") ? "000" : /lakh/i.test(m[2] ?? "") ? "00000" : "";
  const n = m[1].replace(/,/g, "") + mult;
  return "Rs " + Number(n).toLocaleString("en-IN");
}

function extractFields(text: string, type: string | null) {
  const fields: ConversationReply["fields"] = [];
  const add = (key: string, label: string, value: string | null) => {
    if (value) fields.push({ key, label, value });
  };
  if (type === "Residential Rent Agreement") {
    add("monthly_rent", "Monthly rent", amountAfter(text, /\brent\b/));
    add("security_deposit", "Security deposit", amountAfter(text, /\bdeposit\b/));
  } else if (type === "Freelance Services Agreement") {
    add("fee", "Fee", amountAfter(text, /\b(?:fee|pay|paying|budget)\b/));
  } else if (type === "Employment Agreement") {
    add("salary", "Salary", amountAfter(text, /\b(?:salary|ctc)\b/));
  } else if (type === "Sale of Movable Property") {
    add("price", "Price", amountAfter(text, /\b(?:price|for)\b/));
  }
  const name = text.match(/my name is ([A-Z][a-z]+(?: [A-Z][a-z]+)*)/);
  if (name) add("client_name", "Your name", name[1]);
  return fields;
}

function guessRole(text: string, type: string | null): string | null {
  const t = text.toLowerCase();
  if (type === "Residential Rent Agreement") {
    if (/\b(rent out|my flat|my house|landlord)\b/.test(t)) return "landlord";
    if (/\b(tenant|looking to rent|want to rent)\b/.test(t)) return "tenant";
  }
  if (type === "Freelance Services Agreement") {
    if (/\b(hiring|hire|i need a)\b/.test(t)) return "client";
    if (/\b(i am a freelancer|i'm a freelancer)\b/.test(t)) return "freelancer";
  }
  if (type === "Sale of Movable Property") {
    if (/\b(selling|sell my)\b/.test(t)) return "seller";
    if (/\b(buying|buy a)\b/.test(t)) return "buyer";
  }
  return null;
}

function legalFlags(last: string): ConversationReply["legal_flags"] {
  const t = last.toLowerCase();
  const flags: ConversationReply["legal_flags"] = [];
  if (/non-?\s?refundable/.test(t)) {
    flags.push({
      issue: "A completely non-refundable deposit",
      status: "unenforceable",
      consequence:
        "A court can cut a harsh forfeiture down to reasonable compensation, and a very high or non-refundable deposit is a sign of an unfair term.",
      sources: ["ICA-74", "MTA-2021"],
    });
  }
  if (/non-?\s?compete|not (to )?work (for|with) (a )?competitor/.test(t)) {
    flags.push({
      issue: "A non-compete that applies after the job or contract ends",
      status: "not_legal",
      consequence:
        "It cannot be enforced against a person's right to earn a living, although confidentiality clauses can.",
      sources: ["ICA-27", "CON-19"],
    });
  }
  if (/(decision.{0,30}final|no court|only (the )?landlord decides)/.test(t)) {
    flags.push({
      issue: "A clause making one side's decision final or barring the courts",
      status: "unenforceable",
      consequence: "Such a clause is void, and a court can still hear the dispute.",
      sources: ["ICA-28", "ARB-12"],
    });
  }
  if (/(evict|vacate|throw (them )?out).{0,40}(immediately|any ?time|without notice)/.test(t)) {
    flags.push({
      issue: "Evicting a tenant immediately without notice",
      status: "risky",
      consequence:
        "A tenant cannot lawfully be removed without the agreed notice and the process the rent law requires.",
      sources: ["TPA-106", "TRC-10", "CON-300A"],
    });
  }
  if (/cheque/.test(t)) {
    flags.push({
      issue: "A security cheque",
      status: "risky",
      consequence:
        "If a cheque bounces, the person who signed it can face prosecution, so security cheques are risky for the signer.",
      sources: ["NIA-138"],
    });
  }
  if (/(confiscate|keep (his|her|their) original|original documents|training bond)/.test(t)) {
    flags.push({
      issue: "Holding someone's original documents or binding them to service",
      status: "risky",
      consequence: "Such clauses can be void and can even attract criminal liability.",
      sources: ["CON-23"],
    });
  }
  return flags;
}

function summaryOf(details: Record<string, string>, type: string | null): string {
  const parts = Object.entries(details).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`);
  const what = type ?? "agreement";
  return parts.length
    ? `So this is a ${what.toLowerCase()} with ${parts.join(", ")}. Is that all correct, and shall I draft it?`
    : `So this is a ${what.toLowerCase()}, and I will mark the details we don't have as blanks for you to fill in. Is that all correct, and shall I draft it?`;
}

export function mockConversation(req: ChatRequest): ConversationReply {
  const { turns, state } = req;
  const userTurns = turns.filter((t) => t.role === "user");
  // After a voice call, read what the client said in the call as if they had just typed it.
  const callWords = state.callTranscript ? clientWords(state.callTranscript) : "";
  const last = [callWords, userTurns[userTurns.length - 1]?.content ?? ""].filter(Boolean).join(" ");
  const all = [callWords, ...userTurns.map((t) => t.content)].filter(Boolean).join(" ");
  const lower = last.toLowerCase();

  const type = state.contractType ?? guessType(all);
  const role = state.userRole ?? guessRole(all, type);
  const typed = extractFields(last, type);
  const fromCall = state.callTranscript ? readCall(state.callTranscript, type, role) : [];
  const newFields = [...typed.filter((f) => !fromCall.some((c) => c.key === f.key) && !(fromCall.length > 0 && f.key === "client_name")), ...fromCall];
  const merged = { ...state.details };
  newFields.forEach((f) => (merged[f.key] = f.value));
  const missing = (type ? (REQUIRED[type] ?? []) : [])
    .filter((r) => !merged[r.key])
    .map((r) => r.label);

  const base: ConversationReply = {
    reply: "",
    intent: "chat",
    contract_type: type,
    user_role: role,
    stage: state.stage,
    ready: state.ready,
    pushback: false,
    fields: newFields,
    missing,
    action: "none",
    legal_flags: legalFlags(last),
    advice: null,
  };
  const flagLine = base.legal_flags.length
    ? `I have to be plain with you: ${base.legal_flags[0].issue.toLowerCase()} is a problem under Indian law. `
    : "";

  // A worry rather than a document: one-turn sample advice.
  if (!state.stage && /(won'?t|not|refus\w*|isn'?t).{0,20}(return|give back|refund)|deposit.{0,20}(back|return)/.test(lower)) {
    return {
      ...base,
      intent: "advice",
      reply:
        "Please don't worry, we'll work through this. In short, you can ask for the deposit in writing and escalate if it is still withheld; the details are on screen.",
      advice: {
        headline: "A landlord keeping a deposit without a lawful reason can be challenged",
        sections: [
          { id: "ICA-73", law: "Indian Contract Act 1872", section: "s.73", plain: "You can claim compensation for real, provable loss caused by the breach.", confidence: "high" },
          { id: "BNS-316", law: "Bharatiya Nyaya Sanhita 2023", section: "s.316", plain: "Dishonestly misusing money entrusted to someone, such as a deposit, can be a criminal offence.", confidence: "verify" },
          { id: "LIM-55", law: "Limitation Act 1963", section: "Articles 54 and 55", plain: "A claim for breach of contract generally has to be filed within three years.", confidence: "high" },
        ],
        consequences: [
          "A court can order the deposit to be returned, and it can award interest and costs.",
          "Waiting too long can permanently bar the claim.",
        ],
        steps: [
          "Send a polite written request for the deposit, with the date and amount.",
          "Keep the agreement, payment proof and messages together.",
          "If there is no reply, ask an advocate to send a legal notice.",
        ],
      },
    };
  }

  const wantsDraft = /\b(draft|write)\b.{0,25}\b(it|now|contract|agreement)\b|\bdraft it\b|please draft/.test(lower);
  const affirmative = /^(yes|yeah|yep|correct|that'?s (all )?(right|correct)|all correct|ok(ay)?|sure|confirmed?)\b/.test(lower.trim());

  if (wantsDraft) {
    if (state.ready || (state.stage === "confirm" && affirmative)) {
      return { ...base, intent: "draft", ready: true, stage: "confirm", action: "draft_now", reply: `${flagLine}Drafting it now. It will appear on the right, with any unknown details highlighted for you to fill in.` };
    }
    if (state.pushback >= 1) {
      return { ...base, intent: "draft", action: "draft_now", reply: `Understood. I'm drafting it now, and anything we don't know yet will be highlighted for you to fill in.` };
    }
    const next = missing[0] ? `We still need the ${missing[0].toLowerCase()}. ` : "";
    return { ...base, intent: "draft", pushback: true, reply: `${next}Careful drafting protects you, so let me ask a few more things first. ${TERMS_QUESTION[type ?? ""] ?? QUESTIONS.background}` };
  }

  // Interview: move one stage forward per answer.
  if (state.stage === "confirm") {
    if (affirmative) {
      return { ...base, intent: "draft", ready: true, stage: "confirm", reply: `${flagLine}Thank you. Just say "draft it" and I'll write it now.` };
    }
    return { ...base, intent: "draft", stage: "confirm", ready: false, reply: `${flagLine}Noted. ${summaryOf(merged, type)}` };
  }

  const idx = state.stage ? STAGES.indexOf(state.stage) : -1;
  const nextStage = STAGES[Math.min(idx + 1, STAGES.length - 1)];
  let question: string;
  if (nextStage === "confirm") question = summaryOf(merged, type);
  else if (nextStage === "terms") question = TERMS_QUESTION[type ?? ""] ?? "Now the key terms: the amounts, dates and duration.";
  else question = QUESTIONS[nextStage];

  return {
    ...base,
    intent: type ? "draft" : "chat",
    stage: nextStage,
    reply: `${flagLine}${question}`,
  };
}

/* ---------------- drafting ---------------- */

function v(details: Record<string, string>, key: string, what: string): string {
  return details[key] ?? `[[to be filled: ${what}]]`;
}

export function mockDraftText(req: DraftRequest): string {
  const d = req.details;
  const type = req.contractType;

  if (type === "Residential Rent Agreement") {
    return `TITLE: RESIDENTIAL RENT AGREEMENT
This Agreement is made on [[to be filled: date]] at Hyderabad, Telangana, between ${v(d, "landlord_name", "landlord's full name and address")} (the **Landlord**) and ${v(d, "tenant_name", "tenant's full name and address")} (the **Tenant**).
## 1. Property and purpose
The Landlord lets to the Tenant the residential property at ${v(d, "property_address", "full property address")} (the **Premises**) for residential use only.
> why: A lease is defined by what it does, not what it is called, so the property and use must be clear. (Source: TPA-105)
## 2. Term
The tenancy begins on ${v(d, "start_date", "start date")} and runs for ${v(d, "term", "term, for example 11 months")}.
> why: A lease longer than one year must be registered, which is why many residential agreements run for 11 months. (Source: TPA-107, REG-17)
## 3. Rent
The Tenant shall pay rent of ${v(d, "monthly_rent", "monthly rent")} per month, on or before [[to be filled: due date]] of each month. Rent may be revised only by written agreement of both parties.
> why: A rent the landlord can change "as he sees fit" is too vague to enforce. (Source: ICA-29)
## 4. Security deposit
The Tenant has paid a refundable security deposit of ${v(d, "security_deposit", "security deposit")}. It shall be returned within [[to be filled: number of days]] days of the Tenant vacating, after deducting only proven unpaid dues or damage beyond normal wear and tear.
> why: A deposit cannot be forfeited beyond reasonable compensation, and a very high or non-refundable deposit signals an unfair term. (Source: ICA-74, MTA-2021)
## 5. Repairs and use
(a) The Tenant shall keep the Premises in good condition and shall not sublet without written consent.
(b) The Landlord shall disclose known defects and bear structural repairs. Ordinary wear and tear is not the Tenant's liability.
> why: The landlord has duties too, and charging a tenant for old damage can breach them. (Source: TPA-108)
## 6. Entry
The Landlord may enter the Premises on [[to be filled: hours of notice]] hours' prior notice at a reasonable time, or at once in an emergency.
> why: Entry at any time can be challenged as against privacy and public policy. (Source: CON-21)
## 7. Termination and notice
Either party may end the tenancy by giving ${v(d, "notice_period", "notice period, for example 30 days")} written notice. If the Tenant leaves before the lock-in ends, compensation shall be limited to the Landlord's reasonable proven loss. When the tenancy ends the Tenant shall vacate and hand over possession of the Premises in the condition received, subject to normal wear and tear.
> why: A tenant cannot be told to leave immediately without notice, and a harsh early-exit sum can be cut down by a court. (Source: TPA-106, ICA-74)
## 8. Dispute resolution
Any dispute shall be referred to a sole arbitrator appointed by mutual consent, seated in Hyderabad, under the Arbitration and Conciliation Act 1996.
> why: Arbitration is allowed, but a clause letting one side appoint the arbitrator or decide finally is void. (Source: ARB-7, ARB-12, ICA-28)
## 9. Governing law and courts
This Agreement is governed by the laws of India, and the courts at Hyderabad, Telangana shall have jurisdiction.
> why: Courts must have real connection with the property, so a distant court alone may not work. (Source: CPC-16)
## 10. General
This is the entire agreement between the parties. If any clause is found invalid, the rest remains in force. Notices shall be in writing to the addresses above.
> why: Terms promised only by word of mouth are hard to enforce once the agreement is written. (Source: BSA-94)
SIGN: Landlord, ${v(d, "landlord_name", "landlord's name")}
SIGN: Tenant, ${v(d, "tenant_name", "tenant's name")}
SIGN: Witness 1
SIGN: Witness 2
===BEFORE YOU SIGN===
- Pay stamp duty at the current Telangana rate for a lease and use stamp paper or an e-stamp of that value before anyone signs. Unstamped agreements cannot be relied on in court. (STAMP-35)
- A lease of more than one year must be made by a registered instrument and presented for registration within four months of signing; otherwise it may not hold up as a lease. (TPA-107, REG-17, REG-23)
- Ask an advocate whether the Telangana Buildings (Lease, Rent and Eviction) Control Act 1960 covers this building, because it can limit eviction and rent. (TRC-10)
- Tax may have to be deducted from rent in some cases. Ask a chartered accountant. (TAX-TDS)
- Both parties should sign with valid ID, or e-sign through a valid Aadhaar e-Sign provider. (ITA-10A)
- Fill in every highlighted blank before signing.`;
  }

  const f: Fill = (key, what) => v(d, key, what);
  if (type === "Freelance Services Agreement") return freelanceDraft(f);
  if (type === "Non-Disclosure Agreement") return ndaDraft(f);
  if (type === "Employment Agreement") return employmentDraft(f);
  return saleDraft(f);
}

export async function* mockDraftStream(req: DraftRequest): AsyncGenerator<string> {
  const text = mockDraftText(req);
  for (let i = 0; i < text.length; i += 24) {
    yield text.slice(i, i + 24);
    await sleep(12);
  }
}

/* ---------------- legal check and obligations ---------------- */

export function mockLegalCheck(text: string): LegalCheck {
  const blanks = /\[\s*_+|to be filled|fill in/i.test(text);
  return {
    verdict: blanks ? "fix before signing" : "ready to sign",
    headline: blanks
      ? "The terms are lawful, but blanks must be filled in and the document stamped before signing."
      : "No unlawful clauses found in this sample check.",
    items: [
      { clause: "Parties and purpose", status: "lawful", consequence: "Clear parties and a lawful purpose are the base of an enforceable agreement.", sources: ["ICA-10"] },
      { clause: "Amounts and payment", status: blanks ? "risky" : "lawful", consequence: "Blank or vague amounts can make a term unenforceable.", sources: ["ICA-29"] },
      { clause: "Early exit and deposit", status: "lawful", consequence: "Compensation is limited to reasonable loss, which a court would uphold.", sources: ["ICA-74"] },
      { clause: "Notice and termination", status: "lawful", consequence: "A written notice period is required before a tenancy or contract ends.", sources: ["TPA-106"] },
      { clause: "Dispute resolution", status: "lawful", consequence: "Arbitration by mutual consent is valid; one-sided appointment would not be.", sources: ["ARB-7", "ARB-12"] },
      { clause: "Governing law and courts", status: "lawful", consequence: "Courts at Hyderabad have a real connection with the matter.", sources: ["CPC-16"] },
    ],
    requirements: [
      { what: "Pay stamp duty at Telangana's current rate.", sources: ["STAMP-35"] },
      { what: "Register the agreement if it runs for more than one year.", sources: ["REG-17", "TPA-107"] },
      { what: "Sign with valid ID, or use a valid Aadhaar e-Sign.", sources: ["ITA-10A"] },
      { what: "Have two witnesses sign.", sources: [] },
    ],
  };
}

export function mockObligations(): Obligation[] {
  return [
    { party: "Payer", action: "Pay the agreed amount", amount: null, due: "As per the payment schedule", trigger: null, penalty: "Reasonable compensation for delay" },
    { party: "Both parties", action: "Give written notice before ending the agreement", amount: null, due: "Within the agreed notice period", trigger: "Decision to end the agreement", penalty: null },
    { party: "Holder of any deposit", action: "Return the deposit", amount: null, due: "Within the agreed number of days after exit", trigger: "End of the agreement", penalty: "Interest or damages if withheld without cause" },
    { party: "Both parties", action: "Stamp and register the agreement where required", amount: null, due: "Before or soon after signing", trigger: "Signing", penalty: null },
  ];
}

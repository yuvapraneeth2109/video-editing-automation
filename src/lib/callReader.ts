/**
 * Demo-mode reader for a finished voice call. The real AI reads a call freely; this one has to cope with no AI at
 * all, so it pairs each of the voice agent's questions with the client's answer and pulls out names, money, dates,
 * lengths of time and places. It is deliberately modest: whatever it cannot read stays a blank for the client.
 */

export interface ReadField {
  key: string;
  label: string;
  value: string;
}

const LABELS: Record<string, string> = {
  landlord_name: "Landlord name",
  tenant_name: "Tenant name",
  property_address: "Property address",
  monthly_rent: "Monthly rent",
  security_deposit: "Security deposit",
  start_date: "Start date",
  term: "Length of tenancy",
  notice_period: "Notice period",
  client_name: "Client name",
  freelancer_name: "Freelancer name",
  scope: "Scope of work",
  fee: "Fee",
  deadline: "Deadline",
  disclosing_party: "Disclosing party",
  receiving_party: "Receiving party",
  purpose: "Purpose",
  duration: "Duration",
  employer_name: "Employer name",
  employee_name: "Employee name",
  role: "Role",
  salary: "Salary",
  seller_name: "Seller name",
  buyer_name: "Buyer name",
  item: "Item",
  price: "Price",
  delivery_date: "Delivery date",
};

/** Who the two sides are in each kind of contract: [role words, detail key]. */
const PARTIES: Record<string, [string[], string][]> = {
  "Residential Rent Agreement": [[["landlord", "owner", "lessor"], "landlord_name"], [["tenant", "lessee"], "tenant_name"]],
  "Freelance Services Agreement": [[["client"], "client_name"], [["freelancer", "contractor"], "freelancer_name"]],
  "Non-Disclosure Agreement": [[["discloser", "disclosing party"], "disclosing_party"], [["recipient", "receiving party"], "receiving_party"]],
  "Employment Agreement": [[["employer", "company"], "employer_name"], [["employee"], "employee_name"]],
  "Sale of Movable Property": [[["seller"], "seller_name"], [["buyer", "purchaser"], "buyer_name"]],
};

const MONEY_KEY: Record<string, string> = {
  "Residential Rent Agreement": "monthly_rent",
  "Freelance Services Agreement": "fee",
  "Employment Agreement": "salary",
  "Sale of Movable Property": "price",
};

/* ---------------- numbers ---------------- */

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { thousand: 1_000, k: 1_000, lakh: 100_000, lakhs: 100_000, lac: 100_000, lacs: 100_000, crore: 10_000_000, crores: 10_000_000 };

export interface Amount {
  value: number;
  start: number; // index in the text
  end: number;
}

/** Every amount in a piece of speech or text: "25,000", "25k", "twenty five thousand", "1 lakh 50 thousand", "2.5 lakh". */
export function findAmounts(text: string): Amount[] {
  const out: Amount[] = [];
  const re = /[a-z]+|\d[\d,]*(?:\.\d+)?|\S/gi;
  let m: RegExpExecArray | null;
  let total = 0;
  let cur = 0;
  let seen = false;
  let start = 0;
  let end = 0;
  let pendingAnd = false;
  const flush = () => {
    if (seen) out.push({ value: total + cur, start, end });
    total = 0; cur = 0; seen = false; pendingAnd = false;
  };
  while ((m = re.exec(text)) !== null) {
    const w = m[0].toLowerCase();
    const idx = m.index;
    if (/^\d/.test(w)) {
      if (!seen) start = idx;
      const n = parseFloat(w.replace(/,/g, ""));
      if (seen && cur !== 0 && !pendingAnd && total === 0 && cur >= 1000) flush(); // two separate big numbers in a row
      if (!seen) start = idx;
      cur += n; seen = true; end = idx + m[0].length; pendingAnd = false;
    } else if (w in UNITS) {
      if (!seen) start = idx;
      cur += UNITS[w]; seen = true; end = idx + m[0].length; pendingAnd = false;
    } else if (w in TENS) {
      if (!seen) start = idx;
      cur += TENS[w]; seen = true; end = idx + m[0].length; pendingAnd = false;
    } else if (w === "hundred" && seen) {
      cur = (cur || 1) * 100; end = idx + m[0].length; pendingAnd = false;
    } else if (w in SCALES && seen) {
      total += (cur || 1) * SCALES[w]; cur = 0; end = idx + m[0].length; pendingAnd = false;
    } else if (w === "and" && seen) {
      pendingAnd = true; // "one lakh and fifty thousand"
    } else if (seen && (w === "," || w === "rupees" || w === "rs" || w === "inr" || w === "₹")) {
      // keep the run going over a comma or a currency word
    } else {
      flush();
    }
  }
  flush();
  return out.filter((a) => a.value > 0);
}

/** Amounts that can plausibly be money: a bare four-digit number such as 2019 or 2026 is a year. */
function moneyAmounts(text: string): Amount[] {
  return findAmounts(text).filter((a) => {
    const raw = text.slice(a.start, a.end).trim();
    return !(/^(19|20)\d\d$/.test(raw));
  });
}

export function formatRs(n: number): string {
  return "Rs " + Math.round(n).toLocaleString("en-IN");
}

/** The first amount after a keyword (within a short distance), else the first amount before it. */
function amountNear(text: string, word: RegExp): number | null {
  const t = text.toLowerCase();
  const k = t.search(word);
  if (k < 0) return null;
  const all = moneyAmounts(t);
  const after = all.find((a) => a.start >= k && a.start - k < 60);
  if (after) return after.value;
  const before = [...all].reverse().find((a) => a.end <= k && k - a.end < 40);
  return before ? before.value : null;
}

/* ---------------- words, names, dates ---------------- */

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const MONTH_NAMES: Record<string, string> = { jan: "January", feb: "February", mar: "March", apr: "April", may: "May", jun: "June", jul: "July", aug: "August", sep: "September", oct: "October", nov: "November", dec: "December" };

function monthName(s: string): string {
  return MONTH_NAMES[s.slice(0, 3).toLowerCase()] ?? s;
}

export function findDate(text: string): string | null {
  const t = text.toLowerCase();
  let m = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?: of)?,? (${MONTHS})\\b,?(?: (\\d{4}))?`));
  if (m) return `${Number(m[1])} ${monthName(m[2])}${m[3] ? " " + m[3] : ""}`;
  m = t.match(new RegExp(`\\b(${MONTHS})\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b,?(?: (\\d{4}))?`));
  if (m) return `${Number(m[2])} ${monthName(m[1])}${m[3] ? " " + m[3] : ""}`;
  m = t.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/);
  if (m) return `${m[1]}/${m[2]}/${m[3]}`;
  m = t.match(/\b(next month|next week|tomorrow|today|immediately|from now)\b/);
  if (m) return m[1];
  return null;
}

const NUMBER_WORD = "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty five|forty-five|forty|sixty|ninety)";
function wordToDigits(s: string): string {
  const t = s.toLowerCase().replace(/-/g, " ");
  if (/^\d+$/.test(t)) return t;
  const a = findAmounts(t)[0];
  return a ? String(a.value) : s;
}

/** A length of time such as "11 months" or "30 days". */
export function findDuration(text: string, units: string[]): string | null {
  const re = new RegExp(`\\b(${NUMBER_WORD})\\s*(${units.join("|")})s?\\b`, "i");
  const m = text.match(re);
  if (!m) return null;
  const n = wordToDigits(m[1]);
  const u = m[2].toLowerCase();
  return `${n} ${u}${n === "1" ? "" : "s"}`;
}

const FILLER = /^(?:(?:um+|uh+|hmm+|well|so|okay|ok|yes|yeah|sure|right|actually|basically)[,.]?\s+)+/i;
const LEAD = /^(?:it'?s|it is|that'?s|that is|my name is|i am|i'm|this is|the name is|names? (?:are|is)|(?:the )?(?:landlord|tenant|owner|client|freelancer|employer|employee|seller|buyer|company|discloser|recipient)(?: name)?(?: is| are)?|(?:he|she) is|called)\s+/i;

/** "my name is ramesh kumar" -> "Ramesh Kumar". Returns null if nothing name-like is left. */
export function cleanName(raw: string): string | null {
  let s = raw.trim().replace(/[.!?]+$/, "").replace(FILLER, "");
  for (let i = 0; i < 3; i++) s = s.replace(LEAD, "");
  s = s.split(/\s+(?:and|but|who|which|from|at|in)\s+|,/i)[0].trim();
  s = s.replace(/^(?:mr|mrs|ms|shri|smt|dr)\.?\s+/i, (m) => m.trim().replace(/^./, (c) => c.toUpperCase()) + " ");
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return null;
  if (!words.every((w) => /^[a-z.'-]+$/i.test(w))) return null;
  if (words.some((w) => /^(yes|no|the|a|an|my|our|is|are|not|none|nothing)$/i.test(w))) return null;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function sentence(raw: string): string {
  const s = raw.trim().replace(FILLER, "").replace(/\s+/g, " ");
  return (s.charAt(0).toUpperCase() + s.slice(1)).slice(0, 220);
}

/* ---------------- the call ---------------- */

type Topic =
  | "deposit" | "notice" | "term" | "start" | "place" | "role" | "names" | "money" | "type"
  | "notes" | "item" | "scope" | "purpose" | "deadline" | "unknown";

export function classifyQuestion(q: string): Topic {
  const t = q.toLowerCase();
  if (/deposit|advance|security/.test(t)) return "deposit";
  if (/notice|end (it |the \w+ )?early|terminate|exit|leave early/.test(t)) return "notice";
  if (/how long|duration|how many (months|years)|for how|term of|period/.test(t)) return "term";
  if (/deadline|deliver by|due date|by when|delivery date|handover/.test(t)) return "deadline";
  if (/start|begin|from when|which date|what date|when (will|do|should|would)|move in/.test(t)) return "start";
  if (/where|address|location|situated|located/.test(t)) return "place";
  if (/\bnames?\b/.test(t)) return "names";
  if (/who are you|your role|which side|are you the|are you a /.test(t)) return "role";
  if (/who is|who are/.test(t)) return "names";
  if (/rent|monthly|how much|amount|fee|price|salary|\bpay|budget|ctc|cost|charge/.test(t)) return "money";
  if (/kind of|type of|what (do you need|agreement|contract|sort)/.test(t)) return "type";
  if (/special|anything else|any other|written in|add/.test(t)) return "notes";
  if (/item|vehicle|bike|car\b|model|what (are you|is being) (selling|buying|sold)/.test(t)) return "item";
  if (/work|scope|deliverable|service|project|job/.test(t)) return "scope";
  if (/purpose|why|share/.test(t)) return "purpose";
  return "unknown";
}

interface Exchange {
  q: string;
  a: string;
}

function exchanges(transcript: string): Exchange[] {
  const out: Exchange[] = [];
  let q = "";
  let a = "";
  const push = () => {
    if (a) out.push({ q, a });
    a = "";
  };
  for (const line of transcript.split("\n")) {
    if (line.startsWith("Voice agent: ")) {
      push();
      q = line.slice(13);
    } else if (line.startsWith("Client: ")) {
      a = a ? a + " " + line.slice(8) : line.slice(8);
    }
  }
  push();
  return out;
}

/** Reads the call. `role` is the side the client is on (for example "landlord"), when known. */
export function readCall(transcript: string, contractType: string | null, role: string | null): ReadField[] {
  const found = new Map<string, string>();
  const set = (key: string, value: string | null | undefined) => {
    if (value && value.trim()) found.set(key, value.trim());
  };
  const type = contractType ?? "";
  const parties = PARTIES[type] ?? [];
  const moneyKey = MONEY_KEY[type];

  const sideOf = (word: string | null) => parties.find(([words]) => word && words.includes(word.toLowerCase()));
  const mySide = role ? sideOf(role) : undefined;
  const otherSide = mySide ? parties.find((p) => p !== mySide) : undefined;

  for (const { q, a } of exchanges(transcript)) {
    const lower = a.toLowerCase();
    let topic = classifyQuestion(q);

    // Without a usable question, read what the answer itself is about.
    if (topic === "unknown" || topic === "type" || topic === "role") {
      if (/deposit|advance/.test(lower)) topic = "deposit";
      else if (/\brent\b|salary|\bfee\b|price|ctc/.test(lower) && moneyAmounts(lower).length) topic = "money";
    }

    // Anything the client says with a keyword is read by that keyword, whatever was asked.
    const depositAmt = amountNear(lower, /deposit|advance/);
    if (depositAmt && type === "Residential Rent Agreement") set("security_deposit", formatRs(depositAmt));
    if (type === "Residential Rent Agreement") {
      const rentAmt = amountNear(lower, /\brent\b/);
      if (rentAmt && rentAmt !== depositAmt) set("monthly_rent", formatRs(rentAmt));
    } else if (moneyKey) {
      const kw = type === "Freelance Services Agreement" ? /\bfee|pay|budget|charge/ : type === "Employment Agreement" ? /salary|ctc|per month/ : /price|cost|asking|(?:sell(?:ing)?|sold|buy(?:ing)?) (?:it |this |my \w+ )?for\b/;
      const amt = amountNear(lower, kw);
      if (amt) set(moneyKey, formatRs(amt));
    }

    // "My name is Ramesh Kumar" is the client's own name, whatever was asked.
    if (mySide && !found.has(mySide[1])) {
      const me = a.match(/\b(?:my name is|my name's|i am|i'm|this is)\s+([A-Za-z][A-Za-z.' -]{1,40})/i);
      const nm = cleanName(me?.[1] ?? "");
      if (nm && !parties.some(([words]) => words.some((w) => nm.toLowerCase() === w))) set(mySide[1], nm);
    }

    // Party names stated with a role, for example "the tenant is Suresh" or "Suresh is the tenant".
    for (const [words, key] of parties) {
      for (const w of words) {
        const fwd = a.match(new RegExp(`\\b${w}(?: name)?(?: is| are|:)?\\s+([A-Za-z][A-Za-z.' -]{1,40})`, "i"));
        const rev = a.match(new RegExp(`([A-Za-z][A-Za-z.' -]{1,40}?)\\s+(?:is|as|will be)\\s+(?:the |my )?${w}\\b`, "i"));
        const nm = cleanName(fwd?.[1] ?? "") ?? cleanName(rev?.[1] ?? "");
        if (nm && !/^(?:my|our|the|a)$/i.test(nm)) set(key, nm);
      }
    }

    switch (topic) {
      case "deposit": {
        const amt = moneyAmounts(lower)[0];
        if (amt && type === "Residential Rent Agreement") set("security_deposit", formatRs(amt.value));
        break;
      }
      case "money": {
        const amt = moneyAmounts(lower)[0];
        if (amt && moneyKey && !found.has(moneyKey)) set(moneyKey, formatRs(amt.value));
        break;
      }
      case "notice":
        set("notice_period", findDuration(a, ["day", "week", "month"]));
        break;
      case "term": {
        const d = findDuration(a, ["month", "year", "week", "day"]);
        if (type === "Non-Disclosure Agreement") set("duration", d);
        else set("term", d);
        break;
      }
      case "start":
        set(type === "Sale of Movable Property" ? "delivery_date" : "start_date", findDate(a));
        break;
      case "deadline":
        set(type === "Sale of Movable Property" ? "delivery_date" : "deadline", findDate(a) ?? sentence(a));
        break;
      case "place":
        if (type === "Residential Rent Agreement") set("property_address", sentence(a));
        break;
      case "names": {
        // Two names with no roles: the first is the client, the second is the other side.
        const parts = a.split(/\s+and\s+|,\s*/i).map((p) => cleanName(p)).filter((p): p is string => !!p);
        if (parts.length >= 2 && mySide && otherSide) {
          if (!found.has(mySide[1])) set(mySide[1], parts[0]);
          if (!found.has(otherSide[1])) set(otherSide[1], parts[1]);
        } else if (parts.length === 1 && mySide && !found.has(mySide[1]) && /\b(my name|i am|i'm|this is)\b/i.test(a)) {
          set(mySide[1], parts[0]);
        } else if (parts.length === 1 && otherSide && mySide && found.has(mySide[1]) && !found.has(otherSide[1])) {
          set(otherSide[1], parts[0]);
        } else if (parts.length === 1 && parties.length && !parties.some(([, k]) => found.has(k))) {
          set((mySide ?? parties[0])[1], parts[0]);
        }
        break;
      }
      case "item":
        if (type === "Sale of Movable Property") set("item", sentence(a));
        break;
      case "scope":
        if (type === "Freelance Services Agreement") set("scope", sentence(a));
        else if (type === "Employment Agreement") set("role", sentence(a));
        break;
      case "purpose":
        if (type === "Non-Disclosure Agreement") set("purpose", sentence(a));
        break;
      default:
        break;
    }

    // A date or duration can come up in any answer.
    if (topic !== "start" && /\b(start|begin|from|move in|starting)\b/.test(lower)) {
      const d = findDate(a);
      if (d) set(type === "Sale of Movable Property" ? "delivery_date" : "start_date", d);
    }
    if (type === "Residential Rent Agreement" && !found.has("term")) {
      const d = findDuration(a, ["month", "year"]);
      if (d && /(for|period|term|lease|tenancy|stay)/.test(lower)) set("term", d);
    }
  }

  // Only report values for fields this kind of contract knows about.
  return [...found.entries()].map(([key, value]) => ({ key, label: LABELS[key] ?? key, value }));
}

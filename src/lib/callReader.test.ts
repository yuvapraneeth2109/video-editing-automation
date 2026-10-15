import { describe, expect, it } from "vitest";
import { cleanName, findAmounts, findDate, findDuration, readCall, classifyQuestion } from "./callReader";
import { mockConversation, mockDraftText } from "./ai/mock";
import { checkDraft } from "./rulebook";

const amounts = (s: string) => findAmounts(s).map((a) => a.value);

describe("amounts as people say them", () => {
  it.each([
    ["25,000", [25000]],
    ["rs 25000 per month", [25000]],
    ["twenty five thousand", [25000]],
    ["25k", [25000]],
    ["one lakh fifty thousand", [150000]],
    ["1 lakh 50 thousand", [150000]],
    ["2.5 lakh", [250000]],
    ["one lakh and fifty thousand rupees", [150000]],
    ["fifty thousand", [50000]],
    ["rent is twenty five thousand and deposit is one lakh", [25000, 100000]],
    ["no number here", []],
  ])("%s", (text, expected) => expect(amounts(text)).toEqual(expected));
});

describe("names, dates and lengths of time", () => {
  it("cleans spoken names", () => {
    expect(cleanName("my name is ramesh kumar")).toBe("Ramesh Kumar");
    expect(cleanName("Um, it's Suresh")).toBe("Suresh");
    expect(cleanName("the tenant is priya sharma")).toBe("Priya Sharma");
    expect(cleanName("yes")).toBeNull();
    expect(cleanName("I would like to rent my flat in Madhapur next month please")).toBeNull();
  });
  it("finds dates", () => {
    expect(findDate("from the 1st of November 2026")).toBe("1 November 2026");
    expect(findDate("november first")).toBeNull();
    expect(findDate("starting 15 dec")).toBe("15 December");
    expect(findDate("June 3rd")).toBe("3 June");
  });
  it("finds lengths of time", () => {
    expect(findDuration("eleven months", ["month", "year"])).toBe("11 months");
    expect(findDuration("a notice of 30 days", ["day"])).toBe("30 days");
    expect(findDuration("two years", ["month", "year"])).toBe("2 years");
  });
  it("understands what the agent asked", () => {
    expect(classifyQuestion("How much is the monthly rent?")).toBe("money");
    expect(classifyQuestion("And is there a security deposit?")).toBe("deposit");
    expect(classifyQuestion("Where is the property?")).toBe("place");
    expect(classifyQuestion("What notice period for ending it early?")).toBe("notice");
  });
});

const RENT_CALL = [
  "Voice agent: Hello, I'm Sandhi's assistant. What kind of agreement do you need?",
  "Client: I want to rent out my flat to a tenant",
  "Voice agent: Who are you in it, and what are the names of both people?",
  "Client: I am the landlord, my name is Ramesh Kumar and the tenant is Suresh Reddy",
  "Voice agent: The money: how much is the monthly rent?",
  "Client: twenty five thousand rupees",
  "Voice agent: And the deposit or advance?",
  "Client: one lakh fifty thousand",
  "Voice agent: Where is the property?",
  "Client: Flat 302, Green Heights, Madhapur, Hyderabad",
  "Voice agent: When does it start and how long will it last?",
  "Client: from 1st November 2026 for eleven months",
  "Voice agent: What notice period if someone wants to end it early?",
  "Client: thirty days",
].join("\n");

describe("reading a whole call", () => {
  const fields = Object.fromEntries(readCall(RENT_CALL, "Residential Rent Agreement", "landlord").map((f) => [f.key, f.value]));
  it("reads the money", () => {
    expect(fields.monthly_rent).toBe("Rs 25,000");
    expect(fields.security_deposit).toBe("Rs 1,50,000");
  });
  it("reads both names, each on the right side", () => {
    expect(fields.landlord_name).toBe("Ramesh Kumar");
    expect(fields.tenant_name).toBe("Suresh Reddy");
  });
  it("reads the place, dates and notice", () => {
    expect(fields.property_address).toBe("Flat 302, Green Heights, Madhapur, Hyderabad");
    expect(fields.start_date).toBe("1 November 2026");
    expect(fields.term).toBe("11 months");
    expect(fields.notice_period).toBe("30 days");
  });
  it("never reads the agent's own words as facts", () => {
    const f = readCall("Voice agent: The rent is fifty thousand and the tenant is Anil Kapoor\nClient: okay", "Residential Rent Agreement", "landlord");
    expect(f).toEqual([]);
  });
  it("reads a freelance call", () => {
    const call = [
      "Voice agent: What kind of agreement?", "Client: I am hiring a freelance designer",
      "Voice agent: What names?", "Client: I am Meera Nair and the freelancer is Arjun Rao",
      "Voice agent: What work will be delivered?", "Client: a logo and a brand guide for my bakery",
      "Voice agent: How much is the fee?", "Client: forty thousand rupees",
      "Voice agent: By when?", "Client: by 20 December",
    ].join("\n");
    const f = Object.fromEntries(readCall(call, "Freelance Services Agreement", "client").map((x) => [x.key, x.value]));
    expect(f).toMatchObject({ client_name: "Meera Nair", freelancer_name: "Arjun Rao", fee: "Rs 40,000", deadline: "20 December" });
    expect(f.scope).toMatch(/logo/);
  });
  it("reads a bike sale", () => {
    const call = [
      "Voice agent: What are you selling?", "Client: I am selling my bike, a 2019 Honda Activa",
      "Voice agent: What is the price?", "Client: forty five thousand",
      "Voice agent: Names of seller and buyer?", "Client: seller is Kiran and buyer is Vamsi",
    ].join("\n");
    const f = Object.fromEntries(readCall(call, "Sale of Movable Property", "seller").map((x) => [x.key, x.value]));
    expect(f).toMatchObject({ price: "Rs 45,000", seller_name: "Kiran", buyer_name: "Vamsi" });
    expect(f.item).toMatch(/Activa/);
  });
});

describe("from the call to the draft (demo mode)", () => {
  const reply = mockConversation({
    turns: [{ role: "user", content: "I just finished a voice call. Please use what I said in it." }],
    state: { lang: "en", contractType: null, userRole: null, stage: null, ready: false, pushback: 0, drafted: false, details: {}, docContext: "", callTranscript: RENT_CALL },
  } as never);
  it("fills the details from the call", () => {
    const keys = reply.fields.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["monthly_rent", "security_deposit", "landlord_name", "tenant_name", "property_address", "start_date"]));
    expect(reply.contract_type).toBe("Residential Rent Agreement");
    expect(reply.missing).toEqual([]);
  });
  it("puts those details into the agreement and leaves no blank for them", () => {
    const details = Object.fromEntries(reply.fields.map((f) => [f.key, f.value]));
    const text = mockDraftText({ contractType: "Residential Rent Agreement", userRole: "landlord", details, said: "", extra: "" } as never);
    for (const v of ["Ramesh Kumar", "Suresh Reddy", "Rs 25,000", "Rs 1,50,000", "Flat 302", "1 November 2026", "11 months", "30 days"]) expect(text).toContain(v);
    expect(checkDraft("Residential Rent Agreement", text).items.filter((i) => i.status === "missing" || i.status === "problem")).toEqual([]);
  });
});

/** Preview prices. Not a live rate card. Report credits are a separate purchase. */
export const PLAN_CATALOG = [
  {
    id: "personal_1",
    mode: "personal" as const,
    name: "Personal · 1 watch",
    amountCents: 900,
    searchLimit: 1,
    lookupKey: "autoflip_personal_1_monthly",
    detail: "Monitor one saved vehicle search for new matching dealer listings.",
  },
  {
    id: "personal_3",
    mode: "personal" as const,
    name: "Personal · 3 watches",
    amountCents: 1900,
    searchLimit: 3,
    lookupKey: "autoflip_personal_3_monthly",
    detail: "Monitor up to three saved vehicle searches for new matching dealer listings.",
  },
  {
    id: "flip_metro",
    mode: "flip" as const,
    name: "Flip · three watches",
    amountCents: 4900,
    searchLimit: 3,
    lookupKey: "autoflip_flip_metro_monthly",
    detail: "Raise the free Flip watch cap to three local budgets (ZIP, radius, max purchase).",
  },
] as const;

export type PlanId = (typeof PLAN_CATALOG)[number]["id"];

export function planById(id: string) {
  return PLAN_CATALOG.find((plan) => plan.id === id) ?? null;
}

export function planByLookupKey(key: string) {
  return PLAN_CATALOG.find((plan) => plan.lookupKey === key) ?? null;
}

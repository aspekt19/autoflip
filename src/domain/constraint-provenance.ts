/**
 * Single field-level provenance for shopper constraints.
 *
 * Only `origin: "user"` may reach SERV as a hard / form constraint.
 * A value is `origin: "user"` ONLY when created by a shopper input event
 * (form edit or follow-up answer) via {@link fromShopperInputEvent}.
 * `note` / `serv` / `suggestion` travel as context or UI suggestions — never as Form edits.
 *
 * No code path may promote, infer, or overlay provenance onto `"user"`.
 */

/** Runtime brand — only {@link fromShopperInputEvent} sets this key. */
const UserOriginBrand = Symbol.for("lemonless.constraint.userOrigin");

export type ConstraintOrigin = "user" | "note" | "serv" | "suggestion";

export type Provenanced<T> = { value: T; origin: ConstraintOrigin };

/** Type-level: only this shape is accepted by SERV form/hard constraint builders. */
export type UserProvenanced<T> = {
  value: T;
  origin: "user";
  readonly [UserOriginBrand]: typeof UserOriginBrand;
};

export const CONSTRAINT_FIELD_KEYS = [
  "priceMaxUsd",
  "yearMin",
  "yearMax",
  "milesMax",
  "zip",
  "radiusMi",
  "bodyStyles",
  "drivetrain",
  "excludeMakes",
  "sellWithinDays",
] as const;

export type ConstraintFieldKey = (typeof CONSTRAINT_FIELD_KEYS)[number];

export type ConstraintBag = {
  priceMaxUsd?: Provenanced<number | null>;
  yearMin?: Provenanced<number | null>;
  yearMax?: Provenanced<number | null>;
  milesMax?: Provenanced<number | null>;
  zip?: Provenanced<string | null>;
  radiusMi?: Provenanced<number | null>;
  bodyStyles?: Provenanced<string[] | null>;
  drivetrain?: Provenanced<"awd_4wd" | null>;
  excludeMakes?: Provenanced<string[] | null>;
  sellWithinDays?: Provenanced<number | null>;
};

/** Form edits that may be sent to SERV as hard constraints — user origin only. */
export type ServFormConstraints = {
  [K in ConstraintFieldKey]?: UserProvenanced<
    ConstraintBag[K] extends Provenanced<infer V> | undefined ? V : never
  >;
};

/** Follow-up question ids that produce constraint bag cells. */
export type ShopperFollowUpConstraintId = "zip" | "cash" | "age" | "miles";

/**
 * The only legal constructors of `origin: "user"`.
 * - `form_edit` — Confirm / intake field the shopper typed.
 * - `follow_up` — clarification answer (zip / cash / age / miles).
 * - `wire` — revive a value already tagged user on a prior hop (never invent).
 * - `legacy_dirty` — migrate `{ dirty: true }` wire into branded user.
 */
export type ShopperInputEvent<T = unknown> =
  | { kind: "form_edit"; field: ConstraintFieldKey; value: T }
  | { kind: "follow_up"; id: ShopperFollowUpConstraintId; field: ConstraintFieldKey; value: T }
  | { kind: "wire"; field: ConstraintFieldKey; value: T }
  | { kind: "legacy_dirty"; field: ConstraintFieldKey; value: T };

function brandUser<T>(value: T): UserProvenanced<T> {
  return { value, origin: "user", [UserOriginBrand]: UserOriginBrand };
}

/**
 * Sole factory for `origin: "user"`. Call sites that need a user-tagged cell
 * must pass a shopper input event — never a bare `{ value, origin: "user" }` spread.
 */
export function fromShopperInputEvent<T>(event: ShopperInputEvent<T>): UserProvenanced<T> {
  void event.kind;
  void event.field;
  return brandUser(event.value);
}

export function isConstraintOrigin(value: unknown): value is ConstraintOrigin {
  return value === "user" || value === "note" || value === "serv" || value === "suggestion";
}

export function isUserProvenanced<T>(
  field: Provenanced<T> | null | undefined,
): field is UserProvenanced<T> {
  return field != null && field.origin === "user";
}

/** @deprecated Use {@link fromShopperInputEvent} — kept only for note/serv/suggestion helpers symmetry. */
export function userProvenanced<T>(_value: T): never {
  throw new Error(
    "userProvenanced is removed — construct origin:\"user\" only via fromShopperInputEvent(...)",
  );
}

export function noteProvenanced<T>(value: T): Provenanced<T> {
  return { value, origin: "note" };
}

export function servProvenanced<T>(value: T): Provenanced<T> {
  return { value, origin: "serv" };
}

export function suggestionProvenanced<T>(value: T): Provenanced<T> {
  return { value, origin: "suggestion" };
}

/** Type-level gate: SERV hard/form builders accept only UserProvenanced. */
export function acceptUserConstraint<T>(field: UserProvenanced<T>): UserProvenanced<T> {
  return field;
}

/** Runtime filter — strips every non-user field before SERV form serialization. */
export function pickUserFormConstraints(bag: ConstraintBag | null | undefined): ServFormConstraints {
  if (!bag) return {};
  const out: ServFormConstraints = {};
  for (const key of CONSTRAINT_FIELD_KEYS) {
    const field = bag[key] as Provenanced<unknown> | undefined;
    if (isUserProvenanced(field)) {
      (out as Record<string, UserProvenanced<unknown>>)[key] = acceptUserConstraint(
        fromShopperInputEvent({ kind: "wire", field: key, value: field.value }),
      );
    }
  }
  return out;
}

export function isUserOrigin(field: Provenanced<unknown> | null | undefined): boolean {
  return field?.origin === "user";
}

/**
 * Read a Provenanced cell from wire JSON.
 * Accepts `{ value, origin }` (canonical) or legacy `{ value, dirty: true }` → user via factory.
 * Bare values are never inferred as user.
 */
export function readProvenanced<T>(
  raw: unknown,
  field?: ConstraintFieldKey,
): Provenanced<T> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as { value?: unknown; origin?: unknown; dirty?: unknown };
  if (row.origin === "user") {
    const key = field ?? "priceMaxUsd";
    return fromShopperInputEvent<T>({ kind: "wire", field: key, value: row.value as T });
  }
  if (isConstraintOrigin(row.origin) && row.origin !== "user") {
    return { value: row.value as T, origin: row.origin };
  }
  if (row.dirty === true) {
    const key = field ?? "priceMaxUsd";
    return fromShopperInputEvent<T>({ kind: "legacy_dirty", field: key, value: row.value as T });
  }
  return undefined;
}

export function setUserEdit<K extends ConstraintFieldKey>(
  bag: ConstraintBag,
  key: K,
  value: NonNullable<ConstraintBag[K]>["value"],
): ConstraintBag {
  return {
    ...bag,
    [key]: fromShopperInputEvent({ kind: "form_edit", field: key, value }),
  };
}

/**
 * Apply a follow-up answer into the constraint bag with provenance.
 * Returns the bag unchanged when the id is not a constraint-producing follow-up
 * or the value does not parse into a constraint cell.
 */
export function applyFollowUpToConstraintBag(
  bag: ConstraintBag,
  id: string,
  value: string,
): ConstraintBag {
  const trimmed = value.trim();
  if (id === "zip") {
    if (!/^\d{5}$/.test(trimmed)) return bag;
    return {
      ...bag,
      zip: fromShopperInputEvent({
        kind: "follow_up",
        id: "zip",
        field: "zip",
        value: trimmed,
      }),
    };
  }
  if (id === "cash") {
    const amount = Number(trimmed.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(amount) || amount < 1000 || amount > 50_000) return bag;
    return {
      ...bag,
      priceMaxUsd: fromShopperInputEvent({
        kind: "follow_up",
        id: "cash",
        field: "priceMaxUsd",
        value: Math.round(amount),
      }),
    };
  }
  if (id === "age") {
    if (/^any$/i.test(trimmed)) {
      return {
        ...bag,
        yearMin: fromShopperInputEvent({
          kind: "follow_up",
          id: "age",
          field: "yearMin",
          value: null,
        }),
        yearMax: fromShopperInputEvent({
          kind: "follow_up",
          id: "age",
          field: "yearMax",
          value: null,
        }),
      };
    }
    const year = Number(trimmed);
    const cap = new Date().getUTCFullYear() + 1;
    if (!Number.isFinite(year) || year < 1980 || year > cap) return bag;
    return {
      ...bag,
      yearMin: fromShopperInputEvent({
        kind: "follow_up",
        id: "age",
        field: "yearMin",
        value: Math.round(year),
      }),
    };
  }
  if (id === "miles") {
    const raw = trimmed.replace(/,/g, "");
    if (/^any$/i.test(raw)) {
      return {
        ...bag,
        milesMax: fromShopperInputEvent({
          kind: "follow_up",
          id: "miles",
          field: "milesMax",
          value: null,
        }),
      };
    }
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount < 1_000 || amount > 400_000) return bag;
    return {
      ...bag,
      milesMax: fromShopperInputEvent({
        kind: "follow_up",
        id: "miles",
        field: "milesMax",
        value: Math.round(amount),
      }),
    };
  }
  return bag;
}

export function setNonUserField<K extends ConstraintFieldKey>(
  bag: ConstraintBag,
  key: K,
  value: NonNullable<ConstraintBag[K]>["value"],
  origin: Exclude<ConstraintOrigin, "user">,
): ConstraintBag {
  const existing = bag[key];
  if (existing?.origin === "user") return bag;
  return {
    ...bag,
    [key]: { value, origin },
  };
}

export function clearConstraintField<K extends ConstraintFieldKey>(
  bag: ConstraintBag,
  key: K,
): ConstraintBag {
  const next = { ...bag };
  delete next[key];
  return next;
}

export function servFormPayload(bag: ConstraintBag | null | undefined): ServFormConstraints {
  return pickUserFormConstraints(bag);
}

export type ConstraintStateStep =
  | { op: "user"; key: ConstraintFieldKey; value: unknown }
  | { op: "note"; key: ConstraintFieldKey; value: unknown }
  | { op: "serv"; key: ConstraintFieldKey; value: unknown }
  | { op: "suggestion"; key: ConstraintFieldKey; value: unknown }
  | { op: "clear"; key: ConstraintFieldKey }
  | { op: "freshNote" };

export function reduceConstraintSteps(steps: readonly ConstraintStateStep[]): {
  bag: ConstraintBag;
  snapshots: ServFormConstraints[];
} {
  let bag: ConstraintBag = {};
  const snapshots: ServFormConstraints[] = [];
  for (const step of steps) {
    if (step.op === "freshNote") {
      bag = {};
    } else if (step.op === "clear") {
      bag = clearConstraintField(bag, step.key);
    } else if (step.op === "user") {
      bag = setUserEdit(bag, step.key, step.value as never);
    } else {
      bag = setNonUserField(bag, step.key, step.value as never, step.op);
    }
    snapshots.push(servFormPayload(bag));
  }
  return { bag, snapshots };
}

export function assertSnapshotsUserOnly(snapshots: readonly ServFormConstraints[]): {
  ok: true;
} | { ok: false; detail: string } {
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i]!;
    for (const key of Object.keys(snap) as ConstraintFieldKey[]) {
      const field = snap[key];
      if (!field) continue;
      if (field.origin !== "user") {
        return {
          ok: false,
          detail: `snapshot[${i}].${key} has origin "${(field as Provenanced<unknown>).origin}" — only "user" may reach SERV as a form constraint`,
        };
      }
    }
  }
  return { ok: true };
}

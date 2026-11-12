/**
 * Single field-level provenance for shopper constraints.
 *
 * Only `origin: "user"` may reach SERV as a hard / form constraint.
 * `note` / `serv` / `suggestion` travel as context or UI suggestions — never as Form edits.
 */

export type ConstraintOrigin = "user" | "note" | "serv" | "suggestion";

export type Provenanced<T> = { value: T; origin: ConstraintOrigin };

/** Type-level: only this shape is accepted by SERV form/hard constraint builders. */
export type UserProvenanced<T> = { value: T; origin: "user" };

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

export function isConstraintOrigin(value: unknown): value is ConstraintOrigin {
  return value === "user" || value === "note" || value === "serv" || value === "suggestion";
}

export function isUserProvenanced<T>(
  field: Provenanced<T> | null | undefined,
): field is UserProvenanced<T> {
  return field != null && field.origin === "user";
}

export function userProvenanced<T>(value: T): UserProvenanced<T> {
  return { value, origin: "user" };
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
      (out as Record<string, UserProvenanced<unknown>>)[key] = acceptUserConstraint(field);
    }
  }
  return out;
}

export function isUserOrigin(field: Provenanced<unknown> | null | undefined): boolean {
  return field?.origin === "user";
}

/**
 * Read a Provenanced cell from wire JSON.
 * Accepts `{ value, origin }` (canonical) or legacy `{ value, dirty: true }` → user.
 * Bare values are never inferred as user.
 */
export function readProvenanced<T>(raw: unknown): Provenanced<T> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as { value?: unknown; origin?: unknown; dirty?: unknown };
  if (isConstraintOrigin(row.origin)) {
    return { value: row.value as T, origin: row.origin };
  }
  if (row.dirty === true) {
    return { value: row.value as T, origin: "user" };
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
    [key]: { value, origin: "user" as const },
  };
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

import { describe, expect, it } from "vitest";
import {
  acceptUserConstraint,
  assertSnapshotsUserOnly,
  isUserProvenanced,
  pickUserFormConstraints,
  reduceConstraintSteps,
  servFormPayload,
  setNonUserField,
  setUserEdit,
  type Provenanced,
  type UserProvenanced,
} from "./constraint-provenance";
import {
  assertNoNonUserSetConstraints,
  buildUserIntent,
  serializeServFormConstraints,
} from "./serv-boundary";

describe("ConstraintOrigin / Provenanced", () => {
  it("acceptUserConstraint is a type-level gate for origin user only", () => {
    const user: UserProvenanced<number> = { value: 12_000, origin: "user" };
    expect(acceptUserConstraint(user)).toEqual(user);
    // @ts-expect-error — note origin must not compile as a SERV form constraint
    const _note: UserProvenanced<number> = { value: 12_000, origin: "note" };
    void _note;
  });

  it("pickUserFormConstraints strips note/serv/suggestion", () => {
    const bag = {
      priceMaxUsd: { value: 15_000, origin: "user" as const },
      radiusMi: { value: 100, origin: "suggestion" as const },
      yearMin: { value: 2018, origin: "serv" as const },
      zip: { value: "43215", origin: "note" as const },
      milesMax: { value: 80_000, origin: "user" as const },
    };
    expect(pickUserFormConstraints(bag)).toEqual({
      priceMaxUsd: { value: 15_000, origin: "user" },
      milesMax: { value: 80_000, origin: "user" },
    });
  });

  it("setNonUserField never clobbers a shopper edit", () => {
    let bag = setUserEdit({}, "radiusMi", 50);
    bag = setNonUserField(bag, "radiusMi", 100, "suggestion");
    expect(bag.radiusMi).toEqual({ value: 50, origin: "user" });
  });
});

describe("edit / no-edit sequences — no non-user value as SERV form constraint", () => {
  it("drives UI/state through note → suggestion → edit → freshNote", () => {
    const { bag, snapshots } = reduceConstraintSteps([
      { op: "note", key: "priceMaxUsd", value: 12_000 },
      { op: "note", key: "zip", value: "43215" },
      { op: "suggestion", key: "radiusMi", value: 100 },
      { op: "serv", key: "yearMin", value: 2016 },
      { op: "serv", key: "yearMax", value: 2022 },
    ]);

    // After note/suggestion/serv fills, Form edits payload must stay empty.
    expect(servFormPayload(bag)).toEqual({});
    expect(assertSnapshotsUserOnly(snapshots).ok).toBe(true);
    for (const snap of snapshots) {
      expect(Object.keys(snap)).toEqual([]);
    }

    const edited = reduceConstraintSteps([
      { op: "note", key: "priceMaxUsd", value: 12_000 },
      { op: "suggestion", key: "radiusMi", value: 100 },
      { op: "serv", key: "yearMin", value: 2016 },
      { op: "user", key: "priceMaxUsd", value: 18_000 },
      { op: "user", key: "radiusMi", value: 50 },
    ]);
    const last = edited.snapshots[edited.snapshots.length - 1]!;
    expect(last).toEqual({
      priceMaxUsd: { value: 18_000, origin: "user" },
      radiusMi: { value: 50, origin: "user" },
    });
    expect(last.yearMin).toBeUndefined();
    expect(assertSnapshotsUserOnly(edited.snapshots).ok).toBe(true);

    // Fresh note clears user edits — suggestion/serv must not resurrect as form.
    const cleared = reduceConstraintSteps([
      { op: "user", key: "priceMaxUsd", value: 18_000 },
      { op: "user", key: "radiusMi", value: 50 },
      { op: "freshNote" },
      { op: "note", key: "priceMaxUsd", value: 8_000 },
      { op: "suggestion", key: "radiusMi", value: 100 },
      { op: "serv", key: "yearMin", value: 2018 },
    ]);
    expect(servFormPayload(cleared.bag)).toEqual({});
    expect(assertSnapshotsUserOnly(cleared.snapshots).ok).toBe(true);

    // buildUserIntent + serializeServFormConstraints honor the same rule.
    const intent = buildUserIntent({
      note: "reliable car under $12,000 near 43215",
      formEdits: {
        priceMaxUsd: { value: 18_000, origin: "user" },
        radiusMi: { value: 100, origin: "suggestion" },
        yearMin: { value: 2016, origin: "serv" },
        zip: { value: "43215", origin: "note" },
      },
    });
    const form = serializeServFormConstraints(intent);
    expect(form).toEqual({
      priceMaxUsd: { value: 18_000, origin: "user", provenance: "user" },
    });
    expect(form.radiusMi).toBeUndefined();
    expect(form.yearMin).toBeUndefined();
    expect(form.zip).toBeUndefined();
    expect(assertNoNonUserSetConstraints(form, intent).ok).toBe(true);

    // Leaking a suggestion as form fails the architecture gate.
    const leaked = {
      ...form,
      radiusMi: { value: 100, origin: "suggestion" as const, provenance: "suggestion" as const },
    };
    expect(assertNoNonUserSetConstraints(leaked, intent).ok).toBe(false);
  });

  it("never infers user from value present alone", () => {
    const intent = buildUserIntent({
      note: "SUV",
      formEdits: {
        // Non-user origins present with values — must not become form.
        yearMin: { value: 2018, origin: "serv" },
        milesMax: { value: 60_000, origin: "note" },
        zip: { value: "60601", origin: "note" },
        radiusMi: { value: 100, origin: "suggestion" },
      },
    });
    expect(serializeServFormConstraints(intent)).toEqual({});
    expect(isUserProvenanced(intent.fields.yearMin as Provenanced<number> | undefined)).toBe(false);
  });
});

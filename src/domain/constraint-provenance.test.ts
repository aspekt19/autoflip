import { describe, expect, it } from "vitest";
import {
  acceptUserConstraint,
  applyFollowUpToConstraintBag,
  assertSnapshotsUserOnly,
  fromShopperInputEvent,
  isUserProvenanced,
  pickUserFormConstraints,
  readProvenanced,
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

describe("ConstraintOrigin / fromShopperInputEvent factory", () => {
  it("fromShopperInputEvent is the only constructor for origin user", () => {
    const user = fromShopperInputEvent({
      kind: "form_edit",
      field: "priceMaxUsd",
      value: 12_000,
    });
    expect(user).toMatchObject({ value: 12_000, origin: "user" });
    expect(acceptUserConstraint(user)).toEqual(user);
    // @ts-expect-error — note origin must not compile as a SERV form constraint
    const _note: UserProvenanced<number> = { value: 12_000, origin: "note" };
    void _note;
    // @ts-expect-error — unbranded { origin: "user" } must not satisfy UserProvenanced
    const _raw: UserProvenanced<number> = { value: 12_000, origin: "user" };
    void _raw;
  });

  it("pickUserFormConstraints strips note/serv/suggestion", () => {
    const bag = {
      priceMaxUsd: fromShopperInputEvent({
        kind: "form_edit",
        field: "priceMaxUsd",
        value: 15_000,
      }),
      radiusMi: { value: 100, origin: "suggestion" as const },
      yearMin: { value: 2018, origin: "serv" as const },
      zip: { value: "43215", origin: "note" as const },
      milesMax: fromShopperInputEvent({
        kind: "form_edit",
        field: "milesMax",
        value: 80_000,
      }),
    };
    expect(pickUserFormConstraints(bag)).toEqual({
      priceMaxUsd: expect.objectContaining({ value: 15_000, origin: "user" }),
      milesMax: expect.objectContaining({ value: 80_000, origin: "user" }),
    });
  });

  it("setNonUserField never clobbers a shopper edit", () => {
    let bag = setUserEdit({}, "radiusMi", 50);
    bag = setNonUserField(bag, "radiusMi", 100, "suggestion");
    expect(bag.radiusMi).toEqual(expect.objectContaining({ value: 50, origin: "user" }));
  });

  it("never infers user from value present alone", () => {
    expect(readProvenanced({ value: 2018 })).toBeUndefined();
    expect(readProvenanced(2018)).toBeUndefined();
    expect(readProvenanced({ value: 2018, dirty: false })).toBeUndefined();
  });
});

describe("follow-up path end-to-end provenance", () => {
  it("bags zip/cash/age/miles via follow_up events and reaches SERV form channel", () => {
    let bag = {};
    bag = applyFollowUpToConstraintBag(bag, "zip", "43215");
    bag = applyFollowUpToConstraintBag(bag, "cash", "15000");
    bag = applyFollowUpToConstraintBag(bag, "age", "2018");
    bag = applyFollowUpToConstraintBag(bag, "miles", "60000");

    const payload = servFormPayload(bag);
    expect(payload).toEqual({
      zip: expect.objectContaining({ value: "43215", origin: "user" }),
      priceMaxUsd: expect.objectContaining({ value: 15_000, origin: "user" }),
      yearMin: expect.objectContaining({ value: 2018, origin: "user" }),
      milesMax: expect.objectContaining({ value: 60_000, origin: "user" }),
    });

    const intent = buildUserIntent({
      note: "reliable car",
      formEdits: payload,
    });
    const form = serializeServFormConstraints(intent);
    expect(form.zip).toEqual(expect.objectContaining({ value: "43215", origin: "user" }));
    expect(form.priceMaxUsd).toEqual(expect.objectContaining({ value: 15_000, origin: "user" }));
    expect(form.yearMin).toEqual(expect.objectContaining({ value: 2018, origin: "user" }));
    expect(form.milesMax).toEqual(expect.objectContaining({ value: 60_000, origin: "user" }));
    expect(assertNoNonUserSetConstraints(form, intent).ok).toBe(true);
  });

  it("age/miles 'any' clear floors with user provenance (null value)", () => {
    let bag = applyFollowUpToConstraintBag({}, "age", "any");
    bag = applyFollowUpToConstraintBag(bag, "miles", "any");
    const payload = servFormPayload(bag);
    expect(payload.yearMin).toEqual(expect.objectContaining({ value: null, origin: "user" }));
    expect(payload.yearMax).toEqual(expect.objectContaining({ value: null, origin: "user" }));
    expect(payload.milesMax).toEqual(expect.objectContaining({ value: null, origin: "user" }));
  });

  it("does not promote plan/resolved years as user without a follow-up event", () => {
    // Simulates yearBandResolved with years from note/SERV — bag stays empty for form.
    const bag = {
      yearMin: { value: 2016, origin: "serv" as const },
      milesMax: { value: 80_000, origin: "note" as const },
    };
    expect(servFormPayload(bag)).toEqual({});
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
      priceMaxUsd: expect.objectContaining({ value: 18_000, origin: "user" }),
      radiusMi: expect.objectContaining({ value: 50, origin: "user" }),
    });
    expect(last.yearMin).toBeUndefined();
    expect(assertSnapshotsUserOnly(edited.snapshots).ok).toBe(true);

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

    const intent = buildUserIntent({
      note: "reliable car under $12,000 near 43215",
      formEdits: {
        priceMaxUsd: fromShopperInputEvent({
          kind: "form_edit",
          field: "priceMaxUsd",
          value: 18_000,
        }),
        radiusMi: { value: 100, origin: "suggestion" },
        yearMin: { value: 2016, origin: "serv" },
        zip: { value: "43215", origin: "note" },
      },
    });
    const form = serializeServFormConstraints(intent);
    expect(form).toEqual({
      priceMaxUsd: expect.objectContaining({
        value: 18_000,
        origin: "user",
        provenance: "user",
      }),
    });
    expect(form.radiusMi).toBeUndefined();
    expect(form.yearMin).toBeUndefined();
    expect(form.zip).toBeUndefined();
    expect(assertNoNonUserSetConstraints(form, intent).ok).toBe(true);

    const leaked = {
      ...form,
      radiusMi: { value: 100, origin: "suggestion" as const, provenance: "suggestion" as const },
    };
    expect(assertNoNonUserSetConstraints(leaked, intent).ok).toBe(false);
  });

  it("never infers user from value present alone in buildUserIntent", () => {
    const intent = buildUserIntent({
      note: "SUV",
      formEdits: {
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

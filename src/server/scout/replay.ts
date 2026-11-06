import fixture from "../../../fixtures/autodev-camry.json";
import {
  REPLAY_CAMRY_PROVENANCE,
  replayInventoryAdapter,
  type InventoryAdapter,
} from "@/domain/scout";

/** Offline real-source inventory — the only checked-in Auto.dev listings JSON. */
export function camryReplayInventory(): InventoryAdapter {
  return replayInventoryAdapter(fixture, REPLAY_CAMRY_PROVENANCE);
}

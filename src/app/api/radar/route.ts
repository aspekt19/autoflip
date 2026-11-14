import { requireVerifiedAccountForRadar } from "@/server/session";
import { RADAR_TEST_DIRECT_SCAN_MESSAGE } from "@/server/radar-test-mode";

export const dynamic = "force-dynamic";

/**
 * Ad-hoc Radar scans are disabled during the controlled one-notification test.
 * The only enabled inventory path is the single saved-watch monitoring cycle.
 */
export async function POST() {
  const access = await requireVerifiedAccountForRadar();
  if (!access.ok) return access.response;
  return Response.json(
    { error: "radar_test_mode_limited", message: RADAR_TEST_DIRECT_SCAN_MESSAGE },
    { status: 423 },
  );
}

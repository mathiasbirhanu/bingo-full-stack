import { z } from "zod";
import { jsonOk, route } from "@/lib/api";
import { claimPrize } from "@/modules/engine/claim";

/**
 * Player BINGO! claim (UC-04, manual rooms autoClaim=false).
 *
 * POST /api/v1/rooms/[roomId]/claim  {} → { claimed, label, eachSantim, ... }
 *
 * The server validates against the CALLED-ball set (client daubs are UI
 * only), pays the first open pattern the caller completed — split across
 * every ticket in the room completing it — and closes the tier. Not-yet
 * claims return ok:true with claimed:false + a friendly "n more for X"
 * hint instead of an error, so a rushed tap is never punished hard.
 */
const schema = z.object({}).passthrough();

export const POST = route(
  async ({ params, user }) => {
    const outcome = await claimPrize(params.roomId, user!.id);
    return jsonOk(outcome);
  },
  { schema }
);

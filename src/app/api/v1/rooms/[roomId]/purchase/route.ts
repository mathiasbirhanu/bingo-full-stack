import { z } from "zod";
import { jsonOk, route } from "@/lib/api";
import { purchaseCards } from "@/modules/rooms";

/**
 * Purchase saga — UC-03. The client generates and persists the idempotency
 * key; a retried purchase with the same key replays the stored original
 * result and never double-debits.
 */
const schema = z.object({
  quantity: z.number().int().min(1).max(6),
  idempotencyKey: z.string().min(8).max(128),
});

export const POST = route(
  async ({ body, params, user }) => {
    const { quantity, idempotencyKey } = body as z.infer<typeof schema>;
    const result = await purchaseCards({
      roomId: params.roomId,
      playerId: user!.id,
      quantity,
      idempotencyKey,
    });
    return jsonOk(result);
  },
  { schema }
);

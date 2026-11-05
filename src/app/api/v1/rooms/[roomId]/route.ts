import { jsonOk, route } from "@/lib/api";
import { roomDetail } from "@/modules/rooms";

/** Room detail — rules, variant, live prize preview, my tickets (FR-PLY-02). */
export const GET = route(
  async ({ session, params }) => {
    return jsonOk(await roomDetail(params.roomId, session?.sub ?? undefined));
  },
  { anon: true }
);

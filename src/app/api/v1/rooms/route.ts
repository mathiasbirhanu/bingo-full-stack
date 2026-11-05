import { jsonOk, route } from "@/lib/api";
import { listRooms } from "@/modules/rooms";

/** Room list — FR-PLY-02: rules and prize tables visible per room. */
export const GET = route(async () => jsonOk(await listRooms()), { anon: true });

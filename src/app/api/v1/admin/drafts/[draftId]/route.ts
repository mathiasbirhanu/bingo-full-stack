import { z } from "zod";
import { jsonOk, route, ROLE } from "@/lib/api";
import { approveDraft, rejectDraft } from "@/modules/config-control";

/** Checker decision — UC-08. Self-approval is structurally rejected inside. */
const schema = z.object({
  action: z.enum(["approve", "reject"]),
  reason: z.string().optional(),
});

export const POST = route(
  async ({ body, params, user }) => {
    const { action, reason } = body as z.infer<typeof schema>;
    if (action === "approve") {
      return jsonOk(await approveDraft(params.draftId, user!.id, user!.role));
    }
    return jsonOk(await rejectDraft(params.draftId, user!.id, user!.role, reason ?? "rejected by checker"));
  },
  { roles: [ROLE.ADMIN, ROLE.SUPERVISOR], schema }
);

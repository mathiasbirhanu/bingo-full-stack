import { z } from "zod";
import { jsonOk, route } from "@/lib/api";
import { requestOtp, verifyOtpAndLogin, rotateRefresh, logout, me } from "@/modules/authn";

/**
 * Auth endpoints — UC-01. One route file, four verbs via `action`:
 *   POST /api/v1/auth  { action: "request-otp" | "login" | "refresh" | "logout" }
 *   GET  /api/v1/auth  → who am I
 */
const bodySchema = z.object({
  action: z.enum(["request-otp", "login", "refresh", "logout"]),
  phone: z.string().optional(),
  code: z.string().optional(),
});

export const POST = route(
  async ({ body }) => {
    const { action, phone, code } = body as z.infer<typeof bodySchema>;
    switch (action) {
      case "request-otp":
        return jsonOk(await requestOtp(phone ?? ""));
      case "login":
        return jsonOk(await verifyOtpAndLogin(phone ?? "", code ?? "", undefined));
      case "refresh": {
        // Refresh token rides the httpOnly cookie; rotate it.
        const { cookies } = await import("next/headers");
        const jar = await cookies();
        const raw = jar.get("bg_rt")?.value;
        return jsonOk(await rotateRefresh(raw ?? ""));
      }
      case "logout":
        await logout();
        return jsonOk({ ok: true });
    }
  },
  { anon: true, schema: bodySchema }
);

export const GET = route(async () => jsonOk({ user: await me() }), { anon: true });

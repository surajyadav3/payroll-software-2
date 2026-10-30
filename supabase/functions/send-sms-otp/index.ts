import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { activeProfileIdsByMobile, normalizeIndianMobile } from "../_shared/indianMobile.ts";

// SMS OTP via MSG91 (pending-list item 1). Login / password recovery only:
// the number must belong to exactly one active CrewCore account.
//   POST { phone: "9876543210" }  ->  { success: true, type: "phone", identifier: "9876543210" }
// The code is generated here and stored in otp_table (user_id = "phone:<10 digits>"),
// so verify-otp keeps doing expiry + attempt limits exactly as for email.
// MSG91 delivers it with an approved DLT OTP template (variable ##OTP##).
//
// Secrets: MSG91_AUTH_KEY, MSG91_OTP_TEMPLATE_ID.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-app-name",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authKey = Deno.env.get("MSG91_AUTH_KEY");
  const templateId = Deno.env.get("MSG91_OTP_TEMPLATE_ID");
  if (!authKey || !templateId) {
    return json({ error: "SMS login isn't available yet. Please use your email or password.", code: "not_configured" }, 503);
  }

  try {
    const { phone } = await req.json().catch(() => ({}));
    const mobile = normalizeIndianMobile(phone);
    if (!mobile) return json({ error: "Enter a valid 10-digit Indian mobile number." }, 400);

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Registered, active accounts only (stops SMS-pumping to random numbers).
    const matches = await activeProfileIdsByMobile(db, mobile);
    if (matches.length === 0) {
      return json({ error: "No active account uses this mobile number. Contact your HR." }, 404);
    }
    if (matches.length > 1) {
      return json({ error: "This number is linked to more than one account. Please sign in with your email or password." }, 409);
    }

    const { data: blocked, error: limErr } = await db.rpc("otp_sms_allow", { p_phone: mobile });
    if (limErr) throw limErr;
    if (blocked) return json({ error: blocked }, 429);

    const otp = String(crypto.getRandomValues(new Uint32Array(1))[0] % 900000 + 100000);
    const key = `phone:${mobile}`;
    await db.from("otp_table").delete().eq("user_id", key);
    const { error: insErr } = await db.from("otp_table").insert([{
      user_id: key, otp, expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    }]);
    if (insErr) throw insErr;

    const url = new URL("https://control.msg91.com/api/v5/otp");
    url.searchParams.set("template_id", templateId);
    url.searchParams.set("mobile", `91${mobile}`);
    url.searchParams.set("otp", otp);
    url.searchParams.set("otp_expiry", "5");
    const res = await fetch(url, { method: "POST", headers: { authkey: authKey, "Content-Type": "application/json" }, body: "{}" });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out?.type === "error") {
      console.error("MSG91 send failed:", res.status, out);
      await db.from("otp_table").delete().eq("user_id", key);
      return json({ error: "Couldn't send the SMS right now. Please try again or use email." }, 502);
    }

    return json({ success: true, type: "phone", identifier: mobile });
  } catch (e) {
    console.error("send-sms-otp:", e);
    return json({ error: "Failed to send OTP. Please try again." }, 500);
  }
});

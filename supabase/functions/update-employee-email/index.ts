import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { findUserByEmail } from "../_shared/findUserByEmail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-app-name",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !caller) {
      return json({ error: "Not authenticated." }, 401);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: callerProfile, error: callerProfileErr } = await adminClient
      .from("profiles")
      .select("role, tenant_id")
      .eq("id", caller.id)
      .single();

    if (callerProfileErr || !callerProfile || !["admin", "manager", "superadmin"].includes(callerProfile.role)) {
      return json({ error: "Not authorized to update employees." }, 403);
    }

    const body = await req.json();
    const { id, email } = body;
    const newEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!id || !newEmail) {
      return json({ error: "Missing 'id' or 'email'." }, 400);
    }
    if (!EMAIL_RE.test(newEmail)) {
      return json({ error: "That doesn't look like a valid email address." }, 400);
    }

    const { data: targetProfile, error: targetErr } = await adminClient
      .from("profiles")
      .select("id, tenant_id")
      .eq("id", id)
      .maybeSingle();

    if (targetErr || !targetProfile) {
      return json({ error: "Employee not found." }, 404);
    }

    if (callerProfile.role !== "superadmin" && targetProfile.tenant_id !== callerProfile.tenant_id) {
      return json({ error: "Not authorized to update this employee." }, 403);
    }

    // Only the email changes here — password/temp_password are intentionally
    // left untouched so the employee's existing (temporary or self-set)
    // password keeps working after the login email is corrected.
    const setEmail = () => adminClient.auth.admin.updateUserById(id, { email: newEmail, email_confirm: true });
    let { error: authError } = await setEmail();

    // The new email is already some other auth account's login (GoTrue only
    // reports a bare "Error updating user" for the unique-key clash).
    if (authError && /error updating user|duplicate key|already|users_email/i.test(authError.message || "")) {
      const existing = await findUserByEmail(adminClient, newEmail);
      if (existing && existing.id !== id) {
        const { data: owner } = await adminClient
          .from("profiles")
          .select("first_name, last_name, essl_employee_code, tenant_id, role")
          .eq("id", existing.id)
          .maybeSingle();
        // A profile with no company is a stray self-signup (app "Create
        // account" with this email) — it belongs to nobody, so free it like a
        // leftover login instead of calling it "another company".
        const strayProfile = owner && !owner.tenant_id && owner.role !== "superadmin";
        if (owner && !strayProfile) {
          const who = owner.tenant_id === targetProfile.tenant_id
            ? `${[owner.first_name, owner.last_name].filter(Boolean).join(" ")}${owner.essl_employee_code ? ` (Emp ${owner.essl_employee_code})` : ""}`
            : "an account in another company";
          return json({ error: `This email is already the login of ${who}. Use a different email.` }, 409);
        }
        // Leftover auth account with no profile (a half-finished add/import)
        // or a company-less stray signup: nobody can use it and it owns no
        // data — free the email and retry.
        const { error: delErr } = await adminClient.auth.admin.deleteUser(existing.id);
        if (delErr) return json({ error: `This email is held by an unused leftover login and could not be freed: ${delErr.message}` }, 400);
        ({ error: authError } = await setEmail());
      }
    }
    if (authError) return json({ error: authError.message }, 400);

    const { error: profileError } = await adminClient
      .from("profiles")
      .update({ email: newEmail })
      .eq("id", id);
    if (profileError) return json({ error: profileError.message }, 400);

    return json({ success: true });
  } catch (err) {
    console.error("update-employee-email error:", err);
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: "Internal server error: " + message }, 500);
  }
});

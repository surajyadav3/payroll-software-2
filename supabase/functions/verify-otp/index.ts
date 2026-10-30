import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { findUserByEmail } from "../_shared/findUserByEmail.ts";
import { activeProfileIdsByMobile } from "../_shared/indianMobile.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-app-name",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { identifier, otp, isSignup, password, firstName, lastName } = await req.json();

    if (!identifier || !otp) {
      return new Response(
        JSON.stringify({ error: "Missing 'identifier' or 'otp'" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // A 10-digit mobile number is an SMS OTP from send-sms-otp (stored under
    // "phone:<digits>"); it can only log in an existing account, never sign up.
    const phoneDigits = /^\d{10}$/.test(String(identifier).trim()) ? String(identifier).trim() : null;
    if (phoneDigits && isSignup) {
      return new Response(
        JSON.stringify({ error: "Sign up with an email address." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const email = phoneDigits ? `phone:${phoneDigits}` : identifier.toLowerCase().trim();

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const db = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Look up the OTP record
    const { data: record, error: fetchErr } = await db
      .from("otp_table")
      .select("*")
      .eq("user_id", email)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchErr) {
      return new Response(
        JSON.stringify({ error: "Database error: " + fetchErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!record) {
      return new Response(
        JSON.stringify({ error: "No code found. Please request a new one." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check expiry
    if (new Date(record.expires_at) < new Date()) {
      await db.from("otp_table").delete().eq("user_id", email);
      return new Response(
        JSON.stringify({ error: "OTP has expired. Please request a new one." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Brute-force guard: cap incorrect attempts per OTP (1,000,000-value space
    // is trivially guessable in a 5-minute window without this).
    const MAX_ATTEMPTS = 5;
    if (record.attempts >= MAX_ATTEMPTS) {
      await db.from("otp_table").delete().eq("user_id", email);
      return new Response(
        JSON.stringify({ error: "Too many incorrect attempts. Please request a new code." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check OTP value
    if (record.otp !== otp.toString().trim()) {
      await db.from("otp_table").update({ attempts: record.attempts + 1 }).eq("id", record.id);
      return new Response(
        JSON.stringify({ error: "Invalid OTP. Please check the code and try again." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // OTP is valid — consume it
    await db.from("otp_table").delete().eq("user_id", email);

    // ── SIGNUP FLOW ──────────────────────────────────────────────────────────
    if (isSignup) {
      if (!password) {
        return new Response(
          JSON.stringify({ error: "Password is required for signup." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Check if user already exists (paginated — a flat perPage:1000 call
      // silently misses users once the platform account count grows past it)
      const existingUser = await findUserByEmail(db, email);

      let userId: string;

      if (existingUser) {
        // Update password for existing user and ensure email is confirmed
        await db.auth.admin.updateUserById(existingUser.id, {
          password,
          email_confirm: true,
          user_metadata: { first_name: firstName, last_name: lastName },
        });
        userId = existingUser.id;
      } else {
        // Create new user with email already confirmed
        const { data: newUser, error: createErr } = await db.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { first_name: firstName, last_name: lastName },
        });

        if (createErr) {
          return new Response(
            JSON.stringify({ error: "Failed to create account: " + createErr.message }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        userId = newUser.user.id;
      }

      return new Response(
        JSON.stringify({ usePasswordLogin: true, user_id: userId }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── LOGIN FLOW ───────────────────────────────────────────────────────────
    // Phone login: the session is for the auth user that owns this number
    // (often a placeholder p<digits>@phone.crewcore.internal address).
    let loginEmail = email;
    if (phoneDigits) {
      const owners = await activeProfileIdsByMobile(db, phoneDigits);
      if (owners.length !== 1) {
        return new Response(
          JSON.stringify({ error: "Couldn't match this number to one account. Please sign in with email or password." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const { data: authUser } = await db.auth.admin.getUserById(owners[0]);
      if (!authUser?.user?.email) {
        return new Response(
          JSON.stringify({ error: "This account can't use SMS login. Please contact your HR." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      loginEmail = authUser.user.email;
    }

    // Generate a magic link so the client can exchange it for a session
    const { data: linkData, error: linkErr } = await db.auth.admin.generateLink({
      type:  "magiclink",
      email: loginEmail,
    });

    if (linkErr || !linkData?.properties?.hashed_token) {
      console.error("generateLink error:", linkErr);
      return new Response(
        JSON.stringify({ error: "Failed to generate login token. " + (linkErr?.message || "") }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ token_hash: linkData.properties.hashed_token }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("verify-otp error:", err);
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: "Internal server error: " + message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

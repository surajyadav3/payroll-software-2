import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Public job application from a company's careers page (pending-list item 7).
// multipart/form-data: slug, job_posting_id, name, email, phone, cover_note,
// resume (PDF/DOC/DOCX ≤ 5 MB), website (honeypot — must be empty).
// Creates a referrals row with source 'Careers Page' (no referrer), stores the
// CV in the private referral-resumes bucket and notifies the company's HR.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-app-name",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MAX_RESUME = 5 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;

/** Detects the real file type from its first bytes (never trust the name/MIME). */
function sniffResume(bytes: Uint8Array): { ext: string; mime: string } | null {
  const b = bytes;
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return { ext: "pdf", mime: "application/pdf" };
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return { ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return { ext: "doc", mime: "application/msword" };
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const form = await req.formData().catch(() => null);
    if (!form) return json({ error: "Invalid form submission." }, 400);
    const field = (k: string, max: number) => String(form.get(k) ?? "").trim().slice(0, max);

    // Honeypot: real people never see or fill this field.
    if (field("website", 200)) return json({ success: true });

    const slug = field("slug", 40).toLowerCase();
    const postingId = field("job_posting_id", 40);
    const name = field("name", 100).replace(/\s+/g, " ");
    const email = field("email", 254).toLowerCase();
    const phoneDigits = field("phone", 20).replace(/\D/g, "");
    const coverNote = field("cover_note", 2000);
    const resume = form.get("resume");

    if (!slug || !/^[0-9a-f-]{36}$/i.test(postingId)) return json({ error: "This job link is invalid." }, 400);
    if (name.length < 2) return json({ error: "Please enter your full name." }, 400);
    if (!EMAIL_RE.test(email)) return json({ error: "Please enter a valid email address." }, 400);
    if (phoneDigits.length < 10 || phoneDigits.length > 13) return json({ error: "Please enter a valid phone number." }, 400);
    if (!(resume instanceof File) || resume.size === 0) return json({ error: "Please attach your resume." }, 400);
    if (resume.size > MAX_RESUME) return json({ error: "Resume must be 5 MB or smaller." }, 400);

    const bytes = new Uint8Array(await resume.arrayBuffer());
    const kind = sniffResume(bytes);
    if (!kind) return json({ error: "Resume must be a PDF or Word (.doc/.docx) file." }, 400);

    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: tenant } = await db.from("tenants").select("id, company_name")
      .eq("careers_slug", slug).eq("careers_enabled", true).maybeSingle();
    if (!tenant) return json({ error: "This careers page is not available." }, 404);
    // Platform-level switch (superadmin Toggle Services → "Careers Page").
    const { data: featureOn } = await db.rpc("ai_feature_enabled", { p_tenant: tenant.id, p_outlet: null, p_key: "careers_page" });
    if (featureOn === false) return json({ error: "This careers page is not available." }, 404);

    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const { data: posting } = await db.from("job_postings")
      .select("id, title, status, closing_date, headcount_request_id")
      .eq("id", postingId).eq("tenant_id", tenant.id).maybeSingle();
    if (!posting || posting.status !== "Open" || (posting.closing_date && posting.closing_date < today)) {
      return json({ error: "This position is no longer accepting applications." }, 410);
    }

    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    const { data: blocked, error: limErr } = await db.rpc("careers_apply_allow", { p_ip: ip, p_email: email, p_posting: posting.id });
    if (limErr) throw limErr;
    if (blocked) return json({ error: blocked }, 429);

    const safeName = name.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 40) || "candidate";
    const path = `${tenant.id}/careers/${crypto.randomUUID()}-${safeName}.${kind.ext}`;
    const { error: upErr } = await db.storage.from("referral-resumes").upload(path, bytes, { contentType: kind.mime, upsert: false });
    if (upErr) throw upErr;

    const { data: referral, error: insErr } = await db.from("referrals").insert([{
      tenant_id: tenant.id,
      job_posting_id: posting.id,
      referred_by: null,
      candidate_name: name,
      candidate_email: email,
      candidate_phone: phoneDigits,
      resume_file_path: path,
      notes: coverNote,
      source: "Careers Page",
      stage: "Applied",
      status: "Submitted",
    }]).select("id").single();
    if (insErr) {
      await db.storage.from("referral-resumes").remove([path]);
      throw insErr;
    }

    // Notify HR (+ the requisition's recruiter, if any).
    const recipients = new Set<string>();
    const { data: hr } = await db.from("profiles").select("id").eq("tenant_id", tenant.id).eq("role", "admin").eq("status", "Active");
    (hr || []).forEach((p: any) => recipients.add(p.id));
    if (posting.headcount_request_id) {
      const { data: hc } = await db.from("headcount_requests").select("assigned_recruiter_id").eq("id", posting.headcount_request_id).maybeSingle();
      if (hc?.assigned_recruiter_id) recipients.add(hc.assigned_recruiter_id);
    }
    if (recipients.size) {
      await db.from("app_notifications").insert([...recipients].map((profile_id) => ({
        tenant_id: tenant.id, profile_id, type: "careers_application",
        title: "New job application", body: `${name} applied for ${posting.title} via the careers page.`,
        link_key: "recruitment", related_id: referral.id,
      })));
    }

    return json({ success: true });
  } catch (e) {
    console.error("careers-apply:", e);
    return json({ error: "Something went wrong submitting your application. Please try again." }, 500);
  }
});

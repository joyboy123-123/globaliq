// supabase/functions/submit-email/index.ts
// Deploy:  supabase functions deploy submit-email --no-verify-jwt
//
// The browser calls THIS, not the database directly. The service-role key lives
// only here on the server, so visitors can't read or dump your customer table.
// Upsert-on-email guarantees no duplicate records.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*", // lock this to your domain in production
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: cors });
  }

  try {
    const { email, marketingConsent } = await req.json();

    // Basic server-side validation (never trust the client).
    const valid = typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!valid) {
      return new Response(JSON.stringify({ error: "invalid_email" }), {
        status: 400,
        headers: { ...cors, "content-type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, // server-only secret
    );

    // Upsert by email: inserts a new customer, or returns the existing one.
    // onConflict 'email' + ignoreDuplicates:false means re-submits just touch the row.
    const { data, error } = await supabase
      .from("customers")
      .upsert(
        {
          email: email.trim(),
          marketing_consent: marketingConsent === true,
          ip_address: req.headers.get("x-forwarded-for") ?? null,
          user_agent: req.headers.get("user-agent") ?? null,
        },
        { onConflict: "email" },
      )
      .select("id, email, payment_status")
      .single();

    if (error) throw error;

    // Return the customer id so the frontend can carry it through checkout.
    return new Response(JSON.stringify({ customer: data }), {
      status: 200,
      headers: { ...cors, "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), {
      status: 500,
      headers: { ...cors, "content-type": "application/json" },
    });
  }
});

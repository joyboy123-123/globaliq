import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { customerId, email, stage } = await req.json();
    if (!customerId && !email) throw new Error("customerId or email required");
    const patch: Record<string, unknown> = {};
    if (stage === "reached_checkout") { patch.reached_checkout = true; patch.reached_checkout_at = new Date().toISOString(); }
    else if (stage === "clicked_pay") { patch.clicked_pay_at = new Date().toISOString(); }
    else throw new Error("unknown stage");
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const q = supabase.from("customers").update(patch);
    const { error } = customerId ? await q.eq("id", customerId) : await q.eq("email", email);
    if (error) throw error;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...cors, "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message ?? e) }), { status: 500, headers: { ...cors, "content-type": "application/json" } });
  }
});

// api/paypal-verify-subscription.js
// Vercel Serverless Function
//
// Called by /results after a PayPal or Venmo approval redirect comes back.
// Confirms the subscription's real status directly with PayPal (never trusts
// the frontend/URL alone) before the results page shows a success state —
// mirrors how api/activate-subscription.js confirms a real Stripe PaymentIntent
// status server-side.
//
// Uses the same environment variables as api/paypal-create-subscription.js:
//   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_MODE
// (PAYPAL_PLAN_ID is not needed here — we're just checking an existing subscription.)

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const MODE = process.env.PAYPAL_MODE;
const BASE_URL = MODE === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

async function getAccessToken() {
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const resp = await fetch(`${BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await resp.json();
  if (!resp.ok) {
    const err = new Error("Failed to authenticate with PayPal.");
    err.paypalResponse = data;
    throw err;
  }
  return data.access_token;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { subscriptionId } = req.body || {};
  if (!subscriptionId || typeof subscriptionId !== "string") {
    return res.status(400).json({ error: "subscriptionId is required." });
  }
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("[paypal-verify-subscription] Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET env var.");
    return res.status(500).json({ error: "Server misconfiguration. Contact support." });
  }
  if (!MODE) {
    console.error("[paypal-verify-subscription] Missing PAYPAL_MODE env var.");
    return res.status(500).json({ error: "Server misconfiguration. Contact support." });
  }

  try {
    const accessToken = await getAccessToken();

    const resp = await fetch(`${BASE_URL}/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await resp.json();
    if (!resp.ok) {
      console.error("[paypal-verify-subscription] PayPal error:", JSON.stringify(data));
      return res.status(400).json({ error: data.message || "Unable to verify subscription." });
    }

    return res.status(200).json({
      active: data.status === "ACTIVE",
      status: data.status,
      subscriptionId: data.id,
    });
  } catch (err) {
    console.error("[paypal-verify-subscription] Error:", err.message, err.paypalResponse ? JSON.stringify(err.paypalResponse) : "");
    return res.status(500).json({ error: "Internal server error." });
  }
};

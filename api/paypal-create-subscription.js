// api/paypal-create-subscription.js
// Vercel Serverless Function
//
// Called when the checkout page's PayPal or Venmo button is clicked. Creates a
// PayPal Subscription against the shared Plan (see scripts/setup-paypal-plan.js)
// that bills $1.00 once (trial) then $29.99/month forever after. Both the
// PayPal button and the Venmo button on the checkout page call this SAME
// endpoint — the only difference between them is which funding source the
// frontend requests from PayPal's JS SDK, nothing server-side.
//
// This is a completely separate system from the existing Stripe integration —
// does not read or touch any Stripe env vars, files, or logic.
//
// Uses the environment variables configured in Vercel:
//   PAYPAL_CLIENT_ID      (public, safe to also return to the frontend)
//   PAYPAL_CLIENT_SECRET  (secret — never sent to the frontend)
//   PAYPAL_PLAN_ID        (P-... from the one-time setup script)
//   PAYPAL_MODE           ("sandbox" or "live")

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PLAN_ID = process.env.PAYPAL_PLAN_ID;
const MODE = process.env.PAYPAL_MODE;
const BASE_URL = MODE === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

// Using www, not the bare domain — see the comment above STRIPE_SUCCESS_URL in
// email/checkout/index.html: the bare globaliqreport.com domain has had SSL
// certificate issues, www is the confirmed-reliable one.
const RETURN_URL = "https://www.globaliqreport.com/results?paypal=success";
const CANCEL_URL = "https://www.globaliqreport.com/email/checkout?paypal=cancelled";

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

  const { email } = req.body || {};
  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "A valid email address is required." });
  }
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("[paypal-create-subscription] Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET env var.");
    return res.status(500).json({ error: "Server misconfiguration. Contact support." });
  }
  if (!PLAN_ID) {
    console.error("[paypal-create-subscription] Missing PAYPAL_PLAN_ID env var.");
    return res.status(500).json({ error: "Server misconfiguration. Contact support." });
  }
  if (!MODE) {
    console.error("[paypal-create-subscription] Missing PAYPAL_MODE env var.");
    return res.status(500).json({ error: "Server misconfiguration. Contact support." });
  }

  try {
    const accessToken = await getAccessToken();

    const subResp = await fetch(`${BASE_URL}/v1/billing/subscriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": `globaliq-sub-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
      body: JSON.stringify({
        plan_id: PLAN_ID,
        subscriber: { email_address: email },
        application_context: {
          brand_name: "GlobalIQ",
          user_action: "SUBSCRIBE_NOW",
          return_url: RETURN_URL,
          cancel_url: CANCEL_URL,
        },
      }),
    });
    const subData = await subResp.json();
    if (!subResp.ok) {
      console.error("[paypal-create-subscription] PayPal error:", JSON.stringify(subData));
      return res.status(500).json({ error: subData.message || "Unable to start PayPal checkout." });
    }

    const approveLink = (subData.links || []).find((l) => l.rel === "approve");
    if (!approveLink) {
      console.error("[paypal-create-subscription] No approve link in PayPal response:", JSON.stringify(subData));
      return res.status(500).json({ error: "Unable to start PayPal checkout." });
    }

    return res.status(200).json({
      approveUrl: approveLink.href,
      subscriptionId: subData.id,
      paypalClientId: CLIENT_ID,
    });
  } catch (err) {
    console.error("[paypal-create-subscription] Error:", err.message, err.paypalResponse ? JSON.stringify(err.paypalResponse) : "");
    return res.status(500).json({ error: "Internal server error." });
  }
};

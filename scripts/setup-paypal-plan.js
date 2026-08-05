// scripts/setup-paypal-plan.js
//
// ONE-TIME SETUP SCRIPT — not part of the deployed website, run this once from
// your own machine to create the PayPal Product + Subscription Plan, then never
// run it again. It prints a PAYPAL_PLAN_ID at the end — save that value, it goes
// into Vercel as the PAYPAL_PLAN_ID environment variable.
//
// This ONE plan is shared by both the PayPal button and the Venmo button on the
// checkout page — both funding sources subscribe to the same plan.
//
// Usage:
//   PAYPAL_CLIENT_ID=xxx PAYPAL_CLIENT_SECRET=yyy node scripts/setup-paypal-plan.js
//
// Reads PAYPAL_MODE too (defaults to "sandbox" if not set) — use "sandbox" for
// this first run. Only switch to "live" after everything is fully tested.

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const MODE = process.env.PAYPAL_MODE || "sandbox";
const BASE_URL = MODE === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("ERROR: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set as environment variables.");
  console.error("Example: PAYPAL_CLIENT_ID=xxx PAYPAL_CLIENT_SECRET=yyy node scripts/setup-paypal-plan.js");
  process.exit(1);
}

async function getAccessToken() {
  // PayPal's OAuth endpoint wants HTTP Basic Auth with client_id:secret, and a
  // client_credentials grant — this token is what authorizes every other call below.
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
    console.error("Failed to get PayPal access token. PayPal's response:");
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }
  return data.access_token;
}

async function createProduct(accessToken) {
  const resp = await fetch(`${BASE_URL}/v1/catalogs/products`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": `globaliq-product-${Date.now()}`, // idempotency key
    },
    body: JSON.stringify({
      name: "GlobalIQ Monthly Membership",
      description: "IQ test results + monthly membership access",
      type: "SERVICE",
      category: "SOFTWARE",
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    console.error("Failed to create PayPal Product. PayPal's response:");
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }
  console.log("Created Product:", data.id);
  return data.id;
}

async function createPlan(accessToken, productId) {
  const resp = await fetch(`${BASE_URL}/v1/billing/plans`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": `globaliq-plan-${Date.now()}`, // idempotency key
    },
    body: JSON.stringify({
      product_id: productId,
      name: "GlobalIQ Trial + Monthly",
      description: "$1 one-time trial, then $29.99/month until cancelled",
      status: "ACTIVE",
      billing_cycles: [
        {
          // Trial cycle: charge $1.00 once. Note: PayPal trial cycles bill on a
          // cycle interval, not a literal day count — "1 week" is the closest
          // built-in unit to a 7-day trial. This is NOT a literal 7-day
          // countdown, it's PayPal's own weekly billing cycle concept.
          frequency: { interval_unit: "WEEK", interval_count: 1 },
          tenure_type: "TRIAL",
          sequence: 1,
          total_cycles: 1,
          pricing_scheme: {
            fixed_price: { value: "1.00", currency_code: "USD" },
          },
        },
        {
          // Regular cycle: $29.99/month, forever (total_cycles: 0 = infinite,
          // runs until the customer or you cancel it).
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 2,
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: { value: "29.99", currency_code: "USD" },
          },
        },
      ],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee: { value: "0", currency_code: "USD" },
        setup_fee_failure_action: "CONTINUE",
        payment_failure_threshold: 3,
      },
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    console.error("Failed to create PayPal Plan. PayPal's response:");
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }
  return data.id;
}

async function main() {
  console.log(`Mode: ${MODE} (${BASE_URL})`);
  console.log("Getting PayPal access token...");
  const accessToken = await getAccessToken();
  console.log("Got access token.");

  console.log("Creating Product...");
  const productId = await createProduct(accessToken);

  console.log("Creating Plan (trial $1 once, then $29.99/month)...");
  const planId = await createPlan(accessToken, productId);

  console.log("\n=== SUCCESS ===");
  console.log(`Product ID: ${productId}`);
  console.log(`PAYPAL_PLAN_ID=${planId}`);
  console.log("\nSave that PAYPAL_PLAN_ID value — it goes into Vercel as an environment variable.");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});

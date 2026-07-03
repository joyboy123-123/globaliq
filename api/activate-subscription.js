// api/activate-subscription.js
// Vercel Serverless Function
//
// Called by the checkout page AFTER the $1.00 PaymentIntent succeeds (the card /
// wallet was charged and the payment method saved). This sets that method as the
// customer's default and creates the $29.99/month subscription with a 7-day trial,
// so the first $29.99 invoice is charged automatically when the trial ends.
//
// Uses the environment variables already configured in Vercel:
//   STRIPE_SECRET_KEY     (sk_live_… / sk_test_…)
//   STRIPE_PRICE_MONTHLY  (price_… for the $29.99/month recurring price)

const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-04-10",
});

const PRICE_ID_MONTHLY = process.env.STRIPE_PRICE_MONTHLY;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { customerId, paymentMethodId } = req.body || {};
  if (!customerId || !paymentMethodId) {
    return res
      .status(400)
      .json({ error: "customerId and paymentMethodId are required." });
  }
  if (!PRICE_ID_MONTHLY) {
    console.error("[activate-subscription] Missing STRIPE_PRICE_MONTHLY env var.");
    return res.status(500).json({ error: "Server misconfiguration. Contact support." });
  }

  try {
    // The payment method is already attached to the customer via the PaymentIntent.
    // Set it as the default so the subscription can charge it after the trial.
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    const trialEndUnix = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // +7 days

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: PRICE_ID_MONTHLY }],
      trial_end: trialEndUnix,
      default_payment_method: paymentMethodId,
      collection_method: "charge_automatically",
      metadata: { plan: "globaliq_monthly" },
    });

    return res.status(200).json({
      success: true,
      subscriptionId: subscription.id,
      trialEnd: new Date(trialEndUnix * 1000).toISOString(),
    });
  } catch (err) {
    console.error("[activate-subscription] Error:", err.message);
    return res.status(500).json({ error: err.message || "Internal server error." });
  }
};

// api/activate-subscription.js
// Vercel Serverless Function
//
// Called by the /results page right after the $1.00 PaymentIntent redirect comes
// back with redirect_status=succeeded. Confirms that PaymentIntent server-side
// (never trusts client-supplied customer/payment-method IDs), then sets the saved
// payment method as the customer's default and creates the $29.99/month
// subscription with a 7-day trial, so the first $29.99 invoice is charged
// automatically when the trial ends.
//
// Uses the environment variables already configured in Vercel:
//   STRIPE_SECRET_KEY          (sk_live_… / sk_test_…)
//   STRIPE_MEMBERSHIP_PRICE_ID (price_… for the $29.99/month recurring price)

const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-04-10",
});

const PRICE_ID_MONTHLY = process.env.STRIPE_MEMBERSHIP_PRICE_ID;
const PLAN_METADATA_VALUE = "globaliq_monthly";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { paymentIntentId } = req.body || {};
  if (!paymentIntentId || typeof paymentIntentId !== "string") {
    return res.status(400).json({ error: "paymentIntentId is required." });
  }
  if (!PRICE_ID_MONTHLY) {
    console.error("[activate-subscription] Missing STRIPE_MEMBERSHIP_PRICE_ID env var.");
    return res.status(500).json({ error: "Server misconfiguration. Contact support." });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== "succeeded") {
      return res.status(400).json({ error: "Payment has not succeeded yet." });
    }

    const customerId = paymentIntent.customer;
    const paymentMethodId = paymentIntent.payment_method;
    if (!customerId || !paymentMethodId) {
      return res.status(400).json({ error: "Payment is missing customer or payment method." });
    }

    // If a membership subscription already exists for this customer (e.g. the
    // results page was reloaded), return it instead of creating a duplicate.
    const existingSubs = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
    });
    const existing = existingSubs.data.find(
      (sub) => sub.metadata && sub.metadata.plan === PLAN_METADATA_VALUE
    );
    if (existing) {
      return res.status(200).json({
        success: true,
        subscriptionId: existing.id,
        trialEnd: existing.trial_end
          ? new Date(existing.trial_end * 1000).toISOString()
          : null,
      });
    }

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
      metadata: { plan: PLAN_METADATA_VALUE },
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

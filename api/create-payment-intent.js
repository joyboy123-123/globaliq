// api/create-payment-intent.js
// Vercel Serverless Function
//
// Called when the checkout page loads. Finds/creates the Stripe Customer for
// the email, then creates a PaymentIntent for the $1 trial-activation price
// (STRIPE_TRIAL_PRICE_ID in the Dashboard) with `setup_future_usage` so the
// same payment method is saved for the upcoming subscription.
//
// `automatic_payment_methods` lets the embedded Payment Element show every
// method you have enabled in the Stripe Dashboard — card (incl. Apple Pay /
// Google Pay wallets), Cash App Pay, Link, etc. Enable the ones you want under
// Dashboard → Settings → Payment methods, and register your domain for Apple Pay.
//
// Uses the environment variables already configured in Vercel:
//   STRIPE_SECRET_KEY      (sk_live_… / sk_test_…)
//   STRIPE_TRIAL_PRICE_ID  (price_… for the $1 one-time trial-activation price)

const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-04-10",
});

const TRIAL_PRICE_ID = process.env.STRIPE_TRIAL_PRICE_ID;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { email } = req.body || {};
  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "A valid email address is required." });
  }
  if (!TRIAL_PRICE_ID) {
    console.error("[create-payment-intent] Missing STRIPE_TRIAL_PRICE_ID env var.");
    return res.status(500).json({ error: "Server misconfiguration. Contact support." });
  }

  try {
    // Pull the live amount/currency from the Dashboard price so the charge
    // always matches whatever is configured there, instead of a hardcoded number.
    const trialPrice = await stripe.prices.retrieve(TRIAL_PRICE_ID);
    if (!trialPrice.active || trialPrice.unit_amount == null) {
      console.error("[create-payment-intent] STRIPE_TRIAL_PRICE_ID is inactive or has no unit_amount.");
      return res.status(500).json({ error: "Server misconfiguration. Contact support." });
    }

    // Find or create the customer so returning users reuse the same record.
    const existing = await stripe.customers.list({ email, limit: 1 });
    const customer = existing.data.length
      ? existing.data[0]
      : await stripe.customers.create({ email });

    // Charge now; the payment method is saved for the subscription.
    const paymentIntent = await stripe.paymentIntents.create({
      amount: trialPrice.unit_amount,
      currency: trialPrice.currency,
      customer: customer.id,
      setup_future_usage: "off_session",
      automatic_payment_methods: { enabled: true },
      description: "GlobalIQ – trial activation (7-day trial)",
      metadata: { type: "trial_activation", price_id: TRIAL_PRICE_ID },
    });

    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      customerId: customer.id,
    });
  } catch (err) {
    console.error("[create-payment-intent] Stripe error:", err.message);
    return res.status(500).json({ error: err.message || "Internal server error." });
  }
};

const Stripe = require("stripe");

module.exports = async (req, res) => {
  // CORS para permitir llamadas desde tu GitHub Pages
  res.setHeader("Access-Control-Allow-Origin", process.env.SITE_URL);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Preflight
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido" });

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { items } = body || {};

    const line_items = (items || []).map((i) => ({
      price_data: {
        currency: "eur",
        product_data: { name: i.name || "Pedido" },
        unit_amount: Number(i.amount_cents || 0),
      },
      quantity: Number(i.qty || 1),
    }));

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      ui_mode: "embedded",
      line_items,
      return_url: `${process.env.SITE_URL}/pago-ok.html?session_id={CHECKOUT_SESSION_ID}`,
    });

    return res.status(200).json({
      clientSecret: session.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
};

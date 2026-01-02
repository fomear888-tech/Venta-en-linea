import Stripe from "stripe";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

    const { customer, items, total_eur } = req.body || {};
    if (!customer?.name || !customer?.phone) return res.status(400).json({ error: "Missing customer data" });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Empty items" });

    const total = Number(total_eur);
    if (!Number.isFinite(total) || total <= 0) return res.status(400).json({ error: "Invalid total" });

    const totalCents = Math.round(total * 100);

    // 1) Guardar pedido pendiente en Supabase
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const insertRes = await fetch(`${supabaseUrl}/rest/v1/pending_orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
        "Prefer": "return=representation"
      },
      body: JSON.stringify([{
        customer_name: customer.name,
        customer_phone: customer.phone,
        items: items.map(i => ({ product_id: i.product_id, qty: i.qty })), // compacto
        total_cents: totalCents,
        status: "pending"
      }])
    });

    if (!insertRes.ok) {
      const txt = await insertRes.text();
      console.error("Supabase insert pending_orders failed:", txt);
      return res.status(500).json({ error: "Supabase insert failed" });
    }

    const [pending] = await insertRes.json();
    const pendingOrderId = pending.id;

    // 2) Crear sesión de Stripe y guardar el pending_order_id en metadata
    const session = await stripe.checkout.sessions.create({
      ui_mode: "embedded",
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "eur",
          product_data: { name: "Pedido Mas Envíos" },
          unit_amount: totalCents
        },
        quantity: 1
      }],
      return_url: `${process.env.FRONTEND_BASE_URL}/pago-ok.html`,
      metadata: {
        pending_order_id: pendingOrderId
      }
    });

    // 3) Guardar stripe_session_id en la fila pending_orders (opcional pero útil)
    await fetch(`${supabaseUrl}/rest/v1/pending_orders?id=eq.${pendingOrderId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`
      },
      body: JSON.stringify({ stripe_session_id: session.id })
    });

    return res.status(200).json({
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      clientSecret: session.client_secret
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}


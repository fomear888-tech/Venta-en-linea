import Stripe from "stripe";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    if (!process.env.STRIPE_SECRET_KEY) {
  return res.status(500).json({ error: "Missing STRIPE_SECRET_KEY env var" });
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

    const { customer, items } = req.body || {};

    if (!customer?.name || !customer?.phone) {
      return res.status(400).json({ error: "Missing customer data" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Empty items" });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({ error: "Missing Supabase env vars" });
    }

    const siteUrl = (process.env.SITE_URL || "").replace(/\/$/, "");
if (!siteUrl) {
  return res.status(500).json({ error: "Missing SITE_URL env var" });
}

    const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
    if (!publishableKey) {
      return res.status(500).json({ error: "Missing STRIPE_PUBLISHABLE_KEY env var" });
    }

    // ✅ 1) VALIDAR STOCK REAL EN SERVIDOR + recalcular total desde BD
    const ids = [...new Set(items.map(i => String(i.product_id)))];

    if (ids.length === 0) {
  return res.status(400).json({ error: "Empty items" });
}
    
    const inList = ids.map(id => `"${id}"`).join(",");

    const stockRes = await fetch(
      `${supabaseUrl}/rest/v1/products?select=id,name,stock,price&id=in.(${inList})`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
        },
      }
    );

    if (!stockRes.ok) {
      const txt = await stockRes.text();
      console.error("Stock check failed:", txt);
      return res.status(500).json({ error: "Stock check failed" });
    }

    const products = await stockRes.json();
    const byId = new Map(products.map(p => [String(p.id), p]));

    const problems = [];
    let computedTotalCents = 0;

    for (const it of items) {
      const pid = String(it.product_id);
      const p = byId.get(pid);

      if (!p) {
        problems.push({ product_id: pid, reason: "not_found" });
        continue;
      }

      const want = Number(it.qty) || 0;
      const have = Number(p.stock) || 0;

      if (want <= 0) {
        problems.push({ product_id: pid, reason: "invalid_qty" });
        continue;
      }

      if (have < want) {
        problems.push({
          product_id: pid,
          name: p.name,
          available: have,
          requested: want,
          reason: "insufficient_stock",
        });
        continue;
      }

      const price = Number(p.price) || 0;
      computedTotalCents += Math.round(price * 100) * want;
    }

    if (problems.length) {
      return res.status(409).json({ error: "Stock insuficiente", problems });
    }

    if (computedTotalCents <= 0) {
      return res.status(400).json({ error: "Invalid total" });
    }

    const totalCents = computedTotalCents;

    // ✅ 2) Guardar pedido pendiente en Supabase
    const insertRes = await fetch(`${supabaseUrl}/rest/v1/pending_orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify([
        {
          customer_name: customer.name,
          customer_phone: customer.phone,
          items: items.map(i => ({ product_id: i.product_id, qty: i.qty })),
          total_cents: totalCents,
          status: "pending",
        },
      ]),
    });

    if (!insertRes.ok) {
      const txt = await insertRes.text();
      console.error("Supabase insert pending_orders failed:", txt);
      return res.status(500).json({ error: "Supabase insert failed" });
    }

    const [pending] = await insertRes.json();
    const pendingOrderId = pending.id;

// ✅ 3) Crear sesión de Stripe
const session = await stripe.checkout.sessions.create({
  ui_mode: "embedded",
  mode: "payment",

  // 🔑 ESTO ES LO IMPORTANTE
  customer_creation: "always",


  

  line_items: [
    {
      price_data: {
        currency: "eur",
        product_data: { name: "Pedido Mas Envíos" },
        unit_amount: totalCents,
      },
      quantity: 1,
    },
  ],
  return_url: `${siteUrl}/pago-ok.html`,
  metadata: { pending_order_id: pendingOrderId },
});

    // ✅ 4) Guardar stripe_session_id (opcional pero recomendado)
    await fetch(`${supabaseUrl}/rest/v1/pending_orders?id=eq.${pendingOrderId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ stripe_session_id: session.id }),
    });

    // ✅ 5) Respuesta final
    return res.status(200).json({
      publishableKey,
      clientSecret: session.client_secret,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}

import Stripe from "stripe";

export const config = {
  api: {
    bodyParser: false, // ⚠️ obligatorio para verificar Stripe
  },
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  // 🔒 Validar variables de entorno críticas
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).send("Missing STRIPE_SECRET_KEY");
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send("Missing STRIPE_WEBHOOK_SECRET");
  }
  if (!process.env.SUPABASE_URL) {
    return res.status(500).send("Missing SUPABASE_URL");
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).send("Missing SUPABASE_SERVICE_ROLE_KEY");
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: "2024-06-20",
  });

  const sig = req.headers["stripe-signature"];

if (!sig) {
  return res.status(400).send("Missing stripe-signature header");
}
  
  let event;
  
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      if (session.payment_status === "paid") {
        const pendingOrderId = session.metadata?.pending_order_id;
        if (!pendingOrderId) {
          throw new Error("No pending_order_id in metadata");
        }

        const supabaseUrl = process.env.SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        // 1️⃣ Obtener el pedido pendiente
        const pendingRes = await fetch(
          `${supabaseUrl}/rest/v1/pending_orders?id=eq.${pendingOrderId}`,
          {
            headers: {
              apikey: serviceKey,
              Authorization: `Bearer ${serviceKey}`,
            },
          }
        );

        if (!pendingRes.ok) {
  const txt = await pendingRes.text();
  throw new Error("Pending fetch failed: " + txt);
}
const [pending] = await pendingRes.json();
        if (!pending) throw new Error("Pending order not found");

        // 2️⃣ Crear pedido REAL y descontar stock (RPC)
        const rpcRes = await fetch(
          `${supabaseUrl}/rest/v1/rpc/create_order_and_discount_stock`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: serviceKey,
              Authorization: `Bearer ${serviceKey}`,
            },
            body: JSON.stringify({
              p_customer_name: pending.customer_name,
              p_customer_phone: pending.customer_phone,
              p_items: pending.items,
            }),
          }
        );

        if (!rpcRes.ok) {
          const txt = await rpcRes.text();
          throw new Error("RPC failed: " + txt);
        }

        // 3️⃣ Marcar pending_order como pagado
        await fetch(
          `${supabaseUrl}/rest/v1/pending_orders?id=eq.${pendingOrderId}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              apikey: serviceKey,
              Authorization: `Bearer ${serviceKey}`,
            },
            body: JSON.stringify({
              status: "paid",
              paid_at: new Date().toISOString(),
            }),
          }
        );
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.status(500).send("Webhook failed");
  }
}

import Stripe from "stripe";


import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendTicketEmail({ to, name, ticketNumber, ticketUrl, total }) {
  const subject = `Tu ticket ${ticketNumber}`;
  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; line-height:1.4; color:#111">
    <h2>Gracias por tu compra${name ? `, ${name}` : ""} 😊</h2>
    <p>Tu ticket <b>${ticketNumber}</b> está listo.</p>
    <p>Total: <b>${Number(total || 0).toFixed(2)} €</b> (IVA incluido)</p>
    <p>
      <a href="${ticketUrl}" style="display:inline-block;padding:10px 14px;border:1px solid #ddd;border-radius:10px;text-decoration:none">
        Ver / imprimir ticket
      </a>
    </p>
    <p style="color:#555;font-size:12px">
      Si necesitas factura con NIF, responde a este correo solicitándola.
    </p>
  </div>`;

  await resend.emails.send({
    from: process.env.FROM_EMAIL || "Tickets <onboarding@resend.dev>",
    to,
    subject,
    html,
  });
}



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




async function getBestEmailFromSession(stripe, session) {
  // 1) lo que venga directo
  const direct = session?.customer_details?.email;
  if (direct) return direct;

  // 2) volver a pedir la sesión completa a Stripe
  try {
    const full = await stripe.checkout.sessions.retrieve(session.id);
    const e2 = full?.customer_details?.email;
    if (e2) return e2;
  } catch (e) {
    console.error("Could not retrieve full session:", e?.message || e);
  }

  // 3) si tampoco, null
  return null;
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

  if (!process.env.RESEND_API_KEY) {
  console.error("Missing RESEND_API_KEY");
}
if (!process.env.PUBLIC_BASE_URL) {
  console.error("Missing PUBLIC_BASE_URL");
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



// 2️⃣.1 Enviar ticket por EMAIL
const email = await getBestEmailFromSession(stripe, session);
const name = session.customer_details?.name || pending.customer_name;
const ticketUrl = `${process.env.PUBLIC_BASE_URL}/api/ticket?session_id=${session.id}`;

if (email) {
  try {
    console.log("Intentando enviar email a:", email);

    await sendTicketEmail({
      to: email,
      name,
      ticketNumber: "TICKET_GENERADO_POR_TU_RPC",
      ticketUrl,
      total: session.amount_total / 100,
    });
  } catch (e) {
    console.error("Email failed:", e);
  }
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

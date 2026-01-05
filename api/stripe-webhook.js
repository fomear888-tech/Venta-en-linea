import Stripe from "stripe";
import { Resend } from "resend";

export const config = { api: { bodyParser: false } };

const resend = new Resend(process.env.RESEND_API_KEY);

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

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

  return resend.emails.send({
    from: process.env.FROM_EMAIL || "Tickets <onboarding@resend.dev>",
    to,
    subject,
    html,
  });
}

async function getBestEmailFromSession(stripe, session) {
  const e1 = session?.customer_details?.email;
  if (e1) return e1;

  const e2 = session?.customer_email;
  if (e2) return e2;

  const cusId = session?.customer;
  if (cusId) {
    const cus = await stripe.customers.retrieve(cusId);
    if (cus?.email) return cus.email;
  }
  return null;
}

export default async function handler(req, res) {
  console.log("WEBHOOK VERSION: 2026-01-05 v3");

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).send("Missing STRIPE_SECRET_KEY");
  if (!process.env.STRIPE_WEBHOOK_SECRET) return res.status(500).send("Missing STRIPE_WEBHOOK_SECRET");
  if (!process.env.SUPABASE_URL) return res.status(500).send("Missing SUPABASE_URL");
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(500).send("Missing SUPABASE_SERVICE_ROLE_KEY");

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

  const sig = req.headers["stripe-signature"];
  if (!sig) return res.status(400).send("Missing stripe-signature header");

  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      if (session.payment_status === "paid") {
        const pendingOrderId = session.metadata?.pending_order_id;
        if (!pendingOrderId) throw new Error("No pending_order_id in metadata");

        const supabaseUrl = process.env.SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        const pendingRes = await fetch(
          `${supabaseUrl}/rest/v1/pending_orders?id=eq.${pendingOrderId}`,
          { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
        );
        if (!pendingRes.ok) throw new Error("Pending fetch failed: " + (await pendingRes.text()));
        const [pending] = await pendingRes.json();
        if (!pending) throw new Error("Pending order not found");

        const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/create_order_and_discount_stock`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
          body: JSON.stringify({
            p_customer_name: pending.customer_name,
            p_customer_phone: pending.customer_phone,
            p_items: pending.items,
          }),
        });
        if (!rpcRes.ok) throw new Error("RPC failed: " + (await rpcRes.text()));

        // EMAIL
        const email = await getBestEmailFromSession(stripe, session);
        console.log("Email detectado:", email);

        const name = session.customer_details?.name || pending.customer_name;
        const baseUrl = (process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`).replace(/\/$/, "");
        const ticketUrl = `${baseUrl}/api/ticket?session_id=${session.id}`;

        if (!process.env.RESEND_API_KEY) {
          console.error("Missing RESEND_API_KEY - skipping email");
        } else if (email) {
          const result = await sendTicketEmail({
            to: email,
            name,
            ticketNumber: "TICKET_GENERADO_POR_TU_RPC",
            ticketUrl,
            total: session.amount_total / 100,
          });
          console.log("RESEND RESULT:", result);
        }

        // marcar pending como pagado
        await fetch(`${supabaseUrl}/rest/v1/pending_orders?id=eq.${pendingOrderId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
          body: JSON.stringify({ status: "paid", paid_at: new Date().toISOString() }),
        });
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.status(500).send("Webhook failed");
  }
}

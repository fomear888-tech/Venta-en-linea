// api/place-order.js
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { customer_name, customer_phone, items } = req.body || {};

    if (!customer_name || !customer_phone) {
      return res.status(400).json({ error: "Missing customer data" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Empty items" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return res.status(500).json({ error: "Missing Supabase env vars" });
    }

    // ⚠️ Service role: puede saltarse RLS
    const sbAdmin = createClient(SUPABASE_URL, SERVICE_KEY);

    // 1) Traer productos para validar stock y precios reales (no confiar en el front)
    const ids = items.map(i => i.product_id);
    const { data: products, error: pErr } = await sbAdmin
      .from("products")
      .select("id,name,price,stock")
      .in("id", ids);

    if (pErr) return res.status(500).json({ error: pErr.message });

    const byId = new Map((products || []).map(p => [p.id, p]));

    // 2) Validar stock + calcular total
    const orderItems = [];
    let total = 0;

    for (const it of items) {
      const p = byId.get(it.product_id);
      const qty = Number(it.qty || 0);

      if (!p) return res.status(400).json({ error: `Product not found: ${it.product_id}` });
      if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: "Invalid qty" });
      if ((p.stock ?? 0) < qty) return res.status(409).json({ error: `No stock for ${p.name}` });

      const price = Number(p.price) || 0;
      const line_total = price * qty;

      orderItems.push({
        product_id: p.id,
        name: p.name,
        price,
        qty,
        line_total,
      });

      total += line_total;
    }

    // 3) Crear order
    const orderId = crypto.randomUUID();
    const ticketNumber = "T-" + String(Date.now()).slice(-6); // simple (si ya tienes otro sistema, lo ajustamos)

    const { error: oErr } = await sbAdmin.from("orders").insert([{
      id: orderId,
      ticket_number: ticketNumber,
      customer_name,
      customer_phone,
      total,
      estado: "pendiente",
      // metodo_pago: null, // si quieres setearlo luego
    }]);

    if (oErr) return res.status(500).json({ error: oErr.message });

    // 4) Crear order_items
    const rows = orderItems.map(oi => ({
      id: crypto.randomUUID(),
      order_id: orderId,
      ...oi,
    }));

    const { error: oiErr } = await sbAdmin.from("order_items").insert(rows);
    if (oiErr) return res.status(500).json({ error: oiErr.message });

    // 5) Descontar stock (simple, no transaccional)
    // Para tu caso (tienda pequeña) funciona bien. Si luego quieres “a prueba de guerras”, hacemos RPC SQL atómico.
    for (const it of orderItems) {
      const p = byId.get(it.product_id);
      const newStock = (Number(p.stock) || 0) - it.qty;

      const { error: sErr } = await sbAdmin
        .from("products")
        .update({ stock: newStock })
        .eq("id", it.product_id);

      if (sErr) return res.status(500).json({ error: sErr.message });
    }

    return res.status(200).json({
      ok: true,
      order_id: orderId,
      ticket_number: ticketNumber,
      total,
    });

  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}

// /api/place-order.js
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const sb = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
});

function pad(n, len = 5) {
  return String(n).padStart(len, "0");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { customer, items } = req.body || {};
    const name = (customer?.name || "").trim();
    const phone = (customer?.phone || "").trim();

    if (!name || !phone) return res.status(400).json({ error: "Missing customer data" });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Empty items" });

    // 1) Traer productos para calcular total y validar stock
    const productIds = items.map(i => String(i.product_id));
    const { data: products, error: prodErr } = await sb
      .from("products")
      .select("id,name,price,stock")
      .in("id", productIds);

    if (prodErr) return res.status(500).json({ error: "Loading products failed", details: prodErr.message });

    const byId = new Map((products || []).map(p => [String(p.id), p]));

    // validar y armar order_items
    const orderItems = [];
    let total = 0;

    for (const it of items) {
      const pid = String(it.product_id);
      const qty = Number(it.qty || 0);

      if (!pid || !Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ error: "Invalid item", item: it });
      }

      const p = byId.get(pid);
      if (!p) return res.status(400).json({ error: `Product not found: ${pid}` });

      const stock = Number(p.stock || 0);
      if (stock < qty) return res.status(400).json({ error: `No stock for ${p.name}`, product_id: pid, stock, qty });

      const price = Number(p.price || 0);
      const lineTotal = price * qty;
      total += lineTotal;

      orderItems.push({
        product_id: pid,
        name: p.name,
        price,
        qty,
        line_total: lineTotal,
      });
    }

    // 2) Generar ticket_number tipo T-00026 (como tu tabla)
    //    (lo sacamos leyendo el último ticket y sumando 1)
    let nextN = 1;
    const { data: last, error: lastErr } = await sb
      .from("orders")
      .select("ticket_number, created_at")
      .order("created_at", { ascending: false })
      .limit(1);

    if (!lastErr && last?.[0]?.ticket_number) {
      const m = String(last[0].ticket_number).match(/(\d+)/);
      if (m) nextN = Number(m[1]) + 1;
    }

    const ticketNumber = `T-${pad(nextN)}`;

    // 3) Insert en orders
    // Campos según tu tabla: ticket_number, customer_name, customer_phone, total, estado, metodo_pago...
    const { data: orderRow, error: orderErr } = await sb
      .from("orders")
      .insert([{
        ticket_number: ticketNumber,
        customer_name: name,
        customer_phone: phone,
        total: Number(total.toFixed(2)),
        estado: "pendiente",
        // metodo_pago: null (o pon "bizum"/"tarjeta" si lo usas en tu enum)
      }])
      .select("id,ticket_number,total,created_at")
      .single();

    if (orderErr) {
      return res.status(500).json({ error: "Insert orders failed", details: orderErr.message });
    }

    const orderId = orderRow.id;

    // 4) Insert en order_items (con order_id)
    const itemsToInsert = orderItems.map(oi => ({
      order_id: orderId,
      ...oi,
    }));

    const { error: itemsErr } = await sb.from("order_items").insert(itemsToInsert);
    if (itemsErr) {
      // rollback simple: borrar order si falla items
      await sb.from("orders").delete().eq("id", orderId);
      return res.status(500).json({ error: "Insert order_items failed", details: itemsErr.message });
    }

    // 5) Descontar stock en products (simple, producto por producto)
    // Nota: esto no es transacción atómica; para 100% robustez se hace con SQL function.
    for (const oi of orderItems) {
      const p = byId.get(String(oi.product_id));
      const newStock = Number(p.stock) - Number(oi.qty);

      const { error: updErr } = await sb
        .from("products")
        .update({ stock: newStock })
        .eq("id", oi.product_id);

      if (updErr) {
        // rollback best-effort
        await sb.from("order_items").delete().eq("order_id", orderId);
        await sb.from("orders").delete().eq("id", orderId);
        return res.status(500).json({ error: "Stock update failed", details: updErr.message });
      }
    }

    return res.status(200).json({
      ok: true,
      order: {
        id: orderId,
        ticket_number: orderRow.ticket_number,
        total: orderRow.total,
        created_at: orderRow.created_at,
      }
    });

  } catch (e) {
    console.error("PLACE ORDER FATAL:", e);
    return res.status(500).json({ error: "Server error", details: String(e?.message || e) });
  }
}

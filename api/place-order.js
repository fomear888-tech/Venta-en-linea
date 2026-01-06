// /api/place-order.js
const { createClient } = require("@supabase/supabase-js");

function pad(n, len = 5) {
  return String(n).padStart(len, "0");
}

module.exports = async function handler(req, res) {
  // Health check en navegador
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, msg: "place-order alive" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({
        ok: false,
        error: "Missing env vars",
        details: {
          hasUrl: !!supabaseUrl,
          hasServiceKey: !!serviceKey,
        },
      });
    }

    const sb = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    const { customer, items } = req.body || {};
    const name = String(customer?.name || "").trim();
    const phone = String(customer?.phone || "").trim();

    if (!name || !phone) {
      return res.status(400).json({ ok: false, error: "Missing customer data" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "Empty items" });
    }

    // 1) cargar productos
    const productIds = items.map((i) => String(i.product_id));
    const { data: products, error: prodErr } = await sb
      .from("products")
      .select("id,name,price,stock")
      .in("id", productIds);

    if (prodErr) {
      return res.status(500).json({ ok: false, error: "Loading products failed", details: prodErr.message });
    }

    const byId = new Map((products || []).map((p) => [String(p.id), p]));

    // 2) validar items + total
    const orderItems = [];
    let total = 0;

    for (const it of items) {
      const pid = String(it.product_id);
      const qty = Number(it.qty || 0);

      if (!pid || !Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ ok: false, error: "Invalid item", item: it });
      }

      const p = byId.get(pid);
      if (!p) return res.status(400).json({ ok: false, error: `Product not found: ${pid}` });

      const stock = Number(p.stock || 0);
      if (stock < qty) {
        return res.status(400).json({
          ok: false,
          error: `No stock for ${p.name}`,
          details: { product_id: pid, stock, qty },
        });
      }

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

    // 3) ticket_number tipo T-00026
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

    // 4) insert order
    const { data: orderRow, error: orderErr } = await sb
      .from("orders")
      .insert([{
        ticket_number: ticketNumber,
        customer_name: name,
        customer_phone: phone,
        total: Number(total.toFixed(2)),
        estado: "pendiente",
        // metodo_pago: null
      }])
      .select("id,ticket_number,total,created_at")
      .single();

    if (orderErr) {
      return res.status(500).json({ ok: false, error: "Insert orders failed", details: orderErr.message });
    }

    const orderId = orderRow.id;

    // 5) insert items
    const itemsToInsert = orderItems.map((oi) => ({ order_id: orderId, ...oi }));
    const { error: itemsErr } = await sb.from("order_items").insert(itemsToInsert);

    if (itemsErr) {
      await sb.from("orders").delete().eq("id", orderId);
      return res.status(500).json({ ok: false, error: "Insert order_items failed", details: itemsErr.message });
    }

    // 6) update stock
    for (const oi of orderItems) {
      const p = byId.get(String(oi.product_id));
      const newStock = Number(p.stock) - Number(oi.qty);

      const { error: updErr } = await sb.from("products").update({ stock: newStock }).eq("id", oi.product_id);
      if (updErr) {
        await sb.from("order_items").delete().eq("order_id", orderId);
        await sb.from("orders").delete().eq("id", orderId);
        return res.status(500).json({ ok: false, error: "Stock update failed", details: updErr.message });
      }
    }

    return res.status(200).json({
      ok: true,
      order: {
        id: orderId,
        ticket_number: orderRow.ticket_number,
        total: orderRow.total,
        created_at: orderRow.created_at,
      },
    });
  } catch (e) {
    console.error("PLACE ORDER FATAL:", e);
    return res.status(500).json({ ok: false, error: "Server error", details: String(e?.message || e) });
  }
};

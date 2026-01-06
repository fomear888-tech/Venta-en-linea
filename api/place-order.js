// /api/place-order.js
import { createClient } from "@supabase/supabase-js";

function pad(n, width = 5) {
  const s = String(n);
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

function toISODate(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function toISOTime(d) {
  return d.toTimeString().slice(0, 8); // HH:MM:SS
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({
        ok: false,
        error: "Missing env vars",
        details: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing in Vercel",
      });
    }

    // Service role -> no RLS
    const sbAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false },
    });

    const body = req.body || {};
    const customer = body.customer || {};
    const items = Array.isArray(body.items) ? body.items : [];

    const name = String(customer.name || "").trim();
    const phone = String(customer.phone || "").trim();

    if (!name || !phone) {
      return res.status(400).json({ ok: false, error: "Missing customer data" });
    }
    if (items.length === 0) {
      return res.status(400).json({ ok: false, error: "Empty items" });
    }

    // Normaliza items: [{product_id, qty}]
    const normalized = items
      .map((it) => ({
        product_id: String(it.product_id || "").trim(),
        qty: Number(it.qty || 0),
      }))
      .filter((it) => it.product_id && Number.isFinite(it.qty) && it.qty > 0);

    if (normalized.length === 0) {
      return res.status(400).json({ ok: false, error: "Invalid items" });
    }

    // Trae productos
    const ids = [...new Set(normalized.map((x) => x.product_id))];

    const { data: products, error: prodErr } = await sbAdmin
      .from("products")
      .select("id,name,price,stock")
      .in("id", ids);

    if (prodErr) {
      return res.status(500).json({ ok: false, error: "Products fetch failed", details: prodErr.message });
    }

    const byId = new Map((products || []).map((p) => [String(p.id), p]));

    // Verifica stock + calcula total
    let total = 0;
    for (const it of normalized) {
      const p = byId.get(it.product_id);
      if (!p) {
        return res.status(400).json({ ok: false, error: `Product not found: ${it.product_id}` });
      }
      const stock = Number(p.stock || 0);
      if (it.qty > stock) {
        return res.status(400).json({
          ok: false,
          error: "Not enough stock",
          details: `${p.name} stock=${stock} requested=${it.qty}`,
        });
      }
      const price = Number(p.price || 0);
      total += price * it.qty;
    }

    // Ticket number: lee el último y suma 1 (simple)
    const { data: last, error: lastErr } = await sbAdmin
      .from("orders")
      .select("ticket_number, created_at")
      .order("created_at", { ascending: false })
      .limit(1);

    if (lastErr) {
      return res.status(500).json({ ok: false, error: "Ticket lookup failed", details: lastErr.message });
    }

    let nextNum = 1;
    const lastTicket = last?.[0]?.ticket_number || "";
    const m = String(lastTicket).match(/(\d+)/);
    if (m) nextNum = Number(m[1]) + 1;

    const ticket_number = `T-${pad(nextNum, 5)}`;

    const now = new Date();
    const order_date = toISODate(now);
    const order_time = toISOTime(now);
    const order_month = `${order_date.slice(0, 7)}-01`; // primer día del mes

    // 1) Inserta order
    const { data: orderRow, error: orderErr } = await sbAdmin
      .from("orders")
      .insert([
        {
          ticket_number,
          customer_name: name,
          customer_phone: phone,
          total: Number(total.toFixed(2)),
          order_date,
          order_time,
          order_month,
          estado: "pendiente",
          // metodo_pago: null, // si tu enum lo permite, lo dejas sin enviar o null
        },
      ])
      .select("*")
      .single();

    if (orderErr) {
      return res.status(500).json({ ok: false, error: "Orders insert failed", details: orderErr.message });
    }

    // 2) Inserta order_items
    const order_id = orderRow.id;

    const itemsToInsert = normalized.map((it) => {
      const p = byId.get(it.product_id);
      const price = Number(p.price || 0);
      const line_total = Number((price * it.qty).toFixed(2));
      return {
        order_id,
        product_id: it.product_id,
        name: p.name,
        price: Number(price.toFixed(2)),
        qty: it.qty,
        line_total,
      };
    });

    const { error: itemsErr } = await sbAdmin.from("order_items").insert(itemsToInsert);

    if (itemsErr) {
      // Nota: aquí ya existe el order. Si quieres “borrarlo” al fallar items, lo hacemos.
      await sbAdmin.from("orders").delete().eq("id", order_id);
      return res.status(500).json({ ok: false, error: "Order items insert failed", details: itemsErr.message });
    }

    // 3) Descuenta stock
    for (const it of normalized) {
      const p = byId.get(it.product_id);
      const newStock = Number(p.stock || 0) - it.qty;

      const { error: stockErr } = await sbAdmin
        .from("products")
        .update({ stock: newStock })
        .eq("id", it.product_id);

      if (stockErr) {
        // No matamos el pedido por esto, pero lo reportamos
        console.error("STOCK UPDATE ERROR:", it.product_id, stockErr.message);
      }
    }

    return res.status(200).json({
      ok: true,
      order: orderRow,
    });
  } catch (e) {
    console.error("PLACE ORDER SERVER ERROR:", e);
    return res.status(500).json({ ok: false, error: "Server error", details: e?.message || String(e) });
  }
}

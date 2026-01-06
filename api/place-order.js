// /api/place-order.js
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

function padTicket(n) {
  return String(n).padStart(5, "0");
}

function toDateParts(d = new Date()) {
  // Ojo: esto usa hora del servidor. Para España suele estar ok en Vercel,
  // si quieres 100% Europe/Madrid habría que ajustar con librería/offset.
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  const MI = String(d.getMinutes()).padStart(2, "0");
  const SS = String(d.getSeconds()).padStart(2, "0");

  return {
    order_date: `${yyyy}-${mm}-${dd}`,     // date
    order_time: `${HH}:${MI}:${SS}`,      // time
    order_month: `${yyyy}-${mm}-01`,      // date (primer día del mes)
  };
}

async function getNextTicketNumber() {
  // Busca el último ticket y suma 1: T-00026 => 27
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("ticket_number, created_at")
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw new Error(`No pude leer último ticket: ${error.message}`);

  const last = data?.[0]?.ticket_number || "T-00000";
  const m = String(last).match(/(\d+)$/);
  const lastNum = m ? parseInt(m[1], 10) : 0;
  const nextNum = lastNum + 1;

  return `T-${padTicket(nextNum)}`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    // 1) Validar env vars
    if (!process.env.SUPABASE_URL) {
      return res.status(500).json({ ok: false, error: "Missing SUPABASE_URL" });
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });
    }

    // 2) Leer body
    const { customer, items } = req.body || {};
    const name = (customer?.name || "").trim();
    const phone = (customer?.phone || "").trim();

    if (!name || !phone) {
      return res.status(400).json({ ok: false, error: "Missing customer name/phone" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "Empty items" });
    }

    // Normalizar items
    const cleanItems = items
      .map((it) => ({
        product_id: String(it?.product_id || "").trim(),
        qty: Number(it?.qty || 0),
      }))
      .filter((it) => it.product_id && Number.isFinite(it.qty) && it.qty > 0);

    if (cleanItems.length === 0) {
      return res.status(400).json({ ok: false, error: "No valid items" });
    }

    // 3) Traer productos desde DB para calcular total real
    const productIds = [...new Set(cleanItems.map((x) => x.product_id))];

    const { data: products, error: prodErr } = await supabaseAdmin
      .from("products")
      .select("id, name, price, stock")
      .in("id", productIds);

    if (prodErr) {
      return res.status(500).json({ ok: false, error: "DB error reading products", details: prodErr.message });
    }

    const byId = new Map((products || []).map((p) => [String(p.id), p]));
    for (const it of cleanItems) {
      if (!byId.has(it.product_id)) {
        return res.status(400).json({ ok: false, error: `Producto no existe: ${it.product_id}` });
      }
    }

    // 4) Validar stock y calcular totales
    let total = 0;
    const orderItemsRows = cleanItems.map((it) => {
      const p = byId.get(it.product_id);
      const price = Number(p.price) || 0;
      const stock = Number(p.stock) || 0;

      if (it.qty > stock) {
        throw new Error(`Stock insuficiente para ${p.name} (pid=${it.product_id}). Pedido=${it.qty}, Stock=${stock}`);
      }

      const line_total = +(price * it.qty).toFixed(2);
      total += line_total;

      return {
        product_id: it.product_id,
        name: p.name,
        price: price,
        qty: it.qty,
        line_total,
      };
    });

    total = +total.toFixed(2);

    // 5) Crear order
    const ticket_number = await getNextTicketNumber();
    const parts = toDateParts(new Date());

    const { data: orderInserted, error: orderErr } = await supabaseAdmin
      .from("orders")
      .insert({
        ticket_number,
        customer_name: name,
        customer_phone: phone,
        total,
        estado: "pendiente",     // coincide con tu enum (por tu captura)
        metodo_pago: null,       // si luego lo usas, aquí lo pones
        order_date: parts.order_date,
        order_time: parts.order_time,
        order_month: parts.order_month,
      })
      .select("*")
      .single();

    if (orderErr) {
      return res.status(500).json({ ok: false, error: "DB error inserting order", details: orderErr.message });
    }

    // 6) Insertar order_items
    const rows = orderItemsRows.map((r) => ({
      order_id: orderInserted.id,
      ...r,
    }));

    const { error: itemsErr } = await supabaseAdmin
      .from("order_items")
      .insert(rows);

    if (itemsErr) {
      // Intento de rollback “suave”: borra la order si falla items
      await supabaseAdmin.from("orders").delete().eq("id", orderInserted.id);
      return res.status(500).json({ ok: false, error: "DB error inserting order_items", details: itemsErr.message });
    }

    // 7) (Opcional) Descontar stock
    // Si no quieres descontar aún, borra este bloque.
    for (const it of cleanItems) {
      const p = byId.get(it.product_id);
      const newStock = Math.max(0, (Number(p.stock) || 0) - it.qty);

      const { error: stErr } = await supabaseAdmin
        .from("products")
        .update({ stock: newStock })
        .eq("id", it.product_id);

      if (stErr) {
        // No rompo el pedido si stock update falla, pero lo reporto
        console.warn("Stock update failed:", it.product_id, stErr.message);
      }
    }

    return res.status(200).json({
      ok: true,
      order: {
        id: orderInserted.id,
        ticket_number: orderInserted.ticket_number,
        total: orderInserted.total,
        estado: orderInserted.estado,
      },
    });
  } catch (e) {
    console.error("PLACE-ORDER FATAL:", e);
    return res.status(500).json({ ok: false, error: "Server error", details: e?.message || String(e) });
  }
}


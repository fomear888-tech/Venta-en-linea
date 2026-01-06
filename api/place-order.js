// /api/place-order.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({
        ok: false,
        error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
      });
    }

    const { customer, items } = req.body || {};
    const name = (customer?.name || "").trim();
    const phone = (customer?.phone || "").trim();

    if (!name || !phone) {
      return res.status(400).json({ ok: false, error: "Missing customer data" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: "Empty items" });
    }

    // Normalizar items
    const normItems = items
      .map((it) => ({
        product_id: String(it.product_id || "").trim(),
        qty: Number(it.qty) || 0,
      }))
      .filter((it) => it.product_id && it.qty > 0);

    if (normItems.length === 0) {
      return res.status(400).json({ ok: false, error: "Invalid items" });
    }

    // 1) Leer productos desde Supabase para validar stock + precio real
    const ids = [...new Set(normItems.map((i) => i.product_id))];
    const inList = ids.map((id) => `"${id}"`).join(",");

    const productsRes = await fetch(
      `${supabaseUrl}/rest/v1/products?select=id,name,price,stock&id=in.(${inList})`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
        },
      }
    );

    if (!productsRes.ok) {
      const raw = await productsRes.text();
      return res.status(500).json({ ok: false, error: "Products fetch failed", details: raw });
    }

    const products = await productsRes.json();
    const byId = new Map(products.map((p) => [String(p.id), p]));

    // 2) Validar stock y calcular total
    const problems = [];
    let total = 0;

    const enriched = normItems.map((it) => {
      const p = byId.get(it.product_id);
      if (!p) {
        problems.push({ product_id: it.product_id, reason: "not_found" });
        return null;
      }
      const have = Number(p.stock) || 0;
      if (have < it.qty) {
        problems.push({
          product_id: it.product_id,
          name: p.name,
          available: have,
          requested: it.qty,
          reason: "insufficient_stock",
        });
        return null;
      }
      const price = Number(p.price) || 0;
      const line_total = price * it.qty;
      total += line_total;

      return {
        product_id: it.product_id,
        qty: it.qty,
        name: p.name,
        price,
        line_total,
        new_stock: have - it.qty,
      };
    }).filter(Boolean);

    if (problems.length) {
      return res.status(409).json({ ok: false, error: "Stock insuficiente", problems });
    }

    if (!(total > 0)) {
      return res.status(400).json({ ok: false, error: "Invalid total" });
    }

    // 3) Crear ticket_number
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const ticket_number = `T-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
      now.getHours()
    )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    // 4) Insert en orders (tu tabla)
    const ordersInsertRes = await fetch(`${supabaseUrl}/rest/v1/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify([
        {
          ticket_number,
          customer_name: name,
          customer_phone: phone,
          total,
          // si en tu tabla estos campos pueden ir NULL, puedes dejarlos fuera
          estado: "pendiente", // según tu enum/valor actual
          // metodo_pago: null,
        },
      ]),
    });

    if (!ordersInsertRes.ok) {
      const raw = await ordersInsertRes.text();
      return res.status(500).json({ ok: false, error: "Insert orders failed", details: raw });
    }

    const [order] = await ordersInsertRes.json();
    const orderId = order?.id;
    if (!orderId) {
      return res.status(500).json({ ok: false, error: "Order insert returned no id" });
    }

    // 5) Insert en order_items (tu tabla)
    const orderItemsPayload = enriched.map((x) => ({
      order_id: orderId,
      product_id: x.product_id,
      name: x.name,
      price: x.price,
      qty: x.qty,
      line_total: x.line_total,
    }));

    const itemsInsertRes = await fetch(`${supabaseUrl}/rest/v1/order_items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(orderItemsPayload),
    });

    if (!itemsInsertRes.ok) {
      const raw = await itemsInsertRes.text();
      return res.status(500).json({ ok: false, error: "Insert order_items failed", details: raw });
    }

    // 6) Descontar stock (simple, sin SQL extra)
    for (const x of enriched) {
      const upd = await fetch(`${supabaseUrl}/rest/v1/products?id=eq.${encodeURIComponent(x.product_id)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ stock: x.new_stock }),
      });

      if (!upd.ok) {
        const raw = await upd.text();
        // OJO: aquí ya creamos pedido; devolvemos error informando (para que lo veas)
        return res.status(500).json({
          ok: false,
          error: "Stock update failed (order created)",
          details: raw,
          order: { id: orderId, ticket_number, total },
        });
      }
    }

    return res.status(200).json({
      ok: true,
      order: {
        id: orderId,
        ticket_number,
        total,
      },
    });
  } catch (err) {
    console.error("PLACE ORDER FATAL:", err);
    return res.status(500).json({ ok: false, error: "Server error", details: String(err?.message || err) });
  }
}

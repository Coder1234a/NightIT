import { useEffect, useState } from "react";
import { api, rupees, humanWait } from "../lib/api";
import { loadRazorpayScript } from "../lib/loadRazorpay";
import { tone, askToNotify } from "../lib/notify";

// The student's ordering screen: pick a block, build a cart, see what the whole
// cart will take including everyone already queued, then pay by UPI or cash.
export default function Order({ hostelType, regNo, setRegNo, onOrdered }) {
  const [blocks, setBlocks] = useState([]);
  const [blockId, setBlockId] = useState(null);
  const [menu, setMenu] = useState([]);
  const [cart, setCart] = useState({});          // menu_item_id -> qty
  const [takeaway, setTakeaway] = useState(false);
  const [taxPct, setTaxPct] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.blocks()
      .then(all => {
        const mine = all.filter(b => b.hostel_type === hostelType);
        setBlocks(mine);
        setBlockId(mine[0]?.id ?? null);
      })
      .catch(() => setError("Cannot reach the server. It may be waking up — try again in 30 seconds."));
    api.paymentConfig().then(c => setTaxPct(c.tax_percent ?? 5)).catch(() => {});
  }, [hostelType]);

  useEffect(() => {
    if (!blockId) return;
    let alive = true;
    const load = () => api.menu(blockId).then(m => { if (alive) setMenu(m); }).catch(() => {});
    load();
    const t = setInterval(load, 8000);          // stock and the queue move while you read
    return () => { alive = false; clearInterval(t); };
  }, [blockId]);

  const lines = Object.entries(cart)
    .map(([id, qty]) => ({ item: menu.find(m => m.id === Number(id)), qty }))
    .filter(l => l.item);
  const subtotal = lines.reduce((s, l) => s + l.item.price_paise * l.qty, 0);
  const tax = Math.round(subtotal * taxPct / 100);
  // The kitchen cooks a cart together, so the wait is its slowest item, not the
  // sum of them. Then add the people already queued at this counter.
  const cook = lines.reduce((s, l) => Math.max(s, l.item.prep_minutes * 60), 0);
  const ahead = menu[0] ? Number(menu[0].queue_ahead) : 0;
  const service = menu[0] ? Number(menu[0].avg_service_seconds) : 90;
  const cartWait = cook + ahead * service;

  function bump(item, delta) {
    if (!item.available && delta > 0) return;
    tone("tap");
    setCart(c => {
      const next = { ...c };
      const q = (next[item.id] || 0) + delta;
      if (q <= 0) delete next[item.id]; else next[item.id] = Math.min(q, item.remaining);
      return next;
    });
  }

  // Creates the cart first, then takes payment, then confirms. In that order,
  // so a failed payment can never leave a code with no order behind it.
  async function checkout(mode) {
    if (!lines.length) return;
    setBusy(true); setError(null);
    try {
      await askToNotify();
      const order = await api.createOrder({
        reg_no: regNo.trim() || "GUEST",
        items: lines.map(l => ({ menu_item_id: l.item.id, qty: l.qty })),
        mode, takeaway,
      });

      if (mode === "cash") {
        onOrdered(order.order_id, "cash");
        return;
      }

      const cfg = await api.paymentConfig();
      const loaded = cfg.configured ? await loadRazorpayScript() : false;
      if (!loaded) {
        // No key configured or the script is blocked. Confirm directly rather
        // than stranding a paid-for cart, and say plainly what happened.
        const done = await api.confirmOrder(order.order_id);
        onOrdered(order.order_id, "upi", done.code);
        return;
      }

      const rzp = new window.Razorpay({
        key: cfg.key_id,
        amount: order.total_paise,
        currency: "INR",
        name: "NightIT",
        description: lines.map(l => `${l.item.name} x${l.qty}`).join(", "),
        prefill: { name: regNo },
        theme: { color: "#ff4f87" },
        handler: async () => {
          try {
            const done = await api.confirmOrder(order.order_id);
            onOrdered(order.order_id, "upi", done.code);
          }
          catch { setError("Payment went through but confirming failed. Show this at the counter."); }
        },
        modal: {
          ondismiss: () => {
            api.cancelOrder(order.order_id).catch(() => {});
            setBusy(false);
            setError("Payment cancelled. Your items went back on the shelf.");
          },
        },
      });
      rzp.open();
      return;                                    // busy stays on until the modal closes
    } catch (e) {
      setError(e.message === "sold_out" ? "Something in your cart just sold out."
             : e.message === "closed_for_tonight" ? "That counter has closed for tonight."
             : "Could not place the order. Try again.");
      tone("bad");
    } finally {
      if (mode === "cash") setBusy(false);
    }
  }

  return (
    <>
      <p className="section-label">Your block</p>
      <div className="select-wrap">
        <select className="select-block" value={blockId ?? ""}
                onChange={e => { setBlockId(Number(e.target.value)); setCart({}); }}>
          {blocks.map(b => <option key={b.id} value={b.id}>{b.name} · {b.hostel_type}</option>)}
        </select>
      </div>

      <p className="section-label">Registration number</p>
      <input className="field" value={regNo} onChange={e => setRegNo(e.target.value.toUpperCase())}
             placeholder="Your registration number" autoComplete="off" spellCheck="false" />

      <div className="mode-toggle">
        <button className={`mode-btn ${!takeaway ? "active" : ""}`}
                onClick={() => setTakeaway(false)}>Eat in</button>
        <button className={`mode-btn ${takeaway ? "active" : ""}`}
                onClick={() => setTakeaway(true)}>Take away</button>
      </div>

      {error && <p className="note bad">{error}</p>}

      <p className="section-label">Tonight&rsquo;s menu</p>
      <ul className="menu-list">
        {menu.map(i => (
          <li key={i.id}>
            <div className={`menu-item ${i.image_url ? "has-thumb" : ""}`} style={{ cursor: "default" }}>
              {i.image_url && (
                <img className="thumb" src={i.image_url} alt="" loading="lazy"
                     onError={e => { e.currentTarget.style.visibility = "hidden"; }} />
              )}
              <div className="item-copy">
                <div className="item-name">
                  {i.name}
                  <span className="item-price">
                    {rupees(i.price_paise)}<span className="excl">+tax</span>
                  </span>
                </div>
                <div className={`item-meta ${i.available ? "" : "closed"}`}>
                  {i.available
                    ? `${humanWait(Number(i.eta_seconds))} · ${i.remaining} left`
                    : i.state.replace(/_/g, " ")}
                </div>
              </div>
              <div className="qty">
                <button onClick={() => bump(i, -1)} disabled={!cart[i.id]}>&minus;</button>
                <span>{cart[i.id] || 0}</span>
                <button onClick={() => bump(i, +1)} disabled={!i.available}>+</button>
              </div>
            </div>
          </li>
        ))}
        {!menu.length && <li className="empty">Loading the menu&hellip;</li>}
      </ul>

      {lines.length > 0 && (
        <div className="cart-bar">
          <div className="cart-copy">
            <div className="cart-total">{rupees(subtotal + tax)}</div>
            <div className="cart-wait">
              incl. {rupees(tax)} tax · ready in about {humanWait(cartWait)}
              {ahead > 0 && ` · ${ahead} ahead`}
            </div>
          </div>
          <button className="btn-primary" disabled={busy} onClick={() => checkout("upi")}>
            {busy ? "..." : "Pay UPI"}
          </button>
          <button className="btn-secondary" disabled={busy} onClick={() => checkout("cash")}>
            Cash
          </button>
        </div>
      )}
    </>
  );
}

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { api, rupees, humanWait } from "../lib/api";
import { tone, notify } from "../lib/notify";

// What the student watches while they wait: their queue number, how many are
// ahead, how long that is, and a loud change when the food is ready.
export default function Ticket({ orderId, code, onBack }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const canvas = useRef(null);
  const warned = useRef({ soon: false, ready: false });

  useEffect(() => {
    if (code && canvas.current) {
      QRCode.toCanvas(canvas.current, code, { width: 170, margin: 1 }).catch(() => {});
    }
  }, [code]);

  // One poll carries everything: status, queue position, wait, ready flag.
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const s = await api.orderStatus(orderId);
        if (!alive) return;
        setStatus(s); setError(null);

        if (s.ready && !warned.current.ready) {
          warned.current.ready = true;
          tone("ready");
          notify("Your food is ready", `Token ${code || s.queue_no} — collect it now.`);
        } else if (s.almost_your_turn && !s.ready && !warned.current.soon) {
          warned.current.soon = true;
          tone("turn");
          notify("Almost your turn", `${s.ahead} ahead of you at ${s.block}. Head down.`);
        }
      } catch {
        if (alive) setError("Lost the connection. Retrying.");
      }
    }
    tick();
    const t = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [orderId, code]);

  const ready = status?.ready;
  const soon = status?.almost_your_turn && !ready;

  return (
    <div className="token-screen">
      <h1>{ready ? "Ready" : "Waiting"}</h1>
      <p className="token-sub">
        {status?.block ? `${status.block} night counter` : "Loading your order"}
        {status?.takeaway ? " · take away" : ""}
      </p>

      {code && (
        <div className="qr-card"><canvas ref={canvas} /></div>
      )}
      {code && <div className="token-code">{code}</div>}
      {!code && (
        <p className="note">
          Cash order. Pay at the counter, then collect on your queue number below —
          the staff hand it over against that number, so there is no code to lose.
        </p>
      )}

      {error && <p className="note bad" style={{ marginTop: 12 }}>{error}</p>}

      {status && (
        <div className={`queue-card ${ready ? "is-ready" : soon ? "is-soon" : ""}`}>
          <div className="queue-no">{status.queue_no ?? "--"}</div>
          <p className="queue-label">your token number</p>

          {ready ? (
            <p className="ready-shout">Collect it now</p>
          ) : (
            <>
              <div className="queue-line">
                <span>You are</span>
                <b>{status.position === 1 ? "next" : `${status.position} in line`}</b>
              </div>
              <div className="queue-line">
                <span>People ahead of you</span><b>{status.ahead}</b>
              </div>
              <div className="queue-line">
                <span>Whole cart ready in</span><b>{humanWait(status.eta_seconds)}</b>
              </div>
              {soon && <p className="note" style={{ marginTop: 12 }}>
                You are next. Start walking down.
              </p>}
            </>
          )}

          {status.items?.length > 0 && (
            <ul className="cart-lines" style={{ marginTop: 14 }}>
              {status.items.map((i, n) => (
                <li key={n}>
                  <span>{i.name}{i.qty > 1 ? ` x${i.qty}` : ""}</span>
                  <span>{rupees(i.price_paise * i.qty)}</span>
                </li>
              ))}
              <li><span>Subtotal</span><span>{rupees(status.amount_paise)}</span></li>
              <li><span>Tax</span><span>{rupees(status.tax_paise || 0)}</span></li>
              <li style={{ fontWeight: 700 }}>
                <span>Paid</span>
                <span>{rupees(status.total_paise ?? status.amount_paise)}</span>
              </li>
            </ul>
          )}

          {status.served && <p className="note" style={{ marginTop: 10 }}>Collected. Enjoy.</p>}
        </div>
      )}

      <button className="btn-secondary" style={{ marginTop: 22 }} onClick={onBack}>
        Order something else
      </button>
    </div>
  );
}

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";

const LAST_ORDER = "nightit.order";

// The strip that follows a student around the app so an order is never more
// than one tap away. It trusts this phone's memory first, then falls back to
// asking the server by registration number — which is what makes an order
// findable after a cleared cache or on a different handset.
export default function LiveOrder({ regNo }) {
  const [live, setLive] = useState([]);
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState("");
  const [missed, setMissed] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    let stop = false;
    async function look() {
      let found = [];
      const reg = (regNo || "").trim();
      if (reg) {
        found = await api.activeOrders(reg).catch(() => []);
      } else {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(LAST_ORDER) || "null"); } catch { /* ignore */ }
        if (saved?.id) {
          const s = await api.orderStatus(saved.id).catch(() => null);
          if (s && (s.status === "paid" || s.status === "ready")) {
            found = [{ order_id: s.order_id, block: s.block, queue_no: s.queue_no,
                       position: s.position, ready: s.ready }];
          }
        }
      }
      if (!stop) setLive(found);
    }
    look();
    const t = setInterval(look, 12000);
    return () => { stop = true; clearInterval(t); };
  }, [regNo]);

  async function find() {
    const rows = await api.activeOrders(typed.trim()).catch(() => []);
    setLive(rows); setMissed(rows.length === 0);
    if (rows.length) setAsking(false);
  }

  if (!live.length) {
    return (
      <div className="live-find">
        {asking ? (
          <>
            <input className="field" value={typed} autoFocus
                   placeholder="Registration number you ordered with"
                   onChange={e => setTyped(e.target.value)}
                   onKeyDown={e => e.key === "Enter" && find()} />
            <button className="btn-secondary" onClick={find}>Find</button>
            {missed && <p className="note">No live order under that number tonight.</p>}
          </>
        ) : (
          <button className="link-quiet" onClick={() => setAsking(true)}>
            Already ordered? Find my order &rarr;
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="live-stack">
      {live.map(o => (
        <button key={o.order_id} className={`live-strip ${o.ready ? "hot" : ""}`}
                onClick={() => nav(`/order/${o.order_id}`)}>
          <span className="ls-dot" />
          <span className="ls-copy">
            <b>{o.ready ? "Your food is ready" : `You are ${o.position} in line`}</b>
            <span>{o.block} · token {o.queue_no}</span>
          </span>
          <span className="ls-go">Open &rarr;</span>
        </button>
      ))}
    </div>
  );
}

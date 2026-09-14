import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { api, rupees } from "../lib/api";
import { tone } from "../lib/notify";

// The mess counter's screen: the live queue, a button to mark food ready, a
// camera scanner, and a typed-code fallback for when the camera will not focus.
export default function Counter() {
  const [blocks, setBlocks] = useState([]);
  const [counterId, setCounterId] = useState(null);
  const [queue, setQueue] = useState([]);
  const [manual, setManual] = useState("");
  const [result, setResult] = useState(null);       // { served, text, sub }
  const [scanning, setScanning] = useState(false);
  const scanner = useRef(null);

  useEffect(() => {
    api.blocks().then(bs => { setBlocks(bs); setCounterId(bs[0]?.counter_id ?? null); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!counterId) return;
    let alive = true;
    const load = () => api.counterQueue(counterId).then(q => { if (alive) setQueue(q); }).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [counterId]);

  useEffect(() => () => { scanner.current?.stop().catch(() => {}); }, []);

  function flash(served, text, sub) {
    setResult({ served, text, sub });
    tone(served ? "ready" : "bad");
    setTimeout(() => setResult(null), 2600);
  }

  async function redeem(code) {
    try {
      const r = await api.redeem(counterId, String(code).trim());
      flash(true, "SERVED", `#${r.order.queue_no} · ${r.order.items}${r.order.parcel ? " · PARCEL" : ""}`);
    } catch {
      flash(false, "ALREADY USED", "invalid, expired, or collected");
    }
    setManual("");
    api.counterQueue(counterId).then(setQueue).catch(() => {});
  }

  // Hands a cart over at the counter. Used for cash, where the student has no
  // code. Still a one-way change, so it cannot be handed over twice.
  async function serve(id) {
    try {
      await api.serveOrder(id);
      flash(true, "SERVED", "handed over at the counter");
    } catch { flash(false, "ALREADY DONE", "this cart was already collected"); }
    api.counterQueue(counterId).then(setQueue).catch(() => {});
  }

  async function ready(id) {
    try { await api.markReady(id); tone("ready"); }
    catch { tone("bad"); }
    api.counterQueue(counterId).then(setQueue).catch(() => {});
  }

  // A cash cart is confirmed here; that is what issues its pickup code.
  async function confirmCash(id) {
    try { await api.confirmOrder(id); tone("tap"); }
    catch { tone("bad"); }
    api.counterQueue(counterId).then(setQueue).catch(() => {});
  }

  async function toggleCamera() {
    if (scanning) {
      await scanner.current?.stop().catch(() => {});
      setScanning(false);
      return;
    }
    try {
      scanner.current = new Html5Qrcode("reader");
      await scanner.current.start({ facingMode: "environment" },
        { fps: 10, qrbox: 230 },
        text => { redeem(text); scanner.current.stop().catch(() => {}); setScanning(false); },
        () => {});
      setScanning(true);
    } catch {
      flash(false, "NO CAMERA", "type the code instead");
    }
  }

  return (
    <div className="scanner-screen">
      <h1>Counter</h1>

      <div className="select-wrap">
        <select className="select-block" value={counterId ?? ""}
                onChange={e => setCounterId(Number(e.target.value))}>
          {blocks.map(b => (
            <option key={b.counter_id} value={b.counter_id}>{b.name} — counter {b.counter_id}</option>
          ))}
        </select>
      </div>

      <p className="section-label">Waiting now · {queue.length}</p>
      {queue.map(o => (
        <div key={o.id} className={`q-row ${o.status === "ready" ? "ready" : ""}`}>
          <div className="q-no">{o.queue_no ?? "—"}</div>
          <div className="q-copy">
            <div className="q-items">{o.items || "—"}</div>
            <div className="q-meta">
              {o.reg_no} · {rupees(o.amount_paise)} · {o.mode}
              {o.parcel ? " · parcel" : ""} · {o.status}
            </div>
          </div>
          {o.status === "pending" && o.mode === "cash" &&
            <button className="btn-mini" onClick={() => confirmCash(o.id)}>Cash paid</button>}
          {o.status === "paid" &&
            <button className="btn-mini go" onClick={() => ready(o.id)}>Ready</button>}
          {(o.status === "ready" || (o.status === "paid" && o.mode === "cash")) &&
            <button className="btn-mini" onClick={() => serve(o.id)}>Serve</button>}
        </div>
      ))}
      {!queue.length && <p className="empty">Nobody waiting.</p>}

      <button className="btn-camera" style={{ marginTop: 20 }} onClick={toggleCamera}>
        {scanning ? "Stop the camera" : "Scan a QR code"}
      </button>
      <div id="reader" style={{ minHeight: scanning ? 240 : 0 }} />

      <p className="manual-label">or type the six digits</p>
      <div className="manual-row">
        <input className="manual-input" value={manual} maxLength={6} inputMode="numeric"
               onChange={e => setManual(e.target.value.replace(/\D/g, ""))}
               onKeyDown={e => e.key === "Enter" && manual.length === 6 && redeem(manual)} />
        <button className="btn-redeem" disabled={manual.length !== 6} onClick={() => redeem(manual)}>
          Check
        </button>
      </div>

      {result && (
        <div className={`result-overlay ${result.served ? "served" : "rejected"}`}>
          <div className="result-text">{result.text}</div>
          <div className="result-item">{result.sub}</div>
        </div>
      )}
    </div>
  );
}

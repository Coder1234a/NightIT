import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { tone } from "../lib/notify";

// Feedback and bug reporting, open to men's and ladies' hostel users alike.
export default function Say({ regNo }) {
  const [blocks, setBlocks] = useState([]);
  const [blockId, setBlockId] = useState("");
  const [kind, setKind] = useState("feedback");
  const [rating, setRating] = useState(0);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.blocks().then(bs => { setBlocks(bs); setBlockId(String(bs[0]?.id ?? "")); }).catch(() => {});
  }, []);

  async function send() {
    if (!message.trim()) return;
    try {
      await api.sendFeedback({
        reg_no: regNo?.trim() || null,
        block_id: blockId ? Number(blockId) : null,
        kind,
        rating: kind === "feedback" && rating ? rating : null,
        message: message.trim(),
      });
      tone("ready");
      setSent(true); setMessage(""); setRating(0); setError(null);
      setTimeout(() => setSent(false), 4000);
    } catch {
      setError("Could not send that. Try again.");
      tone("bad");
    }
  }

  return (
    <>
      <div className="mode-toggle">
        <button className={`mode-btn ${kind === "feedback" ? "active" : ""}`}
                onClick={() => setKind("feedback")}>Feedback</button>
        <button className={`mode-btn ${kind === "bug" ? "active" : ""}`}
                onClick={() => setKind("bug")}>Report a bug</button>
      </div>

      <p className="section-label">Your block</p>
      <div className="select-wrap">
        <select className="select-block" value={blockId} onChange={e => setBlockId(e.target.value)}>
          {blocks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>

      {kind === "feedback" && (
        <>
          <p className="section-label">How was tonight?</p>
          <div className="stars">
            {[1, 2, 3, 4, 5].map(n => (
              <button key={n} className={rating >= n ? "on" : ""} onClick={() => setRating(n)}>
                {n}
              </button>
            ))}
          </div>
        </>
      )}

      <p className="section-label">
        {kind === "feedback" ? "What should the mess know?" : "What went wrong?"}
      </p>
      <textarea className="field" rows={5} value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder={kind === "feedback"
                  ? "Please add more veg options after midnight"
                  : "The scanner froze after the third scan"} />

      <button className="btn-primary" style={{ width: "100%" }}
              disabled={!message.trim()} onClick={send}>
        Send
      </button>

      {sent && <p className="note" style={{ marginTop: 14 }}>
        Sent. It reaches the mess committee and our team.
      </p>}
      {error && <p className="note bad" style={{ marginTop: 14 }}>{error}</p>}
    </>
  );
}

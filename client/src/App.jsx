import { useEffect, useState } from "react";
import { api } from "./lib/api";
import Order from "./screens/Order.jsx";
import Ticket from "./screens/Ticket.jsx";
import Counter from "./screens/Counter.jsx";
import Admin from "./screens/Admin.jsx";
import Say from "./screens/Say.jsx";

const TABS = [
  ["order", "Order"],
  ["counter", "Counter"],
  ["admin", "Admin"],
  ["say", "Say"],
];

// Holds which screen is showing, the student's registration number, and the
// order they are currently waiting on. Everything else lives in its screen.
export default function App() {
  const [tab, setTab] = useState("order");
  const [theme, setTheme] = useState(() => localStorage.getItem("nightit.theme") || "system");
  const [regNo, setRegNo] = useState(() => localStorage.getItem("nightit.reg") || "26BDE0124");
  const [waiting, setWaiting] = useState(null);      // { orderId, code }
  const [up, setUp] = useState(null);

  useEffect(() => {
    document.body.className = `theme-${theme}`;
    try { localStorage.setItem("nightit.theme", theme); } catch { /* private window */ }
  }, [theme]);

  useEffect(() => {
    try { localStorage.setItem("nightit.reg", regNo); } catch { /* private window */ }
  }, [regNo]);

  useEffect(() => {
    api.health().then(h => setUp(Boolean(h.ok))).catch(() => setUp(false));
  }, []);

  // A UPI cart carries its code back from confirm. A cash cart has no code on
  // the phone at all: the student paid in person, so the counter hands it over
  // against the queue number. The ticket screen handles both.
  function handleOrdered(orderId, mode, code) {
    setWaiting({ orderId, code: mode === "cash" ? null : code || null });
  }

  if (waiting) {
    return <Ticket orderId={waiting.orderId} code={waiting.code}
                   onBack={() => { setWaiting(null); setTab("order"); }} />;
  }

  return (
    <div className="app">
      <div className="topline">
        <div>
          <span className="eyebrow">VIT night mess</span>
          <h1>Night<span>IT</span></h1>
          <p className="hero-note">
            Order from inside your block. <strong>One code, one meal.</strong>
          </p>
        </div>
        <div className="action-stack">
          <div className="theme-wrap">
            <span className="theme-icon">{theme === "dark" ? "◑" : "☀"}</span>
            <select className="theme-select" value={theme} onChange={e => setTheme(e.target.value)}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
        </div>
      </div>

      <div className="tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? "active" : ""}`}
                  onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === "order"   && <Order regNo={regNo} setRegNo={setRegNo} onOrdered={handleOrdered} />}
      {tab === "counter" && <Counter />}
      {tab === "admin"   && <Admin />}
      {tab === "say"     && <Say regNo={regNo} />}

      <div className={`api-pill ${up === true ? "up" : up === false ? "down" : ""}`}>
        <i />{api.base.replace("https://", "")}
      </div>
    </div>
  );
}

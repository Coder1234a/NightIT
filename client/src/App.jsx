import { useEffect, useState } from "react";
import {
  BrowserRouter, Routes, Route, Link, Navigate, useNavigate, useParams,
} from "react-router-dom";
import { api } from "./lib/api";
import Order from "./screens/Order.jsx";
import Ticket from "./screens/Ticket.jsx";
import Counter from "./screens/Counter.jsx";
import Admin from "./screens/Admin.jsx";
import Say from "./screens/Say.jsx";

const LAST_ORDER = "nightit.order";
const ROLE = "nightit.role";

// Paints the whole app in the palette for whoever is using it: men's blocks,
// ladies' blocks, or staff.
function useRole(role) {
  useEffect(() => {
    document.body.dataset.role = role || "";
    if (role) { try { localStorage.setItem(ROLE, role); } catch { /* private */ } }
  }, [role]);
}

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("nightit.theme") || "system"; } catch { return "system"; }
  });
  useEffect(() => {
    document.body.className = `theme-${theme}`;
    try { localStorage.setItem("nightit.theme", theme); } catch { /* private */ }
  }, [theme]);
  return [theme, setTheme];
}

function ThemePicker({ theme, setTheme }) {
  return (
    <div className="theme-wrap">
      <span className="theme-icon">{theme === "dark" ? "◑" : "☀"}</span>
      <select className="theme-select" value={theme} aria-label="Colour theme"
              onChange={e => setTheme(e.target.value)}>
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </div>
  );
}

/* ------------------------------------------------------------------ door -- */
// The front door. Choosing here is what sets the palette and keeps the student
// and staff sides of the app visibly apart.
function Door() {
  useRole(null);
  const [theme, setTheme] = useTheme();
  const [resume, setResume] = useState(null);
  const nav = useNavigate();

  useEffect(() => {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LAST_ORDER) || "null"); } catch { /* ignore */ }
    if (!saved?.id) return;
    api.orderStatus(saved.id)
      .then(s => { if (s.status === "paid" || s.status === "ready") setResume({ ...saved, s }); })
      .catch(() => {});
  }, []);

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
        <div className="action-stack"><ThemePicker theme={theme} setTheme={setTheme} /></div>
      </div>

      {resume && (
        <div className="resume">
          <div className="r-copy">
            <b>{resume.s.ready ? "Your food is ready" : `You are ${resume.s.position} in line`}</b>
            {resume.s.block} · token {resume.s.queue_no}
          </div>
          <button onClick={() => nav(`/order/${resume.id}`)}>Open</button>
        </div>
      )}

      <span className="sticker">who are you tonight?</span>
      <div className="door">
        <button className="door-btn" onClick={() => nav("/mens")}>
          <span className="blob m" />
          <span><span className="t">Men&rsquo;s hostel</span>
            <span className="s">Order from your block&rsquo;s night counter</span></span>
        </button>
        <button className="door-btn" onClick={() => nav("/ladies")}>
          <span className="blob l" />
          <span><span className="t">Ladies&rsquo; hostel</span>
            <span className="s">Order from your block&rsquo;s night counter</span></span>
        </button>
        <button className="door-btn" onClick={() => nav("/staff")}>
          <span className="blob s" />
          <span><span className="t">Mess staff</span>
            <span className="s">Counter queue, scanning and the dashboard</span></span>
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- student -- */
function Student({ hostelType }) {
  useRole(hostelType);
  const [theme, setTheme] = useTheme();
  const [tab, setTab] = useState("order");
  const [regNo, setRegNo] = useState(() => {
    try { return localStorage.getItem("nightit.reg") || ""; } catch { return ""; }
  });
  const nav = useNavigate();

  useEffect(() => {
    try { localStorage.setItem("nightit.reg", regNo); } catch { /* private */ }
  }, [regNo]);

  function onOrdered(orderId, mode, code) {
    try {
      localStorage.setItem(LAST_ORDER, JSON.stringify({ id: orderId, code: code || null }));
    } catch { /* private */ }
    nav(`/order/${orderId}`, { state: { code: code || null } });
  }

  const label = hostelType === "ladies" ? "Ladies’ hostel" : "Men’s hostel";

  return (
    <div className="app">
      <div className="topline">
        <div>
          <Link to="/" className="crumb">&larr; change</Link>
          <span className="eyebrow">{label}</span>
          <h1>Night<span>IT</span></h1>
        </div>
        <div className="action-stack"><ThemePicker theme={theme} setTheme={setTheme} /></div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === "order" ? "active" : ""}`}
                onClick={() => setTab("order")}>Order</button>
        <button className={`tab ${tab === "say" ? "active" : ""}`}
                onClick={() => setTab("say")}>Feedback</button>
      </div>

      {tab === "order"
        ? <Order hostelType={hostelType} regNo={regNo} setRegNo={setRegNo} onOrdered={onOrdered} />
        : <Say regNo={regNo} hostelType={hostelType} />}
    </div>
  );
}

/* ---------------------------------------------------------------- ticket -- */
function TicketPage() {
  const { id } = useParams();
  const nav = useNavigate();
  useRole((() => { try { return localStorage.getItem(ROLE) || "mens"; } catch { return "mens"; } })());
  let code = null;
  try { code = (JSON.parse(localStorage.getItem(LAST_ORDER) || "null") || {}).code; } catch { /* ignore */ }
  return <Ticket orderId={Number(id)} code={code}
                 onBack={() => nav(`/${localStorage.getItem(ROLE) || "mens"}`)} />;
}

/* ----------------------------------------------------------------- staff -- */
function Staff() {
  useRole("staff");
  const [theme, setTheme] = useTheme();
  const [tab, setTab] = useState("counter");
  return (
    <div className="app staff-shell">
      <div className="topline">
        <div>
          <Link to="/" className="crumb">&larr; exit</Link>
          <span className="eyebrow">Mess staff</span>
          <h1>Night<span>IT</span> desk</h1>
        </div>
        <div className="action-stack"><ThemePicker theme={theme} setTheme={setTheme} /></div>
      </div>
      <div className="tabs">
        <button className={`tab ${tab === "counter" ? "active" : ""}`}
                onClick={() => setTab("counter")}>Counter</button>
        <button className={`tab ${tab === "admin" ? "active" : ""}`}
                onClick={() => setTab("admin")}>Dashboard</button>
      </div>
      {tab === "counter" ? <Counter /> : <Admin />}
    </div>
  );
}

/* ------------------------------------------------------------------- app -- */
export default function App() {
  const [up, setUp] = useState(null);
  useEffect(() => { api.health().then(h => setUp(Boolean(h.ok))).catch(() => setUp(false)); }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Door />} />
        <Route path="/mens" element={<Student hostelType="mens" />} />
        <Route path="/ladies" element={<Student hostelType="ladies" />} />
        <Route path="/order/:id" element={<TicketPage />} />
        <Route path="/staff" element={<Staff />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <div className={`api-pill ${up === true ? "up" : up === false ? "down" : ""}`}
           style={{ position: "fixed", bottom: 6, left: 12, zIndex: 50 }}>
        <i />{api.base.replace("https://", "")}
      </div>
    </BrowserRouter>
  );
}

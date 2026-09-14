import { useEffect, useState } from "react";
import { Bar } from "react-chartjs-2";
import {
  Chart, CategoryScale, LinearScale, BarElement, Tooltip, Legend,
} from "chart.js";
import { api, rupees } from "../lib/api";
import { tone } from "../lib/notify";

Chart.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

// What the mess supervisor sees: tonight's numbers, demand by ten-minute slot,
// stock control, and everything students have reported.
export default function Admin() {
  const [hostel, setHostel] = useState("");
  const [sum, setSum] = useState(null);
  const [menu, setMenu] = useState([]);
  const [reports, setReports] = useState([]);
  const [tab, setTab] = useState("feedback");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [s, m1, m2] = await Promise.all([api.summary(hostel), api.menu(1), api.menu(2)]);
        if (!alive) return;
        setSum(s);
        setMenu([...m1, ...m2]);
      } catch { /* keep the last good numbers on screen */ }
    };
    load();
    const t = setInterval(load, 6000);
    return () => { alive = false; clearInterval(t); };
  }, [hostel]);

  useEffect(() => { api.listFeedback(tab).then(setReports).catch(() => {}); }, [tab]);

  async function setStock(item, value) {
    await api.setStock(item.id, Math.max(0, value)).catch(() => {});
    tone("tap");
    const [m1, m2] = await Promise.all([api.menu(1), api.menu(2)]);
    setMenu([...m1, ...m2]);
  }

  const chart = {
    labels: (sum?.demand || []).map(d => d.slot),
    datasets: [{
      label: "orders",
      data: (sum?.demand || []).map(d => Number(d.orders)),
      backgroundColor: "#ff4f87",
      borderRadius: 6,
    }],
  };

  return (
    <>
      <div className="mode-toggle">
        {[["", "All"], ["mens", "Men's"], ["ladies", "Ladies'"]].map(([v, label]) => (
          <button key={v} className={`mode-btn ${hostel === v ? "active" : ""}`}
                  onClick={() => setHostel(v)}>{label}</button>
        ))}
      </div>

      <div className="tiles">
        <div className="tile"><b>{sum?.orders_tonight ?? "–"}</b><span>orders tonight</span></div>
        <div className="tile"><b>{sum?.meals_served ?? "–"}</b><span>meals served</span></div>
        <div className="tile"><b>{sum?.waiting_now ?? "–"}</b><span>waiting now</span></div>
        <div className="tile">
          <b>{sum ? rupees(sum.collections_paise) : "–"}</b><span>collected</span>
        </div>
      </div>

      <p className="section-label">Demand, ten-minute slots</p>
      {sum?.demand?.length
        ? <div style={{ background: "var(--card)", border: "1px solid var(--line)",
                        borderRadius: 20, padding: 12, marginBottom: 20 }}>
            <Bar data={chart} options={{
              responsive: true,
              plugins: { legend: { display: false } },
              scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
            }} />
          </div>
        : <p className="empty">No orders yet tonight.</p>}

      <p className="section-label">Stock control</p>
      {menu.map(i => (
        <div key={`${i.counter_id}-${i.id}`} className="q-row">
          <div className="q-copy">
            <div className="q-items">{i.name}</div>
            <div className="q-meta">counter {i.counter_id} · {i.state.replace(/_/g, " ")}</div>
          </div>
          <div className="qty">
            <button onClick={() => setStock(i, Number(i.remaining) - 1)}>&minus;</button>
            <span>{i.remaining}</span>
            <button onClick={() => setStock(i, Number(i.remaining) + 1)}>+</button>
          </div>
          <button className="btn-mini" onClick={() => setStock(i, 0)}>Sold out</button>
        </div>
      ))}

      <p className="section-label" style={{ marginTop: 22 }}>From students</p>
      <div className="tabs">
        <button className={`tab ${tab === "feedback" ? "active" : ""}`}
                onClick={() => setTab("feedback")}>Feedback</button>
        <button className={`tab ${tab === "bug" ? "active" : ""}`}
                onClick={() => setTab("bug")}>Bug reports</button>
      </div>
      {reports.map(f => (
        <div key={f.id} className="q-row">
          <div className="q-copy">
            <div className="q-items">{f.message}</div>
            <div className="q-meta">
              {f.block || "—"} · {f.reg_no || "anonymous"}
              {f.rating ? ` · ${f.rating}/5` : ""}
            </div>
          </div>
        </div>
      ))}
      {!reports.length && <p className="empty">Nothing yet.</p>}
    </>
  );
}

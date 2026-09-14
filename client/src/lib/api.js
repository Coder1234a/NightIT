// Every call to the backend goes through here, so the base URL and the error
// shape are defined in exactly one place.
const BASE = import.meta.env.VITE_API_URL || "https://nightit-api.onrender.com";

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw Object.assign(new Error(data?.error || "request_failed"), { status: res.status, data });
  return data;
}

export const api = {
  base: BASE,
  health:        ()             => call("GET",  "/health"),
  paymentConfig: ()             => call("GET",  "/payments/config"),
  blocks:        ()             => call("GET",  "/blocks"),
  menu:          (blockId)      => call("GET",  `/menu?block_id=${blockId}`),
  createOrder:   (payload)      => call("POST", "/orders", payload),
  confirmOrder:  (id)           => call("POST", `/orders/${id}/confirm`),
  cancelOrder:   (id)           => call("POST", `/orders/${id}/cancel`),
  orderStatus:   (id)           => call("GET",  `/orders/${id}/status`),
  markReady:     (id)           => call("POST", `/orders/${id}/ready`),
  serveOrder:    (id)           => call("POST", `/orders/${id}/serve`),
  counterQueue:  (counterId)    => call("GET",  `/counter/${counterId}/queue`),
  redeem:        (counterId, code) => call("POST", "/redeem", { counter_id: counterId, code }),
  setStock:      (id, remaining)=> call("POST", "/stock", { menu_item_id: id, remaining }),
  sendFeedback:  (payload)      => call("POST", "/feedback", payload),
  listFeedback:  (kind)         => call("GET",  `/feedback${kind ? `?kind=${kind}` : ""}`),
  summary:       (hostelType)   => call("GET",  `/admin/summary${hostelType ? `?hostel_type=${hostelType}` : ""}`),
};

export const rupees = paise => "₹" + (paise / 100).toFixed(0);

// "12 min" reads better than "720 seconds" on a phone at midnight.
export function humanWait(seconds) {
  if (seconds <= 0) return "ready now";
  const m = Math.round(seconds / 60);
  if (m < 1) return "under a minute";
  return `${m} min`;
}

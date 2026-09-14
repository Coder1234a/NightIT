// Short beeps so the counter and the student get feedback without looking.
let ctx;
export function tone(kind = "tap") {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    const map = { tap: [660, 0.06], ready: [880, 0.18], turn: [520, 0.12], bad: [180, 0.3] };
    const [freq, dur] = map[kind] || map.tap;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = kind === "bad" ? "sawtooth" : "sine";
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + dur);
  } catch { /* audio is a nicety, never a failure */ }
}

// Asks once, quietly. A denied permission just means no banner.
export async function askToNotify() {
  try {
    if (!("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;
    return (await Notification.requestPermission()) === "granted";
  } catch { return false; }
}

export function notify(title, body) {
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body, tag: "nightit" });
    }
  } catch { /* ignore */ }
}

import { useEffect, useRef, useState } from "react";

// The front-door intro. Self-contained on purpose: it mounts, plays, and takes
// itself off the page, so wiring it up is one tag and nothing else in the app
// has to know it exists.
//
// Three rules it enforces for you:
//   · once per visit — a sessionStorage flag, so coming back to the door does
//     not replay it. An intro on its third viewing is not charming.
//   · one tap skips it, anywhere on the screen.
//   · under prefers-reduced-motion it never runs at all.

const SEEN = "nightit.intro";
const NAME = [..."NightIT"];

// timings, in milliseconds — the whole sequence lands at about 2.2 seconds
const T = {
  letterGap:  52,   // between one letter and the next
  letterRun: 560,   // how long a single letter takes to fall and settle
  ruleRun:   340,   // the line drawing under the name
  hold:      300,   // the pause on the finished name
  curtain:   700,   // the curtain sliding off the top
};

export default function Intro() {
  const skipped = typeof sessionStorage !== "undefined" &&
                  sessionStorage.getItem(SEEN) === "1";
  const calm = typeof matchMedia !== "undefined" &&
               matchMedia("(prefers-reduced-motion: reduce)").matches;

  const [alive, setAlive] = useState(!skipped && !calm);
  const box = useRef(null);
  const mark = useRef(null);
  const rule = useRef(null);
  const tag = useRef(null);

  useEffect(() => {
    if (!alive) return;
    try { sessionStorage.setItem(SEEN, "1"); } catch { /* private mode */ }

    const el = box.current;
    let dead = false;
    const timers = [];
    const after = (ms, fn) => timers.push(setTimeout(fn, ms));

    // the flat shapes arrive first, from wherever they already sit
    el.querySelectorAll(".ni-shape").forEach((s, i) => {
      s.animate([{ transform: "scale(.4)", opacity: 0 },
                 { transform: "scale(1)",  opacity: .9 }],
        { duration: 680, delay: 70 + i * 55,
          easing: "cubic-bezier(.2,1.2,.35,1)", fill: "both" });
    });

    // then the letters drop in, one after another, with a little overshoot
    const chars = [...mark.current.children];
    chars.forEach((c, i) => {
      c.animate([{ transform: "translateY(-46px) rotate(-8deg)", opacity: 0 },
                 { transform: "none", opacity: 1 }],
        { duration: T.letterRun, delay: i * T.letterGap,
          easing: "cubic-bezier(.18,1.5,.42,1)", fill: "both" });
    });

    const lettersEnd = (chars.length - 1) * T.letterGap + T.letterRun;

    // the rule draws under the name, and the strapline fades up behind it
    after(lettersEnd, () => {
      if (dead) return;
      rule.current.style.transition = `width ${T.ruleRun}ms cubic-bezier(.22,1,.36,1)`;
      rule.current.style.width = mark.current.offsetWidth + "px";
      tag.current.style.transition = `opacity ${T.ruleRun}ms ease 180ms`;
      tag.current.style.opacity = "1";
    });

    // and the whole curtain lifts off the top
    after(lettersEnd + T.ruleRun + T.hold, () => {
      if (dead) return;
      el.classList.add("ni-gone");
      after(T.curtain, () => !dead && setAlive(false));
    });

    // one tap anywhere gets you past it
    const skip = () => {
      if (dead) return;
      el.getAnimations({ subtree: true }).forEach(a => a.finish());
      el.classList.add("ni-gone");
      after(T.curtain, () => !dead && setAlive(false));
    };
    el.addEventListener("pointerdown", skip, { once: true });

    return () => {
      dead = true;
      timers.forEach(clearTimeout);
      el?.removeEventListener("pointerdown", skip);
    };
  }, [alive]);

  if (!alive) return null;

  return (
    <div className="ni-curtain" ref={box} aria-hidden="true">
      <span className="ni-shape s1" /><span className="ni-shape s2" />
      <span className="ni-shape s3" /><span className="ni-shape s4" />
      <span className="ni-shape s5" /><span className="ni-shape s6" />
      <div className="ni-stack">
        <div className="ni-mark" ref={mark}>
          {NAME.map((c, i) => (
            <span key={i} className={`ni-ch${i >= 5 ? " it" : ""}`}>{c}</span>
          ))}
        </div>
        <div className="ni-rule" ref={rule} />
        <div className="ni-tag" ref={tag}>VIT night mess</div>
      </div>
    </div>
  );
}

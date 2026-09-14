# Wiring up the front-door intro

Two files to add, one file to append to, two lines to change. Nothing else in
the app is touched, and everything below has already been run against the real
client and verified.

**Timing:** the whole thing lands at about **2.2 seconds**, then gets out of the
way. The numbers live in one object at the top of `Intro.jsx` — change them
there, nowhere else.

```js
const T = {
  letterGap:  52,   // between one letter and the next
  letterRun: 560,   // one letter falling and settling
  ruleRun:   340,   // the line drawing under the name
  hold:      300,   // the pause on the finished name
  curtain:   700,   // the curtain sliding off the top
};
```

---

## The four steps

**1.** Copy `Intro.jsx` into `client/src/screens/`.

**2.** Append the whole of `intro.css` to the end of `client/src/index.css`.
Paste it at the bottom — it deliberately overrides nothing.

**3.** In `client/src/App.jsx`, add the import next to the others:

```js
import Intro from "./screens/Intro.jsx";
```

**4.** In the same file, in the `Door()` function, change the opening tag and
add one line under it:

```diff
-    <div className="app">
+    <div className="app enter">
+      <Intro />
       <div className="topline">
```

That is the entire integration. Build, and it plays.

---

## What it does on its own

**Plays once per visit.** A `sessionStorage` flag under `nightit.intro`. A
reload does not replay it; going into a hostel and pressing "change" does not
replay it. Closing the tab and coming back does. This is the difference between
charming and infuriating, and it is why the flag is not optional.

**One tap skips it,** anywhere on the screen.

**Never runs under `prefers-reduced-motion`.** Not slowed — skipped. The door
renders immediately, with no entrance animation either.

**Takes itself off the page** when it finishes. No leftover overlay sitting on
top of your buttons.

---

## The one thing that will break it

The staggered entrance uses `nth-child` to space the door's elements out:

```css
.enter > *:nth-child(2) { animation-delay:0ms; }     /* topline    */
.enter > *:nth-child(3) { animation-delay:70ms; }    /* LiveOrder  */
.enter > *:nth-child(4) { animation-delay:140ms; }   /* sticker    */
.enter > *:nth-child(5) { animation-delay:210ms; }   /* .door      */
```

Child 1 is `<Intro />` itself. **If you add or remove an element inside
`<div className="app enter">`, every delay after it shifts by one** and some
element ends up with no delay rule at all — which means no animation, so it
appears instantly while everything around it slides. Nothing errors; it just
looks wrong.

If that happens, either renumber the block or add one more line to the end of
it. It is the only fragile part of this.

---

## Testing it

You cannot see it twice without clearing the flag. In DevTools:

```js
sessionStorage.removeItem("nightit.intro"); location.reload();
```

Or just open a private window.

Check all four:

1. Fresh tab → the intro plays and clears itself.
2. Reload → no intro, door appears normally.
3. Enter a hostel, press "change" → no intro, door still complete.
4. DevTools → Rendering → *Emulate prefers-reduced-motion* → no intro at all,
   and the door still fully visible.

---

## If you want to take it out again

Delete `screens/Intro.jsx`, remove the import, drop `enter` from the class and
the `<Intro />` line. The CSS block at the bottom of `index.css` then applies to
nothing and can stay or go.

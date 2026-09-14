# Working on the NightIT frontend

For Vidhi and Vedanshi. Everything you need to change how the app looks and
reads, and a short list of things that will break it if you touch them.

The rule that keeps you safe: **anything inside `client/src` is yours. Nothing
outside it is.** If a change you want to make seems to need a file in `server/`,
stop and ask — it almost certainly doesn't.

---

## Run it before you change it

Two terminals. The frontend alone is enough for design work; it talks to the
live API on Render.

```bash
cd client
npm install          # once
npm run dev          # http://localhost:5173
```

Save a file and the browser updates itself. You do not need to restart
anything, and you do not need the backend running on your machine.

If the page loads but the menu is empty, the Render API has gone to sleep. Open
`https://nightit-api.onrender.com/health` once, wait half a minute, reload.

---

## Where everything lives

```
client/src/
├── index.css              ← all the styling, for the whole app
├── App.jsx                ← the pages and what routes to what
├── main.jsx               ← boots React. Leave it alone.
├── lib/
│   ├── api.js             ← every call to the backend
│   ├── loadRazorpay.js    ← the payment popup
│   └── notify.js          ← the buzz and the beep
└── screens/
    ├── Order.jsx          ← block, registration number, menu, cart
    ├── Ticket.jsx         ← the pickup code, QR and queue position
    ├── LiveOrder.jsx      ← the "you are 3 in line" strip
    ├── Counter.jsx        ← staff: the queue and the scanner
    ├── Admin.jsx          ← staff: the dashboard
    └── Say.jsx            ← feedback and bug reports
```

### What to open for what

| You want to change | Open |
|---|---|
| Any colour, size, spacing, shadow, corner | `index.css` |
| Wording on the front door | `App.jsx` |
| Wording on the ordering screen | `Order.jsx` |
| Wording on the ticket | `Ticket.jsx` |
| Which pages exist and their URLs | `App.jsx`, the `<Routes>` block at the bottom |
| The order things appear in on a screen | that screen's `.jsx`, the block after `return (` |
| Menu photos | drop files into `client/public/items/` — see the README there |

---

## Colours

Every colour in the app comes from one place at the top of `index.css`:

```css
:root { --ink:#24202d; --muted:#756d7d; --paper:#fff9f4; --card:#fffdfb;
        --line:#eadfd9; --pink:#ff4f87; --orange:#ff6b35; --yellow:#ffd166;
        --lilac:#b7a9ff; --mint:#a8e6cf; --blue:#8bd5ff; --green:#22b573;
        --red:#ee4f62; --shadow:#e7d7d0; }
```

Change `--pink` and every button, price and accent in the app changes with it.
That is the whole point — **never paste a hex code anywhere else.** If you find
yourself writing `color:#ff4f87` in a rule, use `color:var(--pink)` instead, or
the dark theme and the three role palettes will not follow your change.

What each one is for:

| Variable | Used for |
|---|---|
| `--ink` | body text and the dark cart bar |
| `--muted` | secondary text, labels, captions |
| `--paper` | the page background |
| `--card` | anything raised off the page |
| `--line` | borders |
| `--pink` | the main accent: buttons, prices, the active tab |
| `--orange` | the second half of button gradients |
| `--green` / `--red` | "ready" and "sold out" — leave these readable |
| `--shadow` | the offset drop shadows under cards |

### The three role palettes

Search `index.css` for **Role themes**. Men's blocks, ladies' blocks and staff
each override a handful of variables:

```css
body[data-role="mens"]   { --pink:#ff6b35; ... }
body[data-role="ladies"] { --pink:#a45cff; ... }
body[data-role="staff"]  { --pink:#0f9b8e; ... }
```

Change a hex here and only that audience sees it. This is where to make the
girls' side feel different from the boys' side.

The `data-role` attribute is put on `<body>` by `App.jsx`. You style against
it; you don't set it.

---

## Spacing

Search `index.css` for **TYPOGRAPHY AND RHYTHM**. That whole section exists to
be tuned — it is line heights, margins and padding and nothing else. Every rule
in it overrides an earlier one on purpose, so editing a number there is safe.

If a screen feels cramped, that section is almost always the answer, not the
original rule further up the file.

---

## Recipes

**Make a button bigger.** `index.css`, find `.btn-primary`, change `padding`.

**Change what the front door says.** `App.jsx`, find `who are you tonight?` and
the three `door-btn` blocks. Only edit text between `>` and `<`.

**Reorder the ordering screen.** `Order.jsx`, inside `return (`. Each section is
a `<p className="section-label">` followed by its control. Move the pair
together, top to bottom, and don't move anything out of the outer `<>…</>`.

**Add a menu photo.** Save it as `client/public/items/<slug>.jpg` — the slug is
the item name in lower case with hyphens, so Cheese Maggi is
`cheese-maggi.jpg`. Square, at least 400×400, under 80 KB. A missing photo
falls back to a coloured tile, so the app never breaks over one.

**Change the dark theme.** `index.css`, the `body.theme-dark` rules near the
top.

---

## Do not touch

Not because you can't understand it — because it is wired to the backend and a
small edit breaks the whole app rather than one screen.

**`lib/api.js`** — every backend call. Change a path here and nothing loads.
Read it if you want to know what data a screen gets; don't edit it.

**Anything in a `.jsx` that is not text between tags.** In particular:

- `className="..."` — this is the hook the CSS uses. Rename it and the styling
  falls off.
- `useState`, `useEffect`, `api.something()`, `onClick={...}` — that is the
  logic.
- `key={i.id}` on a list item.
- `i.price_paise`, `i.remaining`, `i.prep_minutes`, `o.queue_no` and friends —
  these names come from the database and have to match exactly.

**`main.jsx`** — eight lines, no reason to change them.

**The `<Routes>` block in `App.jsx`** — adding a page is fine, but changing an
existing path breaks the links students already have to their orders.

**Anything in `server/`** — that is Anikeit's. Frontend work never needs it.

---

## Two people, one repo

You will both be editing `index.css`. That is where conflicts happen.

- **Pull before you start**, every time: `git pull`
- **Commit small and often**, not one big commit at the end
- Agree who owns which screen for the next hour and stay out of each other's
- If git says *CONFLICT*, don't guess. Send the file to Anikeit — untangling one
  takes two minutes and guessing costs an hour

---

## Before you push

Three checks. All three, every time.

1. **The build works.** `npm run build` in `client/`. If it prints an error, the
   deploy will fail too. Fix it or undo your change — never push a red build.
2. **Click through it.** Front door → a block → add two items → pay → the ticket
   appears with a code. Then `/staff` → the cart is in the queue.
3. **Look at it narrow.** Squeeze the browser to phone width, or use the device
   toolbar. Every student uses this on a phone in the dark; nothing should
   overflow sideways.

If all three pass, push.

---

## When something breaks

**A blank white page** — you almost certainly deleted a `}`, a `)` or a tag.
Open the browser console (F12) and read the first red line: it names the file
and the line. Or run `git diff` and look at what you changed.

**The styling has vanished from one thing** — a `className` was renamed or a
`{` in the CSS is unclosed. A missing closing brace kills every rule after it,
so check the section you edited last.

**"Cannot reach the server"** — not you. Render is asleep. Open
`https://nightit-api.onrender.com/health` and wait thirty seconds.

**You want to start over on a file:**

```bash
git checkout -- client/src/index.css
```

That throws away your uncommitted changes to that one file and nothing else.
This is why you commit often.

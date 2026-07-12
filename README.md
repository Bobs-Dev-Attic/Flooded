# FLOODED

A portrait, mobile-and-web 2D puzzle-platformer. You're trapped underground with
a pressure **water hose**. Blast the dirt to wash out tunnels in **8 directions**,
reveal (and escape) the hazards buried around you, and climb your way to the
surface before the water — or something worse — gets you.

No build step, no dependencies. Just open `index.html` in any modern browser, or
serve the folder statically.

```
# from the repo root
python3 -m http.server 8000
# then open http://localhost:8000
```

## How to play

Vertical progress is a rhythm: **blast up to clear headroom, then climb into it.**

| Action | Touch | Keyboard / Mouse |
|---|---|---|
| Move left / right | drag the **left stick** ◀ ▶ | `A` / `D` or `←` / `→` |
| Jump / **Climb** a tunnel | push the **left stick** ▲ up | `W`, `Space` or `↑` |
| Aim & fire hose (full **360°**) | drag the **right stick** any direction | hold `Mouse` (aims at cursor), or the `Q W E / A · D / Z X C` ring |

Both control pads are analog **circular joysticks**. The right hose stick fires in
whatever direction you point it — a continuous 360°, not just 8 fixed angles.

- **Climbing:** holding jump while braced inside a tunnel hauls you steadily
  upward. Out in open caverns there's nothing to grip — you're back to gravity.
- **The hose** washes away dirt and injects water. Spray *briefly* — hosing a
  confined space non-stop floods it and you'll run out of **AIR**.

## Hazards (hidden until your tunnels reach them)

- **Rocks / bedrock** — can't be washed away; dig around them.
- **Poison gas** — trapped in pockets; it rises when you break in. Drains your
  **LIFE**. Water pushes it out.
- **Drains** — swallow water fast (safe relief valves).
- **Clogged drains** — no relief; and a **rabid rodent** washed into an open
  drain will clog it, backing the water up.
- **Rabid rodents** — nest in hidden cavities, chase you, and bite.

Reach the daylight band at the top alive to win.

## Under the hood

- Single-file engine in `js/game.js` (canvas 2D, fixed 60 Hz timestep).
- Water is a **mass-based cellular-automaton fluid** — it falls, pools, seeks its
  level and rises under pressure — rendered in a chunky, pixelated style with an
  animated surface shimmer and spray particles.
- A fog-of-war reveal system keeps buried hazards hidden until a tunnel opens
  into them.

Layout: `index.html` · `css/style.css` · `js/game.js`.

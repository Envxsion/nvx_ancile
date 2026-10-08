# Brand: APERTURE, as carried by NVX Ancile

Ancile belongs to the NVX family from nvx.sh, beside NVX Session and NVX Kinetix. The family shares one design language, called **APERTURE**: graphite grounds, hairline edges, depth from a lift ladder rather than shadows, Archivo for words, Martian Mono for data, and one expo-out ease. Each product changes exactly two things: its **signal colour** and its **mark**. Anything else that differs is a bug.

The source of truth is `packages/aperture/`. It holds `tokens.css` (family), `ancile.css` (identity), `mark.tsx` and `icons/`.

## The signal

| Product | Signal | The idea |
|---|---|---|
| NVX Session | chartreuse `#dcea4f` | The signal in the tab |
| NVX Kinetix | electric cyan `#4fd6ea` | The signal down the wire |
| **NVX Ancile** | **ultraviolet `#9d86ff`** | The light just past the visible edge. The ancile was the shield that fell from the sky. |

| Token | Dark | Light | Use |
|---|---|---|---|
| `--signal` | `#9d86ff` | `#6e52ec` | Fills: primary button, active bar, the mark, selection |
| `--signal-ink` | `#b3a1ff` | `#5a3fd6` | Text and hairline strokes in signal; focus ring |
| `--signal-mid` | `#7a63e6` | `#5a3fd6` | Pressed states, gradients' far stop |
| `--signal-dim` | `#2a2160` | `#e4defe` | Tinted backgrounds for selected rows |
| `--on-signal` | `#08090a` | `#ffffff` | Text on a signal fill (6.9:1 dark, 5.2:1 light) |

**Signal is for system affordance only:** focus, the primary action, live state, the thing the AI is doing now. It's never decoration and never a status colour. Success, warning and failure have their own tokens (`--ok`, `--warn`, `--fail`). Violet is the only hue Ancile never assigns from the identity ramp, because it would sit beside the signal.

## Grounds and surfaces

| Token | Dark | Light |
|---|---|---|
| `--void` (page) | `#08090a` | `#eceef0` (cool, never warm) |
| `--chrome` (titlebar, rail) | `#0a0b0e` | `#e6e9ec` |
| `--lift` (content) | `#12151b` | `#ffffff` |
| `--lift-2` (raised work) | `#171b22` | `#f4f5f6` |
| `--lift-3` (popovers) | `#1d222a` | `#ffffff` + shadow |
| `--hair` / `--edge` | fg at 0.10 / 0.16 | fg at 0.08 / 0.12 |

Depth comes from the ladder and inset hairlines, not drop shadows. Shadows are reserved for objects that float (popovers, the palette, dialogs).

The **identity ramp** (`--s-coral`, `--s-amber`, `--s-jade`, `--s-cyan`, `--s-azure`, `--s-magenta`, `--s-chalk`) colours models, branches and nodes. It's one luminance band, so no item reads louder than another. Chalk is the colour-blind-safe neutral. On the light ground the ramp is darkened to hold 3:1 as thin strokes.

## Type

- **Archivo** for everything that is read, using its width axis (62–125) for display.
- **Martian Mono** only for data: ids, hashes, token counts, costs, timestamps. Never for words.
- Upright throughout: no italics.
- Sentence case. Labels can be small caps-height uppercase, tracked at most 0.06em.
- App scale:

  | Role | Size | Leading |
  |---|---|---|
  | micro | 10.5 | |
  | small | 12 | |
  | UI | 13 | 1.4 |
  | body | 14.5 | |
  | reading | 15.5 | 1.65, 72ch measure |
  | h3 | 17 | |
  | h2 | 22 | |
  | h1 | 30 | |

## The mark

The ancile was the figure-of-eight shield of Mars, waisted on both sides. Numa had eleven identical copies made so the true one could never be singled out, which suits a product built on branches that share an origin.

The mark draws the shield as **two contours that never close**, the family's open-mark trait. Around the core is a small **broken ring**, which nods to Session's aperture rings. It uses the family depth ramp: left half at 1, right half at 0.7, inner ring at 0.4, plus a solid core. Geometry is exported from `mark.tsx` (`MARK`), so the app icon and the titlebar mark are the same object.

| State | Motion | Meaning |
|---|---|---|
| `idle` | Inner ring drifts (16 s) | Ready |
| `thinking` | Ring turns quickly, halves breathe | Planning, retrieving |
| `streaming` | Core beats | Writing a reply |
| `ask` | **Halves close in**, core pulses | Waiting for your approval: the shield shuts until you answer |
| `offline` | Grey, still | Not connected |
| `alarm` | Fail colour, two shakes | Something failed |

States change speed, distance and colour, never the geometry. All of them respect reduced motion.

**App icon** (`icons/icon-128.svg`), the family formula:
- a 96 px squircle at radius 24
- a graphite gradient ground
- a top-lit edge
- a soft signal glow
- the mark in a three-stop signal gradient, with a blurred twin for bloom

**Favicon** (`icons/favicon.svg`): the two halves and core only. The inner ring disappears at 16 px.

## Naming

| Where | Write |
|---|---|
| UI, titles, docs | **NVX Ancile**, then "Ancile" |
| The lockup | `NVX` heavy, `Ancile` regular in a quieter tone, beside the mark |
| Page titles | `<Page> · NVX Ancile` |
| Repo, packages, env | `nvx_ancile`, `@nvx/*`, `ANCILE_*` |
| Domain, bundle | `ancile.nvx.sh`, `sh.nvx.ancile` |
| Company | `nvx.sh`, lowercase. Footer: "A product from nvx.sh" |

## Voice

Plain, concrete, second person, British spelling. Say what something does, not how clever it is.

| Do | Don't |
|---|---|
| "Start node" | "Submit" / "Launch 🚀" |
| "Waking your GPU node · about 90 s" | "Please wait…" |
| "Anthropic rejected the API key. Update it in Settings → Models." | "Oops! Something went wrong." |
| "No sources yet. Drop files here, paste a link, or pull in a past thread." | "Nothing to see here!" |
| "Answered by GPT-5.5 · Sonnet was unavailable" | Hiding the fallback |

- Errors don't apologise and are never vague.
- An action keeps one name through the whole flow: the button "Archive" gives the toast "Archived".
- No em dashes in UI copy. No exclamation marks.

## Do and don't

- **Do** use tokens. A literal colour in a component is a bug.
- **Do** let one thing per view carry signal. If everything is violet, nothing is.
- **Do** use the radius ladder. Controls are tight (5–7 px), surfaces soft (10–14 px), state is a pill. One radius on everything is the generic-SaaS tell.
- **Don't** put gradients on surfaces, glassmorphism on scrolling content, or a warm cream light theme.
- **Don't** set words in Martian Mono.
- **Don't** add a "PRO" badge to every Pro feature. The family shows Pro once, as a pill in Settings, and lights unlocked items in signal.

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
| `--signal` | `#9d86ff` | `#6d51eb` | Fills: primary button, active bar, the mark, live dots. Never text. |
| `--signal-ink` | `#b3a1ff` | `#593ed5` | Text and hairline strokes in signal; focus ring |
| `--signal-mid` | `#7a63e6` | `#5a3fd6` | Pressed states, gradients' far stop |
| `--signal-dim` | `#2a2160` | `#e4defe` | Tinted backgrounds: selected text and rows, the halo of a live dot |
| `--on-signal` | `#08090a` | `#ffffff` | Text on a signal fill (6.9:1 dark, 5.2:1 light, 4.5:1 under the button's lit top edge) |

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

The **identity ramp** (`--s-coral`, `--s-amber`, `--s-jade`, `--s-cyan`, `--s-azure`, `--s-magenta`, `--s-chalk`) colours models, branches and nodes. It's one luminance band, so no item reads louder than another. Chalk is the colour-blind-safe neutral. On the light ground the ramp is darkened to hold 3:1 as thin strokes. Where a ramp colour is text (a branch name), it is drawn as `color-mix(in oklab, <hue> var(--ramp-ink), var(--fg))`: unchanged in dark, a fifth of the way to `--fg` in light, which holds 4.5:1.

## Text contrast

Every text token holds 4.5:1 on every ground (`--void` to `--panel`), on glass, and, for the inks, on a chip of its own colour (a 12% wash, the strongest the app lays under its own ink), in both themes and in every ground tint, accent, contrast, gilt mode and edition. `apps/cockpit/test/contrast.test.ts` reads the token CSS and checks all of it. The worst case for each, free edition, standard contrast:

| Token | Dark | Worst ground | Ratio | Light | Worst ground | Ratio |
|---|---|---|---|---|---|---|
| `--fg` | `#eff0ea` | lift-3 | 13.94 | `#0e1114` | void-deep | 14.84 |
| `--fg-2` | `#cfd2d5` | lift-3 | 10.52 | `#2b3137` | void-deep | 10.30 |
| `--fg-3` | `#b4b8bc` | lift-3 | 8.01 | `#4c545c` | void-deep | 6.03 |
| `--mute` | `#9aa0a6` | lift-3 | 6.05 | `#535a61` | void-deep | 5.48 |
| `--mute-2` | `#7c8a96` | lift-3 | 4.51 | `#5a6168` | void-deep | 4.92 |
| `--placeholder` | fg at 0.52 | lift-3 | 4.79 | fg at 0.60 | void-deep | 4.57 |
| `--signal-ink` | `#b3a1ff` | lift-3 | 7.20 | `#593ed5` | void-deep | 5.35 |
| `--ok` | `#7bc96f` | lift-3 | 7.93 | `#1f683c` | void-deep | 5.30 |
| `--warn` | `#d8a13c` | lift-3 | 6.91 | `#805108` | void-deep | 5.31 |
| `--fail` | `#d87d63` | lift-3 | 5.35 | `#a62f20` | void-deep | 5.40 |
| `--gilt` | `#d9b871` | lift-3 | 8.40 | `#785514` | void-deep | 5.29 |

Placeholders are text and are held to the same 4.5:1. `--mute-3` (2.2 to 3.4:1) is for rules, dots, gutters and the offline mark, never for text; quiet text uses `--mute-2`. `--signal` is a fill, never text.

## Materials: glass, grain and gilt

- **Glass** (`.m-glass`, `.m-glass-thick`): a translucent ground (`--glass` at 0.64, `--glass-thick` at 0.8) with a backdrop blur. It is a utility and wins over the solid ground a component sets for when glass is off, but only while glass is in force: Settings → Appearance → Surfaces → Glass, transparency not reduced, effects not Light. Otherwise it steps aside and the component's own solid ground shows.
- **Grain**: one fixed layer of grey noise over the whole app, blended hard-light at `--grain-opacity` (0.10 dark, 0.08 light). Above mid-grey it lightens, below it darkens, and mid-grey changes nothing, so it shows on the near-black grounds as well as the light ones without veiling either.
- **Gilt** has three modes. On is the full brass: rich ink, a wash you can see (`--gilt-wash`, 12%), a bright rim (`--gilt-line`) and the glow. Subtle greys the ink and halves the wash and rim, with a hairline for the glow. Off removes the brass. Components draw gilt grounds with `--gilt-wash` and gilt rules with `--gilt-line`, so every mode reaches them.
- Settings shows a note under Surfaces and Film grain whenever Transparency, the system or Effects overrides them, naming and linking the setting.

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

## Pro: gilt and a brighter palette

Gold is the Pro accent and means owned, kept or earned; violet stays Ancile's identity and the only colour for focus, the primary action and live state. Gold is never a status, an error, a link or a focus ring. `packages/aperture/src/pro.css` holds both halves.

**The Pro palette** applies on `<html data-edition="pro">`, which the Cockpit sets from the licence (a Pro build with a Pro tier) and the theme script replays before first paint. Text is a step brighter on dark and a step deeper on light, edges a little firmer, the ultraviolet signal (default accent only) a little more luminous, the brass richer. Grounds and the lift ladder do not change, so a chosen ground tint holds, and High contrast still wins.

| Token | Pro dark | Worst ground | Ratio | Pro light | Worst ground | Ratio |
|---|---|---|---|---|---|---|
| `--fg-2` | `#dde0e2` | lift-3 | 12.05 | `#20262c` | void-deep | 11.97 |
| `--fg-3` | `#c6cacd` | lift-3 | 9.69 | `#3b434b` | void-deep | 7.87 |
| `--mute` | `#adb3b9` | lift-3 | 7.55 | `#454c53` | void-deep | 6.82 |
| `--mute-2` | `#939da6` | lift-3 | 5.79 | `#4b5259` | void-deep | 6.21 |
| `--signal-ink` | `#c2b4ff` | lift-3 | 8.57 | `#4c30cc` | void-deep | 6.32 |
| `--gilt` (text) | `#e6c784` | lift-3 | 9.79 | `#6b4d14` | void-deep | 6.10 |
| `--on-signal` on `--signal` | `#08090a` on `#ab97ff` | | 8.16 | `#fff` on `#6043e6` | | 6.10 |

`--on-gilt` (`#1a1306`) on every stop of `--gilt-fill` holds 8.72:1 or more, in both themes and both editions; the light theme's gilt frame stroke holds 4.52:1 on lift-2 (3:1 needed for a non-text edge). The free edition's gilt was already AA (9.61 dark, 6.76 light on lift).

**The gilt kit**, in both editions:

- `.gilt-frame` a 1 px gilded edge that follows any radius (`--gilt-frame-o` sets its strength); `.gilt-frame--quiet` for a locked Pro card in the free edition.
- `.pro-card` depth that answers a hand: 2 px up and the frame brightens on hover, settles on press.
- `.gilt-action` one sheen over a primary Pro action when it is reached; the fill stays violet.
- `.gilt-pill` dark ink on the gilt fill (never light text on gold).
- `.edition-mark` the status bar's Pro mark, and `.pro-awaken`, the one moment Pro arrives: a gilded line runs round the window once (a key turns Pro on, or a Pro build opens for the first time). Nothing moves with reduced motion.

Budget: one gilded thing per cluster. A screen Pro has unlocked wears one frame (its headline) and one sheen (its primary action); its cards gild only under the hand.

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
- **Don't** add a "PRO" badge to every Pro feature. Pro is named once per view: the pill on the licence (or on a locked feature's card) and the edition mark in the status bar.

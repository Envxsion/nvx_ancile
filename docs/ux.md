# Keyboard and interaction

Ancile is built to be driven from the keyboard. Every action has a shortcut, the shortcuts are listed in the `?` sheet and beside each command in the palette, and they can be rebound in Settings → Keyboard.

## The keyboard map

`Mod` is `⌘` on a Mac and `Ctrl` elsewhere.

### Everywhere

| Keys | Does |
|---|---|
| `Mod K` | Command palette |
| `/` | Search |
| `?` | Shortcut sheet |
| `Esc` | Close the topmost layer. In the composer, leave it for navigate mode. |
| `[` / `]` | Collapse or expand the rail / drawer |
| `g n` | Go to notebooks |
| `g t` | Go to threads |
| `g b` | Branch tree |
| `g i` | Notification centre |
| `g a` | Admin |
| `g l` | Logs |
| `g w` | Flows |
| `g u` | Automations |
| `Mod Shift L` | Cycle theme: system, dark, light |

### Lists

| Keys | Does |
|---|---|
| `j` / `k` | Next / previous |
| `Enter` | Open |
| `x` | Select (for bulk actions) |
| `#` | Archive |

### In a thread (navigate mode)

| Keys | Does |
|---|---|
| `j` / `k` | Next / previous message |
| `e` | Edit (creates a sibling) |
| `r` | Regenerate |
| `m` | Change model and regenerate |
| `b` | Branch from this message |
| `f` | Fact-check |
| `w` | Why did the AI say this? |
| `c` | Copy |
| `n` | Save as a note |
| `Alt [` / `Alt ]` | Previous / next sibling |
| `i` or `Enter` | Back to the composer |

### Composer

| Keys | Does |
|---|---|
| `Enter` | Send |
| `Shift Enter` | New line |
| `/` at line start | Slash commands: `/model`, `/branch`, `/compact`, `/factcheck`, `/note`, `/research` |
| `@` | Mention a source, notebook, thread, model or memory file |
| `Mod .` | Stop generating |
| `↑` in an empty composer | Edit your last message |

With **Slash and @ menus** off (Settings → Composer), `/` and `@` are plain text. Typing one says so above the composer, "Slash and @ menus are off, so / and @ are plain text.", with **Turn menus on**; Esc puts the line away for that draft.

Single-key shortcuts never fire while you're typing. Leave the composer with `Esc` to use them. This is the vim-like navigate mode, and the status bar shows `NAV` while it's on.

### Palette prefixes

| Prefix | Searches |
|---|---|
| `>` | Commands |
| `@` | Models |
| `#` | Notebooks |
| `~` | Threads and branches |
| `!` | Memory |
| `?` | Help |

## Interaction patterns

**The mark is a status light.** The shield in the titlebar shows what the AI is doing:

| Shield | State |
|---|---|
| Still, inner ring drifting | Idle |
| Halves breathing, ring turning quickly | Thinking |
| Core beating | Streaming |
| Halves closed in | Waiting for you to approve something |
| Grey | Offline |
| Red, shaking once | Something failed |

**Progress says what's happening.** For example "Extracting tables · page 14 of 52" or "Waking node · loading weights (about 40 s)". There are no bare spinners. Content that's loading shows a skeleton with the family's chalk wipe.

**An agent's steps are cards.** Each tool call is a one-line card: a rule and icon for its kind (a command, an MCP tool, a subagent, or any other tool, never in signal violet), what it did, its seconds while it runs, then how long it took and what came back in one short line (lines read, results found, the first line printed). While an answer is written, "Working now" under it lists every step running, parallel calls too. All the timers on screen tick on one shared clock, and the seconds are never announced to screen readers.

**Confirmation chains** for anything touching infrastructure: Requested → Acknowledged → In progress → Confirmed, each step lit as it's reported, with timestamps and the provider's words.

**Optimistic, with rollback.** Sending, renaming, pinning, archiving, attaching, revoking a grant and editing memory appear instantly. If the server disagrees, the change rolls back with a toast that says why.

**Toasts** appear bottom-right and never block. At most three are shown; the rest go to the notification centre. Undo is offered wherever an action can be reversed.

**Hover actions** on every message: branch, fact-check, cite, edit, copy, regenerate, change model. All of them are also on the keyboard, so nothing is hidden behind a menu.

**Empty states** say what to do, in one sentence with one button. For example: "No sources yet. Drop files here, paste a link, or pull in a past thread."

**You come back to where you left off.** After a reload or a week away, you get the same notebook, thread, branch and draft, and the scroll position is anchored to the message you were reading. Drafts save locally as you type and to the server every 3 seconds.

## Accessibility

- Every control is reachable and operable by keyboard, and focus is always visible (a 2 px signal ring, 3 px with Settings → Accessibility → Focus ring → Thick). Every ring reads `--focus-w` and `--focus-color`, or the `--focus-ring` shadows built from them, so the setting reaches all of them.
- Streaming replies are announced to screen readers a sentence at a time, not a token at a time.
- Status is never colour alone: fact-check underlines carry icons, and health dots carry text.
- Contrast is AA everywhere text goes. Every text token (`--fg` to `--mute-2`, `--placeholder`, `--signal-ink`, `--ok`, `--warn`, `--fail`, `--gilt`) holds 4.5:1 on every ground, on glass, and on a chip of its own colour, in dark and light, in each ground tint, accent, contrast, gilt mode and edition; text on the primary button and the gilt pill does too. `apps/cockpit/test/contrast.test.ts` reads the token CSS and checks every combination, so a token change that breaks it fails the build. Placeholders count as text. `--mute-3` is for rules, dots and gutters only, never text.
- **Motion** (Settings → Accessibility) decides for everything that moves; System follows the OS. It reaches the CSS as `data-motion` on `<html>` and Motion (the animation library) through `MotionPrefs`, so choosing Full keeps motion even if the OS asks for less, and choosing Reduced reduces it even if the OS does not. Reduced removes movement and keeps short fades: transforms, sizes, layout moves, springs and smooth scrolling stop, and CSS keyframe animations (spinners, pulses, shimmers, entrances) end at their last frame, while opacity and colour transitions and Motion's opacity still fade, capped at 120 ms in CSS. Components key their own reduced rules on `data-motion`, never on the media query. JS that moves something asks `useReducedMotion()` from `lib/motion.tsx`, never Motion's hook of the same name (that one reads only the OS).
- **Transparency** on Reduced (or on System while the OS asks for less) makes glass solid and removes the grain. **Effects** (Advanced) does the same while Light, or, on Automatic, while the machine is struggling. When either is in force, Settings says so under Surfaces and Film grain, and links to the setting that did it.
- axe runs in the end-to-end suite on every route, in both themes.

## Layout

```
┌ titlebar ─ mark · NVX Ancile · notebook / thread ·························· Mod K ┐
├ rail ──────┬──────────── thread (72 characters wide, centred) ───────┬ drawer ─────┤
│ flows      │ TL;DR                                                    │ Sources     │
│ automations│ messages, hover actions                                  │ Tree · Why  │
│ notebooks  │ composer                                                 │ Evidence    │
│ threads    │                                                          │             │
├────────────┴──────────────────────────────────────────────────────────┴─────────────┤
└ status ─ model · context 62% · node ready $0.42/h · approvals 1 · health ● · NAV ───┘
```

At tablet width the drawer becomes a sheet and the rail an overlay. Phones work, but they aren't the target.

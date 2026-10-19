/**
 * ------------------------------------------------------------------
 *  Title    |  Layout check
 *  Ref      |  ROADMAP DX2
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Find text that overflows its box without an ellipsis,
 *           |  text boxes that overlap, and pages that scroll
 *           |  sideways, on the main screens, at five window sizes,
 *           |  in both themes.
 *  How      |  With the stack running (pnpm start):
 *           |    node scripts/layout-check.mjs [--quick] [--only=home,models]
 *           |  It loads the Cockpit's root first, then moves between
 *           |  screens inside the app (a fresh profile that deep-links
 *           |  lands on Setup). A thread on the offline echo model is
 *           |  made for the thread screen: no provider is called and
 *           |  nothing is billed. Exits 1 when it finds anything.
 *           |    COCKPIT_URL (default http://localhost:7701)
 *           |    CORE_URL    (default http://localhost:7700)
 *           |    --quick     one size (1366x768), both themes
 *           |    --zoom=1.4  the interface zoom at its largest (Settings →
 *           |                Appearance), to see what larger text does
 *  Note     |  Overlap means two pieces of text whose boxes cross by
 *           |  more than 2px each way. Boxes that are meant to stack
 *           |  (a tooltip over a button) are not text-on-text, so they
 *           |  do not show up; anything that does is worth a look.
 * ------------------------------------------------------------------
 */

import { chromium } from '@playwright/test';

const APP = process.env.COCKPIT_URL ?? 'http://localhost:7701';
const CORE = process.env.CORE_URL ?? 'http://localhost:7700';
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const zoom = args.find((a) => a.startsWith('--zoom='))?.slice(7);
const only = args
  .find((a) => a.startsWith('--only='))
  ?.slice(7)
  .split(',');

const ALL_SIZES = [
  ['1366x768', 1366, 768],
  ['768x1024', 768, 1024],
  ['1024x768', 1024, 768],
  ['1920x1080', 1920, 1080],
  ['3440x1440', 3440, 1440],
];
const SIZES = quick ? ALL_SIZES.slice(0, 1) : ALL_SIZES;

async function api(path, method = 'GET', body) {
  const r = await fetch(`${CORE}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-ancile-client': 'layout-check-0001' },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}

/** A thread on the offline model with one answer, so the receipt has something to show. */
async function makeThread() {
  try {
    const t = await api('/threads', 'POST', {
      title: 'Layout check with a deliberately long title to see how it wraps',
      model: 'offline/echo',
    });
    const id = t.body?.id;
    if (!id) return null;
    await api(`/threads/${id}/turns`, 'POST', {
      text: 'Say hello, then list three colours.',
      model: 'offline/echo',
      idempotency_key: `layout-check-${Date.now()}`,
    });
    await new Promise((r) => setTimeout(r, 3000));
    return id;
  } catch {
    return null;
  }
}

/** Runs in the page. Returns what is wrong with what is on screen right now. */
function inspect() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const out = { hscroll: false, clipped: [], overlaps: [] };
  const doc = document.documentElement;
  out.hscroll = doc.scrollWidth > vw + 1 || document.body.scrollWidth > vw + 1;

  const label = (el) => {
    const cls =
      typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
  };
  const shown = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      if (e.hasAttribute('inert') || e.getAttribute('aria-hidden') === 'true') return false;
    }
    return true;
  };
  // A row that scrolls sideways on purpose (tabs, a code block) may run past the window's edge.
  const inScroller = (el) => {
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (['auto', 'scroll'].includes(cs.overflowX)) return true;
    }
    return false;
  };
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());

  // 1. Text that does not fit its box and says nothing about it.
  for (const el of document.querySelectorAll('body *')) {
    if (!ownText(el) && !el.matches('input, textarea, select, button')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue; // sr-only and collapsed
    if (!shown(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.clip !== 'auto' && cs.clip !== '') continue;
    const clipsX = ['hidden', 'clip'].includes(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
    const clipsY = ['hidden', 'clip'].includes(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    const clamped = cs.webkitLineClamp && cs.webkitLineClamp !== 'none';
    if (clipsX && cs.textOverflow !== 'ellipsis' && !clamped)
      out.clipped.push(
        `${label(el)} cut off sideways: "${el.textContent.trim().slice(0, 48)}" (${el.scrollWidth}px of ${el.clientWidth}px)`,
      );
    else if (clipsY && !clamped && cs.whiteSpace !== 'nowrap' && cs.display !== 'inline')
      out.clipped.push(
        `${label(el)} cut off below: "${el.textContent.trim().slice(0, 48)}" (${el.scrollHeight}px of ${el.clientHeight}px)`,
      );
    // An ellipsis on something that is almost all hidden is also a loss.
    else if (
      cs.textOverflow === 'ellipsis' &&
      el.scrollWidth > el.clientWidth * 2.2 &&
      el.clientWidth < 40 &&
      el.textContent.trim().length > 6
    )
      out.clipped.push(
        `${label(el)} shows only "${el.textContent.trim().slice(0, 6)}..." in ${el.clientWidth}px`,
      );
    // Outside the window on the right (not fixed UI, which is placed deliberately).
    if (r.right > vw + 2 && cs.position !== 'fixed' && !inScroller(el))
      out.clipped.push(`${label(el)} runs off the right edge: "${el.textContent.trim().slice(0, 40)}"`);
  }

  // 2. Text that sits on other text.
  const boxes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent.trim();
    if (!t) continue;
    const el = n.parentElement;
    if (!el || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName) || !shown(el)) continue;
    if (el.closest('.sr-only, [data-sr-only]')) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.width < 3 || r.height < 5) continue;
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
      // Only what is painted counts: cut the box down to every ancestor that clips or scrolls it
      // (an ellipsis keeps the whole string in the range's rects, but paints only the start).
      let left = r.left;
      let right = r.right;
      let top = r.top;
      let bottom = r.bottom;
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        const cs = getComputedStyle(e);
        const clipX = ['hidden', 'clip', 'auto', 'scroll'].includes(cs.overflowX);
        const clipY = ['hidden', 'clip', 'auto', 'scroll'].includes(cs.overflowY);
        if (!clipX && !clipY) continue;
        const b = e.getBoundingClientRect();
        if (clipX) {
          left = Math.max(left, b.left);
          right = Math.min(right, b.right);
        }
        if (clipY) {
          top = Math.max(top, b.top);
          bottom = Math.min(bottom, b.bottom);
        }
      }
      if (right - left < 3 || bottom - top < 5) continue;
      // A toast floats over whatever is there on purpose.
      if (el.closest('.toast, [data-toast], [role="status"]')) continue;
      boxes.push({ el, t, l: left, r: right, tp: top, b: bottom });
    }
  }
  boxes.sort((a, b) => a.l - b.l);
  const seen = new Set();
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const c = boxes[j];
      if (c.l >= a.r - 2) break;
      if (a.el === c.el || a.el.contains(c.el) || c.el.contains(a.el)) continue;
      const w = Math.min(a.r, c.r) - Math.max(a.l, c.l);
      const h = Math.min(a.b, c.b) - Math.max(a.tp, c.tp);
      if (w > 2 && h > 2) {
        const key = `${label(a.el)}|${label(c.el)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.overlaps.push(
          `"${a.t.slice(0, 28)}" (${label(a.el)}) over "${c.t.slice(0, 28)}" (${label(c.el)})`,
        );
      }
    }
  }
  out.clipped = [...new Set(out.clipped)].slice(0, 15);
  out.overlaps = out.overlaps.slice(0, 15);
  return out;
}

const goto = (page, path) =>
  page.evaluate((p) => {
    history.pushState({}, '', p);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);

const settle = (page, ms = 1100) => page.waitForTimeout(ms);

async function main() {
  const threadId = await makeThread();
  const screens = [
    { name: 'home', run: async (p) => goto(p, '/') },
    {
      name: 'thread-receipt',
      skip: !threadId,
      run: async (p) => {
        await goto(p, `/t/${threadId}`);
        await settle(p, 1500);
        const strip = p.locator('.rc-strip').first();
        if (await strip.count()) {
          await strip.click().catch(() => {});
          await settle(p, 700);
        }
      },
    },
    ...[
      [
        'thread-typing',
        'A long message that keeps going so the composer has to wrap it, with a very-long-unbroken-token-' +
          'x'.repeat(60),
      ],
      ['thread-slash', '/'],
      ['thread-mention', '@'],
    ].map(([name, text]) => ({
      name,
      skip: !threadId,
      run: async (p) => {
        await goto(p, `/t/${threadId}`);
        await settle(p, 1500);
        const box = p
          .locator('.composer textarea, .composer [role="textbox"], .composer [contenteditable="true"]')
          .first();
        if (await box.count()) {
          await box.click().catch(() => {});
          await p.keyboard.type(text, { delay: 0 });
          await settle(p, 500);
        }
      },
    })),
    { name: 'admin-models', run: async (p) => goto(p, '/admin/models') },
    { name: 'settings-keys', run: async (p) => goto(p, '/settings/keys') },
    { name: 'flows', run: async (p) => goto(p, '/flows') },
    {
      name: 'palette',
      run: async (p) => {
        await goto(p, '/');
        await settle(p, 600);
        await p.keyboard.press('Control+k');
        await settle(p, 600);
      },
    },
    {
      name: 'trash',
      run: async (p) => {
        await goto(p, '/');
        await settle(p, 600);
        const archive = p.getByRole('button', { name: 'Archive', exact: true }).first();
        if (await archive.count()) await archive.click().catch(() => {});
        const trash = p.getByRole('button', { name: 'Trash', exact: true }).first();
        if (await trash.count()) await trash.click().catch(() => {});
      },
    },
    { name: 'setup', run: async (p) => goto(p, '/setup') },
  ].filter((s) => !only || only.includes(s.name));

  const browser = await chromium.launch();
  const findings = [];
  const notes = [];
  for (const scheme of ['dark', 'light']) {
    for (const [size, width, height] of SIZES) {
      const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
      const page = await ctx.newPage();
      await page.goto(APP, { waitUntil: 'load' });
      await settle(page, 1500);
      if (zoom) await page.evaluate((z) => document.documentElement.style.setProperty('--ui-zoom', z), zoom);
      for (const s of screens) {
        if (s.skip) {
          if (scheme === 'dark' && size === SIZES[0][0])
            notes.push(`skipped ${s.name}: Core did not make a thread`);
          continue;
        }
        try {
          await s.run(page);
          await settle(page);
          const r = await page.evaluate(inspect);
          const where = `${s.name} @ ${size}${zoom ? ` x${zoom}` : ''} ${scheme}`;
          if (r.hscroll) findings.push(`${where}: the page scrolls sideways`);
          for (const c of r.clipped) findings.push(`${where}: ${c}`);
          for (const o of r.overlaps) findings.push(`${where}: overlap ${o}`);
        } catch (e) {
          notes.push(`${s.name} @ ${size} ${scheme}: could not check (${String(e).slice(0, 120)})`);
        }
        // Back to a clean screen for the next one.
        await page.keyboard.press('Escape').catch(() => {});
      }
      await ctx.close();
    }
  }
  await browser.close();

  for (const n of notes) console.log(`note: ${n}`);
  // Group identical findings across sizes so the list reads as problems, not as repeats.
  const grouped = new Map();
  for (const f of findings) {
    const m = /^(\S+) @ (\S+(?: x[\d.]+)?) (dark|light): (.*)$/.exec(f);
    if (!m) continue;
    const key = `${m[1]}: ${m[4]}`;
    const set = grouped.get(key) ?? new Set();
    set.add(`${m[2]} ${m[3]}`);
    grouped.set(key, set);
  }
  for (const [k, v] of grouped) console.log(`${k}\n    at ${[...v].join(', ')}`);
  console.log(
    `\n${grouped.size} problem${grouped.size === 1 ? '' : 's'} across ${screens.length} screens, ${SIZES.length} sizes, 2 themes.`,
  );
  process.exit(grouped.size ? 1 : 0);
}

await main();

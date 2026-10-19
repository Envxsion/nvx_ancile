/**
 * ------------------------------------------------------------------
 *  Title    |  Token guard
 *  Ref      |  ROADMAP D6
 *  ID       |  cockpit
 * ------------------------------------------------------------------
 *  Purpose  |  Fail when a style sheet or a component's inline style
 *           |  brings in a literal font size, corner radius or colour
 *           |  instead of an Aperture token.
 *  How      |  Scans src/**\/*.css and src/**\/*.tsx. Sizes and radii
 *           |  must be var(--t-*) and var(--r-*); colours must come
 *           |  from var(--*) or the --c-black / --c-white channels.
 *  Note     |  The allowlist is for values that are genuinely data:
 *           |  hues the user picks, a CSS example the user may paste,
 *           |  and the standalone documents we export (they cannot see
 *           |  the app's variables). Add to it only with a reason.
 * ------------------------------------------------------------------
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

/** Files whose literals are data, not styling. */
const ALLOW = new Set([
  'routes/settings/groups.tsx', // the accent hues a person can pick
  'setup/MakeItYours.tsx', // the same hues, on first run
  'routes/settings/CustomCss.tsx', // an example of CSS to paste
]);

const RULES: Array<[string, RegExp]> = [
  ['a literal font size (use var(--t-*))', /font-size:\s*[0-9.]+px|fontSize:\s*['"]?[0-9.]+/g],
  ['a literal corner radius (use var(--r-*))', /border-radius:\s*[0-9.]+px|borderRadius:\s*['"]?[0-9.]+/g],
  ['a literal colour (use a token)', /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(\s*[0-9]/g],
];

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(css|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe('design tokens', () => {
  it('has no literal font sizes, radii or colours in styles and inline styles', () => {
    const found: string[] = [];
    for (const file of files(SRC)) {
      const rel = relative(SRC, file).split(sep).join('/');
      if (ALLOW.has(rel)) continue;
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/href=|url\(#|\bid=/.test(line)) return;
        for (const [what, re] of RULES) {
          re.lastIndex = 0;
          const m = re.exec(line);
          if (m) found.push(`${rel}:${i + 1} has ${what}: ${m[0]}`);
        }
      });
    }
    expect(found, `Use the Aperture scale in packages/aperture/src/tokens.css:\n${found.join('\n')}`).toEqual(
      [],
    );
  });
});

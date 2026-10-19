import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { loadMarkdown } from '../src/ui/Markdown';

// The markdown chunk loads on demand in the app; here it is in before any test renders.
await loadMarkdown();

// Vitest runs without globals here, so Testing Library cannot register its
// own auto-cleanup; without this, one test's DOM leaks into the next.
afterEach(() => cleanup());

// jsdom has no matchMedia; the shell asks for it (theme, sheets).
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

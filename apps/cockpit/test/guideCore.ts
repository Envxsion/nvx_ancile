/**
 * The guide's core articles, without waiting for the lazy loader: tests that read one article
 * by id use this. (The guide's own lists fill only after help/lazyGuide.ts has loaded.)
 */
import { CORE_CHAPTERS } from '../src/help/coreGuide';

export const CORE_ARTICLES = CORE_CHAPTERS.flatMap((c) => c.articles);

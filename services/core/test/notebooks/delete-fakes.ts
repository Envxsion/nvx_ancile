/**
 * Fakes for the notebook delete tests: a scope store that finds a thread's notebook the way
 * Postgres does (from the thread itself), so a thread that has left its notebook really has
 * lost it, and the privacy a test checks afterwards is the privacy Core would apply.
 */

import type { MemoryNotebookRepo } from '../../src/notebooks/repo';
import { MemoryScopeStore } from '../../src/scopes';
import type { MemoryThreadRepo } from '../../src/threads/repo';

export class ThreadBackedScopes extends MemoryScopeStore {
  constructor(
    private readonly threadRepo: MemoryThreadRepo,
    private readonly books: MemoryNotebookRepo,
  ) {
    super();
  }

  override async threadNotebook(threadId: string) {
    const t = this.threadRepo.threads.get(threadId);
    return t ? t.notebook_id : undefined;
  }

  override async notebookExists(notebookId: string) {
    return !!(await this.books.get(notebookId));
  }
}

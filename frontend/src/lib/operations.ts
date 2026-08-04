import { uuidv7 } from 'uuidv7';

/**
 * Operation ids and form drafts.
 *
 * Two rules make accidental duplicate inventory movements impossible, and both
 * live here:
 *
 *  1. The operation id is generated when the user *opens* a form, not when they
 *     submit it, and is reused for every retry — including after a page reload
 *     or a browser crash. Generating a fresh id per attempt defeats the server's
 *     duplicate protection entirely.
 *
 *  2. The form's contents are mirrored to localStorage as the user types, so a
 *     failed submission, a dropped connection, or a closed lid never silently
 *     discards what someone typed at the counter.
 *
 * The durable offline queue is a later milestone. This is the minimum that makes
 * the online-only release safe.
 */

/**
 * A new operation id: one intended state-changing action, named before it is
 * attempted.
 *
 * UUIDv7, from the same generator the backend uses for every other id. Never a
 * timestamp, a counter, or a short random string — the id is a primary key in
 * `operations` and has to be unique across every browser in the shop.
 *
 * Call it when an *intent* begins — a form opens, a completed receipt is
 * followed by another — and never per attempt. Every retry of the same intent
 * must carry the id the first attempt carried, which is the whole of what makes
 * a retry safe.
 */
export function newOperationId(): string {
  return uuidv7();
}

const DRAFT_PREFIX = 'ekon.draft.';

export interface Draft<T> {
  operationId: string;
  values: T;
  updatedAt: string;
}

function key(formId: string): string {
  return `${DRAFT_PREFIX}${formId}`;
}

/** Loads an in-progress draft, or starts a new one with a fresh operation id. */
export function loadOrCreateDraft<T>(formId: string, initial: T): Draft<T> {
  try {
    const raw = window.localStorage.getItem(key(formId));
    if (raw) {
      const parsed = JSON.parse(raw) as Draft<T>;
      if (typeof parsed.operationId === 'string' && parsed.operationId.length > 0) {
        return parsed;
      }
    }
  } catch {
    // Corrupt or unavailable storage — fall through to a fresh draft.
  }
  return { operationId: uuidv7(), values: initial, updatedAt: new Date().toISOString() };
}

export function saveDraft<T>(formId: string, draft: Draft<T>): void {
  try {
    window.localStorage.setItem(
      key(formId),
      JSON.stringify({ ...draft, updatedAt: new Date().toISOString() }),
    );
  } catch {
    // Storage full or disabled. The in-memory form still works.
  }
}

/**
 * Clears a draft. Call this only after the server has confirmed the write —
 * clearing on submit would lose the operation id that makes a retry safe.
 */
export function clearDraft(formId: string): void {
  try {
    window.localStorage.removeItem(key(formId));
  } catch {
    // Nothing to do.
  }
}

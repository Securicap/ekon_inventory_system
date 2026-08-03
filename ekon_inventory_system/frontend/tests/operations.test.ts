import { beforeEach, describe, expect, it } from 'vitest';
import { clearDraft, loadOrCreateDraft, saveDraft } from '../src/lib/operations.js';

describe('operation ids and form drafts', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('keeps the same operation id across reloads of the same form', () => {
    // This is the property the server's duplicate protection depends on. If a
    // retry generated a fresh id, an interrupted submission would create a
    // second inventory movement.
    const first = loadOrCreateDraft('receive', { quantity: 0 });
    saveDraft('receive', first);

    const afterReload = loadOrCreateDraft('receive', { quantity: 0 });
    expect(afterReload.operationId).toBe(first.operationId);
  });

  it('preserves what the user typed when a submission fails', () => {
    const draft = loadOrCreateDraft('receive', { quantity: 0 });
    saveDraft('receive', { ...draft, values: { quantity: 12 } });

    expect(loadOrCreateDraft('receive', { quantity: 0 }).values).toEqual({ quantity: 12 });
  });

  it('issues a fresh operation id only after the draft is cleared', () => {
    const first = loadOrCreateDraft('adjust', { quantity: 0 });
    saveDraft('adjust', first);
    clearDraft('adjust');

    expect(loadOrCreateDraft('adjust', { quantity: 0 }).operationId).not.toBe(first.operationId);
  });

  it('gives different forms different operation ids', () => {
    const receive = loadOrCreateDraft('receive', {});
    const adjust = loadOrCreateDraft('adjust', {});
    expect(receive.operationId).not.toBe(adjust.operationId);
  });

  it('recovers from corrupt storage instead of throwing at the counter', () => {
    window.localStorage.setItem('ekon.draft.receive', 'not json');
    const draft = loadOrCreateDraft('receive', { quantity: 0 });
    expect(draft.operationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { apiFailure, deferred, json, type Responder } from '../helpers/fetchMock.js';
import { productFixture } from '../helpers/fixtures.js';
import { CATALOG_ROUTE, openCatalog } from '../helpers/catalog.js';
import { settle } from '../helpers/renderApp.js';

/**
 * Withdrawing merchandise, and bringing it back.
 *
 * Three states in plain words: **Active** is sold and restocked, **Discontinued**
 * is no longer restocked though what is on the shelf still sells and is still
 * counted, and **Archived** is out of daily use and kept for history.
 *
 * The thing being defended here is the sentence before the change. Both of the
 * interesting states are easy to misread — "Discontinued" sounds like *gone*
 * and "Archived" sounds like *deleted*, and neither is either.
 */

const RICE = productFixture({ name: 'Diri' });
const LIFECYCLE_ROUTE = `PATCH /api/catalog/products/${RICE.id}/lifecycle`;

/** Somebody who may read merchandise and withdraw it. */
const DEACTIVATOR = ['catalog.read', 'catalog.deactivate'] as const;

async function openLifecycle(
  product = RICE,
  target = 'ARCHIVED',
  routes: Record<string, Responder | Responder[]> = {},
): Promise<Awaited<ReturnType<typeof openCatalog>>> {
  const api = await openCatalog(
    { [CATALOG_ROUTE]: json([product]), ...routes },
    { capabilities: DEACTIVATOR },
  );
  const control = screen.getByRole('combobox');
  control.focus();
  fireEvent.change(control, { target: { value: target } });
  await screen.findByRole('dialog');
  return api;
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog');
}

function confirm(): void {
  const buttons = within(dialog()).getAllByRole('button');
  fireEvent.click(buttons[buttons.length - 1]!);
}

describe('what the change means', () => {
  it('says what archiving does, rather than what it is called', async () => {
    await openLifecycle(RICE, 'ARCHIVED');

    expect(within(dialog()).getByText(ht['catalog.lifecycleArchivedMeans'])).toBeInTheDocument();
  });

  it('says discontinued merchandise still sells and is still counted', async () => {
    // "Discontinued" sounds like gone. The units on the shelf are still the
    // shop's, and somebody has to be told that before they choose it.
    await openLifecycle(RICE, 'DISCONTINUED');

    expect(
      within(dialog()).getByText(ht['catalog.lifecycleDiscontinuedMeans']),
    ).toBeInTheDocument();
  });

  it('names the merchandise being withdrawn', async () => {
    await openLifecycle(RICE, 'ARCHIVED');

    expect(within(dialog()).getByText('Diri')).toBeInTheDocument();
  });

  it('never says the word that would make archiving a lie', async () => {
    // Archiving keeps the history. A dialog that said "delete" would be
    // promising something the ledger does not do.
    await openLifecycle(RICE, 'ARCHIVED');

    const body = (dialog().textContent ?? '').toLowerCase();
    for (const forbidden of ['efase', 'siprime', 'delete', 'supprimer']) {
      expect(body).not.toContain(forbidden);
    }
  });
});

describe('the transition', () => {
  it('sends the status the catalog owns, and nothing else', async () => {
    const api = await openLifecycle(RICE, 'ARCHIVED', {
      [LIFECYCLE_ROUTE]: json({ ...RICE, lifecycleStatus: 'ARCHIVED' }),
    });

    confirm();
    await settle();

    const body = api.to(LIFECYCLE_ROUTE)[0]?.body as Record<string, unknown>;
    expect(body).toEqual({ lifecycleStatus: 'ARCHIVED' });
  });

  it('re-reads the catalog and the current-stock list', async () => {
    // Archived merchandise leaves the stock list and discontinued merchandise
    // stops being offered for receiving. Both are the server's decision, so
    // both reads are invalidated rather than filtered here.
    const api = await openLifecycle(RICE, 'ARCHIVED', {
      [LIFECYCLE_ROUTE]: json({ ...RICE, lifecycleStatus: 'ARCHIVED' }),
    });

    const catalogBefore = api.to(CATALOG_ROUTE).length;

    confirm();
    await settle();

    expect(api.to(CATALOG_ROUTE).length).toBeGreaterThan(catalogBefore);
  });

  it('closes once the change is made', async () => {
    await openLifecycle(RICE, 'DISCONTINUED', {
      [LIFECYCLE_ROUTE]: json({ ...RICE, lifecycleStatus: 'DISCONTINUED' }),
    });

    confirm();
    await settle();

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not send twice while the change is in flight', async () => {
    const pending = deferred();
    const api = await openLifecycle(RICE, 'ARCHIVED', { [LIFECYCLE_ROUTE]: pending.responder });

    confirm();
    await settle();
    confirm();
    await settle();

    expect(api.to(LIFECYCLE_ROUTE)).toHaveLength(1);
    pending.resolve(json({ ...RICE, lifecycleStatus: 'ARCHIVED' }));
    await settle();
  });
});

describe('when the server refuses to archive', () => {
  it('shows the refusal as the business answer it is', async () => {
    // Six are still on a shelf. That is not a failure, it is the shop's own
    // state, and it is shown as one.
    await openLifecycle(RICE, 'ARCHIVED', {
      [LIFECYCLE_ROUTE]: apiFailure('CONFLICT', 409),
    });

    confirm();
    await settle();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog()).getAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('says stock remains, not that the merchandise is closed', async () => {
    // A bare `CONFLICT` means "pick again from a fresh list" on receiving and
    // removal, and that sentence is wrong here: nothing is closed, there are
    // units on a shelf. Asserting the alert exists is not enough — the previous
    // version of this screen showed the wrong one and passed.
    await openLifecycle(RICE, 'ARCHIVED', {
      [LIFECYCLE_ROUTE]: apiFailure('CONFLICT', 409),
    });

    confirm();
    await settle();

    expect(within(dialog()).getByText(ht['catalog.archiveBlockedByStock'])).toBeInTheDocument();
    expect(within(dialog()).queryByText(ht['error.resourceInactive'])).toBeNull();
  });

  it('leaves the other transitions to the shared notice', async () => {
    // Only archiving is refused for remaining stock. Restoring cannot be, so
    // the stock sentence would be a confident lie about why it failed.
    await openLifecycle(RICE, 'DISCONTINUED', {
      [LIFECYCLE_ROUTE]: apiFailure('CONFLICT', 409),
    });

    confirm();
    await settle();

    expect(within(dialog()).queryByText(ht['catalog.archiveBlockedByStock'])).toBeNull();
    expect(within(dialog()).getAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('offers no way to write the remaining stock off from here', async () => {
    // A lifecycle screen posting an inventory movement is the one thing a
    // lifecycle change must never do. The remedy is to sell or correct the
    // stock somewhere that says so.
    await openLifecycle(RICE, 'ARCHIVED', {
      [LIFECYCLE_ROUTE]: apiFailure('CONFLICT', 409),
    });

    confirm();
    await settle();

    const body = dialog();
    expect(within(body).queryByRole('button', { name: ht['stock.actionAdjust'] })).toBeNull();
    expect(within(body).queryByRole('button', { name: ht['nav.remove'] })).toBeNull();
    expect(within(body).queryByLabelText(ht['adjust.quantity'])).toBeNull();
  });
});

describe('the dialog itself', () => {
  it('closes on Escape without changing anything', async () => {
    const api = await openLifecycle(RICE, 'ARCHIVED');

    fireEvent.keyDown(dialog(), { key: 'Escape' });
    await settle();

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.to(LIFECYCLE_ROUTE)).toHaveLength(0);
  });

  it('forgets a refusal when it is opened again', async () => {
    // A stale error under a fresh decision would read as a refusal of the
    // decision nobody has taken yet.
    await openLifecycle(RICE, 'ARCHIVED', { [LIFECYCLE_ROUTE]: apiFailure('CONFLICT', 409) });

    confirm();
    await settle();
    expect(within(dialog()).getAllByRole('alert').length).toBeGreaterThan(0);

    fireEvent.click(within(dialog()).getByRole('button', { name: ht['action.cancel'] }));
    await settle();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'DISCONTINUED' } });
    await screen.findByRole('dialog');
    expect(within(dialog()).queryAllByRole('alert')).toHaveLength(0);
  });
});

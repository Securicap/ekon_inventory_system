import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { json } from '../helpers/fetchMock.js';
import { countFixture, page } from '../helpers/fixtures.js';
import { ALL_COUNTS_ROUTE, COUNTER, OPEN_COUNTS_ROUTE, openCounts } from '../helpers/counts.js';
import { settle } from '../helpers/renderApp.js';

/**
 * Reviewing what has been counted.
 *
 * The list is evidence, and the tests that matter most here are the ones that
 * keep it evidence: the three numbers are the server's permanent record of a
 * moment, and nothing on this screen may recompute them against today's shelf.
 */

const SHORT = countFixture({ expectedQuantity: 7, countedQuantity: 6 });

const MATCH = countFixture({
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c12',
  expectedQuantity: 4,
  countedQuantity: 4,
  variant: { productName: 'Lwil', sku: 'EKN-Z9Y8X7W6' },
});

const SETTLED = countFixture({
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c13',
  expectedQuantity: 9,
  countedQuantity: 11,
  variant: { productName: 'Siwo', sku: 'EKN-QR90ST12' },
  reconciliation: { reason: 'MISSED_RECEIPT', note: 'Yon bwat ki pa t antre' },
});

function row(productName: string): HTMLElement {
  const name = screen.getByText(productName);
  return name.closest('li') as HTMLElement;
}

describe('what a count record says', () => {
  it('shows expected, counted and the difference, as the server stored them', async () => {
    await openCounts({ [OPEN_COUNTS_ROUTE]: json(page([SHORT])) });

    const record = row('Diri');
    expect(within(record).getByText(ht['counts.expected'])).toBeInTheDocument();
    expect(within(record).getByText('7')).toBeInTheDocument();
    expect(within(record).getByText('6')).toBeInTheDocument();
    expect(within(record).getByText('−1')).toBeInTheDocument();
  });

  it('shows the variance the record carries, not one recomputed from anything', async () => {
    // A count taken last Tuesday says what it said last Tuesday even though the
    // shelf has moved since. The fixture's own arithmetic is the only source.
    await openCounts({ [OPEN_COUNTS_ROUTE]: json(page([SETTLED])) }, { capabilities: COUNTER });

    expect(within(row('Siwo')).getByText('+2')).toBeInTheDocument();
  });

  it('names the item, the shelf and who walked it', async () => {
    await openCounts({ [OPEN_COUNTS_ROUTE]: json(page([SHORT])) });

    const record = row('Diri');
    expect(within(record).getByText(/EKN-AB12CD34/)).toBeInTheDocument();
    expect(within(record).getByText(/Main Store/)).toBeInTheDocument();
    expect(within(record).getByText(/Marie Joseph/)).toBeInTheDocument();
  });

  it('shows no identifier a person cannot use', async () => {
    // A count id and a variant id are the system's business. Somebody reading a
    // discrepancy needs the product, the shelf and the numbers.
    await openCounts({ [OPEN_COUNTS_ROUTE]: json(page([SHORT])) });

    expect(screen.queryByText(SHORT.id)).toBeNull();
    expect(screen.queryByText(SHORT.variant.id)).toBeNull();
    expect(screen.queryByText(SHORT.location.id)).toBeNull();
  });

  it('marks each state by its name, never by colour alone', async () => {
    await openCounts({ [ALL_COUNTS_ROUTE]: json(page([SHORT, MATCH, SETTLED])) });
    fireEvent.click(screen.getByLabelText(ht['counts.filterAll'], { selector: 'input' }));
    await settle();

    expect(within(row('Diri')).getByText(ht['counts.statusOpen'])).toBeInTheDocument();
    expect(within(row('Lwil')).getByText(ht['counts.statusMatched'])).toBeInTheDocument();
    expect(within(row('Siwo')).getByText(ht['counts.statusReconciled'])).toBeInTheDocument();
  });

  it('says what a settled difference was concluded to be, and by whom', async () => {
    // Without that, "Reconciled" is a state with no story behind it — and the
    // story is the entire reason the reason code exists.
    await openCounts({ [OPEN_COUNTS_ROUTE]: json(page([SETTLED])) });

    const record = row('Siwo');
    expect(within(record).getByText(ht['reason.missedReceipt'])).toBeInTheDocument();
    expect(within(record).getByText('Jean Baptiste')).toBeInTheDocument();
    expect(within(record).getByText('Yon bwat ki pa t antre')).toBeInTheDocument();
  });
});

describe('which counts are shown', () => {
  it('opens on what still needs somebody to look at it', async () => {
    // The question the screen exists to answer.
    const { api } = await openCounts({ [OPEN_COUNTS_ROUTE]: json(page([SHORT])) });

    expect(api.to(OPEN_COUNTS_ROUTE).length).toBeGreaterThan(0);
    expect(screen.getByText('Diri')).toBeInTheDocument();
  });

  it('switches to every count, and asks a different question of the server', async () => {
    // Two different questions are two different answers, and they must not
    // share a cache entry — which is why the filters are part of the query key.
    const { api } = await openCounts({
      [OPEN_COUNTS_ROUTE]: json(page([SHORT])),
      [ALL_COUNTS_ROUTE]: json(page([SHORT, MATCH])),
    });

    fireEvent.click(screen.getByLabelText(ht['counts.filterAll'], { selector: 'input' }));
    await settle();

    expect(api.to(ALL_COUNTS_ROUTE).length).toBeGreaterThan(0);
    expect(screen.getByText('Lwil')).toBeInTheDocument();
  });

  it('says nothing needs review rather than showing an empty box', async () => {
    await openCounts({ [OPEN_COUNTS_ROUTE]: json(page([])) });

    expect(screen.getByText(ht['counts.noneOpen'])).toBeInTheDocument();
  });

  it('says something different when no shelf has been walked at all', async () => {
    // "Nothing to review" and "nothing has been counted" are different facts,
    // and a shop that has never counted needs to be told the second one.
    await openCounts({
      [OPEN_COUNTS_ROUTE]: json(page([])),
      [ALL_COUNTS_ROUTE]: json(page([])),
    });

    fireEvent.click(screen.getByLabelText(ht['counts.filterAll'], { selector: 'input' }));
    await settle();

    expect(screen.getByText(ht['counts.none'])).toBeInTheDocument();
  });
});

describe('what each capability opens', () => {
  it('lets a reader see the evidence and change nothing', async () => {
    // Seeing what has been counted is inventory visibility; walking a shelf and
    // settling a difference are a separate trust.
    await openCounts({ [OPEN_COUNTS_ROUTE]: json(page([SHORT])) });

    expect(screen.getByText('Diri')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: ht['counts.recordTitle'] })).toBeNull();
    expect(screen.queryByRole('button', { name: ht['counts.reconcile'] })).toBeNull();
  });

  it('offers both halves of the workflow to somebody who may count', async () => {
    await openCounts({ [OPEN_COUNTS_ROUTE]: json(page([SHORT])) }, { capabilities: COUNTER });

    expect(screen.getByRole('heading', { name: ht['counts.recordTitle'] })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ht['counts.reconcile'] })).toBeInTheDocument();
  });

  it('offers no way to settle a count that is already settled', async () => {
    await openCounts(
      { [OPEN_COUNTS_ROUTE]: json(page([MATCH, SETTLED])) },
      { capabilities: COUNTER },
    );

    expect(screen.queryByRole('button', { name: ht['counts.reconcile'] })).toBeNull();
  });
});

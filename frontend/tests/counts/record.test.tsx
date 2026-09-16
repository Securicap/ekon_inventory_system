import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { apiFailure, deferred, json, offline } from '../helpers/fetchMock.js';
import { balanceFixture, countFixture, page } from '../helpers/fixtures.js';
import {
  ALL_COUNTS_ROUTE,
  BALANCES_ROUTE,
  COUNTER,
  OPEN_COUNTS_ROUTE,
  RECORD_COUNT_ROUTE,
  fillCount,
  openCounts,
  recordedCounts,
  submitCount,
} from '../helpers/counts.js';
import { settle } from '../helpers/renderApp.js';

/**
 * Recording what is physically on the shelf.
 *
 * > **A count observes. Investigation explains. Reconciliation changes stock.**
 *
 * The first clause is what this file is about, and most of these tests are
 * there to keep the form from quietly acquiring the other two.
 */

describe('what the form says before anybody types', () => {
  it('says out loud that this does not change stock', async () => {
    // Every other inventory screen a person has used *does* change it. Saying
    // so once, above the fields, is what makes the rest of the workflow make
    // sense — and it is a sentence, not a tooltip.
    await openCounts({}, { capabilities: COUNTER });

    expect(screen.getByText(ht['counts.recordExplains'])).toBeInTheDocument();
  });

  it('does not show what Ekon expects', async () => {
    // Not blind counting — that is a post-OR1 workflow with locking and second
    // counts. But a number beside the box you are about to type in is an
    // invitation to agree with it, and the discrepancy that would have told the
    // shop something disappears. The balance read is on this screen for the
    // item list; the expected figure must not leak out of it.
    await openCounts(
      { [BALANCES_ROUTE]: json([balanceFixture({ locations: [{ quantity: 7 }] })]) },
      { capabilities: COUNTER },
    );

    const form = screen.getByRole('heading', { name: ht['counts.recordTitle'] }).closest('section');
    expect(within(form as HTMLElement).queryByText(ht['counts.expected'])).toBeNull();
    expect(within(form as HTMLElement).queryByText('7')).toBeNull();
  });

  it('says an empty shelf is a real answer', async () => {
    // The count that matters most is the one somebody skips because the form
    // looks like it wants a positive number.
    await openCounts({}, { capabilities: COUNTER });

    expect(screen.getByText(ht['counts.countedHint'])).toBeInTheDocument();
  });

  it('asks when the shelf was walked, not when the form was filled in', async () => {
    await openCounts({}, { capabilities: COUNTER });

    expect(screen.getByLabelText(ht['counts.countedAt'])).toBeInTheDocument();
    expect(screen.getByText(ht['counts.countedAtHint'])).toBeInTheDocument();
  });
});

describe('recording an observation', () => {
  it('sends what was seen, and never an expected quantity', async () => {
    // A browser that could supply the expected quantity could manufacture any
    // variance it liked. The shared request schema refuses the field; this
    // proves the form does not try.
    const { api } = await openCounts(
      { [RECORD_COUNT_ROUTE]: json(countFixture({ countedQuantity: 6 })) },
      { capabilities: COUNTER },
    );

    fillCount({ counted: '6' });
    submitCount();
    await settle();

    const [body] = recordedCounts(api);
    expect(body).toMatchObject({ countedQuantity: 6 });
    expect(body).not.toHaveProperty('expectedQuantity');
    expect(body).not.toHaveProperty('variance');
  });

  it('records zero', async () => {
    const { api } = await openCounts(
      {
        [RECORD_COUNT_ROUTE]: json(countFixture({ expectedQuantity: 7, countedQuantity: 0 })),
      },
      { capabilities: COUNTER },
    );

    fillCount({ counted: '0' });
    submitCount();
    await settle();

    expect(recordedCounts(api)[0]).toMatchObject({ countedQuantity: 0 });
  });

  it('refuses an empty quantity, which is not the same as zero', async () => {
    const { api } = await openCounts({}, { capabilities: COUNTER });

    fillCount({ counted: '' });
    submitCount();
    await settle();

    expect(screen.getByText(ht['counts.quantityRequired'])).toBeInTheDocument();
    expect(api.to(RECORD_COUNT_ROUTE)).toHaveLength(0);
  });

  it('refuses a negative count and a fractional one', async () => {
    const { api } = await openCounts({}, { capabilities: COUNTER });

    fillCount({ counted: '-1' });
    submitCount();
    await settle();
    expect(screen.getByText(ht['counts.quantityInvalid'])).toBeInTheDocument();

    fillCount({ counted: '2.5' });
    submitCount();
    await settle();
    expect(screen.getByText(ht['counts.quantityInvalid'])).toBeInTheDocument();

    expect(api.to(RECORD_COUNT_ROUTE)).toHaveLength(0);
  });

  it('asks for the item and the shelf before it sends anything', async () => {
    const { api } = await openCounts({}, { capabilities: COUNTER });

    fireEvent.change(screen.getByLabelText(ht['counts.counted']), { target: { value: '6' } });
    submitCount();
    await settle();

    expect(screen.getByText(ht['counts.itemRequired'])).toBeInTheDocument();
    expect(screen.getByText(ht['counts.locationRequired'])).toBeInTheDocument();
    expect(api.to(RECORD_COUNT_ROUTE)).toHaveLength(0);
  });
});

describe('the comparison, afterwards', () => {
  it('shows expected, counted and the difference once the server has answered', async () => {
    // This is the only place the expected quantity can honestly come from: the
    // server reads it inside the recording transaction.
    await openCounts(
      {
        [RECORD_COUNT_ROUTE]: json(countFixture({ expectedQuantity: 7, countedQuantity: 6 })),
      },
      { capabilities: COUNTER },
    );

    fillCount({ counted: '6' });
    submitCount();
    await settle();

    const outcome = screen.getByRole('status');
    expect(within(outcome).getByText(ht['counts.expected'])).toBeInTheDocument();
    expect(within(outcome).getByText('7')).toBeInTheDocument();
    expect(within(outcome).getByText('6')).toBeInTheDocument();
    // A real minus sign, and the sign is the point.
    expect(within(outcome).getByText('−1')).toBeInTheDocument();
    expect(within(outcome).getByText(ht['counts.needsReview'])).toBeInTheDocument();
  });

  it('calls a match a match, and asks nobody to do anything about it', async () => {
    await openCounts(
      {
        [RECORD_COUNT_ROUTE]: json(countFixture({ expectedQuantity: 7, countedQuantity: 7 })),
      },
      { capabilities: COUNTER },
    );

    fillCount({ counted: '7' });
    submitCount();
    await settle();

    const outcome = screen.getByRole('status');
    expect(within(outcome).getByText(ht['counts.statusMatched'])).toBeInTheDocument();
    expect(within(outcome).queryByRole('button', { name: ht['counts.reconcile'] })).toBeNull();
  });

  it('offers no way to fix a difference from the outcome panel', async () => {
    // Accepting a difference is a decision taken against the list below, with a
    // reason attached. Offering it here — one press after typing the number —
    // would turn "I counted six" into "make it six", which is the whole thing
    // the workflow separates.
    await openCounts(
      { [RECORD_COUNT_ROUTE]: json(countFixture({ expectedQuantity: 7, countedQuantity: 6 })) },
      { capabilities: COUNTER },
    );

    fillCount({ counted: '6' });
    submitCount();
    await settle();

    const outcome = screen.getByRole('status');
    expect(within(outcome).queryByRole('button', { name: ht['counts.reconcile'] })).toBeNull();
  });
});

describe('the operation id', () => {
  it('does not change when the same observation is submitted again', async () => {
    // The retry invariant, which is the whole of idempotency from the client's
    // side: a fresh id per click would make a duplicate out of every retry.
    const { api } = await openCounts(
      { [RECORD_COUNT_ROUTE]: [apiFailure('INTERNAL', 500), json(countFixture())] },
      { capabilities: COUNTER },
    );

    fillCount({ counted: '6' });
    submitCount();
    await settle();
    submitCount();
    await settle();

    const bodies = recordedCounts(api);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.operationId).toBe(bodies[1]!.operationId);
  });

  it('keeps the id across a dead network too', async () => {
    const { api } = await openCounts(
      { [RECORD_COUNT_ROUTE]: [offline(), json(countFixture())] },
      { capabilities: COUNTER },
    );

    fillCount({ counted: '6' });
    submitCount();
    await settle();
    submitCount();
    await settle();

    const bodies = recordedCounts(api);
    expect(bodies[0]!.operationId).toBe(bodies[1]!.operationId);
  });

  it('takes a new id for the next shelf', async () => {
    // The observation just recorded is settled; the next one is a different
    // fact and must not be deduplicated against it.
    const { api } = await openCounts(
      { [RECORD_COUNT_ROUTE]: json(countFixture()) },
      { capabilities: COUNTER },
    );

    fillCount({ counted: '6' });
    submitCount();
    await settle();

    fillCount({ counted: '4' });
    submitCount();
    await settle();

    const bodies = recordedCounts(api);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.operationId).not.toBe(bodies[1]!.operationId);
  });

  it('does not send twice while the first request is still open', async () => {
    const pending = deferred();
    const { api } = await openCounts(
      { [RECORD_COUNT_ROUTE]: pending.responder },
      { capabilities: COUNTER },
    );

    fillCount({ counted: '6' });
    submitCount();
    await settle();
    submitCount();
    await settle();

    expect(api.to(RECORD_COUNT_ROUTE)).toHaveLength(1);
    pending.resolve(json(countFixture()));
    await settle();
  });
});

describe('what a recorded count invalidates', () => {
  it('refreshes the count feed and nothing else', async () => {
    // The invalidation rule the whole workflow rests on. Recording a count
    // posts no movement and moves no stock, so re-reading the balances would be
    // this screen implying something changed on the shelf.
    const { api } = await openCounts(
      { [RECORD_COUNT_ROUTE]: json(countFixture()) },
      { capabilities: COUNTER },
    );

    const balancesBefore = api.to(BALANCES_ROUTE).length;
    const countsBefore = api.to(OPEN_COUNTS_ROUTE).length + api.to(ALL_COUNTS_ROUTE).length;

    fillCount({ counted: '6' });
    submitCount();
    await settle();

    expect(api.to(OPEN_COUNTS_ROUTE).length + api.to(ALL_COUNTS_ROUTE).length).toBeGreaterThan(
      countsBefore,
    );
    expect(api.to(BALANCES_ROUTE)).toHaveLength(balancesBefore);
    expect(
      api.requests.filter((request) => request.url.startsWith('/api/inventory/movements')),
    ).toHaveLength(0);
  });
});

describe('when the shelf list is empty', () => {
  it('does not offer a count of nothing', async () => {
    // A fresh installation with no merchandise. A submit button over two empty
    // selects is a button that can only fail.
    await openCounts({ [BALANCES_ROUTE]: json([]) }, { capabilities: COUNTER });

    expect(screen.getByRole('button', { name: ht['counts.record'] })).toBeDisabled();
  });
});

describe('failure', () => {
  it('says what the server said rather than something went wrong', async () => {
    await openCounts({ [RECORD_COUNT_ROUTE]: json(page([])) }, { capabilities: COUNTER });
    // The route above answers a count page, which is not a count record — the
    // parse fails, and the screen has to say something honest about it.
    fillCount({ counted: '6' });
    submitCount();
    await settle();

    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });
});

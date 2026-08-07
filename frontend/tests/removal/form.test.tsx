import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MAX_MOVEMENT_QUANTITY } from '@ekon/shared';
import ht from '../../src/i18n/ht.json';
import { translate } from '../../src/i18n/index.js';
import { json } from '../helpers/fetchMock.js';
import { balanceFixture } from '../helpers/fixtures.js';
import { settle } from '../helpers/renderApp.js';
import {
  fillRemovalForm,
  fillValidRemoval,
  locationSelect,
  occurredAtInput,
  openRemoval,
  options,
  quantityInput,
  reasonSelect,
  removalResponse,
  removeRequests,
  submitRemovalForm,
  variantSelect,
  BALANCES_ROUTE,
  OIL,
  REMOVE_ROUTE,
  RICE,
} from '../helpers/removal.js';

/**
 * The form an employee fills in to record that stock left: what it offers, what
 * it refuses, and what it puts on the wire.
 *
 * The question this screen exists to answer is *which shelf am I taking from,
 * and how many are there now?* — so the choices carry their quantities, the
 * chosen shelf says its number out loud, and a shelf that cannot satisfy any
 * removal is visible without being selectable. None of that is a promise: the
 * numbers are the last balance read, and the server decides.
 */

describe('where the choices come from', () => {
  it('reads the balances, and nothing else', async () => {
    const { api } = await openRemoval();

    expect(api.to(BALANCES_ROUTE)).toHaveLength(1);
    // The balance response already carries the product name, the SKU, the
    // attributes, and every active location with its quantity — which is the
    // whole question. Reading the catalog and the location list as well would
    // be two more requests on a bad connection and three chances for the
    // pieces to disagree about which shelf holds what.
    expect(api.to('GET /api/catalog/products')).toHaveLength(0);
    expect(api.to('GET /api/inventory/locations')).toHaveLength(0);
  });

  it('shares the stock screen cache rather than reading the same answer twice', async () => {
    const { api, queryClient } = await openRemoval();

    expect(queryClient.getQueryData(['inventory', 'balances'])).toBeDefined();

    // Walking to Stock asks the server nothing new: the answer is already
    // cached under the key both screens use.
    fireEvent.click(screen.getByRole('button', { name: ht['nav.stock'] }));
    await screen.findByRole('heading', { name: ht['stock.title'] });
    await settle();

    expect(api.to(BALANCES_ROUTE)).toHaveLength(1);
  });
});

describe('choosing an item', () => {
  it('names it the way somebody holding the box would recognize it', async () => {
    await openRemoval();

    const labels = options(variantSelect()).map((option) => option.label);
    expect(labels[1]).toContain('Diri');
    expect(labels[1]).toContain('gwosè: 5 mamit');
    expect(labels[1]).toContain('EKN-AB12CD34');
  });

  it('shows how much there is, so the list answers the question', async () => {
    await openRemoval();
    // Rice holds 10 + 4; oil holds 3.
    expect(options(variantSelect())[1]?.label).toContain('14');
    expect(options(variantSelect())[2]?.label).toContain('3');
  });

  it('shows no database identifier', async () => {
    await openRemoval();
    const page = document.body.textContent ?? '';
    for (const id of [RICE.variantId, RICE.productId, OIL.variantId, OIL.productId]) {
      expect(page).not.toContain(id);
    }
  });

  it('keeps an item with no stock visible, and refuses it as a choice', async () => {
    // Dropping it would make a shop that is out of rice look like a shop that
    // never sold rice — and the employee still needs to see that it is at zero.
    const empty = balanceFixture({
      productId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a03',
      productName: 'Sik',
      sku: 'EKN-11223344',
      locations: [{ locationName: 'Main Store', isDefault: true, quantity: 0 }],
    });
    await openRemoval({ [BALANCES_ROUTE]: json([RICE, empty]) });

    const sugar = options(variantSelect()).find((option) => option.label.includes('Sik'));
    expect(sugar).toBeDefined();
    expect(sugar?.disabled).toBe(true);
    expect(options(variantSelect()).find((option) => option.label.includes('Diri'))?.disabled).toBe(
      false,
    );
  });

  it('says so when the whole shop has nothing to remove', async () => {
    const empty = balanceFixture({ locations: [{ quantity: 0 }] });
    await openRemoval({ [BALANCES_ROUTE]: json([empty]) });

    expect(screen.getByText(ht['removal.noStock'])).toBeInTheDocument();
    // Not an error, and not an empty dropdown with no explanation.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so when there is no active product at all', async () => {
    await openRemoval({ [BALANCES_ROUTE]: json([]) });
    expect(screen.getByText(ht['stock.noVariants'])).toBeInTheDocument();
    expect(screen.queryByText(ht['removal.noStock'])).toBeNull();
  });

  it('says so when the business has no active location', async () => {
    await openRemoval({ [BALANCES_ROUTE]: json([balanceFixture({ locations: [] })]) });
    expect(screen.getByText(ht['removal.noLocations'])).toBeInTheDocument();
  });
});

describe('choosing a shelf', () => {
  it('offers only the shelves the chosen item sits on', async () => {
    await openRemoval();
    fillRemovalForm({ variantId: OIL.variantId });

    const names = options(locationSelect())
      .slice(1)
      .map((option) => option.label);
    expect(names).toHaveLength(1);
    expect(names[0]).toContain('Main Store');
  });

  it('shows what each shelf holds', async () => {
    await openRemoval();
    fillRemovalForm({ variantId: RICE.variantId });

    const labels = options(locationSelect())
      .slice(1)
      .map((option) => option.label);
    expect(labels[0]).toBe('Main Store — 10');
    expect(labels[1]).toBe('Backroom — 4');
  });

  it('keeps an empty shelf visible and refuses it as a choice', async () => {
    // An employee who cannot see that the Main Store is at zero will go and
    // look for stock that is in the back.
    const split = balanceFixture({
      productName: 'Diri',
      locations: [
        { locationName: 'Main Store', isDefault: true, quantity: 0 },
        { locationName: 'Backroom', isDefault: false, quantity: 6 },
      ],
    });
    await openRemoval({ [BALANCES_ROUTE]: json([split]) });
    fillRemovalForm({ variantId: split.variantId });

    const shelves = options(locationSelect()).slice(1);
    expect(shelves[0]?.label).toBe('Main Store — 0');
    expect(shelves[0]?.disabled).toBe(true);
    expect(shelves[1]?.disabled).toBe(false);
  });

  it('starts on the default shelf when it holds something', async () => {
    await openRemoval();
    fillRemovalForm({ variantId: RICE.variantId });
    expect(locationSelect().value).toBe(RICE.locations[0]!.locationId);
  });

  it('never starts on a default shelf holding nothing', async () => {
    // The one plausible-looking wrong answer: the form would open on a shelf
    // that cannot satisfy any quantity.
    const split = balanceFixture({
      locations: [
        { locationName: 'Main Store', isDefault: true, quantity: 0 },
        { locationName: 'Backroom', isDefault: false, quantity: 6 },
      ],
    });
    await openRemoval({ [BALANCES_ROUTE]: json([split]) });
    fillRemovalForm({ variantId: split.variantId });

    // The only shelf with stock, so it is chosen — but not the empty default.
    expect(locationSelect().value).toBe(split.locations[1]!.locationId);
  });

  it('chooses nothing when several shelves could be meant', async () => {
    const spread = balanceFixture({
      locations: [
        { locationName: 'Main Store', isDefault: false, quantity: 2 },
        { locationName: 'Backroom', isDefault: false, quantity: 6 },
      ],
    });
    await openRemoval({ [BALANCES_ROUTE]: json([spread]) });
    fillRemovalForm({ variantId: spread.variantId });

    expect(locationSelect().value).toBe('');
  });

  it('re-answers the shelf question when the item changes', async () => {
    await openRemoval();
    fillRemovalForm({ variantId: RICE.variantId });
    expect(locationSelect().value).toBe(RICE.locations[0]!.locationId);

    fillRemovalForm({ variantId: OIL.variantId });
    expect(locationSelect().value).toBe(OIL.locations[0]!.locationId);

    fillRemovalForm({ variantId: '' });
    expect(locationSelect().value).toBe('');
  });
});

describe('what the chosen shelf holds', () => {
  it('says the number in a sentence, once a shelf is chosen', async () => {
    await openRemoval();
    expect(
      screen.queryByText(ht['removal.currentQuantity'].replace('{quantity}', '10')),
    ).toBeNull();

    fillRemovalForm({ variantId: RICE.variantId });
    expect(
      screen.getByText(ht['removal.currentQuantity'].replace('{quantity}', '10')),
    ).toBeInTheDocument();
  });

  it('follows the shelf', async () => {
    await openRemoval();
    fillRemovalForm({ variantId: RICE.variantId, locationId: RICE.locations[1]!.locationId });
    expect(
      screen.getByText(ht['removal.currentQuantity'].replace('{quantity}', '4')),
    ).toBeInTheDocument();
  });

  it('describes the quantity field, so the limit is read with the input', async () => {
    await openRemoval();
    fillRemovalForm({ variantId: RICE.variantId });

    expect(quantityInput().getAttribute('aria-describedby')).toContain('removal-current-quantity');
    expect(quantityInput().max).toBe('10');
  });
});

describe('what the form refuses before it sends anything', () => {
  async function rejects(field: HTMLElement, messageKey: keyof typeof ht): Promise<void> {
    submitRemovalForm();
    expect(
      await screen.findByText(translate('ht', messageKey, { max: MAX_MOVEMENT_QUANTITY })),
    ).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
  }

  it('refuses a removal with no item', async () => {
    const { api } = await openRemoval();
    await rejects(variantSelect(), 'removal.variantRequired');
    expect(api.to(REMOVE_ROUTE)).toHaveLength(0);
  });

  it('refuses a removal with no shelf', async () => {
    const spread = balanceFixture({
      locations: [
        { locationName: 'Main Store', isDefault: false, quantity: 2 },
        { locationName: 'Backroom', isDefault: false, quantity: 6 },
      ],
    });
    const { api } = await openRemoval({ [BALANCES_ROUTE]: json([spread]) });
    fillRemovalForm({ variantId: spread.variantId, quantity: '1', reason: 'SOLD' });

    await rejects(locationSelect(), 'removal.locationRequired');
    expect(api.to(REMOVE_ROUTE)).toHaveLength(0);
  });

  it.each([
    ['missing', '   ', 'removal.quantityRequired'],
    ['zero', '0', 'removal.quantityInvalid'],
    ['negative', '-2', 'removal.quantityInvalid'],
    ['fractional', '1.5', 'removal.quantityInvalid'],
    ['unstorable', '2147483648', 'removal.quantityTooLarge'],
  ] as const)('refuses a %s quantity', async (_label, quantity, messageKey) => {
    const { api } = await openRemoval();
    fillValidRemoval({ quantity });
    await rejects(quantityInput(), messageKey);
    expect(api.to(REMOVE_ROUTE)).toHaveLength(0);
  });

  it('refuses more than the shelf is showing', async () => {
    // Usability, not authority: the number can be stale by the time a request
    // lands, which is why a `422` is still a state this screen renders.
    const { api } = await openRemoval();
    fillValidRemoval({ quantity: '11' });
    submitRemovalForm();

    expect(
      await screen.findByText(ht['removal.quantityExceedsStock'].replace('{quantity}', '10')),
    ).toBeInTheDocument();
    expect(api.to(REMOVE_ROUTE)).toHaveLength(0);
    // Never clamped, never silently reduced, and never answered by choosing a
    // different shelf.
    expect(quantityInput().value).toBe('11');
    expect(locationSelect().value).toBe(RICE.locations[0]!.locationId);
  });

  it('accepts exactly what the shelf is showing', async () => {
    const { api } = await openRemoval({
      [REMOVE_ROUTE]: json(removalResponse({ quantityAfter: 0 }), 201),
    });
    fillValidRemoval({ quantity: '10' });
    submitRemovalForm();

    await screen.findByRole('status');
    expect(api.to(REMOVE_ROUTE)).toHaveLength(1);
  });

  it('refuses a removal with no reason', async () => {
    const { api } = await openRemoval();
    fillValidRemoval({ reason: '' });
    await rejects(reasonSelect(), 'removal.reasonRequired');
    expect(api.to(REMOVE_ROUTE)).toHaveLength(0);
  });

  it('refuses a missing time', async () => {
    const { api } = await openRemoval();
    fillValidRemoval();
    fillRemovalForm({ occurredAtLocal: '' });
    submitRemovalForm();

    expect(await screen.findByText(ht['removal.occurredAtRequired'])).toBeInTheDocument();
    expect(api.to(REMOVE_ROUTE)).toHaveLength(0);
  });

  it('refuses a date that does not exist', async () => {
    // 31 February is refused before it reaches the server, whichever way the
    // browser hands it over: a `datetime-local` control that sanitizes an
    // impossible date leaves the field empty, and one that does not is caught
    // by `localDateTimeToIso`. The conversion itself is tested directly in
    // `tests/businessTime.test.ts`.
    const { api } = await openRemoval();
    fillValidRemoval();
    fillRemovalForm({ occurredAtLocal: '2026-02-31T10:00' });
    submitRemovalForm();

    await screen.findByRole('button', { name: ht['removal.submit'] });
    expect(occurredAtInput()).toHaveAttribute('aria-invalid', 'true');
    expect(occurredAtInput().getAttribute('aria-describedby')).toBe('removal-occurred-at-error');
    expect(api.to(REMOVE_ROUTE)).toHaveLength(0);
  });

  it('moves the keyboard to the first field that needs attention', async () => {
    await openRemoval();
    fillRemovalForm({ quantity: '3', reason: 'SOLD' });
    submitRemovalForm();
    expect(variantSelect()).toHaveFocus();
  });

  it('cannot be submitted at all when nothing is removable', async () => {
    await openRemoval({
      [BALANCES_ROUTE]: json([balanceFixture({ locations: [{ quantity: 0 }] })]),
    });
    expect(screen.getByRole('button', { name: ht['removal.submit'] })).toBeDisabled();
  });
});

describe('what goes on the wire', () => {
  it('sends exactly the six fields the command consists of', async () => {
    const { api } = await openRemoval({ [REMOVE_ROUTE]: json(removalResponse(), 201) });
    fillValidRemoval({ quantity: '3' });
    submitRemovalForm();
    await screen.findByRole('status');

    const [body] = removeRequests(api);
    expect(Object.keys(body!).sort()).toEqual([
      'locationId',
      'occurredAt',
      'operationId',
      'quantity',
      'reason',
      'variantId',
    ]);
    expect(body).toMatchObject({
      variantId: RICE.variantId,
      locationId: RICE.locations[0]!.locationId,
      quantity: 3,
      reason: 'SOLD',
    });
  });

  it('sends a positive quantity, and never a delta', async () => {
    // Direction belongs to the server's workflow. A browser that sent its own
    // sign could add stock through an endpoint whose capability says `remove`.
    const { api } = await openRemoval({ [REMOVE_ROUTE]: json(removalResponse(), 201) });
    fillValidRemoval({ quantity: '3' });
    submitRemovalForm();
    await screen.findByRole('status');

    const [body] = removeRequests(api);
    expect(body?.quantity).toBe(3);
    expect(body).not.toHaveProperty('quantityDelta');
  });

  it('sends nothing the server owns', async () => {
    const { api } = await openRemoval({ [REMOVE_ROUTE]: json(removalResponse(), 201) });
    fillValidRemoval();
    submitRemovalForm();
    await screen.findByRole('status');

    const [body] = removeRequests(api);
    for (const field of [
      'userId',
      'movementId',
      'movementType',
      'quantityDelta',
      'recordedAt',
      'quantityBefore',
      'quantityAfter',
      'previousMovementId',
      'requestHash',
      'operationType',
      'reasonCode',
      'note',
    ]) {
      expect(body, field).not.toHaveProperty(field);
    }
  });

  it('carries the session the way every other request does', async () => {
    const { api } = await openRemoval({ [REMOVE_ROUTE]: json(removalResponse(), 201) });
    fillValidRemoval();
    submitRemovalForm();
    await screen.findByRole('status');

    const request = api.to(REMOVE_ROUTE)[0]!;
    expect(request.credentials).toBe('same-origin');
    expect(request.url).toBe('/api/inventory/remove');
    expect(Object.keys(request.headers)).not.toContain('authorization');
  });

  it('states the business time as an instant', async () => {
    const { api } = await openRemoval({ [REMOVE_ROUTE]: json(removalResponse(), 201) });
    fillValidRemoval();
    submitRemovalForm();
    await screen.findByRole('status');

    // The control holds local time; the wire carries the instant it names.
    expect(removeRequests(api)[0]?.occurredAt).toBe(new Date('2026-08-06T14:30').toISOString());
  });
});

describe('the reason a unit left', () => {
  it.each([
    ['removal.reasonSold', 'SOLD'],
    ['removal.reasonDamaged', 'DAMAGED'],
    ['removal.reasonInternalUse', 'INTERNAL_USE'],
    ['removal.reasonOther', 'OTHER'],
  ] as const)('sends %s as the stable code %s', async (labelKey, code) => {
    const { api } = await openRemoval({ [REMOVE_ROUTE]: json(removalResponse(), 201) });
    fillValidRemoval({ reason: code });

    // Read while the form is still on screen: the words are translated, and the
    // value behind them is the code a permanent ledger stores.
    expect(options(reasonSelect()).find((option) => option.value === code)?.label).toBe(
      ht[labelKey],
    );

    submitRemovalForm();
    await screen.findByRole('status');
    expect(removeRequests(api)[0]?.reason).toBe(code);
  });

  it('shows no raw code to the person choosing', async () => {
    await openRemoval();
    const labels = options(reasonSelect()).map((option) => option.label);
    for (const code of ['SOLD', 'DAMAGED', 'INTERNAL_USE', 'OTHER']) {
      expect(labels.join(' ')).not.toContain(code);
    }
  });

  it('offers every reason the server accepts, and nothing else', async () => {
    await openRemoval();
    expect(
      options(reasonSelect())
        .slice(1)
        .map((option) => option.value),
    ).toEqual(['SOLD', 'DAMAGED', 'INTERNAL_USE', 'OTHER']);
  });
});

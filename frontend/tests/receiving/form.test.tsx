import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { apiFailure, json, mockApi } from '../helpers/fetchMock.js';
import {
  locationFixture,
  productFixture,
  userFixture,
  userResponse,
  variantIdOf,
} from '../helpers/fixtures.js';
import {
  fillReceivingForm,
  locationSelect,
  occurredAtInput,
  openReceiving,
  quantityInput,
  receiptResponse,
  receiveRequests,
  submitButton,
  submitReceivingForm,
  variantSelect,
  RECEIVE_ROUTE,
} from '../helpers/receiving.js';
import { renderApp, settle } from '../helpers/renderApp.js';

/**
 * The receiving form: what it offers, what it refuses, and what it puts on the
 * wire.
 *
 * Everything here is about the delivery somebody is holding. The choices are
 * the ones they can actually act on — an item the shop still sells, a counter
 * that is still open — and the request carries the business event and nothing
 * the server owns.
 */

const RICE = productFixture({ name: 'Diri', sku: 'EKN-AB12CD34' });
const OIL = productFixture({
  id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02',
  name: 'Lwil',
  sku: 'EKN-EF56GH78',
  attributes: [
    { name: 'gwosè', value: '5 mamit' },
    { name: 'mak', value: 'Tchako' },
  ],
});

describe('loading the choices', () => {
  it('reads the catalog and the locations over an authenticated same-origin request', async () => {
    const api = await openReceiving();

    for (const route of ['GET /api/catalog/products', 'GET /api/inventory/locations']) {
      const [request] = api.to(route);
      expect(request, route).toBeDefined();
      expect(request?.credentials).toBe('same-origin');
    }
  });

  it('shows a loading state while they are in flight', async () => {
    // Rendered without awaiting the screen, so the first paint is observable.
    mockApi({
      'GET /api/auth/me': json(userResponse(userFixture({ capabilities: ['inventory.receive'] }))),
    });
    renderApp();
    await screen.findByText('Marie Joseph');

    fireEvent.click(screen.getByRole('button', { name: ht['nav.receive'] }));

    expect(await screen.findByText(ht['status.loading'])).toBeInTheDocument();
  });

  it('shows a failure instead of an empty form', async () => {
    await openReceiving({ 'GET /api/catalog/products': apiFailure('FORBIDDEN', 403) });
    expect(await screen.findByRole('alert')).toHaveTextContent(ht['error.forbidden']);
  });

  it('offers only active products and active variants', async () => {
    await openReceiving({
      'GET /api/catalog/products': json([
        RICE,
        productFixture({
          id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a03',
          name: 'Pwodwi retire',
          sku: 'EKN-RETIRED1',
          lifecycleStatus: 'DISCONTINUED',
        }),
        productFixture({
          id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a04',
          name: 'Varyant fèmen',
          sku: 'EKN-CLOSED01',
          variantLifecycleStatus: 'ARCHIVED',
        }),
      ]),
    });

    const options = [...variantSelect().options].map((option) => option.textContent);
    expect(options).toEqual([ht['receiving.choose'], expect.stringContaining('Diri')]);
    expect(options.join(' ')).not.toContain('Pwodwi retire');
    expect(options.join(' ')).not.toContain('Varyant fèmen');
  });

  it('offers only active locations', async () => {
    await openReceiving({
      'GET /api/inventory/locations': json([
        locationFixture({ name: 'Main Store' }),
        locationFixture({
          id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b02',
          name: 'Depo fèmen',
          isDefault: false,
          isActive: false,
        }),
      ]),
    });

    const options = [...locationSelect().options].map((option) => option.textContent);
    expect(options).toEqual([ht['receiving.choose'], 'Main Store']);
  });

  it('starts on the default location', async () => {
    const backroom = locationFixture({
      id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b03',
      name: 'Depo',
      isDefault: false,
    });
    const main = locationFixture({ name: 'Main Store', isDefault: true });

    await openReceiving({ 'GET /api/inventory/locations': json([backroom, main]) });

    expect(locationSelect().value).toBe(main.id);
  });

  it('starts on the only active location when there is no default', async () => {
    const only = locationFixture({ name: 'Sèl kote a', isDefault: false });
    await openReceiving({ 'GET /api/inventory/locations': json([only]) });
    expect(locationSelect().value).toBe(only.id);
  });

  it('makes somebody choose when several locations could be meant', async () => {
    // Guessing here would be a guess the person has to notice and undo, and the
    // one they would not notice is the one that puts stock in the wrong place.
    await openReceiving({
      'GET /api/inventory/locations': json([
        locationFixture({ name: 'Boutik', isDefault: false }),
        locationFixture({
          id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b04',
          name: 'Depo',
          isDefault: false,
        }),
      ]),
    });

    expect(locationSelect().value).toBe('');
  });

  it('says so, and refuses to submit, when nothing can be received', async () => {
    await openReceiving({
      'GET /api/catalog/products': json([productFixture({ lifecycleStatus: 'DISCONTINUED' })]),
    });

    expect(await screen.findByText(ht['receiving.noVariants'])).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it('says so, and refuses to submit, when no location is open', async () => {
    await openReceiving({
      'GET /api/inventory/locations': json([locationFixture({ isActive: false })]),
    });

    expect(await screen.findByText(ht['receiving.noLocations'])).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });
});

describe('naming a variant', () => {
  it('reads as the product, its attributes, and the SKU on the shelf label', async () => {
    await openReceiving({ 'GET /api/catalog/products': json([OIL]) });

    expect(
      screen.getByRole('option', { name: 'Lwil — gwosè: 5 mamit, mak: Tchako — EKN-EF56GH78' }),
    ).toBeInTheDocument();
  });

  it('stays understandable for a product with no attributes', async () => {
    await openReceiving({ 'GET /api/catalog/products': json([RICE]) });
    expect(screen.getByRole('option', { name: 'Diri — EKN-AB12CD34' })).toBeInTheDocument();
  });

  it('shows nothing that identifies a database row', async () => {
    await openReceiving({ 'GET /api/catalog/products': json([RICE, OIL]) });

    const options = [...variantSelect().options]
      .map((option) => option.textContent ?? '')
      .join(' ');
    expect(options).not.toContain('signature');
    expect(options).not.toContain(RICE.id);
    expect(options).not.toContain(variantIdOf(RICE));
    expect(options).not.toContain('2026-08-02');
  });
});

describe('what the form refuses to send', () => {
  async function rejects(values: Parameters<typeof fillReceivingForm>[0]): Promise<void> {
    const api = await openReceiving();
    fillReceivingForm({
      variantId: variantIdOf(RICE),
      quantity: '5',
      occurredAtLocal: '2026-08-04T14:30',
      ...values,
    });
    submitReceivingForm();
    await settle();
    expect(api.to(RECEIVE_ROUTE)).toHaveLength(0);
  }

  it('refuses a receipt with no item chosen', async () => {
    await rejects({ variantId: '' });
    expect(screen.getByText(ht['receiving.variantRequired'])).toBeInTheDocument();
  });

  it('refuses a receipt with no location chosen', async () => {
    await rejects({ locationId: '' });
    expect(screen.getByText(ht['receiving.locationRequired'])).toBeInTheDocument();
  });

  it('refuses a missing quantity', async () => {
    await rejects({ quantity: '' });
    expect(screen.getByText(ht['receiving.quantityRequired'])).toBeInTheDocument();
  });

  it.each([
    ['zero', '0'],
    ['negative', '-3'],
    ['fractional', '2.5'],
  ])('refuses a %s quantity', async (_label, quantity) => {
    await rejects({ quantity });
    expect(screen.getByText(ht['receiving.quantityInvalid'])).toBeInTheDocument();
  });

  it('refuses a quantity the ledger could not store', async () => {
    await rejects({ quantity: '2147483648' });
    expect(screen.getByText(/2147483647/)).toBeInTheDocument();
  });

  it('refuses a missing arrival time', async () => {
    await rejects({ occurredAtLocal: '' });
    expect(screen.getByText(ht['receiving.occurredAtRequired'])).toBeInTheDocument();
  });

  it('refuses a date that does not exist', async () => {
    // 31 February is refused before it reaches the server, whichever way the
    // browser hands it over: a `datetime-local` control that sanitizes an
    // impossible date leaves the field empty, and one that does not is caught
    // by `localDateTimeToIso` — `new Date('2026-02-31T10:00')` rolls forward to
    // 3 March rather than failing, so a typo would otherwise be sent as a real
    // and wrong business time. The conversion itself is tested directly in
    // `tests/receiving.test.ts`.
    await rejects({ occurredAtLocal: '2026-02-31T10:00' });

    expect(occurredAtInput()).toHaveAttribute('aria-invalid', 'true');
    expect(occurredAtInput().getAttribute('aria-describedby')).toBe('receiving-occurred-at-error');
  });

  it('marks the field it refused, and puts the cursor on it', async () => {
    await rejects({ quantity: '0' });

    expect(quantityInput()).toHaveAttribute('aria-invalid', 'true');
    expect(quantityInput()).toHaveFocus();
    expect(quantityInput().getAttribute('aria-describedby')).toBe('receiving-quantity-error');
  });
});

describe('what the form does send', () => {
  it('sends the business event, and only the business event', async () => {
    const api = await openReceiving({ [RECEIVE_ROUTE]: json(receiptResponse(), 201) });

    fillReceivingForm({
      variantId: variantIdOf(RICE),
      quantity: '12',
      occurredAtLocal: '2026-08-04T14:30',
    });
    submitReceivingForm();
    await screen.findByRole('status');

    const [body] = receiveRequests(api);
    expect(Object.keys(body!).sort()).toEqual([
      'locationId',
      'occurredAt',
      'operationId',
      'quantity',
      'variantId',
    ]);
    expect(body).toMatchObject({
      variantId: variantIdOf(RICE),
      locationId: locationFixture().id,
      quantity: 12,
    });
  });

  it('never sends anything the server owns', async () => {
    // Who received it, which movement it becomes, what the ledger held before
    // and after, when the server recorded it, what the request hashes to —
    // every one of those is the server's, and the browser must not be able to
    // state any of them even by accident.
    const api = await openReceiving({ [RECEIVE_ROUTE]: json(receiptResponse(), 201) });

    fillReceivingForm({
      variantId: variantIdOf(RICE),
      quantity: '3',
      occurredAtLocal: '2026-08-04T14:30',
    });
    submitReceivingForm();
    await screen.findByRole('status');

    const [body] = receiveRequests(api);
    for (const forbidden of [
      'userId',
      'movementId',
      'movementType',
      'quantityDelta',
      'recordedAt',
      'quantityBefore',
      'quantityAfter',
      'previousMovementId',
      'requestHash',
    ]) {
      expect(body, forbidden).not.toHaveProperty(forbidden);
    }

    // Nor under another name in a header. The session cookie is the actor.
    const headers = Object.keys(api.to(RECEIVE_ROUTE)[0]!.headers).map((name) =>
      name.toLowerCase(),
    );
    expect(headers.some((name) => /user|actor|device|machine|terminal/.test(name))).toBe(false);
  });

  it('sends the quantity as a number, not as the string the input held', async () => {
    const api = await openReceiving({ [RECEIVE_ROUTE]: json(receiptResponse(), 201) });

    fillReceivingForm({
      variantId: variantIdOf(RICE),
      quantity: '7',
      occurredAtLocal: '2026-08-04T14:30',
    });
    submitReceivingForm();
    await screen.findByRole('status');

    expect(receiveRequests(api)[0]?.quantity).toBe(7);
  });
});

describe('the arrival time', () => {
  it('starts at the current local time', async () => {
    await openReceiving();

    // The control's own format, in the browser's zone — not a UTC string, which
    // would show somebody in Haiti a delivery arriving four hours from now.
    expect(occurredAtInput().value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it('is sent as the instant that local time refers to', async () => {
    const api = await openReceiving({ [RECEIVE_ROUTE]: json(receiptResponse(), 201) });

    const localValue = '2026-08-04T14:30';
    fillReceivingForm({
      variantId: variantIdOf(RICE),
      quantity: '4',
      occurredAtLocal: localValue,
    });
    submitReceivingForm();
    await screen.findByRole('status');

    // Expected through the same Date semantics the browser uses, so the test
    // holds in any time zone rather than encoding the developer's.
    expect(receiveRequests(api)[0]?.occurredAt).toBe(new Date(localValue).toISOString());
  });

  it('accepts a time in the future, because a fast shop clock is not an error', async () => {
    const api = await openReceiving({ [RECEIVE_ROUTE]: json(receiptResponse(), 201) });

    fillReceivingForm({
      variantId: variantIdOf(RICE),
      quantity: '1',
      occurredAtLocal: '2099-01-01T09:00',
    });
    submitReceivingForm();

    await screen.findByRole('status');
    expect(receiveRequests(api)).toHaveLength(1);
  });
});

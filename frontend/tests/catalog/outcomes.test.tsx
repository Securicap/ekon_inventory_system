import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Capability } from '@ekon/shared';
import ht from '../../src/i18n/ht.json';
import { catalogProductsQueryKey } from '../../src/lib/catalogQueries.js';
import { apiFailure, json, mockApi, offline } from '../helpers/fetchMock.js';
import { locationFixture, productFixture, userFixture, userResponse } from '../helpers/fixtures.js';
import {
  CATALOG_ROUTE,
  CREATE_PRODUCT_ROUTE,
  createdProduct,
  createProductRequests,
  fillNewProductForm,
  openNewProduct,
  submitNewProductForm,
} from '../helpers/catalog.js';
import { renderApp, settle } from '../helpers/renderApp.js';

/**
 * What happens after the button is pressed — which, for a route with no
 * idempotency contract, is the part that matters.
 *
 * A confirmed `201` is a product that exists: the list must say so, and so must
 * receiving, because an item nobody can select is an item the shop cannot book
 * in. A refusal is the server telling us something true and nothing was
 * written. An answer that never arrived is neither, and is the one case where
 * pressing again could quietly make two products — so it is said as uncertainty
 * and nothing is re-sent on anybody's behalf.
 */

const RICE = createdProduct({ name: 'Diri', sku: 'EKN-AB12CD34' });

describe('a confirmed creation', () => {
  it('names the product and the SKU the server chose', async () => {
    await openNewProduct({ [CREATE_PRODUCT_ROUTE]: json(RICE, 201) });

    fillNewProductForm({ name: 'Diri' });
    submitNewProductForm();

    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent('Diri');
    // The SKU is the one identifier printed on a shelf label, and only the
    // server could have chosen it.
    expect(confirmation).toHaveTextContent('EKN-AB12CD34');
  });

  it('closes the form, so a confirmation cannot be mistaken for a second draft', async () => {
    await openNewProduct({ [CREATE_PRODUCT_ROUTE]: json(RICE, 201) });

    fillNewProductForm({ name: 'Diri' });
    submitNewProductForm();
    await screen.findByRole('status');

    expect(screen.queryByRole('heading', { name: ht['catalog.newProductTitle'] })).toBeNull();
    expect(screen.getByRole('button', { name: ht['catalog.newProduct'] })).toBeInTheDocument();
  });

  it('marks the catalog as no longer current', async () => {
    const api = await openNewProduct({
      [CATALOG_ROUTE]: [json([]), json([RICE])],
      [CREATE_PRODUCT_ROUTE]: json(RICE, 201),
    });

    fillNewProductForm({ name: 'Diri' });
    submitNewProductForm();
    await screen.findByRole('status');
    await settle();

    // The behaviour an owner experiences: the product they just created is in
    // the list under the form, without a page reload.
    expect(await screen.findByText('Diri')).toBeInTheDocument();
    expect(api.to(CATALOG_ROUTE)).toHaveLength(2);
  });

  it('stays a confirmed creation whatever the refetch does afterwards', async () => {
    // The product exists the moment the server answers 201. A list read that
    // fails afterwards is the list's problem to render, and must never turn a
    // created product into "did that work?".
    await openNewProduct({
      [CATALOG_ROUTE]: [json([]), apiFailure('INTERNAL', 500)],
      [CREATE_PRODUCT_ROUTE]: json(RICE, 201),
    });

    fillNewProductForm({ name: 'Diri' });
    submitNewProductForm();
    await screen.findByRole('status');
    await settle();

    expect(screen.getByRole('status')).toHaveTextContent('Diri');
  });
});

/**
 * The handoff the whole workflow exists for.
 *
 * A product that cannot be received is a product the shop has no use for, so
 * this walks the two screens in the order somebody actually would: create the
 * item, then go and book in what arrived. Nothing here reaches past the
 * application — receiving reads the catalog through the same key the creation
 * invalidated, which is the whole mechanism.
 */
describe('a newly created product reaches receiving', () => {
  const CAPABILITIES: readonly Capability[] = [
    'catalog.read',
    'catalog.write',
    'inventory.receive',
  ];

  it('is offered as something to receive, without a reload', async () => {
    const api = mockApi({
      'GET /api/auth/me': json(userResponse(userFixture({ capabilities: CAPABILITIES }))),
      // Empty at first — a fresh installation — and holding the new product
      // from the moment the creation invalidated it.
      [CATALOG_ROUTE]: [json([]), json([RICE])],
      'GET /api/inventory/locations': json([locationFixture()]),
      [CREATE_PRODUCT_ROUTE]: json(RICE, 201),
    });

    renderApp();
    await screen.findByText('Marie Joseph');

    // Receiving first, so its catalog read is genuinely in the cache and stale
    // data would really be shown.
    fireEvent.click(screen.getByRole('button', { name: ht['nav.receive'] }));
    await screen.findByRole('heading', { name: ht['receiving.title'] });
    await settle();

    fireEvent.click(screen.getByRole('button', { name: ht['nav.products'] }));
    await screen.findByRole('heading', { name: ht['catalog.title'] });
    fireEvent.click(screen.getByRole('button', { name: ht['catalog.newProduct'] }));
    await screen.findByRole('heading', { name: ht['catalog.newProductTitle'] });

    fillNewProductForm({ name: 'Diri' });
    submitNewProductForm();
    await screen.findByRole('status');
    await settle();

    fireEvent.click(screen.getByRole('button', { name: ht['nav.receive'] }));
    const variants = (await screen.findByLabelText(ht['receiving.variant'])) as HTMLSelectElement;

    // The variant the server created, selectable by the label the shop reads.
    expect([...variants.options].map((option) => option.textContent)).toContain(
      'Diri — EKN-AB12CD34',
    );
    expect(api.to(CATALOG_ROUTE)).toHaveLength(2);
  });
});

describe('a refusal', () => {
  it('renders a 403 in place and leaves the person signed in', async () => {
    // Capabilities can change between a screen rendering and a request being
    // made. The remedy is to ask the owner, not to sign in again.
    await openNewProduct({ [CREATE_PRODUCT_ROUTE]: apiFailure('FORBIDDEN', 403, 'req-forbidden') });

    fillNewProductForm();
    submitNewProductForm();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ht['error.forbidden']);
    expect(alert).toHaveTextContent('req-forbidden');

    // Still signed in, still on the screen, and not asked for a password.
    expect(screen.getByText('Marie Joseph')).toBeInTheDocument();
    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.queryByLabelText(ht['auth.password'])).toBeNull();
    expect(screen.queryByText(ht['error.sessionExpired'])).toBeNull();
  });

  it('does not resend a 403 by itself', async () => {
    const api = await openNewProduct({ [CREATE_PRODUCT_ROUTE]: apiFailure('FORBIDDEN', 403) });

    fillNewProductForm();
    submitNewProductForm();
    await screen.findByRole('alert');
    await settle();

    expect(api.to(CREATE_PRODUCT_ROUTE)).toHaveLength(1);
  });

  it('keeps what was typed, so a refusal costs nothing but a correction', async () => {
    await openNewProduct({ [CREATE_PRODUCT_ROUTE]: apiFailure('CONFLICT', 409) });

    fillNewProductForm({ name: 'Diri' });
    submitNewProductForm();
    await screen.findByRole('alert');

    expect(screen.getByLabelText(ht['catalog.productName'])).toHaveValue('Diri');
  });

  it('says what a 409 actually means here', async () => {
    // Not "start again with a fresh list", which is what CONFLICT means on the
    // inventory screens. Here it is one thing: those attributes are taken.
    await openNewProduct({ [CREATE_PRODUCT_ROUTE]: apiFailure('CONFLICT', 409) });

    fillNewProductForm();
    submitNewProductForm();

    expect(await screen.findByRole('alert')).toHaveTextContent(ht['catalog.variantExists']);
  });

  it('follows the global behaviour for a 401', async () => {
    // A mutation is a protected request like any other: a 401 means the session
    // ended, and the application says so once and shows the login screen.
    await openNewProduct({ [CREATE_PRODUCT_ROUTE]: apiFailure('UNAUTHENTICATED', 401) });

    fillNewProductForm();
    submitNewProductForm();

    expect(await screen.findByLabelText(ht['auth.username'])).toBeInTheDocument();
    expect(screen.getByText(ht['error.sessionExpired'])).toBeInTheDocument();
    expect(screen.queryByText('Marie Joseph')).toBeNull();
  });
});

describe('an answer that never arrived', () => {
  it('does not send the creation again by itself when the connection drops', async () => {
    // The invariant this whole screen is built around. There is no operation id
    // on this route and no uniqueness on a product name, so an automatic retry
    // would be an automatic duplicate.
    const api = await openNewProduct({ [CREATE_PRODUCT_ROUTE]: offline() });

    fillNewProductForm();
    submitNewProductForm();
    await screen.findByRole('alert');
    await settle();

    expect(api.to(CREATE_PRODUCT_ROUTE)).toHaveLength(1);
  });

  it('does not send it again by itself on a 5xx either', async () => {
    const api = await openNewProduct({ [CREATE_PRODUCT_ROUTE]: apiFailure('INTERNAL', 500) });

    fillNewProductForm();
    submitNewProductForm();
    await screen.findByRole('alert');
    await settle();

    expect(api.to(CREATE_PRODUCT_ROUTE)).toHaveLength(1);
  });

  it('says it does not know, rather than that it failed', async () => {
    await openNewProduct({ [CREATE_PRODUCT_ROUTE]: offline() });

    fillNewProductForm();
    submitNewProductForm();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ht['catalog.uncertain']);
    // And it does not claim success.
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('offers the list, which is where the answer actually is', async () => {
    const api = await openNewProduct({
      [CATALOG_ROUTE]: [json([]), json([RICE])],
      [CREATE_PRODUCT_ROUTE]: apiFailure('INTERNAL', 500),
    });

    fillNewProductForm({ name: 'Diri' });
    submitNewProductForm();
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: ht['catalog.checkList'] }));
    await settle();

    // A fresh read, and nothing sent a second time.
    expect(await screen.findByText('Diri')).toBeInTheDocument();
    expect(api.to(CATALOG_ROUTE)).toHaveLength(2);
    expect(api.to(CREATE_PRODUCT_ROUTE)).toHaveLength(1);
    expect(createProductRequests(api)).toHaveLength(1);
  });
});

describe('a refusal leaves the catalog cache alone', () => {
  it('does not invalidate the list', async () => {
    // Nothing was written, so re-reading the list would spend a request on a
    // connection that drops to learn nothing.
    const api = mockApi({
      'GET /api/auth/me': json(
        userResponse(userFixture({ capabilities: ['catalog.read', 'catalog.write'] })),
      ),
      [CATALOG_ROUTE]: json([productFixture()]),
      [CREATE_PRODUCT_ROUTE]: apiFailure('FORBIDDEN', 403),
    });

    const { queryClient } = renderApp();
    await screen.findByText('Marie Joseph');
    fireEvent.click(screen.getByRole('button', { name: ht['nav.products'] }));
    await screen.findByRole('heading', { name: ht['catalog.title'] });
    fireEvent.click(screen.getByRole('button', { name: ht['catalog.newProduct'] }));
    await screen.findByRole('heading', { name: ht['catalog.newProductTitle'] });

    fillNewProductForm();
    submitNewProductForm();
    await screen.findByRole('alert');
    await settle();

    expect(queryClient.getQueryState(catalogProductsQueryKey)?.isInvalidated).toBe(false);
    expect(api.to(CATALOG_ROUTE)).toHaveLength(1);
  });
});

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createProductRequestSchema, PRODUCT_NAME_MAX_LENGTH } from '@ekon/shared';
import ht from '../../src/i18n/ht.json';
import { deferred, json } from '../helpers/fetchMock.js';
import {
  addAttribute,
  addVariant,
  fillMoney,
  createdProduct,
  createProductRequests,
  CREATE_PRODUCT_ROUTE,
  fillNewProductForm,
  openNewProduct,
  submitButton,
  submitNewProductForm,
} from '../helpers/catalog.js';
import { settle } from '../helpers/renderApp.js';

/**
 * Creating a product, from the browser.
 *
 * The form is the smallest thing that makes the workflow usable without
 * somebody typing curl at a shop counter, so what is tested is the workflow:
 * exactly the contract's fields go out, nothing the server owns can be sent,
 * and an impatient second press does not make a second product.
 */

const CREATED = json(createdProduct(), 201);

describe('what the form sends', () => {
  it('sends exactly the shape the shared contract defines', async () => {
    const api = await openNewProduct({ [CREATE_PRODUCT_ROUTE]: CREATED });

    fillNewProductForm({ name: 'Diri' });
    submitNewProductForm();
    await screen.findByRole('status');

    const [sent, ...extras] = createProductRequests(api);
    expect(extras).toHaveLength(0);
    // The simplest product in a shop: a name, and one variant with nothing on
    // it — which the contract calls the default variant.
    expect(sent).toEqual({
      name: 'Diri',
      classifications: {},
      variants: [{ attributes: {}, barcodes: [] }],
    });
    // And it is a body the shared schema itself accepts, not merely one that
    // looks right: this is the same parse the route performs on arrival.
    expect(createProductRequestSchema.safeParse(sent).success).toBe(true);
  });

  it('sends the attribute name from the vocabulary and the value as typed', async () => {
    // The name comes from `GET /api/catalog/metadata` — it is structure, and
    // the catalog refuses one it has never heard of. The *value* is free
    // display text, sent exactly as typed: the catalog normalizes it on
    // arrival, and doing that here as well would be the browser deciding
    // something the server is the authority on.
    const api = await openNewProduct({ [CREATE_PRODUCT_ROUTE]: CREATED });

    fillNewProductForm({ name: 'Diri' });
    addAttribute(0, { name: 'size', value: '5 mamit' });
    submitNewProductForm();
    await screen.findByRole('status');

    expect(createProductRequests(api)[0]).toEqual({
      name: 'Diri',
      classifications: {},
      variants: [{ attributes: { size: '5 mamit' }, barcodes: [] }],
    });
  });

  it('offers only attribute names the catalog has defined, and no way to type one', async () => {
    // The rule this form exists to keep: a shop that could invent `colour`
    // beside `color` could never report on either again, and the server would
    // refuse the request anyway. So the control is a list, and what it lists is
    // what the catalog defined.
    await openNewProduct();
    fireEvent.click(screen.getByRole('button', { name: ht['catalog.addAttribute'] }));

    const names = screen.getByLabelText(ht['catalog.attributeName']);
    expect(names.tagName).toBe('SELECT');
    expect([...(names as HTMLSelectElement).options].map((option) => option.value)).toEqual([
      '',
      'color',
      'size',
      'width',
    ]);
  });

  it('sends a brand, a classification, a price and a barcode when they are given', async () => {
    const api = await openNewProduct({ [CREATE_PRODUCT_ROUTE]: CREATED });

    fillNewProductForm({ name: 'Bel Ami' });
    fireEvent.change(screen.getByLabelText(ht['catalog.brand']), {
      target: { value: 'Steve Madden' },
    });
    fireEvent.change(screen.getByLabelText('Audience'), { target: { value: 'Fanm' } });
    addAttribute(0, { name: 'color', value: 'Nwa' });
    fillMoney('price', { amount: '7500.50', currency: 'htg' });
    fireEvent.click(screen.getByRole('button', { name: ht['catalog.addBarcode'] }));
    fireEvent.change(screen.getByLabelText(ht['catalog.barcode']), {
      target: { value: '0123456789012' },
    });
    submitNewProductForm();
    await screen.findByRole('status');

    expect(createProductRequests(api)[0]).toEqual({
      name: 'Bel Ami',
      brand: 'Steve Madden',
      classifications: { audience: 'Fanm' },
      variants: [
        {
          attributes: { color: 'Nwa' },
          // `7500.50` typed becomes 750050 minor units, by reading the digits
          // as text — never by multiplying a float.
          sellingPrice: { amountMinor: 750050, currency: 'HTG' },
          barcodes: ['0123456789012'],
        },
      ],
    });
  });

  it('omits a price nobody entered rather than sending a zero', async () => {
    // `null` in the contract means "nobody has established one". A zero would
    // mean the item is free, and a margin computed from it would be a lie with
    // a number attached.
    const api = await openNewProduct({ [CREATE_PRODUCT_ROUTE]: CREATED });

    fillNewProductForm({ name: 'Diri' });
    submitNewProductForm();
    await screen.findByRole('status');

    const [sent] = createProductRequests(api);
    expect(sent?.variants).toEqual([{ attributes: {}, barcodes: [] }]);
  });

  it('refuses an amount with no currency, because half a price is not a price', async () => {
    const api = await openNewProduct({ [CREATE_PRODUCT_ROUTE]: CREATED });

    fillNewProductForm({ name: 'Diri' });
    fillMoney('price', { amount: '7500', currency: '' });
    submitNewProductForm();
    await settle();

    expect(createProductRequests(api)).toHaveLength(0);
    expect(screen.getByText(ht['catalog.moneyIncomplete'])).toBeInTheDocument();
  });

  it('sends every variant that was added', async () => {
    const api = await openNewProduct({ [CREATE_PRODUCT_ROUTE]: CREATED });

    fillNewProductForm({ name: 'Diri' });
    addAttribute(0, { name: 'size', value: '5 mamit' });
    addVariant();
    addAttribute(1, { name: 'size', value: '10 mamit' });
    submitNewProductForm();
    await screen.findByRole('status');

    expect(createProductRequests(api)[0]?.variants).toEqual([
      { attributes: { size: '5 mamit' }, barcodes: [] },
      { attributes: { size: '10 mamit' }, barcodes: [] },
    ]);
  });

  it('omits a description nobody wrote rather than sending an empty one', async () => {
    const api = await openNewProduct({ [CREATE_PRODUCT_ROUTE]: CREATED });

    fillNewProductForm({ name: 'Diri', description: '   ' });
    submitNewProductForm();
    await screen.findByRole('status');

    expect(createProductRequests(api)[0]).not.toHaveProperty('description');
  });

  it('sends a description that was written', async () => {
    const api = await openNewProduct({ [CREATE_PRODUCT_ROUTE]: CREATED });

    fillNewProductForm({ name: 'Diri', description: 'Sak 25 liv' });
    submitNewProductForm();
    await screen.findByRole('status');

    expect(createProductRequests(api)[0]?.description).toBe('Sak 25 liv');
  });

  it('carries the session cookie and no operation id', async () => {
    // Not a ledger command. The operation-id header exists so a retried
    // movement posts once; this route writes no `operations` row, and sending
    // the header would claim an idempotency it does not implement.
    const api = await openNewProduct({ [CREATE_PRODUCT_ROUTE]: CREATED });

    fillNewProductForm();
    submitNewProductForm();
    await screen.findByRole('status');

    const [request] = api.to(CREATE_PRODUCT_ROUTE);
    expect(request?.credentials).toBe('same-origin');
    expect(Object.keys(request?.headers ?? {}).map((name) => name.toLowerCase())).not.toContain(
      'x-ekon-operation-id',
    );
  });
});

describe('what the server owns', () => {
  it('offers no field for anything the catalog assigns', async () => {
    await openNewProduct();

    // The SKU above all: it is generated server-side, it is what goes on the
    // shelf label, and a caller who could choose one could collide with another
    // shop's. There is no input for it, nor for an id, a signature, or a flag.
    expect(screen.queryByLabelText(ht['catalog.sku'])).toBeNull();
    const labels = screen
      .getAllByRole('textbox')
      .map((field) => field.getAttribute('name') ?? field.getAttribute('id') ?? '');
    for (const forbidden of ['sku', 'id', 'variantSignature', 'isActive', 'createdAt']) {
      expect(labels.some((label) => label.toLowerCase().includes(forbidden.toLowerCase()))).toBe(
        false,
      );
    }
  });

  it('puts none of them on the wire', async () => {
    const api = await openNewProduct({ [CREATE_PRODUCT_ROUTE]: CREATED });

    fillNewProductForm();
    addAttribute(0, { name: 'size', value: '5 mamit' });
    submitNewProductForm();
    await screen.findByRole('status');

    const sent = createProductRequests(api)[0] ?? {};
    expect(Object.keys(sent).sort()).toEqual(['classifications', 'name', 'variants']);
    for (const variant of sent.variants as Record<string, unknown>[]) {
      expect(Object.keys(variant).sort()).toEqual(['attributes', 'barcodes']);
    }
  });

  it('would be refused by the shared schema even if one were smuggled in', async () => {
    // The last line of the browser's defence, and the reason `createProduct`
    // parses before it sends: the contract is `.strict()`.
    expect(
      createProductRequestSchema.safeParse({
        name: 'Diri',
        variants: [{ attributes: {}, sku: 'EKN-AB12CD34' }],
      }).success,
    ).toBe(false);
  });
});

describe('what the form refuses before sending', () => {
  it('refuses a product with no name', async () => {
    const api = await openNewProduct();

    submitNewProductForm();

    expect(await screen.findByText(ht['catalog.nameRequired'])).toBeInTheDocument();
    expect(api.to(CREATE_PRODUCT_ROUTE)).toHaveLength(0);
  });

  it('refuses a name that is only spaces, and puts the cursor back on it', async () => {
    const api = await openNewProduct();

    fillNewProductForm({ name: '   ' });
    submitNewProductForm();

    await waitFor(() => expect(screen.getByLabelText(ht['catalog.productName'])).toHaveFocus());
    expect(api.to(CREATE_PRODUCT_ROUTE)).toHaveLength(0);
  });

  it('refuses a name longer than the shared bound', async () => {
    const api = await openNewProduct();

    fillNewProductForm({ name: 'a'.repeat(PRODUCT_NAME_MAX_LENGTH + 1) });
    submitNewProductForm();

    // A sentence, not a field that silently stopped accepting characters. The
    // input carries no `maxLength` for exactly that reason: truncating tells
    // somebody nothing about why their name is now shorter than they typed it.
    expect(await screen.findByText(ht['catalog.nameTooLong'])).toBeInTheDocument();
    expect(api.to(CREATE_PRODUCT_ROUTE)).toHaveLength(0);
  });

  it('refuses an attribute with a name and no value', async () => {
    const api = await openNewProduct();

    fillNewProductForm();
    addAttribute(0, { name: 'size', value: '  ' });
    submitNewProductForm();

    expect(await screen.findByText(ht['catalog.attributeValueRequired'])).toBeInTheDocument();
    expect(api.to(CREATE_PRODUCT_ROUTE)).toHaveLength(0);
  });

  it('cannot offer the same attribute twice in one variant', async () => {
    // Stronger than refusing it: the second row simply does not list a name the
    // first one took. Attributes cross the wire as an object, so two rows with
    // one name would collapse into a single key and the server would never
    // learn the second existed — a form that made that impossible to express is
    // better than one that catches it afterwards.
    await openNewProduct();

    fillNewProductForm({ name: 'Diri' });
    addAttribute(0, { name: 'size', value: '5 mamit' });
    fireEvent.click(screen.getByRole('button', { name: ht['catalog.addAttribute'] }));

    const [, second] = screen.getAllByLabelText(ht['catalog.attributeName']);
    expect([...(second as HTMLSelectElement).options].map((option) => option.value)).toEqual([
      '',
      'color',
      'width',
    ]);
  });

  it('refuses two variants that are the same item', async () => {
    const api = await openNewProduct();

    fillNewProductForm();
    addAttribute(0, { name: 'size', value: '5 mamit' });
    addVariant();
    addAttribute(1, { name: 'size', value: '5 Mamit' });
    submitNewProductForm();

    expect(await screen.findByText(ht['catalog.duplicateVariant'])).toBeInTheDocument();
    expect(api.to(CREATE_PRODUCT_ROUTE)).toHaveLength(0);
  });

  it('ignores an attribute row that was added and never filled in', async () => {
    // Pressing "add" and changing your mind is not a mistake to be scolded for.
    const api = await openNewProduct({ [CREATE_PRODUCT_ROUTE]: CREATED });

    fillNewProductForm();
    fireEvent.click(screen.getAllByRole('button', { name: ht['catalog.addAttribute'] })[0]!);
    submitNewProductForm();
    await screen.findByRole('status');

    expect(createProductRequests(api)[0]?.variants).toEqual([{ attributes: {}, barcodes: [] }]);
  });
});

describe('a second press while the first is in flight', () => {
  it('sends the request once', async () => {
    // Held open deliberately, because the window this guards is exactly the one
    // where the answer has not arrived. This route has no operation id and no
    // uniqueness on a product name, so a second attempt would be a second
    // product — there is nothing on the server to catch it.
    const inFlight = deferred();
    const api = await openNewProduct({ [CREATE_PRODUCT_ROUTE]: inFlight.responder });

    fillNewProductForm();
    submitNewProductForm();

    // The same element both times: its label changes while the request is open,
    // which is how somebody can see that pressing again is not needed.
    expect(submitButton()).toHaveTextContent(ht['catalog.submitting']);
    expect(submitButton()).toBeDisabled();

    submitNewProductForm();
    submitNewProductForm();
    await settle();

    expect(api.to(CREATE_PRODUCT_ROUTE)).toHaveLength(1);

    inFlight.resolve(CREATED);
    await screen.findByRole('status');
    expect(api.to(CREATE_PRODUCT_ROUTE)).toHaveLength(1);
  });
});

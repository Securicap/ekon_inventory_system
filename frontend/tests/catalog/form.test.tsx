import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createProductRequestSchema, PRODUCT_NAME_MAX_LENGTH } from '@ekon/shared';
import ht from '../../src/i18n/ht.json';
import { deferred, json } from '../helpers/fetchMock.js';
import {
  addAttribute,
  addVariant,
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

  it('sends the attributes that were typed, as they were typed', async () => {
    // Names and values are normalized by the catalog on arrival — trimmed, and
    // lower-cased for identity. Doing any of that here as well would be the
    // browser deciding something the server is the authority on.
    const api = await openNewProduct({ [CREATE_PRODUCT_ROUTE]: CREATED });

    fillNewProductForm({ name: 'Diri' });
    addAttribute(0, { name: 'Gwosè', value: '5 mamit' });
    submitNewProductForm();
    await screen.findByRole('status');

    expect(createProductRequests(api)[0]).toEqual({
      name: 'Diri',
      classifications: {},
      variants: [{ attributes: { Gwosè: '5 mamit' }, barcodes: [] }],
    });
  });

  it('sends every variant that was added', async () => {
    const api = await openNewProduct({ [CREATE_PRODUCT_ROUTE]: CREATED });

    fillNewProductForm({ name: 'Diri' });
    addAttribute(0, { name: 'gwosè', value: '5 mamit' });
    addVariant();
    addAttribute(1, { name: 'gwosè', value: '10 mamit' });
    submitNewProductForm();
    await screen.findByRole('status');

    expect(createProductRequests(api)[0]?.variants).toEqual([
      { attributes: { gwosè: '5 mamit' }, barcodes: [] },
      { attributes: { gwosè: '10 mamit' }, barcodes: [] },
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
    addAttribute(0, { name: 'gwosè', value: '5 mamit' });
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

    expect(
      await screen.findByText(
        ht['catalog.nameTooLong'].replace('{max}', String(PRODUCT_NAME_MAX_LENGTH)),
      ),
    ).toBeInTheDocument();
    expect(api.to(CREATE_PRODUCT_ROUTE)).toHaveLength(0);
  });

  it('refuses an attribute with a name and no value', async () => {
    const api = await openNewProduct();

    fillNewProductForm();
    addAttribute(0, { name: 'gwosè', value: '  ' });
    submitNewProductForm();

    expect(await screen.findByText(ht['catalog.attributeValueRequired'])).toBeInTheDocument();
    expect(api.to(CREATE_PRODUCT_ROUTE)).toHaveLength(0);
  });

  it('refuses the same attribute twice in one variant', async () => {
    // The one local rule that is not merely a faster round trip. Attributes
    // cross the wire as a JSON object, so a repeated name would collapse into
    // one key in the browser and the server would never learn the second was
    // typed — the person would be told nothing and lose what they entered.
    const api = await openNewProduct();

    fillNewProductForm();
    addAttribute(0, { name: 'Gwosè', value: '5 mamit' });
    addAttribute(0, { name: ' gwosè ', value: '10 mamit' });
    submitNewProductForm();

    expect(await screen.findByText(ht['catalog.duplicateAttribute'])).toBeInTheDocument();
    expect(api.to(CREATE_PRODUCT_ROUTE)).toHaveLength(0);
  });

  it('refuses two variants that are the same item', async () => {
    const api = await openNewProduct();

    fillNewProductForm();
    addAttribute(0, { name: 'gwosè', value: '5 mamit' });
    addVariant();
    addAttribute(1, { name: 'GWOSÈ', value: '5 Mamit' });
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

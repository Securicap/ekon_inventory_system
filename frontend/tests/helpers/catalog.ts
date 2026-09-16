import { fireEvent, screen } from '@testing-library/react';
import type { Capability } from '@ekon/shared';
import ht from '../../src/i18n/ht.json';
import { json, mockApi, type FetchMock, type Responder } from './fetchMock.js';
import { metadataFixture, productFixture, userFixture, userResponse } from './fixtures.js';
import { renderApp, settle } from './renderApp.js';

/**
 * Signs somebody in who may write the catalog, and opens the screen the way
 * they would: by clicking the navigation entry.
 *
 * No shortcut past authentication and none past the shell — the form is reached
 * through the same capability check that decides whether it is offered at all,
 * which is half of what these tests are about.
 */

export const CREATE_PRODUCT_ROUTE = 'POST /api/catalog/products';
export const CATALOG_ROUTE = 'GET /api/catalog/products';
export const METADATA_ROUTE = 'GET /api/catalog/metadata';

/** What somebody who may both read and write the catalog holds. */
export const CATALOG_WRITER: readonly Capability[] = ['catalog.read', 'catalog.write'];

/**
 * A created product, as the route answers it — the shared response shape, with
 * the id and the SKU the server chose. `productFixture` is the same shape the
 * list returns, which is what makes a creation and a listing agree.
 */
export function createdProduct(
  overrides: Parameters<typeof productFixture>[0] = {},
): ReturnType<typeof productFixture> {
  return productFixture(overrides);
}

export async function openCatalog(
  routes: Record<string, Responder | Responder[]> = {},
  options: { capabilities?: readonly Capability[] } = {},
): Promise<FetchMock> {
  const api = mockApi({
    'GET /api/auth/me': json(
      userResponse(userFixture({ capabilities: options.capabilities ?? CATALOG_WRITER })),
    ),
    [CATALOG_ROUTE]: json([]),
    // The form reads the catalog's vocabulary to build its attribute list; a
    // test that opens the form without it would be testing a form with nothing
    // to choose from.
    [METADATA_ROUTE]: json(metadataFixture()),
    ...routes,
  });

  renderApp();
  await screen.findByText('Marie Joseph');
  fireEvent.click(screen.getByRole('button', { name: ht['nav.products'] }));
  await screen.findByRole('heading', { name: ht['catalog.title'] });
  await settle();

  return api;
}

/** Opens the catalog and then the creation form, as somebody adding an item would. */
export async function openNewProduct(
  routes: Record<string, Responder | Responder[]> = {},
  options: { capabilities?: readonly Capability[] } = {},
): Promise<FetchMock> {
  const api = await openCatalog(routes, options);
  fireEvent.click(screen.getByRole('button', { name: ht['catalog.newProduct'] }));
  await screen.findByRole('heading', { name: ht['catalog.newProductTitle'] });
  // The vocabulary is read when the form opens, and the attribute list is built
  // from it — so a test that started typing before it arrived would be filling
  // in a form with nothing to choose from.
  await settle();
  return api;
}

export function fillNewProductForm(values: { name?: string; description?: string } = {}): void {
  fireEvent.change(screen.getByLabelText(ht['catalog.productName']), {
    target: { value: values.name ?? 'Diri' },
  });
  if (values.description !== undefined) {
    fireEvent.change(screen.getByLabelText(ht['catalog.productDescription']), {
      target: { value: values.description },
    });
  }
}

/**
 * Adds an attribute row to a variant and fills it in, by position.
 *
 * The name is **selected**, not typed: attribute names are structure, the
 * catalog refuses one it has never heard of, and the form offers the vocabulary
 * rather than a text box. Passing a name the metadata does not define leaves
 * the select empty, which is exactly what should happen.
 */
export function addAttribute(
  variantIndex: number,
  attribute: { name: string; value: string },
): void {
  const buttons = screen.getAllByRole('button', { name: ht['catalog.addAttribute'] });
  fireEvent.click(buttons[variantIndex]!);

  const names = screen.getAllByLabelText(ht['catalog.attributeName']);
  const valuesFields = screen.getAllByLabelText(ht['catalog.attributeValue']);
  const position = names.length - 1;

  fireEvent.change(names[position]!, { target: { value: attribute.name } });
  fireEvent.change(valuesFields[position]!, { target: { value: attribute.value } });
}

/** Fills one variant's price or cost: an amount and a currency, which are one fact. */
export function fillMoney(
  field: 'price' | 'cost',
  money: { amount: string; currency: string },
  variantIndex = 0,
): void {
  const label = field === 'price' ? ht['catalog.price'] : ht['catalog.cost'];
  fireEvent.change(screen.getAllByLabelText(label)[variantIndex]!, {
    target: { value: money.amount },
  });
  fireEvent.change(screen.getAllByLabelText(ht['catalog.currency'])[variantIndex]!, {
    target: { value: money.currency },
  });
}

export function addVariant(): void {
  fireEvent.click(screen.getByRole('button', { name: ht['catalog.addVariant'] }));
}

/**
 * The form's submit control, found by what it is rather than by what it says —
 * its label changes while the request is open, and a test that pressed it twice
 * would otherwise stop being able to find it exactly when that matters.
 */
export function submitButton(): HTMLButtonElement {
  const button = screen
    .getAllByRole('button')
    .find((candidate) => (candidate as HTMLButtonElement).type === 'submit');
  if (!button) throw new Error('The product form has no submit button');
  return button as HTMLButtonElement;
}

export function submitNewProductForm(): void {
  fireEvent.click(submitButton());
}

/** The body of `POST /api/catalog/products`, as the browser sent it. */
export function createProductRequests(api: FetchMock): Record<string, unknown>[] {
  return api.to(CREATE_PRODUCT_ROUTE).map((request) => request.body as Record<string, unknown>);
}

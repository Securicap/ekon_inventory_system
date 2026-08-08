import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLE_CAPABILITIES, type Capability } from '@ekon/shared';
import ht from '../../src/i18n/ht.json';
import { apiFailure, json } from '../helpers/fetchMock.js';
import { productFixture } from '../helpers/fixtures.js';
import { CATALOG_ROUTE, CREATE_PRODUCT_ROUTE, openCatalog } from '../helpers/catalog.js';
import { settle } from '../helpers/renderApp.js';

/**
 * Who is shown the door to product creation.
 *
 * Reading the catalog and writing it are two different permissions, and
 * somebody may hold either without the other: `catalog.read` opens this screen,
 * `catalog.write` opens the form on it. The check here is usability, not
 * security — the list arrives from `/me` and lives in a browser where anything
 * can be edited, and the server checks `catalog.write` again on every request,
 * which `catalogApi.test.ts` on the backend already proves. Hiding a form
 * somebody may not submit is worth doing anyway.
 */

async function signedInWith(capabilities: readonly Capability[]): Promise<void> {
  await openCatalog({ [CATALOG_ROUTE]: json([productFixture()]) }, { capabilities });
}

describe('who is offered product creation', () => {
  it('offers it to somebody holding catalog.write', async () => {
    await signedInWith(['catalog.read', 'catalog.write']);
    expect(screen.getByRole('button', { name: ht['catalog.newProduct'] })).toBeInTheDocument();
  });

  it('does not offer it to somebody who may only read the catalog', async () => {
    // The employee case, and the one that matters: they use this screen all day
    // to look things up, and must not be shown a form the server would refuse.
    await signedInWith(['catalog.read']);
    expect(screen.queryByRole('button', { name: ht['catalog.newProduct'] })).toBeNull();
  });

  it('does not offer it to an employee holding every capability their role grants', async () => {
    // Their real seeded grants, not a hand-picked list: an employee reads the
    // catalog, reads stock, receives, and removes. Writing the catalog is not
    // among them, and the day it is, this test is the one that says so.
    await signedInWith(DEFAULT_ROLE_CAPABILITIES.EMPLOYEE ?? []);
    expect(screen.queryByRole('button', { name: ht['catalog.newProduct'] })).toBeNull();
  });

  it('offers it to an owner through their seeded grants', async () => {
    await signedInWith(DEFAULT_ROLE_CAPABILITIES.OWNER ?? []);
    expect(screen.getByRole('button', { name: ht['catalog.newProduct'] })).toBeInTheDocument();
  });

  it('offers it to a manager, who may write the catalog without managing anybody', async () => {
    await signedInWith(DEFAULT_ROLE_CAPABILITIES.MANAGER ?? []);
    expect(screen.getByRole('button', { name: ht['catalog.newProduct'] })).toBeInTheDocument();
  });

  it('shows no form until the action is taken', async () => {
    // The screen is a list first. Somebody who came to look something up is not
    // made to scroll past a form they did not ask for.
    await signedInWith(['catalog.read', 'catalog.write']);
    expect(screen.queryByRole('heading', { name: ht['catalog.newProductTitle'] })).toBeNull();
  });
});

describe('the browser is not the authority', () => {
  it('sends nothing on its own when the form is merely opened', async () => {
    // Opening a form is not an intent to create anything.
    const api = await openCatalog(
      { [CREATE_PRODUCT_ROUTE]: apiFailure('FORBIDDEN', 403) },
      { capabilities: ['catalog.read', 'catalog.write'] },
    );
    await settle();

    expect(api.to(CREATE_PRODUCT_ROUTE)).toHaveLength(0);
  });
});

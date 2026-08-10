import { cleanup, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { json } from '../helpers/fetchMock.js';
import { openCatalog, openNewProduct } from '../helpers/catalog.js';
import { openNewUser } from '../helpers/users.js';
import { openReceiving } from '../helpers/receiving.js';
import { openRemoval } from '../helpers/removal.js';
import { openStock } from '../helpers/stock.js';
import { balanceFixture } from '../helpers/fixtures.js';
import { viewport } from '../helpers/viewport.js';

/**
 * One outline per screen, and it has to be a sensible one.
 *
 * Every authenticated screen opens with `PageHeader`, whose title is the page's
 * `h1`; everything below it is a section of that page. The screens were built
 * by separate pull requests, and two of them ended up starting their sections at
 * `h3` — so somebody navigating by heading on a phone jumped from the page title
 * straight past a level that was never there. Home had it right, which is what
 * made it a discrepancy rather than a house style.
 *
 * This asserts the two properties that matter and nothing about wording or
 * markup: exactly one `h1`, and no level skipped on the way down.
 */

/** Every heading currently rendered, in document order. */
function outline(): { level: number; text: string }[] {
  return screen.getAllByRole('heading').map((heading) => ({
    level: Number(heading.tagName[1]),
    text: heading.textContent ?? '',
  }));
}

function skippedLevels(headings: { level: number; text: string }[]): string[] {
  return headings
    .slice(1)
    .filter((heading, index) => heading.level - headings[index]!.level > 1)
    .map((heading, index) => `h${headings[index]!.level} → h${heading.level} at "${heading.text}"`);
}

const STOCK = [
  balanceFixture({
    productName: 'Diri',
    sku: 'EKN-AB12CD34',
    attributes: [{ name: 'gwosè', value: '5 mamit' }],
    locations: [{ locationName: 'Main Store', isDefault: true, quantity: 10 }],
  }),
];

const SCREENS: [string, () => Promise<unknown>][] = [
  ['stock', () => openStock({ 'GET /api/inventory/balances': json(STOCK) })],
  ['catalog', () => openCatalog()],
  ['new product', () => openNewProduct()],
  ['receiving', () => openReceiving()],
  ['removal', () => openRemoval()],
  ['new account', () => openNewUser()],
];

/**
 * The phone carries only the everyday destinations on its bottom bar, and the
 * shared openers reach a screen by pressing that bar — so these are the screens
 * a phone opens directly. They are also the ones that matter most here: the
 * stock register is the screen that swaps its table for a list of records, and
 * those record headings were the ones skipping a level.
 */
const PHONE_SCREENS = SCREENS.filter(([name]) => ['stock', 'receiving', 'removal'].includes(name));

describe.each([
  ['desktop', SCREENS],
  ['mobile', PHONE_SCREENS],
] as const)('heading outline on %s', (size, screens) => {
  it.each(screens)('gives %s exactly one h1', async (_name, open) => {
    viewport(size);
    await open();

    const h1 = outline().filter((heading) => heading.level === 1);
    expect(h1.map((heading) => heading.text)).toHaveLength(1);
    cleanup();
  });

  it.each(screens)('skips no heading level on %s', async (_name, open) => {
    viewport(size);
    await open();

    expect(skippedLevels(outline())).toEqual([]);
    cleanup();
  });
});

describe('the page title is the h1', () => {
  it('is the screen name rather than the wordmark, once somebody is signed in', async () => {
    viewport('desktop');
    await openStock({ 'GET /api/inventory/balances': json(STOCK) });

    // The brand is a `<p>` inside the shell; the `h1` belongs to the screen in
    // `main`, so a screen reader's first heading is where the reader is.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(ht['stock.title']);
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveTextContent(ht['app.name']);
  });
});

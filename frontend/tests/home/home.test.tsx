import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Capability } from '@ekon/shared';
import ht from '../../src/i18n/ht.json';
import { apiFailure, deferred, json, mockApi, type Responder } from '../helpers/fetchMock.js';
import { locationFixture, productFixture, userFixture, userResponse } from '../helpers/fixtures.js';
import { renderApp } from '../helpers/renderApp.js';

const EVERYTHING: readonly Capability[] = [
  'catalog.read',
  'inventory.read',
  'inventory.receive',
  'inventory.remove',
  'identity.manage',
];

async function signedInWith(
  capabilities: readonly Capability[],
  routes: Record<string, Responder | Responder[]> = {},
): Promise<void> {
  mockApi({
    'GET /api/auth/me': json(userResponse(userFixture({ capabilities }))),
    'GET /api/catalog/products': json([productFixture()]),
    'GET /api/inventory/locations': json([locationFixture()]),
    'GET /api/inventory/balances': json([]),
    ...routes,
  });
  renderApp();
  await screen.findByText('Marie Joseph');
}

/** The shortcut panel, which is the only part of Home that goes anywhere. */
function tasks(): HTMLElement {
  return screen.getByRole('region', { name: ht['home.tasks'] });
}

/**
 * A shortcut's accessible name: the destination, then what it is for. Both are
 * inside the control, so a screen reader announces the purpose with the name
 * rather than leaving "Retire" to be guessed at.
 */
function shortcutName(label: string, purpose: string): string {
  return `${label} ${purpose}`;
}

const STOCK = shortcutName(ht['nav.stock'], ht['nav.stockPurpose']);
const RECEIVE = shortcutName(ht['nav.receive'], ht['nav.receivePurpose']);
const REMOVE = shortcutName(ht['nav.remove'], ht['nav.removePurpose']);
const PRODUCTS = shortcutName(ht['nav.products'], ht['nav.productsPurpose']);
const NEW_USER = shortcutName(ht['nav.newUser'], ht['nav.newUserPurpose']);
const COUNTS = shortcutName(ht['nav.counts'], ht['nav.countsPurpose']);
const HISTORY = shortcutName(ht['nav.history'], ht['nav.historyPurpose']);

/**
 * Every shortcut's accessible name, in order. Joined the way the accessible
 * name is computed — one space between the control's children — rather than
 * read off `textContent`, which runs them together.
 */
function shortcuts(): string[] {
  return within(tasks())
    .getAllByRole('button')
    .map((button) =>
      [...button.children]
        .map((child) => child.textContent ?? '')
        .join(' ')
        .trim(),
    );
}

/**
 * The landing screen: who you are, what you may open, and whether the system is
 * working.
 *
 * The property worth protecting here is negative. Home is the obvious place for
 * somebody to add "stock on hand" or "movements today", and the API produces
 * neither — so what it offers is doors, and the doors are the ones the shell
 * would offer, from the same list. A shortcut that appeared for somebody the
 * sidebar would refuse would be a second permission model.
 */
describe('the home screen', () => {
  it('greets the signed-in person and names the account they are using', async () => {
    await signedInWith(['inventory.read']);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      ht['home.welcome'].replace('{name}', 'Marie Joseph'),
    );
    expect(
      screen.getByText(
        ht['home.identity'].replace('{role}', ht['role.OWNER']).replace('{username}', 'marie.j'),
      ),
    ).toBeInTheDocument();
  });

  it('offers every destination this person may open, operations first', async () => {
    await signedInWith(EVERYTHING);
    expect(shortcuts()).toEqual([STOCK, RECEIVE, REMOVE, COUNTS, HISTORY, PRODUCTS, NEW_USER]);
  });

  it('does not offer itself', async () => {
    await signedInWith(EVERYTHING);

    expect(shortcuts().some((name) => name.startsWith(ht['nav.home']))).toBe(false);
  });

  it('leaves out what the capability does not open, rather than disabling it', async () => {
    await signedInWith(['inventory.read', 'inventory.receive']);

    // Counts and History come with `inventory.read`, which is what makes them
    // visibility rather than authority.
    expect(shortcuts()).toEqual([STOCK, RECEIVE, COUNTS, HISTORY]);
    // Absent, not present-and-dead: a disabled door is still a door somebody
    // will try, and the API would refuse it anyway.
    for (const button of within(tasks()).getAllByRole('button')) {
      expect(button).toBeEnabled();
    }
  });

  it('says so, rather than showing an empty panel, when nothing may be opened', async () => {
    await signedInWith([]);

    expect(within(tasks()).queryAllByRole('button')).toEqual([]);
    // A bare panel reads as a broken application. This one says what happened
    // and who can fix it.
    expect(within(tasks()).getByText(ht['home.noTasks'])).toBeInTheDocument();
    // And the note about what the panel normally lists is not left hanging
    // under nothing.
    expect(within(tasks()).queryByText(ht['home.tasksNote'])).toBeNull();
  });

  it('shows exactly the destinations the shell shows', async () => {
    // One capability model, asked twice. If Home ever grew its own list, this
    // is the test that would notice.
    await signedInWith(['inventory.read', 'identity.manage']);

    const sidebar = within(screen.getByRole('navigation', { name: ht['nav.main'] }))
      .getAllByRole('button')
      .map((button) => button.textContent ?? '')
      .filter((label) => label !== ht['nav.home']);

    expect(shortcuts().map((name) => name.split(' ')[0])).toEqual(
      sidebar.map((label) => label.split(' ')[0]),
    );
  });

  it('opens the screen a shortcut names, through the shell that owns the view', async () => {
    await signedInWith(EVERYTHING);

    fireEvent.click(within(tasks()).getByRole('button', { name: PRODUCTS }));

    await screen.findByText('Diri');
    // The shell agrees about where we are — there is one view, not two.
    expect(screen.getByRole('button', { name: ht['nav.products'] })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('reaches an operational screen the same way', async () => {
    await signedInWith(EVERYTHING);

    fireEvent.click(within(tasks()).getByRole('button', { name: RECEIVE }));

    expect(await screen.findByRole('heading', { name: ht['receiving.title'] })).toBeInTheDocument();
  });

  it('reaches a shortcut by keyboard, with the destination in its name', async () => {
    await signedInWith(['inventory.remove']);

    const remove = within(tasks()).getByRole('button', { name: REMOVE });
    remove.focus();
    expect(remove).toHaveFocus();
    expect(remove).toBeEnabled();
  });
});

describe('the system health panel', () => {
  function panel(): HTMLElement {
    return screen.getByRole('region', { name: ht['health.title'] });
  }

  it('says the database is reachable, in words rather than in colour', async () => {
    await signedInWith(['inventory.read']);
    await within(panel()).findByText(ht['health.up']);

    const terms = within(panel()).getAllByRole('term');
    const definitions = within(panel()).getAllByRole('definition');

    expect(terms.map((term) => term.textContent)).toEqual([
      ht['health.database'],
      ht['health.schemaVersion'],
      ht['health.version'],
      ht['health.time'],
    ]);
    expect(definitions[0]).toHaveTextContent(ht['health.up']);
    expect(definitions[1]).toHaveTextContent('0008');
  });

  it('says the database is down in words too', async () => {
    await signedInWith(['inventory.read'], {
      'GET /api/health': json({
        status: 'degraded',
        version: 'test',
        schemaVersion: null,
        database: 'down',
        time: '2026-08-02T12:00:00.000Z',
      }),
    });

    await within(panel()).findByText(ht['health.down']);
    expect(within(panel()).getAllByRole('definition')[0]).toHaveTextContent(ht['health.down']);
  });

  it('says it is still asking before the answer arrives', async () => {
    const health = deferred();
    await signedInWith(['inventory.read'], { 'GET /api/health': health.responder });

    expect(within(panel()).getByRole('status')).toHaveTextContent(ht['status.loading']);
    expect(within(panel()).queryAllByRole('definition')).toEqual([]);

    health.resolve(
      json({
        status: 'ok',
        version: 'test',
        schemaVersion: '0008',
        database: 'up',
        time: '2026-08-02T12:00:00.000Z',
      }),
    );
    expect(await within(panel()).findByText(ht['health.up'])).toBeInTheDocument();
  });

  it('reports a health failure as a failure, with a way to ask again', async () => {
    await signedInWith(['inventory.read'], {
      'GET /api/health': apiFailure('INTERNAL', 500, 'req-7'),
    });

    // A 500 is retried with backoff before the read gives up, which is the read
    // policy the whole application uses — so this waits longer than a default.
    const alert = await within(panel()).findByRole('alert', {}, { timeout: 8000 });
    expect(alert).toHaveTextContent(ht['error.generic']);
    expect(alert).toHaveTextContent('req-7');
    expect(within(alert).getByRole('button', { name: ht['action.retry'] })).toBeInTheDocument();

    // A failing health check is not a session problem: the shell stays.
    expect(screen.getByRole('button', { name: ht['auth.signOut'] })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: ht['nav.main'] })).toBeInTheDocument();
  });

  it('is not a destination: nothing in it navigates', async () => {
    await signedInWith(EVERYTHING);

    expect(within(panel()).queryAllByRole('button')).toEqual([]);
    expect(within(panel()).queryAllByRole('link')).toEqual([]);
  });
});

import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ht from '../../src/i18n/ht.json';
import { apiFailure, deferred, json, mockApi } from '../helpers/fetchMock.js';
import { userResponse } from '../helpers/fixtures.js';
import { renderApp, submitLogin } from '../helpers/renderApp.js';

const PASSWORD = 'chwal vèt kanpe';

/** The login form, reached by starting the application with no session. */
async function renderLogin(
  overrides: Record<string, unknown> = {},
): Promise<ReturnType<typeof mockApi>> {
  const api = mockApi({
    'GET /api/auth/me': apiFailure('UNAUTHENTICATED', 401),
    'POST /api/auth/login': json(userResponse()),
    ...overrides,
  });
  renderApp();
  await screen.findByLabelText(ht['auth.username']);
  return api;
}

/**
 * How the unauthenticated screens say what they are doing.
 *
 * These are about meaning rather than appearance. A busy button and a disabled
 * one look different, but what matters is that assistive technology is told
 * which of the two it is; a cleared password field is a decision, and the
 * screen has to say so rather than look like it lost what was typed. Nothing
 * here asserts a class name — a redesign should be free to move all of it and
 * still pass.
 */
describe('the login screen', () => {
  it('carries the application identity as the page heading, with no navigation behind it', async () => {
    await renderLogin();

    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName(ht['app.name']);
    // The identity is shared with the shell; the navigation is not, and none of
    // it may appear before anybody is signed in.
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: ht['auth.signOut'] })).toBeNull();
  });

  it('labels the sign-in panel and offers exactly one submit action', async () => {
    await renderLogin();

    expect(screen.getByRole('heading', { name: ht['auth.signInHeading'] })).toBeInTheDocument();

    const form = screen.getByRole('button', { name: ht['auth.signIn'] }).closest('form');
    const submits = within(form!)
      .getAllByRole('button')
      .filter((button) => (button as HTMLButtonElement).type === 'submit');
    expect(submits).toHaveLength(1);
  });

  it('says a sign-in is in progress rather than only greying the button', async () => {
    const login = deferred();
    await renderLogin({ 'POST /api/auth/login': login.responder });

    submitLogin({ username: 'marie.j', password: PASSWORD });

    const button = screen.getByRole('button', { name: ht['auth.signingIn'] });
    // Disabled stops a second session being minted for one intent; `aria-busy`
    // is what says *why* it cannot be pressed.
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');

    // The form is still the form. Authentication does not replace the screen
    // with a spinner, so nothing a person was reading moves.
    expect(screen.getByLabelText(ht['auth.username'])).toBeInTheDocument();
    expect(screen.getByLabelText(ht['auth.password'])).toBeInTheDocument();

    login.resolve(json(userResponse()));
    await screen.findByText('Marie Joseph');
  });

  it('is not busy before anything has been submitted', async () => {
    await renderLogin();
    expect(screen.getByRole('button', { name: ht['auth.signIn'] })).not.toHaveAttribute(
      'aria-busy',
      'true',
    );
  });

  it('explains the emptied password field, and attaches the explanation to it', async () => {
    await renderLogin({ 'POST /api/auth/login': apiFailure('UNAUTHENTICATED', 401) });

    submitLogin({ username: 'marie.j', password: PASSWORD });
    await screen.findByRole('alert');

    const password = screen.getByLabelText(ht['auth.password']);
    expect(password).toHaveValue('');

    const hint = screen.getByText(ht['auth.passwordCleared']);
    expect(password.getAttribute('aria-describedby')?.split(' ')).toContain(hint.id);
  });

  it('says nothing about a cleared field before anything was refused', async () => {
    await renderLogin();

    expect(screen.queryByText(ht['auth.passwordCleared'])).toBeNull();
    expect(screen.getByLabelText(ht['auth.password'])).not.toHaveAttribute('aria-describedby');
  });

  it('stays on the form when a credential is refused', async () => {
    await renderLogin({ 'POST /api/auth/login': apiFailure('UNAUTHENTICATED', 401) });

    submitLogin({ username: 'marie.j', password: PASSWORD });
    await screen.findByRole('alert');

    expect(screen.getByRole('button', { name: ht['auth.signIn'] })).toBeEnabled();
    expect(screen.queryByRole('button', { name: ht['auth.signOut'] })).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('states why the session ended without announcing it as a failure', async () => {
    // An ended session is a fact about the past; the refusal that just happened
    // is the thing that needs announcing. Two alerts would make them compete.
    mockApi({
      'GET /api/auth/me': json(userResponse()),
      'GET /api/catalog/products': apiFailure('UNAUTHENTICATED', 401),
    });
    renderApp();
    await screen.findByText('Marie Joseph');
    fireEvent.click(screen.getByRole('button', { name: ht['nav.products'] }));
    await screen.findByLabelText(ht['auth.username']);

    expect(screen.getByRole('status')).toHaveTextContent(ht['error.sessionExpired']);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the ended-session notice and a refused credential as separate statements', async () => {
    mockApi({
      'GET /api/auth/me': json(userResponse()),
      'GET /api/catalog/products': apiFailure('UNAUTHENTICATED', 401),
      'POST /api/auth/login': apiFailure('UNAUTHENTICATED', 401),
    });
    renderApp();
    await screen.findByText('Marie Joseph');
    fireEvent.click(screen.getByRole('button', { name: ht['nav.products'] }));
    await screen.findByLabelText(ht['auth.username']);

    submitLogin({ username: 'marie.j', password: PASSWORD });

    const alerts = await screen.findAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toHaveTextContent(ht['auth.invalidCredentials']);
    // And the reason they are back at this screen has not been overwritten.
    expect(screen.getByText(ht['error.sessionExpired'])).toBeInTheDocument();
  });
});

describe('connectivity around the login screen', () => {
  /**
   * `online`/`offline` are window events, and the query client's own connection
   * state is a module singleton that listens to them — so a test that drops the
   * connection must put it back, or the next one starts with its reads paused.
   */
  afterEach(() => fireEvent(window, new Event('online')));

  it('shows the banner outside the authentication boundary, above the form', async () => {
    await renderLogin();

    fireEvent(window, new Event('offline'));

    const banner = screen.getByText(ht['connectivity.offline']);
    const main = screen.getByRole('main');

    // Outside the boundary, not inside the screen it happens to be sitting
    // above — and before it in the document, so it can never cover a control.
    expect(main.contains(banner)).toBe(false);
    expect(banner.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Nothing about the form is taken away: the fields, their labels, and the
    // submit action are all still there and still operable.
    expect(screen.getByLabelText(ht['auth.username'])).toBeInTheDocument();
    expect(screen.getByLabelText(ht['auth.password'])).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ht['auth.signIn'] })).toBeEnabled();
  });

  it('goes on saying the connection is back once it is', async () => {
    await renderLogin();

    fireEvent(window, new Event('offline'));
    expect(screen.getByText(ht['connectivity.offline'])).toBeInTheDocument();

    fireEvent(window, new Event('online'));
    expect(screen.getByText(ht['connectivity.online'])).toBeInTheDocument();
    expect(screen.queryByText(ht['connectivity.offline'])).toBeNull();

    // And it never became a second thing to read inside the form.
    const form = screen.getByRole('button', { name: ht['auth.signIn'] }).closest('form');
    expect(within(form!).queryByText(ht['connectivity.online'])).toBeNull();
  });
});

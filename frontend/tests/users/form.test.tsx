import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PASSWORD_INPUT_MIN_LENGTH, ROLES } from '@ekon/shared';
import ht from '../../src/i18n/ht.json';
import { apiFailure, deferred, json, offline } from '../helpers/fetchMock.js';
import {
  CREATE_USER_ROUTE,
  createdUser,
  createUserRequests,
  fillNewUserForm,
  openNewUser,
  submitNewUserForm,
} from '../helpers/users.js';
import { settle } from '../helpers/renderApp.js';

/**
 * Creating an account, from the browser.
 *
 * The screen is the smallest thing that makes the workflow usable without
 * anybody typing curl at a shop counter, so what is tested is the workflow: the
 * account is created, the person is told what to hand over, the credential does
 * not linger, and a refusal says something they can act on.
 */

const PASSWORD = 'zoranj kokoye diri';

describe('creating an account', () => {
  it('sends exactly the four fields the contract allows', async () => {
    const { api } = await openNewUser({ [CREATE_USER_ROUTE]: json(createdUser(), 201) });

    fillNewUserForm();
    submitNewUserForm();

    await screen.findByRole('alert');

    const [sent, ...extras] = createUserRequests(api);
    expect(extras).toHaveLength(0);
    expect(sent).toEqual({
      username: 'nadege.l',
      displayName: 'Nadege Louis',
      password: PASSWORD,
      role: 'EMPLOYEE',
    });

    // Nothing the server owns, and above all no capability list.
    expect(sent).not.toHaveProperty('id');
    expect(sent).not.toHaveProperty('capabilities');
    expect(sent).not.toHaveProperty('isActive');
    expect(sent).not.toHaveProperty('passwordHash');
  });

  it('carries the session cookie and no operation id', async () => {
    // Not a ledger command. The operation-id header exists so a retried
    // movement posts once; a repeated account creation is a duplicate username,
    // which the server refuses on its own.
    const { api } = await openNewUser({ [CREATE_USER_ROUTE]: json(createdUser(), 201) });

    fillNewUserForm();
    submitNewUserForm();
    await screen.findByRole('alert');

    const [request] = api.to(CREATE_USER_ROUTE);
    expect(request?.credentials).toBe('same-origin');
    expect(Object.keys(request?.headers ?? {}).map((name) => name.toLowerCase())).not.toContain(
      'x-operation-id',
    );
  });

  it('normalizes the username before it is sent', async () => {
    // The shared schema, the same one the server parses. The account is created
    // under the name the person will sign in with.
    const { api } = await openNewUser({ [CREATE_USER_ROUTE]: json(createdUser(), 201) });

    fillNewUserForm({ username: '  Nadege.L  ' });
    submitNewUserForm();
    await screen.findByRole('alert');

    expect(createUserRequests(api)[0]?.username).toBe('nadege.l');
  });

  it('sends the password exactly as typed, spaces and all', async () => {
    const padded = `  ${PASSWORD}  `;
    const { api } = await openNewUser({ [CREATE_USER_ROUTE]: json(createdUser(), 201) });

    fillNewUserForm({ password: padded });
    submitNewUserForm();
    await screen.findByRole('alert');

    expect(createUserRequests(api)[0]?.password).toBe(padded);
  });

  it('offers every role in the closed set, and defaults to employee', async () => {
    await openNewUser();

    const select = screen.getByLabelText(ht['users.role']) as HTMLSelectElement;
    const offered = [...select.options].map((option) => option.value);
    expect(offered).toEqual([...ROLES]);
    // The role most accounts will have, so the common case is one less choice.
    expect(select.value).toBe('EMPLOYEE');
  });

  it('sends the role that was chosen', async () => {
    const { api } = await openNewUser({ [CREATE_USER_ROUTE]: json(createdUser(), 201) });

    fillNewUserForm({ role: 'MANAGER' });
    submitNewUserForm();
    await screen.findByRole('alert');

    expect(createUserRequests(api)[0]?.role).toBe('MANAGER');
  });
});

describe('what the form refuses before sending', () => {
  /** Fills the form with one bad field and asserts nothing left the browser. */
  async function refuses(
    values: Parameters<typeof fillNewUserForm>[0],
    expectedMessage: string,
  ): Promise<void> {
    const { api } = await openNewUser();

    fillNewUserForm(values);
    submitNewUserForm();

    expect(await screen.findByText(expectedMessage)).toBeInTheDocument();
    expect(api.to(CREATE_USER_ROUTE)).toHaveLength(0);
  }

  it('refuses a blank username', async () => {
    await refuses({ username: '   ' }, ht['users.usernameRequired']);
  });

  it.each([
    ['too short', 'ab'],
    ['spaced', 'nadege louis'],
    ['punctuated', 'nadege@shop'],
  ])('refuses a %s username', async (_label, username) => {
    const { api } = await openNewUser();
    fillNewUserForm({ username });
    submitNewUserForm();

    expect(await screen.findByText(/ti lèt, chif/i)).toBeInTheDocument();
    expect(api.to(CREATE_USER_ROUTE)).toHaveLength(0);
  });

  it('accepts a username that only needs normalizing', async () => {
    // Upper case and padding are not mistakes: the shared rule normalizes them.
    const { api } = await openNewUser({ [CREATE_USER_ROUTE]: json(createdUser(), 201) });
    fillNewUserForm({ username: '  NADEGE.L  ' });
    submitNewUserForm();

    await screen.findByRole('alert');
    expect(api.to(CREATE_USER_ROUTE)).toHaveLength(1);
  });

  it('refuses a blank display name', async () => {
    await refuses({ displayName: '  ' }, ht['users.displayNameRequired']);
  });

  it('refuses an empty password', async () => {
    await refuses({ password: '' }, ht['users.passwordRequired']);
  });

  it('refuses a password below the shared minimum', async () => {
    const { api } = await openNewUser();
    fillNewUserForm({ password: 'a'.repeat(PASSWORD_INPUT_MIN_LENGTH - 1) });
    submitNewUserForm();

    expect(await screen.findByText(/omwen 10 karaktè/i)).toBeInTheDocument();
    expect(api.to(CREATE_USER_ROUTE)).toHaveLength(0);
  });

  it('moves focus to the first field that is wrong', async () => {
    await openNewUser();
    fillNewUserForm({ username: 'ab', password: '' });
    submitNewUserForm();

    await waitFor(() => expect(screen.getByLabelText(ht['users.username'])).toHaveFocus());
  });
});

describe('the password', () => {
  it("is a password field, and is never offered back as the signed-in person's own", async () => {
    await openNewUser();

    const field = screen.getByLabelText(ht['users.password']);
    expect(field).toHaveAttribute('type', 'password');
    // `new-password`: this is somebody else's credential, and a browser that
    // filed it under the signed-in person would offer it at the login form.
    expect(field).toHaveAttribute('autocomplete', 'new-password');
  });

  it('is cleared from the form once the account exists', async () => {
    await openNewUser({ [CREATE_USER_ROUTE]: json(createdUser(), 201) });

    fillNewUserForm();
    submitNewUserForm();
    await screen.findByText(ht['users.success'].replace('{name}', 'Nadege Louis'));

    // The confirmation does not show it, and neither does anything else on the
    // screen. A shared shop laptop must not keep a colleague's credential up.
    expect(document.body.textContent).not.toContain(PASSWORD);
  });

  it('is never written to browser storage', async () => {
    await openNewUser({ [CREATE_USER_ROUTE]: json(createdUser(), 201) });

    fillNewUserForm();
    submitNewUserForm();
    await screen.findByRole('alert');
    await settle();

    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe('after the account is created', () => {
  it('names the person and the username they were given', async () => {
    await openNewUser({
      [CREATE_USER_ROUTE]: json(
        createdUser({ username: 'nadege.l', displayName: 'Nadege Louis' }),
        201,
      ),
    });

    fillNewUserForm();
    submitNewUserForm();

    const outcome = await screen.findByRole('alert');
    expect(outcome).toHaveTextContent('Nadege Louis');
    expect(outcome).toHaveTextContent('nadege.l');
  });

  it('offers to create another, and comes back to an empty form', async () => {
    const { api } = await openNewUser({ [CREATE_USER_ROUTE]: json(createdUser(), 201) });

    fillNewUserForm();
    submitNewUserForm();
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: ht['users.createAnother'] }));

    const username = await screen.findByLabelText(ht['users.username']);
    expect(username).toHaveValue('');
    expect(screen.getByLabelText(ht['users.displayName'])).toHaveValue('');
    expect(screen.getByLabelText(ht['users.password'])).toHaveValue('');
    // And nothing was sent by starting again.
    expect(api.to(CREATE_USER_ROUTE)).toHaveLength(1);
  });

  it('does not submit twice while the first request is in flight', async () => {
    // Held open deliberately, because the window this guards is exactly the one
    // where the answer has not arrived — an impatient second press at a counter
    // must not try to create the same person again.
    const inFlight = deferred();
    const { api } = await openNewUser({ [CREATE_USER_ROUTE]: inFlight.responder });

    fillNewUserForm();
    // The same element both times: its label changes to "creating…" while the
    // request is open, which is how somebody can see that pressing again is
    // not needed.
    const button = screen.getByRole('button', { name: ht['users.submit'] });
    fireEvent.click(button);
    expect(button).toHaveTextContent(ht['users.submitting']);
    fireEvent.click(button);
    await settle();

    expect(api.to(CREATE_USER_ROUTE)).toHaveLength(1);

    inFlight.resolve(json(createdUser(), 201));
    await screen.findByRole('alert');
    expect(api.to(CREATE_USER_ROUTE)).toHaveLength(1);
  });
});

describe('when the server refuses', () => {
  it('says a taken username is taken, and keeps what was typed', async () => {
    await openNewUser({ [CREATE_USER_ROUTE]: apiFailure('CONFLICT', 409) });

    fillNewUserForm({ username: 'nadege.l' });
    submitNewUserForm();

    expect(await screen.findByText(ht['users.usernameTaken'])).toBeInTheDocument();
    // The remedy is to change one field, so the rest of the form survives —
    // and the generic "start again from a fresh list" is not what is said.
    expect(screen.getByLabelText(ht['users.displayName'])).toHaveValue('Nadege Louis');
    expect(screen.queryByText(ht['error.resourceInactive'])).not.toBeInTheDocument();
  });

  it('shows the forbidden message on a 403 without signing anybody out', async () => {
    await openNewUser({ [CREATE_USER_ROUTE]: apiFailure('FORBIDDEN', 403) });

    fillNewUserForm();
    submitNewUserForm();

    expect(await screen.findByText(ht['error.forbidden'])).toBeInTheDocument();
    // Still signed in: a denial is not a session problem.
    expect(screen.getByText('Marie Joseph')).toBeInTheDocument();
  });

  it('reports a lost connection as one', async () => {
    await openNewUser({ [CREATE_USER_ROUTE]: offline() });

    fillNewUserForm();
    submitNewUserForm();

    expect(await screen.findByText(ht['error.network'])).toBeInTheDocument();
  });

  it('does not retry a failed creation by itself', async () => {
    // Writes are never retried automatically. Creating a person twice because
    // a response was slow is exactly what that rule exists to prevent.
    const { api } = await openNewUser({ [CREATE_USER_ROUTE]: apiFailure('INTERNAL', 500) });

    fillNewUserForm();
    submitNewUserForm();
    await screen.findByRole('alert');
    await settle();

    expect(api.to(CREATE_USER_ROUTE)).toHaveLength(1);
  });
});

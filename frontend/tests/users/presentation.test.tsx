import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ROLES } from '@ekon/shared';
import ht from '../../src/i18n/ht.json';
import { translate } from '../../src/i18n/index.js';
import { apiFailure, deferred, json, offline } from '../helpers/fetchMock.js';
import { settle } from '../helpers/renderApp.js';
import {
  CREATE_USER_ROUTE,
  createdUser,
  createUserRequests,
  fillNewUserForm,
  openNewUser,
  submitNewUserForm,
} from '../helpers/users.js';

/**
 * How account creation reads on screen.
 *
 * The workflow itself is asserted next door in `form.test.tsx` and the door in
 * `access.test.tsx`, and nothing here may weaken either. What this file is
 * about is that the screen stayed the one small thing it is — four fields and a
 * button, not the beginning of a staff directory — that the credential never
 * comes back after the account exists, and that a refusal says which of the
 * four kinds of refusal it was.
 */

const PASSWORD = 'zoranj kokoye diri';

function form(): HTMLElement {
  return screen.getByRole('form', { name: ht['users.title'] });
}

describe('the form', () => {
  it('is exactly the four fields the contract accepts, and no others', async () => {
    await openNewUser();

    const controls = [...form().querySelectorAll('input, select, textarea')];
    expect(controls.map((element) => element.getAttribute('name'))).toEqual([
      'username',
      'displayName',
      'password',
      'role',
    ]);
    // No email, no phone, no job title, no second password to confirm, and no
    // account-status selector. The contract accepts four fields and the form
    // offers four.
    expect(controls).toHaveLength(4);
  });

  it('labels every field, and never uses a placeholder as one', async () => {
    await openNewUser();

    for (const key of [
      'users.username',
      'users.displayName',
      'users.password',
      'users.role',
    ] as const) {
      expect(screen.getByLabelText(ht[key]), key).toBeInTheDocument();
    }
    for (const element of form().querySelectorAll('input, select')) {
      expect(element.getAttribute('placeholder')).toBeNull();
    }
  });

  it('describes each field with the rule that applies to it', async () => {
    await openNewUser();

    expect(screen.getByText(ht['users.usernameHint'])).toBeInTheDocument();
    expect(screen.getByText(ht['users.displayNameHint'])).toBeInTheDocument();
    expect(
      screen.getByText(translate('ht', 'users.passwordHint', { min: 10 })),
    ).toBeInTheDocument();
    expect(screen.getByText(ht['users.roleHint'])).toBeInTheDocument();

    expect(screen.getByLabelText(ht['users.username'])).toHaveAttribute(
      'aria-describedby',
      'new-user-username-hint',
    );
  });

  it('swaps the hint for the reason when a field is refused', async () => {
    await openNewUser();
    fillNewUserForm({ username: 'ab' });
    submitNewUserForm();

    const field = await screen.findByLabelText(ht['users.username']);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAttribute('aria-describedby', 'new-user-username-error');
    // The rule it broke replaces the rule it was given; the form does not grow.
    expect(screen.queryByText(ht['users.usernameHint'])).toBeNull();
  });

  it('names every role in words, in the order the shared vocabulary declares', async () => {
    await openNewUser();

    const select = screen.getByLabelText(ht['users.role']) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([...ROLES]);
    expect([...select.options].map((option) => option.textContent)).toEqual([
      ht['role.SUPER_ADMIN'],
      ht['role.OWNER'],
      ht['role.MANAGER'],
      ht['role.EMPLOYEE'],
    ]);
    // No raw enum reaches the person choosing.
    expect(select.textContent ?? '').not.toMatch(/SUPER_ADMIN|EMPLOYEE|MANAGER|OWNER/);
  });

  it('offers no capability editor, and no account management of any kind', async () => {
    // The whole of user management in this milestone is creating one account.
    // A control that listed, edited, deactivated, or reset anybody would be a
    // feature this PR was explicitly not allowed to invent.
    await openNewUser();

    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(within(form()).getAllByRole('button')).toHaveLength(1);
    expect(within(form()).getByRole('button')).toHaveAccessibleName(ht['users.submit']);
    expect(document.body.textContent ?? '').not.toMatch(/capabilit|kapasite|capacité/i);
  });
});

describe('while the account is being created', () => {
  it('reports the request as busy rather than as unavailable', async () => {
    const inFlight = deferred();
    await openNewUser({ [CREATE_USER_ROUTE]: inFlight.responder });

    fillNewUserForm();
    submitNewUserForm();

    const button = await screen.findByRole('button', { name: ht['users.submitting'] });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
    expect(form()).toHaveAttribute('aria-busy', 'true');

    inFlight.resolve(json(createdUser(), 201));
    await screen.findByRole('status');
  });

  it('keeps what was typed, so nothing has to be entered twice', async () => {
    const inFlight = deferred();
    await openNewUser({ [CREATE_USER_ROUTE]: inFlight.responder });

    fillNewUserForm({ displayName: 'Nadege Louis' });
    submitNewUserForm();
    await screen.findByRole('button', { name: ht['users.submitting'] });

    expect(screen.getByLabelText(ht['users.displayName'])).toHaveValue('Nadege Louis');
    expect(screen.getByLabelText(ht['users.username'])).toHaveValue('nadege.l');

    inFlight.resolve(json(createdUser(), 201));
    await screen.findByRole('status');
  });
});

describe('the confirmation', () => {
  async function created(overrides: Parameters<typeof createdUser>[0] = {}): Promise<void> {
    await openNewUser({ [CREATE_USER_ROUTE]: json(createdUser(overrides), 201) });
    fillNewUserForm();
    submitNewUserForm();
    await screen.findByRole('status');
  }

  /**
   * A confirmed write is announced politely, as every other one in the
   * application is: receiving, removal, and product creation all report success
   * through `role="status"`. This screen used to be the single outlier with an
   * assertive `alert`, which interrupts whatever a screen reader is mid-sentence
   * on to deliver good news that focus is already moving to.
   */
  it('announces success politely, not as an alert', async () => {
    await created();

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names the person, the username they will type, and the role they were given', async () => {
    await created({ username: 'nadege.l', displayName: 'Nadege Louis', role: 'MANAGER' });

    const outcome = screen.getByRole('status');
    expect(outcome).toHaveTextContent(ht['users.createdLabel']);
    expect(outcome).toHaveTextContent(translate('ht', 'users.success', { name: 'Nadege Louis' }));
    expect(outcome).toHaveTextContent('nadege.l');
    // The role in words, not the code the identity module stores.
    expect(outcome).toHaveTextContent(ht['role.MANAGER']);
    expect(outcome.textContent ?? '').not.toContain('MANAGER');
  });

  /**
   * The assertion this screen exists to keep.
   *
   * The initial password was chosen for somebody else, on a laptop other people
   * sit down at. It is in component state while it is typed and in the request
   * body when it is sent, and after that it is gone — so it cannot be read off
   * the confirmation, off a hidden field, or out of storage.
   */
  it('never shows the password again, anywhere', async () => {
    await created();

    expect(screen.getByRole('status').textContent ?? '').not.toContain(PASSWORD);
    expect(document.body.textContent ?? '').not.toContain(PASSWORD);
    expect(document.body.innerHTML).not.toContain(PASSWORD);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('shows no database identifier as business data', async () => {
    // The response carries an id and a created timestamp. Neither is something
    // anybody can act on, and an id on screen is an id somebody gets asked to
    // read out over the phone.
    await created({ id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c01' });

    const outcome = screen.getByRole('status');
    expect(outcome.textContent ?? '').not.toContain('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c01');
  });

  it('replaces the form, so the same person cannot be created again by reflex', async () => {
    await created();

    expect(screen.queryByLabelText(ht['users.password'])).toBeNull();
    expect(screen.getByRole('button', { name: ht['users.createAnother'] })).toBeInTheDocument();
  });

  it('does not depend on the colour green to say it worked', async () => {
    await created({ displayName: 'Nadege Louis' });
    // A sentence, read identically by somebody who cannot tell green from grey.
    expect(
      screen.getByText(translate('ht', 'users.success', { name: 'Nadege Louis' })),
    ).toBeInTheDocument();
  });
});

describe('starting another account', () => {
  it('comes back to an empty form and sends nothing on its own', async () => {
    const { api } = await openNewUser({ [CREATE_USER_ROUTE]: json(createdUser(), 201) });

    fillNewUserForm({ role: 'MANAGER' });
    submitNewUserForm();
    await screen.findByRole('status');

    fireEvent.click(screen.getByRole('button', { name: ht['users.createAnother'] }));
    await settle();

    expect(screen.getByLabelText(ht['users.username'])).toHaveValue('');
    expect(screen.getByLabelText(ht['users.displayName'])).toHaveValue('');
    expect(screen.getByLabelText(ht['users.password'])).toHaveValue('');
    // Back to the ordinary role, rather than the one the previous account got.
    expect(screen.getByLabelText(ht['users.role'])).toHaveValue('EMPLOYEE');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.to(CREATE_USER_ROUTE)).toHaveLength(1);
  });

  it('is a genuinely fresh request when it is submitted', async () => {
    const { api } = await openNewUser({ [CREATE_USER_ROUTE]: json(createdUser(), 201) });

    fillNewUserForm();
    submitNewUserForm();
    await screen.findByRole('status');

    fireEvent.click(screen.getByRole('button', { name: ht['users.createAnother'] }));
    fillNewUserForm({ username: 'jean.b', displayName: 'Jean Baptiste' });
    submitNewUserForm();
    await screen.findByRole('status');

    const [first, second] = createUserRequests(api);
    expect(second).not.toEqual(first);
    expect(second?.username).toBe('jean.b');
    // Still no operation id: this is not a ledger command, and a repeat is a
    // duplicate username rather than a replay.
    for (const request of api.to(CREATE_USER_ROUTE)) {
      expect(Object.keys(request.headers).map((name) => name.toLowerCase())).not.toContain(
        'x-ekon-operation-id',
      );
      expect(request.body).not.toHaveProperty('operationId');
    }
  });
});

describe('the four ways this can be refused', () => {
  it('says a taken username is taken, and offers no way to send it again', async () => {
    await openNewUser({ [CREATE_USER_ROUTE]: apiFailure('CONFLICT', 409) });

    fillNewUserForm();
    submitNewUserForm();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ht['users.usernameTaken']);
    // Not the generic conflict sentence the inventory screens use, and never
    // the server's English.
    expect(alert).not.toHaveTextContent(ht['error.resourceInactive']);
    expect(alert).not.toHaveTextContent('English:');

    // The account was not created under that name. The remedy is one field,
    // not a resend — so the form is still here, still filled in, and the only
    // way forward is the ordinary submit.
    expect(screen.getByLabelText(ht['users.displayName'])).toHaveValue('Nadege Louis');
    expect(
      within(form())
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([ht['users.submit'], ht['action.cancel']]);
  });

  it('keeps a 403 a refusal rather than a login problem', async () => {
    await openNewUser({ [CREATE_USER_ROUTE]: apiFailure('FORBIDDEN', 403, 'req-forbidden') });

    fillNewUserForm();
    submitNewUserForm();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ht['error.forbidden']);
    expect(alert).toHaveTextContent('req-forbidden');
    // Still signed in, still inside the shell, still able to leave.
    expect(screen.getByText('Marie Joseph')).toBeInTheDocument();
    expect(screen.queryByLabelText(ht['auth.password'])).toBeNull();
  });

  /**
   * A 401 ends the session, and takes the form with it.
   *
   * The application has one rule for this and every protected request obeys it:
   * reads through `useProtectedQuery`, and writes through the same
   * `reportSessionEnded` that receiving and removal call. Account creation is
   * not an exception — a form left standing over an ended session is an
   * invitation to type a colleague's initial password into a request that
   * cannot succeed, and it tells somebody at the counter they are signed in
   * when the server has already said otherwise.
   */
  it('ends the session on a 401, and takes the form with it', async () => {
    await openNewUser({ [CREATE_USER_ROUTE]: apiFailure('SESSION_EXPIRED', 401) });

    fillNewUserForm();
    submitNewUserForm();

    // The same state the rest of the application reaches: the login screen,
    // saying why, because this browser watched the session end.
    await screen.findByLabelText(ht['auth.username']);
    expect(screen.getByText(ht['error.sessionExpired'])).toBeInTheDocument();

    // Nothing protected is left mounted — not the form, not the person it was
    // showing, not the shell around it.
    expect(screen.queryByLabelText(ht['users.password'])).toBeNull();
    expect(screen.queryByRole('form', { name: ht['users.title'] })).toBeNull();
    expect(screen.queryByText('Marie Joseph')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: ht['auth.signOut'] })).toBeNull();
  });

  /**
   * An answer that never arrived, handled the only safe way this route allows.
   *
   * There is no operation id, so a resend is not a replay — it is a second
   * attempt to create the same person. What makes that safe is the username's
   * UNIQUE constraint: submitting again either creates the account, because the
   * first attempt never landed, or is answered `409`, which is the database
   * confirming that it did. So no retry button is offered and nothing is sent
   * automatically; the ordinary submit already resolves the ambiguity.
   */
  it.each([
    ['a dropped connection', offline(), ht['error.network']],
    ['a server fault', apiFailure('INTERNAL', 500), ht['error.generic']],
  ])(
    'leaves %s to the ordinary submit, and retries nothing',
    async (_label, responder, message) => {
      const { api } = await openNewUser({ [CREATE_USER_ROUTE]: responder });

      fillNewUserForm();
      submitNewUserForm();

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      await settle();

      expect(api.to(CREATE_USER_ROUTE)).toHaveLength(1);
      // What was typed survives, because sending it again is the way forward.
      expect(screen.getByLabelText(ht['users.username'])).toHaveValue('nadege.l');
      expect(screen.getByLabelText(ht['users.password'])).toHaveValue(PASSWORD);
      // And nothing invites a blind resend under a promise of idempotency.
      expect(within(form()).getAllByRole('button')).toHaveLength(2);
    },
  );

  it('clears the refusal without discarding what was typed', async () => {
    await openNewUser({ [CREATE_USER_ROUTE]: apiFailure('INTERNAL', 500) });

    fillNewUserForm();
    submitNewUserForm();
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: ht['action.cancel'] }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText(ht['users.displayName'])).toHaveValue('Nadege Louis');
  });
});

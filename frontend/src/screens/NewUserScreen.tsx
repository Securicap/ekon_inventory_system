import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  PASSWORD_INPUT_MAX_LENGTH,
  PASSWORD_INPUT_MIN_LENGTH,
  ROLES,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  createUserRequestSchema,
  type CreatedUser,
  type Role,
} from '@ekon/shared';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { PRIMARY_BUTTON, SECONDARY_BUTTON, TEXT_INPUT } from '../components/styles.js';
import { useTranslator, type MessageKey } from '../i18n/index.js';
import { ApiError } from '../lib/api.js';
import { validateNewUserForm, type NewUserFieldErrors } from '../lib/users.js';
import { createUser } from '../lib/usersApi.js';

/**
 * Giving somebody an account, so they can sign in and do their job.
 *
 * The whole of user management in this milestone, and it is one form on
 * purpose. There is no list of people, no search, no editing, no role change,
 * no deactivation, and no password reset — each of those is a separate
 * authority over somebody's access and deserves to be decided on its own rather
 * than arriving as a side effect of the screen that hires them. What the
 * business needed to open for the day was the ability to create an account; it
 * is the only thing here.
 *
 * Reached only by somebody holding `identity.manage` — the shell does not draw
 * the door otherwise, and the server refuses the request regardless of what the
 * browser drew.
 *
 * **The password exists in this component's state while it is typed and in the
 * request body when it is sent, and nowhere else.** Not in a query key, not in
 * a URL, not in storage, and not in the confirmation: once the account is
 * created the screen cannot show it again, which is why the field says so
 * before it is submitted. A shared shop laptop that remembered a colleague's
 * initial password would be a credential left on a counter.
 */

/** Where a single attempt has got to. */
type Phase = 'editing' | 'created';

/**
 * Roles are shown in the order the shared vocabulary declares them, which runs
 * from most authority to least. The list is `ROLES` itself rather than a copy:
 * a role added to the system without a label here would be a compile error at
 * `ROLE_LABEL_KEYS`, not a silently missing option.
 *
 * Every role is offered because no account a holder of `identity.manage` can
 * create outranks them — they hold every capability already, which is asserted
 * in the backend's capability tests. The server accepts the same closed set, so
 * this list and that one cannot drift into a UI that offers a refused choice.
 */
const ROLE_LABEL_KEYS: Readonly<Record<Role, MessageKey>> = {
  SUPER_ADMIN: 'role.SUPER_ADMIN',
  OWNER: 'role.OWNER',
  MANAGER: 'role.MANAGER',
  EMPLOYEE: 'role.EMPLOYEE',
};

/** What a new account starts as, and what the form returns to after one. */
const EMPTY = { username: '', displayName: '', password: '', role: 'EMPLOYEE' as const };

export function NewUserScreen() {
  const t = useTranslator();

  const [username, setUsername] = useState(EMPTY.username);
  const [displayName, setDisplayName] = useState(EMPTY.displayName);
  const [password, setPassword] = useState(EMPTY.password);
  const [role, setRole] = useState<string>(EMPTY.role);

  const [fieldErrors, setFieldErrors] = useState<NewUserFieldErrors>({});
  const [phase, setPhase] = useState<Phase>('editing');
  /** The account that was created. Only ever set from a response. */
  const [created, setCreated] = useState<CreatedUser | null>(null);

  const usernameRef = useRef<HTMLInputElement>(null);
  const displayNameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const roleRef = useRef<HTMLSelectElement>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);

  const submit = useMutation({
    mutationFn: createUser,
    onSuccess: (user) => {
      setCreated(user);
      setPhase('created');
      // The credential leaves the browser the moment it is no longer needed.
      // Nothing on the confirmation shows it, and nothing can now put it back
      // on screen for whoever sits down at this laptop next.
      setPassword('');
      setUsername(EMPTY.username);
      setDisplayName(EMPTY.displayName);
      setRole(EMPTY.role);
    },
  });

  // The outcome — created, or refused — is announced by its `role="alert"`;
  // moving focus there as well means somebody navigating by keyboard lands on
  // the answer rather than on a form that appears to have done nothing.
  useEffect(() => {
    if (phase === 'created' || submit.isError) outcomeRef.current?.focus();
  }, [phase, submit.isError]);

  function startAnother(): void {
    setPhase('editing');
    setCreated(null);
    setFieldErrors({});
    submit.reset();
    usernameRef.current?.focus();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    // A second submission of a request already in flight would try to create
    // the same person twice, and the second would be answered as a duplicate.
    if (submit.isPending) return;

    const values = { username, displayName, password, role };
    const errors = validateNewUserForm(values);

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      submit.reset();
      const firstInvalid = errors.username
        ? usernameRef
        : errors.displayName
          ? displayNameRef
          : errors.password
            ? passwordRef
            : roleRef;
      firstInvalid.current?.focus();
      return;
    }

    /**
     * Parsed with the *shared* schema, which is what actually goes on the wire
     * — so the username is normalized exactly as the server would normalize it,
     * and a request that somehow carried a field the server owns would fail
     * here rather than be refused after a round trip.
     *
     * A failure at this point means the form's own validation and the contract
     * disagree, which is a bug rather than something the person can fix. It is
     * handled as a field error on the username, the field it could plausibly
     * concern, rather than thrown into a render.
     */
    const parsed = createUserRequestSchema.safeParse(values);
    if (!parsed.success) {
      setFieldErrors({ username: 'users.usernameInvalid' });
      usernameRef.current?.focus();
      return;
    }

    setFieldErrors({});
    submit.mutate(parsed.data);
  }

  if (phase === 'created' && created) {
    return (
      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">{t('users.title')}</h2>

        <div
          ref={outcomeRef}
          tabIndex={-1}
          role="alert"
          className="flex flex-col items-start gap-2 rounded-md border border-green-700 bg-green-50 px-4 py-3 text-green-900"
        >
          <p className="font-medium">{t('users.success', { name: created.displayName })}</p>
          {/* The username, because they will need to be told it. Never the
              password: it was theirs to be given in person, and this screen
              is a shared laptop at a counter. */}
          <p>{t('users.successHint', { username: created.username })}</p>
        </div>

        <div>
          <button type="button" className={PRIMARY_BUTTON} onClick={startAnother}>
            {t('users.createAnother')}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-semibold">{t('users.title')}</h2>
        <p className="text-slate-600">{t('users.description')}</p>
      </div>

      <form
        onSubmit={handleSubmit}
        noValidate
        className="flex max-w-md flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4"
      >
        {submit.isError && (
          <div ref={outcomeRef} tabIndex={-1}>
            {isUsernameTaken(submit.error) ? (
              <p
                role="alert"
                className="rounded-md border border-red-700 bg-red-50 px-4 py-3 text-red-900"
              >
                {t('users.usernameTaken')}
              </p>
            ) : (
              <ErrorNotice error={submit.error} />
            )}
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label htmlFor="new-user-username" className="font-medium">
            {t('users.username')}
          </label>
          <input
            id="new-user-username"
            ref={usernameRef}
            name="username"
            type="text"
            /* Somebody is creating an account for another person. The browser
               must not offer this laptop's own saved username, and must not be
               invited to remember what is typed as a credential of its own. */
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={USERNAME_MAX_LENGTH}
            minLength={USERNAME_MIN_LENGTH}
            required
            className={TEXT_INPUT}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            aria-invalid={fieldErrors.username ? true : undefined}
            aria-describedby={
              fieldErrors.username ? 'new-user-username-error' : 'new-user-username-hint'
            }
          />
          {fieldErrors.username ? (
            <p id="new-user-username-error" className="text-red-800">
              {t(fieldErrors.username, { min: USERNAME_MIN_LENGTH, max: USERNAME_MAX_LENGTH })}
            </p>
          ) : (
            <p id="new-user-username-hint" className="text-sm text-slate-600">
              {t('users.usernameHint')}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="new-user-display-name" className="font-medium">
            {t('users.displayName')}
          </label>
          <input
            id="new-user-display-name"
            ref={displayNameRef}
            name="displayName"
            type="text"
            autoComplete="off"
            required
            className={TEXT_INPUT}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            aria-invalid={fieldErrors.displayName ? true : undefined}
            aria-describedby={fieldErrors.displayName ? 'new-user-display-name-error' : undefined}
          />
          {fieldErrors.displayName && (
            <p id="new-user-display-name-error" className="text-red-800">
              {t(fieldErrors.displayName, { max: 120 })}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="new-user-password" className="font-medium">
            {t('users.password')}
          </label>
          <input
            id="new-user-password"
            ref={passwordRef}
            name="password"
            type="password"
            /* `new-password`, never `current-password`: this is not the
               signed-in person's own credential, and a browser that filed it
               under theirs would offer it back at the login form. */
            autoComplete="new-password"
            maxLength={PASSWORD_INPUT_MAX_LENGTH}
            required
            className={TEXT_INPUT}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={fieldErrors.password ? true : undefined}
            aria-describedby={
              fieldErrors.password ? 'new-user-password-error' : 'new-user-password-hint'
            }
          />
          {fieldErrors.password ? (
            <p id="new-user-password-error" className="text-red-800">
              {t(fieldErrors.password, {
                min: PASSWORD_INPUT_MIN_LENGTH,
                max: PASSWORD_INPUT_MAX_LENGTH,
              })}
            </p>
          ) : (
            <p id="new-user-password-hint" className="text-sm text-slate-600">
              {t('users.passwordHint', { min: PASSWORD_INPUT_MIN_LENGTH })}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="new-user-role" className="font-medium">
            {t('users.role')}
          </label>
          <select
            id="new-user-role"
            ref={roleRef}
            name="role"
            required
            className={TEXT_INPUT}
            value={role}
            onChange={(event) => setRole(event.target.value)}
            aria-invalid={fieldErrors.role ? true : undefined}
            aria-describedby={fieldErrors.role ? 'new-user-role-error' : 'new-user-role-hint'}
          >
            {ROLES.map((option) => (
              <option key={option} value={option}>
                {t(ROLE_LABEL_KEYS[option])}
              </option>
            ))}
          </select>
          {fieldErrors.role ? (
            <p id="new-user-role-error" className="text-red-800">
              {t(fieldErrors.role)}
            </p>
          ) : (
            <p id="new-user-role-hint" className="text-sm text-slate-600">
              {t('users.roleHint')}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="submit" className={PRIMARY_BUTTON} disabled={submit.isPending}>
            {submit.isPending ? t('users.submitting') : t('users.submit')}
          </button>
          {submit.isError && (
            <button type="button" className={SECONDARY_BUTTON} onClick={startAnother}>
              {t('action.cancel')}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

/**
 * The one failure this screen says something specific about.
 *
 * A `409` from this route means exactly one thing — the username is taken — and
 * the remedy is to pick another, which is a sentence beside the field rather
 * than the generic "start again with a fresh list" that `CONFLICT` means on the
 * inventory screens. Everything else goes to the shared `ErrorNotice`, which
 * already handles `401`, `403`, the network, and the unexpected.
 */
function isUsernameTaken(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === 'CONFLICT';
}

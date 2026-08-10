import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  DISPLAY_NAME_MAX_LENGTH,
  PASSWORD_INPUT_MAX_LENGTH,
  PASSWORD_INPUT_MIN_LENGTH,
  ROLES,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  createUserRequestSchema,
  type CreatedUser,
  type Role,
} from '@ekon/shared';
import { useAuth } from '../auth/useAuth.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { PageHeader } from '../components/PageHeader.js';
import {
  FIELD_ERROR,
  FIELD_HINT,
  FIELD_LABEL,
  PANEL,
  PRIMARY_BUTTON,
  PRIMARY_BUTTON_BUSY,
  SECONDARY_BUTTON,
  TEXT_INPUT,
} from '../components/styles.js';
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
 * is the only thing here, and the redesign deliberately did not widen it.
 *
 * So this is a narrow panel rather than the full content region. The four
 * fields are the whole command, a page-wide form would imply the rest of a
 * staff directory that does not exist, and a line of text is easier to read
 * when it is not a metre long.
 *
 * Reached only by somebody holding `identity.manage` — the shell does not draw
 * the door otherwise, and the server refuses the request regardless of what the
 * browser drew. The role chosen *in* the form is account data and nothing more:
 * it decides what the new person may do once the server resolves it into
 * capabilities, and nothing anywhere in this application reads a role to decide
 * what to draw.
 *
 * **This is not a ledger command and carries no operation id.** Receiving may
 * be pressed again after a dropped connection because the server recognizes the
 * repeat; there is no such contract on this route. What stands in for it is the
 * username's UNIQUE constraint: a second attempt with the same username is
 * answered `409`, which is the database saying the first one worked. So nothing
 * here retries, automatically or by offering a button.
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
  const { reportSessionEnded } = useAuth();

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
    onError: (error) => {
      // A mutation is a protected request like any other, and a 401 back from
      // one means the same thing it means on a read: the session ended. Reads
      // go through `useProtectedQuery`; receiving and removal say this same
      // line for their writes, and account creation is no different — a form
      // left standing over an ended session invites somebody to type a
      // colleague's initial password into a request that cannot succeed.
      //
      // A 403 is deliberately not here. Somebody signed in who may not do this
      // is told so in place; signing in again would change nothing.
      if (error instanceof ApiError && error.status === 401) reportSessionEnded();
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

  return (
    <section className="flex flex-col gap-6">
      <PageHeader title={t('users.title')} subtitle={t('users.description')} />

      {/* Narrow on purpose, and the same width in both phases so confirming an
          account does not move the page under the reader. */}
      <div className="w-full max-w-[620px]">
        {phase === 'created' && created ? (
          <div className="flex flex-col gap-5">
            <Confirmation ref={outcomeRef} user={created} />

            <div>
              <button type="button" className={PRIMARY_BUTTON} onClick={startAnother}>
                {t('users.createAnother')}
              </button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            noValidate
            aria-label={t('users.title')}
            aria-busy={submit.isPending}
            className={`${PANEL} flex flex-col gap-5`}
          >
            {submit.isError && (
              <div ref={outcomeRef} tabIndex={-1}>
                {/* A taken username is a definitive refusal of one field, and
                    the remedy is to change that field — so it is said as its
                    own sentence rather than as the generic notice, and no
                    resend is offered. Everything else is the shared notice,
                    which already handles the session, the refusal, the network,
                    and the unexpected. */}
                {isUsernameTaken(submit.error) ? (
                  <p
                    role="alert"
                    className="rounded-md border border-danger bg-danger-soft px-3.5 py-3 text-[15px] font-semibold text-pretty text-danger-ink"
                  >
                    {t('users.usernameTaken')}
                  </p>
                ) : (
                  <ErrorNotice error={submit.error} />
                )}
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <label htmlFor="new-user-username" className={FIELD_LABEL}>
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
                <p id="new-user-username-error" className={FIELD_ERROR}>
                  {t(fieldErrors.username, { min: USERNAME_MIN_LENGTH, max: USERNAME_MAX_LENGTH })}
                </p>
              ) : (
                <p id="new-user-username-hint" className={FIELD_HINT}>
                  {t('users.usernameHint')}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5 border-t border-rule pt-5">
              <label htmlFor="new-user-display-name" className={FIELD_LABEL}>
                {t('users.displayName')}
              </label>
              <input
                id="new-user-display-name"
                ref={displayNameRef}
                name="displayName"
                type="text"
                autoComplete="off"
                maxLength={DISPLAY_NAME_MAX_LENGTH}
                required
                className={TEXT_INPUT}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                aria-invalid={fieldErrors.displayName ? true : undefined}
                aria-describedby={
                  fieldErrors.displayName
                    ? 'new-user-display-name-error'
                    : 'new-user-display-name-hint'
                }
              />
              {fieldErrors.displayName ? (
                <p id="new-user-display-name-error" className={FIELD_ERROR}>
                  {t(fieldErrors.displayName, { max: DISPLAY_NAME_MAX_LENGTH })}
                </p>
              ) : (
                /* One field, not a first and last name. It is the name Ekon
                   shows beside what this person does, and the shop writes it
                   the way the shop says it. */
                <p id="new-user-display-name-hint" className={FIELD_HINT}>
                  {t('users.displayNameHint')}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5 border-t border-rule pt-5">
              <label htmlFor="new-user-password" className={FIELD_LABEL}>
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
                <p id="new-user-password-error" className={FIELD_ERROR}>
                  {t(fieldErrors.password, {
                    min: PASSWORD_INPUT_MIN_LENGTH,
                    max: PASSWORD_INPUT_MAX_LENGTH,
                  })}
                </p>
              ) : (
                /* The only rule there is, said once: a length. No composition
                   requirements, no strength meter, and no generated password —
                   the first reliably produces `Password1!`, and the last would
                   have to be displayed somewhere to be usable. */
                <p id="new-user-password-hint" className={FIELD_HINT}>
                  {t('users.passwordHint', { min: PASSWORD_INPUT_MIN_LENGTH })}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5 border-t border-rule pt-5">
              <label htmlFor="new-user-role" className={FIELD_LABEL}>
                {t('users.role')}
              </label>
              {/* The words are translated; the value sent is the stable code the
                  identity module stores. Capabilities are not offered here and
                  never will be — they are resolved from the role on every
                  request, and a form that could name them would be a form that
                  grants permissions. */}
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
                <p id="new-user-role-error" className={FIELD_ERROR}>
                  {t(fieldErrors.role)}
                </p>
              ) : (
                <p id="new-user-role-hint" className={FIELD_HINT}>
                  {t('users.roleHint')}
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-3 border-t border-rule pt-5">
              {/* The button says what is happening, and it is where the keyboard
                  already is when it happens, so its own name is the
                  announcement. Busy, not unavailable: it keeps its colour and
                  carries a progress mark, because a grey button says "you may
                  not press this" when what is true is "this is working". */}
              <button
                type="submit"
                className={`${submit.isPending ? PRIMARY_BUTTON_BUSY : PRIMARY_BUTTON} min-h-touch-lg text-[17px]`}
                disabled={submit.isPending}
                aria-busy={submit.isPending}
              >
                {submit.isPending && (
                  <span
                    aria-hidden="true"
                    className="mr-2.5 inline-block size-3.5 animate-spin rounded-full border-2 border-white/45 border-t-white motion-reduce:animate-none"
                  />
                )}
                {submit.isPending ? t('users.submitting') : t('users.submit')}
              </button>

              {/* Clears the refusal and puts the keyboard back in the first
                  field. It does not empty the form: the remedy for almost every
                  failure here is to change one thing and send it again, and
                  discarding somebody's typing would be its own small disaster. */}
              {submit.isError && (
                <button
                  type="button"
                  className={`${SECONDARY_BUTTON} min-h-touch-lg`}
                  onClick={startAnother}
                >
                  {t('action.cancel')}
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

/**
 * The account that now exists, in the terms it was created with.
 *
 * The name, the username they will type, and the role they were given — which
 * is everything somebody has to pass on. **Never the password.** It was theirs
 * to be told in person, this is a shared laptop at a counter, and by the time
 * this renders the field holding it has already been emptied.
 *
 * Also absent: the account id and the created timestamp. Both come back in the
 * response and neither is something a person can act on; an id shown as
 * business data is an id somebody will eventually be asked to read out.
 *
 * `role="alert"` rather than `status`, which is what this screen has always
 * used — creating somebody's account is worth interrupting for, and the
 * existing tests hold the application to it.
 */
function Confirmation({ ref, user }: { ref: React.Ref<HTMLDivElement>; user: CreatedUser }) {
  const t = useTranslator();

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="flex flex-col gap-3 rounded-lg border border-success bg-success-soft p-5"
    >
      {/* Sentences, not a colour. Somebody who cannot tell green from grey
          reads exactly the same confirmation. */}
      <div>
        <p className="text-xs font-bold tracking-[0.08em] text-success uppercase">
          {t('users.createdLabel')}
        </p>
        <p className="mt-1 text-[17px] font-semibold text-success-ink">
          {t('users.success', { name: user.displayName })}
        </p>
      </div>

      {/* The username, because they will need to be told it. */}
      <p className="text-base text-pretty text-success-ink">
        {t('users.successHint', { username: user.username })}
      </p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5 text-sm text-success-ink">
        <dt className="opacity-80">{t('users.username')}</dt>
        <dd className="font-semibold">{user.username}</dd>
        <dt className="opacity-80">{t('users.role')}</dt>
        <dd className="font-semibold">{t(ROLE_LABEL_KEYS[user.role])}</dd>
      </dl>
    </div>
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
 *
 * It is also the answer to "did my request get through?" after a dropped
 * connection. Sending the same account again is either created — because the
 * first attempt never landed — or refused as a duplicate, which is the database
 * confirming that it did. That is why there is no retry button: the ordinary
 * submit already resolves the ambiguity, and it resolves it truthfully.
 */
function isUsernameTaken(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === 'CONFLICT';
}

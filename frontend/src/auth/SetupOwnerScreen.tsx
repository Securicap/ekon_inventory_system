import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  PASSWORD_INPUT_MAX_LENGTH,
  PASSWORD_INPUT_MIN_LENGTH,
  setupOwnerRequestSchema,
  normalizeUsername,
} from '@ekon/shared';
import { Brand } from '../components/Brand.js';
import {
  FIELD_ERROR,
  FIELD_HINT,
  FIELD_LABEL,
  OUTCOME_FOCUS,
  PRIMARY_BUTTON,
  PRIMARY_BUTTON_BUSY,
  TEXT_INPUT,
} from '../components/styles.js';
import { useTranslator, type MessageKey } from '../i18n/index.js';
import { ApiError } from '../lib/api.js';
import { messageKeyForError } from '../lib/errorMessages.js';
import { setUpFirstOwner } from './authApi.js';
import { useAuth } from './useAuth.js';

/**
 * The first screen of a brand-new installation: create the owner.
 *
 * Somebody has just installed Ekon on the shop computer and opened the browser.
 * The database is empty, so there is no account to sign in to and nobody who
 * could be authorized to create one — a login form here would be a dead end.
 * This is the way out of that, and it exists for exactly as long as the `users`
 * table is empty: the moment the first owner is created, the server stops
 * offering it and answers `SETUP_COMPLETE` to anybody who tries.
 *
 * It is the login screen's twin by design — the same centred column, the same
 * mark at the same size, the same field styling — because the two are the first
 * and second things the same person sees, ninety seconds apart, and the second
 * should not look like a different product.
 *
 * **It does not sign anybody in.** The server returns no cookie, and on success
 * this hands over to the login form. That costs one extra step and buys
 * something worth more than the step: the password is proven to work, by being
 * typed into the form it will be typed into every morning, while the person who
 * chose it is still standing there. An installation whose only owner has a
 * password nobody can reproduce is an installation nobody can get into — there
 * is no self-service reset, and no second account to recover from.
 *
 * The confirmation field exists for the same reason, and only for that reason:
 * it is never sent, and it is the one place in this application where a typo is
 * unrecoverable without a database.
 */
export function SetupOwnerScreen() {
  const t = useTranslator();
  const { completeSetup } = useAuth();

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const usernameRef = useRef<HTMLInputElement>(null);
  const displayNameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  const setUp = useMutation({
    mutationFn: setUpFirstOwner,
    onSuccess: () => {
      // The credential leaves the browser the moment the account exists.
      setPassword('');
      setConfirmation('');
      completeSetup();
    },
  });

  useEffect(() => {
    if (setUp.isError) summaryRef.current?.focus();
  }, [setUp.isError]);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    // A second submission of a request already in flight would be a second
    // attempt to create the one account this route can ever create.
    if (setUp.isPending) return;

    /**
     * Validated with the *shared* schema — the same one the route parses — so
     * the browser and the server cannot disagree about what a username is or
     * how long a password must be. It normalizes as well as checks, so the
     * owner is created under the name they will sign in with.
     */
    const parsed = setupOwnerRequestSchema.safeParse({ username, displayName, password });

    const errors: FieldErrors = {};
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => issue.path[0]);
      if (paths.includes('username')) {
        errors.username =
          normalizeUsername(username) === '' ? 'setup.usernameRequired' : 'setup.usernameInvalid';
      }
      if (paths.includes('displayName')) {
        errors.displayName = 'setup.displayNameRequired';
      }
      if (paths.includes('password')) {
        errors.password = password === '' ? 'setup.passwordRequired' : 'setup.passwordTooShort';
      }
    }

    // Checked here and nowhere else: the confirmation is not part of the
    // command and never goes on the wire.
    if (errors.password === undefined && password !== confirmation) {
      errors.confirmation = 'setup.passwordMismatch';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setUp.reset();
      (errors.username
        ? usernameRef
        : errors.displayName
          ? displayNameRef
          : errors.password
            ? passwordRef
            : confirmationRef
      ).current?.focus();
      return;
    }

    setFieldErrors({});
    if (parsed.success) setUp.mutate(parsed.data);
  }

  return (
    <main className="flex flex-1 items-center justify-center p-4 md:p-6 lg:p-8">
      <div className="flex w-full max-w-100 flex-col gap-5">
        <Brand variant="hero" level={1} />

        <form
          onSubmit={handleSubmit}
          noValidate
          className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-6 shadow-panel"
        >
          <h2 className="text-lg font-semibold text-ink">{t('setup.heading')}</h2>
          <p className={FIELD_HINT}>{t('setup.description')}</p>

          {setUp.isError && (
            <div
              ref={summaryRef}
              tabIndex={-1}
              role="alert"
              className={`${OUTCOME_FOCUS} rounded-md border border-danger bg-danger-soft px-3.5 py-3 text-[15px] font-semibold text-danger-ink`}
            >
              {t(setupFailureMessageKey(setUp.error))}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label htmlFor="setup-username" className={FIELD_LABEL}>
              {t('setup.username')}
            </label>
            <input
              id="setup-username"
              ref={usernameRef}
              name="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              className={TEXT_INPUT}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              aria-invalid={fieldErrors.username ? true : undefined}
              aria-describedby={
                fieldErrors.username ? 'setup-username-error' : 'setup-username-hint'
              }
            />
            {fieldErrors.username ? (
              <p id="setup-username-error" className={FIELD_ERROR}>
                {t(fieldErrors.username)}
              </p>
            ) : (
              <p id="setup-username-hint" className={FIELD_HINT}>
                {t('setup.usernameHint')}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="setup-display-name" className={FIELD_LABEL}>
              {t('setup.displayName')}
            </label>
            <input
              id="setup-display-name"
              ref={displayNameRef}
              name="displayName"
              type="text"
              autoComplete="name"
              required
              className={TEXT_INPUT}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              aria-invalid={fieldErrors.displayName ? true : undefined}
              aria-describedby={fieldErrors.displayName ? 'setup-display-name-error' : undefined}
            />
            {fieldErrors.displayName && (
              <p id="setup-display-name-error" className={FIELD_ERROR}>
                {t(fieldErrors.displayName)}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="setup-password" className={FIELD_LABEL}>
              {t('setup.password')}
            </label>
            <input
              id="setup-password"
              ref={passwordRef}
              name="password"
              type="password"
              autoComplete="new-password"
              required
              className={TEXT_INPUT}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={fieldErrors.password ? true : undefined}
              aria-describedby={
                fieldErrors.password ? 'setup-password-error' : 'setup-password-hint'
              }
            />
            {fieldErrors.password ? (
              <p id="setup-password-error" className={FIELD_ERROR}>
                {t(fieldErrors.password, {
                  min: PASSWORD_INPUT_MIN_LENGTH,
                  max: PASSWORD_INPUT_MAX_LENGTH,
                })}
              </p>
            ) : (
              <p id="setup-password-hint" className={FIELD_HINT}>
                {t('setup.passwordHint', { min: PASSWORD_INPUT_MIN_LENGTH })}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="setup-confirmation" className={FIELD_LABEL}>
              {t('setup.confirmation')}
            </label>
            <input
              id="setup-confirmation"
              ref={confirmationRef}
              name="confirmation"
              type="password"
              autoComplete="new-password"
              required
              className={TEXT_INPUT}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              aria-invalid={fieldErrors.confirmation ? true : undefined}
              aria-describedby={fieldErrors.confirmation ? 'setup-confirmation-error' : undefined}
            />
            {fieldErrors.confirmation && (
              <p id="setup-confirmation-error" className={FIELD_ERROR}>
                {t(fieldErrors.confirmation)}
              </p>
            )}
          </div>

          <button
            type="submit"
            className={`${setUp.isPending ? PRIMARY_BUTTON_BUSY : PRIMARY_BUTTON} w-full`}
            disabled={setUp.isPending}
            aria-busy={setUp.isPending}
          >
            {setUp.isPending && (
              <span
                aria-hidden="true"
                className="mr-2.5 inline-block size-3.5 animate-spin rounded-full border-2 border-white/45 border-t-white motion-reduce:animate-none"
              />
            )}
            {setUp.isPending ? t('setup.submitting') : t('setup.submit')}
          </button>

          <p className={FIELD_HINT}>{t('setup.noReset')}</p>
        </form>
      </div>
    </main>
  );
}

interface FieldErrors {
  username?: MessageKey;
  displayName?: MessageKey;
  password?: MessageKey;
  confirmation?: MessageKey;
}

/**
 * What to say when setup was refused.
 *
 * `SETUP_COMPLETE` is the one worth its own sentence: somebody else set this
 * installation up — a second browser tab, a colleague, the operator command —
 * while this form was open. The remedy is to sign in, not to try again, and the
 * next `/api/auth/me` will put the login screen up anyway.
 */
function setupFailureMessageKey(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    if (error.code === 'SETUP_COMPLETE') return 'setup.alreadyComplete';
    if (error.status === 400) return 'setup.rejected';
  }
  return messageKeyForError(error);
}

import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { loginRequestSchema } from '@ekon/shared';
import { PRIMARY_BUTTON, TEXT_INPUT } from '../components/styles.js';
import { useTranslator, type MessageKey } from '../i18n/index.js';
import { ApiError } from '../lib/api.js';
import { messageKeyForError } from '../lib/errorMessages.js';
import { login } from './authApi.js';
import { useAuth } from './useAuth.js';

/**
 * The sign-in screen.
 *
 * A username, a password, and a button. There is deliberately no "remember me",
 * no "forgot password", no email field, no account creation, and no social
 * sign-in: sessions are twelve hours and absolute, there is no self-service
 * reset (an owner resets a password, in a later PR), and every account is
 * created from inside the application by somebody holding `identity.manage`.
 *
 * The password exists in this component's state while it is being typed and in
 * the request body when it is sent, and nowhere else — not in a query key, not
 * in a URL, not in storage, not in a log line. A failed attempt clears it.
 */
export function LoginScreen({ sessionEnded }: { sessionEnded: boolean }) {
  const t = useTranslator();
  const { completeSignIn } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  const signIn = useMutation({
    mutationFn: login,
    onSuccess: completeSignIn,
    // Not kept for a second attempt. What was typed was rejected, and leaving
    // it in the field invites pressing the same button again.
    onError: () => setPassword(''),
  });

  // A rejected sign-in is announced by the summary's `role="alert"`; moving
  // focus there as well means somebody navigating by keyboard lands on the
  // reason instead of on a form that silently did nothing.
  useEffect(() => {
    if (signIn.isError) summaryRef.current?.focus();
  }, [signIn.isError]);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    // A second submission of a request already in flight would mint a second
    // session for one intent.
    if (signIn.isPending) return;

    /**
     * Validated with the *shared* login schema — the same one the route parses
     * — so the browser and the server cannot disagree about what a username is.
     * It normalizes as well as checks: `" Marie.J "` is sent as `marie.j`, and
     * the password is passed through untouched, because trimming it would mean
     * the password somebody set is not the password that works.
     *
     * This is for immediate feedback and nothing else. The server validates
     * again and is the authority.
     */
    const parsed = loginRequestSchema.safeParse({ username, password });

    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => issue.path[0]);
      const errors: FieldErrors = {};
      if (paths.includes('username')) {
        errors.username = username.trim() === '' ? 'auth.usernameRequired' : 'auth.usernameInvalid';
      }
      if (paths.includes('password')) {
        errors.password = password === '' ? 'auth.passwordRequired' : 'auth.passwordTooShort';
      }
      setFieldErrors(errors);
      signIn.reset();
      (errors.username ? usernameRef : passwordRef).current?.focus();
      return;
    }

    setFieldErrors({});
    signIn.mutate(parsed.data);
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">{t('app.name')}</h1>
        <p className="text-slate-600">{t('app.tagline')}</p>
      </div>

      {sessionEnded && (
        <p
          role="status"
          className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-slate-900"
        >
          {t('error.sessionExpired')}
        </p>
      )}

      <form
        onSubmit={handleSubmit}
        noValidate
        className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-6"
      >
        <h2 className="text-lg font-medium">{t('auth.signInHeading')}</h2>

        {signIn.isError && (
          <div
            ref={summaryRef}
            tabIndex={-1}
            role="alert"
            className="rounded-md border border-red-700 bg-red-50 px-4 py-3 text-red-900"
          >
            {t(signInFailureMessageKey(signIn.error))}
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label htmlFor="login-username" className="font-medium">
            {t('auth.username')}
          </label>
          <input
            id="login-username"
            ref={usernameRef}
            name="username"
            type="text"
            /* The browser's own credential manager. Nothing this application
               writes; it never stores a credential itself. */
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            className={TEXT_INPUT}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            aria-invalid={fieldErrors.username ? true : undefined}
            aria-describedby={fieldErrors.username ? 'login-username-error' : undefined}
          />
          {fieldErrors.username && (
            <p id="login-username-error" className="text-red-800">
              {t(fieldErrors.username)}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="login-password" className="font-medium">
            {t('auth.password')}
          </label>
          <input
            id="login-password"
            ref={passwordRef}
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className={TEXT_INPUT}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={fieldErrors.password ? true : undefined}
            aria-describedby={fieldErrors.password ? 'login-password-error' : undefined}
          />
          {fieldErrors.password && (
            <p id="login-password-error" className="text-red-800">
              {t(fieldErrors.password)}
            </p>
          )}
        </div>

        <button type="submit" className={PRIMARY_BUTTON} disabled={signIn.isPending}>
          {signIn.isPending ? t('auth.signingIn') : t('auth.signIn')}
        </button>
      </form>
    </main>
  );
}

interface FieldErrors {
  username?: MessageKey;
  password?: MessageKey;
}

/**
 * One message for every rejected credential.
 *
 * An unknown username, a wrong password, and a deactivated account are all
 * `401` from the server and all read the same here. Anything that distinguished
 * them would turn this form into a way to ask which usernames exist and which
 * of those still work. A `400` means the shared schema and the route disagreed
 * about the input, which the person at the counter cannot act on either — it
 * gets the same sentence rather than a field-level hint about a credential.
 */
function signInFailureMessageKey(error: unknown): MessageKey {
  if (error instanceof ApiError && (error.status === 401 || error.status === 400)) {
    return 'auth.invalidCredentials';
  }
  return messageKeyForError(error);
}

import { useMutation } from '@tanstack/react-query';
import { SECONDARY_BUTTON } from '../components/styles.js';
import { useTranslator } from '../i18n/index.js';
import { logout } from './authApi.js';
import { useAuth } from './useAuth.js';

/**
 * Signing out, which means asking the server to revoke the session — not
 * forgetting about it here.
 *
 * A local-only sign-out would leave a live session on a shared shop laptop
 * while telling the person who walked away that they had ended it. So the
 * application changes nothing until the server has answered, and when the
 * request fails it says so and leaves them signed in. The button is the retry.
 *
 * The server answers `204` whether the session was live, already expired, or
 * already revoked, so success needs no interpretation: whatever the cookie held
 * is no longer usable.
 */
export function SignOutButton() {
  const t = useTranslator();
  const { completeSignOut } = useAuth();

  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: completeSignOut,
  });

  return (
    <div className="flex flex-col items-stretch gap-1">
      <button
        type="button"
        className={SECONDARY_BUTTON}
        disabled={signOut.isPending}
        onClick={() => signOut.mutate()}
      >
        {signOut.isPending ? t('auth.signingOut') : t('auth.signOut')}
      </button>

      {signOut.isError && (
        <p role="alert" className="text-sm text-danger">
          {t('auth.signOutFailed')}
        </p>
      )}
    </div>
  );
}

import { ROLE_LABEL_KEYS } from '../../auth/roles.js';
import { SignOutButton } from '../../auth/SignOutButton.js';
import { useAuthenticatedUser } from '../../auth/useAuth.js';
import { useTranslator } from '../../i18n/index.js';

/**
 * Who is signed in, and how to stop being signed in.
 *
 * Three things and no fourth: a name, an informational role label, and the sign
 * out control. There is no profile, no settings, and no account menu, because
 * the product has none of them and a shell that offers a door to a room that
 * was never built is worse than a shell that offers none.
 *
 * It sits at the bottom of the account area on purpose — sign out is never next
 * to an inventory action, where a thumb reaching for "record the removal" could
 * find it instead.
 */
export function UserArea() {
  const t = useTranslator();
  const user = useAuthenticatedUser();

  return (
    <div className="flex flex-col gap-2.5 border-t border-rule pt-4">
      <div>
        <p className="text-[15px] font-semibold text-ink">{user.displayName}</p>
        <p className="mt-1">
          <span className="inline-block rounded-sm bg-fill px-2 py-0.5 text-xs font-semibold text-ink-soft">
            {t(ROLE_LABEL_KEYS[user.role])}
          </span>
        </p>
      </div>

      <SignOutButton />
    </div>
  );
}

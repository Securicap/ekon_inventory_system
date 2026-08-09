import type { Role } from '@ekon/shared';
import { SignOutButton } from '../../auth/SignOutButton.js';
import { useAuthenticatedUser } from '../../auth/useAuth.js';
import { useTranslator, type MessageKey } from '../../i18n/index.js';

/**
 * Roles are shown, not acted on. The label tells somebody which account they
 * are using; what they may do is decided by capabilities, here and on the
 * server.
 */
const ROLE_LABEL_KEYS: Readonly<Record<Role, MessageKey>> = {
  SUPER_ADMIN: 'role.SUPER_ADMIN',
  OWNER: 'role.OWNER',
  MANAGER: 'role.MANAGER',
  EMPLOYEE: 'role.EMPLOYEE',
};

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

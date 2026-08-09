import type { Role } from '@ekon/shared';
import type { MessageKey } from '../i18n/index.js';

/**
 * Roles are shown, not acted on.
 *
 * The label tells somebody which account they are using; what they may do is
 * decided by capabilities, here and on the server. Nothing branches on the
 * values in this map — it exists only so that two places that display a role
 * display the same word for it.
 */
export const ROLE_LABEL_KEYS: Readonly<Record<Role, MessageKey>> = {
  SUPER_ADMIN: 'role.SUPER_ADMIN',
  OWNER: 'role.OWNER',
  MANAGER: 'role.MANAGER',
  EMPLOYEE: 'role.EMPLOYEE',
};

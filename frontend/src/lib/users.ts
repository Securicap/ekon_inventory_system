import {
  DISPLAY_NAME_MAX_LENGTH,
  PASSWORD_INPUT_MAX_LENGTH,
  PASSWORD_INPUT_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
  normalizeUsername,
} from '@ekon/shared';
import type { MessageKey } from '../i18n/index.js';

/**
 * The parts of account creation that are decisions rather than markup.
 *
 * Here rather than in the screen because they are rules worth checking without
 * reading JSX, and worth testing directly. The screen keeps state and layout.
 *
 * Every bound comes from `@ekon/shared`. Nothing in this file restates what a
 * username is or how long a password must be: a second copy of those rules
 * would be a form that accepts what the server refuses, or refuses what it
 * would have accepted.
 */

/** What the form holds while it is being filled in. Strings, as the DOM has them. */
export interface NewUserFormValues {
  username: string;
  displayName: string;
  password: string;
  role: string;
}

export type NewUserFieldErrors = Partial<Record<keyof NewUserFormValues, MessageKey>>;

/**
 * The form as the person filling it in should be told about it.
 *
 * Immediate feedback and nothing more: the server validates all of this again,
 * with the same shared schemas, and is the authority. What this buys is that a
 * mistyped username is a sentence under the field rather than a round trip.
 *
 * The username is checked in its **normalized** form, because that is what will
 * be sent and stored — so `"  Marie.J  "` is accepted rather than reported as
 * containing spaces and capitals it will not be stored with.
 *
 * The password is checked for length only. There are no composition rules here
 * because there are none in the system: a required digit and symbol reliably
 * produce `Password1!`, which is worse than the four ordinary words somebody
 * would otherwise have chosen. It is never trimmed, on either side of the wire.
 */
export function validateNewUserForm(values: NewUserFormValues): NewUserFieldErrors {
  const errors: NewUserFieldErrors = {};

  const username = normalizeUsername(values.username);
  if (username === '') {
    errors.username = 'users.usernameRequired';
  } else if (
    username.length < USERNAME_MIN_LENGTH ||
    username.length > USERNAME_MAX_LENGTH ||
    !USERNAME_PATTERN.test(username)
  ) {
    errors.username = 'users.usernameInvalid';
  }

  const displayName = values.displayName.trim();
  if (displayName === '') {
    errors.displayName = 'users.displayNameRequired';
  } else if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    errors.displayName = 'users.displayNameTooLong';
  }

  if (values.password === '') {
    errors.password = 'users.passwordRequired';
  } else if (values.password.length < PASSWORD_INPUT_MIN_LENGTH) {
    errors.password = 'users.passwordTooShort';
  } else if (values.password.length > PASSWORD_INPUT_MAX_LENGTH) {
    errors.password = 'users.passwordTooLong';
  }

  if (values.role === '') errors.role = 'users.roleRequired';

  return errors;
}

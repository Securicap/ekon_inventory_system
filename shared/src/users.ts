import { z } from 'zod';
import { passwordInputSchema } from './auth.js';
import {
  DISPLAY_NAME_MAX_LENGTH,
  USERNAME_PATTERN,
  displayNameSchema,
  usernameSchema,
} from './identity.js';
import { roleSchema } from './roles.js';

/**
 * Creating a user account — the contract for the one identity workflow that is
 * neither signing in nor signing out.
 *
 * A new installation gets its first `OWNER` from the operator command, and
 * everybody after that is created here, by somebody already signed in who holds
 * `identity.manage`. That is the whole of user management in this milestone:
 * there is no listing, no editing, no role change, no deactivation, and no
 * password reset, and none of them has a contract in this file.
 *
 * Its own module rather than an addition to `identity.ts` because of the import
 * direction: the password bounds live in `auth.ts`, which already imports the
 * username and display-name rules from `identity.ts`. Putting this beside them
 * would make those two files import each other, and a cycle between modules
 * that build zod schemas at import time is the kind that fails as an
 * inscrutable `undefined` rather than as an error anybody can read.
 */

/**
 * `POST /api/identity/users`.
 *
 * Four fields, and the strictness is the point: everything else about an
 * account is the server's. A request cannot supply an id, a password hash, an
 * active flag, a timestamp, or — above all — a capability list. `.strict()`
 * makes each of those a `400` naming the field rather than a value quietly
 * dropped, which is the difference between an attempt that is refused and an
 * attempt whose author never learns it failed.
 *
 * There is no `capabilities` field and there will not be one. Capabilities come
 * from the role through `role_capabilities`, resolved per request; a request
 * that could name them would be a request that grants itself permissions.
 *
 * Every rule here is one the system already had. The username is normalized and
 * checked by the shared `usernameSchema` — the same one the login route parses,
 * so an account is created under exactly the name it will sign in with. The
 * password is length-checked by the shared bounds and never trimmed. The role
 * is the closed set from `roles.ts`.
 */
export const createUserRequestSchema = z
  .object({
    username: usernameSchema,
    displayName: displayNameSchema,
    /**
     * The initial password, in plaintext, over TLS, exactly as the login route
     * receives one. It is hashed on arrival and never stored, logged, echoed
     * back, or put in an error — the server's `req.body.password` redaction
     * path covers this field because it is deliberately named the same thing.
     *
     * There is no generated-password option and no "must change on first
     * sign-in" flag: the first would have to be displayed somewhere to be
     * usable, and the second is a password-change workflow that does not exist.
     * The owner chooses one with the employee and tells them.
     */
    password: passwordInputSchema,
    role: roleSchema,
  })
  .strict();

export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

/**
 * The account that was created, as the caller is told about it.
 *
 * No password hash — nothing outside the identity module has a reason to see
 * one, and a value that is never returned cannot be logged by accident. No
 * capabilities either: they are not stored on the user, they are resolved from
 * the role on every request, and echoing a snapshot here would invite a client
 * to keep it.
 *
 * `isActive` and `createdAt` are included precisely because the request could
 * not set them. They are the server's answer about state it owns, which is what
 * makes them worth returning.
 */
export const createdUserSchema = z
  .object({
    id: z.string().uuid(),
    /** Already normalized: trimmed and lower-cased, as stored. */
    username: z.string().regex(USERNAME_PATTERN),
    displayName: z.string().min(1).max(DISPLAY_NAME_MAX_LENGTH),
    role: roleSchema,
    isActive: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type CreatedUser = z.infer<typeof createdUserSchema>;

/**
 * The body of a successful `POST /api/identity/users`, answered `201`.
 *
 * Wrapped in `user` to match `AuthenticatedUserResponse`, so the two shapes the
 * identity module returns a person in are read the same way — and so a later
 * addition beside it is a new key rather than a change to what clients parse.
 *
 * **No session is created and none is returned.** Creating somebody's account
 * is not signing in as them: there is no token, no cookie, and nothing here the
 * caller could present as the new user. They sign in themselves, through the
 * ordinary login route, with the password they were given.
 */
export const createUserResponseSchema = z.object({ user: createdUserSchema }).strict();

export type CreateUserResponse = z.infer<typeof createUserResponseSchema>;

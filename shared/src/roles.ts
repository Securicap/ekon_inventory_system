import { z } from 'zod';

/**
 * Roles are a closed set. Adding one is a migration (it must also be granted
 * capabilities in `role_capabilities`), which is deliberate — role changes
 * should be reviewable and auditable, not configurable at runtime.
 */
export const ROLES = ['SUPER_ADMIN', 'OWNER', 'MANAGER', 'EMPLOYEE'] as const;

export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

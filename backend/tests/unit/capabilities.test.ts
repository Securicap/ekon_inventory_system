import { describe, expect, it } from 'vitest';
import { CAPABILITIES, DEFAULT_ROLE_CAPABILITIES, ROLES } from '@ekon/shared';

describe('capability model', () => {
  it('defines capabilities for every role', () => {
    for (const role of ROLES) {
      expect(DEFAULT_ROLE_CAPABILITIES[role], `no capabilities defined for ${role}`).toBeDefined();
    }
  });

  it('grants only capabilities that exist', () => {
    for (const [role, granted] of Object.entries(DEFAULT_ROLE_CAPABILITIES)) {
      for (const capability of granted) {
        expect(CAPABILITIES, `${role} was granted unknown capability ${capability}`).toContain(
          capability,
        );
      }
    }
  });

  it('gives an employee exactly the three capabilities the counter job needs', () => {
    // Read the catalog, read stock, book in what arrives. Anything beyond that
    // is granted deliberately, never inherited from a default.
    expect([...(DEFAULT_ROLE_CAPABILITIES.EMPLOYEE ?? [])].sort()).toEqual([
      'catalog.read',
      'inventory.read',
      'inventory.receive',
    ]);
  });

  it('does not give employees privileged capabilities', () => {
    const employee = DEFAULT_ROLE_CAPABILITIES.EMPLOYEE ?? [];
    for (const capability of [
      'catalog.write',
      'catalog.deactivate',
      'inventory.adjust',
      'inventory.count',
      'inventory.reverse',
      'audit.read',
      'identity.manage',
      'reports.export',
    ] as const) {
      expect(employee, `employee should not hold ${capability}`).not.toContain(capability);
    }
  });

  it('withholds identity.manage from managers and grants it to owners', () => {
    // Creating accounts, changing roles, and deactivating people is the
    // owner's. A manager runs the shop floor.
    expect(DEFAULT_ROLE_CAPABILITIES.MANAGER).not.toContain('identity.manage');
    expect(DEFAULT_ROLE_CAPABILITIES.OWNER).toContain('identity.manage');
    expect(DEFAULT_ROLE_CAPABILITIES.SUPER_ADMIN).toContain('identity.manage');
  });

  it('has no capability that permits negative stock', () => {
    // Stock below zero is forbidden by database constraint on every path.
    // A shelf cannot hold minus three items; the remedy for a shortfall is to
    // record the missing receipt or run a physical count. If a capability like
    // this ever appears, the constraint has been weakened somewhere.
    expect(CAPABILITIES.some((c) => c.includes('negative'))).toBe(false);
  });
});

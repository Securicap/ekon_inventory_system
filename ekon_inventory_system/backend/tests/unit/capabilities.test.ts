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

  it('does not give employees privileged capabilities', () => {
    const employee = DEFAULT_ROLE_CAPABILITIES.EMPLOYEE ?? [];
    expect(employee).not.toContain('identity.manage');
    expect(employee).not.toContain('audit.read');
    expect(employee).not.toContain('inventory.reverse');
    expect(employee).not.toContain('catalog.deactivate');
  });

  it('has no capability that permits negative stock', () => {
    // Stock below zero is forbidden by database constraint on every path.
    // A shelf cannot hold minus three items; the remedy for a shortfall is to
    // record the missing receipt or run a physical count. If a capability like
    // this ever appears, the constraint has been weakened somewhere.
    expect(CAPABILITIES.some((c) => c.includes('negative'))).toBe(false);
  });
});

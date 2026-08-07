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

  it('gives an employee exactly the four capabilities the counter job needs', () => {
    // Read the catalog, read stock, book in what arrives, record what leaves.
    // Anything beyond that is granted deliberately, never inherited from a
    // default.
    expect([...(DEFAULT_ROLE_CAPABILITIES.EMPLOYEE ?? [])].sort()).toEqual([
      'catalog.read',
      'inventory.read',
      'inventory.receive',
      'inventory.remove',
    ]);
  });

  it('separates removing stock from adjusting it', () => {
    // Recording that stock left is the counter job. Correcting a balance that
    // was wrong is authority over the records themselves, and it can make a
    // shortfall disappear — so an employee holding the first must not inherit
    // the second, and granting `inventory.adjust` to enable routine removal
    // would have done exactly that.
    const employee = DEFAULT_ROLE_CAPABILITIES.EMPLOYEE ?? [];
    expect(employee).toContain('inventory.remove');
    expect(employee).not.toContain('inventory.adjust');
    expect(CAPABILITIES).toContain('inventory.remove');
    expect(CAPABILITIES).toContain('inventory.adjust');
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

  it('lets no role be created that outranks the people who may create it', () => {
    /**
     * `POST /api/identity/users` accepts the whole closed role set rather than
     * a narrower list of its own, and this is the reason it is safe to: every
     * role that holds `identity.manage` already holds *every* capability, so
     * there is no account a creator could make that can do something they
     * cannot. Account creation is therefore not a privilege-escalation path,
     * and the route needs no rule about which roles may create which.
     *
     * If a future migration grants `identity.manage` to a role that does not
     * hold everything — a `MANAGER`, say — this fails, and it should: at that
     * moment the route does need such a rule, and this is where the decision
     * has to be made rather than discovered.
     */
    const creators = ROLES.filter((role) =>
      (DEFAULT_ROLE_CAPABILITIES[role] ?? []).includes('identity.manage'),
    );
    expect(creators.length).toBeGreaterThan(0);

    for (const creator of creators) {
      const held = new Set(DEFAULT_ROLE_CAPABILITIES[creator] ?? []);
      for (const created of ROLES) {
        for (const capability of DEFAULT_ROLE_CAPABILITIES[created] ?? []) {
          expect(
            held.has(capability),
            `${creator} may create a ${created}, who would hold ${capability} that ${creator} does not`,
          ).toBe(true);
        }
      }
    }
  });

  it('has no capability that permits negative stock', () => {
    // Stock below zero is forbidden by database constraint on every path.
    // A shelf cannot hold minus three items; the remedy for a shortfall is to
    // record the missing receipt or run a physical count. If a capability like
    // this ever appears, the constraint has been weakened somewhere.
    expect(CAPABILITIES.some((c) => c.includes('negative'))).toBe(false);
  });
});

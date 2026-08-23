import { describe, expect, it } from 'vitest';
import { LIFECYCLE_STATUSES, type LifecycleStatus } from '@ekon/shared';
import {
  allowedTransitionsFrom,
  effectiveLifecycle,
  isTransitionAllowed,
  merchandisePolicy,
  OPERATIONAL_LIFECYCLE_STATUSES,
  requiresZeroStock,
} from '../../../src/modules/catalog/domain/lifecycle.js';

/**
 * Merchandise lifecycle policy, tested where it is decided.
 *
 * The integration suites prove that receiving, removal, adjustment, reversal,
 * and the stock read all honour these rules through real HTTP against a real
 * database. This file proves the rules themselves, exhaustively and cheaply —
 * every pair of statuses, every transition, every permission — which is the
 * kind of coverage that would be tedious and slow to buy an endpoint at a time.
 */

describe('what each status permits', () => {
  it('permits everything while merchandise is ACTIVE', () => {
    expect(merchandisePolicy('ACTIVE')).toEqual({
      mayReceive: true,
      mayIssue: true,
      mayCount: true,
      mayCorrect: true,
    });
  });

  it('stops replenishment and nothing else when merchandise is DISCONTINUED', () => {
    // The distinction a single availability flag could not express, and the
    // reason lifecycle replaced one. No longer bought is not no longer sold.
    expect(merchandisePolicy('DISCONTINUED')).toEqual({
      mayReceive: false,
      mayIssue: true,
      mayCount: true,
      mayCorrect: true,
    });
  });

  it('permits nothing operational once merchandise is ARCHIVED', () => {
    // Safe only because archiving is refused while stock remains: an archived
    // SKU has nothing on any shelf, so nothing is being hidden. Its history
    // stays readable, which is what archiving is for.
    expect(merchandisePolicy('ARCHIVED')).toEqual({
      mayReceive: false,
      mayIssue: false,
      mayCount: false,
      mayCorrect: false,
    });
  });

  it('leaves counting possible wherever issuing is', () => {
    // PR 6 owns physical counts, and this is the promise made to it: anything
    // the shop can still sell, it can still count. A lifecycle that permitted
    // one and not the other would force that PR to work around this one.
    for (const status of LIFECYCLE_STATUSES) {
      const policy = merchandisePolicy(status);
      expect(policy.mayCount, status).toBe(policy.mayIssue);
    }
  });

  it('never permits receiving where it does not permit issuing', () => {
    // The asymmetry only ever runs one way. Merchandise that may be replenished
    // but not sold would be a shop buying stock it cannot move.
    for (const status of LIFECYCLE_STATUSES) {
      const policy = merchandisePolicy(status);
      if (policy.mayReceive) expect(policy.mayIssue, status).toBe(true);
    }
  });
});

describe('the operational statuses', () => {
  it('are exactly the ones stock can still leave through', () => {
    expect(OPERATIONAL_LIFECYCLE_STATUSES).toEqual(['ACTIVE', 'DISCONTINUED']);
  });

  it('are derived from the policy rather than written out beside it', () => {
    // The list is what the catalog's SQL filter binds, so a policy change and
    // the current-stock query cannot drift apart.
    const derived = LIFECYCLE_STATUSES.filter((status) => merchandisePolicy(status).mayIssue);
    expect([...OPERATIONAL_LIFECYCLE_STATUSES]).toEqual(derived);
  });
});

describe('effective status: a variant is never more available than its product', () => {
  const cases: [LifecycleStatus, LifecycleStatus, LifecycleStatus][] = [
    ['ACTIVE', 'ACTIVE', 'ACTIVE'],
    ['ACTIVE', 'DISCONTINUED', 'DISCONTINUED'],
    ['ACTIVE', 'ARCHIVED', 'ARCHIVED'],
    ['DISCONTINUED', 'ACTIVE', 'DISCONTINUED'],
    ['DISCONTINUED', 'DISCONTINUED', 'DISCONTINUED'],
    ['DISCONTINUED', 'ARCHIVED', 'ARCHIVED'],
    ['ARCHIVED', 'ACTIVE', 'ARCHIVED'],
    ['ARCHIVED', 'DISCONTINUED', 'ARCHIVED'],
    ['ARCHIVED', 'ARCHIVED', 'ARCHIVED'],
  ];

  it.each(cases)('product %s + variant %s → %s', (product, variant, expected) => {
    expect(effectiveLifecycle(product, variant)).toBe(expected);
  });

  it('covers every pair of statuses', () => {
    // Nine cases and nine pairs: the table above is exhaustive, so a fourth
    // status could not be added without this failing.
    expect(cases).toHaveLength(LIFECYCLE_STATUSES.length ** 2);
  });

  it('is the more restrictive of the two, whichever side it is on', () => {
    for (const product of LIFECYCLE_STATUSES) {
      for (const variant of LIFECYCLE_STATUSES) {
        const effective = effectiveLifecycle(product, variant);
        const policy = merchandisePolicy(effective);
        // Nothing the combination permits is forbidden by either side alone.
        expect(policy.mayReceive && merchandisePolicy(product).mayReceive).toBe(policy.mayReceive);
        expect(policy.mayReceive && merchandisePolicy(variant).mayReceive).toBe(policy.mayReceive);
        expect(policy.mayIssue && merchandisePolicy(product).mayIssue).toBe(policy.mayIssue);
        expect(policy.mayIssue && merchandisePolicy(variant).mayIssue).toBe(policy.mayIssue);
      }
    }
  });

  it('is symmetric, because "more restrictive" does not care which row said so', () => {
    for (const first of LIFECYCLE_STATUSES) {
      for (const second of LIFECYCLE_STATUSES) {
        expect(effectiveLifecycle(first, second)).toBe(effectiveLifecycle(second, first));
      }
    }
  });
});

describe('the transition matrix', () => {
  it.each<[LifecycleStatus, LifecycleStatus, boolean]>([
    // The lifecycle itself.
    ['ACTIVE', 'DISCONTINUED', true],
    ['DISCONTINUED', 'ARCHIVED', true],
    // A shortcut for merchandise entered by mistake, with nothing to sell down.
    ['ACTIVE', 'ARCHIVED', true],
    // The corrective steps, each going back exactly one stage.
    ['DISCONTINUED', 'ACTIVE', true],
    ['ARCHIVED', 'DISCONTINUED', true],
    // And the one that is refused: coming back into operation and being
    // reordered again are two decisions, so they are two steps.
    ['ARCHIVED', 'ACTIVE', false],
  ])('%s → %s is %s', (from, to, allowed) => {
    expect(isTransitionAllowed(from, to)).toBe(allowed);
  });

  it('treats no status as a transition to itself', () => {
    // A declarative PATCH restating the current status has nothing to do, and
    // the service answers it as a no-op rather than asking this function.
    for (const status of LIFECYCLE_STATUSES) {
      expect(isTransitionAllowed(status, status)).toBe(false);
      expect(allowedTransitionsFrom(status)).not.toContain(status);
    }
  });

  it('leaves every status reachable from every other, in at most two steps', () => {
    // No permanent tombstone. A mis-clicked archive is recoverable without a
    // database session, which is the difference between having a correction
    // path and not having one.
    for (const from of LIFECYCLE_STATUSES) {
      for (const to of LIFECYCLE_STATUSES) {
        if (from === to) continue;
        const direct = isTransitionAllowed(from, to);
        const viaOne = allowedTransitionsFrom(from).some((middle) =>
          isTransitionAllowed(middle, to),
        );
        expect(direct || viaOne, `${from} → ${to}`).toBe(true);
      }
    }
  });

  it('names what is permitted, for the message a refusal carries', () => {
    expect(allowedTransitionsFrom('ARCHIVED')).toEqual(['DISCONTINUED']);
  });
});

describe('the zero-stock requirement', () => {
  it('applies to archiving and to nothing else', () => {
    // Discontinuing merchandise the shop is still selling down is the ordinary
    // case and must never be blocked by a quantity; archiving asserts an empty
    // shelf, so it must be.
    expect(requiresZeroStock('ARCHIVED')).toBe(true);
    expect(requiresZeroStock('DISCONTINUED')).toBe(false);
    expect(requiresZeroStock('ACTIVE')).toBe(false);
  });

  it('is required by exactly the status that permits nothing operational', () => {
    for (const status of LIFECYCLE_STATUSES) {
      expect(requiresZeroStock(status), status).toBe(!merchandisePolicy(status).mayIssue);
    }
  });
});

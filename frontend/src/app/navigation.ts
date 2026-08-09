import type { AuthenticatedUser, Capability } from '@ekon/shared';
import { hasCapability } from '../auth/capabilities.js';
import type { MessageKey } from '../i18n/index.js';

/**
 * What the shell can navigate to — which is only what has been built.
 *
 * There is one of these lists and there will only ever be one. The desktop
 * sidebar, the tablet rail, the mobile bottom bar, and the mobile navigation
 * panel are four presentations of this array and of the two functions below;
 * none of them decides for itself what a person may open. A second list would
 * be a second answer to "may they?", and the two would drift.
 *
 * Two rules, and the second is the one that is easy to get wrong:
 *
 *  - visibility is decided by capability, never by role. There is no
 *    `role === 'OWNER'` anywhere in this application;
 *  - a capability is not a destination. A link to a screen that does not exist
 *    is worse than a missing link, so an entry arrives with its screen and not
 *    before. `audit.read` and `reports.export` are still waiting for theirs.
 *
 * Each inventory door has its own key, and the keys are not interchangeable.
 * Receiving is gated on `inventory.receive`, removal on `inventory.remove`, and
 * reading stock on `inventory.read` — three different permissions over three
 * different acts, and somebody may hold any combination of them. Neither write
 * door opens on the read capability, and neither opens on the other's.
 *
 * `inventory.adjust` opens nothing here, deliberately. Recording that stock
 * left is what somebody at the counter does all day; correcting a balance that
 * was wrong is authority over the records themselves, and the screen for it
 * does not exist. A capability is not a destination.
 *
 * `identity.manage` opens one door and it is a narrow one: creating an account.
 * That is the whole of user management that exists, so it is the whole of what
 * the entry promises — it is labelled for the act rather than for the subject,
 * because a link called "Users" that cannot list any would be a lie about what
 * is behind it.
 *
 * The API enforces the same capabilities, which is the boundary that matters;
 * this only decides whether somebody is shown a door that will be shut in their
 * face.
 */
export type View = 'home' | 'catalog' | 'inventory' | 'receiving' | 'removal' | 'newUser';

/**
 * Two groups, because the sidebar reads better as two short lists than as one
 * long one: what somebody does with stock during a shift, and what somebody
 * sets up around it.
 */
export type NavigationGroupId = 'operations' | 'management';

export interface NavigationItem {
  view: View;
  labelKey: MessageKey;
  /** Omitted for the landing view, which every signed-in person can see. */
  capability?: Capability;
  group: NavigationGroupId;
  /**
   * Whether this is a destination somebody opens repeatedly during a shift.
   *
   * It decides one thing only: whether the entry earns a slot in the mobile
   * bottom bar, which has room for a few and not for all. Everything else keeps
   * showing every permitted destination, and the panel behind "More" is the
   * complete list — so this narrows a bar, it never hides a door.
   */
  everyday?: true;
}

export const NAVIGATION: readonly NavigationItem[] = [
  { view: 'home', labelKey: 'nav.home', group: 'operations' },
  {
    view: 'inventory',
    labelKey: 'nav.stock',
    capability: 'inventory.read',
    group: 'operations',
    everyday: true,
  },
  {
    view: 'receiving',
    labelKey: 'nav.receive',
    capability: 'inventory.receive',
    group: 'operations',
    everyday: true,
  },
  {
    view: 'removal',
    labelKey: 'nav.remove',
    capability: 'inventory.remove',
    group: 'operations',
    everyday: true,
  },
  { view: 'catalog', labelKey: 'nav.products', capability: 'catalog.read', group: 'management' },
  { view: 'newUser', labelKey: 'nav.newUser', capability: 'identity.manage', group: 'management' },
];

const GROUP_LABEL_KEYS: Readonly<Record<NavigationGroupId, MessageKey>> = {
  operations: 'nav.groupOperations',
  management: 'nav.groupManagement',
};

/** The order groups appear in, everywhere they appear. */
const GROUP_ORDER: readonly NavigationGroupId[] = ['operations', 'management'];

export interface NavigationGroup {
  id: NavigationGroupId;
  labelKey: MessageKey;
  items: readonly NavigationItem[];
}

/**
 * The destinations this person may open. Every presentation starts here.
 */
export function availableNavigation(user: AuthenticatedUser): readonly NavigationItem[] {
  return NAVIGATION.filter(
    (item) => item.capability === undefined || hasCapability(user, item.capability),
  );
}

/**
 * The same destinations, grouped for display.
 *
 * A group with nothing in it does not appear at all — heading included. An
 * employee who cannot manage products or accounts is not shown a "Management"
 * heading with a gap under it, and no destination is ever drawn disabled.
 */
export function navigationGroups(available: readonly NavigationItem[]): readonly NavigationGroup[] {
  return GROUP_ORDER.map((id) => ({
    id,
    labelKey: GROUP_LABEL_KEYS[id],
    items: available.filter((item) => item.group === id),
  })).filter((group) => group.items.length > 0);
}

/**
 * The permitted destinations that earn a slot in the mobile bottom bar and the
 * tablet rail. A subset of what a person may open, never a superset.
 */
export function everydayNavigation(
  available: readonly NavigationItem[],
): readonly NavigationItem[] {
  return available.filter((item) => item.everyday === true);
}

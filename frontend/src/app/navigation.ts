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
 * **Not every capability is a destination, and three deliberately are not.**
 * `inventory.adjust`, `inventory.reverse` and `catalog.deactivate` open no
 * entry here, because each is a *contextual action* on something a person is
 * already looking at rather than a place they go:
 *
 *   - adjusting a quantity belongs to the row whose quantity is wrong, on
 *     Inventory;
 *   - reversing a movement belongs to that movement, in History;
 *   - withdrawing merchandise belongs to that merchandise, on Products.
 *
 * A navigation entry per endpoint would be eight doors for what is, to the
 * person at the counter, four jobs — and "Adjust" as a destination would invite
 * somebody to reach for it *instead of* Remove, which is the one confusion the
 * two capabilities exist to prevent.
 *
 * `inventory.count` is the same shape of rule read the other way: Counts *is* a
 * destination, on `inventory.read`, because seeing what has been counted and
 * what is still unexplained is inventory visibility. Recording a count and
 * accepting a difference are the acts that need `inventory.count`, and they are
 * gated on the screen rather than at the door.
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
export type View =
  'home' | 'inventory' | 'receiving' | 'removal' | 'counts' | 'history' | 'catalog' | 'newUser';

/**
 * Where to go, and — for the two screens that can be opened *about* something —
 * what to open it about.
 *
 * An inventory row offers "see this item's history", and the honest way to
 * answer that is to open History already filtered to it rather than to drop
 * somebody on an unfiltered feed and ask them to find it again. The focus is a
 * hint the destination applies to its own filters; it is not routing state and
 * nothing depends on it being present.
 */
export interface ViewFocus {
  variantId?: string;
  locationId?: string;
}

/**
 * Three groups, because the sidebar reads better as three short lists than as
 * one long one, and because the three answer genuinely different questions:
 *
 *   operations  what somebody does with stock during a shift;
 *   control     how somebody checks that the records are right;
 *   management  what somebody sets up around all of it.
 *
 * Counts and History sit in `control` rather than in `operations` for a reason
 * worth stating: neither is part of serving a customer. One is an audit of the
 * records against the shelf and the other is the evidence of what changed them,
 * and putting them beside Receive and Remove would suggest they are things to
 * do all day.
 */
export type NavigationGroupId = 'operations' | 'control' | 'management';

export interface NavigationItem {
  view: View;
  labelKey: MessageKey;
  /**
   * What the destination is for, in one short phrase.
   *
   * A sidebar entry has room for a word and Home has room for a sentence, so
   * the sentence lives here beside the word rather than in a second table
   * somewhere else — one place still answers "what destinations are there, what
   * are they called, and who may open them". Home is the landing view and does
   * not describe itself.
   */
  descriptionKey?: MessageKey;
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
    descriptionKey: 'nav.stockPurpose',
    capability: 'inventory.read',
    group: 'operations',
    everyday: true,
  },
  {
    view: 'receiving',
    labelKey: 'nav.receive',
    descriptionKey: 'nav.receivePurpose',
    capability: 'inventory.receive',
    group: 'operations',
    everyday: true,
  },
  {
    view: 'removal',
    labelKey: 'nav.remove',
    descriptionKey: 'nav.removePurpose',
    capability: 'inventory.remove',
    group: 'operations',
    everyday: true,
  },
  {
    view: 'counts',
    labelKey: 'nav.counts',
    descriptionKey: 'nav.countsPurpose',
    capability: 'inventory.read',
    group: 'control',
  },
  {
    view: 'history',
    labelKey: 'nav.history',
    descriptionKey: 'nav.historyPurpose',
    capability: 'inventory.read',
    group: 'control',
  },
  {
    view: 'catalog',
    labelKey: 'nav.products',
    descriptionKey: 'nav.productsPurpose',
    capability: 'catalog.read',
    group: 'management',
  },
  {
    view: 'newUser',
    labelKey: 'nav.newUser',
    descriptionKey: 'nav.newUserPurpose',
    capability: 'identity.manage',
    group: 'management',
  },
];

const GROUP_LABEL_KEYS: Readonly<Record<NavigationGroupId, MessageKey>> = {
  operations: 'nav.groupOperations',
  control: 'nav.groupControl',
  management: 'nav.groupManagement',
};

/** The order groups appear in, everywhere they appear. */
const GROUP_ORDER: readonly NavigationGroupId[] = ['operations', 'control', 'management'];

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
 *
 * It stays at three — Inventory, Receive, Remove — now that there are eight
 * destinations rather than six. A bar with room for four including "More" is
 * not a table of contents, and Counts and History are opened a few times a week
 * by somebody who has a minute, not between customers. They are one tap away
 * behind More, which is where everything a person may open is listed in full.
 */
export function everydayNavigation(
  available: readonly NavigationItem[],
): readonly NavigationItem[] {
  return available.filter((item) => item.everyday === true);
}

/**
 * The destinations Home offers as shortcuts: everything this person may open
 * except Home, which is where they already are.
 *
 * Deliberately flat and in the array's own order, which puts the operational
 * destinations before the management ones — the prominence the design gives
 * them falls out of the one list rather than out of a rule about roles. There
 * is nothing to group here, so there is no heading that could be left standing
 * over nothing.
 */
export function shortcutNavigation(
  available: readonly NavigationItem[],
): readonly NavigationItem[] {
  return available.filter((item) => item.view !== 'home');
}

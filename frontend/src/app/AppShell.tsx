import { useEffect, useMemo, useState } from 'react';
import { useAuthenticatedUser } from '../auth/useAuth.js';
import { CatalogScreen } from '../screens/CatalogScreen.js';
import { CountsScreen } from '../screens/CountsScreen.js';
import { HistoryScreen } from '../screens/HistoryScreen.js';
import { HomeScreen } from '../screens/HomeScreen.js';
import { InventoryScreen } from '../screens/InventoryScreen.js';
import { NewUserScreen } from '../screens/NewUserScreen.js';
import { ReceivingScreen } from '../screens/ReceivingScreen.js';
import { RemovalScreen } from '../screens/RemovalScreen.js';
import {
  availableNavigation,
  everydayNavigation,
  navigationGroups,
  type View,
  type ViewFocus,
} from './navigation.js';
import { MobileChrome } from './shell/MobileChrome.js';
import { NavigationPanel } from './shell/NavigationPanel.js';
import { Rail } from './shell/Rail.js';
import { Sidebar } from './shell/Sidebar.js';
import { useBreakpoint } from './useBreakpoint.js';

/**
 * The authenticated shell: who is signed in, how to leave, where to go, and one
 * panel of content.
 *
 * There is no router. Two pieces of local state name the open screen and what
 * it was opened about, and the shell swaps the panel under them; addressable
 * URLs would buy little for eight screens behind a single authentication
 * boundary, and would cost a dependency plus a second place for capabilities to
 * be decided.
 *
 * What the shell offers is decided once, here, from `availableNavigation`, and
 * the three chromes below are three presentations of that one answer. A phone
 * does not get its own permission rules, and a bottom bar cannot show a
 * destination a sidebar would have hidden — there is nothing for them to
 * disagree about, because they are given the same list.
 *
 * It is not a dashboard: there are no metrics, no charts, and no summary tiles,
 * because inventing numbers before the workflows that produce them exist would
 * be inventing the business's numbers.
 */
export function AppShell() {
  const user = useAuthenticatedUser();
  const breakpoint = useBreakpoint();
  const [view, setView] = useState<View>('home');
  /**
   * What the next screen should open *about*, when it was reached from a row
   * rather than from the navigation.
   *
   * Cleared as soon as the destination has consumed it, so returning to History
   * from the sidebar shows the whole ledger rather than whatever an inventory
   * row filtered it to twenty minutes ago.
   */
  const [focus, setFocus] = useState<ViewFocus | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const available = useMemo(() => availableNavigation(user), [user]);
  const groups = useMemo(() => navigationGroups(available), [available]);
  const everyday = useMemo(() => everydayNavigation(available), [available]);

  // The sheet belongs to the narrow chromes. Widening the window past the
  // sidebar breakpoint puts every destination back on screen, so a sheet left
  // open would be covering the thing it exists to reach.
  useEffect(() => {
    if (breakpoint === 'desktop') setPanelOpen(false);
  }, [breakpoint]);

  function go(next: View, about?: ViewFocus): void {
    setView(next);
    setFocus(about ?? null);
    setPanelOpen(false);
  }

  const content = (
    <main className="min-w-0 flex-1 p-4 md:p-6 lg:p-8">
      <div className="w-full max-w-[1120px]">
        {/* Home's shortcuts are this same `go` — there is one way to change
            screen, and Home borrows it rather than owning a second one. */}
        {view === 'home' && <HomeScreen onNavigate={go} />}
        {view === 'catalog' && <CatalogScreen />}
        {view === 'inventory' && <InventoryScreen onOpen={go} />}
        {view === 'receiving' && <ReceivingScreen />}
        {view === 'removal' && <RemovalScreen />}
        {/* The two screens that can be opened about something. The focus is
            keyed into them so arriving from a second row remounts the screen
            with the new filter rather than leaving the first one applied. */}
        {view === 'counts' && <CountsScreen key={focusKey(focus)} focus={focus} />}
        {view === 'history' && <HistoryScreen key={focusKey(focus)} focus={focus} />}
        {view === 'newUser' && <NewUserScreen />}
      </div>
    </main>
  );

  const panel = panelOpen && (
    <NavigationPanel
      groups={groups}
      current={view}
      onSelect={go}
      onClose={() => setPanelOpen(false)}
    />
  );

  if (breakpoint === 'mobile') {
    return (
      <>
        <MobileChrome
          everyday={everyday}
          current={view}
          onSelect={go}
          onOpenPanel={() => setPanelOpen(true)}
          panelOpen={panelOpen}
        >
          {content}
        </MobileChrome>
        {panel}
      </>
    );
  }

  if (breakpoint === 'tablet') {
    return (
      <>
        <div className="flex flex-1">
          <Rail
            everyday={everyday}
            current={view}
            onSelect={go}
            onOpenPanel={() => setPanelOpen(true)}
            panelOpen={panelOpen}
          />
          {content}
        </div>
        {panel}
      </>
    );
  }

  return (
    <div className="flex flex-1">
      <Sidebar groups={groups} current={view} onSelect={go} />
      {content}
    </div>
  );
}

/** A stable identity for one focus, so React can tell two arrivals apart. */
function focusKey(focus: ViewFocus | null): string {
  return focus === null ? 'all' : `${focus.variantId ?? ''}:${focus.locationId ?? ''}`;
}

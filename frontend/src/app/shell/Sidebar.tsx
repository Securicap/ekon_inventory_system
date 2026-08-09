import type { NavigationGroup, View } from '../navigation.js';
import { Brand } from './Brand.js';
import { NavigationList } from './NavigationList.js';
import { UserArea } from './UserArea.js';

/**
 * The desktop shell: a fixed 248px column of white against the page.
 *
 * It does not shrink. Labels are allowed to run onto a second line — Creole is
 * short and French is not, and "Nouveau compte" must not be the reason a bar
 * gets narrower — so an entry grows in height and the column keeps its width.
 */
export function Sidebar({
  groups,
  current,
  onSelect,
}: {
  groups: readonly NavigationGroup[];
  current: View;
  onSelect: (view: View) => void;
}) {
  return (
    <div className="flex w-62 flex-none flex-col gap-6 border-r border-line bg-surface px-3 py-5">
      <div className="px-2.5">
        <Brand />
      </div>

      <NavigationList groups={groups} current={current} onSelect={onSelect} size="pointer" />

      <div className="flex-1" />

      <div className="px-2.5">
        <UserArea />
      </div>
    </div>
  );
}

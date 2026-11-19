// Every upstream sidebar helper the fork tree sidebar uses. Upstream reshapes these on most
// merges; keeping the coupling here makes the breakage show up in one small file.
export {
  deleteSelectedThreadEntries,
  isSidebarNestedLinkClick,
  isTrailingDoubleClick,
  orderItemsByPreferredIds,
  resolveAdjacentThreadId,
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
  sortSidebarV2ProjectGroups,
  useSidebarRowSubscriptionLease,
  useSnoozeWakeClock,
  useThreadJumpHintsVisible,
  type ThreadStatusPill,
} from "./Sidebar.logic";
export { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
export {
  completeSidebarRouteReveal,
  pendingSidebarRouteReveal,
  type SidebarRouteReveal,
} from "./sidebar/routeReveal";

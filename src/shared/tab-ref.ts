/**
 * A tab by its IDs. The two travel together as one value so a call site
 * cannot swap them: both are plain numbers, and the older helpers disagreed on
 * which came first.
 */
export interface TabRef {
  tabId: number;
  windowId: number;
}

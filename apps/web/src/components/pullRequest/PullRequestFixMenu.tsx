import { cloneElement, type ReactElement, type ReactNode } from "react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

/**
 * The "Fix" / "Resolve" control for a hand-off. Beside a thread it asks where the task should go; with no
 * thread to put it in there is nothing to ask, so it stays the single press it always was.
 * `render` is the button itself, so each surface keeps its own look.
 */
export function PullRequestFixMenu({
  render,
  children,
  canFixHere,
  hereLabel = "Fix in this session",
  newLabel = "Fix in new session",
  newDisabled = false,
  disabled = false,
  onFix,
}: {
  render: ReactElement<{ onClick?: () => void; disabled?: boolean; children?: ReactNode }>;
  children: ReactNode;
  canFixHere: boolean;
  hereLabel?: string;
  newLabel?: string;
  newDisabled?: boolean;
  disabled?: boolean;
  onFix: (where: "here" | "new") => void;
}) {
  if (!canFixHere) {
    return cloneElement(render, { disabled, onClick: () => onFix("new") }, children);
  }
  return (
    <Menu>
      <MenuTrigger render={cloneElement(render, { disabled })}>{children}</MenuTrigger>
      <MenuPopup align="end" side="bottom">
        <MenuItem onClick={() => onFix("here")}>{hereLabel}</MenuItem>
        <MenuItem disabled={newDisabled} onClick={() => onFix("new")}>
          {newLabel}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

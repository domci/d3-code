import { cloneElement, type ReactElement, type ReactNode } from "react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

/**
 * The "Fix" control for failing checks. Beside a thread it asks where the task should go; with no
 * thread to put it in there is nothing to ask, so it stays the single press it always was.
 * `render` is the button itself, so each surface keeps its own look.
 */
export function PullRequestFixMenu({
  render,
  children,
  canFixHere,
  newDisabled = false,
  disabled = false,
  onFix,
}: {
  render: ReactElement<{ onClick?: () => void; disabled?: boolean; children?: ReactNode }>;
  children: ReactNode;
  canFixHere: boolean;
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
        <MenuItem onClick={() => onFix("here")}>Fix in this session</MenuItem>
        <MenuItem disabled={newDisabled} onClick={() => onFix("new")}>
          Fix in new session
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

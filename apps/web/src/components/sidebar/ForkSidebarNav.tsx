import {
  ChartNoAxesColumnIcon,
  CodeXmlIcon,
  KanbanIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useGT } from "gt-react";
import { memo } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import { useIssuesSupported, usePullRequestsSupported } from "../../state/environments";
import { Button } from "../ui/button";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { readIssueListPreferences } from "../issue/issueListPreferences";
import { IssueGlyph } from "../issue/issuePresentation";
import { isAppModalPage, isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";

// D3 fork chrome, kept out of upstream's SidebarChrome so upstream merges touch it as little
// as possible: an always-visible nav with active states, and a light/dark switch.

/** Always-visible light/dark switch in the sidebar titlebar. */
export function ForkThemeToggle() {
  const { resolvedTheme, setAppearanceMode } = useTheme();
  const gt = useGT();
  const next = resolvedTheme === "dark" ? "light" : "dark";
  const label = next === "dark" ? gt("Switch to dark mode") : gt("Switch to light mode");
  return (
    <div className="relative z-10 shrink-0 [-webkit-app-region:no-drag]">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={label}
              onClick={() => setAppearanceMode(next)}
            />
          }
        >
          {resolvedTheme === "dark" ? <SunIcon /> : <MoonIcon />}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{label}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function ForkNavItem({
  icon,
  label,
  active,
  className,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className={cn("shrink-0", className)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={label}
              aria-current={active ? "page" : undefined}
              isActive={active}
              onClick={onClick}
              size="icon"
            >
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export const ForkSidebarNav = memo(function ForkSidebarNav() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const gt = useGT();
  const { isMobile, setOpenMobile } = useSidebar();
  const pathname = useLocation({ select: (location) => location.pathname });
  const isSettings = pathname.startsWith("/settings") || pathname.startsWith("/projects/");
  const isPullRequests = pathname === "/pull-requests";
  const isIssues = pathname === "/issues";
  const isBoard = pathname === "/board";
  const isUsage = pathname === "/usage";
  const isCode = !isSidebarUtilityPage(pathname) && !isAppModalPage(pathname);
  const pullRequestsSupported = usePullRequestsSupported();
  const issuesSupported = useIssuesSupported();
  const closeMobileSidebar = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };
  const handlePullRequestsClick = () => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  };
  const handleBoardClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/board" });
  };
  const handleIssuesClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/issues", search: readIssueListPreferences() });
  };
  const handleSettingsClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  };
  const handleUsageClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/usage" });
  };
  const handleThreadsClick = () => {
    closeMobileSidebar();
    void navigateToMainApp();
  };

  return (
    <SidebarMenu className="flex-row items-center">
      <ForkNavItem
        icon={<CodeXmlIcon />}
        label={gt("Threads")}
        active={isCode}
        onClick={handleThreadsClick}
      />
      {pullRequestsSupported ? (
        <ForkNavItem
          icon={<PullRequestGlyph.pullRequest />}
          label={gt("Pull requests")}
          active={isPullRequests}
          onClick={handlePullRequestsClick}
        />
      ) : null}
      {issuesSupported ? (
        <ForkNavItem
          icon={<IssueGlyph.issue />}
          label={gt("Issues", { $context: "sidebar link to the list of issues" })}
          active={isIssues}
          onClick={handleIssuesClick}
        />
      ) : null}
      <ForkNavItem
        icon={<KanbanIcon />}
        label={gt("Board")}
        active={isBoard}
        onClick={handleBoardClick}
      />
      <ForkNavItem
        icon={<ChartNoAxesColumnIcon />}
        label={gt("Usage")}
        active={isUsage}
        onClick={handleUsageClick}
      />
      <SidebarThreadUndoNotice />
      <ForkNavItem
        icon={<SettingsIcon />}
        label={gt("Settings")}
        active={isSettings}
        className="ml-auto"
        onClick={handleSettingsClick}
      />
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { useState, type ReactNode } from "react";

import type { AppBarMenu, AppBarMenuItem } from "../../components/ui/AppBar.types";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import { useThreadListActions } from "../home/useThreadListActions";
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import { resolveThreadListV2SnoozePresets } from "./threadListV2";
import { useThreadListNow } from "./use-thread-list-now";

/** The thread list's long-press actions, as overflow items for the open thread's header. */
export function useThreadMenuActions(
  thread: EnvironmentThreadShell | null,
  onLeaveThread: () => void,
): { readonly menu: AppBarMenu | null; readonly sheet: ReactNode } {
  const list = useThreadListActions((action) => {
    if (action === "archive" || action === "delete") onLeaveThread();
  });
  const environments = useAtomValue(threadListEnvironmentsAtom);
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  const now = useThreadListNow(thread === null ? [] : [thread]);
  if (thread === null) return { menu: null, sheet: null };

  const environmentId = thread.environmentId;
  const snoozed =
    environments.snoozeEnvironmentIds.has(environmentId) && effectiveSnoozed(thread, { now });
  const snoozePresets = resolveThreadListV2SnoozePresets({
    secondary:
      environments.snoozeEnvironmentIds.has(environmentId) && !snoozed && canSnooze(thread, { now })
        ? "snooze"
        : null,
    now,
    presets: environments.snoozePresetsByEnvironmentId.get(environmentId),
  });

  const actions: AppBarMenuItem[] = [];
  const add = (action: Omit<Extract<AppBarMenuItem, { readonly onPress: () => void }>, "id">) =>
    actions.push({ ...action, id: String(actions.length) });

  if (environments.settlementEnvironmentIds.has(environmentId)) {
    if (thread.settledOverride === "settled") {
      add({
        title: "Un-settle",
        icon: "arrow.uturn.backward",
        onPress: () => void list.unsettleThread(thread),
      });
    } else {
      add({
        title: "Settle",
        icon: "checkmark",
        onPress: () => void list.settleThread(thread),
      });
    }
  }
  if (snoozed) {
    add({
      title: "Wake thread",
      icon: "clock",
      onPress: () => void list.unsnoozeThread(thread),
    });
  } else if (snoozePresets.length > 0) {
    actions.push({
      id: "snooze",
      title: "Snooze",
      icon: "clock",
      items: [
        ...snoozePresets.map((preset, index) => ({
          id: `snooze-${index}`,
          title: preset.label,
          subtitle: preset.whenLabel,
          onPress: () => void list.snoozeThread(thread, preset.snoozedUntil),
        })),
        { id: "snooze-custom", title: "Custom…", onPress: () => setCustomSnoozeOpen(true) },
      ],
    });
  }
  if (environments.pinningEnvironmentIds.has(environmentId)) {
    add(
      thread.pinnedAt != null
        ? {
            title: "Unpin",
            icon: "pin.slash",
            onPress: () => void list.unpinThread(thread),
          }
        : { title: "Pin", icon: "pin", onPress: () => void list.pinThread(thread) },
    );
  }
  add({
    title: "Rename",
    icon: "square.and.pencil",
    onPress: () => list.renameThread(thread),
  });
  if (environments.titleRegenerationEnvironmentIds.has(environmentId)) {
    const regenerating = thread.titleRegeneration != null;
    add({
      title: regenerating ? "Regenerating…" : "Regenerate title",
      icon: "arrow.clockwise",
      disabled: regenerating,
      onPress: () => void list.regenerateThreadTitle(thread),
    });
  }
  if (environments.autoSettleOptOutEnvironmentIds.has(environmentId)) {
    const autoSettle = thread.autoSettleDisabledAt == null;
    add({
      title: "Auto-settle",
      icon: "timer",
      selected: autoSettle,
      onPress: () => void list.setThreadAutoSettle(thread, !autoSettle),
    });
  }
  add({
    title: "Copy thread ID",
    icon: "doc.on.doc",
    onPress: () => copyTextWithHaptic(thread.id, { target: "thread-id" }),
  });
  add({
    title: "Archive",
    icon: "archivebox",
    onPress: () => void list.archiveThread(thread),
  });
  add({
    title: "Delete",
    icon: "trash",
    destructive: true,
    onPress: () => list.confirmDeleteThread(thread),
  });

  return {
    menu: { title: "Thread actions", icon: "ellipsis", items: actions },
    sheet: customSnoozeOpen ? (
      <CustomSnoozeSheet
        onClose={() => setCustomSnoozeOpen(false)}
        onSnooze={(snoozedUntil) => void list.snoozeThread(thread, snoozedUntil)}
      />
    ) : null,
  };
}

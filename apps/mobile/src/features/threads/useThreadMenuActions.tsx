import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { canSnooze, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { useState, type ReactNode } from "react";

import type { AppBarAction } from "../../components/ui/AppBar.types";
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
): { readonly actions: ReadonlyArray<AppBarAction>; readonly sheet: ReactNode } {
  const list = useThreadListActions((action) => {
    if (action === "archive" || action === "delete") onLeaveThread();
  });
  const environments = useAtomValue(threadListEnvironmentsAtom);
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  const now = useThreadListNow(thread === null ? [] : [thread]);
  if (thread === null) return { actions: [], sheet: null };

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

  const actions: AppBarAction[] = [];
  const add = (action: Omit<AppBarAction, "overflowOnly">) =>
    actions.push({ ...action, overflowOnly: true });

  if (environments.settlementEnvironmentIds.has(environmentId)) {
    if (thread.settledOverride === "settled") {
      add({
        accessibilityLabel: "Un-settle",
        icon: "arrow.uturn.backward",
        onPress: () => void list.unsettleThread(thread),
      });
    } else {
      add({
        accessibilityLabel: "Settle",
        icon: "checkmark",
        onPress: () => void list.settleThread(thread),
      });
    }
  }
  if (snoozed) {
    add({
      accessibilityLabel: "Wake thread",
      icon: "clock",
      onPress: () => void list.unsnoozeThread(thread),
    });
  } else if (snoozePresets.length > 0) {
    add({
      accessibilityLabel: "Snooze",
      icon: "clock",
      onPress: () => undefined,
      subactions: [
        ...snoozePresets.map((preset) => ({
          title: preset.label,
          subtitle: preset.whenLabel,
          onPress: () => void list.snoozeThread(thread, preset.snoozedUntil),
        })),
        { title: "Custom…", onPress: () => setCustomSnoozeOpen(true) },
      ],
    });
  }
  if (environments.pinningEnvironmentIds.has(environmentId)) {
    add(
      thread.pinnedAt != null
        ? {
            accessibilityLabel: "Unpin",
            icon: "pin.slash",
            onPress: () => void list.unpinThread(thread),
          }
        : { accessibilityLabel: "Pin", icon: "pin", onPress: () => void list.pinThread(thread) },
    );
  }
  add({
    accessibilityLabel: "Rename",
    icon: "square.and.pencil",
    onPress: () => list.renameThread(thread),
  });
  if (environments.titleRegenerationEnvironmentIds.has(environmentId)) {
    const regenerating = thread.titleRegeneration != null;
    add({
      accessibilityLabel: regenerating ? "Regenerating…" : "Regenerate title",
      icon: "arrow.clockwise",
      disabled: regenerating,
      onPress: () => void list.regenerateThreadTitle(thread),
    });
  }
  if (environments.autoSettleOptOutEnvironmentIds.has(environmentId)) {
    const autoSettle = thread.autoSettleDisabledAt == null;
    add({
      accessibilityLabel: "Auto-settle",
      icon: "timer",
      selected: autoSettle,
      onPress: () => void list.setThreadAutoSettle(thread, !autoSettle),
    });
  }
  add({
    accessibilityLabel: "Copy thread ID",
    icon: "doc.on.doc",
    onPress: () => copyTextWithHaptic(thread.id, { target: "thread-id" }),
  });
  add({
    accessibilityLabel: "Archive",
    icon: "archivebox",
    onPress: () => void list.archiveThread(thread),
  });
  add({
    accessibilityLabel: "Delete",
    icon: "trash",
    destructive: true,
    onPress: () => list.confirmDeleteThread(thread),
  });

  return {
    actions,
    sheet: customSnoozeOpen ? (
      <CustomSnoozeSheet
        onClose={() => setCustomSnoozeOpen(false)}
        onSnooze={(snoozedUntil) => void list.snoozeThread(thread, snoozedUntil)}
      />
    ) : null,
  };
}

import { memo, useState } from "react";
import { ScrollView, View } from "react-native";
import type { ThreadTaskProgress } from "@t3tools/client-runtime/state/thread-plans";
import type { RunId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import {
  formatContextWindowTokens,
  type ContextWindowSnapshot,
} from "@t3tools/client-runtime/context-window";
import { AppText as Text } from "../../components/AppText";
import { ComposerInlineControl } from "../../components/ComposerToolbar";

export const ThreadComposerStatus = memo(function ThreadComposerStatus(props: {
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly taskProgress: ThreadTaskProgress | null;
  readonly connected: boolean;
}) {
  const [contextExpanded, setContextExpanded] = useState(false);
  const [expandedTaskRunId, setExpandedTaskRunId] = useState<RunId | null>(null);
  const usage = props.contextWindow;
  const progress = props.taskProgress;
  if (usage === null && progress === null) return null;
  const taskExpanded = progress !== null && expandedTaskRunId === progress.runId;
  const tokens = `${formatContextWindowTokens(usage?.usedTokens ?? null)}${
    usage?.maxTokens == null ? "" : `/${formatContextWindowTokens(usage.maxTokens)}`
  }`;
  const percentage = usage?.usedPercentage == null ? "" : ` · ${Math.round(usage.usedPercentage)}%`;
  const label = `${props.connected ? "Context" : "Last context"} ${tokens}${percentage}`;
  const reportedAt = usage === null ? null : new Date(usage.updatedAt).toLocaleString();

  return (
    <View>
      <View className="flex-row flex-wrap items-center justify-end">
        {progress !== null ? (
          <View className="min-w-0 grow basis-40">
            <ComposerInlineControl
              label={`${props.connected ? "" : "Last task · "}${progress.completedSteps}/${progress.totalSteps} · ${progress.step}`}
              maxWidth="100%"
              accessibilityLabel={`${taskExpanded ? "Hide" : "Show"} task checklist. ${progress.completedSteps} of ${progress.totalSteps} steps completed. Current step: ${progress.step}${props.connected ? "" : ". Disconnected; last reported progress"}`}
              expanded={taskExpanded}
              selected={taskExpanded}
              chevronDirection={taskExpanded ? "down" : "right"}
              onPress={() => setExpandedTaskRunId(taskExpanded ? null : progress.runId)}
            />
          </View>
        ) : null}
        {usage !== null ? (
          <ComposerInlineControl
            label={label}
            maxWidth="100%"
            accessibilityLabel={`${contextExpanded ? "Hide" : "Show"} context details. ${usage.usedTokens} tokens used${
              usage.maxTokens === null ? "" : ` out of ${usage.maxTokens}`
            }${percentage}${props.connected ? "" : ". Disconnected; last reported usage"}`}
            accessibilityHint={
              contextExpanded
                ? "Collapse the last provider report"
                : "Show when the provider last reported context usage"
            }
            selected={contextExpanded}
            expanded={contextExpanded}
            chevronDirection={contextExpanded ? "down" : "right"}
            onPress={() => setContextExpanded((expanded) => !expanded)}
          />
        ) : null}
      </View>
      {progress !== null && taskExpanded ? (
        <ScrollView className="max-h-40" keyboardShouldPersistTaps="handled">
          <View className="gap-2 px-2 pb-2">
            {progress.steps.map((step, index) => (
              <Text key={`${index}:${step.step}`} className="text-xs text-foreground-muted">
                {step.status === "inProgress"
                  ? "Running"
                  : step.status === "completed"
                    ? "Completed"
                    : "Pending"}
                : {step.step}
                {step.durationMs === undefined ? "" : ` · ${formatDuration(step.durationMs)}`}
              </Text>
            ))}
          </View>
        </ScrollView>
      ) : null}
      {usage !== null && contextExpanded ? (
        <View className="px-2 pb-2">
          <Text className="text-xs text-foreground-muted">
            {props.connected ? "Last provider report" : "Disconnected · last provider report"}:{" "}
            {reportedAt}
          </Text>
          {usage.maxTokens === null ? (
            <Text className="text-xs text-foreground-muted">Context limit unavailable.</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

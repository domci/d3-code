export type MergeCommitChecksState = "none" | "pending" | "passed" | "failed";

export interface MergeCommitChecks {
  readonly state: MergeCommitChecksState;
}

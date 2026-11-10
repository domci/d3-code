import { ManagedRelay, relayRequestFailureDetail } from "@t3tools/client-runtime/relay";
import * as Schema from "effect/Schema";

const isRequestFailed = Schema.is(ManagedRelay.ManagedRelayRequestFailedError);
const isRequestTimeout = Schema.is(ManagedRelay.ManagedRelayRequestTimeoutError);

/** One short line for an error toast saying why a D3 Connect request failed. */
export function relayFailureReason(cause: unknown): string | null {
  for (let current = cause, depth = 0; current instanceof Error && depth < 4; depth += 1) {
    if (isRequestTimeout(current)) return "D3 Connect timed out. Try again.";
    if (isRequestFailed(current)) {
      if (current.transportFailed) return "Could not reach D3 Connect. Check your network.";
      if (current.relayError) {
        return current.relayError._tag === "RelayInternalError"
          ? "D3 Connect is unavailable. Try again."
          : relayRequestFailureDetail(current);
      }
      if (current.status === 504) return "D3 Connect timed out. Try again.";
      if ((current.status ?? 0) >= 500) return "D3 Connect is unavailable. Try again.";
      return relayRequestFailureDetail(current);
    }
    current = current.cause;
  }
  return null;
}

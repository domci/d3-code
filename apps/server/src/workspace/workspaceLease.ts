import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import { canonicalPath } from "../canonicalPath.ts";

const leases = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

/**
 * Coordinates checkout removal and startup across threads using the same
 * location. Keyed by real path, so a stored path through a symlinked ancestor
 * and its direct form share one lease.
 */
export const withWorkspaceLease = <A, E, R>(
  path: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const cwd = canonicalPath(path);
    const lease = leases.get(cwd) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
    leases.set(cwd, lease);
    lease.users++;
    return lease.semaphore.withPermit(effect).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          lease.users--;
          if (lease.users === 0) leases.delete(cwd);
        }),
      ),
    );
  });

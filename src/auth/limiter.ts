import { setTimeout as sleep } from "node:timers/promises";

// In-memory passphrase attempt limits. Fine for a single replica; state resets on restart.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = 5;
// Caps guessing from rotating IPs. Locks out the owner too while it lasts, but issued tokens keep working.
const MAX_FAILURES_GLOBAL = 30;

const failuresByIp = new Map<string, number[]>();
let globalFailures: number[] = [];

function recent(times: number[] | undefined, now: number): number[] {
  return (times ?? []).filter((t) => now - t < WINDOW_MS);
}

// Times are ascending, so the count drops below max once times[length - max] leaves the window.
function waitFor(times: number[], max: number, now: number): number {
  return times.length >= max ? times[times.length - max] + WINDOW_MS - now : 0;
}

/** Milliseconds until another attempt is allowed, or 0 if allowed now. */
export function lockedFor(ip: string): number {
  const now = Date.now();
  globalFailures = recent(globalFailures, now);
  return Math.max(
    waitFor(recent(failuresByIp.get(ip), now), MAX_FAILURES_PER_IP, now),
    waitFor(globalFailures, MAX_FAILURES_GLOBAL, now),
  );
}

/** Records a failed attempt, then waits before letting the caller respond. */
export async function recordFailure(ip: string): Promise<void> {
  const now = Date.now();
  const ipFailures = [...recent(failuresByIp.get(ip), now), now];
  failuresByIp.set(ip, ipFailures);
  globalFailures = [...recent(globalFailures, now), now];
  if (failuresByIp.size > 1000) {
    for (const [key, times] of failuresByIp) {
      if (recent(times, now).length === 0) failuresByIp.delete(key);
    }
  }
  await sleep(Math.min(ipFailures.length, 5) * 1000);
}

export function recordSuccess(ip: string): void {
  failuresByIp.delete(ip);
}

export function withFixtureMutation(store, owner, mutation) { return store.fixtureMutation(owner, mutation); }

export async function withExternalFence(store, owner, mutation) {
  await store.assertFence(owner);
  return mutation();
}

export async function withRenewingLease(store, owner, { ttlSeconds, intervalMs, work }) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1 ||
      !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || intervalMs >= ttlSeconds * 1000 ||
      typeof work !== 'function') {
    throw new TypeError('invalid renewal supervision');
  }
  const confirmationStarted = performance.now();
  const confirmed = await store.assertFence(owner);
  if (!Number.isFinite(confirmed?.expiresAt) || !Number.isFinite(confirmed?.serverNow)) {
    throw new TypeError('confirmed lease expiry required');
  }
  const controller = new AbortController();
  let rejectLost;
  const lost = new Promise((_, reject) => { rejectLost = reject; });
  let stopped = false;
  let deadlineTimer;
  let renewalTimer;
  let renewalWaitTimer;
  let deadline;
  const error = (code) => Object.assign(new Error(code), { code });
  const fail = (reason) => {
    if (stopped || controller.signal.aborted) return;
    controller.abort(reason);
    rejectLost(reason);
  };
  const setDeadline = (lease, requestStarted) => {
    if (typeof lease?.expiresAt !== 'number' || typeof lease?.serverNow !== 'number' ||
        !Number.isFinite(lease.expiresAt) || !Number.isFinite(lease.serverNow)) return false;
    const remainingMs = (lease.expiresAt - lease.serverNow) * 1000;
    if (!Number.isFinite(remainingMs) || remainingMs <= 0 ||
        remainingMs > ttlSeconds * 1000 + 1) return false;
    deadline = requestStarted + remainingMs;
    const localRemainingMs = deadline - performance.now();
    if (localRemainingMs <= 0) return false;
    clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(() => fail(error('lease_expired')), localRemainingMs);
    return true;
  };
  const scheduleRenewal = () => {
    renewalTimer = setTimeout(async () => {
      if (stopped || controller.signal.aborted) return;
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) { fail(error('lease_expired')); return; }
      try {
        const renewalStarted = performance.now();
        const renewed = await Promise.race([
          store.renew({ attemptId: owner.attemptId, fence: owner.fence, ttlSeconds }),
          new Promise((_, reject) => {
            renewalWaitTimer = setTimeout(() => reject(error('lease_renewal_timeout')),
              Math.min(intervalMs, remainingMs));
          }),
        ]);
        clearTimeout(renewalWaitTimer);
        if (!stopped && !controller.signal.aborted) {
          if (setDeadline(renewed, renewalStarted)) scheduleRenewal();
          else fail(error('lease_expired'));
        }
      } catch (reason) { fail(reason); }
    }, intervalMs);
  };
  if (!setDeadline(confirmed, confirmationStarted)) throw error('lease_expired');
  scheduleRenewal();
  try { return await Promise.race([Promise.resolve().then(() => work(controller.signal)), lost]); }
  finally {
    stopped = true;
    clearTimeout(deadlineTimer);
    clearTimeout(renewalTimer);
    clearTimeout(renewalWaitTimer);
  }
}

export function withFixtureMutation(store, owner, mutation) { return store.fixtureMutation(owner, mutation); }

export async function withExternalFence(store, owner, mutation) {
  await store.assertFence(owner);
  return mutation();
}

export async function withRenewingLease(store, owner, { ttlSeconds, intervalMs, work }) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1 ||
      !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || typeof work !== 'function') {
    throw new TypeError('invalid renewal supervision');
  }
  await store.assertFence(owner);
  const controller = new AbortController();
  let rejectLost;
  const lost = new Promise((_, reject) => { rejectLost = reject; });
  let renewing = false;
  const timer = setInterval(async () => {
    if (renewing || controller.signal.aborted) return;
    renewing = true;
    try { await store.renew({ attemptId: owner.attemptId, fence: owner.fence, ttlSeconds }); }
    catch (error) { controller.abort(error); rejectLost(error); }
    finally { renewing = false; }
  }, intervalMs);
  try { return await Promise.race([work(controller.signal), lost]); }
  finally { clearInterval(timer); }
}

import { assertCurrentAttempt } from './contracts.mjs';

function hasOpaqueCapabilityShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== 0) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!prototype || prototype === Object.prototype) return false;
  const names = Reflect.ownKeys(prototype);
  return names.length === 1 && names[0] === 'constructor' &&
    typeof Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value === 'function';
}

export async function verifyChallengeCapability({ context, caseId, paymentIntentId,
  challengeWitnessProvider, challengeVerifier } = {}) {
  if (typeof challengeWitnessProvider?.obtain !== 'function' ||
      !/^pi_[A-Za-z0-9_]+$/u.test(paymentIntentId ?? '')) return false;
  const current = await assertCurrentAttempt(context);
  const binding = Object.freeze({ attemptId: context.owner.attemptId, fence: current.fence,
    caseId, paymentIntentId });
  let witness;
  try { witness = await challengeWitnessProvider.obtain(binding); }
  catch {
    await assertCurrentAttempt(context);
    return false;
  }
  const verified = await verifyOpaqueCapability({ witness, binding, verifier: challengeVerifier });
  await assertCurrentAttempt(context);
  return binding.attemptId === context.owner.attemptId && binding.fence === context.owner.fence &&
    binding.caseId === caseId && binding.paymentIntentId === paymentIntentId && verified;
}

export async function verifyOpaqueCapability({ witness, binding, verifier } = {}) {
  if (!hasOpaqueCapabilityShape(witness) || typeof verifier?.isOpaqueCapability !== 'function' ||
      typeof verifier?.verify !== 'function') return false;
  try {
    if (await verifier.isOpaqueCapability(witness, binding) !== true) return false;
    return await verifier.verify(witness, binding) === true;
  } catch {
    return false;
  }
}

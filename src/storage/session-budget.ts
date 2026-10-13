import { LIMITS } from "../shared/limits";

const NONESSENTIAL_SESSION_KEYS = [
  "windowCaptureSessionTest",
  "windowCapturePermissionTest",
  "organizerProviderJob",
] as const;

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export async function ensureSessionStorageCapacity(
  valuesToWrite: Record<string, unknown>,
  replacingKeys: readonly string[] = Object.keys(valuesToWrite),
): Promise<void> {
  const area = chrome.storage.session;
  if (typeof area.getBytesInUse !== "function") {
    throw new Error("Session storage capacity could not be checked.");
  }
  const [currentBytes, replacedBytes] = await Promise.all([
    area.getBytesInUse(null),
    area.getBytesInUse([...replacingKeys]),
  ]);
  const requiredBytes = encodedBytes(valuesToWrite);
  let projected = currentBytes - replacedBytes + requiredBytes;
  if (projected <= LIMITS.SESSION_STORAGE_SOFT_BUDGET_BYTES) return;

  await area.remove([...NONESSENTIAL_SESSION_KEYS]);
  const afterEviction = await area.getBytesInUse(null);
  const afterReplacementBytes = await area.getBytesInUse([...replacingKeys]);
  projected = afterEviction - afterReplacementBytes + requiredBytes;
  if (projected > LIMITS.SESSION_STORAGE_SOFT_BUDGET_BYTES) {
    throw new Error(
      `Session storage reserve would be crossed (${projected} bytes projected; ` +
        `${LIMITS.SESSION_STORAGE_RESERVE_BYTES} bytes must remain reserved).`,
    );
  }
}

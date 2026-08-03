import { uuidv7 } from 'uuidv7';

const STORAGE_KEY = 'ekon.device_id';

/**
 * A stable identifier for this browser installation, generated once and kept in
 * localStorage. Sent on every request and recorded on every movement and audit
 * event.
 *
 * It matters now for attribution — "which machine recorded this?" — and it
 * matters later because device identity cannot be backfilled onto history once
 * the offline milestone needs it.
 */
export function getDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const fresh = uuidv7();
    window.localStorage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    // Private browsing or storage disabled. A per-tab id is worse than a
    // persistent one but far better than failing the request.
    return uuidv7();
  }
}

/**
 * Business time, as a shop laptop states it and as the wire carries it.
 *
 * Every inventory workflow asks the same question — *when did this physically
 * happen?* — through the same `<input type="datetime-local">`, and every one of
 * them has to convert the answer the same way. Receiving books in a delivery,
 * removal records a sale; if the two rounded a local time to an instant
 * differently, the same afternoon would be two different moments in a permanent
 * ledger.
 *
 * So there is one conversion, here, and no workflow has its own. There is also
 * no time zone: no picker, no offset field, no guess. The browser's clock is
 * the shop's clock, and the server normalizes what it is sent.
 */

/**
 * A `Date` as `<input type="datetime-local">` wants it: `YYYY-MM-DDTHH:mm`, in
 * the browser's own time zone.
 *
 * Built from the local getters rather than from `toISOString`, which would
 * write UTC into a control the browser reads as local time — and so would show
 * somebody in Haiti a delivery arriving four hours from now.
 */
export function toLocalDateTimeInputValue(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * The instant a local date and time refers to, as an ISO timestamp — or `null`
 * when the control holds something that is not one.
 *
 * `new Date('2026-08-04T14:30')` is *local* time by specification, which is
 * exactly what the control means, and `toISOString()` then states the same
 * moment in UTC. No time zone is chosen, offered, or guessed at anywhere: the
 * browser's clock is the shop's clock.
 *
 * The round trip at the end is what refuses a date that does not exist.
 * `new Date('2026-02-31T10:00')` does not fail — it rolls forward to 3 March —
 * so a typo would otherwise be sent as a real and wrong business time.
 */
export function localDateTimeToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (toLocalDateTimeInputValue(date) !== value.slice(0, 16)) return null;

  return date.toISOString();
}

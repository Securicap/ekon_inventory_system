import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  MAX_MOVEMENT_QUANTITY,
  REMOVAL_REASONS,
  type RemovalReason,
  type RemoveStockRequest,
  type RemoveStockResponse,
} from '@ekon/shared';
import { useAuth } from '../auth/useAuth.js';
import { useProtectedQuery } from '../auth/useProtectedQuery.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { PRIMARY_BUTTON, SECONDARY_BUTTON, TEXT_INPUT } from '../components/styles.js';
import { useTranslator } from '../i18n/index.js';
import { ApiError } from '../lib/api.js';
import { localDateTimeToIso, toLocalDateTimeInputValue } from '../lib/businessTime.js';
import { getInventoryBalances, inventoryBalancesQueryKey } from '../lib/inventoryQueries.js';
import { newOperationId } from '../lib/operations.js';
import {
  balancesAreStaleAfter,
  canRetryRemoval,
  isInsufficientStock,
  isRemovable,
  isRemovableLocation,
  locationsForVariant,
  preferredRemovalLocationId,
  quantityAt,
  removableVariantChoices,
  validateRemovalForm,
  REMOVAL_REASON_LABEL_KEYS,
  type RemovalFieldErrors,
} from '../lib/removal.js';
import { removeStock } from '../lib/removalApi.js';

/**
 * Recording stock that left: one item, one shelf, one quantity, one reason, one
 * moment.
 *
 * The other half of the loop receiving opened, and the same permanent kind of
 * change — a movement in an append-only ledger. So the design question that
 * matters is the same one, and the answer is the same: the operation id names
 * the *intent*, is generated once when a removal begins rather than once per
 * attempt, and every retry sends it unchanged. Which means the honest
 * instruction to somebody who does not know whether their removal went through
 * is: press it again.
 *
 * What is genuinely different here, and shapes the screen:
 *
 *  - **the shelf matters.** Receiving puts stock somewhere; removal takes it
 *    from somewhere, and that somewhere either holds enough or does not. So the
 *    form shows what each shelf holds, and says the chosen one's quantity out
 *    loud before anybody types;
 *  - **the numbers are advisory.** They come from the last balance read, and
 *    somebody else at the counter may take the last two bottles in between. The
 *    server decides under the row lock it already holds. A `422` is a state
 *    this screen renders, not a case it prevents;
 *  - **a shortfall is definitive.** The transaction rolled back and the stock
 *    did not move, so "send it again" is not offered — the command itself has
 *    to change, and a changed command is a new removal with a new id.
 *
 * This is not an adjustment. Removal says stock left; an adjustment says the
 * record was wrong. That workflow has its own capability and does not exist
 * yet. It is not a sale either: `SOLD` is a reason a unit left, and there is no
 * customer, price, or receipt anywhere here.
 *
 * Nothing is written to `localStorage` or `sessionStorage`. A shared shop
 * laptop that remembered a half-finished removal would show it to whoever sat
 * down next, and a stored operation id would outlive the intent it named.
 */

/** Where a single removal attempt has got to. */
type Phase = 'editing' | 'failed' | 'succeeded';

/**
 * The command that was sent, with the words the person chose it by.
 *
 * The labels are captured at submission rather than looked up afterwards,
 * because by the time the answer arrives the balances may have been refetched
 * and the form reset. A confirmation has to name what was actually removed, not
 * whatever the lists say now.
 */
interface SentRemoval {
  request: RemoveStockRequest;
  variantLabel: string;
  locationName: string;
}

export function RemovalScreen() {
  const t = useTranslator();
  const { reportSessionEnded } = useAuth();
  const queryClient = useQueryClient();

  /**
   * The one read this screen makes, under the key the stock screen already
   * uses. Sharing it means a removal invalidates the numbers both screens show,
   * and that an employee who has just looked at Stock is not made to wait for
   * the same answer twice.
   */
  const balances = useProtectedQuery({
    queryKey: inventoryBalancesQueryKey,
    queryFn: ({ signal }) => getInventoryBalances(signal),
  });

  const choices = useMemo(() => removableVariantChoices(balances.data ?? []), [balances.data]);

  const [operationId, setOperationId] = useState(newOperationId);
  const [variantId, setVariantId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [occurredAtLocal, setOccurredAtLocal] = useState(() =>
    toLocalDateTimeInputValue(new Date()),
  );

  const [fieldErrors, setFieldErrors] = useState<RemovalFieldErrors>({});
  const [phase, setPhase] = useState<Phase>('editing');
  /**
   * The exact request that was sent, kept so a retry re-sends it rather than
   * rebuilding it from state that may have moved underneath — a shelf whose
   * quantity changed, say. A retry has to be the same command, byte for byte.
   */
  const [sent, setSent] = useState<SentRemoval | null>(null);
  /** What the server answered. Only ever set from a response. */
  const [result, setResult] = useState<RemoveStockResponse | null>(null);

  const variantRef = useRef<HTMLSelectElement>(null);
  const locationRef = useRef<HTMLSelectElement>(null);
  const quantityRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLSelectElement>(null);
  const occurredAtRef = useRef<HTMLInputElement>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);

  const locations = useMemo(
    () => (variantId === '' ? [] : locationsForVariant(choices, variantId)),
    [choices, variantId],
  );
  /** What the chosen shelf held at the last read. `null` until one is chosen. */
  const availableQuantity = locationId === '' ? null : quantityAt(locations, locationId);

  const submit = useMutation({
    mutationFn: removeStock,
    onSuccess: (response) => {
      setResult(response);
      setPhase('succeeded');

      /**
       * The stock the shop is holding just changed, and the current-stock
       * screen — and this screen's own choices — now say something out of date.
       *
       * Last, and deliberately after the confirmation state is set. The
       * movement is already permanent — the server answered `201` — so nothing
       * about tidying a cache may be allowed to turn a recorded removal into an
       * ambiguous "did that work?". A replay of an earlier removal answers
       * `201` too and invalidates identically, which costs one read and keeps
       * the two paths the same.
       *
       * Fire and forget, with the rejection swallowed for the same reason: the
       * promise resolves when the refetches it triggered settle, and a refetch
       * that fails must not reach back and unsay a confirmed removal. The
       * confirmation is rendered from `sent` and `result`, which no query can
       * touch.
       */
      void queryClient.invalidateQueries({ queryKey: inventoryBalancesQueryKey }).catch(() => {});
    },
    onError: (error) => {
      // A mutation is a protected request like any other, and a 401 back from
      // one means the same thing it means on a read: the session ended.
      if (error instanceof ApiError && error.status === 401) reportSessionEnded();
      setPhase('failed');

      /**
       * Three refusals mean the numbers on this screen are out of date: the
       * shelf did not hold enough, the item or location is gone, or it is no
       * longer active. Read them again *now*, so the employee decides what to
       * do next against the truth rather than against what this screen happened
       * to be showing when they pressed the button.
       *
       * Not an invalidation, and never for an uncertain outcome: nothing about
       * a dropped connection says the shelf moved, and refetching mid-retry
       * would show a number that may be about to change again.
       */
      if (balancesAreStaleAfter(error)) void balances.refetch();
    },
  });

  const busy = submit.isPending;
  const frozen = busy || phase !== 'editing';

  /**
   * A selection that is no longer offered is dropped rather than kept.
   *
   * The balances refetch — after a removal, after a stale-choice failure, on a
   * window focus — and a `<select>` whose value matches no option renders as
   * blank while still holding the old id in state. Submitting that would send a
   * shelf the person can no longer see.
   *
   * A shelf that has fallen to **zero** is dropped for the same reason: it is
   * no longer a selectable option, and leaving it chosen would leave a form
   * that looks ready and can only be refused. The current-quantity line
   * disappears with it, so the change is visible rather than silent.
   *
   * Guarded on `editing`, because a frozen attempt is answering for a command
   * that was already sent; nothing about a later read may disturb it.
   */
  useEffect(() => {
    if (!balances.data || phase !== 'editing') return;

    if (variantId !== '' && !choices.some((choice) => choice.variantId === variantId)) {
      setVariantId('');
      setLocationId('');
      return;
    }

    if (
      locationId !== '' &&
      !locations.some(
        (location) => location.locationId === locationId && isRemovableLocation(location),
      )
    ) {
      setLocationId('');
    }
  }, [balances.data, choices, locations, variantId, locationId, phase]);

  // The outcome — a confirmation or a failure — is where the reader needs to
  // be. It is announced by `role="status"` / `role="alert"`; moving focus as
  // well means somebody on a keyboard lands on it rather than on a form that
  // appears to have done nothing.
  useEffect(() => {
    if (phase !== 'editing') outcomeRef.current?.focus();
  }, [phase]);

  /**
   * Choosing an item chooses its shelf too, when there is only one sensible
   * one. The rule is in `lib/removal.ts`; what matters here is that it runs on
   * every change of item rather than once for the screen — the shelves belong
   * to the item, so a new item is a new question.
   */
  function chooseVariant(nextVariantId: string): void {
    setVariantId(nextVariantId);
    const nextLocations = nextVariantId === '' ? [] : locationsForVariant(choices, nextVariantId);
    setLocationId(preferredRemovalLocationId(nextLocations) ?? '');
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    // A second press while the first request is in flight. The server would
    // recognize the repeat and post once, but sending it at all would be this
    // screen asking a question it already asked.
    if (frozen) return;

    const values = { variantId, locationId, quantity, reason, occurredAtLocal };
    const errors = validateRemovalForm(values, { availableQuantity });

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      focusFirstInvalid(errors);
      return;
    }

    const occurredAt = localDateTimeToIso(occurredAtLocal);
    // Unreachable: validation above returns an error for anything that does not
    // convert. Guarded because the alternative is sending `null` as a business
    // time.
    if (occurredAt === null) return;

    setFieldErrors({});

    const request: RemoveStockRequest = {
      operationId,
      variantId,
      locationId,
      // Positive, always. Direction is the server workflow's, and a browser
      // that sent its own sign could add stock through this endpoint.
      quantity: Number(quantity),
      reason: reason as RemovalReason,
      occurredAt,
    };

    setSent({
      request,
      variantLabel: choices.find((choice) => choice.variantId === variantId)?.label ?? '',
      locationName:
        locations.find((location) => location.locationId === locationId)?.locationName ?? '',
    });

    submit.mutate(request);
  }

  function focusFirstInvalid(errors: RemovalFieldErrors): void {
    if (errors.variantId) variantRef.current?.focus();
    else if (errors.locationId) locationRef.current?.focus();
    else if (errors.quantity) quantityRef.current?.focus();
    else if (errors.reason) reasonRef.current?.focus();
    else if (errors.occurredAtLocal) occurredAtRef.current?.focus();
  }

  /** Sends the same command again, under the same id. Nothing is rebuilt. */
  function retrySameRemoval(): void {
    if (busy || !sent) return;
    setPhase('editing');
    submit.mutate(sent.request);
  }

  /**
   * Abandons whatever came before and starts a fresh removal: a **new**
   * operation id, and an empty form.
   *
   * Everything is cleared, including the shelf — and that is the difference
   * from receiving, which keeps the counter a delivery arrived at. A second
   * removal is rarely the same item from the same shelf, and a location left
   * over from the previous one is a wrong shelf that looks deliberate. Taking
   * stock off the wrong shelf is not a mistake a confirmation screen catches.
   */
  function startNewRemoval(): void {
    setOperationId(newOperationId());
    setVariantId('');
    setLocationId('');
    setQuantity('');
    setReason('');
    setOccurredAtLocal(toLocalDateTimeInputValue(new Date()));
    setFieldErrors({});
    setSent(null);
    setResult(null);
    setPhase('editing');
    submit.reset();
  }

  const removable = choices.filter(isRemovable);
  const noLocationsAtAll =
    choices.length > 0 && choices.every((choice) => choice.locations.length === 0);
  const describedBy = (...ids: (string | false | undefined)[]): string | undefined => {
    const present = ids.filter((id): id is string => typeof id === 'string');
    return present.length > 0 ? present.join(' ') : undefined;
  };

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-medium">{t('removal.title')}</h2>
        <p className="text-slate-600">{t('removal.description')}</p>
      </div>

      {balances.isPending && <p className="text-slate-600">{t('status.loading')}</p>}

      {/* A 403 lands here as "you may not do this" and nothing more. It does not
          sign anybody out: they are signed in, and signing in again would
          change nothing. */}
      {balances.isError && <ErrorNotice error={balances.error} />}

      {/* Three different empty answers, told apart. An empty catalog, a shop
          with no shelves, and a shop that has sold everything need different
          things done about them, and a blank dropdown says none of it. */}
      {balances.data?.length === 0 && <p className="text-slate-700">{t('stock.noVariants')}</p>}
      {noLocationsAtAll && <p className="text-slate-700">{t('removal.noLocations')}</p>}
      {balances.data && choices.length > 0 && !noLocationsAtAll && removable.length === 0 && (
        <p className="text-slate-700">{t('removal.noStock')}</p>
      )}

      {phase === 'succeeded' && sent && result && (
        <div ref={outcomeRef} tabIndex={-1}>
          <Confirmation sent={sent} result={result} />
        </div>
      )}

      {phase === 'failed' && (
        <div ref={outcomeRef} tabIndex={-1} className="flex flex-col gap-3">
          <ErrorNotice error={submit.error} />

          {/* A shortfall is the one refusal that needs saying twice, because
              the second sentence is the instruction rather than the fact: the
              numbers have moved, they have just been read again, and the way
              forward is a corrected removal rather than the same one. */}
          {isInsufficientStock(submit.error) && (
            <p className="text-slate-700">{t('removal.insufficientStock')}</p>
          )}

          <div className="flex flex-wrap gap-2">
            {/* Offered only when sending the same thing again could plausibly
                work — a dropped connection or a server fault, where the outcome
                is genuinely unknown. A shortfall, a refused permission, a gone
                item, or a changed command will be refused identically however
                many times it is sent. */}
            {canRetryRemoval(submit.error) && (
              <button type="button" className={PRIMARY_BUTTON} onClick={retrySameRemoval}>
                {t('removal.retrySame')}
              </button>
            )}
            <button type="button" className={SECONDARY_BUTTON} onClick={startNewRemoval}>
              {t('removal.startNew')}
            </button>
          </div>
        </div>
      )}

      {phase === 'succeeded' ? (
        <div>
          <button type="button" className={PRIMARY_BUTTON} onClick={startNewRemoval}>
            {t('removal.removeAnother')}
          </button>
        </div>
      ) : (
        <form
          onSubmit={handleSubmit}
          noValidate
          aria-busy={busy}
          className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4 sm:p-6"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="removal-variant" className="font-medium">
              {t('removal.variant')}
            </label>
            {/* The number after each name is what is on the shelf. Said once,
                here, so the options themselves stay short enough to read on a
                phone. */}
            <p id="removal-variant-hint" className="text-sm text-slate-600">
              {t('removal.stockHint')}
            </p>
            <select
              id="removal-variant"
              ref={variantRef}
              name="variantId"
              className={TEXT_INPUT}
              value={variantId}
              disabled={frozen}
              onChange={(event) => chooseVariant(event.target.value)}
              aria-invalid={fieldErrors.variantId ? true : undefined}
              aria-describedby={describedBy(
                'removal-variant-hint',
                fieldErrors.variantId && 'removal-variant-error',
              )}
            >
              <option value="">{t('removal.choose')}</option>
              {choices.map((choice) => (
                /* An item holding nothing stays in the list and cannot be
                   chosen. Removing it would make a shop that is out of rice
                   look like a shop that never sold rice — and the employee
                   still needs to see that the item exists and is at zero. */
                <option
                  key={choice.variantId}
                  value={choice.variantId}
                  disabled={!isRemovable(choice)}
                >
                  {choice.label} — {choice.totalQuantity}
                </option>
              ))}
            </select>
            {fieldErrors.variantId && (
              <p id="removal-variant-error" className="text-red-800">
                {t(fieldErrors.variantId)}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="removal-location" className="font-medium">
              {t('removal.location')}
            </label>
            <select
              id="removal-location"
              ref={locationRef}
              name="locationId"
              className={TEXT_INPUT}
              value={locationId}
              disabled={frozen || variantId === ''}
              onChange={(event) => setLocationId(event.target.value)}
              aria-invalid={fieldErrors.locationId ? true : undefined}
              aria-describedby={describedBy(
                fieldErrors.locationId && 'removal-location-error',
                availableQuantity !== null && 'removal-current-quantity',
              )}
            >
              <option value="">{t('removal.choose')}</option>
              {locations.map((location) => (
                /* Every shelf the item sits on, empty ones included and not
                   selectable. An employee who cannot see that the Main Store
                   is at zero will go and look for stock that is in the back. */
                <option
                  key={location.locationId}
                  value={location.locationId}
                  disabled={!isRemovableLocation(location)}
                >
                  {location.locationName} — {location.quantity}
                </option>
              ))}
            </select>
            {fieldErrors.locationId && (
              <p id="removal-location-error" className="text-red-800">
                {t(fieldErrors.locationId)}
              </p>
            )}
          </div>

          {/* The question this screen exists to answer, said in a sentence
              rather than left as a number beside a dropdown. It is what the
              last read said, which is why it is not called "available": nobody
              can promise it is still true a second from now. */}
          {availableQuantity !== null && (
            <p
              id="removal-current-quantity"
              className="rounded-md bg-slate-100 px-3 py-2 text-slate-900"
            >
              {t('removal.currentQuantity', { quantity: availableQuantity })}
            </p>
          )}

          <div className="flex flex-col gap-1">
            <label htmlFor="removal-quantity" className="font-medium">
              {t('removal.quantity')}
            </label>
            <input
              id="removal-quantity"
              ref={quantityRef}
              name="quantity"
              type="number"
              min={1}
              step={1}
              max={availableQuantity ?? MAX_MOVEMENT_QUANTITY}
              /* A phone keyboard with digits on it, at a counter, in a hurry. */
              inputMode="numeric"
              className={TEXT_INPUT}
              value={quantity}
              disabled={frozen}
              onChange={(event) => setQuantity(event.target.value)}
              aria-invalid={fieldErrors.quantity ? true : undefined}
              aria-describedby={describedBy(
                availableQuantity !== null && 'removal-current-quantity',
                fieldErrors.quantity && 'removal-quantity-error',
              )}
            />
            {fieldErrors.quantity && (
              <p id="removal-quantity-error" className="text-red-800">
                {t(fieldErrors.quantity, {
                  max: MAX_MOVEMENT_QUANTITY,
                  quantity: availableQuantity ?? 0,
                })}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="removal-reason" className="font-medium">
              {t('removal.reason')}
            </label>
            {/* The words are translated; the value sent is the stable code the
                ledger stores. An employee never reads `INTERNAL_USE`, and a
                report never counts "Itilize nan biznis la". */}
            <select
              id="removal-reason"
              ref={reasonRef}
              name="reason"
              className={TEXT_INPUT}
              value={reason}
              disabled={frozen}
              onChange={(event) => setReason(event.target.value)}
              aria-invalid={fieldErrors.reason ? true : undefined}
              aria-describedby={fieldErrors.reason ? 'removal-reason-error' : undefined}
            >
              <option value="">{t('removal.choose')}</option>
              {REMOVAL_REASONS.map((code) => (
                <option key={code} value={code}>
                  {t(REMOVAL_REASON_LABEL_KEYS[code])}
                </option>
              ))}
            </select>
            {fieldErrors.reason && (
              <p id="removal-reason-error" className="text-red-800">
                {t(fieldErrors.reason)}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="removal-occurred-at" className="font-medium">
              {t('removal.occurredAt')}
            </label>
            <input
              id="removal-occurred-at"
              ref={occurredAtRef}
              name="occurredAt"
              type="datetime-local"
              className={TEXT_INPUT}
              value={occurredAtLocal}
              disabled={frozen}
              onChange={(event) => setOccurredAtLocal(event.target.value)}
              aria-invalid={fieldErrors.occurredAtLocal ? true : undefined}
              aria-describedby={
                fieldErrors.occurredAtLocal ? 'removal-occurred-at-error' : undefined
              }
            />
            {fieldErrors.occurredAtLocal && (
              <p id="removal-occurred-at-error" className="text-red-800">
                {t(fieldErrors.occurredAtLocal)}
              </p>
            )}
          </div>

          {/* The button says what is happening, and it is where the keyboard
              already is when it happens, so its own name is the announcement. */}
          <button
            type="submit"
            className={PRIMARY_BUTTON}
            disabled={frozen || removable.length === 0}
          >
            {busy ? t('removal.submitting') : t('removal.submit')}
          </button>
        </form>
      )}
    </section>
  );
}

/**
 * What was recorded, in the terms the person used to record it.
 *
 * The item, the shelf, how many, why, and what is left — which is the number
 * they will be asked about. Deliberately not here: the movement id, the request
 * hash, the negative delta, the quantity before, the recorded time, the
 * movement type, the actor. Those are how the ledger keeps its own promises,
 * and none of them is something an employee can act on or should have to read.
 */
function Confirmation({ sent, result }: { sent: SentRemoval; result: RemoveStockResponse }) {
  const t = useTranslator();

  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-md border border-green-700 bg-green-50 px-4 py-3 text-green-900"
    >
      {/* A sentence, not a colour. Somebody who cannot tell green from grey
          reads exactly the same confirmation. */}
      <p className="font-medium">{t('removal.success', { quantity: sent.request.quantity })}</p>
      <p>
        {t('removal.resultingQuantity', {
          location: sent.locationName,
          quantity: result.quantityAfter,
        })}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-green-800">{t('removal.variant')}</dt>
        <dd className="font-medium">{sent.variantLabel}</dd>
        <dt className="text-green-800">{t('removal.location')}</dt>
        <dd className="font-medium">{sent.locationName}</dd>
        <dt className="text-green-800">{t('removal.reason')}</dt>
        <dd className="font-medium">{t(REMOVAL_REASON_LABEL_KEYS[sent.request.reason])}</dd>
      </dl>
    </div>
  );
}

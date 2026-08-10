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
import { PageHeader } from '../components/PageHeader.js';
import {
  DESTRUCTIVE_BUTTON,
  DESTRUCTIVE_BUTTON_BUSY,
  FIELD_ERROR,
  FIELD_HINT,
  FIELD_LABEL,
  OUTCOME_FOCUS,
  PANEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  TEXT_INPUT,
} from '../components/styles.js';
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
import {
  Confirmation,
  FailureActions,
  ShortfallNotice,
  UncertainNotice,
} from './removal/OutcomePanels.js';
import { RemovalSummary } from './removal/RemovalSummary.js';

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
 *
 * `request` is the snapshot a retry re-sends. It is built once, in
 * `handleSubmit`, and is never rebuilt from the fields afterwards — which is
 * what makes "send the same removal again" mean the same removal even though
 * the balances underneath may have moved.
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
  /**
   * The failure that put this attempt into the failed phase, kept rather than
   * read off the mutation.
   *
   * The mutation clears its own `error` the moment a retry goes pending, and
   * this screen has to go on saying what happened *while* the retry is in
   * flight — otherwise pressing "send the same removal again" would replace the
   * explanation of why with a blank, and the block the person is waiting on
   * would decide it had nothing to offer.
   */
  const [failure, setFailure] = useState<unknown>(null);

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
      setFailure(error);
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
   * A request in flight that this form started, as opposed to a resend of an
   * attempt that already failed. Both freeze the form; only the first is the
   * form's own progress to report.
   */
  const submitting = busy && phase === 'editing';

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

  /**
   * Sends the same command again, under the same id. Nothing is rebuilt.
   *
   * The phase stays `failed` for the whole flight. This attempt has not gone
   * back to being edited — it is the same saved removal being asked about a
   * second time — so the explanation of what happened, and the block that
   * offers this, stay on screen with the button marked busy. Dropping to
   * `editing` would put the ordinary form back under somebody who is waiting to
   * hear whether stock came off a shelf.
   */
  function retrySameRemoval(): void {
    if (busy || !sent) return;
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
    setFailure(null);
    setPhase('editing');
    submit.reset();
  }

  const removable = choices.filter(isRemovable);
  const noLocationsAtAll =
    choices.length > 0 && choices.every((choice) => choice.locations.length === 0);
  const choice = choices.find((candidate) => candidate.variantId === variantId);
  const locationName =
    locations.find((location) => location.locationId === locationId)?.locationName ?? '';
  const reasonLabel =
    reason === '' || !(reason in REMOVAL_REASON_LABEL_KEYS)
      ? ''
      : t(REMOVAL_REASON_LABEL_KEYS[reason as RemovalReason]);
  /** The typed quantity, only when it is a whole number this ledger can hold. */
  const typedQuantity = wholeQuantity(quantity);

  const describedBy = (...ids: (string | false | undefined)[]): string | undefined => {
    const present = ids.filter((id): id is string => typeof id === 'string');
    return present.length > 0 ? present.join(' ') : undefined;
  };

  /**
   * Stepping the quantity writes the same string the keyboard would write, into
   * the same field, and is offered only when it can produce a value the form
   * would accept — so a press can never make the field invalid, and the field
   * is still the place a quantity is entered.
   *
   * The ceiling is the ledger's, not the shelf's. What the shelf holds is the
   * last balance read and the server is the authority on it, so a stepper that
   * stopped at that number would be a browser calculation quietly enforcing
   * something it cannot know. Asking for more than is showing is refused by the
   * form with a sentence, whether it was typed or stepped.
   */
  function step(by: 1 | -1): void {
    if (typedQuantity === null) return;
    setQuantity(String(typedQuantity + by));
  }

  return (
    <section className="flex flex-col gap-6">
      <PageHeader title={t('removal.title')} subtitle={t('removal.description')} />

      {balances.isPending && (
        <p role="status" className="text-[15px] text-ink-soft">
          {t('status.loading')}
        </p>
      )}

      {/* A 403 lands here as "you may not do this" and nothing more. It does not
          sign anybody out: they are signed in, and signing in again would
          change nothing. */}
      {balances.isError && <ErrorNotice error={balances.error} />}

      {/* Three different empty answers, told apart. An empty catalog, a shop
          with no shelves, and a shop that has sold everything need different
          things done about them, and a blank dropdown says none of it. */}
      {balances.data?.length === 0 && (
        <p className="text-[15px] text-ink-soft">{t('stock.noVariants')}</p>
      )}
      {noLocationsAtAll && <p className="text-[15px] text-ink-soft">{t('removal.noLocations')}</p>}
      {balances.data && choices.length > 0 && !noLocationsAtAll && removable.length === 0 && (
        <p className="text-[15px] text-ink-soft">{t('removal.noStock')}</p>
      )}

      {phase === 'succeeded' && sent && result && (
        <div ref={outcomeRef} tabIndex={-1} className={OUTCOME_FOCUS}>
          <Confirmation
            quantity={sent.request.quantity}
            variantLabel={sent.variantLabel}
            locationName={sent.locationName}
            reasonLabel={t(REMOVAL_REASON_LABEL_KEYS[sent.request.reason])}
            result={result}
          />
        </div>
      )}

      {phase === 'failed' && (
        <div ref={outcomeRef} tabIndex={-1} className={`${OUTCOME_FOCUS} flex flex-col gap-4`}>
          {/* Three different failures, three different sentences. A retryable
              one is not a red error — it is "we do not know", and the honest
              instruction is to send the same thing again. A shortfall is the
              refusal this workflow exists to explain. Everything else is the
              shared notice, unchanged. */}
          {canRetryRemoval(failure) ? (
            <UncertainNotice error={failure} />
          ) : isInsufficientStock(failure) ? (
            <ShortfallNotice error={failure} />
          ) : (
            <ErrorNotice error={failure} />
          )}

          <FailureActions
            canRetry={canRetryRemoval(failure)}
            busy={busy}
            onRetry={retrySameRemoval}
            onStartNew={startNewRemoval}
          />
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
          className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_344px]"
        >
          <div className={`${PANEL} flex flex-col gap-5`}>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="removal-variant" className={FIELD_LABEL}>
                {t('removal.variant')}
              </label>
              {/* The number after each name is what is on the shelf. Said once,
                  here, so the options themselves stay short enough to read on a
                  phone. */}
              <p id="removal-variant-hint" className={FIELD_HINT}>
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
                {choices.map((candidate) => (
                  /* An item holding nothing stays in the list and cannot be
                     chosen. Removing it would make a shop that is out of rice
                     look like a shop that never sold rice — and the employee
                     still needs to see that the item exists and is at zero. */
                  <option
                    key={candidate.variantId}
                    value={candidate.variantId}
                    disabled={!isRemovable(candidate)}
                  >
                    {candidate.label} — {candidate.totalQuantity}
                  </option>
                ))}
              </select>
              {fieldErrors.variantId && (
                <p id="removal-variant-error" className={FIELD_ERROR}>
                  {t(fieldErrors.variantId)}
                </p>
              )}

              {/* The one line in the `<option>` broken back into the three
                  things it is, so the hierarchy is readable without opening the
                  list again. */}
              {choice !== undefined && (
                <div className="mt-1 rounded-md border-l-[3px] border-danger bg-danger-soft px-3.5 py-2.5">
                  <p className="text-base font-semibold text-ink">{choice.productName}</p>
                  <p className="text-sm text-ink">
                    {choice.attributes === '' ? t('catalog.noAttributes') : choice.attributes}
                  </p>
                  <p className="tabular text-[13px] text-ink-soft">
                    <span className="sr-only">{t('catalog.sku')} </span>
                    {choice.sku}
                  </p>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1.5 border-t border-rule pt-5">
              <label htmlFor="removal-location" className={FIELD_LABEL}>
                {t('removal.location')}
              </label>
              {/* Said in words, because the label alone leaves "from" to be
                  inferred from a verb somewhere above it. Receiving's location
                  is where stock arrives; this one is the shelf it comes off. */}
              <p id="removal-location-hint" className={FIELD_HINT}>
                {t('removal.locationHint')}
              </p>
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
                  'removal-location-hint',
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
                <p id="removal-location-error" className={FIELD_ERROR}>
                  {t(fieldErrors.locationId)}
                </p>
              )}

              {/* The question this screen exists to answer, said in a sentence
                  rather than left as a number beside a dropdown. It is what the
                  last read said, which is why it is not called "available":
                  nobody can promise it is still true a second from now. */}
              {availableQuantity !== null && (
                <p
                  id="removal-current-quantity"
                  className="mt-1 rounded-md bg-fill px-3.5 py-2.5 text-[15px] text-ink"
                >
                  {t('removal.currentQuantity', { quantity: availableQuantity })}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5 border-t border-rule pt-5">
              <label htmlFor="removal-quantity" className={FIELD_LABEL}>
                {t('removal.quantity')}
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={`${SECONDARY_BUTTON} size-12 shrink-0 px-0 text-xl`}
                  aria-label={t('removal.quantityMinus')}
                  disabled={frozen || typedQuantity === null || typedQuantity <= 1}
                  onClick={() => step(-1)}
                >
                  <span aria-hidden="true">&minus;</span>
                </button>
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
                  className={`${TEXT_INPUT} tabular w-28 text-center text-xl font-bold`}
                  value={quantity}
                  disabled={frozen}
                  onChange={(event) => setQuantity(event.target.value)}
                  aria-invalid={fieldErrors.quantity ? true : undefined}
                  aria-describedby={describedBy(
                    availableQuantity !== null && 'removal-current-quantity',
                    fieldErrors.quantity && 'removal-quantity-error',
                  )}
                />
                <button
                  type="button"
                  className={`${SECONDARY_BUTTON} size-12 shrink-0 px-0 text-xl`}
                  aria-label={t('removal.quantityPlus')}
                  disabled={
                    frozen || typedQuantity === null || typedQuantity >= MAX_MOVEMENT_QUANTITY
                  }
                  onClick={() => step(1)}
                >
                  <span aria-hidden="true">+</span>
                </button>
              </div>
              {fieldErrors.quantity && (
                <p id="removal-quantity-error" className={FIELD_ERROR}>
                  {t(fieldErrors.quantity, {
                    max: MAX_MOVEMENT_QUANTITY,
                    quantity: availableQuantity ?? 0,
                  })}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5 border-t border-rule pt-5">
              <label htmlFor="removal-reason" className={FIELD_LABEL}>
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
                <p id="removal-reason-error" className={FIELD_ERROR}>
                  {t(fieldErrors.reason)}
                </p>
              )}
            </div>

            {/* Lower emphasis than the item, the shelf, and the quantity: it is
                pre-filled with now and is usually right. It is still an editable
                business time rather than the moment the button was pressed —
                stock counted this morning and entered this afternoon left this
                morning. */}
            <div className="flex flex-col gap-1.5 border-t border-rule pt-5">
              <label htmlFor="removal-occurred-at" className={FIELD_LABEL}>
                {t('removal.occurredAt')}
              </label>
              <input
                id="removal-occurred-at"
                ref={occurredAtRef}
                name="occurredAt"
                type="datetime-local"
                className={`${TEXT_INPUT} tabular max-w-72`}
                value={occurredAtLocal}
                disabled={frozen}
                onChange={(event) => setOccurredAtLocal(event.target.value)}
                aria-invalid={fieldErrors.occurredAtLocal ? true : undefined}
                aria-describedby={
                  fieldErrors.occurredAtLocal
                    ? 'removal-occurred-at-error'
                    : 'removal-occurred-at-hint'
                }
              />
              {fieldErrors.occurredAtLocal ? (
                <p id="removal-occurred-at-error" className={FIELD_ERROR}>
                  {t(fieldErrors.occurredAtLocal)}
                </p>
              ) : (
                <p id="removal-occurred-at-hint" className={FIELD_HINT}>
                  {t('removal.occurredAtHint')}
                </p>
              )}
            </div>
          </div>

          <RemovalSummary
            choice={choice}
            locationName={locationName}
            quantity={typedQuantity}
            reasonLabel={reasonLabel}
            occurredAtLocal={occurredAtLocal}
          >
            {/* The button says what is happening, and it is where the keyboard
                already is when it happens, so its own name is the announcement.
                A second live region beside it would say the same thing twice and
                leave the confirmation competing with it to be read.

                It reports busy only for its *own* submission. A resend belongs
                to the block that offered it, and two buttons claiming to be
                working on the same request is one claim too many.

                Red, and it says what it does. The colour is a confirmation of
                the sentence rather than a substitute for it: somebody who
                cannot see it still reads "record the removal". */}
            <button
              type="submit"
              className={`${submitting ? DESTRUCTIVE_BUTTON_BUSY : DESTRUCTIVE_BUTTON} min-h-touch-lg w-full text-[17px]`}
              disabled={frozen || removable.length === 0}
              aria-busy={submitting}
            >
              {submitting && (
                <span
                  aria-hidden="true"
                  className="mr-2.5 inline-block size-3.5 animate-spin rounded-full border-2 border-white/45 border-t-white motion-reduce:animate-none"
                />
              )}
              {submitting ? t('removal.submitting') : t('removal.submit')}
            </button>
          </RemovalSummary>
        </form>
      )}
    </section>
  );
}

/**
 * The quantity as a number, but only when it is one the ledger could hold: a
 * whole number of units, at least one, no larger than the movement ceiling.
 *
 * Anything else is `null` — which is what the summary shows a dash for and what
 * makes the steppers unavailable. It is a reading of the field, never a
 * correction of it: a value the form would refuse stays on screen to be
 * refused, rather than being quietly rounded into something else.
 */
function wholeQuantity(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_MOVEMENT_QUANTITY) return null;
  return parsed;
}

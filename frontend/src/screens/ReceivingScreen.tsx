import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  MAX_MOVEMENT_QUANTITY,
  type ListInventoryLocationsResponse,
  type ReceiveStockRequest,
  type ReceiveStockResponse,
} from '@ekon/shared';
import { useAuth } from '../auth/useAuth.js';
import { useProtectedQuery } from '../auth/useProtectedQuery.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { PageHeader } from '../components/PageHeader.js';
import {
  FIELD_ERROR,
  FIELD_HINT,
  FIELD_LABEL,
  PANEL,
  PRIMARY_BUTTON,
  PRIMARY_BUTTON_BUSY,
  SECONDARY_BUTTON,
  TEXT_INPUT,
} from '../components/styles.js';
import { useTranslator } from '../i18n/index.js';
import { api, ApiError, NetworkError } from '../lib/api.js';
import { localDateTimeToIso, toLocalDateTimeInputValue } from '../lib/businessTime.js';
import { catalogProductsQueryKey, getCatalogProducts } from '../lib/catalogQueries.js';
import { inventoryBalancesQueryKey } from '../lib/inventoryQueries.js';
import { newOperationId } from '../lib/operations.js';
import {
  activeLocations,
  activeVariantChoices,
  preferredLocationId,
  validateReceivingForm,
  type ReceivingFieldErrors,
} from '../lib/receiving.js';
import { receiveStock } from '../lib/receivingApi.js';
import { Confirmation, FailureActions, UncertainNotice } from './receiving/OutcomePanels.js';
import { ReceiptSummary } from './receiving/ReceiptSummary.js';

/**
 * Booking in a delivery: one item, one place, one quantity, one arrival time.
 *
 * This is the first screen in the application that changes anything, and the
 * thing it changes is permanent — a movement in an append-only ledger. So the
 * design question that matters here is not layout, it is what happens when the
 * connection drops halfway through, which at a shop counter in Haiti is not an
 * edge case.
 *
 * The answer is the operation id. It names the *intent* — "this delivery, this
 * many, here, at this time" — and is generated once when a fresh receipt
 * begins, not once per attempt. Every retry sends the same id and the same
 * fields, so the server recognizes the repeat and answers with the movement it
 * already posted rather than posting a second one. Which means the honest
 * instruction to somebody who does not know whether their receipt went through
 * is: press it again.
 *
 * Nothing here is written to `localStorage` or `sessionStorage`. A shared shop
 * laptop that remembered a half-finished delivery would show it to whoever sat
 * down next, and a stored operation id would outlive the intent it named.
 */

/** Where a single receiving attempt has got to. */
type Phase = 'editing' | 'failed' | 'succeeded';

/**
 * The command that was sent, with the words the person chose it by.
 *
 * The labels are captured at submission rather than looked up afterwards,
 * because by the time the answer arrives the form may have been reset and the
 * catalog may have been refetched. A confirmation has to name what was actually
 * received, not whatever the lists say now.
 */
interface SentReceipt {
  request: ReceiveStockRequest;
  variantLabel: string;
  locationName: string;
}

export function ReceivingScreen() {
  const t = useTranslator();
  const { reportSessionEnded } = useAuth();
  const queryClient = useQueryClient();

  const products = useProtectedQuery({
    queryKey: catalogProductsQueryKey,
    queryFn: ({ signal }) => getCatalogProducts(signal),
  });

  const locations = useProtectedQuery({
    queryKey: ['inventory', 'locations'],
    queryFn: ({ signal }) =>
      api.get<ListInventoryLocationsResponse>('/api/inventory/locations', signal),
  });

  const variantChoices = useMemo(() => activeVariantChoices(products.data ?? []), [products.data]);
  const locationChoices = useMemo(() => activeLocations(locations.data ?? []), [locations.data]);

  /**
   * The id of the receipt being entered. Generated here — when the screen
   * opens — and replaced only by starting a new one.
   */
  const [operationId, setOperationId] = useState(newOperationId);
  const [variantId, setVariantId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [occurredAtLocal, setOccurredAtLocal] = useState(() =>
    toLocalDateTimeInputValue(new Date()),
  );

  const [fieldErrors, setFieldErrors] = useState<ReceivingFieldErrors>({});
  const [phase, setPhase] = useState<Phase>('editing');
  /**
   * The exact request that was sent, kept so a retry re-sends it rather than
   * rebuilding it from state that may have moved underneath — a location that
   * was deactivated, say. A retry has to be the same command, byte for byte.
   */
  const [sent, setSent] = useState<SentReceipt | null>(null);
  /** What the server answered. Only ever set from a response. */
  const [result, setResult] = useState<ReceiveStockResponse | null>(null);
  /**
   * The failure that put this attempt into the failed phase, kept rather than
   * read off the mutation.
   *
   * The mutation clears its own `error` the moment a retry goes pending, and
   * this screen has to go on saying what happened *while* the retry is in
   * flight — otherwise pressing "send the same receipt again" would replace the
   * explanation of why with a blank, and the block the person is waiting on
   * would decide it had nothing to offer.
   */
  const [failure, setFailure] = useState<unknown>(null);

  const variantRef = useRef<HTMLSelectElement>(null);
  const locationRef = useRef<HTMLSelectElement>(null);
  const quantityRef = useRef<HTMLInputElement>(null);
  const occurredAtRef = useRef<HTMLInputElement>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  /** Whether the starting location has been chosen for this screen already. */
  const defaultLocationApplied = useRef(false);

  const submit = useMutation({
    mutationFn: receiveStock,
    onSuccess: (response) => {
      setResult(response);
      setPhase('succeeded');

      /**
       * The stock the shop is holding just changed, and the current-stock
       * screen is the one read model that now says something out of date.
       *
       * Last, and deliberately after the confirmation state is set. The
       * movement is already permanent — the server answered `201` — so nothing
       * about tidying a cache may be allowed to turn a booked delivery into an
       * ambiguous "did that work?". A replay of an earlier receipt answers
       * `201` too and invalidates identically, which costs one read and keeps
       * the two paths the same.
       *
       * Fire and forget, with the rejection swallowed for the same reason: the
       * promise resolves when the refetches it triggered settle, and a refetch
       * that fails is the stock screen's problem to render, not this screen's
       * to report. The catalog and the location list are untouched — receiving
       * created no product and opened no counter.
       */
      void queryClient.invalidateQueries({ queryKey: inventoryBalancesQueryKey }).catch(() => {});
    },
    onError: (error) => {
      // A mutation is a protected request like any other, and a 401 back from
      // one means the same thing it means on a read: the session ended. Reads
      // go through `useProtectedQuery`; this is the same rule, said once here
      // because there is one write in the application.
      if (error instanceof ApiError && error.status === 401) reportSessionEnded();
      setFailure(error);
      setPhase('failed');
    },
  });

  /**
   * A selection that is no longer offered is dropped rather than kept.
   *
   * The catalog can change while this screen is open — a variant retired, a
   * location closed — and a `<select>` whose value matches no option renders as
   * blank while still holding the old id in state. Submitting that would send a
   * variant the person can no longer see, which is worse than making them
   * choose again.
   */
  useEffect(() => {
    if (!products.data) return;
    if (variantId !== '' && !variantChoices.some((choice) => choice.variantId === variantId)) {
      setVariantId('');
    }
  }, [products.data, variantChoices, variantId]);

  /**
   * The same rule for locations, plus the one the form starts on.
   *
   * The default is applied **once**, when the locations first arrive, and never
   * again. An effect that kept re-applying it would put the counter back every
   * time somebody deliberately cleared the field, which is a form arguing with
   * the person filling it in.
   */
  useEffect(() => {
    if (!locations.data) return;

    if (!defaultLocationApplied.current) {
      defaultLocationApplied.current = true;
      const preferred = preferredLocationId(locationChoices);
      if (preferred !== null) setLocationId(preferred);
      return;
    }

    if (locationId !== '' && !locationChoices.some((location) => location.id === locationId)) {
      setLocationId('');
    }
  }, [locations.data, locationChoices, locationId]);

  // The outcome — a confirmation or a failure — is where the reader needs to
  // be. It is announced by `role="status"` / `role="alert"`; moving focus as
  // well means somebody on a keyboard lands on it rather than on a form that
  // appears to have done nothing.
  useEffect(() => {
    if (phase !== 'editing') outcomeRef.current?.focus();
  }, [phase]);

  const sourcesReady = variantChoices.length > 0 && locationChoices.length > 0;
  const busy = submit.isPending;
  /**
   * A request in flight that this form started, as opposed to a resend of an
   * attempt that already failed. Both disable the form; only the first is the
   * form's own progress to report.
   */
  const submitting = busy && phase === 'editing';

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    // A second press while the first request is in flight. The server would
    // recognize the repeat and post once, but sending it at all would be this
    // screen asking a question it already asked.
    if (busy || phase !== 'editing') return;

    const values = { variantId, locationId, quantity, occurredAtLocal };
    const errors = validateReceivingForm(values);

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

    const request: ReceiveStockRequest = {
      operationId,
      variantId,
      locationId,
      quantity: Number(quantity),
      occurredAt,
    };

    setSent({
      request,
      variantLabel: variantChoices.find((choice) => choice.variantId === variantId)?.label ?? '',
      locationName: locationChoices.find((location) => location.id === locationId)?.name ?? '',
    });

    submit.mutate(request);
  }

  function focusFirstInvalid(errors: ReceivingFieldErrors): void {
    if (errors.variantId) variantRef.current?.focus();
    else if (errors.locationId) locationRef.current?.focus();
    else if (errors.quantity) quantityRef.current?.focus();
    else if (errors.occurredAtLocal) occurredAtRef.current?.focus();
  }

  /**
   * Sends the same command again, under the same id. Nothing is rebuilt.
   *
   * The phase stays `failed` for the whole flight. This attempt has not gone
   * back to being edited — it is the same saved receipt being asked about a
   * second time — so the explanation of what happened, and the block that
   * offers this, stay on screen with the button marked busy. Dropping to
   * `editing` would put the ordinary form back under somebody who is waiting to
   * hear whether their delivery was written.
   */
  function retrySameReceipt(): void {
    if (busy || !sent) return;
    submit.mutate(sent.request);
  }

  /**
   * Abandons whatever came before and starts a fresh receipt: a **new**
   * operation id, an empty item and quantity, and the current time.
   *
   * The location is kept, because a second delivery almost always arrives at
   * the same counter as the first, and re-choosing it every time is friction
   * for no safety. It is the one field that carries over, and it carries over
   * into a command with a new identity, so nothing about the previous attempt
   * survives.
   *
   * `refreshChoices` reloads the catalog and locations, for the failures that
   * mean the lists themselves were stale — an item that no longer exists, or
   * one that is no longer active. After a success there is nothing to refresh:
   * receiving does not change the catalog.
   */
  function startNewReceipt(options: { refreshChoices: boolean }): void {
    setOperationId(newOperationId());
    setVariantId('');
    setQuantity('');
    setOccurredAtLocal(toLocalDateTimeInputValue(new Date()));
    setFieldErrors({});
    setSent(null);
    setResult(null);
    setFailure(null);
    setPhase('editing');
    submit.reset();

    if (options.refreshChoices) {
      void products.refetch();
      void locations.refetch();
    }
  }

  const loading = products.isPending || locations.isPending;
  const choice = variantChoices.find((candidate) => candidate.variantId === variantId);
  const locationName = locationChoices.find((location) => location.id === locationId)?.name ?? '';
  const selectedLocation = locationChoices.find((location) => location.id === locationId);
  /** The typed quantity, only when it is a whole number this ledger can hold. */
  const typedQuantity = wholeQuantity(quantity);
  const locked = busy || phase === 'failed';

  /**
   * Stepping the quantity writes the same string the keyboard would write, into
   * the same field, and is offered only when it can produce a value the form
   * would accept — so a press can never make the field invalid, and the field
   * is still the place a quantity is entered.
   */
  function step(by: 1 | -1): void {
    if (typedQuantity === null) return;
    setQuantity(String(typedQuantity + by));
  }

  return (
    <section className="flex flex-col gap-6">
      <PageHeader title={t('receiving.title')} subtitle={t('receiving.description')} />

      {loading && (
        <p role="status" className="text-[15px] text-ink-soft">
          {t('status.loading')}
        </p>
      )}

      {products.isError && <ErrorNotice error={products.error} />}
      {locations.isError && <ErrorNotice error={locations.error} />}

      {products.data && variantChoices.length === 0 && (
        <p className="text-[15px] text-ink-soft">{t('receiving.noVariants')}</p>
      )}
      {locations.data && locationChoices.length === 0 && (
        <p className="text-[15px] text-ink-soft">{t('receiving.noLocations')}</p>
      )}

      {phase === 'succeeded' && sent && result && (
        <div ref={outcomeRef} tabIndex={-1}>
          <Confirmation
            quantity={sent.request.quantity}
            variantLabel={sent.variantLabel}
            locationName={sent.locationName}
            result={result}
          />
        </div>
      )}

      {phase === 'failed' && (
        <div ref={outcomeRef} tabIndex={-1} className="flex flex-col gap-4">
          {/* A retryable failure is not a red error — it is "we do not know",
              and the honest instruction is to send the same thing again. A
              definitive refusal is the shared notice, unchanged. */}
          {canRetry(failure) ? (
            <UncertainNotice error={failure} />
          ) : (
            <ErrorNotice error={failure} />
          )}

          <FailureActions
            canRetry={canRetry(failure)}
            busy={busy}
            onRetry={retrySameReceipt}
            onStartNew={() => startNewReceipt({ refreshChoices: true })}
          />
        </div>
      )}

      {phase === 'succeeded' ? (
        <div>
          <button
            type="button"
            className={PRIMARY_BUTTON}
            onClick={() => startNewReceipt({ refreshChoices: false })}
          >
            {t('receiving.receiveAnother')}
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
              <label htmlFor="receiving-variant" className={FIELD_LABEL}>
                {t('receiving.variant')}
              </label>
              <select
                id="receiving-variant"
                ref={variantRef}
                name="variantId"
                className={TEXT_INPUT}
                value={variantId}
                disabled={locked}
                onChange={(event) => setVariantId(event.target.value)}
                aria-invalid={fieldErrors.variantId ? true : undefined}
                aria-describedby={fieldErrors.variantId ? 'receiving-variant-error' : undefined}
              >
                <option value="">{t('receiving.choose')}</option>
                {variantChoices.map((candidate) => (
                  <option key={candidate.variantId} value={candidate.variantId}>
                    {candidate.label}
                  </option>
                ))}
              </select>
              {fieldErrors.variantId && (
                <p id="receiving-variant-error" className={FIELD_ERROR}>
                  {t(fieldErrors.variantId)}
                </p>
              )}

              {/* The one line in the `<option>` broken back into the three
                  things it is, so the hierarchy is readable without opening the
                  list again. */}
              {choice !== undefined && (
                <div className="mt-1 rounded-md border-l-[3px] border-accent bg-accent-soft px-3.5 py-2.5">
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
              <label htmlFor="receiving-location" className={FIELD_LABEL}>
                {t('receiving.location')}
              </label>
              <select
                id="receiving-location"
                ref={locationRef}
                name="locationId"
                className={TEXT_INPUT}
                value={locationId}
                disabled={locked}
                onChange={(event) => setLocationId(event.target.value)}
                aria-invalid={fieldErrors.locationId ? true : undefined}
                aria-describedby={fieldErrors.locationId ? 'receiving-location-error' : undefined}
              >
                <option value="">{t('receiving.choose')}</option>
                {locationChoices.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
              {fieldErrors.locationId && (
                <p id="receiving-location-error" className={FIELD_ERROR}>
                  {t(fieldErrors.locationId)}
                </p>
              )}
              {/* Said in words rather than by a highlight: this is the counter
                  the shop receives at, and it is why the field was already
                  filled in. */}
              {selectedLocation?.isDefault === true && (
                <p className={FIELD_HINT}>{t('receiving.locationPrefilled')}</p>
              )}
            </div>

            <div className="flex flex-wrap gap-6 border-t border-rule pt-5">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="receiving-quantity" className={FIELD_LABEL}>
                  {t('receiving.quantity')}
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={`${SECONDARY_BUTTON} size-12 shrink-0 px-0 text-xl`}
                    aria-label={t('receiving.quantityMinus')}
                    disabled={locked || typedQuantity === null || typedQuantity <= 1}
                    onClick={() => step(-1)}
                  >
                    <span aria-hidden="true">&minus;</span>
                  </button>
                  <input
                    id="receiving-quantity"
                    ref={quantityRef}
                    name="quantity"
                    type="number"
                    min={1}
                    step={1}
                    max={MAX_MOVEMENT_QUANTITY}
                    /* A phone keyboard with digits on it, at a counter, in a hurry. */
                    inputMode="numeric"
                    className={`${TEXT_INPUT} tabular w-28 text-center text-xl font-bold`}
                    value={quantity}
                    disabled={locked}
                    onChange={(event) => setQuantity(event.target.value)}
                    aria-invalid={fieldErrors.quantity ? true : undefined}
                    aria-describedby={fieldErrors.quantity ? 'receiving-quantity-error' : undefined}
                  />
                  <button
                    type="button"
                    className={`${SECONDARY_BUTTON} size-12 shrink-0 px-0 text-xl`}
                    aria-label={t('receiving.quantityPlus')}
                    disabled={
                      locked || typedQuantity === null || typedQuantity >= MAX_MOVEMENT_QUANTITY
                    }
                    onClick={() => step(1)}
                  >
                    <span aria-hidden="true">+</span>
                  </button>
                </div>
                {fieldErrors.quantity && (
                  <p id="receiving-quantity-error" className={FIELD_ERROR}>
                    {t(fieldErrors.quantity, { max: MAX_MOVEMENT_QUANTITY })}
                  </p>
                )}
              </div>

              <div className="flex min-w-60 flex-1 flex-col gap-1.5">
                <label htmlFor="receiving-occurred-at" className={FIELD_LABEL}>
                  {t('receiving.occurredAt')}
                </label>
                <input
                  id="receiving-occurred-at"
                  ref={occurredAtRef}
                  name="occurredAt"
                  type="datetime-local"
                  className={`${TEXT_INPUT} tabular`}
                  value={occurredAtLocal}
                  disabled={locked}
                  onChange={(event) => setOccurredAtLocal(event.target.value)}
                  aria-invalid={fieldErrors.occurredAtLocal ? true : undefined}
                  aria-describedby={
                    fieldErrors.occurredAtLocal ? 'receiving-occurred-at-error' : undefined
                  }
                />
                {fieldErrors.occurredAtLocal ? (
                  <p id="receiving-occurred-at-error" className={FIELD_ERROR}>
                    {t(fieldErrors.occurredAtLocal)}
                  </p>
                ) : (
                  <p className={FIELD_HINT}>{t('receiving.occurredAtHint')}</p>
                )}
              </div>
            </div>
          </div>

          <ReceiptSummary choice={choice} locationName={locationName} quantity={typedQuantity}>
            {/* The button says what is happening, and it is where the keyboard
                already is when it happens, so its own name is the announcement.
                A second live region beside it would say the same thing twice and
                leave the confirmation competing with it to be read.

                It reports busy only for its *own* submission. A resend belongs
                to the block that offered it, and two buttons claiming to be
                working on the same request is one claim too many. */}
            <button
              type="submit"
              className={`${submitting ? PRIMARY_BUTTON_BUSY : PRIMARY_BUTTON} min-h-touch-lg w-full text-[17px]`}
              disabled={busy || phase === 'failed' || !sourcesReady}
              aria-busy={submitting}
            >
              {submitting && (
                <span
                  aria-hidden="true"
                  className="mr-2.5 inline-block size-3.5 animate-spin rounded-full border-2 border-white/45 border-t-white motion-reduce:animate-none"
                />
              )}
              {submitting ? t('receiving.submitting') : t('receiving.submit')}
            </button>
          </ReceiptSummary>
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

/**
 * Whether sending the identical command again could plausibly succeed.
 *
 * A dropped connection and a server fault are both "we do not know whether that
 * worked", and the operation id is what makes asking again safe. Everything
 * else — a refused permission, an item that is gone, an id already used for a
 * different command — is the server stating something true that a second
 * identical request will not change.
 */
function canRetry(error: unknown): boolean {
  if (error instanceof NetworkError) return true;
  return error instanceof ApiError && error.status >= 500;
}

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  MAX_MOVEMENT_QUANTITY,
  type ListInventoryLocationsResponse,
  type ListProductsResponse,
  type ReceiveStockRequest,
  type ReceiveStockResponse,
} from '@ekon/shared';
import { useAuth } from '../auth/useAuth.js';
import { useProtectedQuery } from '../auth/useProtectedQuery.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { PRIMARY_BUTTON, SECONDARY_BUTTON, TEXT_INPUT } from '../components/styles.js';
import { useTranslator } from '../i18n/index.js';
import { api, ApiError, NetworkError } from '../lib/api.js';
import { inventoryBalancesQueryKey } from '../lib/inventoryQueries.js';
import { newOperationId } from '../lib/operations.js';
import {
  activeLocations,
  activeVariantChoices,
  localDateTimeToIso,
  preferredLocationId,
  toLocalDateTimeInputValue,
  validateReceivingForm,
  type ReceivingFieldErrors,
} from '../lib/receiving.js';
import { receiveStock } from '../lib/receivingApi.js';

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
    queryKey: ['catalog', 'products'],
    queryFn: ({ signal }) => api.get<ListProductsResponse>('/api/catalog/products', signal),
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

  /** Sends the same command again, under the same id. Nothing is rebuilt. */
  function retrySameReceipt(): void {
    if (busy || !sent) return;
    setPhase('editing');
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
    setPhase('editing');
    submit.reset();

    if (options.refreshChoices) {
      void products.refetch();
      void locations.refetch();
    }
  }

  const loading = products.isPending || locations.isPending;

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-medium">{t('receiving.title')}</h2>
        <p className="text-slate-600">{t('receiving.description')}</p>
      </div>

      {loading && <p className="text-slate-600">{t('status.loading')}</p>}

      {products.isError && <ErrorNotice error={products.error} />}
      {locations.isError && <ErrorNotice error={locations.error} />}

      {products.data && variantChoices.length === 0 && (
        <p className="text-slate-700">{t('receiving.noVariants')}</p>
      )}
      {locations.data && locationChoices.length === 0 && (
        <p className="text-slate-700">{t('receiving.noLocations')}</p>
      )}

      {phase === 'succeeded' && sent && result && (
        <div ref={outcomeRef} tabIndex={-1}>
          <Confirmation sent={sent} result={result} />
        </div>
      )}

      {phase === 'failed' && (
        <div ref={outcomeRef} tabIndex={-1} className="flex flex-col gap-3">
          <ErrorNotice error={submit.error} />
          <div className="flex flex-wrap gap-2">
            {/* Offered only when sending the same thing again could plausibly
                work. A refused item or a changed command will be refused
                identically however many times it is sent, and a button that
                invites that is a button that wastes somebody's afternoon. */}
            {canRetry(submit.error) && (
              <button type="button" className={PRIMARY_BUTTON} onClick={retrySameReceipt}>
                {t('receiving.retrySame')}
              </button>
            )}
            <button
              type="button"
              className={SECONDARY_BUTTON}
              onClick={() => startNewReceipt({ refreshChoices: true })}
            >
              {t('receiving.startNew')}
            </button>
          </div>
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
          className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4 sm:p-6"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="receiving-variant" className="font-medium">
              {t('receiving.variant')}
            </label>
            <select
              id="receiving-variant"
              ref={variantRef}
              name="variantId"
              className={TEXT_INPUT}
              value={variantId}
              disabled={busy || phase === 'failed'}
              onChange={(event) => setVariantId(event.target.value)}
              aria-invalid={fieldErrors.variantId ? true : undefined}
              aria-describedby={fieldErrors.variantId ? 'receiving-variant-error' : undefined}
            >
              <option value="">{t('receiving.choose')}</option>
              {variantChoices.map((choice) => (
                <option key={choice.variantId} value={choice.variantId}>
                  {choice.label}
                </option>
              ))}
            </select>
            {fieldErrors.variantId && (
              <p id="receiving-variant-error" className="text-red-800">
                {t(fieldErrors.variantId)}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="receiving-location" className="font-medium">
              {t('receiving.location')}
            </label>
            <select
              id="receiving-location"
              ref={locationRef}
              name="locationId"
              className={TEXT_INPUT}
              value={locationId}
              disabled={busy || phase === 'failed'}
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
              <p id="receiving-location-error" className="text-red-800">
                {t(fieldErrors.locationId)}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="receiving-quantity" className="font-medium">
              {t('receiving.quantity')}
            </label>
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
              className={TEXT_INPUT}
              value={quantity}
              disabled={busy || phase === 'failed'}
              onChange={(event) => setQuantity(event.target.value)}
              aria-invalid={fieldErrors.quantity ? true : undefined}
              aria-describedby={fieldErrors.quantity ? 'receiving-quantity-error' : undefined}
            />
            {fieldErrors.quantity && (
              <p id="receiving-quantity-error" className="text-red-800">
                {t(fieldErrors.quantity, { max: MAX_MOVEMENT_QUANTITY })}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="receiving-occurred-at" className="font-medium">
              {t('receiving.occurredAt')}
            </label>
            <input
              id="receiving-occurred-at"
              ref={occurredAtRef}
              name="occurredAt"
              type="datetime-local"
              className={TEXT_INPUT}
              value={occurredAtLocal}
              disabled={busy || phase === 'failed'}
              onChange={(event) => setOccurredAtLocal(event.target.value)}
              aria-invalid={fieldErrors.occurredAtLocal ? true : undefined}
              aria-describedby={
                fieldErrors.occurredAtLocal ? 'receiving-occurred-at-error' : undefined
              }
            />
            {fieldErrors.occurredAtLocal && (
              <p id="receiving-occurred-at-error" className="text-red-800">
                {t(fieldErrors.occurredAtLocal)}
              </p>
            )}
          </div>

          {/* The button says what is happening, and it is where the keyboard
              already is when it happens, so its own name is the announcement.
              A second live region beside it would say the same thing twice and
              leave the confirmation competing with it to be read. */}
          <button
            type="submit"
            className={PRIMARY_BUTTON}
            disabled={busy || phase === 'failed' || !sourcesReady}
          >
            {busy ? t('receiving.submitting') : t('receiving.submit')}
          </button>
        </form>
      )}
    </section>
  );
}

/**
 * What was recorded, in the terms the person used to record it.
 *
 * The item, the place, how many, and what is on the shelf now — which is the
 * number they will be asked about. Deliberately not here: the movement id, the
 * request hash, the quantity before, the recorded time, the movement type.
 * Those are how the ledger keeps its own promises, and none of them is
 * something an employee can act on or should have to read.
 */
function Confirmation({ sent, result }: { sent: SentReceipt; result: ReceiveStockResponse }) {
  const t = useTranslator();

  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-md border border-green-700 bg-green-50 px-4 py-3 text-green-900"
    >
      {/* A sentence, not a colour. Somebody who cannot tell green from grey
          reads exactly the same confirmation. */}
      <p className="font-medium">{t('receiving.success', { quantity: sent.request.quantity })}</p>
      <p>
        {t('receiving.resultingQuantity', {
          location: sent.locationName,
          quantity: result.quantityAfter,
        })}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-green-800">{t('receiving.variant')}</dt>
        <dd className="font-medium">{sent.variantLabel}</dd>
        <dt className="text-green-800">{t('receiving.location')}</dt>
        <dd className="font-medium">{sent.locationName}</dd>
      </dl>
    </div>
  );
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

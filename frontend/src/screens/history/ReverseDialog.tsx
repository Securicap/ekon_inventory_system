import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { InventoryMovementRecord } from '@ekon/shared';
import { useAuth } from '../../auth/useAuth.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { FIELD_HINT, FIELD_LABEL, TEXT_INPUT } from '../../components/styles.js';
import { useTranslator } from '../../i18n/index.js';
import { ApiError } from '../../lib/api.js';
import { localDateTimeToIso, toLocalDateTimeInputValue } from '../../lib/businessTime.js';
import { formatDelta, movementHeadlineKey } from '../../lib/movements.js';
import { reverseMovement } from '../../lib/movementsApi.js';
import { newOperationId } from '../../lib/operations.js';
import { formatVariantLabel } from '../../lib/variants.js';

/**
 * Undoing one movement — by adding another.
 *
 * The wording is the design here. This dialog never says *delete*, *undo*, or
 * *remove record*, because none of those is what happens: the original stays in
 * the ledger exactly as it was, and a compensating movement is appended beside
 * it. Somebody who thinks they are erasing a mistake will be surprised later by
 * a history that still shows it, and a person surprised by their own inventory
 * system stops trusting it.
 *
 * It also says the thing that is easy to get wrong: a reversal moves **current**
 * stock. Reversing a receipt of ten takes ten off the shelf as it is now, not
 * off the shelf as it was that morning — and if the shop has sold some since,
 * the server refuses rather than letting the shelf go negative. That refusal is
 * shown as what it is.
 */
export function ReverseDialog({
  movement,
  onDone,
  onCancel,
}: {
  movement: InventoryMovementRecord;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useTranslator();
  const { reportSessionEnded } = useAuth();

  /**
   * The id of *this* correction, generated once when the dialog opens.
   *
   * Not per attempt: a dropped connection is answered by pressing the button
   * again, and the server recognises the repeat and returns the reversal it
   * already posted rather than posting a second one. A fresh id per press would
   * turn that protection off from the outside.
   */
  const [operationId] = useState(newOperationId);
  const [note, setNote] = useState('');
  const [occurredAtLocal, setOccurredAtLocal] = useState(() =>
    toLocalDateTimeInputValue(new Date()),
  );

  const submit = useMutation({
    mutationFn: reverseMovement,
    onSuccess: onDone,
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) reportSessionEnded();
    },
  });

  function confirm(): void {
    const occurredAt = localDateTimeToIso(occurredAtLocal);
    if (occurredAt === null) return;

    submit.mutate({
      operationId,
      movementId: movement.id,
      // An empty note is an absent note, not an empty string: the field is
      // optional in the contract and blank is what "nothing to add" means.
      ...(note.trim() === '' ? {} : { note: note.trim() }),
      occurredAt,
    });
  }

  return (
    <ConfirmDialog
      title={t('history.reverseTitle')}
      confirmLabel={t('history.reverseConfirm')}
      tone="danger"
      busy={submit.isPending}
      onConfirm={confirm}
      onCancel={onCancel}
    >
      {/* What is being reversed, named the way the feed named it — so nobody
          confirms against a description they have to match up themselves. */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-line bg-canvas px-3 py-2 text-sm">
        <dt className="text-ink-soft">{t('history.reverseItem')}</dt>
        <dd className="text-ink">
          {formatVariantLabel(
            movement.variant.productName,
            movement.variant.attributes,
            movement.variant.sku,
          )}
        </dd>

        <dt className="text-ink-soft">{t('history.filterLocation')}</dt>
        <dd className="text-ink">{movement.location.name}</dd>

        <dt className="text-ink-soft">{t('history.reverseOriginal')}</dt>
        <dd className="tabular text-ink">
          {t(movementHeadlineKey(movement))} {formatDelta(movement.quantityDelta)}
        </dd>
      </dl>

      {/* The two sentences that matter, and they are the whole reason this is a
          dialog rather than a button. */}
      <p className="text-pretty">{t('history.reverseExplains')}</p>
      <p className="text-pretty font-semibold">
        {t('history.reverseWillApply', { delta: formatDelta(-movement.quantityDelta) })}
      </p>

      <div className="flex flex-col gap-1">
        <label htmlFor="reverse-note" className={FIELD_LABEL}>
          {t('history.reverseNote')}
        </label>
        <input
          id="reverse-note"
          type="text"
          className={TEXT_INPUT}
          value={note}
          maxLength={500}
          onChange={(event) => setNote(event.target.value)}
        />
        <p className={FIELD_HINT}>{t('history.reverseNoteHint')}</p>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="reverse-time" className={FIELD_LABEL}>
          {t('history.reverseTime')}
        </label>
        <input
          id="reverse-time"
          type="datetime-local"
          className={TEXT_INPUT}
          value={occurredAtLocal}
          onChange={(event) => setOccurredAtLocal(event.target.value)}
        />
      </div>

      {/* The server's own refusal, in the reader's language: already reversed,
          a reversal of a reversal, or a shelf that cannot give the stock back.
          None of them is "something went wrong". */}
      {submit.isError && <ErrorNotice error={submit.error} />}
    </ConfirmDialog>
  );
}

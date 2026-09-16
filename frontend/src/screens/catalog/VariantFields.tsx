import {
  ATTRIBUTE_VALUE_MAX_LENGTH,
  BARCODE_MAX_LENGTH,
  type VariantAttributeDefinition,
} from '@ekon/shared';
import {
  FIELD_ERROR,
  FIELD_HINT,
  FIELD_LABEL,
  SECONDARY_BUTTON,
  TEXT_INPUT,
} from '../../components/styles.js';
import { useTranslator, type MessageKey } from '../../i18n/index.js';
import type { NewProductFieldErrors, VariantDraft } from '../../lib/merchandise.js';

/**
 * One sellable identity on the product form: what makes it different, what it
 * sells for, what it cost, and any code somebody else printed on it.
 *
 * **The attribute name is a list and never a text box**, and that is the most
 * important thing in this file. `color` is the shape variant identity takes
 * across the whole catalog — it is baked into the variant signature — so the
 * server refuses a name it has never heard of. A form that invited somebody to
 * type one would be a form that invites a rejection they had no way to predict,
 * and a shop that got past it would end up with `color`, `colour` and `couleur`
 * describing the same thing.
 *
 * The *value* is free text, because `Black` is display data about one variant
 * and controlling it would be an option-management engine nobody asked for.
 *
 * Price and cost are entered as money — `7,500.00`, not `750000` — and
 * converted at the edge. The currency is chosen per amount rather than assumed:
 * this shop buys in one currency and sells in another routinely, and a form
 * with a hard-coded `HTG` would be quietly wrong about half the merchandise.
 */
export function VariantFields({
  index,
  variant,
  definitions,
  errors,
  removable,
  onChange,
  onRemove,
}: {
  index: number;
  variant: VariantDraft;
  /** The controlled attribute names, from `GET /api/catalog/metadata`. */
  definitions: readonly VariantAttributeDefinition[];
  errors: NewProductFieldErrors;
  removable: boolean;
  onChange: (next: VariantDraft) => void;
  onRemove: () => void;
}) {
  const t = useTranslator();

  /** The names not already used on *this* variant — one `color` per variant. */
  function availableNames(current: string): readonly VariantAttributeDefinition[] {
    const used = new Set(variant.attributes.map((attribute) => attribute.name));
    return definitions.filter(
      (definition) => definition.name === current || !used.has(definition.name),
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-canvas p-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[15px] font-semibold text-ink">
          {t('catalog.variantNumber', { number: index + 1 })}
        </h3>
        {removable && (
          <button type="button" className={SECONDARY_BUTTON} onClick={onRemove}>
            {t('catalog.removeVariant')}
          </button>
        )}
      </div>

      {/* Attributes ---------------------------------------------------- */}
      <div className="flex flex-col gap-2">
        {variant.attributes.map((attribute, attributeIndex) => {
          const error = errors.attributes?.[`${index}.${attributeIndex}`];
          return (
            <div key={attributeIndex} className="flex flex-wrap items-end gap-2">
              <div className="flex min-w-40 flex-1 flex-col gap-1">
                <label
                  htmlFor={`variant-${index}-attribute-${attributeIndex}-name`}
                  className={FIELD_LABEL}
                >
                  {t('catalog.attributeName')}
                </label>
                <select
                  id={`variant-${index}-attribute-${attributeIndex}-name`}
                  className={TEXT_INPUT}
                  value={attribute.name}
                  aria-invalid={error !== undefined}
                  onChange={(event) =>
                    onChange({
                      ...variant,
                      attributes: variant.attributes.map((current, position) =>
                        position === attributeIndex
                          ? { ...current, name: event.target.value }
                          : current,
                      ),
                    })
                  }
                >
                  <option value="">{t('counts.choose')}</option>
                  {availableNames(attribute.name).map((definition) => (
                    <option key={definition.id} value={definition.name}>
                      {definition.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex min-w-40 flex-1 flex-col gap-1">
                <label
                  htmlFor={`variant-${index}-attribute-${attributeIndex}-value`}
                  className={FIELD_LABEL}
                >
                  {t('catalog.attributeValue')}
                </label>
                <input
                  id={`variant-${index}-attribute-${attributeIndex}-value`}
                  className={TEXT_INPUT}
                  value={attribute.value}
                  maxLength={ATTRIBUTE_VALUE_MAX_LENGTH}
                  aria-invalid={error !== undefined}
                  onChange={(event) =>
                    onChange({
                      ...variant,
                      attributes: variant.attributes.map((current, position) =>
                        position === attributeIndex
                          ? { ...current, value: event.target.value }
                          : current,
                      ),
                    })
                  }
                />
              </div>

              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={() =>
                  onChange({
                    ...variant,
                    attributes: variant.attributes.filter(
                      (_, position) => position !== attributeIndex,
                    ),
                  })
                }
              >
                {t('catalog.removeAttribute')}
              </button>

              {error && <p className={`${FIELD_ERROR} w-full`}>{t(error)}</p>}
            </div>
          );
        })}

        <div>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            disabled={variant.attributes.length >= definitions.length}
            onClick={() =>
              onChange({ ...variant, attributes: [...variant.attributes, { name: '', value: '' }] })
            }
          >
            {t('catalog.addAttribute')}
          </button>
          {/* A product sold one way has no attributes at all, and the form
              should not imply otherwise by opening with an empty pair. */}
          {variant.attributes.length === 0 && (
            <p className={`${FIELD_HINT} mt-1`}>{t('catalog.noAttributesHint')}</p>
          )}
        </div>
      </div>

      {/* Money --------------------------------------------------------- */}
      <div className="grid gap-3 sm:grid-cols-2">
        <MoneyField
          idPrefix={`variant-${index}-price`}
          label={t('catalog.price')}
          hint={t('catalog.priceHint')}
          value={variant.sellingPrice}
          error={errors.money?.[`${index}.price`]}
          onChange={(sellingPrice) => onChange({ ...variant, sellingPrice })}
        />
        <MoneyField
          idPrefix={`variant-${index}-cost`}
          label={t('catalog.cost')}
          hint={t('catalog.costHint')}
          value={variant.referenceCost}
          error={errors.money?.[`${index}.cost`]}
          onChange={(referenceCost) => onChange({ ...variant, referenceCost })}
        />
      </div>

      {/* Barcodes ------------------------------------------------------ */}
      <div className="flex flex-col gap-2">
        {variant.barcodes.map((barcode, barcodeIndex) => {
          const error = errors.barcodes?.[`${index}.${barcodeIndex}`];
          return (
            <div key={barcodeIndex} className="flex flex-wrap items-end gap-2">
              <div className="flex min-w-48 flex-1 flex-col gap-1">
                <label htmlFor={`variant-${index}-barcode-${barcodeIndex}`} className={FIELD_LABEL}>
                  {t('catalog.barcode')}
                </label>
                {/* Typed, never scanned. A camera, a symbology library and a
                    check-digit rule are all post-OR1; a box somebody reads a
                    box into is the whole of what this needs to be. */}
                <input
                  id={`variant-${index}-barcode-${barcodeIndex}`}
                  className={TEXT_INPUT}
                  value={barcode}
                  maxLength={BARCODE_MAX_LENGTH}
                  aria-invalid={error !== undefined}
                  onChange={(event) =>
                    onChange({
                      ...variant,
                      barcodes: variant.barcodes.map((current, position) =>
                        position === barcodeIndex ? event.target.value : current,
                      ),
                    })
                  }
                />
              </div>
              <button
                type="button"
                className={SECONDARY_BUTTON}
                onClick={() =>
                  onChange({
                    ...variant,
                    barcodes: variant.barcodes.filter((_, position) => position !== barcodeIndex),
                  })
                }
              >
                {t('catalog.removeBarcode')}
              </button>
              {error && <p className={`${FIELD_ERROR} w-full`}>{t(error)}</p>}
            </div>
          );
        })}

        <div>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => onChange({ ...variant, barcodes: [...variant.barcodes, ''] })}
          >
            {t('catalog.addBarcode')}
          </button>
        </div>
      </div>

      {errors.variants?.[String(index)] && (
        <p className={FIELD_ERROR}>{t(errors.variants[String(index)]!)}</p>
      )}
    </div>
  );
}

/**
 * An amount and its currency, which are one fact and are entered as one.
 *
 * Two inputs rather than one, because a currency typed into the same box as a
 * number is a parsing problem nobody needs. Both or neither: the contract
 * refuses half an amount, and so does the validation behind this.
 */
function MoneyField({
  idPrefix,
  label,
  hint,
  value,
  error,
  onChange,
}: {
  idPrefix: string;
  label: string;
  hint: string;
  value: { amount: string; currency: string };
  error: MessageKey | undefined;
  onChange: (next: { amount: string; currency: string }) => void;
}) {
  const t = useTranslator();

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${idPrefix}-amount`} className={FIELD_LABEL}>
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={`${idPrefix}-amount`}
          className={TEXT_INPUT}
          inputMode="decimal"
          value={value.amount}
          aria-invalid={error !== undefined}
          onChange={(event) => onChange({ ...value, amount: event.target.value })}
        />
        <label htmlFor={`${idPrefix}-currency`} className="sr-only">
          {t('catalog.currency')}
        </label>
        <input
          id={`${idPrefix}-currency`}
          className={`${TEXT_INPUT} w-24 uppercase`}
          value={value.currency}
          maxLength={3}
          placeholder={t('catalog.currency')}
          aria-invalid={error !== undefined}
          onChange={(event) => onChange({ ...value, currency: event.target.value })}
        />
      </div>
      <p className={FIELD_HINT}>{hint}</p>
      {error && <p className={FIELD_ERROR}>{t(error)}</p>}
    </div>
  );
}

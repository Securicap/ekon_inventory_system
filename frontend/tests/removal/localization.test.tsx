import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import fr from '../../src/i18n/fr.json';
import ht from '../../src/i18n/ht.json';
import { translate, type MessageKey } from '../../src/i18n/index.js';
import { REMOVAL_REASON_LABEL_KEYS } from '../../src/lib/removal.js';
import { apiFailure, json } from '../helpers/fetchMock.js';
import {
  fillValidRemoval,
  openRemoval,
  options,
  reasonSelect,
  removalResponse,
  submitRemovalForm,
  REMOVE_ROUTE,
} from '../helpers/removal.js';

/**
 * Every string removal added exists in both languages, and the screen reads its
 * text from the catalogue rather than from the component.
 *
 * Employees use this in Haitian Creole and the owner reads French. This is the
 * screen where somebody records that stock left the shop, so a misunderstood
 * word becomes a wrong number in an append-only ledger — and a wrong *reason*
 * becomes a permanent claim that something was sold when it was broken.
 *
 * The application renders in Creole today because there is no language
 * selector; French is asserted through the catalogue, which is what the
 * selector will read when it arrives.
 */

const KEYS_ADDED_BY_REMOVAL = [
  'nav.remove',
  'removal.title',
  'removal.description',
  'removal.choose',
  'removal.stockHint',
  'removal.variant',
  'removal.location',
  'removal.locationHint',
  'removal.currentQuantity',
  'removal.quantity',
  'removal.quantityMinus',
  'removal.quantityPlus',
  'removal.reason',
  'removal.reasonSold',
  'removal.reasonDamaged',
  'removal.reasonInternalUse',
  'removal.reasonOther',
  'removal.occurredAt',
  'removal.occurredAtHint',
  'removal.submit',
  'removal.submitting',
  'removal.success',
  'removal.resultingQuantity',
  'removal.removeAnother',
  'removal.retrySame',
  'removal.startNew',
  'removal.insufficientStock',
  'removal.notChosen',
  'removal.summaryTitle',
  'removal.operationIdNote',
  'removal.removedLabel',
  'removal.remainingLabel',
  'removal.shortfallLabel',
  'removal.uncertainLabel',
  'removal.uncertainHint',
  'removal.retryTitle',
  'removal.retryExplain',
  'removal.retryingSame',
  'removal.startNewTitle',
  'removal.startNewExplain',
  'removal.noStock',
  'removal.noLocations',
  'removal.variantRequired',
  'removal.locationRequired',
  'removal.quantityRequired',
  'removal.quantityInvalid',
  'removal.quantityTooLarge',
  'removal.quantityExceedsStock',
  'removal.reasonRequired',
  'removal.reasonInvalid',
  'removal.occurredAtRequired',
  'removal.occurredAtInvalid',
] as const satisfies readonly MessageKey[];

/** Reused rather than re-translated: the same failure, said the same way. */
const KEYS_REUSED_BY_REMOVAL = [
  'stock.noVariants',
  'status.loading',
  'catalog.sku',
  'catalog.noAttributes',
  'error.network',
  'error.requestId',
  'error.insufficientStock',
  'error.notFound',
  'error.resourceInactive',
  'error.operationChanged',
  'error.forbidden',
] as const satisfies readonly MessageKey[];

describe('removal translations', () => {
  it('defines every new string in Haitian Creole and in French', () => {
    for (const key of KEYS_ADDED_BY_REMOVAL) {
      expect(ht[key]?.trim(), `ht.${key}`).toBeTruthy();
      expect(fr[key]?.trim(), `fr.${key}`).toBeTruthy();
    }
  });

  it('says something different in each language, rather than one copied to both', () => {
    const shared = KEYS_ADDED_BY_REMOVAL.filter((key) => ht[key] === fr[key]);
    expect(shared).toEqual([]);
  });

  it('reuses the failures that already had words', () => {
    for (const key of KEYS_REUSED_BY_REMOVAL) {
      expect(ht[key]?.trim(), `ht.${key}`).toBeTruthy();
      expect(fr[key]?.trim(), `fr.${key}`).toBeTruthy();
    }
  });

  it('keeps the placeholders both languages need', () => {
    for (const catalogue of [ht, fr]) {
      expect(catalogue['removal.currentQuantity']).toContain('{quantity}');
      expect(catalogue['removal.success']).toContain('{quantity}');
      expect(catalogue['removal.resultingQuantity']).toContain('{quantity}');
      expect(catalogue['removal.resultingQuantity']).toContain('{location}');
      expect(catalogue['removal.quantityTooLarge']).toContain('{max}');
      expect(catalogue['removal.quantityExceedsStock']).toContain('{quantity}');
    }
  });

  it('names no capability, no ledger word, and no reason code', () => {
    for (const key of KEYS_ADDED_BY_REMOVAL) {
      for (const value of [ht[key], fr[key]]) {
        expect(value).not.toMatch(/inventory\.|catalog\.|ISSUE|movement|ledger|hash|operation_id/i);
        expect(value).not.toMatch(/\bSOLD\b|\bDAMAGED\b|INTERNAL_USE/);
      }
    }
  });

  it('says nothing about a sale beyond the stock leaving', () => {
    // `SOLD` is a reason a unit left inventory. There is no customer, price,
    // receipt, or payment in this system, and the words must not promise one.
    for (const catalogue of [ht, fr]) {
      for (const key of ['removal.title', 'removal.description', 'removal.reasonSold'] as const) {
        expect(catalogue[key]).not.toMatch(/pri|prix|resi|reçu|peman|paiement|faktè|facture/i);
      }
    }
  });

  it('reads the form from the catalogue', async () => {
    await openRemoval();

    expect(screen.getByRole('heading', { name: ht['removal.title'] })).toBeInTheDocument();
    expect(screen.getByText(ht['removal.description'])).toBeInTheDocument();
    expect(screen.getByText(ht['removal.stockHint'])).toBeInTheDocument();
    for (const key of [
      'removal.variant',
      'removal.location',
      'removal.quantity',
      'removal.reason',
      'removal.occurredAt',
    ] as const) {
      expect(screen.getByLabelText(ht[key]), key).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: ht['removal.submit'] })).toBeInTheDocument();
  });

  it('names every reason in words a shop employee reads', async () => {
    await openRemoval();
    const labels = options(reasonSelect())
      .slice(1)
      .map((option) => option.label);

    expect(labels).toEqual([
      ht['removal.reasonSold'],
      ht['removal.reasonDamaged'],
      ht['removal.reasonInternalUse'],
      ht['removal.reasonOther'],
    ]);
    // And the mapping the confirmation reads is the same one.
    expect(Object.values(REMOVAL_REASON_LABEL_KEYS)).toEqual([
      'removal.reasonSold',
      'removal.reasonDamaged',
      'removal.reasonInternalUse',
      'removal.reasonOther',
    ]);
  });

  it('reads the confirmation from the catalogue', async () => {
    await openRemoval({ [REMOVE_ROUTE]: json(removalResponse({ quantityAfter: 7 }), 201) });
    fillValidRemoval({ quantity: '3', reason: 'INTERNAL_USE' });
    submitRemovalForm();

    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent(translate('ht', 'removal.success', { quantity: 3 }));
    expect(confirmation).toHaveTextContent(
      translate('ht', 'removal.resultingQuantity', { quantity: 7, location: 'Main Store' }),
    );
    expect(confirmation).toHaveTextContent(ht['removal.reasonInternalUse']);
    expect(screen.getByRole('button', { name: ht['removal.removeAnother'] })).toBeInTheDocument();
  });

  it('reads a shortfall and its actions from the catalogue', async () => {
    await openRemoval({ [REMOVE_ROUTE]: apiFailure('INSUFFICIENT_STOCK', 422) });
    fillValidRemoval({ quantity: '8' });
    submitRemovalForm();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ht['error.insufficientStock']);
    // Never the server's English, which is written for a log line.
    expect(alert).not.toHaveTextContent('English:');
    expect(screen.getByText(ht['removal.insufficientStock'])).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ht['removal.startNew'] })).toBeInTheDocument();
  });

  it('leaves no interpolation unfilled in either language', async () => {
    await openRemoval({ [REMOVE_ROUTE]: json(removalResponse(), 201) });
    fillValidRemoval();
    submitRemovalForm();

    const confirmation = await screen.findByRole('status');
    expect(confirmation.textContent).not.toMatch(/\{\w+\}/);

    for (const key of KEYS_ADDED_BY_REMOVAL) {
      expect(
        translate('fr', key, { quantity: 3, location: 'Main Store', max: 2147483647 }),
        key,
      ).not.toMatch(/\{\w+\}/);
    }
  });

  it('leaves the shop own words untranslated', async () => {
    // Product names, attribute names, SKUs, and location names were typed by
    // the business. They are shown as they were entered, in either language.
    await openRemoval();
    const labels = options(screen.getByLabelText(ht['removal.variant']) as HTMLSelectElement).map(
      (option) => option.label,
    );
    expect(labels.join(' ')).toContain('Diri');
    expect(labels.join(' ')).toContain('gwosè: 5 mamit');
    expect(labels.join(' ')).toContain('EKN-AB12CD34');
  });

  /**
   * The strings that are long in French and that the layout has to survive.
   *
   * French runs a third longer than Creole here, and every one of these sits in
   * a place with a hard constraint: a 344px summary panel, a button that must
   * not wrap into two lines of a different height, or a notice on a 390px
   * phone. They are listed rather than measured — a character count is not a
   * layout test — so that anybody shortening the Creole to make something fit
   * is reminded which French string is the one actually setting the width.
   */
  it('carries the long French wording the layout has to hold', () => {
    for (const key of [
      'removal.location',
      'removal.locationHint',
      'removal.insufficientStock',
      'removal.uncertainHint',
      'removal.retrySame',
      'removal.retryingSame',
      'removal.startNew',
      'removal.startNewExplain',
      'removal.removedLabel',
      'removal.remainingLabel',
      'removal.submitting',
      'removal.operationIdNote',
    ] as const) {
      expect(fr[key]?.trim(), `fr.${key}`).toBeTruthy();
      // Whole words, so a wrapping box has somewhere to break.
      expect(fr[key], `fr.${key}`).not.toMatch(/\S{28,}/);
    }
  });

  it('says the same things in French', () => {
    for (const key of [...KEYS_ADDED_BY_REMOVAL, ...KEYS_REUSED_BY_REMOVAL]) {
      expect(translate('fr', key), key).toBe(fr[key]);
    }
    // A spot check that the French is French, not the Creole copied over.
    expect(fr['nav.remove']).toBe('Sortie');
    expect(fr['removal.reasonSold']).toContain('Vendu');
    expect(translate('fr', 'removal.success', { quantity: 3 })).toContain('3');
    expect(
      translate('fr', 'removal.resultingQuantity', { quantity: 7, location: 'Main Store' }),
    ).toContain('Main Store');
  });
});

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import fr from '../../src/i18n/fr.json';
import ht from '../../src/i18n/ht.json';
import { translate, type MessageKey } from '../../src/i18n/index.js';
import { apiFailure, json } from '../helpers/fetchMock.js';
import { productFixture, variantIdOf } from '../helpers/fixtures.js';
import {
  fillReceivingForm,
  openReceiving,
  receiptResponse,
  submitReceivingForm,
  RECEIVE_ROUTE,
} from '../helpers/receiving.js';

/**
 * Every string receiving added exists in both languages, and the screen reads
 * its text from the catalogue rather than from the component.
 *
 * Employees use this in Haitian Creole and the owner reads French. A sentence
 * baked into JSX is a sentence that will never be translated — and this is the
 * screen where a misunderstood word becomes a wrong number in an append-only
 * ledger.
 *
 * The application renders in Creole today because there is no language
 * selector; French is asserted through the catalogue, which is what the
 * selector will read when it arrives.
 */

const KEYS_ADDED_BY_RECEIVING = [
  'nav.receive',
  'receiving.title',
  'receiving.description',
  'receiving.choose',
  'receiving.variant',
  'receiving.location',
  'receiving.quantity',
  'receiving.occurredAt',
  'receiving.submit',
  'receiving.submitting',
  'receiving.success',
  'receiving.resultingQuantity',
  'receiving.receiveAnother',
  'receiving.retrySame',
  'receiving.startNew',
  'receiving.noVariants',
  'receiving.noLocations',
  'receiving.variantRequired',
  'receiving.locationRequired',
  'receiving.quantityRequired',
  'receiving.quantityInvalid',
  'receiving.quantityTooLarge',
  'receiving.occurredAtRequired',
  'receiving.occurredAtInvalid',
  'error.notFound',
  'error.resourceInactive',
  'error.operationChanged',
] as const satisfies readonly MessageKey[];

const RICE = productFixture();

describe('receiving translations', () => {
  it('defines every new string in Haitian Creole and in French', () => {
    for (const key of KEYS_ADDED_BY_RECEIVING) {
      expect(ht[key]?.trim(), `ht.${key}`).toBeTruthy();
      expect(fr[key]?.trim(), `fr.${key}`).toBeTruthy();
    }
  });

  it('says something different in each language, rather than one copied to both', () => {
    const shared = KEYS_ADDED_BY_RECEIVING.filter((key) => ht[key] === fr[key]);
    expect(shared).toEqual([]);
  });

  it('keeps the placeholders both languages need', () => {
    for (const catalogue of [ht, fr]) {
      expect(catalogue['receiving.success']).toContain('{quantity}');
      expect(catalogue['receiving.resultingQuantity']).toContain('{quantity}');
      expect(catalogue['receiving.resultingQuantity']).toContain('{location}');
      expect(catalogue['receiving.quantityTooLarge']).toContain('{max}');
    }
  });

  it('names no capability and no ledger word to a user', () => {
    for (const key of KEYS_ADDED_BY_RECEIVING) {
      for (const value of [ht[key], fr[key]]) {
        expect(value).not.toMatch(/inventory\.|catalog\.|RECEIPT|movement|hash|operation_id/i);
      }
    }
  });

  it('reads the form from the catalogue', async () => {
    await openReceiving();

    expect(screen.getByRole('heading', { name: ht['receiving.title'] })).toBeInTheDocument();
    expect(screen.getByText(ht['receiving.description'])).toBeInTheDocument();
    for (const key of [
      'receiving.variant',
      'receiving.location',
      'receiving.quantity',
      'receiving.occurredAt',
    ] as const) {
      expect(screen.getByLabelText(ht[key]), key).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: ht['receiving.submit'] })).toBeInTheDocument();
  });

  it('reads the confirmation from the catalogue', async () => {
    await openReceiving({ [RECEIVE_ROUTE]: json(receiptResponse({ quantityAfter: 37 }), 201) });

    fillReceivingForm({
      variantId: variantIdOf(RICE),
      quantity: '12',
      occurredAtLocal: '2026-08-04T14:30',
    });
    submitReceivingForm();

    const confirmation = await screen.findByRole('status');
    expect(confirmation).toHaveTextContent(translate('ht', 'receiving.success', { quantity: 12 }));
    expect(confirmation).toHaveTextContent(
      translate('ht', 'receiving.resultingQuantity', { quantity: 37, location: 'Main Store' }),
    );
    expect(
      screen.getByRole('button', { name: ht['receiving.receiveAnother'] }),
    ).toBeInTheDocument();
  });

  it('reads a refusal and its actions from the catalogue', async () => {
    await openReceiving({
      [RECEIVE_ROUTE]: apiFailure('OPERATION_REPLAYED_WITH_DIFFERENT_BODY', 409),
    });

    fillReceivingForm({
      variantId: variantIdOf(RICE),
      quantity: '12',
      occurredAtLocal: '2026-08-04T14:30',
    });
    submitReceivingForm();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ht['error.operationChanged']);
    // Never the server's English, which is written for a log line.
    expect(alert).not.toHaveTextContent('English:');
    expect(screen.getByRole('button', { name: ht['receiving.startNew'] })).toBeInTheDocument();
  });

  it('says the same things in French', () => {
    // The whole screen's French, asserted through the catalogue the selector
    // will read. Every sentence a person acts on has a French form.
    expect(translate('fr', 'nav.receive')).toBe(fr['nav.receive']);
    expect(translate('fr', 'receiving.success', { quantity: 12 })).toContain('12');
    expect(
      translate('fr', 'receiving.resultingQuantity', { quantity: 37, location: 'Main Store' }),
    ).toContain('Main Store');
    expect(translate('fr', 'receiving.quantityTooLarge', { max: 2147483647 })).toContain(
      '2147483647',
    );
    for (const key of KEYS_ADDED_BY_RECEIVING) {
      expect(translate('fr', key), key).toBe(fr[key]);
    }
  });

  it('leaves no interpolation unfilled in either language', async () => {
    await openReceiving({ [RECEIVE_ROUTE]: json(receiptResponse(), 201) });

    fillReceivingForm({
      variantId: variantIdOf(RICE),
      quantity: '12',
      occurredAtLocal: '2026-08-04T14:30',
    });
    submitReceivingForm();

    const confirmation = await screen.findByRole('status');
    expect(confirmation.textContent).not.toMatch(/\{\w+\}/);
  });
});

describe('the navigation entry', () => {
  it('is named in both languages', async () => {
    await openReceiving();
    expect(screen.getByRole('button', { name: ht['nav.receive'] })).toBeInTheDocument();
    expect(fr['nav.receive']).toBeTruthy();
  });

  it('marks the receiving screen as the open one', async () => {
    await openReceiving();
    expect(screen.getByRole('button', { name: ht['nav.receive'] })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('reaches receiving by keyboard', async () => {
    await openReceiving();

    const entry = screen.getByRole('button', { name: ht['nav.receive'] });
    entry.focus();
    expect(entry).toHaveFocus();
    fireEvent.keyDown(entry, { key: 'Enter' });
    expect(screen.getByRole('heading', { name: ht['receiving.title'] })).toBeInTheDocument();
  });
});

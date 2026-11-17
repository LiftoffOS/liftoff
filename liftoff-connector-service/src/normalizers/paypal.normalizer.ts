// PayPal Connector Normalizer
//
// PayPal is reactive via native polling. The connector itself is a vendor-hosted
// MCP server (mcp.paypal.com), but it exposes no "payments modified since" list,
// so the reactive source is PayPal's Transaction Search reporting API
// (GET /v1/reporting/transactions). The polling scheduler hands
// PayPalClient.list('Payment') results to normalize() as { results: [transaction] },
// where each transaction is a raw transaction_details[i] object. Field set is the
// documented Transaction Search shape, restricted to the fields a reactive
// subscription would predicate on (status, amount, reference) plus identity +
// timestamps + payer email.

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

interface PayPalAmount {
  currency_code?: string;
  value?: string;
}

interface PayPalTransactionInfo {
  transaction_id?: string;
  transaction_status?: string;
  transaction_amount?: PayPalAmount;
  transaction_initiation_date?: string;
  transaction_updated_date?: string;
  paypal_reference_id?: string;
}

interface PayPalPayerInfo {
  email_address?: string;
}

interface PayPalTransaction {
  transaction_info?: PayPalTransactionInfo;
  payer_info?: PayPalPayerInfo;
}

interface PayPalPayload {
  results?: PayPalTransaction[];
}

const PaymentDataSchema = z.object({
  id: z.string().describe('PayPal transaction id.'),
  status: z.string().optional().describe('Transaction status (S=success, P=pending, V=reversed, D=denied).'),
  amountValue: z.string().optional().describe('Transaction amount as a decimal string.'),
  amountCurrency: z.string().optional().describe('ISO currency code of the transaction amount.'),
  initiationDate: z.string().optional().describe('Transaction initiation ISO timestamp (RFC3339).'),
  updatedDate: z.string().optional().describe('Transaction last-updated ISO timestamp (RFC3339) — anchor for "alert N hours after a payment" patterns.'),
  referenceId: z.string().optional().describe('PayPal reference id linking related transactions (e.g. capture/refund).'),
  payerEmail: z.string().optional().describe('Email address of the payer.'),
});

export class PayPalNormalizer implements ConnectorNormalizer {
  connectorType = 'paypal';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Payment: PaymentDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const transactions = (payload as PayPalPayload)?.results ?? [];
    const records: NormalizedRecord[] = [];

    for (const txn of transactions) {
      const info = txn?.transaction_info;
      if (!info || info.transaction_id === undefined || info.transaction_id === null) continue;
      const id = String(info.transaction_id);
      const declared: Record<string, unknown> = {
        id,
        status: info.transaction_status,
        amountValue: info.transaction_amount?.value,
        amountCurrency: info.transaction_amount?.currency_code,
        initiationDate: info.transaction_initiation_date,
        updatedDate: info.transaction_updated_date,
        referenceId: info.paypal_reference_id,
        payerEmail: txn.payer_info?.email_address,
      };
      records.push({
        entityType: 'Payment',
        externalId: id,
        data: declared,
        metadata: {
          source: 'paypal',
          syncedAt: new Date(),
          version: info.transaction_updated_date ?? info.transaction_initiation_date ?? hashCanonicalJson(txn),
        },
      });
    }

    return records;
  }

  extractEntityType(_record: unknown): string {
    return 'Payment';
  }

  extractExternalId(record: unknown): string {
    return String((record as PayPalTransaction).transaction_info?.transaction_id ?? '');
  }

  extractVersion(record: unknown): string | undefined {
    const info = (record as PayPalTransaction).transaction_info;
    return info?.transaction_updated_date ?? info?.transaction_initiation_date;
  }
}

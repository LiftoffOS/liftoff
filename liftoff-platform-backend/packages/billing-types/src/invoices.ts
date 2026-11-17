export type InvoiceStatus =
  | 'draft'
  | 'open'
  | 'paid'
  | 'void'
  | 'uncollectible';

export interface Invoice {
  id: string;
  tenantId: string;
  stripeInvoiceId: string;
  status: InvoiceStatus;
  amountDueCents: bigint;
  amountPaidCents: bigint;
  taxCents: bigint;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  issuedAt: Date;
  paidAt: Date | null;
  lineItems: InvoiceLineItem[];
}

export interface InvoiceLineItem {
  id: string;
  invoiceId: string;
  description: string;
  amountCents: bigint;
  /** Tax rate in basis points. 10_000 = 100 %. */
  taxRateBps: number;
  quantity: bigint;
  meterEventGroup: string | null;
}

export interface PaymentMethod {
  id: string;
  tenantId: string;
  stripePaymentMethodId: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}

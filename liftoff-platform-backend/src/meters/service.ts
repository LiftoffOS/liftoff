// Meter Service Implementation
// Per Section 13: Control plane owns meter definitions

import Stripe from 'stripe';
import { MeterDefinition, CreateMeterInput, UpdateMeterInput } from './types';
import { MeterRepository } from './repository';
import { getStripeSecretKey } from '../infrastructure/secrets';

let stripe: Stripe | null = null;

async function getStripe(): Promise<Stripe> {
  if (!stripe) {
    const secretKey = await getStripeSecretKey();
    stripe = new Stripe(secretKey);
  }
  return stripe;
}

export class MeterService {
  private repository = new MeterRepository();

  async listAll(): Promise<MeterDefinition[]> {
    return this.repository.findAll();
  }

  async getById(id: string): Promise<MeterDefinition | null> {
    return this.repository.findById(id);
  }

  async getByName(name: string): Promise<MeterDefinition | null> {
    return this.repository.findByName(name);
  }

  async create(input: CreateMeterInput): Promise<MeterDefinition> {
    // Create Stripe meter if not provided
    let stripeMeterId = input.stripeMeterId;

    if (!stripeMeterId) {
      const stripeClient = await getStripe();
      const stripeMeter = await stripeClient.billing.meters.create({
        display_name: input.name,
        event_name: `${input.name.toLowerCase().replace(/\s+/g, '_')}_usage`,
        default_aggregation: {
          formula: input.aggregationType === 'count' ? 'count' : 'sum',
        },
      });
      stripeMeterId = stripeMeter.id;
    }

    return this.repository.create({
      ...input,
      stripeMeterId,
    });
  }

  async update(id: string, input: UpdateMeterInput): Promise<MeterDefinition> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new Error(`Meter definition not found: ${id}`);
    }

    // Update Stripe meter if name changed
    if (input.name && existing.stripeMeterId) {
      const stripeClient = await getStripe();
      await stripeClient.billing.meters.update(existing.stripeMeterId, {
        display_name: input.name,
      });
    }

    return this.repository.update(id, input);
  }

  async delete(id: string): Promise<void> {
    const existing = await this.repository.findById(id);
    if (!existing) {
      throw new Error(`Meter definition not found: ${id}`);
    }

    // Deactivate Stripe meter if exists
    if (existing.stripeMeterId) {
      const stripeClient = await getStripe();
      await stripeClient.billing.meters.deactivate(existing.stripeMeterId);
    }

    return this.repository.delete(id);
  }

  // Per Section 14: Report usage to Stripe meter
  // Per Section 13: Idempotency key prevents duplicate meter events
  async reportUsage(
    meterId: string,
    customerId: string,
    value: number,
    options?: {
      timestamp?: Date;
      idempotencyKey?: string;
    }
  ): Promise<void> {
    const meter = await this.repository.findById(meterId);
    if (!meter) {
      throw new Error(`Meter definition not found: ${meterId}`);
    }
    if (!meter.stripeMeterId) {
      throw new Error(`Meter ${meterId} has no Stripe meter ID`);
    }

    const stripeClient = await getStripe();
    const eventName = `${meter.name.toLowerCase().replace(/\s+/g, '_')}_usage`;

    // Per Section 13: Use identifier for Stripe meter event idempotency
    // This prevents duplicate billing on retries or redelivered events
    const identifier = options?.idempotencyKey ||
      `${customerId}_${meterId}_${options?.timestamp?.getTime() || Date.now()}`;

    await stripeClient.billing.meterEvents.create({
      event_name: eventName,
      identifier,
      payload: {
        stripe_customer_id: customerId,
        value: String(value),
      },
      timestamp: options?.timestamp
        ? Math.floor(options.timestamp.getTime() / 1000)
        : Math.floor(Date.now() / 1000),
    });
  }
}

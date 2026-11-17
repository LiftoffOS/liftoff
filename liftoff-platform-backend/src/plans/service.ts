// Plan Service Implementation
// Per Section 13: Control plane owns plans

import { Plan, CreatePlanInput, UpdatePlanInput } from './types';
import { PlanRepository } from './repository';
import { log } from '../infrastructure/logging';

export class PlanService {
  private repository = new PlanRepository();

  async list(): Promise<Plan[]> {
    return this.repository.findAll();
  }

  async listActive(): Promise<Plan[]> {
    return this.repository.findActive();
  }

  async getById(id: string): Promise<Plan | null> {
    return this.repository.findById(id);
  }

  async getByStripePriceId(stripePriceId: string): Promise<Plan | null> {
    return this.repository.findByStripePriceId(stripePriceId);
  }

  async create(input: CreatePlanInput): Promise<Plan> {
    const plan = await this.repository.create(input);
    log.info({ planId: plan.id, name: plan.name }, 'Plan created');
    return plan;
  }

  async update(id: string, input: UpdatePlanInput): Promise<Plan> {
    const plan = await this.repository.update(id, input);
    log.info({ planId: plan.id }, 'Plan updated');
    return plan;
  }

  async archive(id: string): Promise<Plan> {
    const plan = await this.repository.archive(id);
    log.info({ planId: plan.id }, 'Plan archived');
    return plan;
  }
}

import type { ReactNode } from 'react'
import ArrowUpIcon from '../../../assets/icons/arrow-up.svg?react'
import TrendUpIcon from '../../../assets/icons/trend-up.svg?react'
import LightningIcon from '../../../assets/icons/lightning.svg?react'
import PlugIcon from '../../../assets/icons/plug.svg?react'
import TeamIcon from '../../../assets/icons/team.svg?react'
import ArrowLeftRightIcon from '../../../assets/icons/arrow-left-right.svg?react'
import EyeIcon from '../../../assets/icons/eye.svg?react'
import SlidersIcon from '../../../assets/icons/sliders.svg?react'
import PersonCenteredIcon from '../../../assets/icons/person-centered.svg?react'
import ServerIcon from '../../../assets/icons/server.svg?react'
import LockIcon from '../../../assets/icons/lock.svg?react'
import ShieldCheckIcon from '../../../assets/icons/shield-check.svg?react'
import CheckCircleIcon from '../../../assets/icons/check-circle.svg?react'
import StarIcon from '../../../assets/icons/star.svg?react'
import MailIcon from '../../../assets/icons/mail.svg?react'
import InsightsIcon from '../../../assets/icons/insights.svg?react'
import PeopleIcon from '../../../assets/icons/people.svg?react'
import DatabaseBackupIcon from '../../../assets/icons/database-backup.svg?react'
import ReceiptTextIcon from '../../../assets/icons/receipt-text.svg?react'

export type BillingPeriod = 'monthly' | 'yearly'

export interface PricingPlan {
  id: string
  name: string
  monthlyPrice: number | null
  features: string[]
  isPopular?: boolean
  isEnterprise?: boolean
}

export interface PricingPillar {
  id: string
  title: string
  description: string
}

export interface PricingFeature {
  id: string
  icon: ReactNode
  title: string
  description: string
}

export interface PricingFaq {
  question: string
  answer: string
}

export const pricingPlans: PricingPlan[] = [
  {
    id: 'core',
    name: 'Core',
    monthlyPrice: 20,
    features: ['1,400 Operating Units', 'Unlimited agents', 'Unlimited integrations', 'Workflow orchestration', 'Real-time visibility', 'Governance controls', 'Human oversight and control'],
  },
  {
    id: 'growth',
    name: 'Growth',
    monthlyPrice: 50,
    features: ['3,650 Operating Units', 'Unlimited agents', 'Unlimited integrations', 'Workflow orchestration', 'Real-time visibility', 'Governance controls', 'Human oversight and control'],
    isPopular: true,
  },
  {
    id: 'scale',
    name: 'Scale',
    monthlyPrice: 200,
    features: ['15,200 Operating Units', 'Unlimited agents', 'Unlimited integrations', 'Workflow orchestration', 'Real-time visibility', 'Governance controls', 'Human oversight and control'],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    monthlyPrice: null,
    features: ['Custom volume pricing', 'Enterprise capabilities'],
    isEnterprise: true,
  },
]

export const pricingPillars: PricingPillar[] = [
  { id: 'agents', title: 'Built for AI-natives', description: 'Add unlimited agents for whatever the work needs.' },
  { id: 'operating-capacity', title: 'Aligned to real operating capacity', description: 'Pricing scales with your operating footprint, not the technology behind it.' },
  { id: 'clarity', title: 'Designed for clarity', description: 'Pricing your finance and operations teams can plan, forecast, and budget around.' },
]

// The eight core features, in a fixed order and fixed words, so every surface
// that lists them describes one product.
export const pricingCoreFeatures: PricingFeature[] = [
  { id: 'identity', icon: <PersonCenteredIcon />, title: 'Individual Identities', description: 'Each agent acts as itself, with credentials scoped to its own job.' },
  { id: 'no-cold-start', icon: <EyeIcon />, title: 'No Cold Start', description: 'They arrive knowing your systems and the work, so nothing needs explaining.' },
  { id: 'self-learning', icon: <TrendUpIcon />, title: 'Self-Learning', description: 'agents learn from the work they do, and from each other.' },
  { id: 'connectivity', icon: <PlugIcon />, title: 'Connects to Everything', description: 'Thousands of tools, MCP servers, webhooks, agents, and even websites with no API via a browser.' },
  { id: 'collaboration', icon: <TeamIcon />, title: 'Built to Collaborate', description: 'agents hand work to each other and bring the right one for the job, so no single one is the limit.' },
  { id: 'throughput', icon: <ArrowUpIcon />, title: 'Unlimited Throughput', description: 'Run as many agents simultaneously as the work needs, without any constraints.' },
  { id: 'governance', icon: <SlidersIcon />, title: 'Governed by Default', description: 'Set what runs on its own, what needs approval, and see everything that happened.' },
  { id: 'providers', icon: <ArrowLeftRightIcon />, title: 'Any AI Provider', description: 'All the best AI from Anthropic, OpenAI, Google, Grok, and open source. Switch with one click.' },
  // Ninth, after the shared eight rather than before them: the order of those
  // eight is fixed, and a reader comparing surfaces should meet them in the
  // same sequence.
  { id: 'ready-in-minutes', icon: <LightningIcon />, title: 'Ready in Minutes', description: 'A new agent is working within minutes of you describing it.' },
]

export const pricingAdditionalFeatures: PricingFeature[] = [
  { id: 'dedicated-infrastructure', icon: <ServerIcon />, title: 'Dedicated Infrastructure', description: 'Your own isolated cloud environment. No shared infrastructure.' },
  { id: 'sso', icon: <LockIcon />, title: 'SSO, SCIM/SAML, Audit Logs', description: 'Enterprise identity management and audit trails.' },
  { id: 'compliance', icon: <CheckCircleIcon />, title: 'SOC2 & GDPR Compliance', description: 'Meet regulatory requirements with built-in compliance.' },
  { id: 'security', icon: <ShieldCheckIcon />, title: 'Advanced Security Features', description: 'Enterprise-grade security for your organization.' },
  { id: 'hris-integration', icon: <PeopleIcon />, title: 'HRIS Integration', description: 'Connect your HR systems for a unified view of human and AI workforce productivity and cost.' },
  { id: 'custom-retention', icon: <DatabaseBackupIcon />, title: 'Custom Data Retention', description: 'Define your own data retention policies.' },
  { id: 'dedicated-support', icon: <StarIcon />, title: 'Dedicated Account Team', description: 'Your own dedicated account team.' },
  { id: 'analytics', icon: <InsightsIcon />, title: 'Advanced Analytics', description: 'Deep insights into team performance and cost savings.' },
  { id: 'human-experts', icon: <PersonCenteredIcon />, title: 'Augment with Experts', description: 'Bring on human experts to improve the team\'s performance by guiding, refining, and overseeing their work.' },
  { id: 'unified-billing', icon: <ReceiptTextIcon />, title: 'Unified Billing', description: 'One consolidated invoice across all workspaces in your organization.' },
  { id: 'priority-support', icon: <MailIcon />, title: 'Priority Support', description: 'Get faster response times from our team.' },
]

export const pricingFaqs: PricingFaq[] = [
  { question: 'How does pricing work?', answer: 'Pricing is based on the Operating Units your agents use. Price scales predictably with your operations.' },
  { question: 'Do I pay per task, per run, or per seat?', answer: 'No. You only pay for the Operating Units your agents use. That gives your finance department a single line item and keeps procurement conversations simple.' },
  { question: 'What\'s included?', answer: 'The full platform is included: individual identities, your context on arrival, self-learning, connectivity, collaboration between agents, unlimited throughput, governance, and any AI provider.' },
  { question: 'What\'s not included?', answer: 'Enterprise capabilities are scoped and priced separately based on your organization\'s needs.' },
  { question: 'What if I need more usage after I subscribe?', answer: 'Usage beyond your plan\'s included amount is deducted from your credit balance at 1.6¢ per Operating Unit. You can add credits anytime.' },
  { question: 'How quickly can teams be operational?', answer: 'Most agents are running within minutes of being defined.' },
  { question: 'How many agents can I deploy?', answer: 'Unlimited. Deploy as many as your operations need. Pricing scales with usage, not headcount.' },
  { question: 'How does this work alongside our existing team?', answer: 'agents operate inside the workflows your people already use. Liftoff gives you one shared platform for agents and human teams, with governance and cost clarity built in for both.' },
]

export const PLAN_HIERARCHY: Record<string, number> = {
  core: 1,
  growth: 2,
  scale: 3,
  enterprise: 4,
}

// Each ladder starts at its plan's included allowance and steps up from there.
// The first value must equal that plan's allowance, since PlanCard derives
// `extraOus` as the slider value minus it. The steps are how much EXTRA
// capacity a workspace can commit to, so they are independent of the allowance
// and of what an extra OU costs.
// Steps are multiples of 1,000 Operating Units (2,000 on Scale, 10,000 at its
// top end) because EXTRA_OU_PRICE is $0.015: a thousand units is exactly $15
// and two thousand exactly $30, so every stop shows a whole number of units at
// a whole number of dollars. A step that is not a multiple of 1,000 puts cents
// on the price.
//
// Core tops at 3,400 (= $50, Growth's price) and Growth at 13,650 (= $200,
// Scale's price), so the slider itself shows where the next plan begins.
function makeScaleValues() {
  const vals: number[] = []
  for (let v = 15200; v <= 55200; v += 2000) vals.push(v)   // $200 -> $800 in $30 steps
  vals.push(65200, 75200, 85200, 95200, 105200)             // $950 -> $1,550 in $150 steps
  return vals
}

export const PLAN_SLIDER_VALUES: Record<string, number[]> = {
  core:   [1400, 2400, 3400],
  growth: [3650, 4650, 5650, 6650, 7650, 8650, 9650, 10650, 11650, 12650, 13650],
  scale:  makeScaleValues(),
}

/** What one Operating Unit above the plan's allowance adds to the monthly fee.
 *  The precommit rate: mirrors `plan_catalog.precommit_rate_usd_per_ou` in
 *  platform-backend and `PRECOMMIT_CENTS_PER_OU` in liftoff-billing, which is
 *  the one that actually prices the subscription. This copy is display only, so
 *  a disagreement shows a price the customer is not charged.
 *
 *  A round fraction of a dollar on purpose: a whole dollar buys 1/this many
 *  units, so only a rate like $0.015 (1,000 units = $15) lets a round slider
 *  stop carry a round price. */
export const EXTRA_OU_PRICE = 0.015

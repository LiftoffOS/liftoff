// What a hired team is actually allowed to touch.
//
// What these pin: a connection the person made reaches the team whether its
// requirement was required or optional; one connection binds once however many
// requirements reach it; and a destination lands on the connection it was named
// on. Every one of those fails silently — the team is hired, looks healthy, and
// is missing a tool its own instructions tell it to use.

import { describe, it, expect } from 'vitest'
import { assembleTemplateIntegrations, type AssemblableConnector } from './assembleTemplateIntegrations'
import type { AgentTemplate } from '../services/agentTemplates'

const CAPABILITIES = {
  documents: ['google_drive', 'microsoft_onedrive'],
  team_chat: ['slack', 'microsoft_teams'],
  crm: ['hubspot', 'zoho_crm'],
  cloud_storage: ['google_drive', 'dropbox'],
}

const conn = (id: string, type: string, status = 'active'): AssemblableConnector => ({ id, type, status })

const template = (
  requiredConnectors: Array<Record<string, unknown>>,
  optionalConnectors: Array<Record<string, unknown>> = [],
) => ({ requiredConnectors, optionalConnectors }) as unknown as AgentTemplate

const assemble = (
  t: AgentTemplate,
  connectors: AssemblableConnector[],
  resolvedObjects: Record<string, { id: string; title: string; connectorId: string }> = {},
) =>
  assembleTemplateIntegrations({
    template: t,
    connectors,
    capabilityMap: CAPABILITIES,
    resolvedObjects,
    label: (type) => type.toUpperCase(),
  })

describe('assembleTemplateIntegrations', () => {
  it('binds an optional connector the person actually connected', () => {
    const t = template(
      [{ id: 'req-docs', capability: 'documents', role: 'tool', description: 'd' }],
      [{ id: 'opt-chat', capability: 'team_chat', role: 'tool', description: 'd' }],
    )
    const out = assemble(t, [conn('c1', 'google_drive'), conn('c2', 'slack')])
    expect(out.map(i => i.id)).toEqual(['c1', 'c2'])
  })

  it('binds nothing for an optional requirement nobody connected', () => {
    const t = template(
      [{ id: 'req-docs', capability: 'documents', role: 'tool', description: 'd' }],
      [{ id: 'opt-chat', capability: 'team_chat', role: 'tool', description: 'd' }],
    )
    const out = assemble(t, [conn('c1', 'google_drive')])
    expect(out.map(i => i.id)).toEqual(['c1'])
  })

  it('binds every connection satisfying a capability, so two CRMs both come', () => {
    const t = template([{ id: 'req-crm', capability: 'crm', role: 'tool', description: 'd' }])
    const out = assemble(t, [conn('c1', 'hubspot'), conn('c2', 'zoho_crm')])
    expect(out.map(i => i.id)).toEqual(['c1', 'c2'])
  })

  it('binds one connection once, even when two requirements reach it', () => {
    // Google Drive satisfies documents AND cloud_storage. Two entries for one
    // connection is two bindings of the same thing to the runtime.
    const t = template(
      [{ id: 'req-docs', capability: 'documents', role: 'tool', description: 'd' }],
      [{ id: 'opt-storage', capability: 'cloud_storage', role: 'data_source', description: 'd' }],
    )
    const out = assemble(t, [conn('c1', 'google_drive')])
    expect(out.map(i => i.id)).toEqual(['c1'])
  })

  it('ignores a connection that is not active', () => {
    const t = template([{ id: 'req-chat', capability: 'team_chat', role: 'tool', description: 'd' }])
    expect(assemble(t, [conn('c1', 'slack', 'revoked')])).toEqual([])
  })

  it('binds a specific connectorType requirement to exactly that connector', () => {
    const t = template([{ id: 'req-slack', connectorType: 'slack', role: 'tool', description: 'd' }])
    const out = assemble(t, [conn('c1', 'microsoft_teams'), conn('c2', 'slack')])
    expect(out.map(i => i.id)).toEqual(['c2'])
  })

  it('carries a destination onto the connection it was named on, and no other', () => {
    const t = template(
      [{ id: 'req-docs', capability: 'documents', role: 'tool', description: 'd' }],
      [{ id: 'opt-chat', capability: 'team_chat', role: 'tool', description: 'd' }],
    )
    const out = assemble(t, [conn('c1', 'google_drive'), conn('c2', 'slack')], {
      'req-docs:working-folder': { id: 'F1', title: 'Marketing', connectorId: 'c1' },
      'opt-chat:alert-channel': { id: 'C1', title: '#alerts', connectorId: 'c2' },
    })
    expect(out.find(i => i.id === 'c1')?.config).toEqual({
      destinations: { 'working-folder': { id: 'F1', name: 'Marketing', ref: 'id' } },
    })
    expect(out.find(i => i.id === 'c2')?.config).toEqual({
      destinations: { 'alert-channel': { id: 'C1', name: '#alerts', ref: 'id' } },
    })
  })

  it('leaves out a connection the team was taken off', () => {
    // Two CRMs is right for GitHub and GitLab and wrong for HubSpot and Zoho,
    // so the person says which. Unticking one must reach the hire, or the
    // control is decoration.
    const t = template([{ id: 'req-crm', capability: 'crm', role: 'tool', description: 'd' }])
    const out = assembleTemplateIntegrations({
      template: t,
      connectors: [conn('c1', 'hubspot'), conn('c2', 'zoho_crm')],
      capabilityMap: CAPABILITIES,
      resolvedObjects: {},
      label: (type) => type,
      excludedConnectorIds: new Set(['c1']),
    })
    expect(out.map(i => i.id)).toEqual(['c2'])
  })

  it('drops a connection reached through two requirements when it is excluded once', () => {
    // The decision is per connection, so Drive taken off as documents is Drive
    // taken off, not Drive still arriving through cloud_storage.
    const t = template(
      [{ id: 'req-docs', capability: 'documents', role: 'tool', description: 'd' }],
      [{ id: 'opt-storage', capability: 'cloud_storage', role: 'data_source', description: 'd' }],
    )
    const out = assembleTemplateIntegrations({
      template: t,
      connectors: [conn('c1', 'google_drive')],
      capabilityMap: CAPABILITIES,
      resolvedObjects: {},
      label: (type) => type,
      excludedConnectorIds: new Set(['c1']),
    })
    expect(out).toEqual([])
  })

  it('leaves config off a connection with nothing named on it', () => {
    const t = template([{ id: 'req-crm', capability: 'crm', role: 'tool', description: 'd' }])
    expect(assemble(t, [conn('c1', 'hubspot')])[0].config).toBeUndefined()
  })

  it('never sets selectedObjects, which the runtime reads as a type allowlist', () => {
    // A non-empty list makes every type outside it fail, so a destination must
    // never land there.
    const t = template([{ id: 'req-crm', capability: 'crm', role: 'tool', description: 'd' }])
    const out = assemble(t, [conn('c1', 'hubspot')], {
      'req-crm:x': { id: 'X', title: 'x', connectorId: 'c1' },
    })
    expect(out[0].selectedObjects).toEqual([])
  })
})

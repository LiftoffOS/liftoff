// A template that needs the same kind of app for two different reasons declares
// two requirements: the comparison writer reads a positioning document and
// saves drafts to a folder, both in a documents app, and the backend keeps
// them apart so the two picks cannot be routed onto one tree. The gallery card
// and the detail chips only say which apps to connect, so there the pair is
// one family, not two.

import { describe, it, expect } from 'vitest'
import { uniqueByFamily } from './agentTemplates'

describe('uniqueByFamily', () => {
  it('keeps the first of two requirements naming the same capability', () => {
    const reqs = [
      { id: 'req-documents', capability: 'documents' },
      { id: 'req-positioning', capability: 'documents' },
      { id: 'opt-data-table', capability: 'data_table' },
    ]
    expect(uniqueByFamily(reqs).map(r => r.id)).toEqual(['req-documents', 'opt-data-table'])
  })

  it('reads a list requirement as the same family regardless of order', () => {
    const reqs = [
      { id: 'a', capabilities: ['cloud_storage', 'documents'] },
      { id: 'b', capabilities: ['documents', 'cloud_storage'] },
    ]
    expect(uniqueByFamily(reqs).map(r => r.id)).toEqual(['a'])
  })

  it('does not fold a single capability into a list that contains it', () => {
    const reqs = [
      { id: 'a', capability: 'documents' },
      { id: 'b', capabilities: ['documents', 'cloud_storage'] },
    ]
    expect(uniqueByFamily(reqs).map(r => r.id)).toEqual(['a', 'b'])
  })

  it('dedupes by connector type and keeps a type apart from a capability', () => {
    const reqs = [
      { id: 'a', connectorType: 'docusign' },
      { id: 'b', connectorType: 'docusign' },
      { id: 'c', capability: 'e_sign' },
    ]
    expect(uniqueByFamily(reqs).map(r => r.id)).toEqual(['a', 'c'])
  })
})

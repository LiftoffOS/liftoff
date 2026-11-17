import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { getIntegrationIcon } from './integrationIconRegistry'

// SlackIcon and MicrosoftTeamsIcon were moved out of IntegrationIcons into
// ChannelIcons and re-exported, to keep that ~411 kB icon chunk off the
// first-load path. The registry reaches them through
// `import * as Icons`, so this guards that the re-export still resolves.
//
// Asserted on a mark unique to each icon rather than on "an svg rendered":
// getIntegrationIcon falls back to WebsiteFormsIcon for an unknown id, so a
// bare svg check would pass even if the re-export had broken.
describe('channel icons through the integration registry', () => {
  it('resolves the real Slack icon, not the fallback', () => {
    const { container } = render(<>{getIntegrationIcon('slack')}</>)
    expect(container.querySelector('path[fill="#E01E5A"]')).toBeTruthy()
  })

  it('resolves the real Microsoft Teams icon, not the fallback', () => {
    const { container } = render(<>{getIntegrationIcon('microsoft_teams')}</>)
    expect(container.querySelector('#teams-a')).toBeTruthy()
  })
})

import type React from 'react'
// "You have none" and "we cannot look" are different answers, and the picker
// must not merge them.
//
// Both arrive as an empty results array. Before the connector service started
// sending `unsupported`, a channel picker pointed at a connector nobody had
// wired showed "No channels found" — a confident claim about the customer's
// workspace, made with no knowledge of it. Someone reading that goes to check
// Slack, finds their channels, and concludes the product is broken; the actual
// gap was ours and invisible.
//
// These tests pin the branch, because the two states differ by one flag and the
// wrong one is the plausible-looking one.

import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import ObjectPicker from './ObjectPicker'
import type { RequirementObject } from '../../services/agentTemplates'

const mockUseBrowseConnector = vi.fn()

vi.mock('../../hooks/useKnowledge', () => ({
  useBrowseConnector: (...args: unknown[]) => mockUseBrowseConnector(...args),
}))

// FilePicker pulls in its own data layer and is not what these tests are about;
// the flat-list branch is. Channel is a flat kind, so it never renders.
// Stands in for the real tree: exposes a button that hands back a fixed set of
// rows, so the routing ObjectPicker does with them can be asserted without
// standing up browse.
let filePickerRows: Array<{ id: string; title: string; contentType: string }> = []
vi.mock('../FilePicker/FilePicker', () => ({
  default: ({ onSelect }: { onSelect: (r: unknown[]) => void }) => (
    <button data-testid="file-picker-confirm" onClick={() => onSelect(filePickerRows)}>
      confirm
    </button>
  ),
}))

const channelObject: RequirementObject = {
  id: 'alert_channel',
  kind: 'channel',
  direction: 'write',
  label: 'Where this team posts alerts',
  required: true,
}

function renderPicker(
  props: Partial<React.ComponentProps<typeof ObjectPicker>> = {},
) {
  return render(
    <ObjectPicker
      objects={[channelObject]}
      connectorId="conn-1"
      connectorName="Slack"
      onPick={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  )
}

/** Shape of one useInfiniteQuery page, which is what the component reads. */
function browseState(pages: Array<Record<string, unknown>>) {
  return { data: { pages }, isPending: false, isError: false }
}

beforeEach(() => {
  mockUseBrowseConnector.mockReset()
})

describe('ObjectPicker: empty is not the same as unsupported', () => {
  it('says the account has none when the connector could look and found nothing', () => {
    mockUseBrowseConnector.mockReturnValue(
      browseState([{ results: [], nextCursor: null }]),
    )

    renderPicker()

    expect(screen.getByText(/No channels found/i)).toBeInTheDocument()
    expect(screen.queryByText(/Liftoff cannot list these/i)).not.toBeInTheDocument()
  })

  it('says the limit is ours when the connector cannot enumerate channels', () => {
    mockUseBrowseConnector.mockReturnValue(
      browseState([{ results: [], nextCursor: null, unsupported: true }]),
    )

    renderPicker()

    expect(screen.getByText(/Liftoff cannot list these/i)).toBeInTheDocument()
    // The claim about the customer's workspace must NOT be made here.
    expect(screen.queryByText(/No channels found/i)).not.toBeInTheDocument()
  })

  it('offers a way forward instead of a dead end when it cannot enumerate', () => {
    // A required destination that cannot be picked would otherwise block the
    // hire with nothing on screen explaining why.
    mockUseBrowseConnector.mockReturnValue(
      browseState([{ results: [], nextCursor: null, unsupported: true }]),
    )

    renderPicker()

    expect(screen.getByText(/continue without picking one/i)).toBeInTheDocument()
  })

  it('tells the step the pick cannot be answered, so the message above is true', () => {
    // The words alone do not release the Continue button: the step gates on
    // every required pick, and a channel nobody can list would hold the hire
    // shut while the modal says otherwise.
    const onUnsupported = vi.fn()
    mockUseBrowseConnector.mockReturnValue(
      browseState([{ results: [], nextCursor: null, unsupported: true }]),
    )

    renderPicker({ onUnsupported })

    expect(onUnsupported).toHaveBeenCalledWith('alert_channel')
  })

  it('says nothing to the step when the account simply holds no channels', () => {
    // An empty Slack is answerable: make one and pick it. Only our own gap
    // excuses the pick.
    const onUnsupported = vi.fn()
    mockUseBrowseConnector.mockReturnValue(
      browseState([{ results: [], nextCursor: null }]),
    )

    renderPicker({ onUnsupported })

    expect(onUnsupported).not.toHaveBeenCalled()
  })

  it('renders rows and neither message when the connector returns results', () => {
    mockUseBrowseConnector.mockReturnValue(
      browseState([
        {
          results: [
            { id: 'C1', title: '#finance', contentType: 'channel' },
            { id: 'C2', title: '#alerts', contentType: 'channel' },
          ],
          nextCursor: null,
        },
      ]),
    )

    renderPicker()

    expect(screen.getByText('#finance')).toBeInTheDocument()
    expect(screen.getByText('#alerts')).toBeInTheDocument()
    expect(screen.queryByText(/No channels found/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Liftoff cannot list these/i)).not.toBeInTheDocument()
  })

  it('does not claim an empty account while the request is still in flight', () => {
    mockUseBrowseConnector.mockReturnValue({
      data: undefined,
      isPending: true,
      isError: false,
    })

    renderPicker()

    expect(screen.queryByText(/No channels found/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Liftoff cannot list these/i)).not.toBeInTheDocument()
  })
})

// One tree, one pass, no sequence.
//
// Asking a connection's picks one after another fails three ways: confirming
// advances instead of closing, so the modal looks stuck; the card reads
// "1 of 2 selected", which reads as a count of files; and the folder question
// accepts a file, because the tree lists both and nothing ties a row to the
// question being asked.
//
// A row is routed by what it IS. These assert that, and that the modal closes.
describe('a connection with several picks is answered in one pass', () => {
  const folderPick: RequirementObject = {
    id: 'digest-location', kind: 'folder', direction: 'write',
    required: true, label: 'Where they keep the digests',
  }
  const filePick: RequirementObject = {
    id: 'positioning-source', kind: 'file', direction: 'read',
    required: false, label: 'Your positioning document',
  }

  function renderBoth(onPick = vi.fn(), onClose = vi.fn()) {
    render(
      <ObjectPicker
        objects={[folderPick, filePick]}
        connectorId="conn-1"
        connectorName="Google Drive"
        onPick={onPick}
        onClose={onClose}
      />,
    )
    return { onPick, onClose }
  }

  it('sends a folder to the folder pick and a file to the file pick', () => {
    filePickerRows = [
      { id: 'F1', title: 'Marketing', contentType: 'folder' },
      { id: 'D1', title: 'Positioning', contentType: 'document' },
    ]
    const { onPick, onClose } = renderBoth()
    screen.getByTestId('file-picker-confirm').click()

    expect(onPick).toHaveBeenCalledWith('digest-location', { id: 'F1', title: 'Marketing' })
    expect(onPick).toHaveBeenCalledWith('positioning-source', { id: 'D1', title: 'Positioning' })
    expect(onClose).toHaveBeenCalled()
  })

  it('closes after a single folder, rather than advancing to another question', () => {
    // The reported bug: confirming left the modal open.
    filePickerRows = [{ id: 'F1', title: 'Marketing', contentType: 'folder' }]
    const { onPick, onClose } = renderBoth()
    screen.getByTestId('file-picker-confirm').click()

    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalled()
  })

  it('closes after a single file too', () => {
    filePickerRows = [{ id: 'D1', title: 'Positioning', contentType: 'document' }]
    const { onPick, onClose } = renderBoth()
    screen.getByTestId('file-picker-confirm').click()

    expect(onPick).toHaveBeenCalledWith('positioning-source', { id: 'D1', title: 'Positioning' })
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps the last of a kind rather than accumulating', () => {
    // A destination is one place: checking a second folder replaces the first.
    filePickerRows = [
      { id: 'F1', title: 'Old', contentType: 'folder' },
      { id: 'F2', title: 'New', contentType: 'folder' },
    ]
    const { onPick } = renderBoth()
    screen.getByTestId('file-picker-confirm').click()

    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith('digest-location', { id: 'F2', title: 'New' })
  })

  it('closes without picking when nothing was checked', () => {
    filePickerRows = []
    const { onPick, onClose } = renderBoth()
    screen.getByTestId('file-picker-confirm').click()

    expect(onPick).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})


// Rows arrive in whatever order a vendor felt like, and are shown A to Z.
//
// Slack returns channels in creation order, Google Docs by modified time, Drive
// by its own default. The same workspace looked different depending on which
// connector reached it, and finding a channel whose name you already knew meant
// reading every row.
describe('rows are listed alphabetically', () => {
  const shownTitles = () =>
    screen.getAllByRole('button')
      .map(b => b.textContent)
      .filter((t): t is string => !!t && t.startsWith('#'))

  it('sorts channels by name, whatever order they arrived in', () => {
    mockUseBrowseConnector.mockReturnValue(
      browseState([{
        results: [
          { id: 'C3', title: '#zulu', contentType: 'channel' },
          { id: 'C1', title: '#alpha', contentType: 'channel' },
          { id: 'C2', title: '#mike', contentType: 'channel' },
        ],
        nextCursor: null,
      }]),
    )

    renderPicker()
    expect(shownTitles()).toEqual(['#alpha', '#mike', '#zulu'])
  })

  it('orders numbers the way a person counts them', () => {
    // "room-10" after "room-2", not before it.
    mockUseBrowseConnector.mockReturnValue(
      browseState([{
        results: [
          { id: 'C1', title: '#room-10', contentType: 'channel' },
          { id: 'C2', title: '#room-2', contentType: 'channel' },
        ],
        nextCursor: null,
      }]),
    )

    renderPicker()
    expect(shownTitles()).toEqual(['#room-2', '#room-10'])
  })

  it('does not split neighbours apart on case', () => {
    mockUseBrowseConnector.mockReturnValue(
      browseState([{
        results: [
          { id: 'C1', title: '#Beta', contentType: 'channel' },
          { id: 'C2', title: '#alpha', contentType: 'channel' },
        ],
        nextCursor: null,
      }]),
    )

    renderPicker()
    expect(shownTitles()).toEqual(['#alpha', '#Beta'])
  })
})

// A tree answers TWO questions and routes a pick by what it is: tick a folder
// and you have answered the folder question, tick a file and you have answered
// the file one. That routing is invisible from the rows, and the labels — the
// entire content of both questions — were rendered only for FLAT kinds.
//
// On the Competitive Intelligence template the folder pick is "Where this team
// should save its work" and the file pick is "Your positioning or messaging
// document". A person who picked a document meaning the first was silently
// recorded as answering the second: they hired a team with no save destination,
// and its next run scattered nine documents across their Drive.
describe('a tree says which question each row answers', () => {
  const picks = [
    {
      id: 'working-folder', kind: 'folder' as const, direction: 'write' as const,
      required: false, label: 'Where this team should save its work',
    },
    {
      id: 'positioning-source', kind: 'file' as const, direction: 'read' as const,
      required: false, label: 'Your positioning or messaging document',
    },
  ]

  it('states both questions, not just the connection name', () => {
    renderPicker({ objects: picks })

    expect(screen.getByText('Where this team should save its work')).toBeInTheDocument()
    expect(screen.getByText('Your positioning or messaging document')).toBeInTheDocument()
  })

  it('says it with the labels and no kind chrome', () => {
    renderPicker({ objects: picks })

    // The routing is by kind: tick a folder and you answer the folder pick.
    // The labels already carry that — "where this team should save its work"
    // reads as a place and "your positioning document" reads as a file — so a
    // badge repeating it above them is the control describing itself.
    expect(screen.queryByText('Pick a folder')).not.toBeInTheDocument()
    expect(screen.queryByText('Pick a file')).not.toBeInTheDocument()
    expect(screen.getByText('Where this team should save its work')).toBeInTheDocument()
    expect(screen.getByText('Your positioning or messaging document')).toBeInTheDocument()
  })

  it('says nothing extra when the connection asks only one thing', () => {
    renderPicker({ objects: [picks[0]] })

    expect(screen.getByText('Where this team should save its work')).toBeInTheDocument()
    expect(screen.queryByText('Pick a file')).not.toBeInTheDocument()
  })
})

// One question about where a team's work goes, answerable with a folder or a
// file. The pair it replaces let the ANSWER choose the question.
describe('a destination takes whatever was chosen', () => {
  const destination = [{
    id: 'working-folder', kind: 'destination' as const, direction: 'write' as const,
    required: true, label: 'Where this team should save its work',
  }]

  it('states the one question, and nothing else', () => {
    renderPicker({ objects: destination })

    expect(screen.getByText('Where this team should save its work')).toBeInTheDocument()
    // No kind badge, ever. The label is the question; whether the answer turns
    // out to be a folder or a document is the person's choice to make, not a
    // fact worth announcing back to them above it.
    expect(screen.queryByText('Folder or file')).not.toBeInTheDocument()
  })

  it('shows the labels and no kind chrome when two picks are on screen', () => {
    // The labels are what stopped one question being answered with the other's
    // answer. The badges never did that work.
    renderPicker({ objects: [
      ...destination,
      { id: 'positioning-source', kind: 'file' as const, direction: 'read' as const,
        required: false, label: 'Your positioning document' },
    ] })

    expect(screen.getByText('Where this team should save its work')).toBeInTheDocument()
    expect(screen.getByText('Your positioning document')).toBeInTheDocument()
    expect(screen.queryByText('Folder or file')).not.toBeInTheDocument()
    expect(screen.queryByText('Pick a file')).not.toBeInTheDocument()
    expect(screen.queryByText('Pick a folder')).not.toBeInTheDocument()
  })

  it('does not offer the folder/file split it replaces', () => {
    renderPicker({ objects: destination })

    expect(screen.queryByText('Pick a folder')).not.toBeInTheDocument()
    expect(screen.queryByText('Pick a file')).not.toBeInTheDocument()
  })
})

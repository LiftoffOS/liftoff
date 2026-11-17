/* eslint-disable @typescript-eslint/no-var-requires */

jest.mock('../disconnect-handler', () => ({
  handleConnectorDeleted: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Mock PubSub so we can capture the message handler
let capturedMessageHandler: ((msg: unknown) => void) | null = null;
jest.mock('@google-cloud/pubsub', () => ({
  PubSub: jest.fn().mockImplementation(() => ({
    subscription: jest.fn().mockReturnValue({
      on: jest.fn().mockImplementation((event: string, handler: (msg: unknown) => void) => {
        if (event === 'message') capturedMessageHandler = handler;
      }),
    }),
  })),
}));

import { startControlPlaneSubscriber } from '../control-plane-subscriber';
import { handleConnectorDeleted } from '../disconnect-handler';

const mockedHandle = handleConnectorDeleted as jest.MockedFunction<typeof handleConnectorDeleted>;

function makeMessage(attributes: Record<string, string>): { attributes: Record<string, string>; ack: jest.Mock; nack: jest.Mock } {
  return { attributes, ack: jest.fn(), nack: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  capturedMessageHandler = null;
  startControlPlaneSubscriber();
});

describe('control-plane subscriber', () => {
  it('acks and discards non-connector.deleted events', async () => {
    const msg = makeMessage({ eventType: 'connector.created', entityId: 'conn-1', tenantId: 'tenant-1' });
    capturedMessageHandler!(msg);
    await new Promise(r => setTimeout(r, 10));
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(mockedHandle).not.toHaveBeenCalled();
  });

  it('acks and logs when connector.deleted is missing entityId', async () => {
    const msg = makeMessage({ eventType: 'connector.deleted', tenantId: 'tenant-1' });
    capturedMessageHandler!(msg);
    await new Promise(r => setTimeout(r, 10));
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(mockedHandle).not.toHaveBeenCalled();
  });

  it('calls handleConnectorDeleted and acks on valid connector.deleted', async () => {
    const msg = makeMessage({ eventType: 'connector.deleted', entityId: 'conn-1', tenantId: 'tenant-1' });
    capturedMessageHandler!(msg);
    await new Promise(r => setTimeout(r, 10));
    expect(mockedHandle).toHaveBeenCalledWith('conn-1', 'tenant-1');
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.nack).not.toHaveBeenCalled();
  });

  it('nacks when handleConnectorDeleted throws', async () => {
    mockedHandle.mockRejectedValueOnce(new Error('cleanup failed'));
    const msg = makeMessage({ eventType: 'connector.deleted', entityId: 'conn-1', tenantId: 'tenant-1' });
    capturedMessageHandler!(msg);
    await new Promise(r => setTimeout(r, 10));
    expect(msg.nack).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
  });
});

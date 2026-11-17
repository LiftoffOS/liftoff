// Pub/Sub Publisher Infrastructure
// Per Section 4: Real-time event publishing for control plane events
//
// Thin wrapper around @liftoffos/pubsub that encodes the control-plane
// conventions (env-suffixed topic names, default timestamp attribute,
// platform logger) while keeping the callsite API unchanged.

import { PubSubPublisher as PkgPubSubPublisher } from '@liftoffos/pubsub';
import { log } from './logging';

const environment = process.env.ENVIRONMENT || 'dev';

export class PubSubPublisher {
  private readonly inner = new PkgPubSubPublisher({
    resolveTopicName: (shortName) => `${shortName}-${environment}`,
    defaultAttributes: () => ({ timestamp: new Date().toISOString() }),
    logger: {
      debug: (ctx, msg) => log.debug(ctx, msg),
      error: (ctx, msg) => log.error(ctx, msg),
    },
  });

  publish(topicName: string, data: unknown): Promise<string> {
    return this.inner.publish(topicName, data);
  }

  publishBatch(topicName: string, messages: unknown[]): Promise<string[]> {
    return this.inner.publishBatch(topicName, messages);
  }
}

// Singleton instance
export const pubSubPublisher = new PubSubPublisher();

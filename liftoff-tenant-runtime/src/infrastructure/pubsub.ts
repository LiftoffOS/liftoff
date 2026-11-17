// Tenant-runtime PubSub — delegates to @liftoffos/pubsub with raw topic
// names (no env suffix) and no default attributes, matching the existing
// tenant-runtime semantics.

import { PubSubPublisher as PkgPubSubPublisher } from '@liftoffos/pubsub';
import { logger } from './logging';

export class PubSubPublisher {
  private readonly inner = new PkgPubSubPublisher({
    projectId: process.env.GCP_PROJECT_ID,
    // Caller provides fully-qualified topic name — matches the existing
    // tenant-runtime behaviour.
    resolveTopicName: (name) => name,
    logger: {
      debug: (ctx, msg) => logger.debug(ctx, msg),
      error: (ctx, msg) => logger.error(ctx, msg),
    },
  });

  publish(topicName: string, message: Record<string, unknown>): Promise<string> {
    return this.inner.publish(topicName, message);
  }

  publishBatch(topicName: string, messages: Record<string, unknown>[]): Promise<string[]> {
    return this.inner.publishBatch(topicName, messages);
  }
}

export const publisher = new PubSubPublisher();

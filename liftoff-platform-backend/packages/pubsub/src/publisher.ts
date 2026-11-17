import { PubSub, Topic } from '@google-cloud/pubsub';

export type Logger = {
  debug: (ctx: Record<string, unknown>, msg: string) => void;
  error: (ctx: Record<string, unknown>, msg: string) => void;
};

export interface PubSubPublisherOptions {
  /** GCP project ID. Defaults to env GCP_PROJECT_ID (so ADC). */
  projectId?: string;
  /**
   * Resolves a caller-provided short topic name to the full Pub/Sub topic name.
   * Use this to attach an env suffix (`tenant-updated` → `tenant-updated-prod`).
   * Default: identity (no transformation).
   */
  resolveTopicName?: (shortName: string) => string;
  /**
   * Attributes to attach to every message (computed per publish call). The
   * platform-backend historically included `timestamp`; tenant-runtime
   * attaches no default attributes. Merged with per-call attributes (the
   * per-call ones win on key conflict).
   */
  defaultAttributes?: () => Record<string, string>;
  /** Optional structured logger. Defaults to noop. */
  logger?: Logger;
}

export interface PublishOptions {
  /** Per-message Pub/Sub attributes. Merged with defaultAttributes. */
  attributes?: Record<string, string>;
  /** Per-message ordering key for ordered delivery. */
  orderingKey?: string;
}

const NOOP_LOGGER: Logger = {
  debug: () => {},
  error: () => {},
};

/**
 * Thin wrapper around @google-cloud/pubsub that caches topic handles,
 * serialises JSON bodies, and applies caller-configured defaults. Both
 * Liftoff repos use the same shape — this package unifies them.
 */
export class PubSubPublisher {
  private readonly pubsub: PubSub;
  private readonly topicCache = new Map<string, Topic>();
  private readonly resolveTopicName: (shortName: string) => string;
  private readonly defaultAttributes?: () => Record<string, string>;
  private readonly logger: Logger;

  constructor(options: PubSubPublisherOptions = {}) {
    this.pubsub = new PubSub(
      options.projectId ? { projectId: options.projectId } : {},
    );
    this.resolveTopicName = options.resolveTopicName ?? ((name) => name);
    this.defaultAttributes = options.defaultAttributes;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  private getTopic(shortName: string): Topic {
    const fullName = this.resolveTopicName(shortName);
    let topic = this.topicCache.get(fullName);
    if (!topic) {
      topic = this.pubsub.topic(fullName);
      this.topicCache.set(fullName, topic);
    }
    return topic;
  }

  async publish(
    topicName: string,
    data: unknown,
    options: PublishOptions = {},
  ): Promise<string> {
    const topic = this.getTopic(topicName);
    const attributes = {
      ...(this.defaultAttributes?.() ?? {}),
      ...(options.attributes ?? {}),
    };

    try {
      const messageId = await topic.publishMessage({
        data: Buffer.from(JSON.stringify(data)),
        attributes,
        ...(options.orderingKey ? { orderingKey: options.orderingKey } : {}),
      });
      this.logger.debug({ topicName, messageId }, 'Message published to Pub/Sub');
      return messageId;
    } catch (error) {
      this.logger.error(
        { topicName, error: error instanceof Error ? error.message : String(error) },
        'Failed to publish message to Pub/Sub',
      );
      throw error;
    }
  }

  async publishBatch(
    topicName: string,
    messages: unknown[],
    options: PublishOptions = {},
  ): Promise<string[]> {
    // Reuse the same topic handle — one Promise.all for batched publish.
    const topic = this.getTopic(topicName);
    const attributes = {
      ...(this.defaultAttributes?.() ?? {}),
      ...(options.attributes ?? {}),
    };

    try {
      const ids = await Promise.all(
        messages.map((msg) =>
          topic.publishMessage({
            data: Buffer.from(JSON.stringify(msg)),
            attributes,
            ...(options.orderingKey ? { orderingKey: options.orderingKey } : {}),
          }),
        ),
      );
      this.logger.debug(
        { topicName, count: ids.length },
        'Message batch published to Pub/Sub',
      );
      return ids;
    } catch (error) {
      this.logger.error(
        {
          topicName,
          count: messages.length,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to publish message batch to Pub/Sub',
      );
      throw error;
    }
  }
}

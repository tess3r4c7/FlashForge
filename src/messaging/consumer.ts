import type { ConsumeMessage, Options } from "amqplib";
import { logger } from "../lib/logger.js";
import type { DomainEvent } from "./events.js";
import {
  RETRY_DELAYS_MS,
  assertWorkQueue,
  connectRabbitMQ,
  deadLetterQueueName,
  retryQueueName,
} from "./rabbitmq.js";

export interface ConsumerOptions {
  /** Shown in logs and in the RabbitMQ UI. */
  name: string;
  queue: string;
  /**
   * Max messages this consumer holds un-acknowledged at once.
   * = how many are processed in parallel. RabbitMQ won't send more until
   * one is acked. This is our back-pressure / concurrency limit.
   */
  prefetch: number;
  /** Business logic. Throw to signal failure; return normally for success. */
  handle: (event: DomainEvent) => Promise<void>;
  /** Called if the broker connection drops unexpectedly. */
  onConnectionLost?: (err?: Error) => void;
}

export interface ConsumerHandle {
  /** Stop taking new messages, finish in-flight ones, then disconnect. */
  stop(): Promise<void>;
}

/**
 * Throw this from a handler when retrying can NEVER help (invalid data,
 * a business rule that will fail the same way every time). The message
 * goes straight to the dead-letter queue instead of wasting retries.
 *
 * Everything else (DB down, gateway timeout, network blip) is assumed to be
 * TRANSIENT and is retried with back-off.
 */
export class NonRetryableError extends Error {
  override name = "NonRetryableError";
}

/** Header we use to count attempts across retries. */
export const ATTEMPT_HEADER = "x-attempt";

/**
 * Subscribes to a queue and runs `handle` for every message.
 *
 * Acknowledgement rules (the heart of reliable messaging):
 *   handler succeeds        → ack → RabbitMQ deletes the message
 *   handler throws          → copy to a RETRY queue (waits 1s, 5s, 30s...),
 *                             then ack the original
 *   retries exhausted, or
 *   NonRetryableError, or
 *   unparseable message     → copy to the DEAD-LETTER queue, ack the original
 *   worker crashes mid-way  → no ack ever sent → RabbitMQ redelivers it
 *
 * Because of that last rule (and the outbox relay), a message can be
 * processed MORE THAN ONCE ("at-least-once delivery"). Handlers must be
 * idempotent: see processed-events.ts and the payment worker's state guard.
 */
export async function startConsumer(
  options: ConsumerOptions,
): Promise<ConsumerHandle> {
  const { name, queue, prefetch, handle, onConnectionLost } = options;
  const log = logger.child({ worker: name, queue });
  const dlq = deadLetterQueueName(queue);

  const connection = await connectRabbitMQ(name);
  // A CONFIRM channel: when we copy a failed message to a retry queue or the
  // DLQ, we wait for the broker to confirm it stored the copy BEFORE acking
  // the original. Otherwise a broker hiccup could lose the message entirely.
  const channel = await connection.createConfirmChannel();
  await assertWorkQueue(channel, queue); // also works for queues not in BINDINGS
  await channel.prefetch(prefetch);

  let stopping = false;
  const inFlight = new Set<Promise<void>>();

  connection.on("close", (err?: Error) => {
    if (stopping) return;
    log.error({ err }, "RabbitMQ connection lost");
    onConnectionLost?.(err);
  });

  // ack/nack can throw if the channel already closed. The message will be
  // redelivered anyway in that case, so we just log.
  const settle = (action: () => void) => {
    try {
      action();
    } catch (err) {
      log.warn({ err }, "Could not ack/nack (channel closed); message will be redelivered");
    }
  };

  /** Sends a copy of `msg` to `targetQueue` and waits for the broker's confirm. */
  function sendCopy(
    msg: ConsumeMessage,
    targetQueue: string,
    headers: Record<string, unknown>,
  ): Promise<void> {
    const props = msg.properties;
    const publishOptions: Options.Publish = {
      persistent: true,
      headers: { ...(props.headers ?? {}), ...headers },
    };
    if (props.contentType) publishOptions.contentType = props.contentType;
    if (props.messageId) publishOptions.messageId = props.messageId;
    if (props.type) publishOptions.type = props.type;

    return new Promise((resolve, reject) => {
      try {
        // Default exchange ("") routes by queue name: sendToQueue(q) = "put it in q".
        channel.sendToQueue(targetQueue, msg.content, publishOptions, (err) =>
          err ? reject(err) : resolve(),
        );
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Moves a failed message to a retry queue or the DLQ, then acks the
   * original. If even that fails (broker trouble), nack-with-requeue so the
   * message stays in the main queue: we never drop a message on the floor.
   */
  async function routeFailure(
    msg: ConsumeMessage,
    attempt: number,
    err: unknown,
    eventLog: typeof log,
  ): Promise<void> {
    const errorMessage = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const retryable = !(err instanceof NonRetryableError);
    const delayMs = RETRY_DELAYS_MS[attempt - 1]; // undefined once retries are used up

    try {
      if (retryable && delayMs !== undefined) {
        await sendCopy(msg, retryQueueName(queue, delayMs), {
          [ATTEMPT_HEADER]: attempt + 1,
          "x-last-error": errorMessage,
        });
        eventLog.warn(
          { err, attempt, retryInMs: delayMs },
          `Handler failed (attempt ${attempt}); retrying in ${delayMs}ms`,
        );
      } else {
        await sendCopy(msg, dlq, {
          [ATTEMPT_HEADER]: attempt,
          "x-last-error": errorMessage,
          "x-dead-lettered-at": new Date().toISOString(),
          "x-dead-letter-reason": retryable ? "retries-exhausted" : "non-retryable",
        });
        eventLog.error(
          { err, attempt, dlq },
          retryable
            ? `Handler failed ${attempt} times; moved to dead-letter queue`
            : "Non-retryable failure; moved to dead-letter queue",
        );
      }
      settle(() => channel.ack(msg));
    } catch (routeErr) {
      eventLog.error({ err: routeErr }, "Could not move failed message; requeueing it");
      settle(() => channel.nack(msg, false, true));
    }
  }

  async function processMessage(msg: ConsumeMessage): Promise<void> {
    const attempt = Number(msg.properties.headers?.[ATTEMPT_HEADER] ?? 1) || 1;

    let event: DomainEvent;
    try {
      event = JSON.parse(msg.content.toString("utf8")) as DomainEvent;
    } catch (err) {
      // A "poison message": it will never parse, retrying is pointless.
      // Park it in the DLQ (instead of deleting it) so someone can look at it.
      await routeFailure(msg, attempt, new NonRetryableError(`Malformed JSON: ${String(err)}`), log);
      return;
    }

    const eventLog = log.child({
      eventType: event.type,
      eventId: event.eventId,
      attempt,
      redelivered: msg.fields.redelivered,
    });

    try {
      await handle(event);
      settle(() => channel.ack(msg));
    } catch (err) {
      await routeFailure(msg, attempt, err, eventLog);
    }
  }

  // noAck: false → WE decide when a message is done (manual acknowledgement).
  // With noAck: true, RabbitMQ deletes the message the moment it's sent, so a
  // crash mid-processing would lose it forever.
  const { consumerTag } = await channel.consume(
    queue,
    (msg) => {
      if (!msg) {
        log.warn("Consumer was cancelled by the broker");
        return;
      }
      const task = processMessage(msg).finally(() => inFlight.delete(task));
      inFlight.add(task);
    },
    { noAck: false },
  );

  log.info({ prefetch, retryDelaysMs: RETRY_DELAYS_MS }, "Consumer started");

  return {
    async stop() {
      if (stopping) return;
      stopping = true;
      try {
        await channel.cancel(consumerTag); // 1. no new deliveries
        await Promise.allSettled([...inFlight]); // 2. finish current work
        await channel.close();
        await connection.close(); // 3. disconnect
      } catch (err) {
        log.warn({ err }, "Error while stopping consumer");
      }
      log.info("Consumer stopped");
    },
  };
}

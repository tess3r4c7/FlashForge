import type { ConsumeMessage } from "amqplib";
import { logger } from "../lib/logger.js";
import type { DomainEvent } from "./events.js";
import { connectRabbitMQ } from "./rabbitmq.js";

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
 * Subscribes to a queue and runs `handle` for every message.
 *
 * Acknowledgement rules (the heart of reliable messaging):
 *   handler succeeds          → ack   → RabbitMQ deletes the message
 *   handler throws (1st time) → nack + requeue → message is delivered again
 *   handler throws (2nd time) → nack, no requeue → message is dropped & logged
 *   worker crashes mid-way    → no ack ever sent → RabbitMQ redelivers it
 *                               to another consumer when the connection drops
 *
 * Because of that last rule, a message can be processed MORE THAN ONCE
 * ("at-least-once delivery"). Handlers must be safe to run twice.
 */
export async function startConsumer(
  options: ConsumerOptions,
): Promise<ConsumerHandle> {
  const { name, queue, prefetch, handle, onConnectionLost } = options;
  const log = logger.child({ worker: name, queue });

  const connection = await connectRabbitMQ(name);
  const channel = await connection.createChannel();
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

  async function processMessage(msg: ConsumeMessage): Promise<void> {
    let event: DomainEvent;
    try {
      event = JSON.parse(msg.content.toString("utf8")) as DomainEvent;
    } catch (err) {
      // A "poison message": it will never parse, retrying is pointless.
      log.error({ err }, "Malformed message, discarding");
      settle(() => channel.nack(msg, false, false));
      return;
    }

    const eventLog = log.child({
      eventType: event.type,
      eventId: event.eventId,
      redelivered: msg.fields.redelivered,
    });

    try {
      await handle(event);
      settle(() => channel.ack(msg));
    } catch (err) {
      if (!msg.fields.redelivered) {
        eventLog.warn({ err }, "Handler failed; requeueing for one retry");
        settle(() => channel.nack(msg, false, true));
      } else {
        // Phase 5 replaces this with retries + backoff + a dead-letter queue.
        eventLog.error({ err }, "Handler failed on retry; discarding message");
        settle(() => channel.nack(msg, false, false));
      }
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

  log.info({ prefetch }, "Consumer started");

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

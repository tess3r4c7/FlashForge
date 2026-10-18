import type { ChannelModel, ConfirmChannel } from "amqplib";
import { logger } from "../lib/logger.js";
import type { DomainEvent } from "./events.js";
import { EXCHANGE, connectRabbitMQ } from "./rabbitmq.js";

// The API process keeps ONE connection + ONE confirm channel for publishing,
// shared by all requests. It is opened lazily on the first publish, and if
// RabbitMQ restarts, the next publish simply opens a new one.

interface PublisherState {
  connection: ChannelModel;
  channel: ConfirmChannel;
}

let statePromise: Promise<PublisherState> | null = null;
let current: PublisherState | null = null;

async function open(): Promise<PublisherState> {
  // Both the API and the worker publish, so the name is process-neutral.
  const connection = await connectRabbitMQ(`flashforge-publisher-${process.pid}`);

  // A CONFIRM channel makes the broker reply "got it, stored it" for every
  // message. Without confirms, publish() is fire-and-forget: if the broker
  // drops the message, we'd never know.
  const channel = await connection.createConfirmChannel();
  const state: PublisherState = { connection, channel };

  // If the connection or channel dies, forget it so the next publish reconnects.
  const reset = (reason: string) => {
    if (current !== state) return; // already reset, or closed on purpose
    current = null;
    statePromise = null;
    logger.warn({ reason }, "RabbitMQ publisher lost; will reconnect on next publish");
    connection.close().catch(() => {});
  };

  connection.on("close", () => reset("connection closed"));
  channel.on("close", () => reset("channel closed"));
  channel.on("error", (err) => {
    logger.error({ err }, "RabbitMQ publisher channel error");
  });

  current = state;
  return state;
}

function getPublisher(): Promise<PublisherState> {
  // Cache the PROMISE, not the result: if 20 requests publish at the same
  // moment before we're connected, they all await the same connection
  // attempt instead of opening 20 connections.
  if (!statePromise) {
    statePromise = open().catch((err) => {
      statePromise = null; // allow a retry on the next publish
      throw err;
    });
  }
  return statePromise;
}

/**
 * Publishes an event and waits until RabbitMQ confirms it has stored it.
 * Throws if RabbitMQ is unreachable or rejects the message.
 *
 * Routing key = event.type, so "payment.requested" lands in the payments
 * queue and "order.*" events land in the notifications queue.
 */
export async function publishEvent(event: DomainEvent): Promise<void> {
  const { channel } = await getPublisher();
  const body = Buffer.from(JSON.stringify(event));

  await new Promise<void>((resolve, reject) => {
    channel.publish(
      EXCHANGE,
      event.type,
      body,
      {
        // persistent: written to disk, survives a broker restart
        // (only works because the queues are also durable)
        persistent: true,
        contentType: "application/json",
        messageId: event.eventId,
        type: event.type,
        timestamp: Math.floor(Date.now() / 1000),
      },
      (err) => (err ? reject(err) : resolve()),
    );
  });

  logger.debug({ eventType: event.type, eventId: event.eventId }, "Event published");
}

/**
 * For events where losing one is annoying but not harmful (e.g. "send a
 * confirmation email"). Logs the failure instead of failing the request.
 */
export async function publishEventBestEffort(event: DomainEvent): Promise<void> {
  try {
    await publishEvent(event);
  } catch (err) {
    logger.error(
      { err, eventType: event.type, eventId: event.eventId },
      "Failed to publish event (best effort, continuing)",
    );
  }
}

/** Closes the publisher connection. Called on server shutdown. */
export async function closePublisher(): Promise<void> {
  const pending = statePromise;
  statePromise = null;
  current = null;
  if (!pending) return;

  try {
    const state = await pending;
    current = null;
    await state.connection.close();
  } catch {
    // Already closed or never connected — nothing to do
  }
}

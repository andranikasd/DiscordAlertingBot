import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { parseSqsSnsBody } from "../types/sns.js";
import { processSnsNotification } from "./sns-processor.js";
import type { FastifyBaseLogger } from "fastify";
import { inc } from "../metrics.js";

const POLL_WAIT_SECONDS = 20;
const MAX_MESSAGES = 10;
const VISIBILITY_TIMEOUT_SECONDS = 60;

function getQueueUrl(): string | null {
  const url = process.env.SQS_ALERT_QUEUE_URL ?? process.env.SNS_QUEUE_URL;
  return url?.trim() || null;
}

/** Parse region from queue URL (https://sqs.eu-west-1.amazonaws.com/...) or use env. */
function getQueueRegion(): string {
  const envRegion = process.env.SQS_ALERT_QUEUE_REGION?.trim();
  if (envRegion) return envRegion;
  const url = getQueueUrl();
  if (url) {
    try {
      const match = url.match(/^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\//i);
      if (match?.[1]) return match[1];
    } catch {
      // ignore
    }
  }
  return process.env.AWS_REGION ?? "eu-west-1";
}

export function isSqsPollerEnabled(): boolean {
  return getQueueUrl() != null;
}

/**
 * Process one SQS message: parse SNS envelope from body, run SNS processor, delete on success.
 */
async function processOneMessage(
  message: Message,
  queueUrl: string,
  client: SQSClient,
  log: FastifyBaseLogger
): Promise<void> {
  const body = message.Body;
  const envelope = parseSqsSnsBody(body);
  if (!envelope) {
    log.warn({ component: "sqs_poller", event: "parse_failed", messageId: message.MessageId }, "sqs_message_parse_failed");
    return;
  }
  try {
    await processSnsNotification(envelope, log);
    inc("sqs_messages_processed_total");
  } catch (err) {
    log.error({ component: "sqs_poller", event: "process_failed", messageId: message.MessageId, err }, "sqs_message_process_failed");
    throw err;
  }
  if (!message.ReceiptHandle) return;
  await client.send(
    new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: message.ReceiptHandle,
    })
  );
  log.debug({ component: "sqs_poller", event: "deleted", messageId: message.MessageId }, "sqs_message_deleted");
}

/**
 * Run one poll cycle: receive messages, process each, delete on success.
 */
async function pollOnce(client: SQSClient, queueUrl: string, log: FastifyBaseLogger): Promise<void> {
  const response = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: MAX_MESSAGES,
      WaitTimeSeconds: POLL_WAIT_SECONDS,
      VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
      MessageAttributeNames: ["All"],
    })
  );
  const messages = response.Messages ?? [];
  for (const message of messages) {
    try {
      await processOneMessage(message, queueUrl, client, log);
    } catch {
      // Message will become visible again after visibility timeout for retry
    }
  }
}

/**
 * Start the SQS poll loop. Call after Discord is ready.
 * Runs until process exits. When SQS_ALERT_QUEUE_URL is not set, does nothing.
 */
export function startSqsPoller(log: FastifyBaseLogger): void {
  const queueUrl = getQueueUrl();
  if (!queueUrl) {
    log.info({ component: "sqs_poller", event: "disabled", reason: "no_queue_url" }, "sqs_poller_disabled");
    return;
  }
  const url: string = queueUrl;
  const region = getQueueRegion();
  const client = new SQSClient({ region });
  log.info({ component: "sqs_poller", event: "started", queueUrl: url.replace(/\/[^/]+$/, "/***"), region }, "sqs_poller_started");

  function run(): void {
    pollOnce(client, url, log)
      .catch((err) => log.warn({ component: "sqs_poller", event: "poll_error", err }, "sqs_poller_poll_error"))
      .finally(() => setImmediate(run));
  }
  run();
}

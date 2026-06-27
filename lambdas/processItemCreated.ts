import type { Context, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  type ItemCreatedEventV1,
  parseItemCreatedEventV1,
} from "./src/events/itemCreated.js";
import {
  processItemCreatedEvent,
  type ProcessingResult,
} from "./src/processing/itemProcessing.js";
import { getRequiredEnv } from "./src/utils/env.js";
import { createLogger } from "./src/utils/logger.js";

const client = new DynamoDBClient();
const operation = "processItemCreated";

export type ProcessItemCreatedEvent = (
  event: ItemCreatedEventV1
) => Promise<ProcessingResult>;

type ProcessorFactory = (tableName: string) => ProcessItemCreatedEvent;

type ProcessItemCreatedHandlerOptions = {
  processorFactory?: ProcessorFactory;
};

const defaultProcessorFactory: ProcessorFactory = (tableName) => (event) =>
  processItemCreatedEvent({ client, tableName, event });

const parseAttempt = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const shouldRetry = (result: ProcessingResult): boolean =>
  result.status === "retryable_failure";

export const createProcessItemCreatedHandler =
  ({
    processorFactory = defaultProcessorFactory,
  }: ProcessItemCreatedHandlerOptions = {}) =>
  async (event: SQSEvent, context?: Context): Promise<SQSBatchResponse> => {
    const logger = createLogger({
      service: "items-api",
      context,
      operation,
    });

    for (const record of event.Records) {
      if (!record.messageId) {
        throw new Error("SQS record is missing messageId");
      }
    }

    let processEvent: ProcessItemCreatedEvent;

    try {
      processEvent = processorFactory(getRequiredEnv("TABLE_NAME"));
    } catch (err) {
      logger.error("Worker configuration unavailable", err, {
        event: "item_processing_failed",
        failureCategory: "configuration_error",
        retryable: true,
      });

      return {
        batchItemFailures: event.Records.map((record) => ({
          itemIdentifier: record.messageId,
        })),
      };
    }

    const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];

    for (const record of event.Records) {
      const messageId = record.messageId;
      const attempt = parseAttempt(record.attributes.ApproximateReceiveCount);

      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(record.body);
      } catch (err) {
        logger.warn("Item processing failed", {
          event: "item_processing_failed",
          messageId,
          attempt,
          failureCategory: "invalid_json",
          retryable: false,
          errorName: err instanceof Error ? err.name : "UnknownError",
        });
        batchItemFailures.push({ itemIdentifier: messageId });
        continue;
      }

      const parsedEvent = parseItemCreatedEventV1(parsedBody);

      if (!parsedEvent.ok) {
        logger.warn("Item processing failed", {
          event: "item_processing_failed",
          messageId,
          attempt,
          failureCategory: "invalid_event",
          retryable: false,
        });
        batchItemFailures.push({ itemIdentifier: messageId });
        continue;
      }

      const itemCreatedEvent = parsedEvent.value;

      try {
        const result = await processEvent(itemCreatedEvent);

        if (result.status === "processed") {
          logger.info("Item processing completed", {
            event: "item_processing_completed",
            eventId: itemCreatedEvent.eventId,
            itemId: itemCreatedEvent.data.itemId,
            messageId,
            eventType: itemCreatedEvent.eventType,
            eventVersion: itemCreatedEvent.eventVersion,
            attempt,
            processingStatus: "COMPLETED",
          });
          continue;
        }

        if (result.status === "already_processed") {
          logger.info("Duplicate event ignored", {
            event: "duplicate_event_ignored",
            eventId: itemCreatedEvent.eventId,
            itemId: itemCreatedEvent.data.itemId,
            messageId,
            attempt,
            processingStatus: "COMPLETED",
          });
          continue;
        }

        logger.warn("Item processing failed", {
          event: "item_processing_failed",
          eventId: itemCreatedEvent.eventId,
          itemId: itemCreatedEvent.data.itemId,
          messageId,
          attempt,
          failureCategory: result.reason,
          retryable: shouldRetry(result),
        });
        batchItemFailures.push({ itemIdentifier: messageId });
      } catch (err) {
        logger.error("Item processing failed", err, {
          event: "item_processing_failed",
          eventId: itemCreatedEvent.eventId,
          itemId: itemCreatedEvent.data.itemId,
          messageId,
          attempt,
          failureCategory: "unknown_error",
          retryable: true,
        });
        batchItemFailures.push({ itemIdentifier: messageId });
      }
    }

    return { batchItemFailures };
  };

export const handler = createProcessItemCreatedHandler();

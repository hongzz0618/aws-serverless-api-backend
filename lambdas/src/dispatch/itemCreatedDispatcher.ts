import type { DynamoDBBatchResponse, DynamoDBRecord } from "aws-lambda";
import { z } from "zod";
import {
  createItemCreatedEventId,
  type ItemCreatedEventV1,
  parseItemCreatedEventV1,
} from "../events/itemCreated.js";
import type { LogFields } from "../utils/logger.js";

export type ItemCreatedDispatchFailureCategory =
  | "configuration_error"
  | "invalid_stream_record"
  | "invalid_domain_event"
  | "sqs_send_failed"
  | "unsupported_stream_event";

export type ItemCreatedEventSender = {
  send(event: ItemCreatedEventV1): Promise<void>;
};

export type ItemCreatedDispatcherLogger = {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, error: unknown, fields?: LogFields): void;
};

const streamRecordBaseSchema = z.object({
  eventName: z.string(),
  dynamodb: z.object({
    SequenceNumber: z.string().min(1),
  }),
});

const itemCreatedStreamRecordSchema = streamRecordBaseSchema.extend({
  eventName: z.literal("INSERT"),
  dynamodb: z.object({
    SequenceNumber: z.string().min(1),
    NewImage: z.object({
      id: z.object({ S: z.string() }),
      name: z.object({ S: z.string() }),
      createdAt: z.object({ S: z.string() }),
    }),
  }),
});

const sequenceNumberFromRecord = (record: DynamoDBRecord): string => {
  const result = streamRecordBaseSchema
    .pick({ dynamodb: true })
    .safeParse(record);

  if (!result.success) {
    throw new Error("DynamoDB stream record is missing SequenceNumber");
  }

  return result.data.dynamodb.SequenceNumber;
};

const failure = (sequenceNumber: string) => ({
  itemIdentifier: sequenceNumber,
});

const buildItemCreatedEvent = (
  record: DynamoDBRecord
):
  | { ok: true; sequenceNumber: string; event: ItemCreatedEventV1 }
  | { ok: false; sequenceNumber: string; category: ItemCreatedDispatchFailureCategory } => {
  const parsedRecord = itemCreatedStreamRecordSchema.safeParse(record);

  if (!parsedRecord.success) {
    return {
      ok: false,
      sequenceNumber: sequenceNumberFromRecord(record),
      category: "invalid_stream_record",
    };
  }

  const itemId = parsedRecord.data.dynamodb.NewImage.id.S;
  const eventCandidate = {
    eventId: createItemCreatedEventId(itemId),
    eventType: "item.created",
    eventVersion: 1,
    occurredAt: parsedRecord.data.dynamodb.NewImage.createdAt.S,
    source: "serverless-api",
    data: {
      itemId,
      name: parsedRecord.data.dynamodb.NewImage.name.S,
    },
  };
  const parsedEvent = parseItemCreatedEventV1(eventCandidate);

  if (!parsedEvent.ok) {
    return {
      ok: false,
      sequenceNumber: parsedRecord.data.dynamodb.SequenceNumber,
      category: "invalid_domain_event",
    };
  }

  return {
    ok: true,
    sequenceNumber: parsedRecord.data.dynamodb.SequenceNumber,
    event: parsedEvent.value,
  };
};

export const dispatchItemCreatedRecords = async ({
  records,
  sender,
  logger,
}: {
  records: DynamoDBRecord[];
  sender: ItemCreatedEventSender;
  logger: ItemCreatedDispatcherLogger;
}): Promise<DynamoDBBatchResponse> => {
  const batchItemFailures: DynamoDBBatchResponse["batchItemFailures"] = [];

  for (const record of records) {
    const sequenceNumber = sequenceNumberFromRecord(record);
    const streamEventName = record.eventName;

    if (typeof streamEventName !== "string") {
      logger.warn("Item-created dispatch failed", {
        event: "item_created_dispatch_failed",
        streamSequenceNumber: sequenceNumber,
        failureCategory: "invalid_stream_record",
      });
      batchItemFailures.push(failure(sequenceNumber));
      continue;
    }

    if (streamEventName !== "INSERT") {
      logger.info("Stream record skipped", {
        event: "stream_record_skipped",
        streamSequenceNumber: sequenceNumber,
        streamEventName,
        failureCategory: "unsupported_stream_event",
      });
      continue;
    }

    const eventResult = buildItemCreatedEvent(record);

    if (!eventResult.ok) {
      logger.warn("Item-created dispatch failed", {
        event: "item_created_dispatch_failed",
        streamSequenceNumber: eventResult.sequenceNumber,
        failureCategory: eventResult.category,
      });
      batchItemFailures.push(failure(eventResult.sequenceNumber));
      continue;
    }

    try {
      await sender.send(eventResult.event);
      logger.info("Item-created event dispatched", {
        event: "item_created_dispatched",
        eventId: eventResult.event.eventId,
        itemId: eventResult.event.data.itemId,
        eventType: eventResult.event.eventType,
        eventVersion: eventResult.event.eventVersion,
        streamSequenceNumber: eventResult.sequenceNumber,
      });
    } catch (err) {
      logger.error("Item-created dispatch failed", err, {
        event: "item_created_dispatch_failed",
        streamSequenceNumber: eventResult.sequenceNumber,
        failureCategory: "sqs_send_failed",
      });
      batchItemFailures.push(failure(eventResult.sequenceNumber));
    }
  }

  return { batchItemFailures };
};

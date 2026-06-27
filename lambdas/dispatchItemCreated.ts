import type {
  Context,
  DynamoDBBatchResponse,
  DynamoDBStreamEvent,
} from "aws-lambda";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  dispatchItemCreatedRecords,
  type ItemCreatedEventSender,
} from "./src/dispatch/itemCreatedDispatcher.js";
import type { ItemCreatedEventV1 } from "./src/events/itemCreated.js";
import { getRequiredEnv } from "./src/utils/env.js";
import { createLogger } from "./src/utils/logger.js";

const sqsClient = new SQSClient();

class SqsItemCreatedEventSender implements ItemCreatedEventSender {
  constructor(private readonly queueUrl: string) {}

  async send(event: ItemCreatedEventV1): Promise<void> {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(event),
      })
    );
  }
}

export const createDispatchItemCreatedHandler =
  ({
    senderFactory = (queueUrl: string): ItemCreatedEventSender =>
      new SqsItemCreatedEventSender(queueUrl),
  }: {
    senderFactory?: (queueUrl: string) => ItemCreatedEventSender;
  } = {}) =>
  async (
    event: DynamoDBStreamEvent,
    context?: Context
  ): Promise<DynamoDBBatchResponse> => {
    const logger = createLogger({
      service: "items-api",
      context,
      operation: "dispatchItemCreated",
    });

    const sequenceNumbersByIndex = event.Records.map((record) => {
      const sequenceNumber = record.dynamodb?.SequenceNumber;

      if (!sequenceNumber) {
        throw new Error("DynamoDB stream record is missing SequenceNumber");
      }

      return sequenceNumber;
    });

    let sender: ItemCreatedEventSender;

    try {
      sender = senderFactory(getRequiredEnv("ITEM_PROCESSING_QUEUE_URL"));
    } catch (err) {
      logger.error("Item-created dispatcher configuration failed", err, {
        event: "item_created_dispatch_failed",
        failureCategory: "configuration_error",
      });

      return {
        batchItemFailures: event.Records.flatMap((record, index) =>
          record.eventName === "INSERT"
            ? [{ itemIdentifier: sequenceNumbersByIndex[index] }]
            : []
        ),
      };
    }

    return dispatchItemCreatedRecords({
      records: event.Records,
      sender,
      logger,
    });
  };

export const handler = createDispatchItemCreatedHandler();

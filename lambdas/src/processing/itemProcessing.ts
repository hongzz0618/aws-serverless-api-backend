import {
  GetItemCommand,
  type GetItemCommandInput,
  type GetItemCommandOutput,
  UpdateItemCommand,
  type UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import type { ItemCreatedEventV1 } from "../events/itemCreated.js";
import { createCreationMetadata } from "./itemMetadata.js";

export type ProcessingFailureReason =
  | "invalid_processing_state"
  | "different_event_already_processed"
  | "conditional_state_unresolved"
  | "dynamodb_error"
  | "unknown_error";

export type ProcessingResult =
  | { status: "processed" }
  | { status: "already_processed" }
  | { status: "item_no_longer_exists" }
  | {
      status: "retryable_failure";
      reason: ProcessingFailureReason;
    }
  | {
      status: "permanent_failure";
      reason: ProcessingFailureReason;
    };

export type Clock = {
  now(): Date;
};

export type DynamoDbCommandClient = {
  send(command: UpdateItemCommand): Promise<unknown>;
  send(command: GetItemCommand): Promise<GetItemCommandOutput>;
};

export type ProcessItemCreatedEventInput = {
  client: DynamoDbCommandClient;
  tableName: string;
  event: ItemCreatedEventV1;
  clock?: Clock;
};

const systemClock: Clock = {
  now: () => new Date(),
};

const isConditionalCheckFailed = (err: unknown): boolean =>
  err instanceof Error && err.name === "ConditionalCheckFailedException";

const getProcessingState = (
  item: GetItemCommandOutput["Item"]
): {
  processingStatus?: string;
  processedEventId?: string;
} => ({
  processingStatus: item?.processingStatus?.S,
  processedEventId: item?.processedEventId?.S,
});

const resolveConditionalFailure = async ({
  client,
  tableName,
  event,
}: Omit<ProcessItemCreatedEventInput, "clock">): Promise<ProcessingResult> => {
  let current: GetItemCommandOutput;

  try {
    const input: GetItemCommandInput = {
      TableName: tableName,
      Key: { id: { S: event.data.itemId } },
      ConsistentRead: true,
    };
    current = await client.send(new GetItemCommand(input));
  } catch {
    return {
      status: "retryable_failure",
      reason: "dynamodb_error",
    };
  }

  if (!current.Item) {
    return { status: "item_no_longer_exists" };
  }

  const { processingStatus, processedEventId } = getProcessingState(current.Item);

  if (processingStatus === "COMPLETED" && processedEventId === event.eventId) {
    return { status: "already_processed" };
  }

  if (processedEventId && processedEventId !== event.eventId) {
    return {
      status: "permanent_failure",
      reason: "different_event_already_processed",
    };
  }

  if (
    processingStatus === undefined ||
    (processingStatus !== "PENDING" && processingStatus !== "COMPLETED") ||
    (processingStatus === "COMPLETED" && !processedEventId)
  ) {
    return {
      status: "permanent_failure",
      reason: "invalid_processing_state",
    };
  }

  if (processingStatus === "PENDING" && !processedEventId) {
    return {
      status: "retryable_failure",
      reason: "conditional_state_unresolved",
    };
  }

  return {
    status: "retryable_failure",
    reason: "conditional_state_unresolved",
  };
};

export const processItemCreatedEvent = async ({
  client,
  tableName,
  event,
  clock = systemClock,
}: ProcessItemCreatedEventInput): Promise<ProcessingResult> => {
  const metadata = createCreationMetadata(event.data.name);
  const updateInput: UpdateItemCommandInput = {
    TableName: tableName,
    Key: { id: { S: event.data.itemId } },
    UpdateExpression:
      "SET #processingStatus = :completed, #processedEventId = :eventId, #processedAt = :processedAt, #creationMetadata = :creationMetadata",
    ConditionExpression:
      "attribute_exists(#id) AND #processingStatus = :pending AND attribute_not_exists(#processedEventId)",
    ExpressionAttributeNames: {
      "#id": "id",
      "#processingStatus": "processingStatus",
      "#processedEventId": "processedEventId",
      "#processedAt": "processedAt",
      "#creationMetadata": "creationMetadata",
    },
    ExpressionAttributeValues: {
      ":pending": { S: "PENDING" },
      ":completed": { S: "COMPLETED" },
      ":eventId": { S: event.eventId },
      ":processedAt": { S: clock.now().toISOString() },
      ":creationMetadata": {
        M: {
          normalizedName: { S: metadata.normalizedName },
          nameLength: { N: String(metadata.nameLength) },
        },
      },
    },
  };

  try {
    await client.send(new UpdateItemCommand(updateInput));
    return { status: "processed" };
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      return resolveConditionalFailure({ client, tableName, event });
    }

    if (err instanceof Error) {
      return {
        status: "retryable_failure",
        reason: "dynamodb_error",
      };
    }

    return {
      status: "retryable_failure",
      reason: "unknown_error",
    };
  }
};

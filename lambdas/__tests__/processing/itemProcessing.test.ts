import { GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemCreatedEventV1 } from "../../src/events/itemCreated.js";
import {
  processItemCreatedEvent,
  type DynamoDbCommandClient,
} from "../../src/processing/itemProcessing.js";

const itemId = "550e8400-e29b-41d4-a716-446655440000";
const event: ItemCreatedEventV1 = {
  eventId: `item.created.v1:${itemId}`,
  eventType: "item.created",
  eventVersion: 1,
  occurredAt: "2026-06-27T10:00:00.000Z",
  source: "serverless-api",
  data: {
    itemId,
    name: " Example 😀 ",
  },
};

const fixedClock = {
  now: () => new Date("2026-06-27T12:00:00.000Z"),
};

const conditionalError = () => {
  const err = new Error("conditional failed");
  err.name = "ConditionalCheckFailedException";
  return err;
};

const completedItem = (processedEventId: string = event.eventId) => ({
  id: { S: itemId },
  processingStatus: { S: "COMPLETED" },
  processedEventId: { S: processedEventId },
  processedAt: { S: "2026-06-27T12:00:00.000Z" },
});

const pendingItem = () => ({
  id: { S: itemId },
  processingStatus: { S: "PENDING" },
});

const createClient = () => {
  const send = vi.fn();
  const client: DynamoDbCommandClient = { send };
  return { client, send };
};

const processEvent = (client: DynamoDbCommandClient) =>
  processItemCreatedEvent({
    client,
    tableName: "items-table",
    event,
    clock: fixedClock,
  });

describe("processItemCreatedEvent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("atomically writes processing fields for a pending item", async () => {
    const { client, send } = createClient();
    send.mockResolvedValueOnce({});

    const result = await processEvent(client);

    expect(result).toEqual({ status: "processed" });
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(UpdateItemCommand);
    expect(command.input).toMatchObject({
      TableName: "items-table",
      Key: { id: { S: itemId } },
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
        ":processedAt": { S: "2026-06-27T12:00:00.000Z" },
        ":creationMetadata": {
          M: {
            normalizedName: { S: " example 😀 " },
            nameLength: { N: "11" },
          },
        },
      },
    });
    expect(JSON.stringify(command.input)).not.toContain("version");
  });

  it("resolves duplicate delivery as already processed", async () => {
    const { client, send } = createClient();
    send.mockRejectedValueOnce(conditionalError()).mockResolvedValueOnce({
      Item: completedItem(),
    });

    const result = await processEvent(client);

    expect(result).toEqual({ status: "already_processed" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(GetItemCommand);
    expect(send.mock.calls[1]?.[0].input).toMatchObject({
      ConsistentRead: true,
      Key: { id: { S: itemId } },
    });
  });

  it("explains the losing side of a concurrent duplicate as already processed", async () => {
    const { client, send } = createClient();
    send.mockRejectedValueOnce(conditionalError()).mockResolvedValueOnce({
      Item: completedItem(),
    });

    await expect(processEvent(client)).resolves.toEqual({
      status: "already_processed",
    });
  });

  it("does not overwrite a different processed event", async () => {
    const { client, send } = createClient();
    send.mockRejectedValueOnce(conditionalError()).mockResolvedValueOnce({
      Item: completedItem(`item.created.v1:00000000-0000-4000-8000-000000000002`),
    });

    await expect(processEvent(client)).resolves.toEqual({
      status: "permanent_failure",
      reason: "different_event_already_processed",
    });
  });

  it("classifies a missing item as permanent failure", async () => {
    const { client, send } = createClient();
    send.mockRejectedValueOnce(conditionalError()).mockResolvedValueOnce({});

    await expect(processEvent(client)).resolves.toEqual({
      status: "permanent_failure",
      reason: "item_not_found",
    });
  });

  it.each([
    ["missing status", { id: { S: itemId } }],
    ["unsupported status", { id: { S: itemId }, processingStatus: { S: "FAILED" } }],
    [
      "completed without processedEventId",
      { id: { S: itemId }, processingStatus: { S: "COMPLETED" } },
    ],
  ])("classifies invalid state: %s", async (_label, item) => {
    const { client, send } = createClient();
    send.mockRejectedValueOnce(conditionalError()).mockResolvedValueOnce({
      Item: item,
    });

    await expect(processEvent(client)).resolves.toEqual({
      status: "permanent_failure",
      reason: "invalid_processing_state",
    });
  });

  it("retries unresolved pending state after a conditional failure", async () => {
    const { client, send } = createClient();
    send.mockRejectedValueOnce(conditionalError()).mockResolvedValueOnce({
      Item: pendingItem(),
    });

    await expect(processEvent(client)).resolves.toEqual({
      status: "retryable_failure",
      reason: "conditional_state_unresolved",
    });
  });

  it("classifies non-conditional DynamoDB update errors as retryable", async () => {
    const { client, send } = createClient();
    send.mockRejectedValueOnce(new Error("raw dynamodb outage message"));

    await expect(processEvent(client)).resolves.toEqual({
      status: "retryable_failure",
      reason: "dynamodb_error",
    });
  });

  it("classifies follow-up read errors as retryable DynamoDB errors", async () => {
    const { client, send } = createClient();
    send
      .mockRejectedValueOnce(conditionalError())
      .mockRejectedValueOnce(new Error("raw get failure"));

    await expect(processEvent(client)).resolves.toEqual({
      status: "retryable_failure",
      reason: "dynamodb_error",
    });
  });
});

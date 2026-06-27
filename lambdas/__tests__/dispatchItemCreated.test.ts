import type {
  AttributeValue,
  Context,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDispatchItemCreatedHandler,
} from "../dispatchItemCreated.js";
import type { ItemCreatedEventSender } from "../src/dispatch/itemCreatedDispatcher.js";
import { parseItemCreatedEventV1 } from "../src/events/itemCreated.js";

const itemId = "550e8400-e29b-41d4-a716-446655440000";
const createdAt = "2026-06-27T10:15:30.000Z";
const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789012/private-queue";

const newImage = ({
  id = { S: itemId },
  name = { S: "Example item" },
  createdAtValue = { S: createdAt },
}: {
  id?: AttributeValue;
  name?: AttributeValue;
  createdAtValue?: AttributeValue;
} = {}): Record<string, AttributeValue> => ({
  id,
  name,
  createdAt: createdAtValue,
});

const streamRecord = ({
  sequenceNumber,
  eventName = "INSERT",
  eventID = "event-id",
  image = newImage(),
}: {
  sequenceNumber?: string;
  eventName?: DynamoDBRecord["eventName"] | "missing";
  eventID?: string;
  image?: Record<string, AttributeValue> | "missing";
}): DynamoDBRecord => ({
  eventID,
  ...(eventName === "missing" ? {} : { eventName }),
  eventVersion: "1.1",
  eventSource: "aws:dynamodb",
  awsRegion: "us-east-1",
  dynamodb:
    sequenceNumber === undefined
      ? undefined
      : {
          SequenceNumber: sequenceNumber,
          ...(image === "missing" ? {} : { NewImage: image }),
        },
});

const streamEvent = (records: DynamoDBRecord[]): DynamoDBStreamEvent => ({
  Records: records,
});

const createCapturingSender = (options: {
  failSequenceNumbers?: Set<string>;
} = {}) => {
  const sentEvents: unknown[] = [];
  const sender: ItemCreatedEventSender = {
    send: vi.fn(async (event) => {
      if (options.failSequenceNumbers?.has(event.data.itemId)) {
        throw new Error("SQS unavailable");
      }

      sentEvents.push(event);
    }),
  };

  return { sender, sentEvents };
};

const createHandler = (sender: ItemCreatedEventSender) =>
  createDispatchItemCreatedHandler({
    senderFactory: () => sender,
  });

const lambdaContext = (awsRequestId: string): Context =>
  ({
    awsRequestId,
  }) as Context;

const parsedConsoleOutput = (): Array<Record<string, unknown>> => [
  ...vi.mocked(console.log).mock.calls,
  ...vi.mocked(console.error).mock.calls,
].map(([entry]) => JSON.parse(String(entry)) as Record<string, unknown>);

beforeEach(() => {
  process.env.ITEM_PROCESSING_QUEUE_URL = queueUrl;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dispatchItemCreated handler valid records", () => {
  it("sends one ItemCreatedEventV1 for a valid INSERT record", async () => {
    const { sender, sentEvents } = createCapturingSender();
    const handler = createHandler(sender);

    const result = await handler(
      streamEvent([streamRecord({ sequenceNumber: "100000000000000000001" })])
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sentEvents).toHaveLength(1);
    expect(parseItemCreatedEventV1(sentEvents[0]).ok).toBe(true);
    expect(sentEvents[0]).toEqual({
      eventId: `item.created.v1:${itemId}`,
      eventType: "item.created",
      eventVersion: 1,
      occurredAt: createdAt,
      source: "serverless-api",
      data: {
        itemId,
        name: "Example item",
      },
    });
  });

  it("uses only itemId and name in event data", async () => {
    const { sender, sentEvents } = createCapturingSender();
    const handler = createHandler(sender);

    await handler(
      streamEvent([streamRecord({ sequenceNumber: "100000000000000000001" })])
    );

    expect(Object.keys((sentEvents[0] as { data: object }).data)).toEqual([
      "itemId",
      "name",
    ]);
  });
});

describe("dispatchItemCreated determinism", () => {
  it("builds the same event body for repeated handling of the same stream record", async () => {
    const firstSender = createCapturingSender();
    const secondSender = createCapturingSender();
    const record = streamRecord({ sequenceNumber: "100000000000000000001" });

    await createHandler(firstSender.sender)(streamEvent([record]));
    await createHandler(secondSender.sender)(streamEvent([record]));

    expect(secondSender.sentEvents[0]).toEqual(firstSender.sentEvents[0]);
    expect(secondSender.sentEvents[0]).toMatchObject({
      eventId: `item.created.v1:${itemId}`,
      occurredAt: createdAt,
    });
  });
});

describe("dispatchItemCreated batch behavior", () => {
  it("sends every valid INSERT record and returns no failures", async () => {
    const { sender, sentEvents } = createCapturingSender();
    const handler = createHandler(sender);
    const secondItemId = "660e8400-e29b-41d4-a716-446655440000";

    const result = await handler(
      streamEvent([
        streamRecord({ sequenceNumber: "100000000000000000001" }),
        streamRecord({
          sequenceNumber: "100000000000000000002",
          image: newImage({ id: { S: secondItemId }, name: { S: "Second item" } }),
        }),
      ])
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(sentEvents).toHaveLength(2);
  });

  it("returns only the sequence number for a record whose SQS send fails", async () => {
    const failedItemId = "660e8400-e29b-41d4-a716-446655440000";
    const { sender, sentEvents } = createCapturingSender({
      failSequenceNumbers: new Set([failedItemId]),
    });
    const handler = createHandler(sender);

    const result = await handler(
      streamEvent([
        streamRecord({ sequenceNumber: "100000000000000000001" }),
        streamRecord({
          sequenceNumber: "100000000000000000002",
          image: newImage({ id: { S: failedItemId }, name: { S: "Failed item" } }),
        }),
      ])
    );

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: "100000000000000000002" }],
    });
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]).toMatchObject({ data: { itemId } });
    expect(parsedConsoleOutput()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "item_created_dispatch_failed",
          streamSequenceNumber: "100000000000000000002",
          failureCategory: "sqs_send_failed",
        }),
      ])
    );
  });
});

describe("dispatchItemCreated filtering", () => {
  it("skips MODIFY records without sending or failing them", async () => {
    const { sender } = createCapturingSender();
    const handler = createHandler(sender);

    const result = await handler(
      streamEvent([
        streamRecord({
          sequenceNumber: "100000000000000000001",
          eventName: "MODIFY",
        }),
      ])
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("skips REMOVE records without sending or failing them", async () => {
    const { sender } = createCapturingSender();
    const handler = createHandler(sender);

    const result = await handler(
      streamEvent([
        streamRecord({
          sequenceNumber: "100000000000000000001",
          eventName: "REMOVE",
        }),
      ])
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(sender.send).not.toHaveBeenCalled();
  });
});

describe("dispatchItemCreated invalid stream records", () => {
  it("fails a stream record with missing eventName", async () => {
    const { sender } = createCapturingSender();
    const handler = createHandler(sender);

    const result = await handler(
      streamEvent([
        streamRecord({
          sequenceNumber: "100000000000000000001",
          eventName: "missing",
        }),
      ])
    );

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: "100000000000000000001" }],
    });
    expect(sender.send).not.toHaveBeenCalled();
  });

  it.each([
    ["missing NewImage", "missing"],
    ["missing id", { name: { S: "Example item" }, createdAt: { S: createdAt } }],
    ["missing name", { id: { S: itemId }, createdAt: { S: createdAt } }],
    ["missing createdAt", { id: { S: itemId }, name: { S: "Example item" } }],
    [
      "field with wrong AttributeValue type",
      { id: { N: "1" }, name: { S: "Example item" }, createdAt: { S: createdAt } },
    ],
  ] satisfies Array<[string, Record<string, AttributeValue> | "missing"]>)(
    "fails an INSERT record with %s",
    async (_label, image) => {
      const { sender } = createCapturingSender();
      const handler = createHandler(sender);

      const result = await handler(
        streamEvent([
          streamRecord({
            sequenceNumber: "100000000000000000001",
            image,
          }),
        ])
      );

      expect(result).toEqual({
        batchItemFailures: [{ itemIdentifier: "100000000000000000001" }],
      });
      expect(sender.send).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["invalid UUID", newImage({ id: { S: "not-a-uuid" } })],
    ["invalid datetime", newImage({ createdAtValue: { S: "not-a-date" } })],
    ["invalid name", newImage({ name: { S: "   " } })],
  ] satisfies Array<[string, Record<string, AttributeValue>]>)(
    "fails an INSERT record that creates an invalid domain event: %s",
    async (_label, image) => {
      const { sender } = createCapturingSender();
      const handler = createHandler(sender);

      const result = await handler(
        streamEvent([
          streamRecord({
            sequenceNumber: "100000000000000000001",
            image,
          }),
        ])
      );

      expect(result).toEqual({
        batchItemFailures: [{ itemIdentifier: "100000000000000000001" }],
      });
      expect(sender.send).not.toHaveBeenCalled();
    }
  );
});

describe("dispatchItemCreated sequence numbers", () => {
  it("uses SequenceNumber and not eventID for partial batch failures", async () => {
    const { sender } = createCapturingSender({
      failSequenceNumbers: new Set([itemId]),
    });
    const handler = createHandler(sender);

    const result = await handler(
      streamEvent([
        streamRecord({
          sequenceNumber: "100000000000000000001",
          eventID: "event-id-must-not-be-used",
        }),
      ])
    );

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: "100000000000000000001" }],
    });
    expect(JSON.stringify(result)).not.toContain("event-id-must-not-be-used");
    expect(JSON.stringify(result)).not.toContain('""');
  });

  it("throws when a record is missing SequenceNumber", async () => {
    const { sender } = createCapturingSender();
    const handler = createHandler(sender);

    await expect(
      handler(streamEvent([streamRecord({ sequenceNumber: undefined })]))
    ).rejects.toThrow("DynamoDB stream record is missing SequenceNumber");
  });
});

describe("dispatchItemCreated environment", () => {
  it("returns all recognizable INSERT sequence numbers when queue URL is missing", async () => {
    delete process.env.ITEM_PROCESSING_QUEUE_URL;
    const { sender } = createCapturingSender();
    const handler = createHandler(sender);

    const result = await handler(
      streamEvent([
        streamRecord({ sequenceNumber: "100000000000000000001" }),
        streamRecord({ sequenceNumber: "100000000000000000002" }),
      ])
    );

    expect(result).toEqual({
      batchItemFailures: [
        { itemIdentifier: "100000000000000000001" },
        { itemIdentifier: "100000000000000000002" },
      ],
    });
    expect(sender.send).not.toHaveBeenCalled();
    expect(parsedConsoleOutput()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "item_created_dispatch_failed",
          failureCategory: "configuration_error",
        }),
      ])
    );
  });
});

describe("dispatchItemCreated logging safety", () => {
  it("logs useful dispatch metadata without payloads, sensitive values, or queue URLs", async () => {
    const sensitiveValue = "secret-value-must-not-appear";
    const { sender } = createCapturingSender();
    const handler = createHandler(sender);
    const context = lambdaContext("dispatcher-request-1");

    await handler(
      streamEvent([
        streamRecord({
          sequenceNumber: "100000000000000000001",
          image: newImage({
            name: { S: sensitiveValue },
          }),
        }),
      ]),
      context
    );

    const logs = parsedConsoleOutput();
    const serializedLogs = JSON.stringify(logs);

    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "item_created_dispatched",
          eventId: `item.created.v1:${itemId}`,
          itemId,
          eventType: "item.created",
          eventVersion: 1,
          streamSequenceNumber: "100000000000000000001",
          requestId: "dispatcher-request-1",
        }),
      ])
    );
    expect(serializedLogs).not.toContain(sensitiveValue);
    expect(serializedLogs).not.toContain(queueUrl);
    expect(serializedLogs).not.toContain("NewImage");
  });
});

import type { SQSRecord, SQSEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemCreatedEventV1 } from "../src/events/itemCreated.js";
import {
  createProcessItemCreatedHandler,
  type ProcessItemCreatedEvent,
} from "../processItemCreated.js";

const itemId = "550e8400-e29b-41d4-a716-446655440000";

const validEvent = (overrides: Partial<ItemCreatedEventV1> = {}): ItemCreatedEventV1 => ({
  eventId: `item.created.v1:${itemId}`,
  eventType: "item.created",
  eventVersion: 1,
  occurredAt: "2026-06-27T10:00:00.000Z",
  source: "serverless-api",
  data: {
    itemId,
    name: "Example item",
  },
  ...overrides,
});

const sqsRecord = ({
  messageId,
  body = JSON.stringify(validEvent()),
  receiveCount = "1",
}: {
  messageId: string;
  body?: string;
  receiveCount?: string;
}): SQSRecord => ({
  messageId,
  receiptHandle: `receipt-${messageId}`,
  body,
  attributes: {
    ApproximateReceiveCount: receiveCount,
    SentTimestamp: "1760000000000",
    SenderId: "sender",
    ApproximateFirstReceiveTimestamp: "1760000000001",
  },
  messageAttributes: {},
  md5OfBody: "md5",
  eventSource: "aws:sqs",
  eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:item-processing",
  awsRegion: "us-east-1",
});

const sqsEvent = (records: SQSRecord[]): SQSEvent => ({
  Records: records,
});

const loggedJson = (): Array<Record<string, unknown>> =>
  vi.mocked(console.log).mock.calls.map(
    ([entry]) => JSON.parse(String(entry)) as Record<string, unknown>
  );

const errorLoggedJson = (): Array<Record<string, unknown>> =>
  vi.mocked(console.error).mock.calls.map(
    ([entry]) => JSON.parse(String(entry)) as Record<string, unknown>
  );

const warnLoggedJson = loggedJson;

const createHandler = (processor: ProcessItemCreatedEvent) =>
  createProcessItemCreatedHandler({
    processorFactory: () => processor,
  });

beforeEach(() => {
  process.env.TABLE_NAME = "items-table";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TABLE_NAME;
});

describe("processItemCreated handler", () => {
  it("returns no failures for an empty batch", async () => {
    const processor = vi.fn<ProcessItemCreatedEvent>();
    const handler = createHandler(processor);

    await expect(handler(sqsEvent([]))).resolves.toEqual({
      batchItemFailures: [],
    });
    expect(processor).not.toHaveBeenCalled();
  });

  it("processes a single valid message", async () => {
    const processor = vi.fn<ProcessItemCreatedEvent>().mockResolvedValue({
      status: "processed",
    });
    const handler = createHandler(processor);

    await expect(
      handler(sqsEvent([sqsRecord({ messageId: "message-1", receiveCount: "2" })]))
    ).resolves.toEqual({ batchItemFailures: [] });
    expect(processor).toHaveBeenCalledWith(validEvent());
    expect(loggedJson()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "item_processing_completed",
          eventId: `item.created.v1:${itemId}`,
          itemId,
          messageId: "message-1",
          eventType: "item.created",
          eventVersion: 1,
          attempt: 2,
          processingStatus: "COMPLETED",
        }),
      ])
    );
  });

  it("treats an all-success batch as fully acknowledged", async () => {
    const processor = vi.fn<ProcessItemCreatedEvent>().mockResolvedValue({
      status: "processed",
    });
    const handler = createHandler(processor);

    await expect(
      handler(
        sqsEvent([
          sqsRecord({ messageId: "message-1" }),
          sqsRecord({ messageId: "message-2" }),
        ])
      )
    ).resolves.toEqual({ batchItemFailures: [] });
    expect(processor).toHaveBeenCalledTimes(2);
  });

  it("treats already_processed as success", async () => {
    const processor = vi.fn<ProcessItemCreatedEvent>().mockResolvedValue({
      status: "already_processed",
    });
    const handler = createHandler(processor);

    await expect(
      handler(sqsEvent([sqsRecord({ messageId: "message-1" })]))
    ).resolves.toEqual({ batchItemFailures: [] });
    expect(loggedJson()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "duplicate_event_ignored",
          messageId: "message-1",
          processingStatus: "COMPLETED",
        }),
      ])
    );
  });

  it("returns only retryable and permanent processing failures in a mixed batch", async () => {
    const processor = vi
      .fn<ProcessItemCreatedEvent>()
      .mockResolvedValueOnce({ status: "processed" })
      .mockResolvedValueOnce({
        status: "retryable_failure",
        reason: "dynamodb_error",
      })
      .mockResolvedValueOnce({ status: "already_processed" })
      .mockResolvedValueOnce({
        status: "permanent_failure",
        reason: "different_event_already_processed",
      });
    const handler = createHandler(processor);

    await expect(
      handler(
        sqsEvent([
          sqsRecord({ messageId: "message-a" }),
          sqsRecord({ messageId: "message-b" }),
          sqsRecord({ messageId: "message-c" }),
          sqsRecord({ messageId: "message-d" }),
        ])
      )
    ).resolves.toEqual({
      batchItemFailures: [
        { itemIdentifier: "message-b" },
        { itemIdentifier: "message-d" },
      ],
    });
  });

  it("returns invalid JSON to the batch failure list without calling the processor", async () => {
    const processor = vi.fn<ProcessItemCreatedEvent>();
    const handler = createHandler(processor);

    await expect(
      handler(
        sqsEvent([
          sqsRecord({
            messageId: "message-1",
            body: "{invalid json",
          }),
        ])
      )
    ).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: "message-1" }],
    });
    expect(processor).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid event type", { eventType: "item.deleted" }],
    ["unsupported version", { eventVersion: 2 }],
    ["missing event id", { eventId: undefined }],
    ["missing data", { data: undefined }],
  ])("returns invalid schema to the batch failure list: %s", async (_label, patch) => {
    const processor = vi.fn<ProcessItemCreatedEvent>();
    const handler = createHandler(processor);
    const body = JSON.stringify({ ...validEvent(), ...patch });

    await expect(
      handler(sqsEvent([sqsRecord({ messageId: "message-1", body })]))
    ).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: "message-1" }],
    });
    expect(processor).not.toHaveBeenCalled();
  });

  it("throws when a record is missing messageId", async () => {
    const processor = vi.fn<ProcessItemCreatedEvent>();
    const handler = createHandler(processor);

    await expect(
      handler(sqsEvent([sqsRecord({ messageId: "" })]))
    ).rejects.toThrow("SQS record is missing messageId");
  });

  it("returns all identifiable messages as failures when TABLE_NAME is missing", async () => {
    delete process.env.TABLE_NAME;
    const processor = vi.fn<ProcessItemCreatedEvent>();
    const factory = vi.fn(() => processor);
    const handler = createProcessItemCreatedHandler({ processorFactory: factory });

    await expect(
      handler(
        sqsEvent([
          sqsRecord({ messageId: "message-1" }),
          sqsRecord({ messageId: "message-2" }),
        ])
      )
    ).resolves.toEqual({
      batchItemFailures: [
        { itemIdentifier: "message-1" },
        { itemIdentifier: "message-2" },
      ],
    });
    expect(factory).not.toHaveBeenCalled();
    expect(processor).not.toHaveBeenCalled();
    expect(JSON.stringify(errorLoggedJson())).not.toContain("TABLE_NAME");
  });

  it("continues processing other messages when one service call throws", async () => {
    const processor = vi
      .fn<ProcessItemCreatedEvent>()
      .mockRejectedValueOnce(new Error("unexpected service failure"))
      .mockResolvedValueOnce({ status: "processed" });
    const handler = createHandler(processor);

    await expect(
      handler(
        sqsEvent([
          sqsRecord({ messageId: "message-1" }),
          sqsRecord({ messageId: "message-2" }),
        ])
      )
    ).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: "message-1" }],
    });
    expect(processor).toHaveBeenCalledTimes(2);
  });

  it("does not log full message bodies, sensitive values, table names, or queue URLs", async () => {
    const sensitive = "SECRET-CUSTOMER-NAME";
    const processor = vi.fn<ProcessItemCreatedEvent>().mockResolvedValue({
      status: "permanent_failure",
      reason: "invalid_processing_state",
    });
    const handler = createHandler(processor);

    await handler(
      sqsEvent([
        sqsRecord({
          messageId: "message-1",
          body: JSON.stringify(
            validEvent({
              data: {
                itemId,
                name: sensitive,
              },
            })
          ),
        }),
      ])
    );

    const logs = JSON.stringify([...warnLoggedJson(), ...errorLoggedJson()]);
    expect(logs).not.toContain(sensitive);
    expect(logs).not.toContain("items-table");
    expect(logs).not.toContain("https://sqs");
    expect(logs).not.toContain("MessageBody");
    expect(logs).not.toContain("body");
  });
});

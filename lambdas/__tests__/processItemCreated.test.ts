import type { SQSRecord, SQSEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sqsRecord = ({
  messageId,
  body = "{}",
}: {
  messageId: string;
  body?: string;
}): SQSRecord => ({
  messageId,
  receiptHandle: `receipt-${messageId}`,
  body,
  attributes: {
    ApproximateReceiveCount: "1",
    SentTimestamp: "1760000000000",
    SenderId: "sender",
    ApproximateFirstReceiveTimestamp: "1760000000001",
  },
  messageAttributes: {},
  md5OfBody: "md5",
  eventSource: "aws:sqs",
  eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:queue",
  awsRegion: "us-east-1",
});

const sqsEvent = (records: SQSRecord[]): SQSEvent => ({
  Records: records,
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("processItemCreated placeholder", () => {
  it("returns no failures for an empty batch", async () => {
    const { handler } = await import("../processItemCreated.js");

    const result = await handler(sqsEvent([]));

    expect(result).toEqual({ batchItemFailures: [] });
  });

  it("returns one messageId as a batch failure", async () => {
    const { handler } = await import("../processItemCreated.js");

    const result = await handler(sqsEvent([sqsRecord({ messageId: "message-1" })]));

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: "message-1" }],
    });
  });

  it("returns every messageId as a batch failure", async () => {
    const { handler } = await import("../processItemCreated.js");

    const result = await handler(
      sqsEvent([
        sqsRecord({ messageId: "message-1" }),
        sqsRecord({ messageId: "message-2" }),
      ])
    );

    expect(result).toEqual({
      batchItemFailures: [
        { itemIdentifier: "message-1" },
        { itemIdentifier: "message-2" },
      ],
    });
  });

  it("does not parse the message body", async () => {
    const { handler } = await import("../processItemCreated.js");

    const result = await handler(
      sqsEvent([
        sqsRecord({
          messageId: "message-1",
          body: "not-json",
        }),
      ])
    );

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: "message-1" }],
    });
  });

  it("returns failure for invalid JSON instead of throwing a parse error", async () => {
    const { handler } = await import("../processItemCreated.js");

    await expect(
      handler(
        sqsEvent([
          sqsRecord({
            messageId: "message-1",
            body: "{",
          }),
        ])
      )
    ).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: "message-1" }],
    });
  });
});

import type { DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const streamRecord = ({
  sequenceNumber,
  eventID = "event-id",
}: {
  sequenceNumber?: string;
  eventID?: string;
}): DynamoDBRecord => ({
  eventID,
  eventName: "INSERT",
  eventVersion: "1.1",
  eventSource: "aws:dynamodb",
  awsRegion: "us-east-1",
  dynamodb:
    sequenceNumber === undefined
      ? undefined
      : {
          SequenceNumber: sequenceNumber,
        },
});

const streamEvent = (records: DynamoDBRecord[]): DynamoDBStreamEvent => ({
  Records: records,
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dispatchItemCreated placeholder", () => {
  it("returns no failures for an empty batch", async () => {
    const { handler } = await import("../dispatchItemCreated.js");

    const result = await handler(streamEvent([]));

    expect(result).toEqual({ batchItemFailures: [] });
  });

  it("returns the stream sequence number for one record", async () => {
    const { handler } = await import("../dispatchItemCreated.js");

    const result = await handler(
      streamEvent([streamRecord({ sequenceNumber: "100000000000000000001" })])
    );

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: "100000000000000000001" }],
    });
  });

  it("returns every stream sequence number for multiple records", async () => {
    const { handler } = await import("../dispatchItemCreated.js");

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
  });

  it("does not use eventID as the partial batch failure identifier", async () => {
    const { handler } = await import("../dispatchItemCreated.js");

    const result = await handler(
      streamEvent([
        streamRecord({
          sequenceNumber: "100000000000000000001",
          eventID: "event-id-must-not-be-used",
        }),
      ])
    );

    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: "100000000000000000001" },
    ]);
    expect(JSON.stringify(result)).not.toContain("event-id-must-not-be-used");
  });

  it("does not depend on a complete DynamoDB payload", async () => {
    const { handler } = await import("../dispatchItemCreated.js");

    const result = await handler(
      streamEvent([streamRecord({ sequenceNumber: undefined })])
    );

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: "" }],
    });
  });
});

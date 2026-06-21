import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  completeIdempotentCreate,
  createTransactionClientRequestToken,
  inspectIdempotencyRecord,
  releaseIdempotencyReservation,
  reserveIdempotencyRecord,
} from "../src/idempotency.js";
import { createItemRequestFingerprint } from "../src/requestFingerprint.js";

const TEST_KEY = "create-key-123";
const TEST_FINGERPRINT = createItemRequestFingerprint({ name: "Example item" });
const TEST_ITEM_ID = "00000000-0000-4000-8000-000000000001";
const OLD_ITEM_ID = "00000000-0000-4000-8000-000000000099";
const NOW = new Date("2026-06-21T12:00:00.000Z");
const NOW_EPOCH_SECONDS = Math.floor(NOW.getTime() / 1000);

const conditionalError = (): Error => {
  const error = new Error("conditional failed");
  error.name = "ConditionalCheckFailedException";
  return error;
};

const mockClient = (send = vi.fn()): DynamoDBClient =>
  ({ send } as unknown as DynamoDBClient);

const commandInput = (
  send: ReturnType<typeof vi.fn>,
  callIndex: number
): Record<string, unknown> =>
  (send.mock.calls[callIndex][0] as { input: Record<string, unknown> }).input;

describe("idempotency persistence", () => {
  it("stores a stable item ID on first reservation", async () => {
    const send = vi.fn().mockResolvedValueOnce({});

    const result = await reserveIdempotencyRecord({
      client: mockClient(send),
      tableName: "idempotency-table",
      key: TEST_KEY,
      requestFingerprint: TEST_FINGERPRINT,
      keyCorrelation: "key-hash",
      itemId: TEST_ITEM_ID,
      now: NOW,
    });

    expect(result).toEqual({
      status: "reserved",
      itemId: TEST_ITEM_ID,
      recovered: false,
    });
    expect(commandInput(send, 0)).toEqual(
      expect.objectContaining({
        Item: expect.objectContaining({
          itemId: { S: TEST_ITEM_ID },
          inProgressExpiresAt: { N: String(NOW_EPOCH_SECONDS + 600) },
          expiresAt: { N: String(NOW_EPOCH_SECONDS + 600) },
        }),
        ConditionExpression: "attribute_not_exists(#key)",
      })
    );
  });

  it("uses strongly consistent reads when inspecting an existing reservation", async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Item: {
        requestFingerprint: { S: TEST_FINGERPRINT },
        status: { S: "IN_PROGRESS" },
        itemId: { S: TEST_ITEM_ID },
      },
    });

    await inspectIdempotencyRecord({
      client: mockClient(send),
      tableName: "idempotency-table",
      key: TEST_KEY,
      requestFingerprint: TEST_FINGERPRINT,
    });

    expect(commandInput(send, 0)).toEqual(
      expect.objectContaining({
        ConsistentRead: true,
      })
    );
  });

  it("recovers an expired IN_PROGRESS reservation without changing the original item ID", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(conditionalError())
      .mockResolvedValueOnce({
        Item: {
          requestFingerprint: { S: TEST_FINGERPRINT },
          status: { S: "IN_PROGRESS" },
          itemId: { S: OLD_ITEM_ID },
          inProgressExpiresAt: { N: String(NOW_EPOCH_SECONDS - 1) },
        },
      })
      .mockResolvedValueOnce({});

    const result = await reserveIdempotencyRecord({
      client: mockClient(send),
      tableName: "idempotency-table",
      key: TEST_KEY,
      requestFingerprint: TEST_FINGERPRINT,
      keyCorrelation: "key-hash",
      itemId: TEST_ITEM_ID,
      now: NOW,
    });

    expect(result).toEqual({
      status: "reserved",
      itemId: OLD_ITEM_ID,
      recovered: true,
    });
    expect(commandInput(send, 1)).toEqual(
      expect.objectContaining({
        ConsistentRead: true,
      })
    );
    expect(commandInput(send, 2)).toEqual(
      expect.objectContaining({
        UpdateExpression: expect.stringContaining("#inProgressExpiresAt"),
        ConditionExpression:
          "#status = :inProgress AND #requestFingerprint = :requestFingerprint AND #inProgressExpiresAt <= :nowEpoch",
      })
    );
  });

  it("does not recover an unexpired IN_PROGRESS reservation", async () => {
    const send = vi.fn().mockRejectedValueOnce(conditionalError()).mockResolvedValueOnce({
      Item: {
        requestFingerprint: { S: TEST_FINGERPRINT },
        status: { S: "IN_PROGRESS" },
        itemId: { S: OLD_ITEM_ID },
        inProgressExpiresAt: { N: String(NOW_EPOCH_SECONDS + 1) },
      },
    });

    const result = await reserveIdempotencyRecord({
      client: mockClient(send),
      tableName: "idempotency-table",
      key: TEST_KEY,
      requestFingerprint: TEST_FINGERPRINT,
      keyCorrelation: "key-hash",
      itemId: TEST_ITEM_ID,
      now: NOW,
    });

    expect(result).toEqual({ status: "in_progress" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("treats an expired IN_PROGRESS reservation with a different payload as conflict", async () => {
    const send = vi.fn().mockRejectedValueOnce(conditionalError()).mockResolvedValueOnce({
      Item: {
        requestFingerprint: { S: "different-fingerprint" },
        status: { S: "IN_PROGRESS" },
        itemId: { S: OLD_ITEM_ID },
        inProgressExpiresAt: { N: String(NOW_EPOCH_SECONDS - 1) },
      },
    });

    const result = await reserveIdempotencyRecord({
      client: mockClient(send),
      tableName: "idempotency-table",
      key: TEST_KEY,
      requestFingerprint: TEST_FINGERPRINT,
      keyCorrelation: "key-hash",
      itemId: TEST_ITEM_ID,
      now: NOW,
    });

    expect(result).toEqual({ status: "conflict" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("allows only one concurrent expired reservation takeover to win", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(conditionalError())
      .mockResolvedValueOnce({
        Item: {
          requestFingerprint: { S: TEST_FINGERPRINT },
          status: { S: "IN_PROGRESS" },
          itemId: { S: OLD_ITEM_ID },
          inProgressExpiresAt: { N: String(NOW_EPOCH_SECONDS - 1) },
        },
      })
      .mockRejectedValueOnce(conditionalError());

    const result = await reserveIdempotencyRecord({
      client: mockClient(send),
      tableName: "idempotency-table",
      key: TEST_KEY,
      requestFingerprint: TEST_FINGERPRINT,
      keyCorrelation: "key-hash",
      itemId: TEST_ITEM_ID,
      now: NOW,
    });

    expect(result).toEqual({ status: "in_progress" });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("rejects malformed completed replay records", async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Item: {
        requestFingerprint: { S: TEST_FINGERPRINT },
        status: { S: "COMPLETED" },
        responseStatusCode: { N: "201" },
        responseBody: { S: JSON.stringify({ message: "Item created" }) },
      },
    });

    const result = await inspectIdempotencyRecord({
      client: mockClient(send),
      tableName: "idempotency-table",
      key: TEST_KEY,
      requestFingerprint: TEST_FINGERPRINT,
    });

    expect(result).toEqual({ status: "invalid_record" });
  });

  it("sets a stable DynamoDB transaction client request token", async () => {
    const token = createTransactionClientRequestToken({
      key: TEST_KEY,
      requestFingerprint: TEST_FINGERPRINT,
      itemId: TEST_ITEM_ID,
    });
    const sameToken = createTransactionClientRequestToken({
      key: TEST_KEY,
      requestFingerprint: TEST_FINGERPRINT,
      itemId: TEST_ITEM_ID,
    });
    const differentToken = createTransactionClientRequestToken({
      key: TEST_KEY,
      requestFingerprint: TEST_FINGERPRINT,
      itemId: OLD_ITEM_ID,
    });

    expect(token).toBe(sameToken);
    expect(token).toHaveLength(36);
    expect(token).not.toBe(differentToken);
  });

  it("passes the transaction client request token to TransactWriteItems", async () => {
    const send = vi.fn().mockResolvedValueOnce({});

    await completeIdempotentCreate({
      client: mockClient(send),
      idempotencyTableName: "idempotency-table",
      itemsTableName: "items-table",
      key: TEST_KEY,
      requestFingerprint: TEST_FINGERPRINT,
      item: {
        id: { S: TEST_ITEM_ID },
        name: { S: "Example item" },
        createdAt: { S: NOW.toISOString() },
        version: { N: "1" },
      },
      response: {
        message: "Item created",
        id: TEST_ITEM_ID,
        version: 1,
      },
      now: NOW,
    });

    expect(commandInput(send, 0)).toEqual(
      expect.objectContaining({
        ClientRequestToken: createTransactionClientRequestToken({
          key: TEST_KEY,
          requestFingerprint: TEST_FINGERPRINT,
          itemId: TEST_ITEM_ID,
        }),
      })
    );
  });

  it("conditions cleanup on the reservation fingerprint and item ID", async () => {
    const send = vi.fn().mockResolvedValueOnce({});

    await releaseIdempotencyReservation({
      client: mockClient(send),
      tableName: "idempotency-table",
      key: TEST_KEY,
      requestFingerprint: TEST_FINGERPRINT,
      itemId: TEST_ITEM_ID,
    });

    expect(commandInput(send, 0)).toEqual(
      expect.objectContaining({
        ConditionExpression:
          "#status = :inProgress AND #requestFingerprint = :requestFingerprint AND #itemId = :itemId",
        ExpressionAttributeValues: expect.objectContaining({
          ":itemId": { S: TEST_ITEM_ID },
        }),
      })
    );
  });
});

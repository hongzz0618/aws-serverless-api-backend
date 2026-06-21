import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import type { CreateItemResponse } from "./types/api.js";
import type { StoredItem } from "./types/item.js";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_:\-.]+$/;
const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

const STATUS_IN_PROGRESS = "IN_PROGRESS";
const STATUS_COMPLETED = "COMPLETED";

const IN_PROGRESS_TTL_SECONDS = 10 * 60;
const COMPLETED_TTL_SECONDS = 24 * 60 * 60;

type IdempotencyRecord = Record<string, AttributeValue>;

export type IdempotencyReservationResult =
  | { status: "reserved" }
  | { status: "replayed"; response: CreateItemResponse }
  | { status: "conflict" }
  | { status: "in_progress" }
  | { status: "invalid_record" };

export const validateIdempotencyKey = (
  value: string | undefined
): { ok: true; value: string } | { ok: false; error: string } => {
  const key = value?.trim();

  if (!key) {
    return { ok: false, error: "Idempotency-Key header is required" };
  }

  if (
    key.length < IDEMPOTENCY_KEY_MIN_LENGTH ||
    key.length > IDEMPOTENCY_KEY_MAX_LENGTH ||
    !IDEMPOTENCY_KEY_PATTERN.test(key)
  ) {
    return { ok: false, error: "Idempotency-Key header is invalid" };
  }

  return { ok: true, value: key };
};

const epochSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);

const parseCompletedResponse = (
  record: IdempotencyRecord
): CreateItemResponse | undefined => {
  const responseBody = record.responseBody?.S;

  if (!responseBody) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(responseBody) as Partial<CreateItemResponse>;

    if (
      parsed.message === "Item created" &&
      typeof parsed.id === "string" &&
      parsed.version === 1
    ) {
      return {
        message: "Item created",
        id: parsed.id,
        version: 1,
      };
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const isConditionalCheckFailed = (err: unknown): boolean =>
  err instanceof Error && err.name === "ConditionalCheckFailedException";

export const isItemTransactionConflict = (err: unknown): boolean => {
  if (!(err instanceof Error) || err.name !== "TransactionCanceledException") {
    return false;
  }

  const reasons = (err as { CancellationReasons?: Array<{ Code?: string }> })
    .CancellationReasons;

  return reasons?.[0]?.Code === "ConditionalCheckFailed";
};

export const reserveIdempotencyRecord = async ({
  client,
  tableName,
  key,
  requestFingerprint,
  keyCorrelation,
  now = new Date(),
}: {
  client: DynamoDBClient;
  tableName: string;
  key: string;
  requestFingerprint: string;
  keyCorrelation: string;
  now?: Date;
}): Promise<IdempotencyReservationResult> => {
  const nowIso = now.toISOString();
  const nowEpoch = epochSeconds(now);
  const inProgressExpiresAt = nowEpoch + IN_PROGRESS_TTL_SECONDS;

  try {
    await client.send(
      new PutItemCommand({
        TableName: tableName,
        Item: {
          idempotencyKey: { S: key },
          requestFingerprint: { S: requestFingerprint },
          keyCorrelation: { S: keyCorrelation },
          status: { S: STATUS_IN_PROGRESS },
          createdAt: { S: nowIso },
          updatedAt: { S: nowIso },
          inProgressExpiresAt: { N: String(inProgressExpiresAt) },
          expiresAt: { N: String(inProgressExpiresAt) },
        },
        ConditionExpression:
          "attribute_not_exists(#key) OR (#status = :inProgress AND #inProgressExpiresAt < :now)",
        ExpressionAttributeNames: {
          "#key": "idempotencyKey",
          "#status": "status",
          "#inProgressExpiresAt": "inProgressExpiresAt",
        },
        ExpressionAttributeValues: {
          ":inProgress": { S: STATUS_IN_PROGRESS },
          ":now": { N: String(nowEpoch) },
        },
      })
    );

    return { status: "reserved" };
  } catch (err) {
    if (!isConditionalCheckFailed(err)) {
      throw err;
    }
  }

  const existing = await client.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { idempotencyKey: { S: key } },
      ConsistentRead: true,
    })
  );

  if (!existing.Item) {
    return { status: "invalid_record" };
  }

  if (existing.Item.requestFingerprint?.S !== requestFingerprint) {
    return { status: "conflict" };
  }

  if (existing.Item.status?.S === STATUS_COMPLETED) {
    const response = parseCompletedResponse(existing.Item);

    return response
      ? { status: "replayed", response }
      : { status: "invalid_record" };
  }

  if (existing.Item.status?.S === STATUS_IN_PROGRESS) {
    return { status: "in_progress" };
  }

  return { status: "invalid_record" };
};

export const completeIdempotentCreate = async ({
  client,
  idempotencyTableName,
  itemsTableName,
  key,
  requestFingerprint,
  item,
  response,
  now = new Date(),
}: {
  client: DynamoDBClient;
  idempotencyTableName: string;
  itemsTableName: string;
  key: string;
  requestFingerprint: string;
  item: StoredItem;
  response: CreateItemResponse;
  now?: Date;
}): Promise<void> => {
  const nowIso = now.toISOString();
  const completedExpiresAt = epochSeconds(now) + COMPLETED_TTL_SECONDS;

  await client.send(
    new TransactWriteItemsCommand({
      TransactItems: [
        {
          Put: {
            TableName: itemsTableName,
            Item: item,
            ConditionExpression: "attribute_not_exists(#id)",
            ExpressionAttributeNames: {
              "#id": "id",
            },
          },
        },
        {
          Update: {
            TableName: idempotencyTableName,
            Key: { idempotencyKey: { S: key } },
            UpdateExpression:
              "SET #status = :completed, #itemId = :itemId, #responseStatusCode = :responseStatusCode, #responseBody = :responseBody, #updatedAt = :now, #completedAt = :now, #expiresAt = :expiresAt REMOVE #inProgressExpiresAt",
            ConditionExpression:
              "#status = :inProgress AND #requestFingerprint = :requestFingerprint",
            ExpressionAttributeNames: {
              "#status": "status",
              "#itemId": "itemId",
              "#responseStatusCode": "responseStatusCode",
              "#responseBody": "responseBody",
              "#updatedAt": "updatedAt",
              "#completedAt": "completedAt",
              "#expiresAt": "expiresAt",
              "#inProgressExpiresAt": "inProgressExpiresAt",
              "#requestFingerprint": "requestFingerprint",
            },
            ExpressionAttributeValues: {
              ":completed": { S: STATUS_COMPLETED },
              ":inProgress": { S: STATUS_IN_PROGRESS },
              ":itemId": { S: response.id },
              ":responseStatusCode": { N: "201" },
              ":responseBody": { S: JSON.stringify(response) },
              ":now": { S: nowIso },
              ":expiresAt": { N: String(completedExpiresAt) },
              ":requestFingerprint": { S: requestFingerprint },
            },
          },
        },
      ],
    })
  );
};

export const releaseIdempotencyReservation = async ({
  client,
  tableName,
  key,
  requestFingerprint,
}: {
  client: DynamoDBClient;
  tableName: string;
  key: string;
  requestFingerprint: string;
}): Promise<void> => {
  await client.send(
    new DeleteItemCommand({
      TableName: tableName,
      Key: { idempotencyKey: { S: key } },
      ConditionExpression:
        "#status = :inProgress AND #requestFingerprint = :requestFingerprint",
      ExpressionAttributeNames: {
        "#status": "status",
        "#requestFingerprint": "requestFingerprint",
      },
      ExpressionAttributeValues: {
        ":inProgress": { S: STATUS_IN_PROGRESS },
        ":requestFingerprint": { S: requestFingerprint },
      },
    })
  );
};

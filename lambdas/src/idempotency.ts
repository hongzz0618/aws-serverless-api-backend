import {
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import type { CreateItemResponse } from "./types/api.js";
import type { StoredItem } from "./types/item.js";
import { sha256Hex } from "./requestFingerprint.js";

export const IDEMPOTENCY_KEY_OPENAPI_PATTERN = "^[A-Za-z0-9._:-]{8,128}$";
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_:\-.]+$/;
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

const STATUS_IN_PROGRESS = "IN_PROGRESS";
const STATUS_COMPLETED = "COMPLETED";

const IN_PROGRESS_TTL_SECONDS = 10 * 60;
const COMPLETED_TTL_SECONDS = 24 * 60 * 60;

type IdempotencyRecord = Record<string, AttributeValue>;

export type IdempotencyReservationResult =
  | { status: "reserved"; itemId: string; recovered: boolean }
  | { status: "replayed"; response: CreateItemResponse }
  | { status: "conflict" }
  | { status: "in_progress" }
  | { status: "invalid_record" };

export type IdempotencyInspectionResult =
  | { status: "completed"; response: CreateItemResponse }
  | { status: "in_progress" }
  | { status: "conflict" }
  | { status: "invalid_record" }
  | { status: "not_found" };

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
  const responseStatusCode = record.responseStatusCode?.N;
  const itemId = record.itemId?.S;

  if (!responseBody || responseStatusCode !== "201" || !itemId) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(responseBody) as Partial<CreateItemResponse>;

    if (
      parsed.message === "Item created" &&
      typeof parsed.id === "string" &&
      parsed.id === itemId &&
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

const parseNumberAttribute = (value: AttributeValue | undefined): number | undefined => {
  if (!value?.N) {
    return undefined;
  }

  const parsed = Number(value.N);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const getStoredItemId = (record: IdempotencyRecord): string | undefined =>
  record.itemId?.S;

const inspectRecord = (
  record: IdempotencyRecord,
  requestFingerprint: string
): IdempotencyInspectionResult => {
  if (record.requestFingerprint?.S !== requestFingerprint) {
    return { status: "conflict" };
  }

  if (record.status?.S === STATUS_COMPLETED) {
    const response = parseCompletedResponse(record);
    return response ? { status: "completed", response } : { status: "invalid_record" };
  }

  if (record.status?.S === STATUS_IN_PROGRESS) {
    return getStoredItemId(record)
      ? { status: "in_progress" }
      : { status: "invalid_record" };
  }

  return { status: "invalid_record" };
};

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
  itemId,
  now = new Date(),
}: {
  client: DynamoDBClient;
  tableName: string;
  key: string;
  requestFingerprint: string;
  keyCorrelation: string;
  itemId: string;
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
          itemId: { S: itemId },
          status: { S: STATUS_IN_PROGRESS },
          createdAt: { S: nowIso },
          updatedAt: { S: nowIso },
          inProgressExpiresAt: { N: String(inProgressExpiresAt) },
          expiresAt: { N: String(inProgressExpiresAt) },
        },
        ConditionExpression: "attribute_not_exists(#key)",
        ExpressionAttributeNames: {
          "#key": "idempotencyKey",
        },
      })
    );

    return { status: "reserved", itemId, recovered: false };
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

  const inspected = inspectRecord(existing.Item, requestFingerprint);

  if (inspected.status === "completed") {
    return { status: "replayed", response: inspected.response };
  }

  if (inspected.status === "conflict" || inspected.status === "invalid_record") {
    return inspected;
  }

  if (inspected.status !== "in_progress") {
    return { status: "invalid_record" };
  }

  const existingItemId = getStoredItemId(existing.Item);
  const existingExpiresAt = parseNumberAttribute(existing.Item.inProgressExpiresAt);

  if (!existingItemId || existingExpiresAt === undefined) {
    return { status: "invalid_record" };
  }

  if (existingExpiresAt > nowEpoch) {
    return { status: "in_progress" };
  }

  try {
    await client.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { idempotencyKey: { S: key } },
        UpdateExpression:
          "SET #updatedAt = :nowIso, #inProgressExpiresAt = :inProgressExpiresAt, #expiresAt = :inProgressExpiresAt",
        ConditionExpression:
          "#status = :inProgress AND #requestFingerprint = :requestFingerprint AND #inProgressExpiresAt <= :nowEpoch",
        ExpressionAttributeNames: {
          "#status": "status",
          "#requestFingerprint": "requestFingerprint",
          "#inProgressExpiresAt": "inProgressExpiresAt",
          "#updatedAt": "updatedAt",
          "#expiresAt": "expiresAt",
        },
        ExpressionAttributeValues: {
          ":inProgress": { S: STATUS_IN_PROGRESS },
          ":requestFingerprint": { S: requestFingerprint },
          ":nowEpoch": { N: String(nowEpoch) },
          ":nowIso": { S: nowIso },
          ":inProgressExpiresAt": { N: String(inProgressExpiresAt) },
        },
      })
    );

    return { status: "reserved", itemId: existingItemId, recovered: true };
  } catch (err) {
    if (!isConditionalCheckFailed(err)) {
      throw err;
    }

    return { status: "in_progress" };
  }
};

export const inspectIdempotencyRecord = async ({
  client,
  tableName,
  key,
  requestFingerprint,
}: {
  client: DynamoDBClient;
  tableName: string;
  key: string;
  requestFingerprint: string;
}): Promise<IdempotencyInspectionResult> => {
  const existing = await client.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { idempotencyKey: { S: key } },
      ConsistentRead: true,
    })
  );

  return existing.Item
    ? inspectRecord(existing.Item, requestFingerprint)
    : { status: "not_found" };
};

export const createTransactionClientRequestToken = ({
  key,
  requestFingerprint,
  itemId,
}: {
  key: string;
  requestFingerprint: string;
  itemId: string;
}): string => sha256Hex(JSON.stringify({ key, requestFingerprint, itemId })).slice(0, 36);

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
      ClientRequestToken: createTransactionClientRequestToken({
        key,
        requestFingerprint,
        itemId: response.id,
      }),
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
  itemId,
}: {
  client: DynamoDBClient;
  tableName: string;
  key: string;
  requestFingerprint: string;
  itemId: string;
}): Promise<void> => {
  await client.send(
    new DeleteItemCommand({
      TableName: tableName,
      Key: { idempotencyKey: { S: key } },
      ConditionExpression:
        "#status = :inProgress AND #requestFingerprint = :requestFingerprint AND #itemId = :itemId",
      ExpressionAttributeNames: {
        "#status": "status",
        "#requestFingerprint": "requestFingerprint",
        "#itemId": "itemId",
      },
      ExpressionAttributeValues: {
        ":inProgress": { S: STATUS_IN_PROGRESS },
        ":requestFingerprint": { S: requestFingerprint },
        ":itemId": { S: itemId },
      },
    })
  );
};

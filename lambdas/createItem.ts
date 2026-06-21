import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { v4 as uuidv4 } from "uuid";
import type { CreateItemResponse } from "./src/types/api.js";
import type { StoredItem } from "./src/types/item.js";
import {
  completeIdempotentCreate,
  inspectIdempotencyRecord,
  isItemTransactionConflict,
  releaseIdempotencyReservation,
  reserveIdempotencyRecord,
  validateIdempotencyKey,
} from "./src/idempotency.js";
import {
  createItemRequestFingerprint,
  idempotencyKeyCorrelation,
} from "./src/requestFingerprint.js";
import { getRequiredEnv } from "./src/utils/env.js";
import { getHeaderValue } from "./src/utils/headers.js";
import { errorResponse, jsonResponse } from "./src/utils/http.js";
import { createLogger } from "./src/utils/logger.js";
import { validateCreateItemBody } from "./src/validation/item.js";

const client = new DynamoDBClient();
const route = "POST /items";
const operation = "createItem";
const idempotencyKeyHeader = "Idempotency-Key";

export const handler = async (
  event: APIGatewayProxyEvent,
  context?: Context
): Promise<APIGatewayProxyResult> => {
  const logger = createLogger({
    service: "items-api",
    context,
    route,
    operation,
  });

  logger.info("Request received");

  const idempotencyKeyValidation = validateIdempotencyKey(
    getHeaderValue(event.headers, idempotencyKeyHeader)
  );

  if (!idempotencyKeyValidation.ok) {
    logger.warn("Validation failed", {
      statusCode: 400,
      validationError: idempotencyKeyValidation.error,
    });
    return errorResponse(400, idempotencyKeyValidation.error);
  }

  const validation = validateCreateItemBody(event.body);

  if (!validation.ok) {
    logger.warn("Validation failed", {
      statusCode: 400,
      validationError: validation.error,
    });
    return errorResponse(400, validation.error);
  }

  try {
    const tableName = getRequiredEnv("TABLE_NAME");
    const idempotencyTableName = getRequiredEnv("IDEMPOTENCY_TABLE_NAME");
    const idempotencyKey = idempotencyKeyValidation.value;
    const requestFingerprint = createItemRequestFingerprint(validation.value);
    const keyCorrelation = idempotencyKeyCorrelation(idempotencyKey);
    const candidateItemId = uuidv4();
    const reservation = await reserveIdempotencyRecord({
      client,
      tableName: idempotencyTableName,
      key: idempotencyKey,
      requestFingerprint,
      keyCorrelation,
      itemId: candidateItemId,
    });

    if (reservation.status === "replayed") {
      logger.info("Idempotent create replayed", {
        event: "idempotency_replayed",
        statusCode: 201,
        itemId: reservation.response.id,
        idempotencyKeyHash: keyCorrelation,
      });
      return jsonResponse<CreateItemResponse>(201, reservation.response, {
        "Idempotency-Replayed": "true",
      });
    }

    if (reservation.status === "conflict") {
      logger.warn("Idempotency key conflict", {
        event: "idempotency_conflict",
        statusCode: 409,
        idempotencyKeyHash: keyCorrelation,
      });
      return errorResponse(
        409,
        "Idempotency key was already used with a different request"
      );
    }

    if (reservation.status === "in_progress") {
      logger.warn("Idempotent create already in progress", {
        event: "idempotency_in_progress",
        statusCode: 409,
        idempotencyKeyHash: keyCorrelation,
      });
      return errorResponse(
        409,
        "Request with this idempotency key is already in progress"
      );
    }

    if (reservation.status === "invalid_record") {
      logger.error(
        "Idempotency record has invalid shape",
        new Error("Invalid idempotency record"),
        {
          event: "idempotency_failed",
          statusCode: 500,
          idempotencyKeyHash: keyCorrelation,
        }
      );
      return errorResponse(500, "Failed to create item");
    }

    logger.info("Idempotency key reserved", {
      event: "idempotency_reserved",
      idempotencyKeyHash: keyCorrelation,
      recovered: reservation.recovered,
    });

    const id = reservation.itemId;
    const item: StoredItem = {
      id: { S: id },
      name: { S: validation.value.name },
      createdAt: { S: new Date().toISOString() },
      version: { N: "1" },
    };
    const response: CreateItemResponse = {
      message: "Item created",
      id,
      version: 1,
    };

    try {
      await completeIdempotentCreate({
        client,
        idempotencyTableName,
        itemsTableName: tableName,
        key: idempotencyKey,
        requestFingerprint,
        item,
        response,
      });
    } catch (err) {
      if (isItemTransactionConflict(err)) {
        await releaseIdempotencyReservation({
          client,
          tableName: idempotencyTableName,
          key: idempotencyKey,
          requestFingerprint,
          itemId: id,
        }).catch((cleanupErr: unknown) => {
          logger.error("Failed to release idempotency reservation", cleanupErr, {
            event: "idempotency_failed",
            statusCode: 500,
            idempotencyKeyHash: keyCorrelation,
          });
        });

        logger.warn("Item already exists", {
          statusCode: 409,
          idempotencyKeyHash: keyCorrelation,
        });
        return errorResponse(409, "Item already exists");
      }

      const inspection = await inspectIdempotencyRecord({
        client,
        tableName: idempotencyTableName,
        key: idempotencyKey,
        requestFingerprint,
      });

      if (inspection.status === "completed") {
        logger.info("Idempotent create completed after retry ambiguity", {
          event: "idempotency_replayed",
          statusCode: 201,
          itemId: inspection.response.id,
          idempotencyKeyHash: keyCorrelation,
        });
        return jsonResponse<CreateItemResponse>(201, inspection.response, {
          "Idempotency-Replayed": "true",
        });
      }

      logger.error("Idempotent create completion outcome unresolved", err, {
        event: "idempotency_failed",
        statusCode: 500,
        idempotencyKeyHash: keyCorrelation,
      });
      throw err;
    }

    logger.info("Item created", {
      statusCode: 201,
      itemId: id,
      idempotencyKeyHash: keyCorrelation,
    });

    return jsonResponse<CreateItemResponse>(201, response);
  } catch (err) {
    logger.error("Unexpected error", err, {
      event: "idempotency_failed",
      statusCode: 500,
      idempotencyKeyHash: idempotencyKeyValidation.ok
        ? idempotencyKeyCorrelation(idempotencyKeyValidation.value)
        : undefined,
    });
    return errorResponse(500, "Failed to create item");
  }
};

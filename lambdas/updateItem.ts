import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import {
  DynamoDBClient,
  GetItemCommand,
  type GetItemCommandInput,
  UpdateItemCommand,
  type UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import type { Item } from "./src/types/item.js";
import { getRequiredEnv } from "./src/utils/env.js";
import { errorResponse, jsonResponse } from "./src/utils/http.js";
import { createLogger } from "./src/utils/logger.js";
import {
  parseStoredItem,
  validateItemId,
  validateUpdateItemBody,
} from "./src/validation/item.js";

const client = new DynamoDBClient();
const route = "PUT /items/{id}";
const operation = "updateItem";

const isConditionalCheckFailed = (err: unknown): boolean =>
  err instanceof Error && err.name === "ConditionalCheckFailedException";

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

  const idValidation = validateItemId(event.pathParameters?.id);

  if (!idValidation.ok) {
    logger.warn("Validation failed", {
      statusCode: 400,
      validationError: idValidation.error,
    });
    return errorResponse(400, idValidation.error);
  }

  const bodyValidation = validateUpdateItemBody(event.body);

  if (!bodyValidation.ok) {
    logger.warn("Validation failed", {
      statusCode: 400,
      itemId: idValidation.value,
      validationError: bodyValidation.error,
    });
    return errorResponse(400, bodyValidation.error);
  }

  try {
    const id = idValidation.value;
    const { name, version } = bodyValidation.value;
    const tableName = getRequiredEnv("TABLE_NAME");
    const getInput: GetItemCommandInput = {
      TableName: tableName,
      Key: { id: { S: id } },
    };

    const existing = await client.send(new GetItemCommand(getInput));

    if (!existing.Item) {
      logger.info("Item not found", {
        statusCode: 404,
        itemId: id,
      });
      return errorResponse(404, "Item not found");
    }

    const parsedExistingItem = parseStoredItem(existing.Item);

    if (!parsedExistingItem.ok) {
      logger.error(
        "Stored item shape invalid",
        new Error(parsedExistingItem.error),
        {
          statusCode: 500,
          itemId: id,
        }
      );
      return errorResponse(500, "Failed to update item");
    }

    const nextVersion = version + 1;
    const versionCondition =
      version === 1
        ? "(#version = :expectedVersion OR attribute_not_exists(#version))"
        : "#version = :expectedVersion";
    const updateInput: UpdateItemCommandInput = {
      TableName: tableName,
      Key: { id: { S: id } },
      UpdateExpression: "SET #name = :name, #version = :nextVersion",
      ConditionExpression: `attribute_exists(#id) AND ${versionCondition}`,
      ExpressionAttributeNames: {
        "#id": "id",
        "#name": "name",
        "#version": "version",
      },
      ExpressionAttributeValues: {
        ":name": { S: name },
        ":expectedVersion": { N: String(version) },
        ":nextVersion": { N: String(nextVersion) },
      },
      ReturnValues: "ALL_NEW",
    };

    const updated = await client.send(new UpdateItemCommand(updateInput));
    const parsedUpdatedItem = parseStoredItem(updated.Attributes);

    if (!parsedUpdatedItem.ok) {
      logger.error(
        "Stored item shape invalid",
        new Error(parsedUpdatedItem.error),
        {
          statusCode: 500,
          itemId: id,
        }
      );
      return errorResponse(500, "Failed to update item");
    }

    logger.info("Item updated", {
      statusCode: 200,
      itemId: id,
    });

    return jsonResponse<Item>(200, parsedUpdatedItem.value);
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      logger.warn("Item version conflict", {
        statusCode: 409,
        itemId: idValidation.value,
      });
      return errorResponse(409, "Item version conflict");
    }

    logger.error("Unexpected error", err, {
      statusCode: 500,
      itemId: idValidation.value,
    });
    return errorResponse(500, "Failed to update item");
  }
};

import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import {
  DynamoDBClient,
  PutItemCommand,
  type PutItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import { v4 as uuidv4 } from "uuid";
import type { CreateItemResponse } from "./src/types/api.js";
import type { StoredItem } from "./src/types/item.js";
import { getRequiredEnv } from "./src/utils/env.js";
import { errorResponse, jsonResponse } from "./src/utils/http.js";
import { createLogger } from "./src/utils/logger.js";
import { validateCreateItemBody } from "./src/validation/item.js";

const client = new DynamoDBClient();
const route = "POST /items";
const operation = "createItem";

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
    const id = uuidv4();
    const item: StoredItem = {
      id: { S: id },
      name: { S: validation.value.name },
      createdAt: { S: new Date().toISOString() },
      version: { N: "1" },
    };
    const input: PutItemCommandInput = {
      TableName: tableName,
      Item: item,
      ConditionExpression: "attribute_not_exists(#id)",
      ExpressionAttributeNames: {
        "#id": "id",
      },
    };

    await client.send(new PutItemCommand(input));

    logger.info("Item created", {
      statusCode: 201,
      itemId: id,
    });

    return jsonResponse<CreateItemResponse>(201, {
      message: "Item created",
      id,
      version: 1,
    });
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      logger.warn("Item already exists", {
        statusCode: 409,
      });
      return errorResponse(409, "Item already exists");
    }

    logger.error("Unexpected error", err, {
      statusCode: 500,
    });
    return errorResponse(500, "Failed to create item");
  }
};

import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import {
  DynamoDBClient,
  GetItemCommand,
  type GetItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import type { Item, StoredItem } from "./src/types/item.js";
import { getRequiredEnv } from "./src/utils/env.js";
import { errorResponse, jsonResponse } from "./src/utils/http.js";
import { createLogger } from "./src/utils/logger.js";
import { validateItemId } from "./src/validation/item.js";

const client = new DynamoDBClient();
const route = "GET /items/{id}";
const operation = "getItem";

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

  const validation = validateItemId(event.pathParameters?.id);

  if (!validation.ok) {
    logger.warn("Validation failed", {
      statusCode: 400,
      validationError: validation.error,
    });
    return errorResponse(400, validation.error);
  }

  try {
    const id = validation.value;
    const tableName = getRequiredEnv("TABLE_NAME");
    const input: GetItemCommandInput = {
      TableName: tableName,
      Key: { id: { S: id } },
    };

    const result = await client.send(new GetItemCommand(input));

    if (!result.Item) {
      logger.info("Item not found", {
        statusCode: 404,
        itemId: id,
      });
      return errorResponse(404, "Item not found");
    }

    const item = result.Item as StoredItem;
    const response: Item = {
      id: item.id.S,
      name: item.name.S,
      createdAt: item.createdAt.S,
    };

    logger.info("Item fetched", {
      statusCode: 200,
      itemId: id,
    });

    return jsonResponse<Item>(200, response);
  } catch (err) {
    logger.error("Unexpected error", err, {
      statusCode: 500,
      itemId: validation.value,
    });
    return errorResponse(500, "Failed to fetch item");
  }
};

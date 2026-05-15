import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import {
  DeleteItemCommand,
  DynamoDBClient,
  type DeleteItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import type { DeleteItemResponse } from "./src/types/api.js";
import { getRequiredEnv } from "./src/utils/env.js";
import { errorResponse, jsonResponse } from "./src/utils/http.js";
import { createLogger } from "./src/utils/logger.js";
import { validateItemId } from "./src/validation/item.js";

const client = new DynamoDBClient();
const route = "DELETE /items/{id}";
const operation = "deleteItem";

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
    const input: DeleteItemCommandInput = {
      TableName: tableName,
      Key: { id: { S: id } },
      ReturnValues: "ALL_OLD",
    };

    const result = await client.send(new DeleteItemCommand(input));

    if (!result.Attributes) {
      logger.info("Item not found", {
        statusCode: 404,
        itemId: id,
      });
      return errorResponse(404, "Item not found");
    }

    logger.info("Item deleted", {
      statusCode: 200,
      itemId: id,
    });

    return jsonResponse<DeleteItemResponse>(200, {
      message: "Item deleted",
      id,
    });
  } catch (err) {
    logger.error("Unexpected error", err, {
      statusCode: 500,
      itemId: validation.value,
    });
    return errorResponse(500, "Failed to delete item");
  }
};

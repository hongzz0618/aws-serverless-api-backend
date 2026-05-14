import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
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
import { validateCreateItemBody } from "./src/validation/item.js";

const client = new DynamoDBClient();

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const validation = validateCreateItemBody(event.body);

  if (!validation.ok) {
    return errorResponse(400, validation.error);
  }

  try {
    const tableName = getRequiredEnv("TABLE_NAME");
    const id = uuidv4();
    const item: StoredItem = {
      id: { S: id },
      name: { S: validation.value.name },
      createdAt: { S: new Date().toISOString() },
    };
    const input: PutItemCommandInput = {
      TableName: tableName,
      Item: item,
    };

    await client.send(new PutItemCommand(input));

    return jsonResponse<CreateItemResponse>(201, { message: "Item created", id });
  } catch (err) {
    console.error(err);
    return errorResponse(500, "Failed to create item");
  }
};

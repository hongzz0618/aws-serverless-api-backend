import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  DynamoDBClient,
  GetItemCommand,
  type GetItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import type { Item, StoredItem } from "./src/types/item.js";
import { getRequiredEnv } from "./src/utils/env.js";
import { errorResponse, jsonResponse } from "./src/utils/http.js";

const client = new DynamoDBClient();

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const id = event.pathParameters?.id;

  if (!id) {
    return errorResponse(400, "Item id is required");
  }

  try {
    const tableName = getRequiredEnv("TABLE_NAME");
    const input: GetItemCommandInput = {
      TableName: tableName,
      Key: { id: { S: id } },
    };

    const result = await client.send(new GetItemCommand(input));

    if (!result.Item) {
      return errorResponse(404, "Item not found");
    }

    const item = result.Item as StoredItem;
    const response: Item = {
      id: item.id.S,
      name: item.name.S,
      createdAt: item.createdAt.S,
    };

    return jsonResponse<Item>(200, response);
  } catch (err) {
    console.error(err);
    return errorResponse(500, "Failed to fetch item");
  }
};

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
import { parseJson } from "./src/utils/json.js";

const client = new DynamoDBClient();

interface CreateItemRequestBody {
  name: string;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  if (!event.body) {
    return errorResponse(400, "Request body is required");
  }

  const parsedBody = parseJson(event.body);

  if (!parsedBody.ok) {
    return errorResponse(400, "Request body must be valid JSON");
  }

  if (
    typeof parsedBody.value !== "object" ||
    parsedBody.value === null ||
    !("name" in parsedBody.value)
  ) {
    return errorResponse(400, "Name is required");
  }

  const body = parsedBody.value as Partial<CreateItemRequestBody>;

  if (typeof body.name !== "string") {
    return errorResponse(400, "Name must be a string");
  }

  const name = body.name.trim();

  if (!name) {
    return errorResponse(400, "Name cannot be empty");
  }

  try {
    const tableName = getRequiredEnv("TABLE_NAME");
    const id = uuidv4();
    const item: StoredItem = {
      id: { S: id },
      name: { S: name },
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

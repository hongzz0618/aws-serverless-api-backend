import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  DeleteItemCommand,
  DynamoDBClient,
  type DeleteItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import type { DeleteItemResponse } from "./src/types/api.js";
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
    const input: DeleteItemCommandInput = {
      TableName: tableName,
      Key: { id: { S: id } },
      ReturnValues: "ALL_OLD",
    };

    const result = await client.send(new DeleteItemCommand(input));

    if (!result.Attributes) {
      return errorResponse(404, "Item not found");
    }

    return jsonResponse<DeleteItemResponse>(200, {
      message: "Item deleted",
      id,
    });
  } catch (err) {
    console.error(err);
    return errorResponse(500, "Failed to delete item");
  }
};

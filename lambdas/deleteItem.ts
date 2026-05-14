import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  DeleteItemCommand,
  DynamoDBClient,
  type DeleteItemCommandInput,
} from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient();

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const id = event.pathParameters?.id;

  if (!id) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Item id is required" }),
    };
  }

  try {
    const tableName: string | undefined = process.env.TABLE_NAME;
    const input: DeleteItemCommandInput = {
      TableName: tableName,
      Key: { id: { S: id } },
      ReturnValues: "ALL_OLD",
    };

    const result = await client.send(new DeleteItemCommand(input));

    if (!result.Attributes) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Item not found" }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Item deleted", id }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to delete item" }),
    };
  }
};

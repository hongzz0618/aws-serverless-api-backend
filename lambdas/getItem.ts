import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  DynamoDBClient,
  GetItemCommand,
  type AttributeValue,
  type GetItemCommandInput,
} from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient();

type DynamoDBStringAttribute = AttributeValue.SMember;

type StoredItem = Record<"id" | "name" | "createdAt", DynamoDBStringAttribute>;

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
    const input: GetItemCommandInput = {
      TableName: tableName,
      Key: { id: { S: id } },
    };

    const result = await client.send(new GetItemCommand(input));

    if (!result.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Item not found" }),
      };
    }

    const item = result.Item as StoredItem;

    return {
      statusCode: 200,
      body: JSON.stringify({
        id: item.id.S,
        name: item.name.S,
        createdAt: item.createdAt.S,
      }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to fetch item" }),
    };
  }
};

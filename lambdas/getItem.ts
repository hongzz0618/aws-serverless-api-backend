import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  DynamoDBClient,
  GetItemCommand,
  type AttributeValue,
  type GetItemCommandInput,
} from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient();

type PathParameters = {
  id: string;
};

type DynamoDBStringAttribute = AttributeValue.SMember;

type StoredItem = Record<"id" | "name" | "createdAt", DynamoDBStringAttribute>;

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    const tableName: string | undefined = process.env.TABLE_NAME;
    const pathParameters = event.pathParameters as PathParameters;
    const id = pathParameters.id;
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

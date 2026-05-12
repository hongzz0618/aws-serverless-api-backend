import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  DynamoDBClient,
  PutItemCommand,
  type AttributeValue,
  type PutItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import { v4 as uuidv4 } from "uuid";

const client = new DynamoDBClient();

interface CreateItemRequestBody {
  name: string;
}

type DynamoDBStringAttribute = AttributeValue.SMember;

type StoredItem = Record<"id" | "name" | "createdAt", DynamoDBStringAttribute>;

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    const tableName: string | undefined = process.env.TABLE_NAME;
    const body = JSON.parse(event.body as string) as CreateItemRequestBody;
    const id = uuidv4();
    const item: StoredItem = {
      id: { S: id },
      name: { S: body.name },
      createdAt: { S: new Date().toISOString() },
    };
    const input: PutItemCommandInput = {
      TableName: tableName,
      Item: item,
    };

    await client.send(new PutItemCommand(input));

    return {
      statusCode: 201,
      body: JSON.stringify({ message: "Item created", id }),
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to create item" }),
    };
  }
};

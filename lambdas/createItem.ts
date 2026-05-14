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
  if (!event.body) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Request body is required" }),
    };
  }

  let parsedBody: unknown;

  try {
    parsedBody = JSON.parse(event.body);
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Request body must be valid JSON" }),
    };
  }

  if (
    typeof parsedBody !== "object" ||
    parsedBody === null ||
    !("name" in parsedBody)
  ) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Name is required" }),
    };
  }

  const body = parsedBody as Partial<CreateItemRequestBody>;

  if (typeof body.name !== "string") {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Name must be a string" }),
    };
  }

  const name = body.name.trim();

  if (!name) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Name cannot be empty" }),
    };
  }

  try {
    const tableName: string | undefined = process.env.TABLE_NAME;
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

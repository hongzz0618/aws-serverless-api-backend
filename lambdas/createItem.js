import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { v4 as uuidv4 } from "uuid";

const client = new DynamoDBClient();

export const handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const id = uuidv4();

    await client.send(
      new PutItemCommand({
        TableName: process.env.TABLE_NAME,
        Item: {
          id: { S: id },
          name: { S: body.name },
          createdAt: { S: new Date().toISOString() },
        },
      })
    );

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

import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient();

export const handler = async (event) => {
  try {
    const id = event.pathParameters.id;

    const result = await client.send(
      new GetItemCommand({
        TableName: process.env.TABLE_NAME,
        Key: { id: { S: id } },
      })
    );

    if (!result.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Item not found" }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        id: result.Item.id.S,
        name: result.Item.name.S,
        createdAt: result.Item.createdAt.S,
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

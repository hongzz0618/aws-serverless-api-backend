import { DynamoDBClient, DeleteItemCommand } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient();

export const handler = async (event) => {
  try {
    const id = event.pathParameters.id;

    await client.send(
      new DeleteItemCommand({
        TableName: process.env.TABLE_NAME,
        Key: { id: { S: id } },
      })
    );

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

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  DeleteItemCommand,
  DynamoDBClient,
  type DeleteItemCommandInput,
} from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient();

type PathParameters = {
  id: string;
};

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    const tableName: string | undefined = process.env.TABLE_NAME;
    const pathParameters = event.pathParameters as PathParameters;
    const id = pathParameters.id;
    const input: DeleteItemCommandInput = {
      TableName: tableName,
      Key: { id: { S: id } },
    };

    await client.send(new DeleteItemCommand(input));

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

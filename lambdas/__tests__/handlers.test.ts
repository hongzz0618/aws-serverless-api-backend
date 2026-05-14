import type { APIGatewayProxyEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dynamoMock = vi.hoisted(() => ({
  send: vi.fn(),
  commands: [] as Array<{ name: string; input: unknown }>,
}));

vi.mock("@aws-sdk/client-dynamodb", () => {
  class DynamoDBClient {
    send = dynamoMock.send;
  }

  class PutItemCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
      dynamoMock.commands.push({ name: "PutItemCommand", input });
    }
  }

  class GetItemCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
      dynamoMock.commands.push({ name: "GetItemCommand", input });
    }
  }

  class DeleteItemCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
      dynamoMock.commands.push({ name: "DeleteItemCommand", input });
    }
  }

  return {
    DynamoDBClient,
    PutItemCommand,
    GetItemCommand,
    DeleteItemCommand,
  };
});

vi.mock("uuid", () => ({
  v4: () => "test-item-id",
}));

const apiEvent = (
  overrides: Partial<APIGatewayProxyEvent> = {}
): APIGatewayProxyEvent => ({
  body: null,
  headers: {},
  multiValueHeaders: {},
  httpMethod: "GET",
  isBase64Encoded: false,
  path: "",
  pathParameters: null,
  queryStringParameters: null,
  multiValueQueryStringParameters: null,
  stageVariables: null,
  requestContext: {} as APIGatewayProxyEvent["requestContext"],
  resource: "",
  ...overrides,
});

const responseBody = <TBody>(body: string): TBody => JSON.parse(body) as TBody;

beforeEach(() => {
  vi.resetModules();
  dynamoMock.send.mockReset();
  dynamoMock.commands = [];
  process.env.TABLE_NAME = "items-table";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createItem handler", () => {
  it("returns 400 when body is missing", async () => {
    const { handler } = await import("../createItem.js");

    const result = await handler(apiEvent());

    expect(result.statusCode).toBe(400);
    expect(responseBody(result.body)).toEqual({ error: "Request body is required" });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 400 when JSON is invalid", async () => {
    const { handler } = await import("../createItem.js");

    const result = await handler(apiEvent({ body: "{" }));

    expect(result.statusCode).toBe(400);
    expect(responseBody(result.body)).toEqual({
      error: "Request body must be valid JSON",
    });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 400 when name is missing", async () => {
    const { handler } = await import("../createItem.js");

    const result = await handler(apiEvent({ body: JSON.stringify({}) }));

    expect(result.statusCode).toBe(400);
    expect(responseBody(result.body)).toEqual({ error: "Name is required" });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 400 when name is not a string", async () => {
    const { handler } = await import("../createItem.js");

    const result = await handler(apiEvent({ body: JSON.stringify({ name: 123 }) }));

    expect(result.statusCode).toBe(400);
    expect(responseBody(result.body)).toEqual({ error: "Name must be a string" });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 400 when name is empty", async () => {
    const { handler } = await import("../createItem.js");

    const result = await handler(apiEvent({ body: JSON.stringify({ name: "   " }) }));

    expect(result.statusCode).toBe(400);
    expect(responseBody(result.body)).toEqual({ error: "Name cannot be empty" });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 201 when item is created successfully", async () => {
    dynamoMock.send.mockResolvedValueOnce({});
    const { handler } = await import("../createItem.js");

    const result = await handler(
      apiEvent({ body: JSON.stringify({ name: " Example item " }) })
    );

    expect(result.statusCode).toBe(201);
    expect(responseBody(result.body)).toEqual({
      message: "Item created",
      id: "test-item-id",
    });
    expect(dynamoMock.send).toHaveBeenCalledTimes(1);
    expect(dynamoMock.commands[0]).toMatchObject({
      name: "PutItemCommand",
      input: {
        TableName: "items-table",
        Item: {
          id: { S: "test-item-id" },
          name: { S: "Example item" },
        },
      },
    });
  });

  it("returns 500 when DynamoDB fails", async () => {
    dynamoMock.send.mockRejectedValueOnce(new Error("DynamoDB failure"));
    const { handler } = await import("../createItem.js");

    const result = await handler(apiEvent({ body: JSON.stringify({ name: "Item" }) }));

    expect(result.statusCode).toBe(500);
    expect(responseBody(result.body)).toEqual({ error: "Failed to create item" });
  });
});

describe("getItem handler", () => {
  it("returns 400 when id is missing", async () => {
    const { handler } = await import("../getItem.js");

    const result = await handler(apiEvent());

    expect(result.statusCode).toBe(400);
    expect(responseBody(result.body)).toEqual({ error: "Item id is required" });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 404 when item does not exist", async () => {
    dynamoMock.send.mockResolvedValueOnce({});
    const { handler } = await import("../getItem.js");

    const result = await handler(apiEvent({ pathParameters: { id: "item-1" } }));

    expect(result.statusCode).toBe(404);
    expect(responseBody(result.body)).toEqual({ error: "Item not found" });
    expect(dynamoMock.commands[0]).toMatchObject({
      name: "GetItemCommand",
      input: {
        TableName: "items-table",
        Key: { id: { S: "item-1" } },
      },
    });
  });

  it("returns 200 when item exists", async () => {
    dynamoMock.send.mockResolvedValueOnce({
      Item: {
        id: { S: "item-1" },
        name: { S: "Example item" },
        createdAt: { S: "2026-05-14T10:00:00.000Z" },
      },
    });
    const { handler } = await import("../getItem.js");

    const result = await handler(apiEvent({ pathParameters: { id: "item-1" } }));

    expect(result.statusCode).toBe(200);
    expect(responseBody(result.body)).toEqual({
      id: "item-1",
      name: "Example item",
      createdAt: "2026-05-14T10:00:00.000Z",
    });
  });

  it("returns 500 when DynamoDB fails", async () => {
    dynamoMock.send.mockRejectedValueOnce(new Error("DynamoDB failure"));
    const { handler } = await import("../getItem.js");

    const result = await handler(apiEvent({ pathParameters: { id: "item-1" } }));

    expect(result.statusCode).toBe(500);
    expect(responseBody(result.body)).toEqual({ error: "Failed to fetch item" });
  });
});

describe("deleteItem handler", () => {
  it("returns 400 when id is missing", async () => {
    const { handler } = await import("../deleteItem.js");

    const result = await handler(apiEvent());

    expect(result.statusCode).toBe(400);
    expect(responseBody(result.body)).toEqual({ error: "Item id is required" });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 404 when item does not exist", async () => {
    dynamoMock.send.mockResolvedValueOnce({});
    const { handler } = await import("../deleteItem.js");

    const result = await handler(apiEvent({ pathParameters: { id: "item-1" } }));

    expect(result.statusCode).toBe(404);
    expect(responseBody(result.body)).toEqual({ error: "Item not found" });
    expect(dynamoMock.commands[0]).toMatchObject({
      name: "DeleteItemCommand",
      input: {
        TableName: "items-table",
        Key: { id: { S: "item-1" } },
        ReturnValues: "ALL_OLD",
      },
    });
  });

  it("returns 200 when item is deleted", async () => {
    dynamoMock.send.mockResolvedValueOnce({
      Attributes: {
        id: { S: "item-1" },
      },
    });
    const { handler } = await import("../deleteItem.js");

    const result = await handler(apiEvent({ pathParameters: { id: "item-1" } }));

    expect(result.statusCode).toBe(200);
    expect(responseBody(result.body)).toEqual({
      message: "Item deleted",
      id: "item-1",
    });
  });

  it("returns 500 when DynamoDB fails", async () => {
    dynamoMock.send.mockRejectedValueOnce(new Error("DynamoDB failure"));
    const { handler } = await import("../deleteItem.js");

    const result = await handler(apiEvent({ pathParameters: { id: "item-1" } }));

    expect(result.statusCode).toBe(500);
    expect(responseBody(result.body)).toEqual({ error: "Failed to delete item" });
  });
});

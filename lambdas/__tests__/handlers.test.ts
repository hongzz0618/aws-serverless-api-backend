import type { APIGatewayProxyEvent, Context } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ITEM_ID = "00000000-0000-4000-8000-000000000001";

const dynamoMock = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock("@aws-sdk/client-dynamodb", () => {
  class DynamoDBClient {
    send = dynamoMock.send;
  }

  class PutItemCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class GetItemCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class DeleteItemCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  class UpdateItemCommand {
    input: unknown;

    constructor(input: unknown) {
      this.input = input;
    }
  }

  return {
    DynamoDBClient,
    PutItemCommand,
    GetItemCommand,
    DeleteItemCommand,
    UpdateItemCommand,
  };
});

vi.mock("uuid", () => ({
  v4: () => "00000000-0000-4000-8000-000000000001",
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

const expectJsonResponse = <TBody>(
  result: { statusCode: number; headers?: Record<string, unknown>; body: string },
  statusCode: number,
  body: TBody
) => {
  expect(result.statusCode).toBe(statusCode);
  expect(result.headers).toEqual({ "Content-Type": "application/json" });
  expect(responseBody<TBody>(result.body)).toEqual(body);
};

const expectSafeErrorResponse = (
  result: { statusCode: number; headers?: Record<string, unknown>; body: string },
  statusCode: number,
  publicError: string,
  internalError: string
) => {
  expectJsonResponse(result, statusCode, { error: publicError });
  expect(result.body).not.toContain(internalError);
};

const loggedJson = (): Array<Record<string, unknown>> =>
  vi.mocked(console.log).mock.calls.map(
    ([entry]) => JSON.parse(String(entry)) as Record<string, unknown>
  );

const errorLoggedJson = (): Array<Record<string, unknown>> =>
  vi.mocked(console.error).mock.calls.map(
    ([entry]) => JSON.parse(String(entry)) as Record<string, unknown>
  );

interface MissingTableNameLogExpectation {
  operation: string;
  requestId: string;
  route: string;
  sensitiveBodyValue?: string;
}

const expectMissingTableNameLog = ({
  operation,
  requestId,
  route,
  sensitiveBodyValue,
}: MissingTableNameLogExpectation) => {
  const logs = errorLoggedJson();

  expect(logs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        level: "error",
        message: "Unexpected error",
        service: "items-api",
        requestId,
        route,
        operation,
        statusCode: 500,
        errorName: "Error",
        errorMessage: "Missing required environment variable: TABLE_NAME",
      }),
    ])
  );
  expect(logs).toEqual(
    expect.not.arrayContaining([expect.objectContaining({ body: expect.anything() })])
  );

  if (sensitiveBodyValue) {
    expect(JSON.stringify(logs)).not.toContain(sensitiveBodyValue);
  }
};

beforeEach(() => {
  vi.resetModules();
  dynamoMock.send.mockReset();
  process.env.TABLE_NAME = "items-table";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createItem handler", () => {
  it("returns 400 when body is missing", async () => {
    const { handler } = await import("../createItem.js");

    const result = await handler(apiEvent());

    expectJsonResponse(result, 400, { error: "Request body is required" });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 400 when JSON is invalid", async () => {
    const { handler } = await import("../createItem.js");

    const result = await handler(apiEvent({ body: "{" }));

    expectJsonResponse(result, 400, {
      error: "Request body must be valid JSON",
    });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 400 when name is missing", async () => {
    const { handler } = await import("../createItem.js");

    const result = await handler(apiEvent({ body: JSON.stringify({}) }));

    expectJsonResponse(result, 400, { error: "Name is required" });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 400 when name is not a string", async () => {
    const { handler } = await import("../createItem.js");

    const result = await handler(apiEvent({ body: JSON.stringify({ name: 123 }) }));

    expectJsonResponse(result, 400, { error: "Name must be a string" });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 400 when name contains only spaces", async () => {
    const { handler } = await import("../createItem.js");

    const result = await handler(apiEvent({ body: JSON.stringify({ name: "   " }) }));

    expectJsonResponse(result, 400, { error: "Name cannot be empty" });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 400 when name is longer than the allowed max length", async () => {
    const { handler } = await import("../createItem.js");

    const result = await handler(
      apiEvent({ body: JSON.stringify({ name: "a".repeat(101) }) })
    );

    expectJsonResponse(result, 400, {
      error: "Name must be 100 characters or fewer",
    });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 201 when item is created successfully", async () => {
    dynamoMock.send.mockResolvedValueOnce({});
    const { handler } = await import("../createItem.js");

    const result = await handler(
      apiEvent({ body: JSON.stringify({ name: " Example item " }) })
    );

    expectJsonResponse(result, 201, {
      message: "Item created",
      id: TEST_ITEM_ID,
      version: 1,
    });
    expect(dynamoMock.send).toHaveBeenCalledTimes(1);
    expect(dynamoMock.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Item: expect.objectContaining({
            version: { N: "1" },
          }),
        }),
      })
    );
  });

  it("logs structured request metadata when context is available", async () => {
    dynamoMock.send.mockResolvedValueOnce({});
    const { handler } = await import("../createItem.js");

    await handler(
      apiEvent({ body: JSON.stringify({ name: "Example item" }) }),
      { awsRequestId: "request-123" } as Context
    );

    expect(loggedJson()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "info",
          message: "Request received",
          service: "items-api",
          requestId: "request-123",
          route: "POST /items",
          operation: "createItem",
        }),
        expect.objectContaining({
          level: "info",
          message: "Item created",
          itemId: TEST_ITEM_ID,
          statusCode: 201,
        }),
      ])
    );
  });

  it("returns a safe 500 when DynamoDB fails", async () => {
    const internalError = "DynamoDB failure";
    dynamoMock.send.mockRejectedValueOnce(new Error(internalError));
    const { handler } = await import("../createItem.js");

    const result = await handler(apiEvent({ body: JSON.stringify({ name: "Item" }) }));

    expectSafeErrorResponse(result, 500, "Failed to create item", internalError);
  });

  it("returns a safe 409 when the item id already exists", async () => {
    const internalError = "Conditional request failed for existing item";
    const duplicateError = new Error(internalError);
    duplicateError.name = "ConditionalCheckFailedException";
    dynamoMock.send.mockRejectedValueOnce(duplicateError);
    const { handler } = await import("../createItem.js");

    const result = await handler(apiEvent({ body: JSON.stringify({ name: "Item" }) }));

    expectSafeErrorResponse(result, 409, "Item already exists", internalError);
  });

  it("returns a safe 500 and logs metadata when TABLE_NAME is missing", async () => {
    const sensitiveBodyValue = "Config test item";
    delete process.env.TABLE_NAME;
    const { handler } = await import("../createItem.js");

    const result = await handler(
      apiEvent({ body: JSON.stringify({ name: sensitiveBodyValue }) }),
      { awsRequestId: "request-missing-create-table" } as Context
    );

    expectSafeErrorResponse(
      result,
      500,
      "Failed to create item",
      "Missing required environment variable: TABLE_NAME"
    );
    expect(dynamoMock.send).not.toHaveBeenCalled();
    expectMissingTableNameLog({
      operation: "createItem",
      requestId: "request-missing-create-table",
      route: "POST /items",
      sensitiveBodyValue,
    });
  });
});

describe("getItem handler", () => {
  it("returns 400 when id is missing", async () => {
    const { handler } = await import("../getItem.js");

    const result = await handler(apiEvent());

    expectJsonResponse(result, 400, { error: "Item id is required" });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 400 when id is not a valid UUID", async () => {
    const { handler } = await import("../getItem.js");

    const result = await handler(apiEvent({ pathParameters: { id: "item-1" } }));

    expectJsonResponse(result, 400, {
      error: "Item id must be a valid UUID",
    });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 404 when item does not exist", async () => {
    dynamoMock.send.mockResolvedValueOnce({});
    const { handler } = await import("../getItem.js");

    const result = await handler(apiEvent({ pathParameters: { id: TEST_ITEM_ID } }));

    expectJsonResponse(result, 404, { error: "Item not found" });
  });

  it("uses a consistent read", async () => {
    dynamoMock.send.mockResolvedValueOnce({});
    const { handler } = await import("../getItem.js");

    await handler(apiEvent({ pathParameters: { id: TEST_ITEM_ID } }));

    expect(dynamoMock.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          ConsistentRead: true,
        }),
      })
    );
  });

  it("returns 200 with version when item exists", async () => {
    dynamoMock.send.mockResolvedValueOnce({
      Item: {
        id: { S: TEST_ITEM_ID },
        name: { S: "Example item" },
        createdAt: { S: "2026-05-14T10:00:00.000Z" },
        version: { N: "3" },
      },
    });
    const { handler } = await import("../getItem.js");

    const result = await handler(apiEvent({ pathParameters: { id: TEST_ITEM_ID } }));

    expectJsonResponse(result, 200, {
      id: TEST_ITEM_ID,
      name: "Example item",
      createdAt: "2026-05-14T10:00:00.000Z",
      version: 3,
    });
  });

  it("returns version 1 for legacy items without a version attribute", async () => {
    dynamoMock.send.mockResolvedValueOnce({
      Item: {
        id: { S: TEST_ITEM_ID },
        name: { S: "Legacy item" },
        createdAt: { S: "2026-05-14T10:00:00.000Z" },
      },
    });
    const { handler } = await import("../getItem.js");

    const result = await handler(apiEvent({ pathParameters: { id: TEST_ITEM_ID } }));

    expectJsonResponse(result, 200, {
      id: TEST_ITEM_ID,
      name: "Legacy item",
      createdAt: "2026-05-14T10:00:00.000Z",
      version: 1,
    });
  });

  it("returns 500 when the stored item shape is invalid", async () => {
    dynamoMock.send.mockResolvedValueOnce({
      Item: {
        id: { S: TEST_ITEM_ID },
        name: { S: "Example item" },
      },
    });
    const { handler } = await import("../getItem.js");

    const result = await handler(apiEvent({ pathParameters: { id: TEST_ITEM_ID } }));

    expectSafeErrorResponse(
      result,
      500,
      "Failed to fetch item",
      "Stored item has an invalid shape"
    );
  });

  it("logs metadata when the stored item shape is invalid", async () => {
    dynamoMock.send.mockResolvedValueOnce({
      Item: {
        id: { S: TEST_ITEM_ID },
        createdAt: { S: "2026-05-14T10:00:00.000Z" },
      },
    });
    const { handler } = await import("../getItem.js");

    await handler(
      apiEvent({ pathParameters: { id: TEST_ITEM_ID } }),
      { awsRequestId: "request-456" } as Context
    );

    expect(errorLoggedJson()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          message: "Stored item shape invalid",
          service: "items-api",
          requestId: "request-456",
          route: "GET /items/{id}",
          operation: "getItem",
          statusCode: 500,
          itemId: TEST_ITEM_ID,
          errorName: "Error",
          errorMessage: "Stored item has an invalid shape",
        }),
      ])
    );
  });

  it("returns a safe 500 when DynamoDB fails", async () => {
    const internalError = "DynamoDB failure";
    dynamoMock.send.mockRejectedValueOnce(new Error(internalError));
    const { handler } = await import("../getItem.js");

    const result = await handler(apiEvent({ pathParameters: { id: TEST_ITEM_ID } }));

    expectSafeErrorResponse(result, 500, "Failed to fetch item", internalError);
  });

  it("returns a safe 500 and logs metadata when TABLE_NAME is missing", async () => {
    delete process.env.TABLE_NAME;
    const { handler } = await import("../getItem.js");

    const result = await handler(
      apiEvent({ pathParameters: { id: TEST_ITEM_ID } }),
      { awsRequestId: "request-missing-get-table" } as Context
    );

    expectSafeErrorResponse(
      result,
      500,
      "Failed to fetch item",
      "Missing required environment variable: TABLE_NAME"
    );
    expect(dynamoMock.send).not.toHaveBeenCalled();
    expectMissingTableNameLog({
      operation: "getItem",
      requestId: "request-missing-get-table",
      route: "GET /items/{id}",
    });
  });
});

describe("updateItem handler", () => {
  it("returns 200 with the updated item and incremented version", async () => {
    dynamoMock.send
      .mockResolvedValueOnce({
        Item: {
          id: { S: TEST_ITEM_ID },
          name: { S: "Original item" },
          createdAt: { S: "2026-05-14T10:00:00.000Z" },
          version: { N: "2" },
        },
      })
      .mockResolvedValueOnce({
        Attributes: {
          id: { S: TEST_ITEM_ID },
          name: { S: "Updated item" },
          createdAt: { S: "2026-05-14T10:00:00.000Z" },
          version: { N: "3" },
        },
      });
    const { handler } = await import("../updateItem.js");

    const result = await handler(
      apiEvent({
        pathParameters: { id: TEST_ITEM_ID },
        body: JSON.stringify({ name: " Updated item ", version: 2 }),
      })
    );

    expectJsonResponse(result, 200, {
      id: TEST_ITEM_ID,
      name: "Updated item",
      createdAt: "2026-05-14T10:00:00.000Z",
      version: 3,
    });
    expect(dynamoMock.send).toHaveBeenCalledTimes(2);
  });

  it("uses a consistent read for the pre-read", async () => {
    dynamoMock.send
      .mockResolvedValueOnce({
        Item: {
          id: { S: TEST_ITEM_ID },
          name: { S: "Original item" },
          createdAt: { S: "2026-05-14T10:00:00.000Z" },
          version: { N: "1" },
        },
      })
      .mockResolvedValueOnce({
        Attributes: {
          id: { S: TEST_ITEM_ID },
          name: { S: "Updated item" },
          createdAt: { S: "2026-05-14T10:00:00.000Z" },
          version: { N: "2" },
        },
      });
    const { handler } = await import("../updateItem.js");

    await handler(
      apiEvent({
        pathParameters: { id: TEST_ITEM_ID },
        body: JSON.stringify({ name: "Updated item", version: 1 }),
      })
    );

    expect(dynamoMock.send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        input: expect.objectContaining({
          ConsistentRead: true,
        }),
      })
    );
  });

  it("updates a legacy item without version when submitted version is 1", async () => {
    dynamoMock.send
      .mockResolvedValueOnce({
        Item: {
          id: { S: TEST_ITEM_ID },
          name: { S: "Legacy item" },
          createdAt: { S: "2026-05-14T10:00:00.000Z" },
        },
      })
      .mockResolvedValueOnce({
        Attributes: {
          id: { S: TEST_ITEM_ID },
          name: { S: "Updated legacy item" },
          createdAt: { S: "2026-05-14T10:00:00.000Z" },
          version: { N: "2" },
        },
      });
    const { handler } = await import("../updateItem.js");

    const result = await handler(
      apiEvent({
        pathParameters: { id: TEST_ITEM_ID },
        body: JSON.stringify({ name: "Updated legacy item", version: 1 }),
      })
    );

    expectJsonResponse(result, 200, {
      id: TEST_ITEM_ID,
      name: "Updated legacy item",
      createdAt: "2026-05-14T10:00:00.000Z",
      version: 2,
    });
    expect(dynamoMock.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          ConditionExpression:
            "attribute_exists(#id) AND (#version = :expectedVersion OR attribute_not_exists(#version))",
          ExpressionAttributeValues: expect.objectContaining({
            ":expectedVersion": { N: "1" },
            ":nextVersion": { N: "2" },
          }),
        }),
      })
    );
  });

  it("returns a safe 409 for a legacy item without version when submitted version is not 1", async () => {
    const internalError = "Conditional request failed for legacy stale version";
    const conflictError = new Error(internalError);
    conflictError.name = "ConditionalCheckFailedException";
    dynamoMock.send
      .mockResolvedValueOnce({
        Item: {
          id: { S: TEST_ITEM_ID },
          name: { S: "Legacy item" },
          createdAt: { S: "2026-05-14T10:00:00.000Z" },
        },
      })
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce({
        Item: {
          id: { S: TEST_ITEM_ID },
          name: { S: "Legacy item" },
          createdAt: { S: "2026-05-14T10:00:00.000Z" },
        },
      });
    const { handler } = await import("../updateItem.js");

    const result = await handler(
      apiEvent({
        pathParameters: { id: TEST_ITEM_ID },
        body: JSON.stringify({ name: "Updated legacy item", version: 2 }),
      })
    );

    expectSafeErrorResponse(result, 409, "Item version conflict", internalError);
    expect(dynamoMock.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          ConditionExpression: "attribute_exists(#id) AND #version = :expectedVersion",
          ExpressionAttributeValues: expect.objectContaining({
            ":expectedVersion": { N: "2" },
            ":nextVersion": { N: "3" },
          }),
        }),
      })
    );
  });

  it("returns 400 when version is missing", async () => {
    const { handler } = await import("../updateItem.js");

    const result = await handler(
      apiEvent({
        pathParameters: { id: TEST_ITEM_ID },
        body: JSON.stringify({ name: "Updated item" }),
      })
    );

    expectJsonResponse(result, 400, { error: "Version is required" });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 400 when version is a string", async () => {
    const { handler } = await import("../updateItem.js");

    const result = await handler(
      apiEvent({
        pathParameters: { id: TEST_ITEM_ID },
        body: JSON.stringify({ name: "Updated item", version: "1" }),
      })
    );

    expectJsonResponse(result, 400, { error: "Version must be a number" });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 400 when version is zero", async () => {
    const { handler } = await import("../updateItem.js");

    const result = await handler(
      apiEvent({
        pathParameters: { id: TEST_ITEM_ID },
        body: JSON.stringify({ name: "Updated item", version: 0 }),
      })
    );

    expectJsonResponse(result, 400, {
      error: "Version must be a positive integer",
    });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 400 when version is negative", async () => {
    const { handler } = await import("../updateItem.js");

    const result = await handler(
      apiEvent({
        pathParameters: { id: TEST_ITEM_ID },
        body: JSON.stringify({ name: "Updated item", version: -1 }),
      })
    );

    expectJsonResponse(result, 400, {
      error: "Version must be a positive integer",
    });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 400 when version is not an integer", async () => {
    const { handler } = await import("../updateItem.js");

    const result = await handler(
      apiEvent({
        pathParameters: { id: TEST_ITEM_ID },
        body: JSON.stringify({ name: "Updated item", version: 1.5 }),
      })
    );

    expectJsonResponse(result, 400, {
      error: "Version must be a positive integer",
    });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 400 when id is not a valid UUID", async () => {
    const { handler } = await import("../updateItem.js");

    const result = await handler(
      apiEvent({
        pathParameters: { id: "item-1" },
        body: JSON.stringify({ name: "Updated item", version: 1 }),
      })
    );

    expectJsonResponse(result, 400, {
      error: "Item id must be a valid UUID",
    });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 404 when item does not exist", async () => {
    dynamoMock.send.mockResolvedValueOnce({});
    const { handler } = await import("../updateItem.js");

    const result = await handler(
      apiEvent({
        pathParameters: { id: TEST_ITEM_ID },
        body: JSON.stringify({ name: "Updated item", version: 1 }),
      })
    );

    expectJsonResponse(result, 404, { error: "Item not found" });
    expect(dynamoMock.send).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when a conditional failure is followed by a missing item", async () => {
    const internalError = "Conditional request failed after delete";
    const conflictError = new Error(internalError);
    conflictError.name = "ConditionalCheckFailedException";
    dynamoMock.send
      .mockResolvedValueOnce({
        Item: {
          id: { S: TEST_ITEM_ID },
          name: { S: "Current item" },
          createdAt: { S: "2026-05-14T10:00:00.000Z" },
          version: { N: "1" },
        },
      })
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce({});
    const { handler } = await import("../updateItem.js");

    const result = await handler(
      apiEvent({
        pathParameters: { id: TEST_ITEM_ID },
        body: JSON.stringify({ name: "Updated item", version: 1 }),
      })
    );

    expectJsonResponse(result, 404, { error: "Item not found" });
    expect(result.body).not.toContain(internalError);
    expect(dynamoMock.send).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        input: expect.objectContaining({
          ConsistentRead: true,
        }),
      })
    );
  });

  it("returns a safe 409 when a conditional failure is followed by an existing item", async () => {
    const internalError = "Conditional request failed for stale version";
    const conflictError = new Error(internalError);
    conflictError.name = "ConditionalCheckFailedException";
    dynamoMock.send
      .mockResolvedValueOnce({
        Item: {
          id: { S: TEST_ITEM_ID },
          name: { S: "Current item" },
          createdAt: { S: "2026-05-14T10:00:00.000Z" },
          version: { N: "2" },
        },
      })
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce({
        Item: {
          id: { S: TEST_ITEM_ID },
          name: { S: "Current item" },
          createdAt: { S: "2026-05-14T10:00:00.000Z" },
          version: { N: "2" },
        },
      });
    const { handler } = await import("../updateItem.js");

    const result = await handler(
      apiEvent({
        pathParameters: { id: TEST_ITEM_ID },
        body: JSON.stringify({ name: "Updated item", version: 1 }),
      })
    );

    expectSafeErrorResponse(result, 409, "Item version conflict", internalError);
    expect(dynamoMock.send).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        input: expect.objectContaining({
          ConsistentRead: true,
        }),
      })
    );
  });

  it("returns a safe 500 when the follow-up read after a conditional failure fails", async () => {
    const conflictError = new Error("Conditional request failed for stale version");
    const followUpError = "DynamoDB follow-up get failure";
    conflictError.name = "ConditionalCheckFailedException";
    dynamoMock.send
      .mockResolvedValueOnce({
        Item: {
          id: { S: TEST_ITEM_ID },
          name: { S: "Current item" },
          createdAt: { S: "2026-05-14T10:00:00.000Z" },
          version: { N: "2" },
        },
      })
      .mockRejectedValueOnce(conflictError)
      .mockRejectedValueOnce(new Error(followUpError));
    const { handler } = await import("../updateItem.js");

    const result = await handler(
      apiEvent({
        pathParameters: { id: TEST_ITEM_ID },
        body: JSON.stringify({ name: "Updated item", version: 1 }),
      })
    );

    expectSafeErrorResponse(result, 500, "Failed to update item", followUpError);
  });

  it("returns a safe 500 when DynamoDB read fails", async () => {
    const internalError = "DynamoDB get failure";
    dynamoMock.send.mockRejectedValueOnce(new Error(internalError));
    const { handler } = await import("../updateItem.js");

    const result = await handler(
      apiEvent({
        pathParameters: { id: TEST_ITEM_ID },
        body: JSON.stringify({ name: "Updated item", version: 1 }),
      })
    );

    expectSafeErrorResponse(result, 500, "Failed to update item", internalError);
  });

  it("returns a safe 500 when DynamoDB update fails", async () => {
    const internalError = "DynamoDB update failure";
    dynamoMock.send
      .mockResolvedValueOnce({
        Item: {
          id: { S: TEST_ITEM_ID },
          name: { S: "Current item" },
          createdAt: { S: "2026-05-14T10:00:00.000Z" },
          version: { N: "1" },
        },
      })
      .mockRejectedValueOnce(new Error(internalError));
    const { handler } = await import("../updateItem.js");

    const result = await handler(
      apiEvent({
        pathParameters: { id: TEST_ITEM_ID },
        body: JSON.stringify({ name: "Updated item", version: 1 }),
      })
    );

    expectSafeErrorResponse(result, 500, "Failed to update item", internalError);
  });
});

describe("deleteItem handler", () => {
  it("returns 400 when id is missing", async () => {
    const { handler } = await import("../deleteItem.js");

    const result = await handler(apiEvent());

    expectJsonResponse(result, 400, { error: "Item id is required" });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 400 when id is not a valid UUID", async () => {
    const { handler } = await import("../deleteItem.js");

    const result = await handler(apiEvent({ pathParameters: { id: "item-1" } }));

    expectJsonResponse(result, 400, {
      error: "Item id must be a valid UUID",
    });
    expect(dynamoMock.send).not.toHaveBeenCalled();
  });

  it("returns 404 when item does not exist", async () => {
    dynamoMock.send.mockResolvedValueOnce({});
    const { handler } = await import("../deleteItem.js");

    const result = await handler(apiEvent({ pathParameters: { id: TEST_ITEM_ID } }));

    expectJsonResponse(result, 404, { error: "Item not found" });
  });

  it("returns 200 when item is deleted", async () => {
    dynamoMock.send.mockResolvedValueOnce({
      Attributes: {
        id: { S: TEST_ITEM_ID },
      },
    });
    const { handler } = await import("../deleteItem.js");

    const result = await handler(apiEvent({ pathParameters: { id: TEST_ITEM_ID } }));

    expectJsonResponse(result, 200, {
      message: "Item deleted",
      id: TEST_ITEM_ID,
    });
  });

  it("returns a safe 500 when DynamoDB fails", async () => {
    const internalError = "DynamoDB failure";
    dynamoMock.send.mockRejectedValueOnce(new Error(internalError));
    const { handler } = await import("../deleteItem.js");

    const result = await handler(apiEvent({ pathParameters: { id: TEST_ITEM_ID } }));

    expectSafeErrorResponse(result, 500, "Failed to delete item", internalError);
  });

  it("returns a safe 500 and logs metadata when TABLE_NAME is missing", async () => {
    delete process.env.TABLE_NAME;
    const { handler } = await import("../deleteItem.js");

    const result = await handler(
      apiEvent({ pathParameters: { id: TEST_ITEM_ID } }),
      { awsRequestId: "request-missing-delete-table" } as Context
    );

    expectSafeErrorResponse(
      result,
      500,
      "Failed to delete item",
      "Missing required environment variable: TABLE_NAME"
    );
    expect(dynamoMock.send).not.toHaveBeenCalled();
    expectMissingTableNameLog({
      operation: "deleteItem",
      requestId: "request-missing-delete-table",
      route: "DELETE /items/{id}",
    });
  });
});

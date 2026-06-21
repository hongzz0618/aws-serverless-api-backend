import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv/dist/ajv.js";
import YAML from "yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ITEM_ID = "00000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-05-14T10:00:00.000Z";

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

  class TransactWriteItemsCommand {
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
    TransactWriteItemsCommand,
  };
});

vi.mock("uuid", () => ({
  v4: () => TEST_ITEM_ID,
}));

type OpenApiDocument = {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any>; responses: Record<string, any> };
};

const spec = YAML.parse(
  readFileSync(join(process.cwd(), "../openapi/openapi.yaml"), "utf8")
) as OpenApiDocument;

const ajv = new Ajv({ strict: false, validateFormats: false });

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

const createItemEvent = (
  overrides: Partial<APIGatewayProxyEvent> = {}
): APIGatewayProxyEvent =>
  apiEvent({
    body: JSON.stringify({ name: "Example item" }),
    headers: { "Idempotency-Key": "create-key-123" },
    httpMethod: "POST",
    path: "/items",
    ...overrides,
  });

const body = (result: { body: string }): unknown => JSON.parse(result.body);

const schemaFromResponse = (method: string, path: string, status: number): any => {
  const response = spec.paths[path][method].responses[String(status)];
  const resolvedResponse = response.$ref
    ? spec.components.responses[response.$ref.split("/").at(-1) as string]
    : response;
  const schema = resolvedResponse.content?.["application/json"]?.schema;
  return schema.$ref ? spec.components.schemas[schema.$ref.split("/").at(-1) as string] : schema;
};

const expectBodyMatches = (
  result: APIGatewayProxyResult,
  method: string,
  path: string
) => {
  const validate = ajv.compile(schemaFromResponse(method, path, result.statusCode));
  const parsedBody = body(result);
  expect(validate(parsedBody), JSON.stringify(validate.errors)).toBe(true);
};

const expectJsonHeader = (result: APIGatewayProxyResult) => {
  expect(result.headers?.["Content-Type"]).toBe("application/json");
};

const conditionalError = (message = "conditional failed"): Error => {
  const error = new Error(message);
  error.name = "ConditionalCheckFailedException";
  return error;
};

beforeEach(() => {
  vi.resetModules();
  dynamoMock.send.mockReset();
  process.env.TABLE_NAME = "items-table";
  process.env.IDEMPOTENCY_TABLE_NAME = "idempotency-table";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("handler response contract", () => {
  it("validates create success and non-replay response headers", async () => {
    dynamoMock.send.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const { handler } = await import("../../createItem.js");

    const result = await handler(createItemEvent());

    expect(result.statusCode).toBe(201);
    expectJsonHeader(result);
    expect(result.headers?.["Idempotency-Replayed"]).toBeUndefined();
    expectBodyMatches(result, "post", "/items");
  });

  it("validates idempotent replay response body and header", async () => {
    dynamoMock.send.mockRejectedValueOnce(conditionalError()).mockResolvedValueOnce({
      Item: {
        requestFingerprint: {
          S: "fc5d1045c1183e0903b3823b77393778261920349610a2754d05cb5f43cc2124",
        },
        status: { S: "COMPLETED" },
        itemId: { S: TEST_ITEM_ID },
        responseStatusCode: { N: "201" },
        responseBody: {
          S: JSON.stringify({ message: "Item created", id: TEST_ITEM_ID, version: 1 }),
        },
      },
    });
    const { handler } = await import("../../createItem.js");

    const result = await handler(createItemEvent());

    expect(result.statusCode).toBe(201);
    expectJsonHeader(result);
    expect(result.headers?.["Idempotency-Replayed"]).toBe("true");
    expect(spec.paths["/items"].post.responses["201"].headers["Idempotency-Replayed"]).toBeDefined();
    expectBodyMatches(result, "post", "/items");
  });

  it("validates public validation errors", async () => {
    const { handler } = await import("../../createItem.js");

    const result = await handler(createItemEvent({ headers: {} }));

    expect(result.statusCode).toBe(400);
    expectJsonHeader(result);
    expect(body(result)).toEqual({ error: "Idempotency-Key header is required" });
    expectBodyMatches(result, "post", "/items");
  });

  it("validates not found errors", async () => {
    dynamoMock.send.mockResolvedValueOnce({});
    const { handler } = await import("../../getItem.js");

    const result = await handler(apiEvent({ pathParameters: { id: TEST_ITEM_ID } }));

    expect(result.statusCode).toBe(404);
    expectJsonHeader(result);
    expect(body(result)).toEqual({ error: "Item not found" });
    expectBodyMatches(result, "get", "/items/{id}");
  });

  it("validates optimistic locking version conflict errors", async () => {
    dynamoMock.send
      .mockResolvedValueOnce({
        Item: {
          id: { S: TEST_ITEM_ID },
          name: { S: "Current item" },
          createdAt: { S: CREATED_AT },
          version: { N: "2" },
        },
      })
      .mockRejectedValueOnce(conditionalError("stale version"))
      .mockResolvedValueOnce({
        Item: {
          id: { S: TEST_ITEM_ID },
          name: { S: "Current item" },
          createdAt: { S: CREATED_AT },
          version: { N: "2" },
        },
      });
    const { handler } = await import("../../updateItem.js");

    const result = await handler(
      apiEvent({
        pathParameters: { id: TEST_ITEM_ID },
        body: JSON.stringify({ name: "Updated item", version: 1 }),
      })
    );

    expect(result.statusCode).toBe(409);
    expectJsonHeader(result);
    expect(body(result)).toEqual({ error: "Item version conflict" });
    expectBodyMatches(result, "put", "/items/{id}");
  });

  it("validates internal error responses without internal fields", async () => {
    dynamoMock.send.mockRejectedValueOnce(new Error("DynamoDB failure"));
    const { handler } = await import("../../deleteItem.js");

    const result = await handler(apiEvent({ pathParameters: { id: TEST_ITEM_ID } }));

    expect(result.statusCode).toBe(500);
    expectJsonHeader(result);
    expect(body(result)).toEqual({ error: "Failed to delete item" });
    expect(Object.keys(body(result) as Record<string, unknown>)).toEqual(["error"]);
    expect(result.body).not.toContain("DynamoDB");
    expectBodyMatches(result, "delete", "/items/{id}");
  });
});

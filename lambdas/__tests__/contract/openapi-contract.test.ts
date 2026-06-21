import { readFileSync } from "node:fs";
import { join } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import { Ajv } from "ajv/dist/ajv.js";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_KEY_OPENAPI_PATTERN,
} from "../../src/idempotency.js";
import { ITEM_NAME_MAX_LENGTH } from "../../src/validation/item.js";

const repoRoot = join(process.cwd(), "..");
const openApiPath = join(repoRoot, "openapi/openapi.yaml");
const terraformPath = join(repoRoot, "terraform/main.tf");

const httpMethods = new Set(["get", "put", "post", "delete", "patch", "head", "options"]);

type OpenApiDocument = {
  openapi: string;
  info: Record<string, unknown>;
  servers: Array<Record<string, unknown>>;
  paths: Record<string, Record<string, any>>;
  components: Record<string, any>;
};

const spec = YAML.parse(readFileSync(openApiPath, "utf8")) as OpenApiDocument;

const routeKey = (route: { method: string; path: string }): string =>
  `${route.method} ${route.path}`;

const extractBlocks = (source: string, type: string): Array<{ name: string; body: string }> => {
  const blocks: Array<{ name: string; body: string }> = [];
  const startPattern = new RegExp(`resource\\s+"${type}"\\s+"([^"]+)"\\s+\\{`, "g");
  let match: RegExpExecArray | null;

  while ((match = startPattern.exec(source))) {
    let index = startPattern.lastIndex;
    let depth = 1;

    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
      }
      index += 1;
    }

    if (depth !== 0) {
      throw new Error(`Could not parse Terraform resource ${type}.${match[1]}`);
    }

    blocks.push({ name: match[1], body: source.slice(startPattern.lastIndex, index - 1) });
  }

  return blocks;
};

const attr = (body: string, name: string): string | undefined =>
  body.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, "m"))?.[1]?.trim();

const unquote = (value: string | undefined): string | undefined =>
  value?.replace(/^"|"$/g, "");

const terraformRoutes = (): Array<{ method: string; path: string }> => {
  const source = readFileSync(terraformPath, "utf8");
  const resources = new Map<string, { pathPart: string | undefined; parentRef: string | undefined }>();

  for (const block of extractBlocks(source, "aws_api_gateway_resource")) {
    resources.set(block.name, {
      pathPart: unquote(attr(block.body, "path_part")),
      parentRef: attr(block.body, "parent_id"),
    });
  }

  const resolveResourcePath = (name: string, seen = new Set<string>()): string => {
    const resource = resources.get(name);
    if (!resource) {
      throw new Error(`Method references unknown API Gateway resource: ${name}`);
    }
    if (seen.has(name)) {
      throw new Error(`Cycle found while resolving API Gateway resource: ${name}`);
    }
    seen.add(name);

    if (!resource.pathPart) {
      throw new Error(`API Gateway resource ${name} is missing path_part`);
    }

    if (resource.parentRef === "aws_api_gateway_rest_api.api.root_resource_id") {
      return `/${resource.pathPart}`;
    }

    const parentMatch = resource.parentRef?.match(/^aws_api_gateway_resource\.([^.]+)\.id$/);
    if (!parentMatch) {
      throw new Error(`Unsupported parent_id for API Gateway resource ${name}: ${resource.parentRef}`);
    }

    return `${resolveResourcePath(parentMatch[1], seen)}/${resource.pathPart}`;
  };

  const routes = extractBlocks(source, "aws_api_gateway_method").map((block) => {
    const method = unquote(attr(block.body, "http_method"));
    const resourceRef = attr(block.body, "resource_id");
    const resourceMatch = resourceRef?.match(/^aws_api_gateway_resource\.([^.]+)\.id$/);

    if (!method || !resourceMatch) {
      throw new Error(`Unsupported API Gateway method declaration: ${block.name}`);
    }

    return {
      method,
      path: resolveResourcePath(resourceMatch[1]),
    };
  });

  const keys = routes.map(routeKey);
  expect(new Set(keys).size).toBe(keys.length);
  return routes.sort((a, b) => routeKey(a).localeCompare(routeKey(b)));
};

const openApiRoutes = (): Array<{ method: string; path: string }> => {
  const routes: Array<{ method: string; path: string }> = [];

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (httpMethods.has(method)) {
        expect(operation.responses).toBeDefined();
        routes.push({ method: method.toUpperCase(), path });
      }
    }
  }

  const keys = routes.map(routeKey);
  expect(new Set(keys).size).toBe(keys.length);
  return routes.sort((a, b) => routeKey(a).localeCompare(routeKey(b)));
};

const operationIds = (): string[] => {
  const ids: string[] = [];

  for (const pathItem of Object.values(spec.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (httpMethods.has(method)) {
        expect(operation.operationId).toBeTypeOf("string");
        ids.push(operation.operationId);
      }
    }
  }

  return ids;
};

const dereference = async (): Promise<OpenApiDocument> =>
  (await SwaggerParser.dereference(openApiPath)) as OpenApiDocument;

const localRefName = (ref: string | undefined): string | undefined =>
  ref?.match(/^#\/components\/[^/]+\/([^/]+)$/)?.[1];

const resolveParameter = (parameter: any): any => {
  const name = localRefName(parameter?.$ref);
  return name ? spec.components.parameters[name] : parameter;
};

describe("OpenAPI contract structure", () => {
  it("parses, validates refs, has unique operation IDs, and declares responses", async () => {
    await expect(SwaggerParser.validate(openApiPath)).resolves.toBeDefined();
    await expect(dereference()).resolves.toBeDefined();

    expect(spec.openapi).toBe("3.0.3");
    expect(spec.info).toBeDefined();
    expect(spec.servers).toBeDefined();
    expect(spec.paths).toBeDefined();
    expect(spec.components).toBeDefined();

    const ids = operationIds();
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("Terraform route parity", () => {
  it("matches OpenAPI method/path pairs and path parameter names", () => {
    expect(openApiRoutes().map(routeKey)).toEqual(terraformRoutes().map(routeKey));
  });
});

describe("required request contract", () => {
  it("documents headers, path parameters, request bodies, version, and content type", () => {
    const create = spec.paths["/items"].post;
    const idempotencyKey = create.parameters.map(resolveParameter).find(
      (parameter: any) => parameter.name === "Idempotency-Key" && parameter.in === "header"
    );

    expect(idempotencyKey.required).toBe(true);
    expect(idempotencyKey.schema.minLength).toBe(IDEMPOTENCY_KEY_MIN_LENGTH);
    expect(idempotencyKey.schema.maxLength).toBe(IDEMPOTENCY_KEY_MAX_LENGTH);
    expect(idempotencyKey.schema.pattern).toBe(IDEMPOTENCY_KEY_OPENAPI_PATTERN);
    expect(create.requestBody.required).toBe(true);
    expect(create.requestBody.content["application/json"]).toBeDefined();

    const itemId = spec.components.parameters.ItemId;
    expect(itemId.required).toBe(true);
    expect(itemId.name).toBe("id");
    expect(itemId.schema.format).toBe("uuid");

    const createBody = spec.components.schemas.CreateItemRequest;
    expect(createBody.required).toEqual(["name"]);
    expect(createBody.properties.name.maxLength).toBe(ITEM_NAME_MAX_LENGTH);

    const update = spec.paths["/items/{id}"].put;
    expect(update.requestBody.required).toBe(true);
    expect(update.requestBody.content["application/json"]).toBeDefined();

    const updateBody = spec.components.schemas.UpdateItemRequest;
    expect(updateBody.required).toEqual(["name", "version"]);
    expect(updateBody.properties.version).toEqual(
      expect.objectContaining({ type: "integer", minimum: 1 })
    );

    expect(spec.paths["/items/{id}"].delete.requestBody).toBeUndefined();
  });
});

describe("error consistency", () => {
  it("declares JSON error responses with no undocumented internal fields", async () => {
    const dereferenced = await dereference();
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const validateError = ajv.compile(dereferenced.components.schemas.ErrorResponse);

    for (const [path, pathItem] of Object.entries(dereferenced.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!httpMethods.has(method)) {
          continue;
        }

        for (const status of ["400", "404", "409", "500"]) {
          const response = operation.responses?.[status];
          if (!response) {
            continue;
          }

          const json = response.content?.["application/json"];
          expect(json, `${method.toUpperCase()} ${path} ${status}`).toBeDefined();
          expect(json.schema).toEqual(dereferenced.components.schemas.ErrorResponse);

          const examples = json.examples
            ? Object.values(json.examples).map((example: any) => example.value)
            : [json.example];
          for (const example of examples.filter(Boolean)) {
            expect(validateError(example)).toBe(true);
            expect(Object.keys(example)).toEqual(["error"]);
          }
        }
      }
    }
  });
});

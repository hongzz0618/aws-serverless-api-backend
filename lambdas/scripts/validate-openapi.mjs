import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import YAML from "yaml";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const openApiPath = join(repoRoot, "openapi/openapi.yaml");
const terraformPath = join(repoRoot, "terraform/main.tf");
const ciPath = join(repoRoot, ".github/workflows/ci.yml");

const httpMethods = new Set(["get", "put", "post", "delete", "patch", "head", "options"]);

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const readYaml = (path) => YAML.parse(readFileSync(path, "utf8"));

const extractBlocks = (source, type) => {
  const blocks = [];
  const startPattern = new RegExp(`resource\\s+"${type}"\\s+"([^"]+)"\\s+\\{`, "g");
  let match;

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

    assert(depth === 0, `Could not parse Terraform resource ${type}.${match[1]}`);
    blocks.push({ name: match[1], body: source.slice(startPattern.lastIndex, index - 1) });
  }

  return blocks;
};

const attr = (body, name) => {
  const match = body.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, "m"));
  return match?.[1]?.trim();
};

const unquote = (value) => value?.replace(/^"|"$/g, "");

const terraformRoutes = () => {
  const source = readFileSync(terraformPath, "utf8");
  const resources = new Map();

  for (const block of extractBlocks(source, "aws_api_gateway_resource")) {
    resources.set(block.name, {
      pathPart: unquote(attr(block.body, "path_part")),
      parentRef: attr(block.body, "parent_id"),
    });
  }

  const resolveResourcePath = (name, seen = new Set()) => {
    assert(resources.has(name), `Method references unknown API Gateway resource: ${name}`);
    assert(!seen.has(name), `Cycle found while resolving API Gateway resource: ${name}`);
    seen.add(name);

    const resource = resources.get(name);
    assert(resource.pathPart, `API Gateway resource ${name} is missing path_part`);

    if (resource.parentRef === "aws_api_gateway_rest_api.api.root_resource_id") {
      return `/${resource.pathPart}`;
    }

    const parentMatch = resource.parentRef?.match(/^aws_api_gateway_resource\.([^.]+)\.id$/);
    assert(parentMatch, `Unsupported parent_id for API Gateway resource ${name}: ${resource.parentRef}`);
    return `${resolveResourcePath(parentMatch[1], seen)}/${resource.pathPart}`;
  };

  const routes = [];

  for (const block of extractBlocks(source, "aws_api_gateway_method")) {
    const method = unquote(attr(block.body, "http_method"));
    const resourceRef = attr(block.body, "resource_id");
    const resourceMatch = resourceRef?.match(/^aws_api_gateway_resource\.([^.]+)\.id$/);

    assert(method, `API Gateway method ${block.name} is missing http_method`);
    assert(resourceMatch, `Unsupported resource_id for API Gateway method ${block.name}: ${resourceRef}`);

    routes.push({
      method,
      path: resolveResourcePath(resourceMatch[1]),
    });
  }

  const keys = routes.map((route) => `${route.method} ${route.path}`);
  assert(new Set(keys).size === keys.length, `Duplicate Terraform routes found: ${keys.join(", ")}`);

  return routes.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
};

const openApiRoutes = (spec) => {
  const routes = [];

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (httpMethods.has(method)) {
        assert(operation.responses, `${method.toUpperCase()} ${path} is missing responses`);
        routes.push({ method: method.toUpperCase(), path });
      }
    }
  }

  const keys = routes.map((route) => `${route.method} ${route.path}`);
  assert(new Set(keys).size === keys.length, `Duplicate OpenAPI routes found: ${keys.join(", ")}`);

  return routes.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
};

const operationIds = (spec) => {
  const ids = [];

  for (const pathItem of Object.values(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (httpMethods.has(method)) {
        assert(operation.operationId, `${method.toUpperCase()} operation is missing operationId`);
        ids.push(operation.operationId);
      }
    }
  }

  return ids;
};

const routeKey = (route) => `${route.method} ${route.path}`;
const localRefName = (ref) => ref?.match(/^#\/components\/[^/]+\/([^/]+)$/)?.[1];
const resolveParameter = (parameter) => {
  const name = localRefName(parameter?.$ref);
  return name ? spec.components?.parameters?.[name] : parameter;
};
const resolveResponse = (response) => {
  const name = localRefName(response?.$ref);
  return name ? spec.components?.responses?.[name] : response;
};

const spec = readYaml(openApiPath);
await SwaggerParser.validate(openApiPath);
await SwaggerParser.dereference(openApiPath);

assert(spec.openapi === "3.0.3", "OpenAPI version must be 3.0.3");
for (const requiredTopLevelKey of ["openapi", "info", "servers", "paths", "components"]) {
  assert(spec[requiredTopLevelKey], `OpenAPI is missing top-level ${requiredTopLevelKey}`);
}

const ids = operationIds(spec);
assert(new Set(ids).size === ids.length, "OpenAPI operationId values must be unique");

const terraformRouteKeys = terraformRoutes().map(routeKey);
const openApiRouteKeys = openApiRoutes(spec).map(routeKey);
assert(
  JSON.stringify(terraformRouteKeys) === JSON.stringify(openApiRouteKeys),
  `Terraform/OpenAPI route mismatch\nTerraform: ${terraformRouteKeys.join(", ")}\nOpenAPI: ${openApiRouteKeys.join(", ")}`
);

const createOperation = spec.paths["/items"]?.post;
assert(createOperation, "POST /items is missing from OpenAPI");
const idempotencyKey = createOperation.parameters?.map(resolveParameter).find(
  (parameter) => parameter.name === "Idempotency-Key" && parameter.in === "header"
);
assert(idempotencyKey?.required === true, "Idempotency-Key must be required");
assert(idempotencyKey.schema?.pattern === "^[A-Za-z0-9._:-]{8,128}$", "Idempotency-Key pattern is wrong");
assert(idempotencyKey.schema?.minLength === 8, "Idempotency-Key minLength is wrong");
assert(idempotencyKey.schema?.maxLength === 128, "Idempotency-Key maxLength is wrong");
assert(
  resolveResponse(createOperation.responses?.["201"])?.headers?.["Idempotency-Replayed"],
  "Replay response header is missing"
);

const updateBody = spec.paths["/items/{id}"]?.put?.requestBody?.content?.["application/json"]?.schema;
assert(updateBody?.$ref === "#/components/schemas/UpdateItemRequest", "PUT body must reference UpdateItemRequest");
assert(
  spec.components?.schemas?.UpdateItemRequest?.required?.includes("version"),
  "UpdateItemRequest must require version"
);
assert(spec.paths["/items/{id}"]?.put?.responses?.["409"], "PUT /items/{id} must document version conflict");
assert(!spec.paths["/items/{id}"]?.delete?.requestBody, "DELETE /items/{id} must not define a request body");

const serializedSpec = readFileSync(openApiPath, "utf8");
assert(!/https:\/\/[a-z0-9-]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com\/(?!dev\b)/i.test(serializedSpec), "OpenAPI must not contain a real deployed API endpoint");
assert(!serializedSpec.includes("amazonaws.com/prod"), "OpenAPI must not contain a real production endpoint");

const ci = readFileSync(ciPath, "utf8");
assert(ci.includes("npm run contract:validate"), "CI must run npm run contract:validate");
assert(ci.includes("npm run test:contract"), "CI must run npm run test:contract");

console.log("OpenAPI contract validation passed.");

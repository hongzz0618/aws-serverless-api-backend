import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(process.cwd(), "..");

const readRepoFile = (path: string): string =>
  readFileSync(join(repoRoot, path), "utf8");

const stripCommentOnlyLines = (source: string): string =>
  source
    .split(/\r?\n/)
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join("\n");

const resourceBlock = (source: string, type: string, name: string): string => {
  const uncommentedSource = stripCommentOnlyLines(source);
  const start = uncommentedSource.indexOf(`resource "${type}" "${name}"`);
  expect(start).toBeGreaterThanOrEqual(0);

  const open = uncommentedSource.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < uncommentedSource.length; index += 1) {
    if (uncommentedSource[index] === "{") {
      depth += 1;
    }
    if (uncommentedSource[index] === "}") {
      depth -= 1;
    }
    if (depth === 0) {
      return uncommentedSource.slice(start, index + 1);
    }
  }

  throw new Error(`Could not parse ${type}.${name}`);
};

describe("terraform idempotency configuration", () => {
  const main = readRepoFile("terraform/main.tf");
  const outputs = readRepoFile("terraform/outputs.tf");

  it("creates a separate DynamoDB table with TTL for idempotency records", () => {
    expect(main).toContain('resource "aws_dynamodb_table" "idempotency"');
    expect(main).toContain('name         = "${var.project_name}-idempotency"');
    expect(main).toContain('hash_key     = "idempotencyKey"');
    expect(main).toContain('attribute_name = "expiresAt"');
    expect(main).toContain("server_side_encryption");
  });

  it("wires the idempotency table only into the create Lambda environment", () => {
    const createFunctionStart = main.indexOf('resource "aws_lambda_function" "create_item"');
    const getFunctionStart = main.indexOf('resource "aws_lambda_function" "get_item"');
    const createFunction = main.slice(createFunctionStart, getFunctionStart);

    expect(createFunction).toMatch(
      /IDEMPOTENCY_TABLE_NAME\s*=\s*aws_dynamodb_table\.idempotency\.name/
    );
    expect(main.slice(getFunctionStart)).not.toContain("IDEMPOTENCY_TABLE_NAME");
  });

  it("keeps DynamoDB IAM actions and resources scoped without wildcards", () => {
    const dynamodbPolicy = resourceBlock(main, "aws_iam_role_policy", "lambda_dynamodb_items");
    expect(main).toContain("aws_dynamodb_table.items.arn");
    expect(main).toContain("aws_dynamodb_table.idempotency.arn");
    expect(dynamodbPolicy).toContain('"dynamodb:PutItem"');
    expect(dynamodbPolicy).toContain('"dynamodb:UpdateItem"');
    expect(dynamodbPolicy).not.toContain('"dynamodb:TransactWriteItems"');
    expect(dynamodbPolicy).not.toContain('"dynamodb:*"');
    expect(dynamodbPolicy).not.toMatch(/Action\s*=\s*"\*"/);
    expect(dynamodbPolicy).not.toMatch(/Resource\s*=\s*"\*"/);
  });

  it("exposes idempotency metrics without adding replay or conflict alarms", () => {
    expect(main).toMatch(/event\s*=\s*"idempotency_replayed"/);
    expect(main).toMatch(/event\s*=\s*"idempotency_conflict"/);
    expect(main).toMatch(/event\s*=\s*"idempotency_failed"/);
    expect(main).toContain('pattern        = "\\"${each.value.event}\\""');
    expect(main).not.toContain('$.event = "${each.value.event}"');
    expect(outputs).not.toContain("idempotency_replayed");
  });
});

describe("terraform pre-deployment security boundaries", () => {
  const main = readRepoFile("terraform/main.tf");

  it("uses inline scoped Lambda logging permissions instead of broad managed logging policy", () => {
    const lambdaLogsPolicy = resourceBlock(main, "aws_iam_role_policy", "lambda_logs");

    expect(main).not.toContain("AWSLambdaBasicExecutionRole");
    expect(lambdaLogsPolicy).toContain('"logs:CreateLogStream"');
    expect(lambdaLogsPolicy).toContain('"logs:PutLogEvents"');
    expect(lambdaLogsPolicy).not.toContain('"logs:CreateLogGroup"');
    expect(lambdaLogsPolicy).not.toContain('"logs:*"');
    expect(lambdaLogsPolicy).not.toMatch(/Resource\s*=\s*"\*"/);
    expect(lambdaLogsPolicy).toContain("${aws_cloudwatch_log_group.create_item.arn}:*");
    expect(lambdaLogsPolicy).toContain("${aws_cloudwatch_log_group.get_item.arn}:*");
    expect(lambdaLogsPolicy).toContain("${aws_cloudwatch_log_group.update_item.arn}:*");
    expect(lambdaLogsPolicy).toContain("${aws_cloudwatch_log_group.delete_item.arn}:*");
  });

  it("matches Lambda log group names to Lambda function names", () => {
    const expectedPairs = [
      ["create_item", "create"],
      ["get_item", "get"],
      ["update_item", "update"],
      ["delete_item", "delete"],
    ];

    for (const [resourceName, suffix] of expectedPairs) {
      const logGroup = resourceBlock(main, "aws_cloudwatch_log_group", resourceName);
      const lambda = resourceBlock(main, "aws_lambda_function", resourceName);

      expect(logGroup).toContain(`name              = "/aws/lambda/\${var.project_name}-${suffix}"`);
      expect(lambda).toContain(`function_name = "\${var.project_name}-${suffix}"`);
      expect(lambda).toContain(`depends_on = [aws_cloudwatch_log_group.${resourceName}]`);
    }
  });

  it("uses an explicit API Gateway CloudWatch Logs action allowlist", () => {
    const apiGatewayLogsPolicy = resourceBlock(
      main,
      "aws_iam_role_policy",
      "api_gateway_cloudwatch_logs"
    );

    expect(main).not.toContain("AmazonAPIGatewayPushToCloudWatchLogs");
    expect(apiGatewayLogsPolicy).toContain('"logs:CreateLogGroup"');
    expect(apiGatewayLogsPolicy).toContain('"logs:CreateLogStream"');
    expect(apiGatewayLogsPolicy).toContain('"logs:PutLogEvents"');
    expect(apiGatewayLogsPolicy).toContain('Resource = "*"');
    expect(apiGatewayLogsPolicy).not.toContain('"logs:*"');
    expect(apiGatewayLogsPolicy).not.toMatch(/Action\s*=\s*"\*"/);
  });

  it("keeps API Gateway Lambda invoke permissions route scoped", () => {
    const expectedPermissions = [
      [
        "apigw_create",
        "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.post_items.http_method}/${aws_api_gateway_resource.items.path_part}",
      ],
      [
        "apigw_get",
        "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.get_item.http_method}/${aws_api_gateway_resource.items.path_part}/*",
      ],
      [
        "apigw_update",
        "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.put_item.http_method}/${aws_api_gateway_resource.items.path_part}/*",
      ],
      [
        "apigw_delete",
        "${aws_api_gateway_rest_api.api.execution_arn}/*/${aws_api_gateway_method.delete_item.http_method}/${aws_api_gateway_resource.items.path_part}/*",
      ],
    ];

    for (const [permission, sourceArn] of expectedPermissions) {
      const block = resourceBlock(main, "aws_lambda_permission", permission);
      expect(block).toContain('principal     = "apigateway.amazonaws.com"');
      expect(block).toContain('action        = "lambda:InvokeFunction"');
      expect(block).toContain(`source_arn    = "${sourceArn}"`);
      expect(block).not.toMatch(/source_arn\s*=\s*"\*"/);
      expect(block).not.toContain("/*/*/*");
    }
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(process.cwd(), "..");

const readRepoFile = (path: string): string =>
  readFileSync(join(repoRoot, path), "utf8");

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
    expect(main).toContain("aws_dynamodb_table.items.arn");
    expect(main).toContain("aws_dynamodb_table.idempotency.arn");
    expect(main).toContain('"dynamodb:TransactWriteItems"');
    expect(main).not.toContain('"dynamodb:*"');
    expect(main).not.toMatch(/Resource\s*=\s*"\*"/);
  });

  it("exposes idempotency metrics without adding replay or conflict alarms", () => {
    expect(main).toMatch(/event\s*=\s*"idempotency_replayed"/);
    expect(main).toMatch(/event\s*=\s*"idempotency_conflict"/);
    expect(main).toMatch(/event\s*=\s*"idempotency_failed"/);
    expect(outputs).not.toContain("idempotency_replayed");
  });
});

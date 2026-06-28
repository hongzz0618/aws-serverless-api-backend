import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(process.cwd(), "..");

const readRepoFile = (path: string): string =>
  readFileSync(join(repoRoot, path), "utf8");

const trackedFiles = (): string[] =>
  execFileSync("git", ["ls-files"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean);

describe("GitHub Actions pre-deployment security", () => {
  const workflow = readRepoFile(".github/workflows/ci.yml");

  it("keeps the workflow token read-only and does not request deployment credentials", () => {
    expect(workflow).toMatch(/permissions:\s*\r?\n\s+contents:\s+read/);
    expect(workflow).not.toContain("id-token: write");
    expect(workflow).not.toContain("contents: write");
    expect(workflow).not.toContain("pull-requests: write");
    expect(workflow).not.toContain("security-events: write");
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).not.toContain("aws-actions/");
    expect(workflow).not.toMatch(/toJson\(\s*secrets\s*\)/);
  });

  it("uses pinned action major versions and no floating branch refs", () => {
    const actionRefs = [...workflow.matchAll(/uses:\s+([^\s]+)/g)].map((match) => match[1]);

    expect(actionRefs).toEqual([
      "actions/checkout@v4",
      "actions/setup-node@v4",
      "actions/upload-artifact@v4",
      "actions/checkout@v4",
      "actions/download-artifact@v4",
      "hashicorp/setup-terraform@v3",
    ]);
    expect(actionRefs.some((ref) => /@(main|master|latest)$/.test(ref))).toBe(false);
  });

  it("uploads only Lambda ZIPs and the generated manifest", () => {
    expect(workflow).toContain("lambdas/createItem.zip");
    expect(workflow).toContain("lambdas/getItem.zip");
    expect(workflow).toContain("lambdas/updateItem.zip");
    expect(workflow).toContain("lambdas/deleteItem.zip");
    expect(workflow).toContain("lambdas/dispatchItemCreated.zip");
    expect(workflow).toContain("lambdas/processItemCreated.zip");
    expect(workflow).toContain("lambdas/artifacts-manifest.json");
    expect(workflow).toContain("retention-days: 7");
    expect(workflow).not.toMatch(/path:\s*\|\s*\r?\n\s+lambdas\/?\s*$/m);
    expect(workflow).not.toContain("node_modules");
  });
});

describe("repository sensitive file hygiene", () => {
  it("does not track generated artifacts, local state, plans, credentials, or env files", () => {
    const forbiddenTrackedPatterns = [
      /^lambdas\/.*\.zip$/,
      /^lambdas\/artifacts-manifest\.json$/,
      /^lambdas\/dist\//,
      /(^|\/)node_modules\//,
      /(^|\/)\.env(?:\.|$)/,
      /(^|\/)\.aws\//,
      /(^|\/)credentials$/,
      /\.pem$/,
      /\.key$/,
      /\.tfstate(?:\.|$)/,
      /\.tfplan$/,
      /(^|\/)terraform\.tfvars$/,
      /\.auto\.tfvars$/,
    ];

    expect(
      trackedFiles().filter((file) =>
        forbiddenTrackedPatterns.some((pattern) => pattern.test(file))
      )
    ).toEqual([]);
  });

  it("keeps generated and sensitive local files ignored", () => {
    const gitignore = readRepoFile(".gitignore");

    for (const expected of [
      ".env",
      ".env.*",
      ".aws/",
      "credentials",
      "*.pem",
      "*.key",
      "*.tfstate",
      "*.tfstate.*",
      "*.tfplan",
      "*.tfvars",
      "node_modules/",
      "*.zip",
      "lambdas/dist/",
      "lambdas/artifacts-manifest.json",
    ]) {
      expect(gitignore).toContain(expected);
    }
  });
});

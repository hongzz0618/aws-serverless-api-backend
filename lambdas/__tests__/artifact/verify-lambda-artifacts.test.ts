import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yazl from "yazl";
import { describe, expect, it } from "vitest";

const importVerifier = async () =>
  // @ts-ignore The verifier is an ESM .mjs script used directly by npm.
  import("../../scripts/verify-lambda-artifacts.mjs");

const writeZip = async (
  zipPath: string,
  entries: Record<string, string>
): Promise<void> =>
  new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, content] of Object.entries(entries)) {
      zip.addBuffer(Buffer.from(content), name);
    }
    zip.end();
    zip.outputStream
      .pipe(createWriteStream(zipPath))
      .on("close", resolve)
      .on("error", reject);
  });

interface FixtureOptions {
  zipName?: string;
  terraformZipName?: string;
  terraformHandler?: string;
  zipEntries?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  handlerLine?: string;
  writeArtifact?: boolean;
}

const createFixtureRepo = async ({
  zipName = "createItem.zip",
  terraformZipName = zipName,
  terraformHandler = "createItem.handler",
  zipEntries,
  dependencies = {},
  devDependencies = {},
  handlerLine = "export const handler = async () => {};",
  writeArtifact = true,
}: FixtureOptions) => {
  const repoRoot = await mkdtemp(join(tmpdir(), "artifact-fixture-"));
  const lambdaDir = join(repoRoot, "lambdas");
  await mkdir(join(repoRoot, "scripts"), { recursive: true });
  await mkdir(join(repoRoot, "terraform"), { recursive: true });
  await mkdir(lambdaDir, { recursive: true });

  await writeFile(
    join(repoRoot, "scripts/package-lambdas.sh"),
    `handlers=(\n  "dist/createItem.js:${zipName}"\n)\n`
  );
  await writeFile(
    join(repoRoot, "terraform/main.tf"),
    `resource "aws_lambda_function" "create_item" {
  handler       = "${terraformHandler}"
  runtime       = "nodejs22.x"
  filename         = "\${path.module}/../lambdas/${terraformZipName}"
  source_code_hash = filebase64sha256("\${path.module}/../lambdas/${terraformZipName}")
}
`
  );
  await writeFile(
    join(lambdaDir, "package.json"),
    JSON.stringify({ type: "module", dependencies, devDependencies }, null, 2)
  );

  if (writeArtifact) {
    await writeZip(
      join(lambdaDir, zipName),
      zipEntries ?? {
        "package.json": JSON.stringify({ type: "module", dependencies }, null, 2),
        "createItem.js": handlerLine,
        "node_modules/.package-lock.json": "{}",
      }
    );
  }

  return { repoRoot, lambdaDir, manifestPath: join(lambdaDir, "artifacts-manifest.json") };
};

const expectVerificationFails = async (
  options: Awaited<ReturnType<typeof createFixtureRepo>>,
  message: RegExp
) => {
  const { verifyLambdaArtifacts } = await importVerifier();
  await expect(
    verifyLambdaArtifacts({ ...options, minZipBytes: 1 })
  ).rejects.toThrow(message);
};

describe("Lambda artifact verifier failure modes", () => {
  it("fails when a ZIP is missing", async () => {
    await expectVerificationFails(
      await createFixtureRepo({ writeArtifact: false }),
      /Unexpected ZIP inventory|Missing Lambda artifact/
    );
  });

  it("fails when a ZIP is corrupt", async () => {
    const fixture = await createFixtureRepo({ writeArtifact: false });
    await writeFile(join(fixture.lambdaDir, "createItem.zip"), "not a zip");

    await expectVerificationFails(fixture, /not a valid ZIP/);
  });

  it("fails when the handler module is missing", async () => {
    await expectVerificationFails(
      await createFixtureRepo({
        zipEntries: {
          "package.json": JSON.stringify({ type: "module" }),
          "node_modules/.package-lock.json": "{}",
        },
      }),
      /missing handler module/
    );
  });

  it("fails when the handler export is missing", async () => {
    await expectVerificationFails(
      await createFixtureRepo({ handlerLine: "export const notHandler = 1;" }),
      /not a function/
    );
  });

  it("fails when a runtime dependency cannot resolve", async () => {
    await expectVerificationFails(
      await createFixtureRepo({ dependencies: { zod: "4.4.3" } }),
      /Runtime dependency cannot be resolved/
    );
  });

  it("fails when a forbidden dev dependency is packaged", async () => {
    await expectVerificationFails(
      await createFixtureRepo({
        devDependencies: { vitest: "2.1.9" },
        zipEntries: {
          "package.json": JSON.stringify({ type: "module" }),
          "createItem.js": "export const handler = async () => {};",
          "node_modules/vitest/package.json": "{}",
        },
      }),
      /devDependency vitest/
    );
  });

  it("fails when manifest checksum verification mismatches", async () => {
    const fixture = await createFixtureRepo({});
    const { verifyLambdaArtifacts, verifyManifestMatches } = await importVerifier();
    const manifest = await verifyLambdaArtifacts({ ...fixture, minZipBytes: 1 });
    const badManifest = {
      ...manifest,
      artifacts: [{ ...manifest.artifacts[0], sha256: "0".repeat(64) }],
    };
    await writeFile(fixture.manifestPath, `${JSON.stringify(badManifest, null, 2)}\n`);

    await expect(
      verifyManifestMatches(fixture.manifestPath, manifest.artifacts)
    ).rejects.toThrow(/sha256 mismatch/);
  });

  it("fails when an unexpected extra artifact is present", async () => {
    const fixture = await createFixtureRepo({});
    await writeZip(join(fixture.lambdaDir, "oldItem.zip"), {
      "package.json": "{}",
      "oldItem.js": "export const handler = async () => {};",
    });

    await expectVerificationFails(fixture, /Unexpected ZIP inventory/);
  });

  it("fails when Terraform filename differs from packaging output", async () => {
    await expectVerificationFails(
      await createFixtureRepo({ terraformZipName: "other.zip" }),
      /Packaging\/Terraform ZIP mismatch/
    );
  });

  it("fails when Terraform handler differs from packaging output", async () => {
    await expectVerificationFails(
      await createFixtureRepo({ terraformHandler: "other.handler" }),
      /does not match packaging handler/
    );
  });
});

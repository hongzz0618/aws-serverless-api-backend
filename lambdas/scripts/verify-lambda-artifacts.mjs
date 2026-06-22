import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import yauzl from "yauzl";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, "../..");
const DEFAULT_MIN_ZIP_BYTES = 10_000;
const EXPECTED_RUNTIME = "nodejs22.x";
const execFileAsync = promisify(execFile);
const SENSITIVE_ENTRY_PATTERNS = [
  /^\.git(?:\/|$)/,
  /(?:^|\/)\.env(?:$|\.)/,
  /\.tfstate(?:\.|$)/,
  /\.tfplan$/,
  /(?:^|\/)__tests__(?:\/|$)/,
  /(?:^|\/)tests(?:\/|$)/,
  /artifacts-manifest\.json$/,
  /^package-lock\.json$/,
];

export class ArtifactVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArtifactVerificationError";
  }
}

const fail = (message) => {
  throw new ArtifactVerificationError(message);
};

const assert = (condition, message) => {
  if (!condition) {
    fail(message);
  }
};

const readText = async (path) => fs.readFile(path, "utf8");

const stripCommentOnlyLines = (source) =>
  source
    .split(/\r?\n/)
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join("\n");

const unique = (values, label) => {
  const seen = new Set();
  const duplicates = [];
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.push(value);
    }
    seen.add(value);
  }
  assert(duplicates.length === 0, `Duplicate ${label}: ${duplicates.join(", ")}`);
};

const extractArrayBlock = (source, label) => {
  const match = source.match(new RegExp(`${label}=\\(\\s*([\\s\\S]*?)\\n\\)`, "m"));
  assert(match, `Could not parse ${label} block from packaging script`);
  return match[1];
};

export const parsePackagingScript = async (repoRoot) => {
  const source = await readText(join(repoRoot, "scripts/package-lambdas.sh"));
  const handlersBlock = stripCommentOnlyLines(extractArrayBlock(source, "handlers"));
  const entries = [...handlersBlock.matchAll(/"([^":]+):([^"]+)"/g)].map((match) => ({
    compiledHandler: match[1],
    zipFilename: match[2],
    handlerModule: basename(match[1]),
  }));

  assert(entries.length > 0, "Packaging script did not declare any handlers");
  unique(
    entries.map((entry) => entry.zipFilename),
    "packaging ZIP filename"
  );
  return entries;
};

const extractTerraformBlocks = (source, type) => {
  const blocks = [];
  const pattern = new RegExp(`resource\\s+"${type}"\\s+"([^"]+)"\\s+\\{`, "g");
  let match;

  while ((match = pattern.exec(source))) {
    let index = pattern.lastIndex;
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
    assert(depth === 0, `Could not parse Terraform ${type}.${match[1]}`);
    blocks.push({ name: match[1], body: source.slice(pattern.lastIndex, index - 1) });
  }

  return blocks;
};

const terraformAttr = (body, name) =>
  body.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, "m"))?.[1]?.trim();

const unquote = (value) => value?.replace(/^"|"$/g, "");

const terraformZipBasename = (value) => {
  const match = unquote(value)?.match(/^\$\{path\.module\}\/\.\.\/lambdas\/([^/]+\.zip)$/);
  return match?.[1];
};

export const parseTerraformLambdas = async (repoRoot) => {
  const source = stripCommentOnlyLines(await readText(join(repoRoot, "terraform/main.tf")));
  const lambdas = extractTerraformBlocks(source, "aws_lambda_function").map((block) => {
    const handler = unquote(terraformAttr(block.body, "handler"));
    const runtime = unquote(terraformAttr(block.body, "runtime"));
    const filenameRaw = terraformAttr(block.body, "filename");
    const hashRaw = terraformAttr(block.body, "source_code_hash");
    const zipFilename = terraformZipBasename(filenameRaw);
    const hashZip = hashRaw?.match(/^filebase64sha256\("\$\{path\.module\}\/\.\.\/lambdas\/([^/]+\.zip)"\)$/)?.[1];

    assert(handler, `Terraform lambda ${block.name} is missing handler`);
    assert(runtime, `Terraform lambda ${block.name} is missing runtime`);
    assert(
      runtime === EXPECTED_RUNTIME,
      `Terraform lambda ${block.name} runtime ${runtime} does not match ${EXPECTED_RUNTIME}`
    );
    assert(zipFilename, `Terraform lambda ${block.name} has unsupported filename: ${filenameRaw}`);
    assert(hashZip, `Terraform lambda ${block.name} is missing supported source_code_hash`);
    assert(
      hashZip === zipFilename,
      `Terraform lambda ${block.name} source_code_hash does not match filename`
    );

    const [handlerName, exportName, extra] = handler.split(".");
    assert(handlerName && exportName && !extra, `Unsupported Terraform handler: ${handler}`);

    return {
      lambdaResource: block.name,
      terraformHandler: handler,
      handlerModule: `${handlerName}.js`,
      handlerExport: exportName,
      runtime,
      zipFilename,
    };
  });

  assert(lambdas.length > 0, "No Terraform Lambda functions found");
  unique(
    lambdas.map((lambda) => lambda.zipFilename),
    "Terraform ZIP filename"
  );
  unique(
    lambdas.map((lambda) => lambda.terraformHandler),
    "Terraform handler"
  );
  return lambdas;
};

const listZipEntries = (zipPath) =>
  new Promise((resolveEntries, rejectEntries) => {
    yauzl.open(zipPath, { lazyEntries: true, validateEntrySizes: true }, (openErr, zipFile) => {
      if (openErr) {
        rejectEntries(openErr);
        return;
      }

      const entries = [];
      zipFile.on("entry", (entry) => {
        entries.push(entry.fileName);
        zipFile.readEntry();
      });
      zipFile.on("end", () => resolveEntries(entries));
      zipFile.on("error", rejectEntries);
      zipFile.readEntry();
    });
  });

const isUnsafeEntry = (entry) =>
  entry.includes("..") ||
  entry.startsWith("/") ||
  /^[A-Za-z]:/.test(entry) ||
  entry.split("/").some((part) => part === "..");

const extractZip = (zipPath, destination) =>
  new Promise((resolveExtract, rejectExtract) => {
    yauzl.open(zipPath, { lazyEntries: true, validateEntrySizes: true }, (openErr, zipFile) => {
      if (openErr) {
        rejectExtract(openErr);
        return;
      }

      zipFile.on("entry", (entry) => {
        if (isUnsafeEntry(entry.fileName)) {
          rejectExtract(new Error(`Unsafe ZIP entry: ${entry.fileName}`));
          return;
        }

        const outputPath = join(destination, entry.fileName);
        if (entry.fileName.endsWith("/")) {
          fs.mkdir(outputPath, { recursive: true })
            .then(() => zipFile.readEntry())
            .catch(rejectExtract);
          return;
        }

        zipFile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) {
            rejectExtract(streamErr);
            return;
          }

          fs.mkdir(dirname(outputPath), { recursive: true })
            .then(
              () =>
                new Promise((resolveStream, rejectStream) => {
                  const writeStream = createWriteStream(outputPath);
                  stream.pipe(writeStream);
                  writeStream.on("finish", resolveStream);
                  writeStream.on("error", rejectStream);
                  stream.on("error", rejectStream);
                })
            )
            .then(() => zipFile.readEntry())
            .catch(rejectExtract);
        });
      });
      zipFile.on("end", resolveExtract);
      zipFile.on("error", rejectExtract);
      zipFile.readEntry();
    });
  });

const sha256File = async (path) => {
  const bytes = await fs.readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
};

const dependencyPathPrefix = (dependency) => {
  const parts = dependency.split("/");
  return dependency.startsWith("@")
    ? `node_modules/${parts[0]}/${parts[1]}/`
    : `node_modules/${dependency}/`;
};

const verifyNoForbiddenEntries = (entries, devDependencies) => {
  for (const entry of entries) {
    assert(!isUnsafeEntry(entry), `ZIP contains unsafe entry: ${entry}`);
    assert(
      !SENSITIVE_ENTRY_PATTERNS.some((pattern) => pattern.test(entry)),
      `ZIP contains forbidden sensitive or generated entry: ${entry}`
    );
  }

  for (const dependency of devDependencies) {
    const pathPrefix = dependencyPathPrefix(dependency);
    assert(
      !entries.some((entry) => entry.startsWith(pathPrefix)),
      `ZIP contains devDependency ${dependency}`
    );
  }
};

const verifyRuntimePackageMetadata = async (extractDir) => {
  const artifactPackage = JSON.parse(await readText(join(extractDir, "package.json")));
  assert(
    !artifactPackage.devDependencies,
    "Artifact package.json must not include devDependencies"
  );
};

const verifyRuntimeLoadInChildProcess = async (extractDir, lambda, runtimeDependencies) => {
  const moduleUrl = pathToFileURL(join(extractDir, lambda.handlerModule)).href;
  const probe = `
    import { createRequire } from "node:module";
    const requireFromArtifact = createRequire(new URL("./package.json", import.meta.url));
    const runtimeDependencies = JSON.parse(process.argv[1]);
    for (const dependency of runtimeDependencies) {
      requireFromArtifact.resolve(dependency);
    }
    const module = await import(${JSON.stringify(moduleUrl)});
    if (typeof module[${JSON.stringify(lambda.handlerExport)}] !== "function") {
      throw new Error("Handler export is not a function");
    }
  `;

  try {
    const env = { ...process.env };
    delete env.NODE_PATH;
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", probe, JSON.stringify(runtimeDependencies)], {
      cwd: extractDir,
      env,
      windowsHide: true,
      timeout: 10_000,
    });
  } catch (error) {
    fail(`Could not load handler module ${lambda.handlerModule} from artifact: ${error.message}`);
  }
};

export const verifyManifestMatches = async (manifestPath, actualArtifacts) => {
  const manifest = JSON.parse(await readText(manifestPath));
  const expectedByArtifact = new Map(
    actualArtifacts.map((artifact) => [artifact.artifact, artifact])
  );
  const manifestArtifacts = manifest.artifacts ?? [];
  unique(
    manifestArtifacts.map((artifact) => artifact.artifact),
    "manifest artifact"
  );
  assert(
    manifestArtifacts.length === actualArtifacts.length,
    "Manifest artifact count does not match generated artifacts"
  );

  for (const artifact of manifestArtifacts) {
    const actual = expectedByArtifact.get(artifact.artifact);
    assert(actual, `Manifest references unknown artifact ${artifact.artifact}`);
    for (const field of ["sha256", "sizeBytes", "terraformHandler", "handlerModule"]) {
      assert(
        artifact[field] === actual[field],
        `Manifest ${artifact.artifact} ${field} mismatch`
      );
    }
  }
};

export const verifyLambdaArtifacts = async ({
  repoRoot = defaultRepoRoot,
  lambdaDir = join(repoRoot, "lambdas"),
  manifestPath = join(lambdaDir, "artifacts-manifest.json"),
  minZipBytes = DEFAULT_MIN_ZIP_BYTES,
  writeManifest = true,
} = {}) => {
  const packagingEntries = await parsePackagingScript(repoRoot);
  const terraformLambdas = await parseTerraformLambdas(repoRoot);
  const packageJson = JSON.parse(await readText(join(lambdaDir, "package.json")));
  const runtimeDependencies = Object.keys(packageJson.dependencies ?? {});
  const devDependencies = Object.keys(packageJson.devDependencies ?? {});

  const packagingZips = packagingEntries.map((entry) => entry.zipFilename).sort();
  const terraformZips = terraformLambdas.map((lambda) => lambda.zipFilename).sort();
  assert(
    JSON.stringify(packagingZips) === JSON.stringify(terraformZips),
    `Packaging/Terraform ZIP mismatch: packaging=${packagingZips.join(", ")} terraform=${terraformZips.join(", ")}`
  );

  for (const entry of packagingEntries) {
    const terraform = terraformLambdas.find((lambda) => lambda.zipFilename === entry.zipFilename);
    assert(terraform, `Packaging creates ZIP not referenced by Terraform: ${entry.zipFilename}`);
    assert(
      terraform.handlerModule === entry.handlerModule,
      `Terraform handler ${terraform.terraformHandler} does not match packaging handler ${entry.compiledHandler}`
    );
  }

  const actualZipFiles = (await fs.readdir(lambdaDir))
    .filter((name) => name.endsWith(".zip"))
    .sort();
  assert(
    JSON.stringify(actualZipFiles) === JSON.stringify(terraformZips),
    `Unexpected ZIP inventory: actual=${actualZipFiles.join(", ")} expected=${terraformZips.join(", ")}`
  );

  const tempRoot = await fs.mkdtemp(join(tmpdir(), "lambda-artifacts-"));
  const manifestArtifacts = [];

  try {
    for (const lambda of terraformLambdas.sort((a, b) => a.zipFilename.localeCompare(b.zipFilename))) {
      const zipPath = join(lambdaDir, lambda.zipFilename);
      const stat = await fs.stat(zipPath).catch(() => null);
      assert(stat?.isFile(), `Missing Lambda artifact: ${lambda.zipFilename}`);
      assert(
        stat.size >= minZipBytes,
        `Lambda artifact ${lambda.zipFilename} is too small to be a real package`
      );

      let entries;
      try {
        entries = await listZipEntries(zipPath);
      } catch (error) {
        fail(`Lambda artifact ${lambda.zipFilename} is not a valid ZIP: ${error.message}`);
      }

      assert(entries.includes(lambda.handlerModule), `ZIP missing handler module ${lambda.handlerModule}`);
      assert(entries.includes("package.json"), "ZIP missing package.json");
      assert(entries.some((entry) => entry.startsWith("node_modules/")), "ZIP missing node_modules");
      verifyNoForbiddenEntries(entries, devDependencies);

      const extractDir = join(tempRoot, lambda.zipFilename.replace(/\.zip$/, ""));
      await fs.mkdir(extractDir, { recursive: true });
      try {
        await extractZip(zipPath, extractDir);
      } catch (error) {
        fail(`Could not extract ${lambda.zipFilename}: ${error.message}`);
      }

      await verifyRuntimePackageMetadata(extractDir);
      await verifyRuntimeLoadInChildProcess(extractDir, lambda, runtimeDependencies);

      manifestArtifacts.push({
        artifact: lambda.zipFilename,
        sha256: await sha256File(zipPath),
        sizeBytes: stat.size,
        terraformHandler: lambda.terraformHandler,
        handlerModule: lambda.handlerModule,
        runtime: lambda.runtime,
        fileCount: entries.length,
      });
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  const manifest = {
    schemaVersion: 1,
    generatedBy: "npm run artifacts:verify",
    artifacts: manifestArtifacts,
  };

  if (writeManifest) {
    await fs.writeFile(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.rename(`${manifestPath}.tmp`, manifestPath);
    await verifyManifestMatches(manifestPath, manifestArtifacts);
  }

  return manifest;
};

const isCli = fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");

if (isCli) {
  try {
    const manifest = await verifyLambdaArtifacts();
    for (const artifact of manifest.artifacts) {
      console.log(
        `${artifact.artifact} ${artifact.sha256} ${artifact.sizeBytes} ${artifact.terraformHandler}`
      );
    }
    console.log("Lambda artifact verification passed.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

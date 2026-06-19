const apiUrl = process.env.API_URL?.trim();

if (!apiUrl) {
  console.error("[smoke] API_URL is required.");
  console.error("[smoke] Example: API_URL=https://example.execute-api.us-east-1.amazonaws.com/dev npm run smoke:test");
  process.exit(1);
}

const baseUrl = apiUrl.replace(/\/+$/, "");
const itemName = `Smoke test item ${new Date().toISOString()}`;
const updatedItemName = `${itemName} updated`;
let createdItemId;

const requestJson = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });

  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return { response, body };
};

const assertStatus = (step, response, expectedStatus) => {
  if (response.status !== expectedStatus) {
    throw new Error(`${step} expected ${expectedStatus}, received ${response.status}`);
  }
};

const assertObject = (step, body) => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error(`${step} returned an invalid JSON object`);
  }
};

const assertField = (step, field, actual, expected) => {
  if (actual !== expected) {
    throw new Error(`${step} expected ${field} to be ${expected}, received ${actual}`);
  }
};

const assertNonEmptyString = (step, field, value) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${step} did not return a non-empty ${field}`);
  }
};

const cleanupCreatedItem = async () => {
  if (!createdItemId) {
    return;
  }

  try {
    await requestJson(`/items/${createdItemId}`, { method: "DELETE" });
  } catch {
    console.error(`[smoke] Cleanup failed for item ${createdItemId}`);
  }
};

try {
  console.log("[smoke] Creating item");
  const createResult = await requestJson("/items", {
    method: "POST",
    body: JSON.stringify({ name: itemName }),
  });
  assertStatus("Create item", createResult.response, 201);
  assertObject("Create item", createResult.body);

  assertNonEmptyString("Create item", "id", createResult.body.id);
  assertField("Create item", "version", createResult.body.version, 1);
  createdItemId = createResult.body.id;
  console.log(`[smoke] Created item ${createdItemId}`);

  console.log("[smoke] Reading item");
  const getResult = await requestJson(`/items/${createdItemId}`);
  assertStatus("Read item", getResult.response, 200);
  assertObject("Read item", getResult.body);

  assertField("Read item", "id", getResult.body.id, createdItemId);
  assertField("Read item", "name", getResult.body.name, itemName);
  assertField("Read item", "version", getResult.body.version, 1);

  console.log("[smoke] Updating item");
  const updateResult = await requestJson(`/items/${createdItemId}`, {
    method: "PUT",
    body: JSON.stringify({ name: updatedItemName, version: 1 }),
  });
  assertStatus("Update item", updateResult.response, 200);
  assertObject("Update item", updateResult.body);
  assertField("Update item", "id", updateResult.body.id, createdItemId);
  assertField("Update item", "name", updateResult.body.name, updatedItemName);
  assertField("Update item", "version", updateResult.body.version, 2);

  console.log("[smoke] Reading updated item");
  const getUpdatedResult = await requestJson(`/items/${createdItemId}`);
  assertStatus("Read updated item", getUpdatedResult.response, 200);
  assertObject("Read updated item", getUpdatedResult.body);
  assertField("Read updated item", "id", getUpdatedResult.body.id, createdItemId);
  assertField("Read updated item", "name", getUpdatedResult.body.name, updatedItemName);
  assertField("Read updated item", "version", getUpdatedResult.body.version, 2);

  console.log("[smoke] Verifying stale update conflict");
  const staleUpdateResult = await requestJson(`/items/${createdItemId}`, {
    method: "PUT",
    body: JSON.stringify({ name: "Stale update should fail", version: 1 }),
  });
  assertStatus("Stale update", staleUpdateResult.response, 409);

  console.log("[smoke] Deleting item");
  const deleteResult = await requestJson(`/items/${createdItemId}`, {
    method: "DELETE",
  });
  assertStatus("Delete item", deleteResult.response, 200);
  assertObject("Delete item", deleteResult.body);

  if (deleteResult.body.id !== createdItemId) {
    throw new Error("Delete item response did not match the created item");
  }

  console.log("[smoke] Verifying deleted item is gone");
  const getDeletedResult = await requestJson(`/items/${createdItemId}`);
  assertStatus("Read deleted item", getDeletedResult.response, 404);

  createdItemId = undefined;
  console.log("[smoke] Passed");
} catch (error) {
  await cleanupCreatedItem();
  console.error(`[smoke] Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

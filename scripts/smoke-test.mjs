const apiUrl = process.env.API_URL?.trim();

if (!apiUrl) {
  console.error("[smoke] API_URL is required.");
  console.error("[smoke] Example: API_URL=https://example.execute-api.us-east-1.amazonaws.com/dev npm run smoke:test");
  process.exit(1);
}

const baseUrl = apiUrl.replace(/\/+$/, "");
const itemName = `Smoke test item ${new Date().toISOString()}`;
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

  if (typeof createResult.body.id !== "string" || createResult.body.id.length === 0) {
    throw new Error("Create item did not return an item id");
  }

  createdItemId = createResult.body.id;
  console.log(`[smoke] Created item ${createdItemId}`);

  console.log("[smoke] Reading item");
  const getResult = await requestJson(`/items/${createdItemId}`);
  assertStatus("Read item", getResult.response, 200);
  assertObject("Read item", getResult.body);

  if (getResult.body.id !== createdItemId || getResult.body.name !== itemName) {
    throw new Error("Read item response did not match the created item");
  }

  console.log("[smoke] Deleting item");
  const deleteResult = await requestJson(`/items/${createdItemId}`, {
    method: "DELETE",
  });
  assertStatus("Delete item", deleteResult.response, 200);
  assertObject("Delete item", deleteResult.body);

  if (deleteResult.body.id !== createdItemId) {
    throw new Error("Delete item response did not match the created item");
  }

  createdItemId = undefined;
  console.log("[smoke] Passed");
} catch (error) {
  await cleanupCreatedItem();
  console.error(`[smoke] Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

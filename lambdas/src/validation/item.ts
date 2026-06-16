import { z } from "zod";
import type { Item } from "../types/item.js";
import { parseJson } from "../utils/json.js";

export const ITEM_NAME_MAX_LENGTH = 100;

type ValidationResult<TValue> =
  | {
      ok: true;
      value: TValue;
    }
  | {
      ok: false;
      error: string;
    };

interface CreateItemBody {
  name: string;
}

interface UpdateItemBody {
  name: string;
  version: number;
}

const createItemBodySchema = z.object({
  name: z
    .string({ error: "Name must be a string" })
    .trim()
    .min(1, { error: "Name cannot be empty" })
    .max(ITEM_NAME_MAX_LENGTH, {
      error: `Name must be ${ITEM_NAME_MAX_LENGTH} characters or fewer`,
    }),
});

const updateItemBodySchema = createItemBodySchema.extend({
  version: z
    .number({ error: "Version must be a number" })
    .int({ error: "Version must be a positive integer" })
    .positive({ error: "Version must be a positive integer" }),
});

const itemIdSchema = z.uuid({
  error: "Item id must be a valid UUID",
});

const dynamoDbStringAttributeSchema = z.object({
  S: z.string(),
});

const dynamoDbNumberAttributeSchema = z.object({
  N: z.string().regex(/^[1-9]\d*$/),
});

const storedItemSchema = z.object({
  id: dynamoDbStringAttributeSchema,
  name: dynamoDbStringAttributeSchema,
  createdAt: dynamoDbStringAttributeSchema,
  version: dynamoDbNumberAttributeSchema.optional(),
});

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const validateCreateItemBody = (
  body: string | null
): ValidationResult<CreateItemBody> => {
  if (!body) {
    return {
      ok: false,
      error: "Request body is required",
    };
  }

  const parsedBody = parseJson(body);

  if (!parsedBody.ok) {
    return {
      ok: false,
      error: "Request body must be valid JSON",
    };
  }

  if (!isJsonObject(parsedBody.value) || !("name" in parsedBody.value)) {
    return {
      ok: false,
      error: "Name is required",
    };
  }

  const result = createItemBodySchema.safeParse(parsedBody.value);

  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues[0]?.message ?? "Invalid request body",
    };
  }

  return {
    ok: true,
    value: result.data,
  };
};

export const validateUpdateItemBody = (
  body: string | null
): ValidationResult<UpdateItemBody> => {
  if (!body) {
    return {
      ok: false,
      error: "Request body is required",
    };
  }

  const parsedBody = parseJson(body);

  if (!parsedBody.ok) {
    return {
      ok: false,
      error: "Request body must be valid JSON",
    };
  }

  if (!isJsonObject(parsedBody.value) || !("name" in parsedBody.value)) {
    return {
      ok: false,
      error: "Name is required",
    };
  }

  if (!("version" in parsedBody.value)) {
    return {
      ok: false,
      error: "Version is required",
    };
  }

  const result = updateItemBodySchema.safeParse(parsedBody.value);

  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues[0]?.message ?? "Invalid request body",
    };
  }

  return {
    ok: true,
    value: result.data,
  };
};

export const validateItemId = (
  id: string | undefined
): ValidationResult<string> => {
  if (!id) {
    return {
      ok: false,
      error: "Item id is required",
    };
  }

  const result = itemIdSchema.safeParse(id);

  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues[0]?.message ?? "Invalid item id",
    };
  }

  return {
    ok: true,
    value: result.data,
  };
};

export const parseStoredItem = (item: unknown): ValidationResult<Item> => {
  const result = storedItemSchema.safeParse(item);

  if (!result.success) {
    return {
      ok: false,
      error: "Stored item has an invalid shape",
    };
  }

  return {
    ok: true,
    value: {
      id: result.data.id.S,
      name: result.data.name.S,
      createdAt: result.data.createdAt.S,
      version: result.data.version ? Number(result.data.version.N) : 1,
    },
  };
};

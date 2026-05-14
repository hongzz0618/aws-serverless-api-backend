import { z } from "zod";
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

const createItemBodySchema = z.object({
  name: z
    .string({ error: "Name must be a string" })
    .trim()
    .min(1, { error: "Name cannot be empty" })
    .max(ITEM_NAME_MAX_LENGTH, {
      error: `Name must be ${ITEM_NAME_MAX_LENGTH} characters or fewer`,
    }),
});

const itemIdSchema = z.uuid({
  error: "Item id must be a valid UUID",
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

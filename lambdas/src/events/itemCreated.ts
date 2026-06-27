import { z } from "zod";
import { ITEM_NAME_MAX_LENGTH } from "../validation/item.js";

const itemCreatedEventIdPrefix = "item.created.v1:";
const uuidSchema = z.uuid();

export const createItemCreatedEventId = (itemId: string): string =>
  `${itemCreatedEventIdPrefix}${itemId}`;

export const itemCreatedEventV1Schema = z
  .object({
    eventId: z.string().refine(
      (value) => {
        if (!value.startsWith(itemCreatedEventIdPrefix)) {
          return false;
        }

        return uuidSchema.safeParse(value.slice(itemCreatedEventIdPrefix.length))
          .success;
      },
      { error: "Event id must match item.created.v1:<UUID>" }
    ),
    eventType: z.literal("item.created"),
    eventVersion: z.literal(1),
    occurredAt: z.iso.datetime(),
    source: z.literal("serverless-api"),
    data: z
      .object({
        itemId: uuidSchema,
        name: z
          .string()
          .trim()
          .min(1)
          .max(ITEM_NAME_MAX_LENGTH),
      })
      .strict(),
  })
  .strict();

export type ItemCreatedEventV1 = z.infer<typeof itemCreatedEventV1Schema>;

export type ParseItemCreatedEventResult =
  | {
      ok: true;
      value: ItemCreatedEventV1;
    }
  | {
      ok: false;
      error: string;
    };

export const parseItemCreatedEventV1 = (
  input: unknown
): ParseItemCreatedEventResult => {
  const result = itemCreatedEventV1Schema.safeParse(input);

  if (!result.success) {
    return {
      ok: false,
      error: "Invalid item.created v1 event",
    };
  }

  return {
    ok: true,
    value: result.data,
  };
};

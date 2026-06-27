import { describe, expect, it } from "vitest";
import {
  createItemCreatedEventId,
  type ItemCreatedEventV1,
  parseItemCreatedEventV1,
} from "../../src/events/itemCreated.js";
import { ITEM_NAME_MAX_LENGTH } from "../../src/validation/item.js";

const itemId = "550e8400-e29b-41d4-a716-446655440000";

const validEvent = (): ItemCreatedEventV1 => ({
  eventId: `item.created.v1:${itemId}`,
  eventType: "item.created",
  eventVersion: 1,
  occurredAt: "2026-06-27T10:15:30.000Z",
  source: "serverless-api",
  data: {
    itemId,
    name: "Example item",
  },
});

const expectInvalid = (input: unknown): string => {
  const result = parseItemCreatedEventV1(input);

  expect(result.ok).toBe(false);

  if (result.ok) {
    throw new Error("Expected event parsing to fail");
  }

  expect(result.error).toBe("Invalid item.created v1 event");
  return result.error;
};

describe("ItemCreatedEventV1 contract", () => {
  it("parses a valid item.created v1 event", () => {
    const result = parseItemCreatedEventV1(validEvent());

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error("Expected event parsing to succeed");
    }

    const eventType: "item.created" = result.value.eventType;
    const eventVersion: 1 = result.value.eventVersion;

    expect(eventType).toBe("item.created");
    expect(eventVersion).toBe(1);
    expect(result.value).toEqual(validEvent());
  });

  it("trims names using the same create-item name semantics", () => {
    const result = parseItemCreatedEventV1({
      ...validEvent(),
      data: {
        itemId,
        name: "  Example item  ",
      },
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error("Expected event parsing to succeed");
    }

    expect(result.value.data.name).toBe("Example item");
  });

  it("accepts names at the create API maximum length", () => {
    const name = "a".repeat(ITEM_NAME_MAX_LENGTH);
    const result = parseItemCreatedEventV1({
      ...validEvent(),
      data: {
        itemId,
        name,
      },
    });

    expect(result.ok).toBe(true);

    if (!result.ok) {
      throw new Error("Expected event parsing to succeed");
    }

    expect(result.value.data.name).toBe(name);
  });
});

describe("ItemCreatedEventV1 event id validation", () => {
  it("creates a deterministic event id from an item id", () => {
    expect(createItemCreatedEventId(itemId)).toBe(
      `item.created.v1:${itemId}`
    );
    expect(createItemCreatedEventId(itemId)).toBe(
      createItemCreatedEventId(itemId)
    );
  });

  it("creates different event ids for different item ids", () => {
    const otherItemId = "660e8400-e29b-41d4-a716-446655440000";

    expect(createItemCreatedEventId(otherItemId)).not.toBe(
      createItemCreatedEventId(itemId)
    );
  });

  it("creates event ids that satisfy the event schema", () => {
    const result = parseItemCreatedEventV1({
      ...validEvent(),
      eventId: createItemCreatedEventId(itemId),
    });

    expect(result.ok).toBe(true);
  });

  it("accepts the item.created.v1 UUID event id format", () => {
    const result = parseItemCreatedEventV1(validEvent());

    expect(result.ok).toBe(true);
  });

  it("rejects an event id with the wrong prefix", () => {
    expectInvalid({
      ...validEvent(),
      eventId: `item.updated.v1:${itemId}`,
    });
  });

  it("rejects an event id missing the UUID", () => {
    expectInvalid({
      ...validEvent(),
      eventId: "item.created.v1:",
    });
  });

  it("rejects an event id with an invalid UUID suffix", () => {
    expectInvalid({
      ...validEvent(),
      eventId: "item.created.v1:not-a-uuid",
    });
  });

  it("rejects an arbitrary string event id", () => {
    expectInvalid({
      ...validEvent(),
      eventId: "event-123",
    });
  });
});

describe("ItemCreatedEventV1 metadata validation", () => {
  it("rejects an unsupported event type", () => {
    expectInvalid({
      ...validEvent(),
      eventType: "item.deleted",
    });
  });

  it("rejects an unsupported event version", () => {
    expectInvalid({
      ...validEvent(),
      eventVersion: 2,
    });
  });

  it("rejects a string event version", () => {
    expectInvalid({
      ...validEvent(),
      eventVersion: "1",
    });
  });

  it("rejects an unsupported source", () => {
    expectInvalid({
      ...validEvent(),
      source: "other-service",
    });
  });

  it("rejects a non-ISO datetime", () => {
    expectInvalid({
      ...validEvent(),
      occurredAt: "June 27, 2026",
    });
  });
});

describe("ItemCreatedEventV1 data validation", () => {
  it("rejects missing itemId", () => {
    const { itemId: _itemId, ...dataWithoutItemId } = validEvent().data;

    expectInvalid({
      ...validEvent(),
      data: dataWithoutItemId,
    });
  });

  it("rejects an invalid itemId UUID", () => {
    expectInvalid({
      ...validEvent(),
      data: {
        ...validEvent().data,
        itemId: "not-a-uuid",
      },
    });
  });

  it("rejects missing name", () => {
    const { name: _name, ...dataWithoutName } = validEvent().data;

    expectInvalid({
      ...validEvent(),
      data: dataWithoutName,
    });
  });

  it("rejects an empty name", () => {
    expectInvalid({
      ...validEvent(),
      data: {
        ...validEvent().data,
        name: "",
      },
    });
  });

  it("rejects a whitespace-only name", () => {
    expectInvalid({
      ...validEvent(),
      data: {
        ...validEvent().data,
        name: "   ",
      },
    });
  });

  it("rejects a name longer than the create API maximum", () => {
    expectInvalid({
      ...validEvent(),
      data: {
        ...validEvent().data,
        name: "a".repeat(ITEM_NAME_MAX_LENGTH + 1),
      },
    });
  });
});

describe("ItemCreatedEventV1 strict schema validation", () => {
  it("rejects top-level extra fields", () => {
    expectInvalid({
      ...validEvent(),
      extra: "not allowed",
    });
  });

  it("rejects data extra fields", () => {
    expectInvalid({
      ...validEvent(),
      data: {
        ...validEvent().data,
        extra: "not allowed",
      },
    });
  });
});

describe("ItemCreatedEventV1 invalid input shape", () => {
  it("rejects null", () => {
    expectInvalid(null);
  });

  it("rejects strings", () => {
    expectInvalid("not an event");
  });

  it("rejects arrays", () => {
    expectInvalid([validEvent()]);
  });

  it("rejects empty objects", () => {
    expectInvalid({});
  });
});

describe("ItemCreatedEventV1 safe parse errors", () => {
  it("does not expose the original payload or sensitive values", () => {
    const sensitiveValue = "secret-token-should-not-appear";
    const error = expectInvalid({
      ...validEvent(),
      eventId: sensitiveValue,
      data: {
        ...validEvent().data,
        name: sensitiveValue,
      },
    });

    expect(error).not.toContain(sensitiveValue);
    expect(error).not.toContain("eventId");
    expect(error).not.toContain("name");
  });
});

import { createHash } from "node:crypto";

interface CreateItemFingerprintInput {
  name: string;
}

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const createItemRequestFingerprint = ({
  name,
}: CreateItemFingerprintInput): string =>
  sha256Hex(JSON.stringify({ name }));

export const idempotencyKeyCorrelation = (key: string): string =>
  sha256Hex(key).slice(0, 12);

export interface Item {
  id: string;
  name: string;
  createdAt: string;
  version: number;
}

export type DynamoDBStringAttribute = {
  S: string;
};

export type DynamoDBNumberAttribute = {
  N: string;
};

export type DynamoDBMapAttribute = {
  M: Record<string, DynamoDBStringAttribute | DynamoDBNumberAttribute>;
};

type DynamoDBAttribute =
  | DynamoDBStringAttribute
  | DynamoDBNumberAttribute
  | DynamoDBMapAttribute;

export type StoredItem = {
  id: DynamoDBStringAttribute;
  name: DynamoDBStringAttribute;
  createdAt: DynamoDBStringAttribute;
  version: DynamoDBNumberAttribute;
  processingStatus?: DynamoDBStringAttribute;
  processedEventId?: DynamoDBStringAttribute;
  processedAt?: DynamoDBStringAttribute;
  creationMetadata?: DynamoDBMapAttribute;
} & Record<string, DynamoDBAttribute>;

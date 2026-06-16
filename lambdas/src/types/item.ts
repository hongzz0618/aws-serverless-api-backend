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

type DynamoDBAttribute = DynamoDBStringAttribute | DynamoDBNumberAttribute;

export type StoredItem = {
  id: DynamoDBStringAttribute;
  name: DynamoDBStringAttribute;
  createdAt: DynamoDBStringAttribute;
  version: DynamoDBNumberAttribute;
} & Record<string, DynamoDBAttribute>;

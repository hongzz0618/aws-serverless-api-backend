export interface Item {
  id: string;
  name: string;
  createdAt: string;
}

export type DynamoDBStringAttribute = {
  S: string;
};

export type StoredItem = Record<keyof Item, DynamoDBStringAttribute>;

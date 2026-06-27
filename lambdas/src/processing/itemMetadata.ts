export type CreationMetadata = {
  normalizedName: string;
  nameLength: number;
};

export const createCreationMetadata = (name: string): CreationMetadata => ({
  normalizedName: name.normalize("NFKC").toLowerCase(),
  nameLength: Array.from(name).length,
});

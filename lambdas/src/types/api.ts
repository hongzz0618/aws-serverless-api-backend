export interface ApiErrorResponse {
  error: string;
}

export interface CreateItemResponse {
  message: "Item created";
  id: string;
}

export interface DeleteItemResponse {
  message: "Item deleted";
  id: string;
}

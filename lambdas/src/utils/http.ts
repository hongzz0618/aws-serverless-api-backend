import type { APIGatewayProxyResult } from "aws-lambda";
import type { ApiErrorResponse } from "../types/api.js";

const jsonHeaders = {
  "Content-Type": "application/json",
};

export const jsonResponse = <TBody>(
  statusCode: number,
  body: TBody
): APIGatewayProxyResult => ({
  statusCode,
  headers: jsonHeaders,
  body: JSON.stringify(body),
});

export const errorResponse = (
  statusCode: number,
  error: string
): APIGatewayProxyResult =>
  jsonResponse<ApiErrorResponse>(statusCode, { error });

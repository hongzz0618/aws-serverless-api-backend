import type { APIGatewayProxyEventHeaders } from "aws-lambda";

export const getHeaderValue = (
  headers: APIGatewayProxyEventHeaders,
  name: string
): string | undefined => {
  const target = name.toLowerCase();

  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === target) {
      return value;
    }
  }

  return undefined;
};

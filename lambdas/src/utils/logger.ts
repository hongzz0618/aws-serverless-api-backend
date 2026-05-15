import type { Context } from "aws-lambda";

type LogLevel = "info" | "warn" | "error";

type LogValue = string | number | boolean | null | undefined;

export type LogFields = Record<string, LogValue>;

interface LoggerOptions {
  service: string;
  context?: Pick<Context, "awsRequestId">;
  route?: string;
  operation?: string;
}

const serializeError = (error: unknown): Pick<LogFields, "errorName" | "errorMessage"> => {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
    };
  }

  return {
    errorName: "UnknownError",
    errorMessage: String(error),
  };
};

export const createLogger = ({
  service,
  context,
  route,
  operation,
}: LoggerOptions) => {
  const baseFields = {
    service,
    requestId: context?.awsRequestId,
    route,
    operation,
  };

  const write = (
    level: LogLevel,
    message: string,
    fields: LogFields = {},
    error?: unknown
  ) => {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...baseFields,
      ...fields,
      ...(error === undefined ? {} : serializeError(error)),
    };

    const output = JSON.stringify(entry);

    if (level === "error") {
      console.error(output);
      return;
    }

    console.log(output);
  };

  return {
    info: (message: string, fields?: LogFields) => write("info", message, fields),
    warn: (message: string, fields?: LogFields) => write("warn", message, fields),
    error: (message: string, error: unknown, fields?: LogFields) =>
      write("error", message, fields, error),
  };
};

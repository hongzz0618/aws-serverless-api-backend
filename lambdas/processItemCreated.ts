import type { SQSBatchResponse, SQSEvent } from "aws-lambda";

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "warn",
      service: "items-api",
      operation: "processItemCreated",
      message: "Worker placeholder invoked without business processing enabled",
      messageCount: event.Records.length,
    })
  );

  return {
    batchItemFailures: event.Records.map((record) => ({
      itemIdentifier: record.messageId,
    })),
  };
};

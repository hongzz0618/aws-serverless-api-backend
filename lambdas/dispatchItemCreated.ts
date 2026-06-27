import type {
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from "aws-lambda";

const sequenceNumberFailureId = (record: DynamoDBRecord): string =>
  record.dynamodb?.SequenceNumber ?? "";

export const handler = async (
  event: DynamoDBStreamEvent
): Promise<DynamoDBBatchResponse> => {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "warn",
      service: "items-api",
      operation: "dispatchItemCreated",
      message: "Dispatcher placeholder invoked without business processing enabled",
      recordCount: event.Records.length,
    })
  );

  return {
    batchItemFailures: event.Records.map((record) => ({
      itemIdentifier: sequenceNumberFailureId(record),
    })),
  };
};

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
// Resolve the same SDK core that the DynamoDB client uses.
const requireFromDynamoDB = createRequire(require.resolve("@aws-sdk/client-dynamodb"));
const { parseXmlBody, parseXmlErrorBody } = requireFromDynamoDB("@aws-sdk/core/protocols");

describe("AWS SDK XML compatibility", () => {
  it("decodes a response while preserving string values and significant whitespace", async () => {
    const body = Buffer.from(`<?xml version="1.0"?>
<ReceiveMessageResponse xmlns="http://queue.amazonaws.com/doc/2012-11-05/">
  <ReceiveMessageResult>
    <Message>
      <MessageId>00123</MessageId>
      <Body>  A &amp; B &lt; C &#xD;&#10;  </Body>
    </Message>
  </ReceiveMessageResult>
</ReceiveMessageResponse>`);

    await expect(parseXmlBody(body, {})).resolves.toMatchObject({
      ReceiveMessageResult: {
        Message: { MessageId: "00123", Body: "  A & B < C \r\n  " },
      },
    });
  });

  it("extracts the error code and normalizes the decoded error message", async () => {
    const body = Buffer.from(`<ErrorResponse>
  <Error>
    <Type>Sender</Type>
    <Code>AccessDenied</Code>
    <Message>  Access to &quot;items&quot; &amp; its records was denied.  </Message>
  </Error>
  <RequestId>example-request-id</RequestId>
</ErrorResponse>`);

    await expect(parseXmlErrorBody(body, {})).resolves.toMatchObject({
      Error: {
        Code: "AccessDenied",
        message: '  Access to "items" & its records was denied.  ',
      },
      RequestId: "example-request-id",
    });
  });
});

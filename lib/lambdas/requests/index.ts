import { APIGatewayProxyEvent } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const region = process.env.REGION as string;
const tableName = process.env.TABLE_NAME as string;
const ddbClient = new DynamoDBClient({ region });

function toLambdaOutput(statusCode: number, body: any) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    isBase64Encoded: false
  };
}

export const handler = async (event: APIGatewayProxyEvent) =>  {
  console.log(event)
  const requestId = uuidv4()
  console.log(`Generated uuid ${requestId}`)
  
  const params = {
    TableName: tableName,
    Item: {
      requestId: { S: requestId },
      filesToConvert: { N: "1" }, // TODO query param from event + validation
      presignedUrls: { N: "0" },
      uploadedFiles: { N: "0" },
      convertedFiles: { N: "0" },
      state: { S: "CREATED" },
      createdAt: { S: new Date().toISOString() },
      modifiedAt: { S: new Date().toISOString() },
    },
  };

  try {
    const data = await ddbClient.send(new PutItemCommand(params));
    console.log("Success - item added or updated", data);
  } catch (err) {
    // @ts-ignore
    console.log("Error", err.stack);
    return toLambdaOutput(500, { errMessage: "Error while generating requestId" })  
  }

  return toLambdaOutput(200, { requestId })
}
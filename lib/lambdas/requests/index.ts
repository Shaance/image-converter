import { APIGatewayProxyEvent } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { add } from "date-fns"

const region = process.env.REGION as string;
const tableName = process.env.TABLE_NAME as string;
const ddbClient = new DynamoDBClient({ region });

function toLambdaOutput(statusCode: number, body: any) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
    },
    body: JSON.stringify(body),
    isBase64Encoded: false
  };
}

function validateRequest(nbFiles: string) {
  if (isNaN(+nbFiles)) {
    return toLambdaOutput(400, "nbFiles should be a number")
  }

  if (Number(nbFiles) < 1) {
    return toLambdaOutput(400, "nbFiles should be at least 1")
  }

  if (Number(nbFiles) > 50) {
    return toLambdaOutput(400, "nbFiles can't be higher than 50")
  }

  return
}

export const handler = async (event: APIGatewayProxyEvent) =>  {
  console.log(event)
  // API gateway already validated nbFiles presence in queryString
  const nbFiles = event.queryStringParameters!.nbFiles as string
  const errOutput = validateRequest(nbFiles)
  if (!!errOutput) {
    return errOutput
  }

  const requestId = uuidv4()
  console.log(`Generated uuid ${requestId}`)
  
  const params = {
    TableName: tableName,
    Item: {
      requestId: { S: requestId },
      nbFiles: { N: nbFiles },
      presignedUrls: { N: "0" },
      uploadedFiles: { N: "0" },
      convertedFiles: { N: "0" },
      state: { S: "CREATED" },
      createdAt: { S: new Date().toISOString() },
      modifiedAt: { S: new Date().toISOString() },
      expiresAt: { S: add(new Date(), { days: 2 }).toISOString()}
    },
  };

  try {
    const data = await ddbClient.send(new PutItemCommand(params));
    console.log("Success - item added", data);
  } catch (err) {
    // @ts-ignore
    console.log("Error", err.stack);
    return toLambdaOutput(500, { errMessage: "Error while generating requestId" })  
  }

  return toLambdaOutput(200, { requestId })
}
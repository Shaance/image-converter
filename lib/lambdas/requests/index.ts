import { APIGatewayProxyEvent, APIGatewayProxyResultV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { add } from "date-fns"
import { 
  S3Client,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const region = process.env.REGION as string;
const tableName = process.env.TABLE_NAME as string;
const bucketName = process.env.BUCKET_NAME as string;
const ddbClient = new DynamoDBClient({ region });
const s3Client = new S3Client({ region })

interface RequestAPIResponseBody {
  requestId: string
  getObjectSignedUrl: string
}

function toLambdaOutput(statusCode: number, body: any): APIGatewayProxyResultV2 {
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

async function createRequestItem(event: APIGatewayProxyEvent, requestId: string) {
  const nbFiles = event.queryStringParameters!.nbFiles as string
  const sourceIP = event.requestContext.identity.sourceIp
  const now = Math.floor(new Date().getTime() / 1000).toString()
  const expiresAt = Math.floor(add(new Date(), { days: 2 }).getTime() / 1000) // must be in seconds
  const params = {
    TableName: tableName,
    Item: {
      requestId: { S: requestId },
      nbFiles: { N: nbFiles },
      presignedUrls: { N: "0" },
      uploadedFiles: { N: "0" },
      convertedFiles: { N: "0" },
      state: { S: "CREATED" },
      createdAt: { N: now },
      modifiedAt: { N: now },
      expiresAt: { N: expiresAt.toString()},
      sourceIP: { S: sourceIP }
    },
  };

  await ddbClient.send(new PutItemCommand(params));
}

async function handleRequestsRequest(event: APIGatewayProxyEvent): Promise<RequestAPIResponseBody> {
  const requestId = uuidv4()
  await createRequestItem(event, requestId)
  const getCommand = new GetObjectCommand({
    Bucket: bucketName,
    Key: `Archives/${requestId}/converted.zip`,
  });
  const getObjectSignedUrl = await getSignedUrl(s3Client, getCommand, { expiresIn: 600 });
  return {
    requestId,
    getObjectSignedUrl,
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResultV2> => {
  console.log(event)
  // API gateway already validated nbFiles presence in queryString
  const nbFiles = event.queryStringParameters!.nbFiles as string
  const errOutput = validateRequest(nbFiles)
  if (!!errOutput) {
    return errOutput
  }

  try {
    const responseBody = await handleRequestsRequest(event)
    return toLambdaOutput(200, responseBody)
  } catch (err) {
    // @ts-ignore
    console.log("Error", err.stack);
    return toLambdaOutput(500, { errMessage: "Error while generating requestId" })
  }
}
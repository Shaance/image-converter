import { PreSignAPIGatewayProxyEvent } from './@types/PreSignEvent';
import { 
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from 'uuid';
import { APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
import {
  DynamoDBClient,
  GetItemCommand,
  GetItemCommandInput,
  GetItemCommandOutput,
  UpdateItemCommand,
  UpdateItemCommandInput,
  UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
// import { add } from 'date-fns';

const bucketName = process.env.BUCKET_NAME as string;
const region = process.env.REGION as string;
const validTargetMimes = ['image/jpeg', 'image/png'];
const validTargetMimesSet = new Set<string>(validTargetMimes);
const tableName = process.env.TABLE_NAME as string;
const ddbClient = new DynamoDBClient({ region });
const outOfRetries = "OutOfRetries"
const maximumUrlGenerated = "MaxUrlReached"

function toExtension(fileName: string): string {
  return fileName.substring(fileName.lastIndexOf('.'))
}

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

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getRequestItem(requestId: string, projectionExpression: string, consistentRead = false): Promise<GetItemCommandOutput> {
  const params: GetItemCommandInput = {
    TableName: tableName,
    Key: {
      requestId: { S: requestId },
    },
    ProjectionExpression: projectionExpression,
    ConsistentRead: consistentRead
  };
  
  return ddbClient.send(new GetItemCommand(params))
}

// optimistic locking
async function updatePresignUrlCount(requestId: string, retriesLeft = 10, delay = 25): Promise<UpdateItemCommandOutput> {
  if (retriesLeft < 1) {
    retriesLeft = 1
  }
  if (retriesLeft < 1) {
    return Promise.reject(outOfRetries)
  }

  const requestItem = (await getRequestItem(requestId, "modifiedAt, presignedUrls, nbFiles", true)).Item
  const modifiedAt = requestItem?.modifiedAt.S
  const presignedUrls = Number(requestItem?.presignedUrls.N as string)
  const nbFiles = Number(requestItem?.nbFiles.N as string)
  if (presignedUrls > nbFiles) {
    return Promise.reject(maximumUrlGenerated)
  }

  const params: UpdateItemCommandInput = {
    TableName: tableName,
    Key: {
      requestId: { S: requestId },
    },
    UpdateExpression: "ADD #currentCount :n SET #updatedAt = :newChangeMadeAt",
    ExpressionAttributeNames: {
      "#currentCount" : "presignedUrls",
      "#updatedAt" : "modifiedAt",
    },
    ExpressionAttributeValues: {
      ":n" : { N: "1" },
      ":newChangeMadeAt": { S: new Date().toISOString() },
      ":modifiedAtFromItem": { S: modifiedAt as string },
    },
    ConditionExpression: "#updatedAt = :modifiedAtFromItem",
  };

  try {
    return await ddbClient.send(new UpdateItemCommand(params))
  } catch (err) {
    console.log(err)
    delay = delay * 0.8 + Math.random() * delay * 0.2
    console.log(delay)
    await sleep(delay)
    return updatePresignUrlCount(requestId, retriesLeft - 1, delay * 2)
  }
}

async function validateRequest(queryParams: APIGatewayProxyEventQueryStringParameters) {
  const { targetMime, requestId } = queryParams
  
  if (!validTargetMimesSet.has(targetMime!)) {
    return toLambdaOutput(400, `${targetMime} targetMime is not supported, valid values are: ${validTargetMimes}`)
  }

  const requestItem = await getRequestItem(requestId as string, "modifiedAt") // any attribute would do
  if (!requestItem.Item) {
    return toLambdaOutput(400, `requestId ${requestId} does not exist`)
  }

  return
}

export const handler = async (event: PreSignAPIGatewayProxyEvent) =>  {
    console.log(event)
    const errOutput = await validateRequest(event.queryStringParameters!)
    const { fileName, requestId, targetMime } = event.queryStringParameters!;
    
    if (!!errOutput) {
      return errOutput
    }
    
    const nameWithoutExtension = fileName!.substring(0, fileName!.lastIndexOf('.'));
    const extension = toExtension(fileName!);

    const s3Client = new S3Client({ region: region })

    const putParams = {
      Bucket: bucketName,
      Key: `OriginalImages/${requestId}/${uuidv4()}${extension}`,
      Metadata: {
        "original-name": nameWithoutExtension,
        "target-mime": targetMime as string
      },
      // Expires: add(new Date(), {
      //   hours: 1
      // })
    }

    const getParams = {
      Bucket: bucketName,
      Key: `Archives/${requestId}/converted.zip`,
    }
    const getCommand = new GetObjectCommand(getParams);
    const putCommand = new PutObjectCommand(putParams);

    // TODO SSE encryption
    const getObjectSignedUrl = await getSignedUrl(s3Client, getCommand, { expiresIn: 600 });
    const putObjectSignedUrl = await getSignedUrl(s3Client, putCommand, { expiresIn: 600 });
    const responseBody = {
      getObjectSignedUrl,
      putObjectSignedUrl,
    }
    await updatePresignUrlCount(requestId as string)
    return toLambdaOutput(200, responseBody);
}
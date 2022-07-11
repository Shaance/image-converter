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

async function getRequestItem(requestId: string): Promise<GetItemCommandOutput> {
  const params = {
    TableName: tableName,
    Key: {
      requestId: { S: requestId },
    },
    ProjectionExpression: "modifiedAt", // any attribute would do
  };
  
  return ddbClient.send(new GetItemCommand(params))
}

// optimistic locking
async function updatePresignUrlCount(requestId: string, retries = 10): Promise<UpdateItemCommandOutput> {
  if (retries < 1) {
    return Promise.reject("Could not update after retries")
  }

  const modifiedAt = (await getRequestItem(requestId)).Item?.modifiedAt.S

  const params: UpdateItemCommandInput = {
    TableName: tableName,
    Key: {
      requestId: { S: requestId },
    },
    UpdateExpression: "ADD #c :n SET #updatedAt = :newChangeMadeAt",
    ExpressionAttributeNames: {
      "#c" : "presignedUrls",
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
    return updatePresignUrlCount(requestId, retries - 1)
  }
}

async function validateRequest(queryParams: APIGatewayProxyEventQueryStringParameters) {
  const { targetMime, requestId } = queryParams
  
  if (!validTargetMimesSet.has(targetMime!)) {
    return toLambdaOutput(400, `${targetMime} targetMime is not supported, valid values are: ${validTargetMimes}`)
  }

  const requestItem = await getRequestItem(requestId as string)
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
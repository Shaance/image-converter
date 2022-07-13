import { S3SQSEvent, S3EventRecordDetail, S3EventRecord } from "./@types/S3Event";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  PutObjectCommandOutput,
  GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import {
  DynamoDBClient,
  GetItemCommand,
  GetItemCommandInput,
  GetItemCommandOutput,
  UpdateItemCommand,
  UpdateItemCommandInput,
  UpdateItemCommandOutput,
  UpdateItemOutput,
} from "@aws-sdk/client-dynamodb";
import  { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Readable } from "stream";
import { v4 as uuidv4 } from 'uuid';
import { add } from 'date-fns'

const convert = require("heic-convert")

const region = process.env.REGION as string;
const s3Client = new S3Client({ region })
const tableName = process.env.TABLE_NAME as string;
const queueUrl = process.env.QUEUE_URL as string;
const sqsClient = new SQSClient({ region });
const ddbClient = new DynamoDBClient({ region });
const outOfRetries = "OutOfRetries"

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

async function updateCount(requestId: string, countAttribute: string, returnValues: string, retriesLeft = 15, delay = 25): Promise<UpdateItemCommandOutput> {
  if (retriesLeft < 1) {
    retriesLeft = 1
  }
  if (retriesLeft < 1) {
    return Promise.reject(outOfRetries)
  }

  const requestItem = (await getRequestItem(requestId, "modifiedAt")).Item
  const modifiedAt = requestItem?.modifiedAt.S

  const params: UpdateItemCommandInput = {
    TableName: tableName,
    Key: {
      requestId: { S: requestId },
    },
    UpdateExpression: "ADD #currentCount :n SET #updatedAt = :newChangeMadeAt, #state = :state",
    ExpressionAttributeNames: {
      "#currentCount" : countAttribute,
      "#updatedAt" : "modifiedAt",
      "#state" : "state",
    },
    ExpressionAttributeValues: {
      ":n" : { N: "1" },
      ":newChangeMadeAt": { S: new Date().toISOString() },
      ":modifiedAtFromItem": { S: modifiedAt as string },
      ":state": { S: "CONVERTING" },
    },
    ConditionExpression: "#updatedAt = :modifiedAtFromItem",
    ReturnValues: returnValues
  };

  try {
    return await ddbClient.send(new UpdateItemCommand(params))
  } catch (err) {
    console.log(err)
    delay = delay * 0.8 + Math.random() * delay * 0.2
    console.log(delay)
    await sleep(delay)
    return updateCount(requestId, countAttribute, returnValues, retriesLeft - 1, delay * 1.5)
  }
}

function toHeicConvertTargetFormat(mime: string) {
  if (mime === "image/jpeg") {
    return "JPEG"
  } else if (mime === "image/png") {
    return "PNG"
  }

  throw Error(`Can't convert from heic file to ${mime}.`)
}

async function getObjectFrom(bucket: string, key: string): Promise<GetObjectCommandOutput> {
  return s3Client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }))
}

async function putObjectTo(bucket: string, key: string, body: Buffer, originalName: string): Promise<PutObjectCommandOutput> {
  return s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    Metadata: {
      "original-name": originalName,
    },
    Expires: add(new Date(), {
      hours: 1
    })
  }))
}

async function toArrayBuffer(stream: Readable): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', chunk => chunks.push(chunk))
    stream.once('end', () => resolve(Buffer.concat(chunks)))
    stream.once('error', reject)
  })
}

function toNewKey(key: string, targetMime: string) {
  const extension = targetMime.split('/')[1]
  return key
    .substring(0, key.lastIndexOf('.'))
    .replace("OriginalImages", "Converted")
    + '.' + extension;
}

async function pushToQueue(item: UpdateItemOutput, bucketName: string) {
  const convertedFiles = item.Attributes?.convertedFiles.N!
  const nbFiles = item.Attributes?.nbFiles.N!
  const requestId = item.Attributes?.requestId.S!
  const prefix = `Converted/${requestId}`
  if (convertedFiles !== nbFiles) {
    return
  }

  try {
    const params = {
      MessageBody: JSON.stringify({
        requestId,
        bucketName,
        prefix
      }),
      QueueUrl: queueUrl
    };
    const data = await sqsClient.send(new SendMessageCommand(params));
    console.log("Success, message sent. MessageID:", data.MessageId);
    return data; // For unit tests.
  } catch (err) {
    console.log("Error", err);
    return Promise.reject(err)
  }
}

async function uploadConvertedFile(key: string, bucket: string, targetMime: string, requestId: string, originalName: string, outputBuffer: Buffer) {
  const targetKey = toNewKey(key, targetMime)
  await putObjectTo(bucket, targetKey, outputBuffer, originalName)
  const updatedItem = await updateCount(requestId, "convertedFiles", "ALL_NEW")
  await pushToQueue(updatedItem, bucket)
}

async function convertFromS3(record: S3EventRecordDetail) {
  console.log(record)
  const conversionId = uuidv4()
  const bucket = record.bucket.name;
  const key = record.object.key;
  const requestId = key.split('/')[1]

  await updateCount(requestId, "uploadedFiles", "NONE")
  
  const object = await getObjectFrom(bucket, key)
  const targetMime = object.Metadata!["target-mime"];
  const originalName = object.Metadata!["original-name"];
  const buffer = await toArrayBuffer(object.Body as Readable)
  
  console.time(`Conversion-${conversionId}`)
  const outputBuffer = await convert({
    buffer: buffer,
    format: toHeicConvertTargetFormat(targetMime),
    quality: 1
  });
  console.timeEnd(`Conversion-${conversionId}`)

  await uploadConvertedFile(key, bucket, targetMime, requestId, originalName, outputBuffer)
}

export const handler = async function (event: S3SQSEvent) {
  // batch size 1
  const records: S3EventRecord[] = JSON.parse(event.Records[0].body).Records
  try {
    await Promise.all(records.map((record) => {
      return convertFromS3(record.s3)
    }))
  } catch (err) {
    console.log(err)
    return toLambdaOutput(500, `Error during conversion ${err}`)
  }

  return toLambdaOutput(200, "conversion done")
}
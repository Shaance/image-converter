import { SQSEvent } from "./@types/SQSEvent";

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  GetObjectCommandOutput,
  ListObjectsV2CommandOutput,
  PutObjectCommandOutput,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { DynamoDBClient,
  UpdateItemCommand,
  UpdateItemCommandInput,
  UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { Readable, Stream } from "stream";
import * as JSZip from "jszip";
import { add } from "date-fns";

const region = process.env.REGION as string;
const s3Client = new S3Client({ region });
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

async function getObjectFrom(bucket: string, key: string): Promise<GetObjectCommandOutput> {
  return s3Client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }))
}

async function updateStatus(requestId: string, status: string): Promise<UpdateItemCommandOutput> {
  const params: UpdateItemCommandInput = {
    TableName: tableName,
    Key: {
      requestId: { S: requestId },
    },
    UpdateExpression: "SET #updatedAt = :newChangeMadeAt, #state = :state",
    ExpressionAttributeNames: {
      "#updatedAt" : "modifiedAt",
      "#state" : "state",
    },
    ExpressionAttributeValues: {
      ":newChangeMadeAt": { S: new Date().toISOString() },
      ":state": { S: status },
    },
  };

  return ddbClient.send(new UpdateItemCommand(params))
}

async function listObjects(bucket: string, prefix: string): Promise<ListObjectsV2CommandOutput> {
  return s3Client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
  }))
}

async function toArrayBuffer(stream: Stream): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", chunk => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", err => reject(`Error converting stream - ${err}`));
  });
}

async function putObjectTo(bucket: string, key: string, body: Buffer): Promise<PutObjectCommandOutput> {
  return s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    Expires: add(new Date(), {
      hours: 1
    })
  }))
}

async function addToZip(zip: JSZip, bucket: string, key: string) {
  const object = await getObjectFrom(bucket, key)
  const buffer = await toArrayBuffer(object.Body as Readable)
  const originalName = object.Metadata!["original-name"];
  const extension = key.substring(key.lastIndexOf('.'))
  zip.file(originalName + extension, buffer)
}

async function archive(bucket: string, prefix: string): Promise<Buffer> {
  const listObjResult = await listObjects(bucket, prefix)
  const zip = new JSZip();
  console.time('archive')
  await Promise.all(listObjResult.Contents!!.map(c => addToZip(zip, bucket, c.Key as string)));
  console.timeEnd('archive')
  return toArrayBuffer(zip.generateNodeStream())
}

export const handler = async function (event: SQSEvent) {
  return await Promise.all(event.Records.map(async (record) => {
    console.log(JSON.parse(record.body))
    const { requestId, bucketName, prefix } = JSON.parse(record.body)
    await updateStatus(requestId, "ZIPPING")
    const archiveBuffer = await archive(bucketName, prefix);
    const targetKey = `Archives/${requestId}/converted.zip`
    console.time("Uploading")
    await putObjectTo(bucketName, targetKey, archiveBuffer);
    console.timeEnd("Uploading")
    await updateStatus(requestId, "DONE")
  }))
    .then(() => {
      return toLambdaOutput(200, "Finished zipping")
    })
    .catch(err => {
      console.log(err);
      return toLambdaOutput(500, "Error while zipping")
    })
}
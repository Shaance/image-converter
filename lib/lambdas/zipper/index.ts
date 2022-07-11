import { S3Event } from "./@types/S3Event";

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
  HeadObjectCommandOutput,
  GetObjectCommandOutput,
  ListObjectsV2CommandOutput,
  PutObjectCommandOutput,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { DynamoDBClient, GetItemCommand, GetItemCommandOutput } from "@aws-sdk/client-dynamodb";
import { Readable, Stream } from "stream";
import * as JSZip from "jszip";
import { add } from "date-fns";

const region = process.env.REGION as string;
const s3Client = new S3Client({ region });
const totalFilesCache = new Map<string, number>();
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

async function getRequestItem(requestId: string): Promise<GetItemCommandOutput> {
  const params = {
    TableName: tableName,
    Key: {
      requestId: { S: requestId },
    },
    ProjectionExpression: "nbFiles",
  };
  
  return ddbClient.send(new GetItemCommand(params))
}

async function listObjects(bucket: string, prefix: string): Promise<ListObjectsV2CommandOutput> {
  return s3Client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
  }))
}

async function getMetadataFrom(bucket: string, key: string): Promise<HeadObjectCommandOutput> {
  return s3Client.send(new HeadObjectCommand({
    Bucket: bucket,
    Key: key,
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

async function archive(bucket: string, key: string, requestId: string): Promise<Buffer> {
  const tmp = key.split('/')
  const prefix = tmp.slice(0, 2).join('/')
  let nbFiles: number;
  if (totalFilesCache.has(prefix)) {
    console.log(`Cache hit for ${prefix}`)
    nbFiles = totalFilesCache.get(prefix) as number;
  } else {
    console.log(`${prefix} not cached yet`)
    const ddbResponse = await getRequestItem(requestId)
    console.log(ddbResponse)
    nbFiles = Number(ddbResponse.Item?.nbFiles.N as string)
    console.log(nbFiles)
    totalFilesCache.set(prefix, nbFiles)
  }

  const listObjResult = await listObjects(bucket, prefix)
  console.log(`Metadata totalFiles: ${nbFiles}, keyCount: ${listObjResult.KeyCount}`)
  if (!listObjResult.KeyCount || listObjResult.KeyCount as number !== nbFiles) {
    return Promise.reject("Nothing to archive");
  }

  const zip = new JSZip();
  console.time('archive')
  await Promise.all(listObjResult.Contents!!.map(c => addToZip(zip, bucket, c.Key as string)));
  console.timeEnd('archive')
  return toArrayBuffer(zip.generateNodeStream())
}

export const handler = async function (event: S3Event) {
  return await Promise.all(event.Records.map(async (record) => {
    console.log(record.s3);
    const bucket = record.s3.bucket.name;
    const key = record.s3.object.key;
    const requestId = key.split('/')[1]
    const archiveBuffer = await archive(bucket, key, requestId);
    const targetKey = `Archives/${requestId}/converted.zip`
    console.time("Uploading")
    await putObjectTo(bucket, targetKey, archiveBuffer);
    console.timeEnd("Uploading")
  }))
    .then(() => {
      return toLambdaOutput(200, "Finished zipping")
    })
    .catch(err => {
      console.log(err);
      return toLambdaOutput(500, "Error while zipping")
    })
}
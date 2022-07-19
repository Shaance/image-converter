import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  GetObjectCommandOutput,
  ListObjectsV2CommandOutput,
  PutObjectCommandOutput,
  PutObjectCommand,
  DeleteObjectCommandOutput,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import {
  DynamoDBClient,
  UpdateItemCommand,
  UpdateItemCommandInput,
  UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { Readable, Stream } from "stream";
import * as JSZip from "jszip";
import { add } from "date-fns";
import { SQSEvent, SQSRecord } from 'aws-lambda';

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
  const now = Math.floor(new Date().getTime() / 1000).toString()
  const params: UpdateItemCommandInput = {
    TableName: tableName,
    Key: {
      requestId: { S: requestId },
    },
    UpdateExpression: "SET #updatedAt = :newChangeMadeAt, #state = :state",
    ExpressionAttributeNames: {
      "#updatedAt": "modifiedAt",
      "#state": "state",
    },
    ExpressionAttributeValues: {
      ":newChangeMadeAt": { N: now },
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

async function deleteObject(bucket: string, key: string): Promise<DeleteObjectCommandOutput> {
  return s3Client.send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
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
  await Promise.all(listObjResult.Contents!!.map(c => addToZip(zip, bucket, c.Key as string)));
  return toArrayBuffer(zip.generateNodeStream())
}

async function deleteConvertedFiles(bucket: string, prefix: string) {
  const listObjResult = await listObjects(bucket, prefix)
  await Promise.all(listObjResult.Contents!!.map(content => 
    deleteObject(bucket, content.Key as string)
  ));
}

async function handleArchiveRequest(record: SQSRecord) {
  const recordBody = JSON.parse(record.body)
  console.log(recordBody)
  const { requestId, bucketName, prefix } = recordBody
  try {
    await updateStatus(requestId, "ZIPPING")
    const archiveBuffer = await archive(bucketName, prefix);
    const targetKey = `Archives/${requestId}/converted.zip`
    await putObjectTo(bucketName, targetKey, archiveBuffer);
    await deleteConvertedFiles(bucketName, prefix)
    await updateStatus(requestId, "DONE")
  } catch (err) {
    await updateStatus(requestId, "FAILED")
    throw err
  }
}

export const handler = async function (event: SQSEvent) {
  try {
    await Promise.all(event.Records.map(async (record) => 
      handleArchiveRequest(record)
    ))
  } catch (err) {
    console.log(err);
    return toLambdaOutput(500, "Error while zipping")
  }

  return toLambdaOutput(200, "Finished zipping")
}
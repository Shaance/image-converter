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
import { Readable, Stream } from "stream";
import * as JSZip from "jszip";

const region = process.env.REGION as string;
const s3Client = new S3Client({ region });
const totalFilesCache = new Map<string, number>();

async function getObjectFrom(bucket: string, key: string): Promise<GetObjectCommandOutput> {
  return s3Client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }))
}

async function listObjects(bucket: string, prefix: string): Promise<ListObjectsV2CommandOutput> {
  console.log(`Listing with prefix ${prefix}`)
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

async function toArrayBuffer(stream: Readable): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', chunk => chunks.push(chunk))
    stream.once('end', () => resolve(Buffer.concat(chunks)))
    stream.once('error', reject)
  })
}

async function stream2buffer(stream: Stream): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const _buf = Array<any>();
    stream.on("data", chunk => _buf.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(_buf)));
    stream.on("error", err => reject(`error converting stream - ${err}`));

  });
}

async function putObjectTo(bucket: string, key: string, body: Buffer): Promise<PutObjectCommandOutput> {
  console.log(`target key ${key}`)
  return s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body
  }))
}

async function addToZip(zip: JSZip, bucket: string, key: string) {
  const object = await getObjectFrom(bucket, key)
  const buffer = await toArrayBuffer(object.Body as Readable)
  const originalName = object.Metadata!["original-name"];
  const extension = key.substring(key.lastIndexOf('.'))
  zip.file(originalName + extension, buffer)
}

async function archive(bucket: string, key: string): Promise<Buffer> {
  const tmp = key.split('/')
  const prefix = tmp.slice(0, 2).join('/')
  let totalFiles: number;
  if (totalFilesCache.has(prefix)) {
    console.log(`Cache hit for ${prefix}`)
    totalFiles = totalFilesCache.get(prefix) as number;
  } else {
    console.log(`${prefix} not cached yet`)
    const metadataObject = await getMetadataFrom(bucket, key)
    console.log(metadataObject)
    totalFiles = Number(metadataObject.Metadata!["total-files"]);
    totalFilesCache.set(prefix, totalFiles)
  }

  const listObjResult = await listObjects(bucket, prefix)
  console.log(listObjResult)
  console.log(`Metadata totalFiles: ${totalFiles}, keyCount: ${listObjResult.KeyCount}`)
  if (!listObjResult.KeyCount || listObjResult.KeyCount as number !== totalFiles) {
    return Promise.reject("Nothing to archive");
  }

  const zip = new JSZip();
  console.time('archive')
  await Promise.all(listObjResult.Contents!!.map(c => addToZip(zip, bucket, c.Key as string)));
  console.timeEnd('archive')
  return stream2buffer(zip.generateNodeStream())
}

export const handler = async function (event: S3Event) {

  await Promise.all(event.Records.map(async (record) => {
    console.log(record.s3);
    const bucket = record.s3.bucket.name;
    const key = record.s3.object.key;
    const archiveBuffer = await archive(bucket, key);
    const requestId = key.split('/')[1]
    const targetKey = `Archives/${requestId}/converted.zip`
    console.time("Uploading")
    await putObjectTo(bucket, targetKey, archiveBuffer);
    console.timeEnd("Uploading")
  }))
    .catch(err => console.log(err))

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/plain"
    },
    body: JSON.stringify("ok"),
    isBase64Encoded: false
  };
}
import { S3Event, S3EventRecordDetail } from "./@types/S3Event";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  PutObjectCommandOutput,
  GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { Readable } from "stream";
import { v4 as uuidv4 } from 'uuid';
import { add } from 'date-fns'

const convert = require("heic-convert")

const region = process.env.REGION as string;
const s3Client = new S3Client({ region })

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

async function putObjectTo(bucket: string, key: string, body: Buffer, totalFiles: string, originalName: string): Promise<PutObjectCommandOutput> {
  return s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    Metadata: {
      "total-files": totalFiles,
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

async function convertFromS3(record: S3EventRecordDetail) {
  console.log(record)
  const conversionId = uuidv4()
  const bucket = record.bucket.name;
  const key = record.object.key;
  const object = await getObjectFrom(bucket, key)
  const targetMime = object.Metadata!["target-mime"];
  const buffer = await toArrayBuffer(object.Body as Readable)
  console.time(`Conversion-${conversionId}`)
  const outputBuffer = await convert({
    buffer: buffer,
    format: toHeicConvertTargetFormat(targetMime),
    quality: 1
  });
  console.timeEnd(`Conversion-${conversionId}`)
  const targetKey = toNewKey(key, targetMime)
  const totalFiles = object.Metadata!["total-files"];
  const originalName = object.Metadata!["original-name"];
  await putObjectTo(bucket, targetKey, outputBuffer, totalFiles, originalName)
}


export const handler = async function (event: S3Event) {
  await Promise.all(event.Records.map((record) => {
    return convertFromS3(record.s3)
  }))

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/plain"
    },
    body: JSON.stringify("ok"),
    isBase64Encoded: false
  };
}
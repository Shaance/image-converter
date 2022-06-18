import { S3Event, S3EventRecordDetail } from "./@types/S3Event";
// import heic2any from "heic2any";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  PutObjectCommandOutput,
  GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { Readable } from "stream";
import { v4 as uuidv4 } from 'uuid';

const convert = require("heic-convert")

// import { Blob } from 'buffer';
// import {Blob} from 'node:buffer';
// import { Readable } from "stream";

// const bucketName = process.env.BUCKET_NAME as string;
const region = process.env.REGION as string;
const s3Client = new S3Client({ region })

// async function getMetadataFrom(key: string) {
//   return s3Client.send(new HeadObjectCommand({
//     Bucket: bucketName,
//     Key: key,
//   }))
// }

function toHeicConvertTargetFormat(mime: string) {
  if (mime === "image/jpeg") {
    return "JPEG"
  } else if (mime === "image/png") {
    return "PNG"
  }

  throw Error(`Can't convert from heic file to ${mime}.`)
}

async function getObjectFrom(bucket: string, key: string): Promise<GetObjectCommandOutput> {
  console.log(bucket)
  return s3Client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }))
}

async function putObjectTo(bucket: string, key: string, body: Buffer, totalFiles: string, originalName: string): Promise<PutObjectCommandOutput> {
  console.log(`target key ${key}`)
  return s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    Metadata: {
      "total-files": totalFiles,
      "original-name": originalName,
    },
    // Expires: TODO
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

// async function streamToBinary(stream: any): Promise<Blob> {
//   return new Promise((resolve, reject) => {
//     const chunks: any = [];
//     stream.on("data", (chunk: any) => chunks.push(chunk));
//     stream.on("error", reject);
//     stream.on("end", () => resolve(Buffer.concat(chunks).toString("binary")));
//   });
// }

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
  console.log("AAAA! converting! " + key)
  // const metadata = await getMetadataFrom(key)
  console.time("getObject")
  const object = await getObjectFrom(bucket, key)
  console.timeEnd("getObject")
  console.log(object.Metadata)
  const targetMime = object.Metadata!["target-mime"];
  // console.log(object)
  const buffer = await toArrayBuffer(object.Body as Readable)
  console.log("Finished to retrieve buffer and being conversion")
  console.time(`Conversion-${conversionId}`)
  const outputBuffer = await convert({
    buffer: buffer,
    format: toHeicConvertTargetFormat(targetMime),
    quality: 1
  });
  console.timeEnd(`Conversion-${conversionId}`)
  console.log('Finished conversion')
  const targetKey = toNewKey(key, targetMime)
  console.log('begin upload')
  const totalFiles = object.Metadata!["total-files"];
  const originalName = object.Metadata!["original-name"];
  const putResponse = await putObjectTo(bucket, targetKey, outputBuffer, totalFiles, originalName)
  console.log(putResponse)
  // console.log(outputBuffer)
  // const converted = await heic2any({
  //   blob: object.Body as Blob,
  //   toType: "image/jpeg",
  // })
  // console.log(converted)
}


export const handler = async function (event: S3Event) {
  await Promise.all(event.Records.map((record) => {
    console.log(record.s3);
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
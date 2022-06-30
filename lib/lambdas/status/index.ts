import { StatusAPIGatewayProxyEvent } from './@types/StatusAPIEvent';
import {
  S3Client,
  ListObjectsV2Command,
  ListObjectsV2CommandOutput,
} from '@aws-sdk/client-s3';

const bucketName = process.env.BUCKET_NAME as string;
const region = process.env.REGION as string;
const s3Client = new S3Client({ region: region })

enum ConversionStatus {
  PROCESSING = "PROCESSING",
  DONE = "DONE"
}

interface ConversionStatusDetail {
  status: ConversionStatus,
  processed?: number
}

async function listObjects(prefix: string): Promise<ListObjectsV2CommandOutput> {
  return s3Client.send(new ListObjectsV2Command({
    Bucket: bucketName,
    Prefix: prefix,
  })
  )
}

async function getStatus(requestId: string): Promise<ConversionStatusDetail> {
  let prefix = `Archives/${requestId}`
  let listObjectResponse = await listObjects(prefix)
  const archiveNb = listObjectResponse.KeyCount
  if (!!archiveNb && archiveNb === 1) {
    return {
      status: ConversionStatus.DONE
    }
  }

  prefix = prefix.replace("Archives", "Converted")
  const convertedImagesNb = (await listObjects(prefix)).KeyCount
  return {
    status: ConversionStatus.PROCESSING,
    processed: convertedImagesNb
  }
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

export const handler = async (event: StatusAPIGatewayProxyEvent) => {
  console.log(event)

  let requestId = event.queryStringParameters?.requestId as string;
  const status = await getStatus(requestId)
  return toLambdaOutput(200, status);
}

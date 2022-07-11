import { PreSignAPIGatewayProxyEvent } from './@types/PreSignEvent';
import { 
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from 'uuid';
import { APIGatewayProxyEventQueryStringParameters } from 'aws-lambda';
// import { add } from 'date-fns';

const bucketName = process.env.BUCKET_NAME as string;
const region = process.env.REGION as string;
const validTargetMimes = ['image/jpeg', 'image/png'];
const validTargetMimesSet = new Set<string>(validTargetMimes);

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

function validateRequest(queryParams: APIGatewayProxyEventQueryStringParameters) {
  const { totalFiles, targetMime } = queryParams
  
  if (!validTargetMimesSet.has(targetMime!)) {
    return toLambdaOutput(400, `${targetMime} targetMime is not supported, valid values are: ${validTargetMimes}`)
  }

  // TODO remove once client updated to retrieve requestId through requrests lambda
  if (isNaN(+totalFiles!)) {
    return toLambdaOutput(400, "totalFiles should be a number")
  }

  if (Number(totalFiles) < 1) {
    return toLambdaOutput(400, "totalFiles should be at least 1")
  }

  if (Number(totalFiles) > 50) {
    return toLambdaOutput(400, "totalFiles can't be higher than 50 ")
  }

  return
}

export const handler = async (event: PreSignAPIGatewayProxyEvent) =>  {
    console.log(event)
    const errOutput = validateRequest(event.queryStringParameters!)
    const { fileName, requestId, totalFiles, targetMime } = event.queryStringParameters!;
    
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
        "total-files": totalFiles as string,
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

    return toLambdaOutput(200, responseBody);
}
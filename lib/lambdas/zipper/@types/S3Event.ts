import { APIGatewayProxyEvent } from "aws-lambda";

export interface S3Event extends APIGatewayProxyEvent {
  Records: S3EventRecord[]
}
interface S3EventRecord {
  s3: S3EventRecordDetail // more than that
}

interface S3EventRecordDetail {
  s3SchemaVersion: string
  configurationId: string
  bucket: S3EventRecordBucketObject,
  object: S3EventRecordObject
}

interface S3EventRecordBucketObject {
  name: string
  ownerIdentity: { 
    principalId: string
  },
  arn: string
}

interface S3EventRecordObject {
  key: string
  size: number
  eTag: string
  sequencer: string
}
import { APIGatewayProxyEvent } from "aws-lambda";

export interface SQSEvent extends APIGatewayProxyEvent {
  Records: SQSEventRecord[]
}

export interface SQSEventRecord {
  body: string
}
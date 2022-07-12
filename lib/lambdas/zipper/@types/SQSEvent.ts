import { APIGatewayProxyEvent } from "aws-lambda";

export interface SQSEvent extends APIGatewayProxyEvent {
  Records: SQSEventRecord[]
}

interface SQSEventRecord {
  body: string
}
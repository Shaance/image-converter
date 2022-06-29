import { APIGatewayProxyEvent } from "aws-lambda";

export type StatusAPIBodyField = "requestId"

export interface StatusAPIGatewayProxyEvent extends APIGatewayProxyEvent {
  body: string
}

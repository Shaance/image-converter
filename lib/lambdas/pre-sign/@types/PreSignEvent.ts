import { APIGatewayProxyEvent } from "aws-lambda";

export interface PreSignAPIGatewayProxyEvent extends APIGatewayProxyEvent {
  body: string
}
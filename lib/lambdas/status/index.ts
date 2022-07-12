import { DynamoDBClient, GetItemCommand, GetItemCommandInput, GetItemCommandOutput } from '@aws-sdk/client-dynamodb';
import { StatusAPIGatewayProxyEvent } from './@types/StatusAPIEvent';

const region = process.env.REGION as string;
const tableName = process.env.TABLE_NAME as string;
const ddbClient = new DynamoDBClient({ region });

interface ConversionStatusDetail {
  status: string,
  uploaded: number,
  processed: number,
}

async function getRequestItem(requestId: string, projectionExpression: string): Promise<GetItemCommandOutput> {
  const params: GetItemCommandInput = {
    TableName: tableName,
    Key: {
      requestId: { S: requestId },
    },
    ProjectionExpression: projectionExpression,
  };
  
  return ddbClient.send(new GetItemCommand(params))
}

async function getStatus(requestId: string): Promise<ConversionStatusDetail> {
  const requestItem = await getRequestItem(requestId, "uploadedFiles,convertedFiles, state")
  const uploadedFiles = Number(requestItem.Item?.uploadedFiles.N!)
  const convertedFiles = Number(requestItem.Item?.convertedFiles.N!)
  const state = requestItem.Item?.state.S!

  return {
    status: state,
    uploaded: uploadedFiles,
    processed: convertedFiles,
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

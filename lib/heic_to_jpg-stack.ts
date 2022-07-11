import {
  Stack,
  StackProps,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_notifications as s3n,
  aws_dynamodb as ddb,
  aws_apigateway as api_gateway,
  Duration,
  RemovalPolicy,
} from 'aws-cdk-lib';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { IFunction } from 'aws-cdk-lib/aws-lambda';
import { HttpMethods } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { LambdaRestApi } from 'aws-cdk-lib/aws-apigateway';

function createRequestsTable(scope: Construct): Table {
  return new ddb.Table(scope, 'RequestsTable', {
    partitionKey: { name: 'requestId', type: ddb.AttributeType.STRING },
    billingMode: ddb.BillingMode.PAY_PER_REQUEST,
    encryption: ddb.TableEncryption.AWS_MANAGED,
    removalPolicy: RemovalPolicy.DESTROY,
    timeToLiveAttribute: "expiresAt",
  });
}

function getGatewayLambdaResponseMethod() {
  return {
    statusCode: '400',
    responseParameters: {
      'method.response.header.Content-Type': true,
      'method.response.header.Access-Control-Allow-Origin': true,
      'method.response.header.Access-Control-Allow-Credentials': true
    },
  }
}

function toGatewayApi(scope: Construct, apiName: string, lambdaFn: IFunction, allowMethods: string[], proxy = true): LambdaRestApi {
  return new api_gateway.LambdaRestApi(scope, apiName, {
    handler: lambdaFn,
    proxy,
    defaultCorsPreflightOptions: {
      allowHeaders: api_gateway.Cors.DEFAULT_HEADERS,
      allowMethods,
      allowOrigins: api_gateway.Cors.ALL_ORIGINS,
    },
  });
}

function addMethodOnGatewayApi(scope: Construct, lambdaFn: IFunction, api: LambdaRestApi, restMethod: string, requestValidatorId: string, fields: string[]) {
  const lambdaIntegration = new api_gateway.LambdaIntegration(lambdaFn)
  const requestParameters = fields.reduce((params, field) => {
    // @ts-ignore
    params[`method.request.querystring.${field}`] = true
    return params
  }, {})
  api.root.addMethod(restMethod, lambdaIntegration, {
    requestValidator: new api_gateway.RequestValidator(
      scope,
      requestValidatorId,
      {
        restApi: api,
        validateRequestParameters: true
      }
    ),
    requestParameters,
    methodResponses: [
      getGatewayLambdaResponseMethod()
    ]
  })
}

export class HeicToJpgStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const lambdasPath = './lib/lambdas/';
    
    // TODO SSE encryption
    const bucket = new s3.Bucket(this, 'HeicToJpgBucket', {
      enforceSSL: true,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
      cors: [{
        allowedHeaders: ["*"],
        allowedMethods: [HttpMethods.GET, HttpMethods.PUT],
        allowedOrigins: api_gateway.Cors.ALL_ORIGINS,
      }],
      lifecycleRules: [{
        expiration: Duration.days(1)
      }]
    });

    const table = createRequestsTable(this)

    const requestsLambda = new lambda.Function(this, "RequestsLambda", {
      runtime: lambda.Runtime.NODEJS_16_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      logRetention: logs.RetentionDays.ONE_DAY,
      code: lambda.Code.fromAsset(lambdasPath + '/requests'),
      environment: {
        "TABLE_NAME": table.tableName,
        "REGION": props?.env?.region as string,
      },
    });

    table.grantReadWriteData(requestsLambda)

    const presignLambda = new lambda.Function(this, "PreSignLambda", {
      runtime: lambda.Runtime.NODEJS_16_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      logRetention: logs.RetentionDays.ONE_DAY,
      code: lambda.Code.fromAsset(lambdasPath + '/pre-sign'),
      environment: {
        "BUCKET_NAME": bucket.bucketName,
        "REGION": props?.env?.region as string,
        "TABLE_NAME": table.tableName,
      },
    });

    table.grantReadData(presignLambda)

    const statusLambda = new lambda.Function(this, "StatusLambda", {
      runtime: lambda.Runtime.NODEJS_16_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      logRetention: logs.RetentionDays.ONE_DAY,
      code: lambda.Code.fromAsset(lambdasPath + '/status'),
      environment: {
        "BUCKET_NAME": bucket.bucketName,
        "REGION": props?.env?.region as string
      },
    });

    const converterLambda = new lambda.Function(this, "ConvertLambda", {
      runtime: lambda.Runtime.NODEJS_16_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      logRetention: logs.RetentionDays.ONE_WEEK,
      code: lambda.Code.fromAsset(lambdasPath + '/converter'),
      environment: {
        "REGION": props?.env?.region as string
      },
      timeout: Duration.seconds(30),
      memorySize: 1024
    });

    const zipperLambda = new lambda.Function(this, "ZipperLambda", {
      runtime: lambda.Runtime.NODEJS_16_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      logRetention: logs.RetentionDays.ONE_WEEK,
      code: lambda.Code.fromAsset(lambdasPath + '/zipper'),
      environment: {
        "REGION": props?.env?.region as string
      },
      timeout: Duration.seconds(30),
      memorySize: 2048
    });

    const preSignApi = toGatewayApi(this, 'PreSignAPI', presignLambda, ['GET'], false)
    const requestsApi = toGatewayApi(this, 'RequestsAPI', requestsLambda, ['GET'], false)
    const statusApi = toGatewayApi(this, 'StatusAPI', statusLambda, ['GET'], false)

    addMethodOnGatewayApi(this, statusLambda, statusApi, "GET", "status-query-string-validator", ["requestId"])
    addMethodOnGatewayApi(this, requestsLambda, requestsApi, "GET", "requests-query-string-validator", ["nbFiles"])
    addMethodOnGatewayApi(this, presignLambda, preSignApi, "GET", "pres-sign-query-string-validator", ["fileName", "requestId", "targetMime"])

    bucket.grantReadWrite(presignLambda);
    bucket.grantReadWrite(converterLambda);
    bucket.grantReadWrite(zipperLambda)
    bucket.grantReadWrite(statusLambda)
    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.LambdaDestination(converterLambda),
      {
        prefix: 'OriginalImages'
      }
    )
    
    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.LambdaDestination(zipperLambda),
      {
        prefix: 'Converted'
      }
    )
  }
}

import {
  Stack,
  StackProps,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_notifications as s3n,
  aws_dynamodb as ddb,
  aws_apigateway as api_gateway,
  aws_sqs as sqs,
  Duration,
  RemovalPolicy,
} from 'aws-cdk-lib';

import { Canary, Schedule, Test, Code, Runtime } from '@aws-cdk/aws-synthetics-alpha'
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { IFunction } from 'aws-cdk-lib/aws-lambda';
import { HttpMethods } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { LambdaRestApi } from 'aws-cdk-lib/aws-apigateway';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

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

function createImagesBucket(scope: Construct): s3.Bucket {
  return new s3.Bucket(scope, 'HeicToJpgBucket', {
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
}

function createNodeArmLambda(scope: Construct, name: string, codePath: string, environment?: {[key: string]: string}, timeout = Duration.seconds(3), memorySize = 128) {
  return new lambda.Function(scope, name, {
    runtime: lambda.Runtime.NODEJS_16_X,
    architecture: lambda.Architecture.ARM_64,
    handler: 'index.handler',
    logRetention: logs.RetentionDays.ONE_DAY,
    code: lambda.Code.fromAsset(codePath),
    timeout,
    environment,
    memorySize,
  });
}

export class HeicToJpgStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const lambdasPath = './lib/lambdas/';
    const canarysPath = './lib/canarys/';
    const bucket = createImagesBucket(this)
    const table = createRequestsTable(this)

    const requestsLambda = createNodeArmLambda(this, "RequestsLambda", lambdasPath + '/requests', {
      "TABLE_NAME": table.tableName,
      "REGION": props?.env?.region as string,
    }, Duration.seconds(10))

    const presignLambda = createNodeArmLambda(this, "PreSignLambda", lambdasPath + '/pre-sign', {
      "BUCKET_NAME": bucket.bucketName,
      "REGION": props?.env?.region as string,
      "TABLE_NAME": table.tableName,
    })

    const statusLambda = createNodeArmLambda(this, "StatusLambda", lambdasPath + '/status', {
      "REGION": props?.env?.region as string,
      "TABLE_NAME": table.tableName,
    })
    
    const archiveQueue = new sqs.Queue(this, "ArchiveQueue", {
      removalPolicy: RemovalPolicy.DESTROY
    })

    const converterLambda = createNodeArmLambda(this, "ConvertLambda", lambdasPath + '/converter', {
      "REGION": props?.env?.region as string,
      "TABLE_NAME": table.tableName,
      "QUEUE_URL": archiveQueue.queueUrl,
    }, Duration.seconds(30), 1024)

    const zipperLambda = createNodeArmLambda(this, "ZipperLambda", lambdasPath + '/zipper', {
      "REGION": props?.env?.region as string,
      "TABLE_NAME": table.tableName,
    }, Duration.seconds(30), 2048)

    archiveQueue.grantSendMessages(converterLambda)
    archiveQueue.grantConsumeMessages(zipperLambda)

    // TODO DLQ
    zipperLambda.addEventSource(new SqsEventSource(archiveQueue))

    const preSignApi = toGatewayApi(this, 'PreSignAPI', presignLambda, ['GET'], false)
    const requestsApi = toGatewayApi(this, 'RequestsAPI', requestsLambda, ['GET'], false)
    const statusApi = toGatewayApi(this, 'StatusAPI', statusLambda, ['GET'], false)

    addMethodOnGatewayApi(this, statusLambda, statusApi, "GET", "status-query-string-validator", ["requestId"])
    addMethodOnGatewayApi(this, requestsLambda, requestsApi, "GET", "requests-query-string-validator", ["nbFiles"])
    addMethodOnGatewayApi(this, presignLambda, preSignApi, "GET", "pres-sign-query-string-validator", ["fileName", "requestId", "targetMime"])

    table.grantReadWriteData(requestsLambda)
    table.grantReadWriteData(presignLambda)
    table.grantReadWriteData(converterLambda)
    table.grantReadWriteData(zipperLambda)
    table.grantReadData(statusLambda)
    bucket.grantReadWrite(presignLambda);
    bucket.grantReadWrite(converterLambda);
    bucket.grantReadWrite(zipperLambda)

    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.LambdaDestination(converterLambda),
      {
        prefix: 'OriginalImages'
      }
    )

    new Canary(this, 'RequestsCanary', {
      schedule: Schedule.rate(Duration.minutes(1)),
      test: Test.custom({
        code: Code.fromAsset(canarysPath + 'requests'),
        handler: 'index.handler',
      }),
      runtime: Runtime.SYNTHETICS_NODEJS_PUPPETEER_3_5,
      environmentVariables: {
        "REQUESTS_URL": requestsApi.url,
      },
    });
  }
}

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
  aws_sns as sns,
  Duration,
  RemovalPolicy,
} from 'aws-cdk-lib';

import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { IFunction } from 'aws-cdk-lib/aws-lambda';
import { HttpMethods } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { LambdaRestApi } from 'aws-cdk-lib/aws-apigateway';
import { SnsEventSource, SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';

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

function createArmLambda(scope: Construct, name: string, codePath: string, environment?: { [key: string]: string }, timeout = Duration.seconds(3), memorySize = 128, runtime = lambda.Runtime.NODEJS_16_X) {
  return new lambda.Function(scope, name, {
    architecture: lambda.Architecture.ARM_64,
    handler: 'index.handler',
    logRetention: logs.RetentionDays.ONE_DAY,
    code: lambda.Code.fromAsset(codePath),
    timeout,
    environment,
    memorySize,
    runtime,
  });
}

export class HeicToJpgStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const lambdasPath = './lib/lambdas/';
    const canariesPath = './lib/canaries/';
    const bucket = createImagesBucket(this)
    const table = createRequestsTable(this)

    const requestsLambda = createArmLambda(this, "RequestsLambda", lambdasPath + '/requests', {
      "TABLE_NAME": table.tableName,
      "BUCKET_NAME": bucket.bucketName,
      "REGION": props?.env?.region as string,
    }, Duration.seconds(10))

    const presignLambda = createArmLambda(this, "PreSignLambda", lambdasPath + '/pre-sign', {
      "BUCKET_NAME": bucket.bucketName,
      "REGION": props?.env?.region as string,
      "TABLE_NAME": table.tableName,
    })

    const statusLambda = createArmLambda(this, "StatusLambda", lambdasPath + '/status', {
      "REGION": props?.env?.region as string,
      "TABLE_NAME": table.tableName,
    })

    const archiveQueue = new sqs.Queue(this, "ArchiveQueue", {
      removalPolicy: RemovalPolicy.DESTROY
    })

    const converterTopic = new sns.Topic(this, "ConverterTopic")

    const converterLambda = createArmLambda(this, "ConvertLambda", lambdasPath + '/converter', {
      "REGION": props?.env?.region as string,
      "TABLE_NAME": table.tableName,
      "QUEUE_URL": archiveQueue.queueUrl,
    }, Duration.seconds(30), 1024)

    const goConverterLambda = createArmLambda(this, "GoConverterLambda", lambdasPath + '/go-converter', {
      "REGION": props?.env?.region as string,
      "TABLE_NAME": table.tableName,
      "QUEUE_URL": archiveQueue.queueUrl,
    }, Duration.seconds(30), 1024, lambda.Runtime.GO_1_X)

    bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.SnsDestination(converterTopic),
      {
        prefix: 'OriginalImages'
      }
    )

    const converterDLQ = new sqs.Queue(this, "ConverterDLQ", {
      removalPolicy: RemovalPolicy.DESTROY
    })

    converterLambda.addEventSource(new SnsEventSource(converterTopic, {
      deadLetterQueue: converterDLQ
    }))

    goConverterLambda.addEventSource(new SnsEventSource(converterTopic, {
      deadLetterQueue: converterDLQ
    }))

    const zipperLambda = createArmLambda(this, "ZipperLambda", lambdasPath + '/zipper', {
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
    bucket.grantReadWrite(requestsLambda)
    bucket.grantReadWrite(presignLambda);
    bucket.grantReadWrite(converterLambda);
    bucket.grantReadWrite(zipperLambda)

    const requestCanary = createArmLambda(this, "RequestsCanaryLambda", canariesPath + '/requests', {
      "REQUESTS_API_URL": requestsApi.url,
    })

    const statusCanary = createArmLambda(this, "StatusCanaryLambda", canariesPath + '/status', {
      "REQUESTS_API_URL": requestsApi.url,
      "STATUS_API_URL": statusApi.url,
    })

    const presignCanary = createArmLambda(this, "PresignCanaryLambda", canariesPath + '/pre-sign', {
      "REQUESTS_API_URL": requestsApi.url,
      "PRESIGN_API_URL": preSignApi.url,
    })

    new Rule(this, 'CanaryRule', {
      schedule: Schedule.rate(Duration.minutes(1)),
      targets: [
        new LambdaFunction(requestCanary),
        new LambdaFunction(statusCanary),
        new LambdaFunction(presignCanary),
      ],
    });
  }
}

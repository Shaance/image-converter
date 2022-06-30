import {
  Stack,
  StackProps,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_s3 as s3,
  aws_s3_notifications as s3n,
  aws_apigateway as api_gateway,
  Duration,
  RemovalPolicy,
} from 'aws-cdk-lib';
import { JsonSchemaType, LambdaRestApi } from 'aws-cdk-lib/aws-apigateway';
import { HttpMethods } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

function getStatusApiModel(scope: Construct, api: LambdaRestApi) {
   return new api_gateway.Model(scope, "model-validator", {
    restApi: api,
    contentType: "application/json",
    modelName: "statusApiModel",
    schema: {
      type: JsonSchemaType.OBJECT,
      required: ["requestId"],
      properties: {
        requestId: { type: JsonSchemaType.STRING },
      },
    },
  });
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

    const presignLambda = new lambda.Function(this, "PreSignLambda", {
      runtime: lambda.Runtime.NODEJS_16_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      logRetention: logs.RetentionDays.ONE_DAY,
      code: lambda.Code.fromAsset(lambdasPath + '/pre-sign'),
      environment: {
        "BUCKET_NAME": bucket.bucketName,
        "REGION": props?.env?.region as string
      },
    });

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
   
    new api_gateway.LambdaRestApi(this, 'PreSignAPI', {
      handler: presignLambda,
      defaultCorsPreflightOptions: {
        allowHeaders: api_gateway.Cors.DEFAULT_HEADERS,
        allowMethods: ['POST'],
        allowOrigins: api_gateway.Cors.ALL_ORIGINS,
      },
    });

    const statusApi = new api_gateway.LambdaRestApi(this, 'StatusAPI', {
      handler: statusLambda,
      proxy: false,
      defaultCorsPreflightOptions: {
        allowHeaders: api_gateway.Cors.DEFAULT_HEADERS,
        allowMethods: ['POST'],
        allowOrigins: api_gateway.Cors.ALL_ORIGINS,
      },
    });

    const statusApiModel = getStatusApiModel(this, statusApi)
    const statusLambdaIntegration = new api_gateway.LambdaIntegration(statusLambda)
    statusApi.root.addMethod("POST", statusLambdaIntegration, {
      requestValidator: new api_gateway.RequestValidator(
        this,
        "body-validator",
        {
          restApi: statusApi,
          requestValidatorName: "body-validator",
          validateRequestBody: true,
        }
      ),
      requestModels: {
        "application/json": statusApiModel,
      },
    })

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

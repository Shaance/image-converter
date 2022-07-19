package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/sunshineplan/imgconv"
)

type RequestItem struct {
	RequestId      string `json:"requestId"`
	ModifiedAt     int    `json:"modifiedAt"`
	State          string `json:"state"`
	ConvertedFiles int    `json:"convertedFiles"`
	NbFiles        int    `json:"nbFiles"`
}

type RetryMode int64

type RetryState struct {
	retryMode   RetryMode
	retriesLeft int8
	delay       int16
}

// lambda can only write in tmp
const validPath = "/tmp"
const (
	Immediate RetryMode = iota
	ConstantDelay
	Exponential // + jitter
)

// can convert from / to these formats
var targetMimeToImgConvFormat = map[string]imgconv.Format{
	"image/jpeg":      imgconv.JPEG,
	"image/jpg":       imgconv.JPEG,
	"image/png":       imgconv.PNG,
	"image/gif":       imgconv.GIF,
	"image/tif":       imgconv.TIFF,
	"image/tiff":      imgconv.TIFF,
	"image/bmp":       imgconv.BMP,
	"application/pdf": imgconv.PDF,
}

var awsS3Client *s3.Client
var ddbClient *dynamodb.Client
var sqsClient *sqs.Client
var region string
var queueUrl string
var tableName string

var defaultRetryState = RetryState{
	retryMode:   Immediate,
	retriesLeft: 15,
	delay:       0,
}

func init() {
	rand.Seed(time.Now().UnixNano()) // TODO jitter
	setEnvVars()
	configClients()
}

func setEnvVars() {
	region = os.Getenv("REGION")
	queueUrl = os.Getenv("QUEUE_URL")
	tableName = os.Getenv("TABLE_NAME")
}

func configClients() {
	cfg, err := config.LoadDefaultConfig(context.TODO(), config.WithRegion(region))
	if err != nil {
		log.Fatal(err)
	}
	awsS3Client = s3.NewFromConfig(cfg)
	ddbClient = dynamodb.NewFromConfig(cfg)
	sqsClient = sqs.NewFromConfig(cfg)
}

func getExtensionFromString(fileName string) (string, error) {
	splitted := strings.Split(fileName, ".")
	length := len(splitted)
	if length == 0 {
		return "", errors.New("can't convert file with no extension")
	}
	return splitted[length-1], nil
}

func getConvertedFileName(targetMime, fileName string) string {
	tmp := strings.Split(targetMime, "/")
	return fmt.Sprintf("%s.%s", fileName, tmp[len(tmp)-1])
}

func getFileNameFromKey(key string) string {
	tmp := strings.Split(key, "/")
	return tmp[len(tmp)-1]
}

func downloadKeyToFile(ctx context.Context, key, bucket, pathToFile string) (*os.File, error) {
	fileFromS3, err := os.Create(pathToFile)
	if err != nil {
		return nil, err
	}
	defer fileFromS3.Close()

	downloader := manager.NewDownloader(awsS3Client)
	_, err = downloader.Download(ctx, fileFromS3, &s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	})

	return fileFromS3, err
}

func uploadToS3(ctx context.Context, key, bucket, pathToFile, originalName string) error {
	fileToUpload, err := os.Open(pathToFile)
	if err != nil {
		return err
	}
	defer fileToUpload.Close()

	uploader := manager.NewUploader(awsS3Client)
	if result, err := uploader.Upload(ctx, &s3.PutObjectInput{
		Bucket:  aws.String(bucket),
		Key:     aws.String(key),
		Body:    fileToUpload,
		Expires: aws.Time(time.Now().Add(1 * time.Hour)),
		Metadata: map[string]string{
			"original-name": originalName,
		},
	}); err == nil {
		log.Println("File Uploaded Successfully, URL: ", result.Location)
	}

	return err
}

func pushToQueue(ctx context.Context, item *RequestItem, bucket string) error {
	convertedFiles := item.ConvertedFiles
	nbFiles := item.NbFiles
	requestId := item.RequestId
	if convertedFiles != nbFiles {
		return nil
	}

	prefix := fmt.Sprintf("Converted/%s", requestId)
	params := map[string]string{
		"requestId":  requestId,
		"bucketName": bucket,
		"prefix":     prefix,
	}

	json, err := json.Marshal(params)
	if err != nil {
		log.Println(err)
		return err
	}

	messageInput := &sqs.SendMessageInput{
		DelaySeconds: 2,
		MessageBody:  aws.String(string(json)),
		QueueUrl:     &queueUrl,
	}

	_, err = sqsClient.SendMessage(ctx, messageInput)
	if err != nil {
		fmt.Println("Got an error sending the message:")
		fmt.Println(err)
	}

	return err
}

func updateStatus(ctx context.Context, requestId, status string) (*dynamodb.UpdateItemOutput, error) {
	return ddbClient.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(tableName),
		Key: map[string]types.AttributeValue{
			"requestId": &types.AttributeValueMemberS{Value: requestId},
		},
		UpdateExpression: aws.String("SET #updatedAt = :newChangeMadeAt, #state = :state"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":state":           &types.AttributeValueMemberS{Value: status},
			":newChangeMadeAt": &types.AttributeValueMemberS{Value: strconv.FormatInt(time.Now().Unix(), 10)},
		},
		ExpressionAttributeNames: map[string]string{
			"#updatedAt": "modifiedAt",
			"#state":     "state",
		},
	})
}

func getMetadata(ctx context.Context, bucket, key string) (map[string]string, error) {
	headObj, err := awsS3Client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		log.Println("Error while getting metadata")
	}
	return headObj.Metadata, err
}

func getRequestItem(ctx context.Context, requestId, projectionExpression string) (*dynamodb.GetItemOutput, error) {
	return ddbClient.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(tableName),
		Key: map[string]types.AttributeValue{
			"requestId": &types.AttributeValueMemberS{Value: requestId},
		},
		ProjectionExpression: &projectionExpression,
		ConsistentRead:       aws.Bool(true),
	})
}

func deleteObject(ctx context.Context, requestId, bucket, key string) (*dynamodb.DeleteItemOutput, error) {
	return ddbClient.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(tableName),
		Key: map[string]types.AttributeValue{
			"requestId": &types.AttributeValueMemberS{Value: requestId},
		},
	})
}

func updateCount(ctx context.Context, requestId, countAttribute string, returnValues types.ReturnValue, retryState RetryState) (*dynamodb.UpdateItemOutput, error) {
	if retryState.retriesLeft < 1 {
		if retryState.retryMode == Exponential {
			return nil, fmt.Errorf("could not update attribute %s after retries", countAttribute)
		}
		if retryState.retryMode == ConstantDelay {
			retryState.retryMode = Exponential
			retryState.delay = 25
		} else {
			retryState.retryMode = ConstantDelay
			retryState.delay = 25
		}
		retryState.retriesLeft = defaultRetryState.retriesLeft
		return updateCount(ctx, requestId, countAttribute, returnValues, retryState)
	}

	resp, err := getRequestItem(ctx, requestId, "modifiedAt")
	if err != nil {
		log.Println("Could not retrieve Request item")
		return nil, err
	}
	requestItem := RequestItem{}
	attributevalue.UnmarshalMap(resp.Item, &requestItem)
	modifiedAt := requestItem.ModifiedAt
	conditionExpression := "#updatedAt = :modifiedAtFromItem"
	now := time.Now().Unix()

	updated, err := ddbClient.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(tableName),
		Key: map[string]types.AttributeValue{
			"requestId": &types.AttributeValueMemberS{Value: requestId},
		},
		UpdateExpression: aws.String("ADD #currentCount :n SET #updatedAt = :newChangeMadeAt, #state = :state"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":n":                  &types.AttributeValueMemberN{Value: "1"},
			":newChangeMadeAt":    &types.AttributeValueMemberN{Value: strconv.FormatInt(now, 10)},
			":modifiedAtFromItem": &types.AttributeValueMemberN{Value: fmt.Sprintf("%d", modifiedAt)},
			":state":              &types.AttributeValueMemberS{Value: "CONVERTING"},
		},
		ExpressionAttributeNames: map[string]string{
			"#currentCount": countAttribute,
			"#updatedAt":    "modifiedAt",
			"#state":        "state",
		},
		ConditionExpression: &conditionExpression,
		ReturnValues:        returnValues,
	})

	if err != nil {
		log.Printf("%s\nRetries left %d, retry mode%d\n", err, retryState.retriesLeft, retryState.retryMode)
		if retryState.retryMode == Exponential {
			// TODO jitter
			retryState.delay = 2 * retryState.delay
		}

		retryState.retriesLeft -= 1
		time.Sleep(time.Duration(retryState.delay) * time.Millisecond)
		return updateCount(ctx, requestId, countAttribute, returnValues, retryState)
	}

	return updated, nil
}

// TODO break this into 3 funcs - download - convert - upload
func convertImage(ctx context.Context, entity events.S3Entity) error {
	bucket := entity.Bucket.Name
	key := entity.Object.Key
	requestId := strings.Split(key, "/")[1]
	if _, err := updateCount(ctx, requestId, "uploadedFiles", types.ReturnValueNone, defaultRetryState); err != nil {
		return err
	}
	metadata, err := getMetadata(ctx, bucket, key)
	if err != nil {
		return err
	}

	targetMime := metadata["target-mime"]
	originalName := metadata["original-name"]

	if _, ok := targetMimeToImgConvFormat[targetMime]; !ok {
		return fmt.Errorf("%s format is unsupported", targetMime)
	}

	fileName := getFileNameFromKey(key)
	convertedFileName := getConvertedFileName(targetMime, fileName)
	originalFilePath := fmt.Sprintf("%s/%s", validPath, fileName)
	if _, err := downloadKeyToFile(ctx, key, bucket, originalFilePath); err != nil {
		log.Println("Error while downloading file")
		return err
	}

	fileFromS3, err := imgconv.Open(originalFilePath)
	if err != nil {
		return err
	}

	convertedFilePath := fmt.Sprintf("%s/%s", validPath, convertedFileName)
	if err := imgconv.Save(convertedFilePath, fileFromS3, &imgconv.FormatOption{Format: targetMimeToImgConvFormat[targetMime]}); err != nil {
		log.Printf("Error while converting file")
		return err
	}

	destKey := fmt.Sprintf("Converted/%s/%s", requestId, convertedFileName)
	if err := uploadToS3(ctx, destKey, bucket, convertedFilePath, originalName); err != nil {
		log.Println("Error while uploading file")
		return err
	}

	requestItem := RequestItem{}
	resp, err := updateCount(ctx, requestId, "convertedFiles", types.ReturnValueAllNew, defaultRetryState)
	if err != nil {
		return err
	}
	attributevalue.UnmarshalMap(resp.Attributes, &requestItem)
	log.Printf("ConvertedFiles %d\n", requestItem.ConvertedFiles)

	if err := pushToQueue(ctx, &requestItem, bucket); err != nil {
		return err
	}

	if err := os.Remove(originalFilePath); err != nil {
		log.Println("Error deleting original file from S3 on lambda disk")
		return err
	}

	if err := os.Remove(convertedFilePath); err != nil {
		log.Println("Error deleting converted file on lambda disk")
		return err
	}

	return nil
}

func HandleRequest(ctx context.Context, event events.SNSEvent) (string, error) {
	eventJson, _ := json.Marshal(event)
	log.Printf("Event: %s", eventJson)
	var s3Json events.S3Event
	json.Unmarshal([]byte(event.Records[0].SNS.Message), &s3Json)
	var s3Entity events.S3Entity = s3Json.Records[0].S3
	key := s3Entity.Object.Key
	requestId := strings.Split(key, "/")[1]
	log.Printf("S3 Object key: %s", key)

	extension, err := getExtensionFromString(key)
	if err != nil {
		log.Printf("Err %s", err)
		return "", err
	}
	if extension == "heic" {
		log.Println("heic format, nothing to do")
		return "ok", nil
	}

	log.Printf("Source image extension: %s", extension)
	err = convertImage(ctx, s3Entity)
	if err != nil {
		log.Panicln(err)
		updateStatus(ctx, requestId, "FAILED")
		return "", err
	}
	_, err = deleteObject(ctx, requestId, s3Entity.Bucket.Name, key)
	return "ok", err
}

func main() {
	lambda.Start(HandleRequest)
}

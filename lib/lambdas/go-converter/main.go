package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"log"
	"os"
	"strings"
)

type void struct{}

var member void

// can convert from / to these formats
var validFormats = map[string]void{
	"jpeg": member,
	"jpg":  member,
	"png":  member,
	"gif":  member,
	"tif":  member,
	"tiff": member,
	"pdf":  member,
	"bmp":  member,
}

var awsS3Client *s3.Client
var ddbClient *dynamodb.Client
var region string
var queueUrl string
var tableName string

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
}

func getExtensionFromString(fileName string) (string, error) {
	splitted := strings.Split(fileName, ".")
	length := len(splitted)
	if length == 0 {
		return "", errors.New("can't convert file with no extension")
	}
	return splitted[length-1], nil
}

// func getS3Object(bucket, key string) {

// }

func convertImage(ctx context.Context, entity events.S3Entity) error {
	bucket := entity.Bucket.Name
	key := entity.Object.Key
	// requestId := strings.Split(key, "/")[1]

	// TODO update uploaded count
	headObj, err := awsS3Client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	})

	if err != nil {
		return err
	}

	targetMime := headObj.Metadata["target-mime"]
	originalName := headObj.Metadata["orignal-name"]

	log.Printf("targetMime %s, originalName %s\n", targetMime, originalName)
	return nil
}

func HandleRequest(ctx context.Context, event events.SNSEvent) (string, error) {
	setEnvVars()
	configClients()
	eventJson, _ := json.Marshal(event)
	log.Printf("Event: %s", eventJson)
	var s3Json events.S3Event
	json.Unmarshal([]byte(event.Records[0].SNS.Message), &s3Json)
	var s3Entity events.S3Entity = s3Json.Records[0].S3
	key := s3Entity.Object.Key
	log.Printf("S3 Object key: %s", key)

	extension, err := getExtensionFromString(key)
	if err != nil {
		log.Printf("Err %s", err)
		return "", err
	}
	if extension == "heic" {
		log.Println("heic format, nothing to do")
		return "ok", nil
	} else if _, ok := validFormats[extension]; !ok {
		err := fmt.Errorf("%s format is unsupported", extension)
		log.Println(err)
		return "", err
	}
	log.Printf("Source image extension: %s", extension)
	// log.Println("Golang lambda image conversion not yet implemented!")
	err = convertImage(ctx, s3Entity)
	if err != nil {
		log.Panicln(err)
		return "", err
	}
	return "ok", nil
}

func main() {
	lambda.Start(HandleRequest)
}

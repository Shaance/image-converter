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
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/sunshineplan/imgconv"
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

func getConvertedFileName(targetMime, originalName string) string {
	tmp := strings.Split(targetMime, "/")
	return fmt.Sprintf("%s.%s", originalName, tmp[len(tmp)-1])
}

func getFileNameFromKey(key string) string {
	tmp := strings.Split(key, "/")
	return tmp[len(tmp)-1]
}

func downloadKeyToFile(ctx context.Context, key, bucket, fileName string) (*os.File, error) {
	fileFromS3, err := os.Create(fileName)
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

func uploadToS3(ctx context.Context, key, bucket, fileName string) error {
	fileToUpload, err := os.Open(fileName)
	if err != nil {
		return err
	}
	defer fileToUpload.Close()

	uploader := manager.NewUploader(awsS3Client)
	result, err := uploader.Upload(ctx, &s3.PutObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
		Body:   fileToUpload,
	})

	if err != nil {
		return err
	}

	log.Println("File Uploaded Successfully, URL : ", result.Location)

	return nil
}

// TODO break this into 3 funcs - download - convert - upload
func convertImage(ctx context.Context, entity events.S3Entity) error {
	bucket := entity.Bucket.Name
	key := entity.Object.Key
	requestId := strings.Split(key, "/")[1]

	// TODO update uploaded coun
	headObj, err := awsS3Client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
	})

	if err != nil {
		return err
	}

	targetMime := headObj.Metadata["target-mime"]
	originalName := headObj.Metadata["original-name"]
	log.Printf("targetMime %s, originalName %s\n", targetMime, originalName)
	// TODO check targetMime (but should be done at pre-sign instead of here)
	fileName := getFileNameFromKey(key)
	convertedFileName := getConvertedFileName(targetMime, originalName)
	log.Printf("fileName %s, convertedFileName %s\n", fileName, convertedFileName)
	if _, err := downloadKeyToFile(ctx, key, bucket, fileName); err != nil {
		log.Println("Error while downloading file")
		return err
	}

	fileFromS3, err := imgconv.Open(fileName)
	if err != nil {
		return err
	}
	// use targetMime for target formnat
	if err := imgconv.Save(convertedFileName, fileFromS3, &imgconv.FormatOption{Format: imgconv.JPEG}); err != nil {
		log.Printf("Error while converting file")
		return err
	}

	destKey := fmt.Sprintf("Converted/%s/%s", requestId, convertedFileName)
	if err := uploadToS3(ctx, destKey, bucket, convertedFileName); err != nil {
		log.Println("Error while uploading file")
		return err
	}

	if err := os.Remove(fileName); err != nil {
		log.Println("Error deleting original file from S3 on lambda disk")
		return err
	}

	if err := os.Remove(convertedFileName); err != nil {
		log.Println("Error deleting converted file on lambda disk")
		return err
	}

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

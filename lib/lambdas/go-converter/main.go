package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"log"
	"errors"
	"strings"
)

type void struct{}
var member void

// can convert from / to these formats
var validFormats = map[string]void {
    "jpeg": member,
    "jpg": member,
    "png": member,
    "gif": member,
    "tif": member,
    "tiff": member,
    "pdf": member,
    "bmp": member,
}

func getExtensionFromString(fileName string) (string, error) {
	splitted := strings.Split(fileName, ".")
	length := len(splitted)
	if length == 0 {
		return "", errors.New("can't convert file with no extension")
	}
	return splitted[length-1], nil
}

func HandleRequest(ctx context.Context, event events.SNSEvent) (string, error) {
	eventJson, _ := json.Marshal(event)
	log.Printf("Event: %s", eventJson)
    var s3Json events.S3Event
    json.Unmarshal([]byte(event.Records[0].SNS.Message), &s3Json)
    key := s3Json.Records[0].S3.Object.Key
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
    log.Println("Golang lambda image conversion not yet implemented!")
    return "ok", nil
}

func main() {
	lambda.Start(HandleRequest)
}

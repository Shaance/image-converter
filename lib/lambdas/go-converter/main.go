package main

import (
	"context"
	"encoding/json"
	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	// "github.com/aws/aws-lambda-go/lambdacontext"
	"log"
	// "os"
)

func HandleRequest(ctx context.Context, event events.SNSEvent) (string, error) {
	eventJson, _ := json.Marshal(event)
	log.Printf("Event: %s", eventJson)
    var s3Json events.S3Event
    json.Unmarshal([]byte(event.Records[0].SNS.Message), &s3Json)
    log.Printf("S3 Object key: %s", s3Json.Records[0].S3.Object.Key)

    return "ok", nil
}

func main() {
	lambda.Start(HandleRequest)
}

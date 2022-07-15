package main

import (
	"context"
	"github.com/aws/aws-lambda-go/lambda"
    "github.com/aws/aws-lambda-go/events"
    "log"
    "encoding/json"
    "os"
    "github.com/aws/aws-lambda-go/lambdacontext"
)

func HandleRequest(ctx context.Context, event events.SQSEvent) (string, error) {
    log.Println(event)
    // event
	eventJson, _ := json.MarshalIndent(event, "", "  ")
	log.Printf("EVENT: %s", eventJson)
	// environment variables
	log.Printf("REGION: %s", os.Getenv("AWS_REGION"))
	log.Println("ALL ENV VARS:")
	for _, element := range os.Environ() {
		log.Println(element)
	}
	// request context
	lc, _ := lambdacontext.FromContext(ctx)
	log.Printf("REQUEST ID: %s", lc.AwsRequestID)

	return "Hello from go", nil
}

func main() {
	lambda.Start(HandleRequest)
}

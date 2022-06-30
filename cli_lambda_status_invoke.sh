#!/bin/zsh

aws --region eu-west-1 lambda invoke \
    --function-name HeicToJpgStack-StatusLambdaC33D2097-Cv2jAvmPNzfU \
    --cli-binary-format raw-in-base64-out \
    --payload file://local-status-event.json \
    --log-type Tail response-status.json \
    | grep "LogResult"| awk -F'"' '{print $4}' | base64 --decode > response-status.log
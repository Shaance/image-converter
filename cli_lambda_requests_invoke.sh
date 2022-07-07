#!/bin/zsh

aws --region eu-west-1 lambda invoke \
    --function-name HeicToJpgStack-RequestsLambda30155EB4-3iyQ9PELnlnj \
    --cli-binary-format raw-in-base64-out \
    --log-type Tail response-requests.json \
    | grep "LogResult"| awk -F'"' '{print $4}' | base64 --decode > response-requests.log
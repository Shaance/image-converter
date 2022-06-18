```
aws lambda invoke \
    --function-name HeicToJpgStack-PreSignLambda281BAB7C-0RCZ89sMddBU \
    --cli-binary-format raw-in-base64-out \
    --payload file://local-pre-sign-event.json \
    --log-type Tail response.json \
    | grep "LogResult"| awk -F'"' '{print $4}' | base64 --decode > response-pre-sign.log

```
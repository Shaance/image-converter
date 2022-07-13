#!/bin/zsh

npm run build && npm run cdk synth && sam local invoke PreSignLambda281BAB7C \
-e ./local-pre-sign-event.json \
-t ./cdk.out/HeicToJpgStack.template.json > response-local-presign.json

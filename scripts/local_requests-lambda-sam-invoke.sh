#!/bin/zsh

npm run build && npm run cdk synth && sam local invoke RequestsLambda30155EB4 \
-e ./local-requests-event.json \
-t ./cdk.out/HeicToJpgStack.template.json > response-local-requests.json

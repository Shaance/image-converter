#!/bin/zsh

npm run build && npm run cdk synth && sam local invoke ConvertLambda507ACFE1 \
-e ./local-converter-event.json \
-t ./cdk.out/HeicToJpgStack.template.json > response-local-converter.json

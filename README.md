# Image conversion

## Description
This repo contains code to deploy an AWS infrastructure managed through [CDK](https://aws.amazon.com/cdk/) framework as well as lambda functions (node16 + go1.x) aimed to do image conversion.

## Supported formats
From [heic](https://www.adobe.com/creativecloud/file-types/image/raster/heic-file.html) to
- JPG
- PNG

From any to any of these:
- JPEG
- PNG
- PDF
- GIF
- TIF
- BMP


## High level design diagram
TODO

## API descriptions

TODO

## Backlog

This project lacks lots of stuff, you can find more on what would be nice additions in [backlog.md](https://github.com/Shaance/heic-to-jpg-aws/blob/main/backlog.md) file

## Known issues
Some format conversions are very slow and will timeout:
- JPEG to PNG
- JPEG to GIF
- probably others
## Example client
- [App link](https://images.hashcode.dev/)
- [Repo link](https://github.com/Shaance/image-converter-client)

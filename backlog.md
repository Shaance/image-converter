# Backlog
## One active request per IP
- Soft limit by creating a GSI with PK IP and SK state and check we don't have any request other than DONE / FAILED ones on new request
- Adapt canary tests

## Tests
- Unit tests
- Integ tests
- Canary tests
  - Convert API
  - Zipper API

## Soft limit number of requests per day
- GSI (PK: IP, sort key: createdAt) to soft limit number of requests per day? (100?)

## Global rate limiting
- global rate limiting per IP using AWS WAF which sits in front of API gateway   
- has to be complementary with the soft limit on max number of requests per day as WAF min threshold to start block is 100 requests per 5 min
- benefits:
  - WAF blocks the requests and lambdas don't have to take the load (only 1000 max concurrent exec per account per region)
  - WAF also has managed rules which prevents us from common vulnerabilities: https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-baseline.html 


## Shared layer for common code
- Some code are duplicated through Node.js lambdas, could create a layer to centralize that


## Simplify file names (not sure)
- In current implem, the images that are uploaded with an server generated uuid name
- We only put the original name back when building the archive

## Alarms
- Create alarms based on latency, faults, DLQ not empty metrics

## Some conversions are too expensive
- Jpg to png + jpg to gif extremely slow, doesn't finish in 50s
- either remove that option by blocking at presign or maybe try another lib

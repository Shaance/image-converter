const axios = require('axios').default;
const requestsUrl = process.env.REQUESTS_API_URL as string;
const presignUrl = process.env.PRESIGN_API_URL as string;

function toLambdaOutput(statusCode: number, body: any) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    isBase64Encoded: false
  };
}

export const handler = async () => {
  try {
    const requestsResponse = await axios.get(requestsUrl + '?nbFiles=8')
    const requestId = requestsResponse.data.requestId
    const targetMime = "image/jpeg"
    const fileName = "canarytestFile.heic"
    const url = presignUrl + `?requestId=${requestId}&fileName=${fileName}&targetMime=${targetMime}`
    await axios.get(url)
  } catch (error) {
    console.error(error);
    return toLambdaOutput(500, error)
  }

  return toLambdaOutput(200, "ok")
}

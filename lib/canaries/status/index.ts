const axios = require('axios').default;
const requestsUrl = process.env.REQUESTS_API_URL as string;
const statusUrl = process.env.STATUS_API_URL as string;

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
    const requestsResponse = await axios.get(requestsUrl + '?nbFiles=5')
    const requestId = requestsResponse.data.requestId
    await axios.get(statusUrl + `?requestId=${requestId}`)
  } catch (error) {
    console.error(error);
    return toLambdaOutput(500, error)
  }

  return toLambdaOutput(200, "ok")
}

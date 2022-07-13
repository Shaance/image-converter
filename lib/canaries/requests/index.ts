const axios = require('axios').default;

const url = process.env.REQUESTS_API_URL as string;

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

async function getRequest() {
  await axios
    .get(url + '?nbFiles=5')
    .then((res: any) => {
      console.log(res.data);
    })
    .catch((error: any) => {
      console.error(error);
      throw new Error(`Error! ${error.status}`);
    });
}

export const handler = async () => {
  try  {
    await getRequest()
  } catch (err) {
    console.log(err);
    return toLambdaOutput(500, err)
  }

  return toLambdaOutput(200, "ok")
}

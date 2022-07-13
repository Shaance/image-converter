import { get } from 'request'

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
  get(url + '?nbFiles=5', { json: true }, (err, res) => {
    if (err) {
      throw new Error(`Error! status: ${err.status}`);
    }

    console.log(res.body)
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

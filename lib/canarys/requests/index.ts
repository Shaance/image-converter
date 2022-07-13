import fetch from 'node-fetch';

const url = process.env.REQUESTS_API_URL as string;

async function getRequest() {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Error! status: ${response.status}`);
    }

    const result = (await response.json());
    console.log('result is: ', JSON.stringify(result, null, 4));

    return result;
  } catch (error) {
    console.log('error: ', error);
    throw error
  }
}

await (getRequest)()

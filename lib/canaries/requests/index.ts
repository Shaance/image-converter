import { get } from 'request'

const url = process.env.REQUESTS_API_URL as string;

async function getRequest() {
  get(url, { json: true }, (err, res) => {
    if (err) {
      console.log(err);
      throw new Error(`Error! status: ${err.status}`);
    }

    console.log(res.body)
  });
}

export const handler = async () => {
  await getRequest()
}

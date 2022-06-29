export interface LambdaOutput {
  statusCode: number;
  headers: {
    "Content-Type": string;
  };
  body: any;
}

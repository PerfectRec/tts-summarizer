const UNSTRUCTURED_API_KEY = "Wzymd5niaHuo61O5C4aavbsnNC66jy";
const UNSTRUCTURED_API_URL =
  "https://api.unstructuredapp.io/general/v0/general";

import { UnstructuredClient } from "unstructured-client";
import { PartitionResponse } from "unstructured-client/sdk/models/operations";
import { Strategy } from "unstructured-client/sdk/models/shared";
import * as fs from "fs";

const key = UNSTRUCTURED_API_KEY;
const url = UNSTRUCTURED_API_URL;

const client = new UnstructuredClient({
  serverURL: url,
  security: {
    apiKeyAuth: key,
  },
});

const filename = "./tests/attention_is_all_you_need.pdf";
const data = fs.readFileSync(filename);

client.general
  .partition({
    partitionParameters: {
      files: {
        content: data,
        fileName: filename,
      },
      strategy: Strategy.HiRes,
      splitPdfPage: true,
      splitPdfAllowFailed: true,
      splitPdfConcurrencyLevel: 15,
      languages: ["eng"],
    },
  })
  .then((res: PartitionResponse) => {
    if (res.statusCode == 200) {
      // Print the processed data's first element only.
      console.log(res.elements?.[0]);

      // Write the processed data to a local file.
      const jsonElements = JSON.stringify(res.elements, null, 2);

      fs.writeFileSync("./src/manual/unstructuredoutput.json", jsonElements);
    }
  })
  .catch((e) => {
    if (e.statusCode) {
      console.log(e.statusCode);
      console.log(e.body);
    } else {
      console.log(e);
    }
  });

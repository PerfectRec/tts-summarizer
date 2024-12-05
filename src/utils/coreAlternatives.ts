import { z } from "zod";
import { getStructuredOpenAICompletionWithRetries } from "./openai";

export async function labelTable(
  runId: string,
  logBuffer: string[],
  item: Item,
  items: Item[],
  pageIndex: number,
  pagePath: any
): Promise<void> {
  console.log("labeling table on page ", pageIndex + 1);
  logBuffer.push(`labeling table on page ${pageIndex + 1}`);

  const MODEL: Model = "gpt-4o-2024-08-06";
  const TEMPERATURE = 0.2;
  const RETRIES = 3;
  const USER_PROMPT = `Table to label on this page:\n${JSON.stringify(
    item
  )}\n\nPage context:\n${JSON.stringify(items)}`;
  const SYSTEM_PROMPT = `Add the label "Table X" where X is the table number indicated in the page. You need to extract the correct table number. This is very important. Look for cues around the table and use your best judgement to determine it. Add the panel number that is being summarized, if it is mentioned.
  
  It is possible that a table can be part of a figure and labeled as a figure, in that case label it as a figure.`;
  const SCHEMA = z.object({
    labeledItem: z.object({
      type: z.enum(["table_rows"]),
      label: z.object({
        labelType: z.string(),
        labelNumber: z.string(),
        panelNumber: z.string().optional(),
      }),
    }),
  });

  const labeledTable = await getStructuredOpenAICompletionWithRetries(
    runId,
    SYSTEM_PROMPT,
    USER_PROMPT,
    MODEL,
    TEMPERATURE,
    SCHEMA,
    RETRIES,
    [pagePath]
  );

  item.label = labeledTable?.labeledItem.label;
  if (item.label) {
    item.labelString = `${
      item.label.labelType !== "" ? item.label.labelType : ""
    }${
      !["unlabeled", ""].includes(item.label.labelNumber.toLocaleLowerCase())
        ? ` ${item.label.labelNumber}`
        : ""
    }`;
    item.content = item.labelString;
  }
}

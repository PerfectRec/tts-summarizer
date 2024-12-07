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
    if (item.labelString) {
      item.content = item.labelString;
    }
  }
}

export async function labelFigure(
  runId: string,
  logBuffer: string[],
  item: Item,
  items: Item[],
  pageIndex: number,
  pagePath: any
): Promise<void> {
  console.log("labeling figure on page ", pageIndex + 1);
  logBuffer.push(`labeling figure on page ${pageIndex + 1}`);

  const MODEL: Model = "gpt-4o-2024-08-06";
  const TEMPERATURE = 0.4;
  const RETRIES = 3;
  const USER_PROMPT = `Figure to label on this page:\n${JSON.stringify(
    item
  )}\n\nPage context:\n${JSON.stringify(items)}`;
  const OUTPUT_TOKENS = 16384;
  const FREQUENCY_PENALTY = 0;
  const SYSTEM_PROMPT = `Add the label "Figure X" where X is the figure number indicated in the page. You need to extract the correct label type and label number. This is VERY IMPORTANT. Look for cues around the figure and use your best judgement to determine it. Possible label types can be Figure, Chart, Image etc.
  
  If there is no label or label number set the labelType as "Image" and labelNumber as "unlabeled".`;
  const SCHEMA = z.object({
    summarizedItem: z.object({
      type: z.enum(["figure_image"]),
      label: z.object({
        labelType: z.string(),
        labelNumber: z.string(),
        panelNumber: z.string().optional(),
      }),
    }),
  });

  const EXAMPLE_PAIRS = [
    {
      userImage: "./src/prompt/figures/AIAYN_FIG_1.png",
      assistantOutput: `{
                            type: "figure_image",
                            label: {
                              labelType: "Figure",
                              labelNumber: "1",
                              panelNumber: ""
                            }
                          }`,
    },
    {
      userImage: "./src/prompt/figures/ALHGALW_FIG_2.png",
      assistantOutput: `{
                            type: "figure_image",
                            label: {
                              labelType: "Figure",
                              labelNumber: "2",
                              panelNumber: ""
                            }
                          }`,
    },
    {
      userImage: "./src/prompt/figures/COCD_FIG_1.png",
      assistantOutput: `{
                            type: "figure_image",
                            label: {
                              labelType: "Figure",
                              labelNumber: "1",
                              panelNumber: ""
                            }
                          }`,
    },
    {
      userImage: "./src/prompt/figures/TYE_FIG_2.png",
      assistantOutput: `{
                            type: "figure_image",
                            label: {
                              labelType: "Figure",
                              labelNumber: "1",
                              panelNumber: ""
                            }
                          }`,
    },
    {
      userImage: "./src/prompt/figures/TYE_FIG_3.png",
      assistantOutput: `{
                            type: "figure_image",
                            label: {
                              labelType: "Figure",
                              labelNumber: "1",
                              panelNumber: ""
                            }
                          }`,
    },
  ];

  const labeledFigure = await getStructuredOpenAICompletionWithRetries(
    runId,
    SYSTEM_PROMPT,
    USER_PROMPT,
    MODEL,
    TEMPERATURE,
    SCHEMA,
    RETRIES,
    [pagePath],
    OUTPUT_TOKENS,
    FREQUENCY_PENALTY,
    EXAMPLE_PAIRS
  );

  item.label = labeledFigure?.labeledItem.label;
  if (item.label) {
    item.labelString = `${
      item.label.labelType !== "" ? item.label.labelType : ""
    }${
      !["unlabeled", ""].includes(item.label.labelNumber.toLocaleLowerCase())
        ? ` ${item.label.labelNumber}`
        : ""
    }`;
    if (item.labelString) {
      item.content = item.labelString;
    }
  }
}

export async function labelCodeOrAlgorithm(
  runId: string,
  logBuffer: string[],
  item: Item,
  items: Item[],
  pageIndex: number,
  pagePath: any
): Promise<void> {
  console.log("labeling code or algorithm on page ", pageIndex + 1);
  logBuffer.push(`labeling code or algorithm on page ${pageIndex + 1}`);

  const MODEL: Model = "gpt-4o-2024-08-06";
  const TEMPERATURE = 0.3;
  const RETRIES = 3;
  const OUTPUT_TOKENS = 16384;
  const FREQUENCY_PENALTY = 0;
  const USER_PROMPT = `Code or algorithm to summarize:\n${JSON.stringify(
    item
  )}\n\nPage context:\n${JSON.stringify(items)}`;
  const SYSTEM_PROMPT = `Usually codeblocks do not have labels. If there is no label or label number set the labelType as "" and labelNumber as "unlabeled". If there is no panel number set the panelNumber as "unlabeled"

  Sometimes codeblocks can be labeled. If the codeblock is labeled as a "Figure", then try to detect the "Figure X" label where X is the number assigned to the figure. Look around for clues to help you determine this.`;
  const SCHEMA = z.object({
    labeledCode: z.object({
      type: z.string(z.enum(["code_or_algorithm"])),
      title: z.string(),
      label: z.object({
        labelType: z.string(),
        labelNumber: z.string(),
        panelNumber: z.string().optional(),
      }),
    }),
  });

  const labeledCode = await getStructuredOpenAICompletionWithRetries(
    runId,
    SYSTEM_PROMPT,
    USER_PROMPT,
    MODEL,
    TEMPERATURE,
    SCHEMA,
    RETRIES,
    [pagePath],
    OUTPUT_TOKENS,
    FREQUENCY_PENALTY
  );

  item.label = labeledCode?.labeledCode?.label;
  item.title = labeledCode?.labeledCode?.title;
  if (item.label) {
    item.labelString = `${
      item.label.labelType !== "" ? item.label.labelType : ""
    }${
      !["unlabeled", ""].includes(item.label.labelNumber.toLocaleLowerCase())
        ? ` ${item.label.labelNumber}`
        : ""
    }`;
    if (item.labelString) {
      item.content = item.labelString;
    }
  }
}

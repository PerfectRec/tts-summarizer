import { PngPageOutput } from "pdf-to-png-converter";
import { z } from "zod";
import { getStructuredOpenAICompletionWithRetries } from "./openai";
import { removeBreaks } from "./ssml";

/**
 * This function determines the relevance of each page in a given set of PNG pages.
 * It uses an OpenAI model to classify whether a page contains relevant information or meta information.
 * Relevant pages are those that contain the main content of the document, while irrelevant pages contain meta information such as journal or publisher details.
 * The function processes the pages in batches for efficiency and logs the relevance of each page.
 *
 * @param {string} runId - The unique identifier for the current run.
 * @param {string[]} logBuffer - The buffer to store log messages.
 * @param {PngPageOutput[]} pngPagesOriginal - The list of PNG pages to be evaluated.
 * @returns {Promise<PngPageOutput[]>} - A promise that resolves to an array of objects indicating the index and relevance of each page.
 */

export async function determineRelevantPages(
  runId: string,
  logBuffer: string[],
  pngPagesOriginal: PngPageOutput[]
): Promise<PngPageOutput[]> {
  const MODEL: Model = "gpt-4o-2024-08-06";
  const TEMPERATURE = 0.1;
  const CONCURRENCY = 20;
  const OUTPUT_TOKENS = 64;
  const FREQUENCY_PENALTY = 0;
  const RETRIES = 3;
  const USER_PROMPT = ``;
  const SYSTEM_PROMPT = `Determine if the following page is relevant and contains on topic information. If it contains meta information about journal or publisher or some other meta information, return false. For example if it a research paper anything that is not the main content of the paper is irrelevant. If the page contains references only, return false. However, if the page contains references and other information, return true. Accurately judge what is and what is not relevant`;
  const SCHEMA = z.object({
    isRelevant: z.boolean(),
  });

  let allBatchResults: { index: number; relevant: boolean }[] = [];

  for (let i = 0; i < pngPagesOriginal.length; i += CONCURRENCY) {
    const batch = pngPagesOriginal.slice(i, i + CONCURRENCY);

    const batchResults = await Promise.all(
      batch.map(async (pngPageOriginal, index) => {
        // Replacing classifyPageContent with the new logic

        try {
          const classificationResult =
            await getStructuredOpenAICompletionWithRetries(
              runId,
              SYSTEM_PROMPT,
              USER_PROMPT,
              MODEL,
              TEMPERATURE,
              SCHEMA,
              RETRIES,
              [pngPageOriginal.path],
              OUTPUT_TOKENS,
              FREQUENCY_PENALTY
            );

          const pageIsUseful = classificationResult?.isRelevant ?? true;
          console.log(`Page ${i + index + 1} is relevant: `, pageIsUseful);
          return { index: index + i, relevant: pageIsUseful };
        } catch (error) {
          console.error("Error during classification", error);
          return { index: index + i, relevant: true };
        }
      })
    );

    allBatchResults = allBatchResults.concat(batchResults);
  }

  return pngPagesOriginal.filter((_, index) => {
    const result = allBatchResults.find((result) => result.index === index);
    return result?.relevant ?? true;
  });
}

/**
 * This function processes a list of PNG pages and extracts structured JSON data from each page.
 * It uses an AI model to identify and categorize various elements on the page, such as text, headings,
 * figures, tables, and more. The function processes the pages in batches and returns the extracted items
 * in the correct order, ensuring that no text or relevant information is excluded.
 *
 * @param {string} runId - The unique identifier for the current run.
 * @param {string[]} logBuffer - A buffer to store log messages.
 * @param {Item[]} allItems - A list to store all extracted items.
 * @param {PngPageOutput[]} pngPages - The list of PNG pages to be processed.
 * @param {string} authorInfoContents - The contents related to the author information.
 * @param {string} mainTitleContents - The contents related to the main title.
 * @returns {Promise<void>} - A promise that resolves when the extraction is complete.
 */

export async function extractJsonFromImages(
  runId: string,
  logBuffer: string[],
  allItems: Item[],
  pngPages: PngPageOutput[],
  authorInfoContents: string,
  mainTitleContents: string
): Promise<void> {
  const MODEL: Model = "gpt-4o-2024-08-06";
  const TEMPERATURE = 0.5;
  const CONCURRENCY = 20;
  const USER_PROMPT = ``;
  const FREQUENCY_PENALTY = 0.2;
  const OUTPUT_TOKENS = 16384;
  const RETRIES = 3;
  const SYSTEM_PROMPT = `Please extract all the items in the page in the correct order. Do not exclude any text. 
  
  The text of one paragraph should always be one single text item.
  
  Please include math expressions.
            
  Include partial text cut off at the start or end of the page. 
  
  Combine all rows of a table into a single table_rows item.

  Make sure to detect code and algorithms as seperate items out of text.
  
  Please use your best judgement to determine the abstract even if it is not explicitly labeled as such.
  
  Usually, text item starting with a superscript number is an endnote.`;
  const SCHEMA = z.object({
    items: z.array(
      z.object({
        type: z.enum([
          "main_title",
          "text",
          "heading",
          "figure_image",
          "figure_caption_or_heading",
          "figure_note",
          "non_figure_image",
          "table_rows",
          "table_descrption_or_heading",
          "table_notes",
          "author_info",
          "footnotes",
          "meta_or_publication_info",
          "references_heading",
          "references_item",
          "math",
          "table_of_contents_heading",
          "table_of_contents_item",
          "abstract_heading",
          "abstract_content",
          "page_number",
          "code_or_algorithm",
          "endnotes_item",
          "endnotes_heading",
          "JEL_classification",
          "JSTOR_meta_information",
          "CCS_concepts",
          "keywords",
          "acknowledgements_heading",
          "acknowledgements_content",
          "references_format_information",
        ]),
        content: z.string(),
      })
    ),
  });

  for (let i = 0; i < pngPages.length; i += CONCURRENCY) {
    const batch = pngPages.slice(i, i + CONCURRENCY);

    const batchResults = await Promise.all(
      batch.map(async (pngPage, index) => {
        console.log("processing page ", i + index + 1);
        logBuffer.push(`processing page ${i + index + 1}`);

        const pagePath = pngPage.path;
        const pageItems = await getStructuredOpenAICompletionWithRetries(
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

        let items = pageItems?.items;

        console.log("processed page ", i + index + 1);
        logBuffer.push(`processed page ${i + index + 1}`);

        //combining contiguous math items
        let combinedItems: any[] = [];
        for (let i = 0; i < items.length; i++) {
          if (items[i].type === "math") {
            let combinedContent = items[i].content;
            while (i + 1 < items.length && items[i + 1].type === "math") {
              combinedContent += " " + items[i + 1].content;
              i++;
            }
            combinedItems.push({
              type: "math",
              content: combinedContent,
              mathSymbolFrequency: 5,
            });
          } else {
            combinedItems.push(items[i]);
          }
        }
        items = combinedItems;

        items.forEach((item: any) => {
          item.page = i + index + 1;
        });

        //light postprocessing items
        for (const item of items) {
          item.content = item.content.replace(
            /https?:\/\/[^\s]+/g,
            "See URL in paper."
          );

          if (item.type === "author_info" && i < 5) {
            authorInfoContents += `\n\n${item.content}`;
          }

          if (item.type === "main_title" && i < 5) {
            mainTitleContents += `\n\n${item.content}`;
          }

          if (item.type.includes("heading")) {
            item.content = `[break0.7]${item.content}[break0.7]`;
          }

          if (item.type === "table_rows") {
            await summarizeTable(
              runId,
              logBuffer,
              item,
              items,
              index + i,
              pagePath
            );
          }

          if (item.type === "figure_image") {
            await summarizeFigure(
              runId,
              logBuffer,
              item,
              items,
              index + 1,
              pagePath
            );
          }

          if (item.type === "code_or_algorithm") {
            await summarizeCodeOrAlgorithm(
              runId,
              logBuffer,
              item,
              items,
              index + 1,
              pagePath
            );
          }
        }

        return { index: i + index, items };
      })
    );

    // Sort batch results by index to maintain order
    batchResults.sort((a, b) => a.index - b.index);

    // Add sorted items to allItems
    for (const result of batchResults) {
      allItems.push(...result.items);
    }
  }
}

/**
 * This function summarizes the content of a table found on a specific page.
 * It uses the OpenAI model to generate a concise and accurate summary of the table's data.
 * The summary includes the main points and patterns observed in the table,
 * and it replaces the raw rows in the content field with this summary.
 * The function also extracts and includes the correct table number and panel number, if mentioned.
 * The summary is designed to be easily understandable for users who are listening to it.
 *
 * @param {string} runId - The unique identifier for the current run.
 * @param {string[]} logBuffer - The buffer to store log messages.
 * @param {Item} item - The table item to be summarized.
 * @param {Item[]} items - The list of all items on the page.
 * @param {number} pageIndex - The index of the current page.
 * @param {any} pagePath - The path to the page.
 * @returns {Promise<void>} - A promise that resolves when the summarization is complete.
 */

export async function summarizeTable(
  runId: string,
  logBuffer: string[],
  item: Item,
  items: Item[],
  pageIndex: number,
  pagePath: any
): Promise<void> {
  console.log("summarizing table on page ", pageIndex + 1);
  logBuffer.push(`summarizing table on page ${pageIndex + 1}`);

  const MODEL: Model = "gpt-4o-2024-08-06";
  const TEMPERATURE = 0.2;
  const RETRIES = 3;
  const USER_PROMPT = `Table to summarize on this page:\n${JSON.stringify(
    item
  )}\n\nPage context:\n${JSON.stringify(items)}`;
  const SYSTEM_PROMPT = `Write a concise and effective summary for the table. Replace the raw rows in the content field with the summary. Summarize the size of changes / effects / estimates / results in the tables. Be very accurate while doing this analysis. You must get the patterns correct. To help understand them better, use context from the paper and any note below them. The summary should capture the main point of the table. Try to use as few numbers as possible. Keep in mind that the user cannot see the table as they will be listening to your summary. 
                
  Add the label "Table X" where X is the table number indicated in the page. You need to extract the correct table number. This is very important. Look for cues around the table and use your best judgement to determine it. Add the panel number that is being summarized, if it is mentioned.
  
  It is possible that a table can be part of a figure and labeled as a figure, in that case label it as a figure.
  
  Do not use markdown. Use plain text.`;
  const SCHEMA = z.object({
    summarizedItem: z.object({
      type: z.enum(["table_rows"]),
      label: z.object({
        labelType: z.string(),
        labelNumber: z.string(),
        panelNumber: z.string().optional(),
      }),
      content: z.string(),
    }),
  });

  const summarizedTable = await getStructuredOpenAICompletionWithRetries(
    runId,
    SYSTEM_PROMPT,
    USER_PROMPT,
    MODEL,
    TEMPERATURE,
    SCHEMA,
    RETRIES,
    [pagePath]
  );

  item.label = summarizedTable?.summarizedItem.label;
  item.content = `${item.label?.labelType} ${
    item.label?.labelNumber === "unlabeled" ? "" : item.label?.labelNumber
  } ${
    item.label?.panelNumber && item.label.panelNumber !== "unlabeled"
      ? `Panel ${item.label.panelNumber}`
      : ""
  } summary:\n${summarizedTable?.summarizedItem.content}`;
}

/**
 * This function summarizes a figure from a given page using an AI model.
 * It generates a detailed summary that includes a physical description of the image,
 * a description of the content, and accurate inferences and conclusions from the content.
 * The function processes the figure in the context of the entire page and ensures that the
 * correct label type and number are extracted. The summary is designed to be listened to,
 * so it avoids using markdown and focuses on clear, plain text.
 *
 * @param {string} runId - The unique identifier for the current run.
 * @param {string[]} logBuffer - A buffer to store log messages.
 * @param {Item} item - The figure item to be summarized.
 * @param {Item[]} items - The list of all items on the page.
 * @param {number} pageIndex - The index of the current page.
 * @param {any} pagePath - The path to the page image.
 * @returns {Promise<void>} - A promise that resolves when the summarization is complete.
 */

export async function summarizeFigure(
  runId: string,
  logBuffer: string[],
  item: Item,
  items: Item[],
  pageIndex: number,
  pagePath: any
): Promise<void> {
  console.log("summarizing figure on page ", pageIndex + 1);
  logBuffer.push(`summarizing figure on page ${pageIndex + 1}`);

  const MODEL: Model = "gpt-4o-2024-08-06";
  const TEMPERATURE = 0.4;
  const RETRIES = 3;
  const USER_PROMPT = `Figure to summarize on this page:\n${JSON.stringify(
    item
  )}\n\nPage context:\n${JSON.stringify(items)}`;
  const OUTPUT_TOKENS = 16384;
  const FREQUENCY_PENALTY = 0;
  const SYSTEM_PROMPT = `Write a detailed and effective summary for the figures. Replace the content field with the summary. 

  Every summary must have three subsections:
  1. Physical description of the image
  2. Description of the content of the figure
  3. Accurate inferences and conclusions from the content of the figure. 

  No need to explicitly mention each subsection.

  Add the label "Figure X" where X is the figure number indicated in the page. You need to extract the correct label type and label number. This is VERY IMPORTANT. Look for cues around the figure and use your best judgement to determine it. Possible label types can be Figure, Chart, Image etc.
  
  If there is no label or label number set the labelType as "Image" and labelNumber as "unlabeled".
  
  Do not use markdown. Use plain text.
  
  Remember that the user is going to listen to the output and cannot see the figure. Take that into account while producing the summary.`;
  const SCHEMA = z.object({
    summarizedItem: z.object({
      type: z.enum(["figure_image"]),
      label: z.object({
        labelType: z.string(),
        labelNumber: z.string(),
        panelNumber: z.string().optional(),
      }),
      content: z.string(),
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
                            "This figure is a diagram of the transformer model’s architecture, showing the steps take input tokens and produce output probabilities.  It has two components.  The left side is the encoder which begins with inputs, and the right side is the decoder which begins with outputs that are shifted right.  On the encoder side, first the input tokens are transformed into embeddings, which are then added to positional embeddings.  Then, there are 6 identical layers which include first a multi-head attention step, then a feed forward network. On the decoder side, the first steps are the same.  The input tokens are transformed into embeddings with positional embeddings added next.  Then, there are also 6 identical layers which are similar to this part of the encoder, but with an extra step.  The first step is masked multi-head attention, followed by multi-head attention over the output of the encoder stack.  Next comes the feed forward layer, just like in the encoder.  Finally, the last steps are a linear projection layer, and a softmax step which produces output probabilities."
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
                            content: "This figure plots the fraction of correct next-token predictions for 4 language models during training on a subset of the Pile training set, as a function of the number of training steps.  The four models are: SLM, Baseline, RKD and SALT.  Over the 200K steps shown, accuracy increases from around 55% to 58-60% after 200K steps, with increases slowing down as steps increase.  SALT outperforms baseline slightly for any number of steps, whereas SLM performs worse.  RKD performs better than baseline at first, but after around 75 thousand steps, begins to perform worse."
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
                            content: "This figure plots settler mortality against GDP per capita adjusted for purchasing power parity, both on a log scale.  Each data point is a country and a downward sloping line represents the strong negative correlation.  Data points are generally close to the line, with a few outliers."
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
                            content: "This figure shows cognitive outcome scores over 10 years.  It has 3 panels, each showing a different outcome for each of the four arms of the experiment, treatments for memory, reasoning, and speed, along with the control group.  The outcomes are scores for memory, reasoning and speed.  Each panel shows that the treatment associated with the each outcome resulted in larger increases in the score for that outcome, especially so for speed.  Each score for each treatment generally increase within the first year, peaks, and then declines after 3 years, especially between years 5 and 10."
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
                            content: "This figure plots self-reported IADL scores over 10 years for each of the 4 experimental groups, the 3 treatments, memory, reasoning, speed, as well as the control group. All groups have similar, roughly flat IADL scores for the first 3 years, which decline after.  In years 5 and 10, the control group’s scores are substantially lower than each of the treatments."
                          }`,
    },
  ];

  const summarizedItem = await getStructuredOpenAICompletionWithRetries(
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

  item.label = summarizedItem?.summarizedItem.label;
  item.content = `${item.label?.labelType} ${
    item.label?.labelNumber === "unlabeled" ? "" : item.label?.labelNumber
  } ${
    item.label?.panelNumber && item.label.panelNumber !== "unlabeled"
      ? `Panel ${item.label.panelNumber}`
      : ""
  } summary:\n${summarizedItem?.summarizedItem.content}`;
}

/**
 * This function summarizes the content of a code block or algorithm found on a specific page.
 * It uses the OpenAI model to generate a concise and clear summary of the code or algorithm,
 * explaining its purpose, inputs, and outputs in simple terms. The function also extracts or
 * generates an appropriate title for the code block. If the code block is labeled, it accurately
 * identifies and includes the label type and number. The summary is designed to be easily
 * understandable for users who are listening to it.
 *
 * @param {string} runId - The unique identifier for the current run.
 * @param {string[]} logBuffer - The buffer to store log messages.
 * @param {Item} item - The code or algorithm item to be summarized.
 * @param {Item[]} items - The list of all items on the page.
 * @param {number} pageIndex - The index of the current page.
 * @param {any} pagePath - The path to the page.
 * @returns {Promise<void>} - A promise that resolves when the summarization is complete.
 */

export async function summarizeCodeOrAlgorithm(
  runId: string,
  logBuffer: string[],
  item: Item,
  items: Item[],
  pageIndex: number,
  pagePath: any
): Promise<void> {
  console.log("summarizing code or algorithm on page ", pageIndex + 1);
  logBuffer.push(`summarizing code or algorithm on page ${pageIndex + 1}`);

  const MODEL: Model = "gpt-4o-2024-08-06";
  const TEMPERATURE = 0.3;
  const RETRIES = 3;
  const OUTPUT_TOKENS = 16384;
  const FREQUENCY_PENALTY = 0;
  const USER_PROMPT = `Code or algorithm to summarize:\n${JSON.stringify(
    item
  )}\n\nPage context:\n${JSON.stringify(items)}`;
  const SYSTEM_PROMPT = `Summarize the given code or algorithm. Explain what the code or algorithm does in simple terms including its input and output. Do not include any code syntax in the summary.
                
  Also extract the title of the algorithm or code block. If no title is mentioned, then generate an appropriate one yourself.
  
  Usually codeblocks do not have labels. If there is no label or label number set the labelType as "" and labelNumber as "unlabeled". If there is no panel number set the panelNumber as "unlabeled"

  Sometimes codeblocks can be labeled. If the codeblock is labeled as a "Figure", then try to detect the "Figure X" label where X is the number assigned to the figure. Look around for cuees to help you determine this.`;
  const SCHEMA = z.object({
    summarizedCode: z.object({
      type: z.string(z.enum(["code_or_algorithm"])),
      content: z.string(),
      title: z.string(),
      label: z.object({
        labelType: z.string(),
        labelNumber: z.string(),
        panelNumber: z.string().optional(),
      }),
    }),
  });

  const summarizedCode = await getStructuredOpenAICompletionWithRetries(
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

  item.label = summarizedCode?.summarizedCode?.label;
  item.title = summarizedCode?.summarizedCode?.title;
  item.content = `${item.label?.labelType} ${
    item.label?.labelNumber === "unlabeled" ? "" : item.label?.labelNumber
  } ${
    item.label?.panelNumber && item.label?.panelNumber !== "unlabeled"
      ? `Panel ${item.label.panelNumber}`
      : ""
  } code explanation:\n${summarizedCode?.summarizedCode.content}`;
}

/**
 * The `extractMainTitle` function utilizes the OpenAI model to extract the main title,
 * publication month, and year from the text content of the first five pages of a document.
 * It requires the run ID, log buffer, main title contents, and PNG pages as inputs.
 * The function returns an object containing the extracted title, month, year, and a formatted date string.
 * If the month or year is not detected, they are left empty.
 *
 * @param {string} runId - The unique identifier for the current run.
 * @param {string[]} logBuffer - An array to store log messages for the current process.
 * @param {string} mainTitleContents - The text content from which the main title is to be extracted.
 * @param {PngPageOutput[]} pngPages - An array of PNG page outputs to be processed.
 * @returns {Promise<{ extractedTitle: string; extractedMonth: string; extractedYear: string; formattedDate: string; }>}
 *          An object containing the extracted title, month, year, and a formatted date string.
 */

export async function extractMainTitle(
  runId: string,
  logBuffer: string[],
  mainTitleContents: string,
  pngPages: PngPageOutput[]
): Promise<{
  extractedTitle: string;
  extractedMonth: string;
  extractedYear: string;
  formattedDate: string;
}> {
  const MODEL: Model = "gpt-4o-2024-08-06";
  const TEMPERATURE = 0.2;
  const RETRIES = 3;
  const USER_PROMPT = `Here is the text from the first 5 pages: ${mainTitleContents}`;
  const SYSTEM_PROMPT = `Extract the main title and publication month and year of the document from the following text. Use your judgement to accurately determine the main title. Detect the month and year in MM and YYYY format. If the month or year is missing leave it empty.`;

  const SCHEMA = z.object({
    mainTitle: z.string(),
    monthMM: z.string(),
    yearYYYY: z.string(),
  });

  const extractedMainTitle = await getStructuredOpenAICompletionWithRetries(
    runId,
    SYSTEM_PROMPT,
    USER_PROMPT,
    MODEL,
    TEMPERATURE,
    SCHEMA,
    RETRIES,
    pngPages.slice(0, 5).map((page) => page.path)
  );

  const extractedTitle = extractedMainTitle?.mainTitle || "NoTitleDetected";
  const extractedYear = extractedMainTitle?.yearYYYY || "";
  const extractedMonth = extractedMainTitle?.monthMM || "";

  let formattedDate = "";
  if (extractedMonth && extractedYear) {
    formattedDate = `${extractedMonth}/${extractedYear}`;
  } else if (extractedYear) {
    formattedDate = extractedYear;
  }

  return { extractedTitle, extractedMonth, extractedYear, formattedDate };
}

/**
 * The improveAuthorInfo function processes and enhances author information extracted from a document.
 *
 * @param {string} runId - A unique identifier for the current processing run.
 * @param {string[]} logBuffer - An array used to log messages throughout the processing.
 * @param {Item[]} allItems - A list of items extracted from the document, which may include author information.
 * @param {PngPageOutput[]} pngPages - An array of PNG page outputs used for processing.
 * @param {string} extractedTitle - The title of the document extracted in a previous step.
 * @param {string} authorInfoContents - Raw text content containing author information to be processed.
 *
 * @returns {Promise<{ authors: { authorName: string; affiliation: string }[] }>} - A promise that resolves to an object containing an array of authors, each with a name and affiliation.
 *
 * This function leverages the OpenAI model to extract and refine author details, ensuring only unique author names and affiliations are included. Missing affiliations are left empty. The function is integral to the document processing workflow, providing structured and accurate author information.
 */
export async function improveAuthorInfo(
  runId: string,
  logBuffer: string[],
  allItems: Item[],
  pngPages: PngPageOutput[],
  extractedTitle: string,
  authorInfoContents: string
): Promise<{ authors: { authorName: string; affiliation: string }[] }> {
  const MODEL: Model = "gpt-4o-2024-08-06";
  const TEMPERATURE = 0.2;
  const RETRIES = 3;
  const USER_PROMPT = `Here is the author info: ${authorInfoContents}`;
  const SYSTEM_PROMPT = `Extract all the author info for ${
    extractedTitle && extractedTitle !== "NoTitleDetected" ? extractedTitle : ""
  }. Keep only the author names and affiliations.
      
      If the affiliation is not available for a user leave it empty. Do not repeat the same author or affiliation multiple times.`;

  const SCHEMA = z.object({
    authors: z.array(
      z.object({
        authorName: z.string(),
        affiliation: z.string(),
      })
    ),
  });

  const improvedAuthorInfo = await getStructuredOpenAICompletionWithRetries(
    runId,
    SYSTEM_PROMPT,
    USER_PROMPT,
    MODEL,
    TEMPERATURE,
    SCHEMA,
    RETRIES,
    pngPages.slice(0, 5).map((page) => page.path)
  );

  return { authors: improvedAuthorInfo?.authors || [] };
}

/**
 * Processes and compiles author information from the given items and improved author info.
 *
 * @param {Item[]} allItems - A list of items extracted from the document, which may include author information.
 * @param {{ authors: { authorName: string; affiliation: string }[] }} improvedAuthorInfo - An object containing an array of authors, each with a name and affiliation.
 *
 * @returns {Promise<string>} - A promise that resolves to a string representing the minified author information.
 *
 * This function identifies the first occurrence of author information in the items, groups authors by their affiliations, and compiles the author information into a formatted string. If there are more than five authors, it summarizes the total number of authors. The function updates the item type to "improved_author_info" and returns a minified version of the author information.
 */
export async function processAuthorInfo(
  allItems: Item[],
  improvedAuthorInfo: { authors: { authorName: string; affiliation: string }[] }
): Promise<string> {
  const firstAuthorInfoIndex = allItems.findIndex(
    (item) => item.type === "author_info"
  );

  let minifiedAuthorInfo;
  let compiledAuthorInfo;

  if (firstAuthorInfoIndex !== -1) {
    const authors = improvedAuthorInfo?.authors || [];
    const totalAuthors = authors.length;
    const maxAuthors = 5;
    const authorGroups: { [affiliation: string]: string[] } = {};

    // Group authors by affiliation
    authors
      .slice(0, maxAuthors)
      .forEach(({ authorName, affiliation }: Author) => {
        if (!authorGroups[affiliation]) {
          authorGroups[affiliation] = [];
        }
        authorGroups[affiliation].push(authorName);
      });

    // Compile the author info into the desired format
    compiledAuthorInfo = Object.entries(authorGroups)
      .map(([affiliation, authorNames]) => {
        return affiliation && affiliation !== ""
          ? `[break0.3]${authorNames.join(", ")} from ${affiliation}`
          : `[break0.3]${authorNames.join(", ")}`;
      })
      .join(", ");

    // Add the total number of authors if more than 5
    if (totalAuthors > maxAuthors) {
      compiledAuthorInfo = `There are ${totalAuthors} authors, including ${compiledAuthorInfo}`;
    }
    allItems[firstAuthorInfoIndex].type = "improved_author_info";
    allItems[firstAuthorInfoIndex].content = compiledAuthorInfo;

    const firstAuthor = authors[0]?.authorName || "Unknown Author";
    minifiedAuthorInfo =
      authors.length > 1 ? `${firstAuthor} et al.` : firstAuthor;
  }

  return minifiedAuthorInfo || "";
}

/**
 * Processes the references and acknowledgements sections in the provided items.
 *
 * @param {Item[]} allItems - An array of items representing different sections of the document.
 * @returns {void} - This function does not return a value. It modifies the items in place.
 *
 * The function performs the following tasks:
 * 1. Normalizes and updates the type of headings related to acknowledgements and references.
 * 2. Identifies and updates the type of stray references headings.
 * 3. Ensures the final references heading is correctly identified.
 * 4. Prepares the document for further processing by ensuring the correct categorization of sections.
 */

export function processReferencesAndAcknowledgements(allItems: Item[]): void {
  //processing to correct some important headings
  for (const item of allItems) {
    if (item.type === "heading") {
      const normalizedContent = removeBreaks(item.content).toLowerCase();
      if (
        normalizedContent.includes("acknowledgment") ||
        normalizedContent.includes("acknowledgments") ||
        normalizedContent.includes("acknowledgements") ||
        normalizedContent.includes("acknowledgement")
      ) {
        item.type = "acknowledgements_heading";
      } else if (
        normalizedContent.includes("reference") ||
        normalizedContent.includes("references")
      ) {
        item.type = "references_heading";
      }
    }
  }

  let lastReferencesHeadingIndex = -1;

  // Find the last references_heading index
  for (let i = allItems.length - 1; i >= 0; i--) {
    if (allItems[i].type === "references_heading") {
      lastReferencesHeadingIndex = i;
      break;
    }
  }

  // Update the type of all but the final references heading
  for (let i = 0; i < allItems.length; i++) {
    if (
      allItems[i].type === "references_heading" &&
      i !== lastReferencesHeadingIndex
    ) {
      allItems[i].type = "stray_references_heading";
    }
  }

  let conclusionInsertionIndex = -1;
  let conclusionInsertionPage = 0;

  // Find the last references_heading or references_item
  for (let i = allItems.length - 1; i >= 0; i--) {
    if (
      allItems[i].type === "references_heading" ||
      allItems[i].type === "references_item"
    ) {
      conclusionInsertionIndex = i;
      conclusionInsertionPage = allItems[i].page;
      break;
    }
  }

  // Insert the message if a suitable insertion point was found
  if (conclusionInsertionIndex !== -1) {
    allItems.splice(conclusionInsertionIndex + 1, 0, {
      type: "end_marker",
      content: "[break0.4]You have reached the end of the paper.[break0.4]",
      page: conclusionInsertionPage,
    });
  }
}

/**
 * Filters out unnecessary item types from the provided list of items.
 *
 * @param {Item[]} allItems - The list of all items to be filtered.
 * @returns {Item[]} - The filtered list of items containing only necessary types.
 *
 * This function processes the provided list of items and filters out unnecessary types.
 * It ensures that the abstract section is included if it exists, and skips items in the
 * acknowledgements and references sections. The function also handles the detection of
 * main titles, improved author information, and end markers.
 */

export function filterUnnecessaryItemTypes(allItems: Item[]): Item[] {
  const abstractExists = allItems.some(
    (item) =>
      item.type === "abstract_heading" ||
      item.type === "abstract_content" ||
      item.content.toLocaleLowerCase() === "abstract"
  );
  let abstractDetected = false;
  let inAcknowledgementsSection = false;
  let inReferencesSection = false;
  let mainTitleDetected = false;
  const filteredItems = abstractExists
    ? allItems.filter((item: Item, index: number, array: any[]) => {
        if (!abstractDetected) {
          if (
            item.type === "abstract_heading" ||
            item.content.toLocaleLowerCase() === "abstract"
          ) {
            abstractDetected = true;
            item.type = "abstract_heading";
          } else if (item.type === "abstract_content") {
            abstractDetected = true;
          }
          return [
            "main_title",
            "improved_author_info",
            "abstract_heading",
            "abstract_content",
          ].includes(item.type);
        } else {
          if (item.type === "end_marker") {
            return true;
          }
          // Check for acknowledgements section
          if (item.type === "acknowledgements_heading") {
            inAcknowledgementsSection = true;
          } else if (item.type.includes("heading")) {
            inAcknowledgementsSection = false;
          }

          // Check for references section
          if (item.type === "references_heading") {
            inReferencesSection = true;
          } else if (item.type.includes("heading")) {
            inReferencesSection = false;
          }

          if (inAcknowledgementsSection || inReferencesSection) {
            return false; // Skip items in the acknowledgements section
          }
          // Check for math items between endnotes
          if (item.type === "math" && index > 0 && index < array.length - 1) {
            const prevItem = array[index - 1];
            const nextItem = array[index + 1];
            if (
              prevItem.type === "endnotes_item" &&
              nextItem.type === "endnotes_item"
            ) {
              return false; // Remove this math item
            }
          }

          if (
            !removeBreaks(item.content).trim() ||
            removeBreaks(item.content).trim() === ""
          ) {
            return false;
          }

          return [
            "text",
            "heading",
            "figure_image",
            "table_rows",
            "math",
            "abstract_content",
            "code_or_algorithm",
            "end_marker",
          ].includes(item.type);
        }
      })
    : allItems.filter((item: Item, index: number, array: any[]) => {
        if (item.type === "end_marker") {
          return true;
        }

        // Check for acknowledgements section
        if (item.type === "acknowledgements_heading") {
          inAcknowledgementsSection = true;
        } else if (item.type.includes("heading")) {
          inAcknowledgementsSection = false;
        }

        // Check for references section
        if (item.type === "references_heading") {
          inReferencesSection = true;
        } else if (item.type.includes("heading")) {
          inReferencesSection = false;
        }

        if (inAcknowledgementsSection || inReferencesSection) {
          return false; // Skip items in the acknowledgements or references section
        }
        // Check for math items between endnotes
        if (item.type === "math" && index > 0 && index < array.length - 1) {
          const prevItem = array[index - 1];
          const nextItem = array[index + 1];
          if (
            prevItem.type === "endnotes_item" &&
            nextItem.type === "endnotes_item"
          ) {
            return false; // Remove this math item
          }
        }

        if (
          !removeBreaks(item.content).trim() ||
          removeBreaks(item.content).trim() === ""
        ) {
          return false;
        }

        if (item.type === "main_title") {
          if (mainTitleDetected) {
            return false; // Skip subsequent main_title items
          }
          mainTitleDetected = true;
        }

        return [
          "main_title",
          "improved_author_info",
          "text",
          "heading",
          "figure_image",
          "table_rows",
          "math",
          "abstract_content",
          "abstract_heading",
          "code_or_algorithm",
          "end_marker",
        ].includes(item.type);
      });

  const endMarkerIndex = filteredItems.findIndex(
    (item) => item.type === "end_marker"
  );

  if (endMarkerIndex !== -1 && endMarkerIndex < filteredItems.length - 1) {
    filteredItems[endMarkerIndex].content =
      "[break0.4]You have reached the end of the main paper. Appendix sections follow.[break0.4]";
  }

  return filteredItems;
}

/**
 * Analyzes the provided items to detect the presence of citations to other papers.
 *
 * @param {string} runId - The unique identifier for the current run.
 * @param {string[]} logBuffer - An array to store log messages.
 * @param {Item[]} filteredItems - The array of items to be analyzed for citations.
 * @returns {Promise<void>} - A promise that resolves when the citation detection is complete.
 */

export async function detectCitations(
  runId: string,
  logBuffer: string[],
  filteredItems: Item[]
): Promise<void> {
  const MODEL: Model = "gpt-4o-2024-08-06";
  const TEMPERATURE = 0.1;
  const CONCURRENCY = 20;
  const RETRIES = 3;
  const MAX_TOKENS = 256;
  const FREQUENCY_PENALTY = 0.1;
  const SYSTEM_PROMPT = `Analyze the following text and determine if the text contains citations to other papers. Ignore citations to figures or images in this paper`;

  const SCHEMA = z.object({
    hasCitations: z.boolean(),
  });

  for (let i = 0; i < filteredItems.length; i += CONCURRENCY) {
    const itemBatch = filteredItems.slice(i, i + CONCURRENCY);

    await Promise.all(
      itemBatch.map(async (item) => {
        try {
          const result = await getStructuredOpenAICompletionWithRetries(
            runId,
            SYSTEM_PROMPT,
            `Text to analyze:\n${item.content}`,
            MODEL,
            TEMPERATURE,
            SCHEMA,
            RETRIES,
            [],
            MAX_TOKENS,
            FREQUENCY_PENALTY
          );

          item.hasCitations = result?.hasCitations || false;
        } catch (error) {
          console.error("Non fatal error while detecting citations:", error);
          logBuffer.push(`Non fatal error while detecting citations: ${error}`);
          item.hasCitations = false; // Default to false if there's an error
        }
      })
    );
  }
}

/**
 * Optimizes citations in the provided filtered items by removing citation elements from the text.
 *
 * @param {string} runId - The unique identifier for the current run.
 * @param {string[]} logBuffer - An array to store log messages.
 * @param {Item[]} filteredItems - An array of items that have been filtered for processing.
 * @returns {Promise<void>} - A promise that resolves when the citation optimization is complete.
 */
export async function optimizeCitations(
  runId: string,
  logBuffer: string[],
  filteredItems: Item[]
): Promise<void> {
  const itemsWithCitations = filteredItems.filter((item) => item.hasCitations);

  if (itemsWithCitations.length > 0) {
    const MODEL: Model = "gpt-4o-2024-08-06";
    const TEMPERATURE = 0.2;
    const CONCURRENCY = 20;
    const RETRIES = 3;
    const MAX_TOKENS = 16384;
    const FREQUENCY_PENALTY = 0.1;
    const SYSTEM_PROMPT = `Remove citations elements from the user text.
      
    Examples of citation elements:
    - [10, 38, ....]
    - (Author et al., YYYY; Author et al., YYYY;......)
    - ^number
    - (Author, year, page number) or Author (year, page number)
    - (10, 28,...)
    - Author (page number)

    Do not remove entire sentences just remove the citation element. If the citation is part of a phrase like "such as <citation element>" then remove the phrase from the sentence. However if the citation is part of a phrase like "such as <Noun> <citation element>" then keep the phrase "such as <Noun>" and only remove the citation element.
    
    However if the citation is like "Author <citation element> suggests that..." then only remove the citation element do not remove the author name.

    Do not remove citations to tables and figures in the paper.
    
    Return the original text and the text with citations removed.`;

    const SCHEMA = z.object({
      originalText: z.string(),
      textWithCitationsRemoved: z.string(),
    });

    for (let i = 0; i < itemsWithCitations.length; i += CONCURRENCY) {
      const itemBatch = itemsWithCitations.slice(i, i + CONCURRENCY);
      console.log(`processing text items ${i} through ${i + CONCURRENCY}`);

      logBuffer.push(`processing text items ${i} through ${i + CONCURRENCY}`);

      await Promise.all(
        itemBatch.map(async (item) => {
          try {
            if (item.type === "text") {
              const processedItem =
                await getStructuredOpenAICompletionWithRetries(
                  runId,
                  SYSTEM_PROMPT,
                  `User text:\n${item.content}`,
                  MODEL,
                  TEMPERATURE,
                  SCHEMA,
                  RETRIES,
                  [],
                  MAX_TOKENS,
                  FREQUENCY_PENALTY
                );

              const originalCharCount = item.content.length;
              const optimizedCharCount =
                processedItem?.textWithCitationsRemoved.length || 0;

              const allowedCharCountUpper = originalCharCount * 1.1;
              const allowedCharCountLower = originalCharCount * 0.7;

              if (
                optimizedCharCount <= allowedCharCountUpper &&
                optimizedCharCount >= allowedCharCountLower
              ) {
                item.citationReplacement = {
                  originalText: processedItem?.originalText || "",
                  textWithCitationsRemoved:
                    processedItem?.textWithCitationsRemoved || "",
                };
                item.content =
                  item.citationReplacement.textWithCitationsRemoved;
                item.replacedCitations = true;
              } else {
                item.citationReplacement = {
                  originalText: processedItem?.originalText || "",
                  textWithCitationsRemoved:
                    processedItem?.textWithCitationsRemoved || "",
                };
                item.replacedCitations = false;
                console.log(
                  `Reverting to original text for item due to character count difference: ${optimizedCharCount} not in range [${allowedCharCountLower}, ${allowedCharCountUpper}]`
                );
                logBuffer.push(
                  `Reverting to original text for item due to character count difference: ${optimizedCharCount} not in range [${allowedCharCountLower}, ${allowedCharCountUpper}]`
                );
              }
            }
          } catch (error) {
            console.log(`Non fatal error while processing citations: ${error}`);
            logBuffer.push(
              `Non fatal error while processing citations: ${error}`
            );
          }
        })
      );
    }
  }
}

/**
 * Detects the frequency of complex math symbols and numbers in the provided filtered items.
 *
 * @param {string} runId - The unique identifier for the current run.
 * @param {string[]} logBuffer - An array to store log messages.
 * @param {Item[]} filteredItems - An array of items that have been filtered for processing.
 * @returns {Promise<void>} - A promise that resolves when the math symbol frequency detection is complete.
 */

export async function detectMathSymbolFrequency(
  runId: string,
  logBuffer: string[],
  filteredItems: Item[]
): Promise<void> {
  const MODEL: Model = "gpt-4o-2024-08-06";
  const TEMPERATURE = 0.1;
  const CONCURRENCY = 20;
  const RETRIES = 3;
  const MAX_TOKENS = 256;
  const FREQUENCY_PENALTY = 0.1;
  const SYSTEM_PROMPT = `Analyze the following text and determine the frequency of complex math symbols and numbers. Provide a score between 0 and 5, where 0 means no complex math symbols and numbers and 5 means a high frequency of complex math symbols and numbers.`;

  const mathSymbolFrequencySchema = z.object({
    mathSymbolFrequency: z.number(),
  });

  for (let i = 0; i < filteredItems.length; i += CONCURRENCY) {
    const itemBatch = filteredItems.slice(i, i + CONCURRENCY);

    await Promise.all(
      itemBatch.map(async (item) => {
        if (item.type === "math") {
          item.mathSymbolFrequency = 5;
        } else {
          try {
            const result = await getStructuredOpenAICompletionWithRetries(
              runId,
              SYSTEM_PROMPT,
              `Text to analyze:\n${item.content}`,
              MODEL,
              TEMPERATURE,
              mathSymbolFrequencySchema,
              RETRIES,
              [],
              MAX_TOKENS,
              FREQUENCY_PENALTY
            );

            item.mathSymbolFrequency = result?.mathSymbolFrequency || 0;
          } catch (error) {
            console.error(
              "Non fatal error while assigning math symbol frequency:",
              error
            );
            logBuffer.push(
              `Non fatal error while assigning math symbol frequency: ${error}`
            );
            item.mathSymbolFrequency = 0; // Default to 0 if there's an error
          }
        }
      })
    );
  }
}

/**
 * Optimizes items that can include math by replacing math notation with plain English words.
 *
 * @param {string} runId - The unique identifier for the current run.
 * @param {string[]} logBuffer - An array to store log messages.
 * @param {Item[]} filteredItems - An array of items that have been filtered for processing.
 * @returns {Promise<void>} - A promise that resolves when the math optimization is complete.
 */
export async function optimizeItemsWithMath(
  runId: string,
  logBuffer: string[],
  filteredItems: Item[]
): Promise<void> {
  const itemsThatCanIncludeMath = filteredItems.filter(
    (item) => item.mathSymbolFrequency && item.mathSymbolFrequency > 0
  );

  if (itemsThatCanIncludeMath.length > 0) {
    const MODEL: Model = "gpt-4o-2024-08-06";
    const TEMPERATURE = 0.3;
    const CONCURRENCY = 20;
    const RETRIES = 3;
    const MAX_TOKENS = 16384;
    const FREQUENCY_PENALTY = 0.2;
    const SYSTEM_PROMPT = `The following text will be converted to audio for the user to listen to. Replace math notation and all LaTeX formatting with plain english words to make it more suitable for that purpose. Convert accurately. 
        
    Some examples includes changing "+" to "plus" and inserting a "times" when multiplication is implied. Use your best judgment to make the text as pleasant for audio as possible.
    
    Only convert math notation, do not alter the rest of the text. Return the entire original text and the worded replacement.`;

    const SCHEMA = z.object({
      originalText: z.string(),
      wordedReplacement: z.string(),
    });

    for (let i = 0; i < itemsThatCanIncludeMath.length; i += CONCURRENCY) {
      const itemBatch = itemsThatCanIncludeMath.slice(i, i + CONCURRENCY);
      console.log(`processing math items ${i} through ${i + CONCURRENCY}`);
      logBuffer.push(`processing math items ${i} through ${i + CONCURRENCY}`);

      await Promise.all(
        itemBatch.map(async (item) => {
          try {
            if (item.type === "math" || item.type === "text") {
              const processedItem =
                await getStructuredOpenAICompletionWithRetries(
                  runId,
                  SYSTEM_PROMPT,
                  `Text to optimize:\n${item.content}`,
                  MODEL,
                  TEMPERATURE,
                  SCHEMA,
                  RETRIES,
                  [],
                  MAX_TOKENS,
                  FREQUENCY_PENALTY
                );

              const originalCharCount = item.content.length;
              const optimizedCharCount =
                processedItem?.wordedReplacement.length || 0;

              // Determine the allowed character count based on math symbol frequency
              const frequencyMultiplier =
                {
                  5: 10,
                  4: 4,
                  3: 3,
                  2: 2,
                  1: 1.4,
                }[item.mathSymbolFrequency || 1] || 1.4;

              const allowedCharCountUpper =
                originalCharCount * frequencyMultiplier;
              const allowedCharCountLower = originalCharCount * 0.9;

              if (
                optimizedCharCount <= allowedCharCountUpper &&
                optimizedCharCount >= allowedCharCountLower
              ) {
                item.mathReplacement = {
                  originalText: processedItem?.originalText || "",
                  wordedReplacement: processedItem?.wordedReplacement || "",
                };
                item.content = item.mathReplacement.wordedReplacement;
                item.optimizedMath = true;
              } else {
                item.mathReplacement = {
                  originalText: processedItem?.originalText || "",
                  wordedReplacement: processedItem?.wordedReplacement || "",
                };
                item.optimizedMath = false;
                console.log(
                  `Reverting to original text for item due to character count difference: ${optimizedCharCount} not in range [${allowedCharCountLower}, ${allowedCharCountUpper}]`
                );
                logBuffer.push(
                  `Reverting to original text for item due to character count difference: ${optimizedCharCount} not in range [${allowedCharCountLower}, ${allowedCharCountUpper}]`
                );
              }
            }
          } catch (error) {
            console.log(`Non fatal error while processing math: ${error}`);
            logBuffer.push(`Non fatal error while processing math: ${error}`);
          }
        })
      );
    }
  }
}

/**
 * Replaces known abbreviations in the content of filtered items with their respective replacements.
 *
 * @param {Item[]} filteredItems - An array of items whose content may contain known abbreviations.
 * @returns {void} - This function does not return a value.
 */

export function replaceKnownAbbreviations(filteredItems: Item[]): void {
  const specialAbbreviations: Abbreviation[] = [
    {
      abbreviation: "CI",
      replacement: "C.I.",
      type: "initialism",
      expansion: "confidence interval",
    },
    {
      abbreviation: "ROC",
      replacement: "R.O.C.",
      type: "initialism",
      expansion: "receiver operating curve",
    },
  ];

  filteredItems.forEach((item) => {
    specialAbbreviations.forEach(({ abbreviation, replacement }) => {
      const regex = new RegExp(`\\b${abbreviation}\\b`, "g");
      item.content = item.content.replace(regex, replacement);
    });
  });
}

/**
 * Tags items with cut-offs based on their content.
 * This function checks if the content of each item starts with an uppercase letter and ends with a punctuation mark.
 * If not, it tags the item as having a start or end cut-off.
 *
 * @param {Item[]} filteredItems - An array of items to be tagged with cut-offs.
 * @returns {void} - This function does not return a value.
 */

export function tagItemsWithCutOffs(filteredItems: Item[]): void {
  filteredItems.forEach((item) => {
    if (["abstract_content", "text"].includes(item.type)) {
      item.isStartCutOff = !/^[A-Z]/.test(item.content.trim());
      item.isEndCutOff = !/(?<!\.)[.!?)\]]$/.test(item.content.trim());
    }
  });
}

/**
 * Repositions special items (figures, tables, and code/algorithms) within the filtered items array.
 * This function identifies the appropriate location for each special item based on its label and content.
 * It searches for mentions of the item's label within the text and repositions the item accordingly.
 * The function also logs the repositioning process for debugging and tracking purposes.
 *
 * @param {string[]} logBuffer - An array to store log messages for tracking the repositioning process.
 * @param {Item[]} filteredItems - An array of items that includes both text and special items to be repositioned.
 * @returns {void} - This function does not return a value.
 */

export function repositionSpecialItems(
  logBuffer: string[],
  filteredItems: Item[]
): void {
  const specialItems = filteredItems.filter(
    (item) =>
      item.type === "figure_image" ||
      item.type === "table_rows" ||
      item.type === "code_or_algorithm"
  );
  for (const item of specialItems) {
    if (item.repositioned || !item.label) {
      continue;
    }

    const { labelType, labelNumber } = item.label;
    console.log("repositioning ", labelType, " ", labelNumber);
    logBuffer.push(`repositioning ${labelType} ${labelNumber}`);
    let mentionIndex = -1;
    let headingIndex = -1;
    let textWithoutEndCutoffIndex = -1;

    if (labelNumber !== "unlabeled") {
      console.log("searching for matches for", labelType, labelNumber);
      logBuffer.push(`searching for matches for ${labelType} ${labelNumber}`);
      let matchWords = [];
      if (labelType.toLocaleLowerCase() === "figure") {
        matchWords.push(
          `Figure ${labelNumber}`,
          `Fig. ${labelNumber}`,
          `Fig ${labelNumber}`,
          `FIGURE ${labelNumber}`,
          `FIG ${labelNumber}`,
          `FIG. ${labelNumber}`
        );
      } else if (labelType.toLocaleLowerCase() === "chart") {
        matchWords.push(
          `Chart ${labelNumber}`,
          `chart ${labelNumber}`,
          `CHART ${labelNumber}`
        );
      } else if (labelType.toLocaleLowerCase() === "image") {
        matchWords.push(
          `Image ${labelNumber}`,
          `image ${labelNumber}`,
          `Img ${labelNumber}`,
          `Img. ${labelNumber}`,
          `IMAGE ${labelNumber}`,
          `IMG ${labelNumber}`,
          `IMG. ${labelNumber}`
        );
      } else if (labelType.toLocaleLowerCase() === "table") {
        matchWords.push(`Table ${labelNumber}`, `Table. ${labelNumber}`);
      } else if (labelType.toLocaleLowerCase() === "algorithm") {
        matchWords.push(
          `Algorithm ${labelNumber}`,
          `Algo ${labelNumber}`,
          `Algo. ${labelNumber}`,
          `Alg. ${labelNumber}`,
          `ALGORITHM ${labelNumber}`
        );
      } else {
        matchWords.push(`${labelType} ${labelNumber}`);
      }

      for (let i = 0; i < filteredItems.length; i++) {
        if (
          i !== filteredItems.indexOf(item) &&
          matchWords.some((word) => filteredItems[i].content.includes(word))
        ) {
          mentionIndex = i;
          // console.log(
          //   "found first mention in ",
          //   JSON.stringify(filteredItems[i])
          // );
          break;
        }
      }
    }

    const startIndex =
      mentionIndex !== -1 ? mentionIndex : filteredItems.indexOf(item) + 1;

    for (let i = startIndex; i < filteredItems.length; i++) {
      if (filteredItems[i].type.includes("heading")) {
        headingIndex = i;
        // console.log(
        //   "found the first heading below mention in",
        //   JSON.stringify(filteredItems[i])
        // );
        break;
      }
      if (filteredItems[i].type === "text" && !filteredItems[i].isEndCutOff) {
        textWithoutEndCutoffIndex = i;
        // console.log(
        //   "found the first text without end cutoff below mention in",
        //   JSON.stringify(filteredItems[i])
        // );
        break;
      }
    }

    console.log(
      "moving the item based on end cutoff logic or above the first heading or to the end"
    );
    logBuffer.push(
      "moving the item based on end cutoff logic or above the first heading or to the end"
    );
    const currentIndex = filteredItems.indexOf(item);
    let insertIndex;

    if (textWithoutEndCutoffIndex !== -1) {
      insertIndex =
        textWithoutEndCutoffIndex +
        (currentIndex < textWithoutEndCutoffIndex ? 0 : 1);
    } else if (headingIndex !== -1) {
      insertIndex = headingIndex + (currentIndex < headingIndex ? -1 : 0);
    } else {
      insertIndex = filteredItems.length; // Default to end if no suitable position is found
    }

    const [movedItem] = filteredItems.splice(currentIndex, 1);

    while (
      insertIndex < filteredItems.length &&
      filteredItems[insertIndex].type === movedItem.type
    ) {
      insertIndex += 1; // Move below the item
    }

    if (insertIndex !== -1) {
      filteredItems.splice(insertIndex, 0, movedItem);
    } else {
      filteredItems.push(movedItem);
    }

    item.repositioned = true;
  }
}

/**
 * Adds SSML (Speech Synthesis Markup Language) breaks to the content of specific item types in the filteredItems array.
 * This function appends a break tag "[break0.4]" to the content of items that are of type "text", "figure_image", "code_or_algorithm", "table_rows", or "abstract_content" and are not marked as end cut off.
 *
 * @param {Item[]} filteredItems - The array of items to which SSML breaks will be added.
 * @returns {void} - This function does not return a value.
 */

export function addSSMLBreaks(filteredItems: Item[]): void {
  filteredItems.forEach((item) => {
    if (
      [
        "text",
        "figure_image",
        "code_or_algorithm",
        "table_rows",
        "abstract_content",
      ].includes(item.type) &&
      !item.isEndCutOff
    ) {
      item.content += "[break0.4]";
    }
  });
}

/**
 * Summarizes the content of a group of items using an OpenAI model.
 * This function combines the content of the filtered items, generates a summary using the OpenAI model, and returns the summary.
 *
 * @param {string} runId - The unique identifier for the current run.
 * @param {string[]} logBuffer - The buffer to store log messages.
 * @param {Item[]} filteredItems - The array of items to be summarized.
 * @returns {Promise<{ summary: string }>} - A promise that resolves to an object containing the generated summary.
 */
export async function summarizeItemGroup(
  runId: string,
  logBuffer: string[],
  filteredItems: Item[]
): Promise<{ summary: string }> {
  let combinedContent = filteredItems.map((item) => item.content).join("\n\n");
  let tokenCount = Math.ceil(combinedContent.length / 4);
  if (tokenCount > 120000) {
    combinedContent = combinedContent.slice(0, 120000 * 4);
  }

  const summaryJson = { summary: "" };

  const MODEL = "gpt-4o-2024-08-06";
  const TEMPERATURE = 0.3;
  const RETRIES = 3;
  const MAX_TOKENS = 1024;
  const USER_PROMPT = combinedContent;
  const SYSTEM_PROMPT = `Please provide an effective summary of the following paper. Make sure to capture the main idea of the paper. Do not add any mathematical expressions or equations, only use plain text in the summary.`;

  const SCHEMA = z.object({
    summary: z.string(),
  });

  try {
    const summaryResult = await getStructuredOpenAICompletionWithRetries(
      runId,
      SYSTEM_PROMPT,
      USER_PROMPT,
      MODEL,
      TEMPERATURE,
      SCHEMA,
      RETRIES,
      [],
      MAX_TOKENS
    );

    summaryJson.summary =
      summaryResult?.summary || "Summary could not be generated.";
    console.log("Generated summary");
    logBuffer.push("Generated summary");
  } catch (error) {
    console.error("Error generating summary:", error);
    logBuffer.push(`Error generating summary: ${error}`);
  }

  return summaryJson;
}

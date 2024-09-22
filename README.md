# TTS Summarizer

## Requirements

- Node.js version 20 or higher

## Getting Started

- Install Node.js 20 or higher. On Linux/MacOS use `nvm`. On Windows, simply download it from the Node.js website.
- From the root folder run `yarn`
- From the `client` folder run `yarn`.
- To start the server in dev mode with HMR, from the root folder run `yarn dev`
- Go to `http://localhost:4242`
- Upload a `pdf` or `epub` file.

## Folder Structure

- Place API route handlers in the `src/handlers` directory, each handler in its own file.
- AWS client interfaces are located in the `src/aws` directory.

## Dependencies

We are using

- `fastify` as our primary Node framework.
- `AWS S3`
  - to store the user uploaded files.
  - to store the AI generated audio files.
  - to store the user interaction memory.
- `AWS Polly` to convert generated text to audio.
- `Anthropic` models to generate the summries.
- `LlamaParse` to parse complex file types like `pdf` and `epub`
- `FireCrawl` to scrape web context about the file.

## Summarization Modes

- `Contextual Abstract`: Generates a better and context aware abstract or blurb for the content
- `Two-page`: Generates a standard two page summary of the content
- `Chaptered`: Generates a chaptered summary of the content. Includes options to use existing chapters if any or generate new ones. Also can control if each chapter should be generated seperately, often leading to more detail.
- `Tables, Figures & Expressions Only`: Generates a copy of the original content with only the tables, figures and mathematical expressions summarized and the summaries integrated into the original text at the optimal locations. Other features include:
  - Skip over citations
  - Skip over tables, figures & expressions
- `Ultimate`: `Contextual Abstract` + `Tables, Figures & Equations Only`

## Bug in dependency

The `node_modules/llamaindex/cloud/dist/reader.js` file has a bug in it that causes the `fetchAndSaveImage` function to fail. The bug is that the `response.data` is not a buffer, it's a stream. We are using a local patch to fix the issue. Here is the correct version of the function:

```javascript
async fetchAndSaveImage(imageName, imagePath, jobId) {
        const response = await ParsingService.getJobImageResultApiV1ParsingJobJobIdResultImageNameGet({
            client: this.#client,
            path: {
                job_id: jobId,
                name: imageName
            }
        });
        if (response.error) {
            throw new Error(`Failed to download image: ${response.error.detail}`);
        }
        const arrayBuffer = await response.data.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        // Write the image buffer to the specified imagePath
        await fs.writeFile(imagePath, buffer);
    }
```

# API Specification

## 1. Summarize Endpoint

### URL

`POST /summarize`

### Description

Processes a document for summarization and returns a run ID and received time.

### Request Parameters

- **Querystring**:
  - `email` (string): The user's email address.
  - `summarizationMethod` (string): The method of summarization to use.
  - `fileName` (string): The name of the file being summarized.
  - `sendEmailToUser` (string): Whether to send an email to the user ("true" or "false").
  - `link` (string, optional): A link to the document to be summarized.

### Request body:

PDF File buffer if not passing in a link. You need to add `Content-Type: application/pdf` header. Note that if both a link and file is sent, the file will be prioritized.

### Response

- **Status**: 200 OK
- **Body**:
  ```json
  {
    "runId": "string",
    "receivedTime": "string"
  }
  ```

## 2. Check Status Endpoint

### URL

`GET /checkStatus`

### Description

Checks the status of a summarization process using a run ID.

### Request Parameters

- **Querystring**:
  - `runId` (string): The unique identifier for the summarization process.

### Response Examples

- **Status**: 200 OK
- **Body** (Received):

  ```json
  {
    "status": "Received",
    "message": "Request received",
    "receivedTime": "string"
  }
  ```

- **Body** (Processing):

  ```json
  {
    "status": "Processing",
    "message": "Started processing",
    "receivedTime": "string",
    "startedProcessingTime": "string"
  }
  ```

- **Body** (Completed):

  ```json
  {
    "status": "Completed",
    "message": "Generated audio output and metadata",
    "receivedTime": "string",
    "startedProcessingTime": "string",
    "completedTime": "string",
    "uploadedFileUrl": "string",
    "audioFileUrl": "string",
    "metadataFileUrl": "string",
    "extractedTitle": "string"
  }
  ```

- **Body** (Error):

  ```json
  {
    "status": "Error",
    "errorType": "string",
    "message": "string",
    "receivedTime": "string",
    "errorTime": "string"
  }
  ```

- **Error Types**:

  - `FileSizeExceeded`: The file size exceeds the supported limit.
  - `FileNumberOfPagesExceeded`: The PDF has more pages than supported.
  - `InvalidPDF`: The file is not a valid PDF.
  - `CorruptedFile`: The file is corrupted.
  - `MissingFile`: No file was provided.
  - `CoreSystemFailure`: A general system failure occurred.
  - `InvalidLink`: Failed to download PDF from the provided link.
  - `SummarizationMethodNotSupported`: The requested summarization method is not supported.

## 3. Mock Summarize Endpoint

### URL

`POST /mockSummarize`

### Description

Simulates a summarization process and returns a run ID and received time.

### Request Parameters

- **Querystring**:
  Same as `/summarize`

### Request Body

Same as `/summarize` although it does not really make a difference.

### Response

- **Status**: 200 OK
- **Body**:
  ```json
  {
    "runId": "string",
    "receivedTime": "string"
  }
  ```

## 4. Get Papers Endpoint

### URL

`GET /getpapers`

### Description

Retrieves a list of papers associated with a user's email.

### Request Parameters

- **Querystring**:
  - `email` (string): The user's email address.

### Response

- **Status**: 200 OK
- **Body**:

  ```json
  {
    "status": "Success",
    "papers": {}
  }
  ```

- **Status**: 404 Not Found
- **Body**:
  ```json
  {
    "status": "Error",
    "errorType": "NotFound",
    "message": "No papers found for the given email."
  }
  ```

## 5. Sync Papers Endpoint

### URL

`POST /syncPapers`

### Description

Synchronizes a list of papers for a user.

### Request Parameters

- **Querystring**:

  - `email` (string): The user's email address.

- **Body**: JSON array of paper objects.

### Response

- **Status**: 200 OK
- **Body**:

  ```json
  {
    "status": "Success",
    "message": "Papers synchronized successfully."
  }
  ```

- **Status**: 400 Bad Request
- **Body**:

  ```json
  {
    "status": "Error",
    "errorType": "InvalidInput",
    "message": "Email is required."
  }
  ```

- **Status**: 500 Internal Server Error
- **Body**:
  ```json
  {
    "status": "Error",
    "errorType": "ProcessingError",
    "message": "An error occurred while syncing the papers."
  }
  ```

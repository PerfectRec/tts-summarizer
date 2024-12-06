interface SummarizeRequestParams {
  summarizationMethod: "short" | "ultimate";
  email?: string;
  fileName: string;
  sendEmailToUser: string;
  link: string;
  error?: string;
  id?: string;
}

type Model =
  | "claude-3-5-sonnet-20240620"
  | "gpt-4o-2024-08-06"
  | "gpt-4o-2024-11-20"
  | "gpt-4o-mini-2024-07-18"
  | "claude-3-haiku-20240307";

interface ModelConfig {
  [task: string]: { temperature: number; model: Model; concurrency: number };
}

interface Author {
  authorName: string;
  affiliation: string;
}

type AbbreviationSubTypes = "initialism" | "acronym" | "partial_initialism";

interface Abbreviation {
  abbreviation: string;
  expansion: string;
  replacement: string;
  type: AbbreviationSubTypes;
}

interface MathReplacement {
  originalText: string;
  wordedReplacement: string;
}

interface CitationReplacement {
  originalText: string;
  textWithCitationsRemoved: string;
}

interface HyphenationReplacement {
  originalText: string;
  textWithHyphensRemoved: string;
}

/*
This is in progress - not for use yet.
*/
type ItemType =
  | "main_title"
  | "author_info"
  | "improved_author_info"
  | "text"
  | "heading"
  | "figure_image"
  | "table_rows"
  | "math"
  | "abstract_content"
  | "abstract_heading"
  | "code_or_algorithm"
  | "end_marker"
  | "acknowledgements_heading"
  | "references_heading"
  | "references_item"
  | "stray_references_heading"
  | "endnotes_item"
  | "endnotes_heading"
  | "JEL_classification"
  | "keywords"
  | "acknowledgements_content"
  | "references_format_information"
  | "footnotes"
  | "meta_info"
  | "publisher info"
  | "non_figure_image"
  | "figure_heading"
  | "figure_caption"
  | "figure_note"
  | "table_descrption"
  | "table_heading"
  | "table_notes"
  | "author_info"
  | "page_number"
  | "table_of_contents_heading"
  | "table_of_contents_item";

interface Item {
  type: string;
  page: number;
  content: string;
  pageSpan?: number[];
  order?: number;
  /*These are all optional metadata*/
  title?: string;
  label?: { labelType: string; labelNumber: string; panelNumber: string };
  labelString?: string;
  summary?: string;
  mathReplacement?: MathReplacement;
  optimizedMath?: boolean;
  replacedCitations?: Boolean;
  repositioned?: Boolean;
  mathSymbolFrequency?: number;
  hasCitations?: boolean;
  hasHyphenatedWords?: boolean;
  citationReplacement?: CitationReplacement;
  hyphenationReplacement?: HyphenationReplacement;
  isStartCutOff?: boolean;
  isEndCutOff?: boolean;
  allAbbreviations?: Abbreviation[];
  audioIssues?: string[];
  notes?: string;
  caption?: string;
  heading?: string;
  description?: string;
  isIllegible?: string;
}

type UnstructuredItemType =
  | "Title"
  | "NarrativeText"
  | "UncategorizedText"
  | "CodeSnippet"
  | "Image"
  | "Table"
  | "PageNumber"
  | "Formula"
  | "Address"
  | "EmailAddress"
  | "Header"
  | "ListItem"
  | "PageBreak"
  | "FigureCaption";

interface UnstructuredItem {
  type: UnstructuredItemType;
  element_id: string;
  text: string;
  new_type?: string;
  item_order?: number;
  metadata: {
    filetype?: string;
    languages?: string[];
    page_number: number;
    filename?: string;
    image_base64?: string;
    image_mime_type?: string;
    text_as_html?: string;
    links?: {
      text: string;
      url: string;
      start_index: number;
    }[];
    parent_id?: string;
  };
}

interface ItemAudioMetadata {
  type: string;
  startTime: number;
  itemDuration: number;
  transcript: string;
  page: number;
  index: number;
  audioIssues: string[];
}

interface ItemAudioResult {
  itemAudioBuffer: Buffer;
  itemAudioMetadata: ItemAudioMetadata;
}

interface AudioResult {
  audioBuffer: Buffer;
  audioMetadata: ItemAudioMetadata[];
  audioDuration: number;
  tocAudioMetadata: ItemAudioMetadata[];
}

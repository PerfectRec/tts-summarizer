import { useState } from "react";
import "./App.css";

function App() {
  const [file, setFile] = useState<File | null>(null);
  const [summarizationMethod, setSummarizationMethod] =
    useState<string>("betterAbstract");

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      setFile(event.target.files[0]);
    }
  };

  const handleMethodChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setSummarizationMethod(event.target.value);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file) return;

    const fileBuffer = await file.arrayBuffer();

    try {
      const response = await fetch(
        `/summarize?summarizationMethod=${summarizationMethod}`,
        {
          method: "POST",
          headers: {
            "Content-Type": file.type,
          },
          body: fileBuffer,
        }
      );
      const result = await response.json();
      console.log(result);
    } catch (error) {
      console.error("Error:", error);
    }
  };

  return (
    <>
      <form onSubmit={handleSubmit} className="flex flex-row gap-4">
        <input
          type="file"
          accept=".pdf,.epub"
          onChange={handleFileChange}
          className="p-2 border rounded"
        />
        <select
          value={summarizationMethod}
          onChange={handleMethodChange}
          className="p-2 border rounded"
        >
          <option value="betterAbstract">Better Abstract</option>
          <option value="twoPage">Two-page Summary</option>
          <option value="chaptered">Chaptered Summary</option>
          <option value="tablesAndFiguresOnly">Tables and Figures Only</option>
          <option value="ultimate">Ultimate</option>
        </select>
        <button type="submit" className="p-2 bg-blue-500 text-white rounded">
          Upload and Summarize
        </button>
      </form>
    </>
  );
}

export default App;

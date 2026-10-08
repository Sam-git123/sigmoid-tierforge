import { useRef, useState, type DragEvent } from 'react';
import { requiredCsvColumns, validateCsvFile } from '../utils/csv';

interface FileUploadProps {
  isUploading: boolean;
  serverError?: string | undefined;
  onUpload(file: File): Promise<void>;
}

export function FileUpload({ isUploading, serverError, onUpload }: FileUploadProps) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);

  async function choose(nextFile: File | null) {
    setFile(nextFile);
    setErrors(nextFile ? await validateCsvFile(nextFile) : []);
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void choose(event.dataTransfer.files[0] ?? null);
  }

  async function submit() {
    if (!file) {
      setErrors(['Choose a CSV file before uploading.']);
      return;
    }
    const currentErrors = await validateCsvFile(file);
    setErrors(currentErrors);
    if (!currentErrors.length) await onUpload(file);
  }

  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8"
      aria-labelledby="upload-title"
    >
      <div
        className={`rounded-2xl border-2 border-dashed px-6 py-10 text-center transition ${
          dragging ? 'border-cyan-500 bg-cyan-50' : 'border-slate-300 bg-slate-50/70'
        }`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={drop}
      >
        <div
          className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-white text-2xl shadow-sm"
          aria-hidden="true"
        >
          ↑
        </div>
        <h2 id="upload-title" className="text-lg font-semibold text-slate-900">
          Select your store file
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">
          Drag and drop a UTF-8 CSV here, or choose a file. The backend performs complete validation
          before creating a job.
        </p>
        <input
          ref={input}
          className="sr-only"
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => void choose(event.target.files?.[0] ?? null)}
          aria-label="Choose stores CSV"
        />
        <button
          type="button"
          className="mt-5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-cyan-500"
          onClick={() => input.current?.click()}
        >
          Choose CSV file
        </button>
        {file && (
          <div className="mx-auto mt-5 flex max-w-md items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 text-left">
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-slate-900">
                {file.name}
              </span>
              <span className="text-xs text-slate-500">{(file.size / 1024).toFixed(1)} KB</span>
            </span>
            <button
              type="button"
              onClick={() => void choose(null)}
              className="ml-4 text-xs font-semibold text-slate-500 hover:text-slate-900"
            >
              Remove
            </button>
          </div>
        )}
      </div>

      {(errors.length > 0 || serverError) && (
        <div
          role="alert"
          className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
        >
          <p className="font-semibold">Review the file before continuing</p>
          <ul className="mt-1 list-disc pl-5">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
            {serverError && <li>{serverError}</li>}
          </ul>
        </div>
      )}

      <div className="mt-6 flex flex-col gap-5 border-t border-slate-100 pt-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
            Required columns
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {requiredCsvColumns.map((column) => (
              <code
                key={column}
                className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700"
              >
                {column}
              </code>
            ))}
          </div>
        </div>
        <button
          type="button"
          disabled={!file || errors.length > 0 || isUploading}
          onClick={() => void submit()}
          className="inline-flex min-w-40 items-center justify-center rounded-lg bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-cyan-500 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {isUploading ? 'Creating job…' : 'Upload and continue'}
        </button>
      </div>
    </section>
  );
}

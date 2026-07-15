# Workflow Engine V2 P10 Review: Document Extraction Before Chunk Processing

Date: 2026-07-08

## Scope

- Added a dedicated extraction path for `document_chunk_process` before model chunking.
- Text-like artifacts still use direct text content or OSS range reading.
- Binary office/document artifacts are no longer treated as UTF-8 text.

## Implemented

- DOCX extraction through Apache POI `XWPFDocument`.
- XLSX and XLS extraction through Apache POI workbooks and `DataFormatter`.
- PDF extraction through Apache PDFBox.
- Legacy DOC extraction through Apache POI scratchpad.
- Extraction metadata is written to the derived artifact:
  - `extractionMethod`
  - `extractedChars`
  - `extractionTruncated`
- Extracted text is capped at 1,000,000 characters before chunking.
- Direct extraction is capped to 25MB source files to avoid backend OOM before a streaming/cloud parser is introduced.

## Review Findings

- Passed: binary Office files are no longer read as raw UTF-8 during chunk processing.
- Passed: derived workflow artifacts keep source metadata and extraction metadata for auditability.
- Passed: backend compilation succeeds with the new PDFBox and POI scratchpad dependencies.
- Residual risk: files over 25MB still need a streaming extraction backend or cloud document parser. This is intentionally deferred because local full-file parsing would conflict with the large-file/OOM safety requirement.
- Residual risk: scanned PDFs without embedded text still require OCR/vision integration; PDFBox only extracts embedded text.

## Verification

- `mvn.cmd -DskipTests compile` in `backend` passed.

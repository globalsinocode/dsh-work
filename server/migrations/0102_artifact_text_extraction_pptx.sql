-- Execution isolation 2b-3: binary artifacts (PDF, DOCX, XLSX, PPTX) get extracted text from the
-- container extractor `exec-office-v1`; PPTX is a new detected type.
alter table file_extractions drop constraint file_extractions_detected_type_check;
alter table file_extractions add constraint file_extractions_detected_type_check
  check (detected_type in ('pdf', 'docx', 'xlsx', 'pptx', 'csv', 'text'));

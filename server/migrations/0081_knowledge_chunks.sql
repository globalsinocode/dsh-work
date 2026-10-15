-- Chunked full-text retrieval for enterprise knowledge. Documents are split into
-- sentence-aligned chunks of at most 800 characters, and every chunk carries its search
-- terms: lower-cased Latin words and overlapping bigrams of Chinese text. A GIN index on
-- the terms narrows candidates in SQL, so retrieval no longer loads every authorized
-- document. Bigrams are produced explicitly rather than with pg_trgm, whose word
-- detection for Chinese depends on the database locale.

create or replace function knowledge_search_terms(input text) returns text[]
language sql immutable parallel safe as $$
  with normalized as (select lower(coalesce(input, '')) as value),
  words as (
    select m[1] as term
      from normalized, regexp_matches(value, '([a-z0-9_-]{2,})', 'g') as m
  ),
  han_runs as (
    select m[1] as run
      from normalized, regexp_matches(value, '([㐀-䶿一-鿿豈-﫿]{2,})', 'g') as m
  ),
  bigrams as (
    select substr(run, position, 2) as term
      from han_runs, generate_series(1, char_length(run) - 1) as position
  )
  select coalesce(array_agg(distinct term order by term), '{}'::text[])
    from (select term from words union select term from bigrams) as terms
$$;

-- Splits text into chunks of at most max_chars characters, breaking after sentence
-- punctuation and keeping paragraph breaks; an overlong sentence is cut hard.
create or replace function knowledge_split_chunks(input text, max_chars integer default 800)
returns setof text language plpgsql immutable parallel safe as $$
declare
  paragraph text;
  sentence text;
  buffer text := '';
begin
  for paragraph in select btrim(part, E' \t\r\n') from regexp_split_to_table(coalesce(input, ''), E'\\n[ \\t\\r]*\\n') as part loop
    continue when paragraph = '';
    if buffer <> '' then
      if char_length(buffer) + 2 >= max_chars then
        return next buffer;
        buffer := '';
      else
        buffer := buffer || E'\n\n';
      end if;
    end if;
    for sentence in select m[1] from regexp_matches(paragraph, '([^。！？；!?]+[。！？；!?]*|[。！？；!?]+)', 'g') as m loop
      while char_length(sentence) > max_chars loop
        if btrim(buffer, E'\n') <> '' then return next btrim(buffer, E'\n'); end if;
        buffer := '';
        return next substr(sentence, 1, max_chars);
        sentence := substr(sentence, max_chars + 1);
      end loop;
      if char_length(buffer) + char_length(sentence) > max_chars and btrim(buffer, E'\n') <> '' then
        return next btrim(buffer, E'\n');
        buffer := '';
      end if;
      buffer := buffer || sentence;
    end loop;
  end loop;
  if btrim(buffer, E'\n') <> '' then return next btrim(buffer, E'\n'); end if;
end;
$$;

create table knowledge_chunks (
  tenant_id text not null,
  document_id text not null,
  ordinal integer not null check (ordinal >= 0),
  content text not null,
  terms text[] not null,
  title_terms text[] not null,
  primary key (tenant_id, document_id, ordinal),
  foreign key (tenant_id, document_id) references knowledge_documents(tenant_id, id) on delete cascade
);

create index knowledge_chunks_terms on knowledge_chunks using gin (terms);
create index knowledge_chunks_title_terms on knowledge_chunks using gin (title_terms);

create or replace function knowledge_index_document() returns trigger language plpgsql as $$
begin
  delete from knowledge_chunks where tenant_id = new.tenant_id and document_id = new.id;
  insert into knowledge_chunks (tenant_id, document_id, ordinal, content, terms, title_terms)
  select new.tenant_id, new.id, chunk.ordinal - 1, chunk.content,
         knowledge_search_terms(chunk.content), knowledge_search_terms(new.title)
    from knowledge_split_chunks(new.content) with ordinality as chunk(content, ordinal);
  return null;
end;
$$;

create trigger knowledge_documents_index
  after insert or update of title, content on knowledge_documents
  for each row execute function knowledge_index_document();

insert into knowledge_chunks (tenant_id, document_id, ordinal, content, terms, title_terms)
select kd.tenant_id, kd.id, chunk.ordinal - 1, chunk.content,
       knowledge_search_terms(chunk.content), knowledge_search_terms(kd.title)
  from knowledge_documents kd,
       knowledge_split_chunks(kd.content) with ordinality as chunk(content, ordinal);

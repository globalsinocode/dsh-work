-- Keep existing usernames usable while allowing phone/email account identifiers.
alter table local_user_credentials drop constraint local_user_credentials_username_check;
alter table local_user_credentials add constraint local_user_credentials_username_check
  check (char_length(username) between 3 and 254 and username = lower(btrim(username)) and username !~ '[[:space:]]');

create index users_ai_hub_login_account_idx
  on users (tenant_id, lower(btrim(external_subject))) where identity_provider = 'ai-hub';

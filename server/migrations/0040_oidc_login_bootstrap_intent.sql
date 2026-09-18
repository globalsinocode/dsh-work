-- Explicit login intent is server-authored and bound to the single-use OIDC transaction.
-- Old pending transactions remain normal logins; no historical claim is fabricated.
alter table oidc_login_transactions
  add column login_purpose text not null default 'login'
    check (login_purpose in ('login', 'admin-bootstrap'));
alter table oidc_login_transactions
  add constraint oidc_bootstrap_requires_admin_audience
    check (login_purpose <> 'admin-bootstrap' or audience = 'admin');

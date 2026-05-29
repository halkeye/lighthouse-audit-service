CREATE TABLE IF NOT EXISTS lighthouse_audits (
  id varchar(36) PRIMARY KEY NOT NULL,
  url text NOT NULL,
  time_created datetime NOT NULL,
  time_completed datetime,
  report_json text
);

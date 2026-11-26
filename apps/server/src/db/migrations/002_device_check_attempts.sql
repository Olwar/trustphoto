-- One row per Play Integrity call made for an install that has never passed
-- the device check. Junk tokens from free installs must not be able to spend
-- the Google quota that real phones need (see services/captures.ts).
CREATE TABLE device_check_attempts (
  id uuid PRIMARY KEY,
  install_id uuid NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
  client_key text NOT NULL,
  at timestamptz NOT NULL
);
CREATE INDEX device_check_attempts_install ON device_check_attempts (install_id, at);
CREATE INDEX device_check_attempts_client ON device_check_attempts (client_key, at);

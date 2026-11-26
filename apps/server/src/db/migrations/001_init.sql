-- One row per app install. TrustPhoto has no accounts: the install token is
-- the only credential, stored as a SHA-256.
CREATE TABLE installs (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- iOS App Attest key, registered once per install.
  app_attest_key_id text UNIQUE,
  app_attest_public_key_pem text,
  app_attest_sign_count bigint
);

CREATE TABLE attest_challenges (
  challenge text PRIMARY KEY,
  install_id uuid NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);

CREATE TABLE capture_nonces (
  nonce uuid PRIMARY KEY,
  install_id uuid NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);
CREATE INDEX capture_nonces_created_at ON capture_nonces (created_at);

-- Every accepted upload, verified or not. The UNIQUE columns are the
-- authoritative replay fence: the same bytes or the same exact motion trace
-- never verify twice. sensor_fingerprint is the looser fingerprint that the
-- photo checks may give for a motion trace; phones held still can share one,
-- so it only fences replays within one install (see services/captures.ts).
CREATE TABLE captures (
  id uuid PRIMARY KEY,
  install_id uuid NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL,
  image_sha256 text NOT NULL UNIQUE,
  sensor_digest text UNIQUE,
  sensor_fingerprint text,
  status text NOT NULL CHECK (status IN ('verified', 'not_verified', 'rejected')),
  reason text,
  score real,
  attestation_verdict text NOT NULL,
  platform text NOT NULL,
  device_model text,
  app_version text,
  client_captured_at timestamptz,
  result jsonb NOT NULL
);
CREATE INDEX captures_install ON captures (install_id, received_at DESC);
CREATE INDEX captures_install_fingerprint ON captures (install_id, sensor_fingerprint);

-- Public proofs. Only verified captures get one.
CREATE TABLE photos (
  id text PRIMARY KEY,
  capture_id uuid NOT NULL UNIQUE REFERENCES captures(id) ON DELETE CASCADE,
  install_id uuid NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL,
  original_sha256 text NOT NULL,
  public_sha256 text NOT NULL UNIQUE,
  phash text NOT NULL CHECK (phash ~ '^[0-9a-f]{16}$'),
  width integer NOT NULL,
  height integer NOT NULL,
  device_label text,
  checks jsonb NOT NULL,
  is_test boolean NOT NULL,
  receipt jsonb NOT NULL,
  signature text NOT NULL,
  deleted_at timestamptz
);
CREATE INDEX photos_original_sha256 ON photos (original_sha256);
CREATE INDEX photos_install ON photos (install_id, received_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE reports (
  id uuid PRIMARY KEY,
  photo_id text NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('not_real', 'private', 'offensive', 'other')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reporter_hash text NOT NULL,
  UNIQUE (photo_id, reporter_hash)
);

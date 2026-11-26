-- Calls for installs that passed before are booked too (their own daily cap).
ALTER TABLE device_check_attempts ADD COLUMN lane text NOT NULL DEFAULT 'unproven' CHECK (lane IN ('proven', 'unproven'));
CREATE INDEX device_check_attempts_at ON device_check_attempts (at);

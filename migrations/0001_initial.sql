-- Zein E-Services: complete initial schema.
-- Apply ONCE to a brand-new, empty D1 database (see README).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK(length(username) BETWEEN 3 AND 32),
  display_name TEXT,
  email TEXT,
  contact_note TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  recovery_code_hash TEXT,
  role TEXT NOT NULL DEFAULT 'student' CHECK(role IN ('student','owner')),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_users_single_owner ON users(role) WHERE role='owner';

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- One active owner-issued reset passcode per student (replacement overwrites).
CREATE TABLE reset_passcodes (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  passcode_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT
);

-- Short-lived tokens that authorize exactly one password reset.
CREATE TABLE reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE TABLE security_events (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  username TEXT,
  event_type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_security_created ON security_events(created_at DESC);

CREATE TABLE inquiries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  service TEXT NOT NULL,
  education_level TEXT NOT NULL CHECK(education_level IN ('Elementary School','Junior High School','Senior High School')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  deadline TEXT,
  preferred_date TEXT,
  extra_notes TEXT,
  contact_details TEXT,
  status TEXT NOT NULL DEFAULT 'Submitted' CHECK(status IN ('Submitted','Read','Under Review','Awaiting Response','Accepted','In Progress','Completed','Declined','Cancelled')),
  student_message TEXT,
  internal_notes TEXT,
  expected_completion TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at TEXT,
  completed_at TEXT
);
CREATE INDEX idx_inquiries_user ON inquiries(user_id, created_at DESC);
CREATE INDEX idx_inquiries_status ON inquiries(status, created_at DESC);

CREATE TABLE inquiry_files (
  id TEXT PRIMARY KEY,
  inquiry_id TEXT NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
  uploader_user_id TEXT NOT NULL REFERENCES users(id),
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  file_kind TEXT NOT NULL CHECK(file_kind IN ('incoming','deliverable')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  first_downloaded_at TEXT,
  delete_after TEXT,
  deleted_at TEXT
);
CREATE INDEX idx_files_inquiry ON inquiry_files(inquiry_id, file_kind);
CREATE INDEX idx_files_cleanup ON inquiry_files(delete_after) WHERE deleted_at IS NULL;

-- Timeline: status changes, downloads, and student/owner messages.
CREATE TABLE inquiry_events (
  id TEXT PRIMARY KEY,
  inquiry_id TEXT NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id),
  event_type TEXT NOT NULL,
  message TEXT,
  visible_to_student INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_events_inquiry ON inquiry_events(inquiry_id, created_at);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  inquiry_id TEXT NOT NULL UNIQUE REFERENCES inquiries(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment TEXT,
  visible INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_reviews_visible ON reviews(visible, created_at DESC);

CREATE TABLE payment_methods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_holder TEXT,
  account_identifier TEXT,
  instructions TEXT,
  qr_object_key TEXT,
  qr_content_type TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_payment_order ON payment_methods(enabled, sort_order);

CREATE TABLE contribution_receipts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  inquiry_id TEXT REFERENCES inquiries(id) ON DELETE SET NULL,
  payment_method_id TEXT REFERENCES payment_methods(id) ON DELETE SET NULL,
  object_key TEXT UNIQUE,
  content_type TEXT,
  size_bytes INTEGER,
  thank_you_message TEXT,
  reviewed_at TEXT,
  delete_after TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_receipts_created ON contribution_receipts(created_at DESC);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Discord notification outbox (idempotent via dedupe_key).
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT
);
CREATE INDEX idx_notifications_pending ON notifications(status, created_at);

-- Objects pending deletion in R2 (retry-safe cleanup queue).
CREATE TABLE r2_cleanup (
  object_key TEXT PRIMARY KEY,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO settings(key,value) VALUES
  ('discord_enabled','0'),
  ('discord_owner_id',''),
  ('discord_events','{"new_inquiry":true,"student_info":false,"decision":false,"completed":false,"new_review":false,"receipt":false,"download":false}');

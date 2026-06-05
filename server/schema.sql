CREATE DATABASE IF NOT EXISTS device_command_center
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE device_command_center;

CREATE TABLE IF NOT EXISTS devices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_uid VARCHAR(80) NOT NULL,
  name VARCHAR(190) NOT NULL,
  api_token_hash CHAR(64) NOT NULL,
  platform VARCHAR(80) DEFAULT NULL,
  hostname VARCHAR(190) DEFAULT NULL,
  agent_version VARCHAR(40) DEFAULT NULL,
  last_seen DATETIME DEFAULT NULL,
  favorite TINYINT(1) NOT NULL DEFAULT 0,
  tags VARCHAR(255) NOT NULL DEFAULT '',
  permission_profile VARCHAR(32) NOT NULL DEFAULT 'full',
  transport_mode VARCHAR(32) NOT NULL DEFAULT 'auto',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_devices_uid (device_uid),
  KEY idx_devices_last_seen (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS commands (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(64) NOT NULL,
  payload_json LONGTEXT DEFAULT NULL,
  status ENUM('queued','running','succeeded','failed','cancelled') NOT NULL DEFAULT 'queued',
  result_text MEDIUMTEXT DEFAULT NULL,
  result_json LONGTEXT DEFAULT NULL,
  error_text TEXT DEFAULT NULL,
  artifact_path VARCHAR(255) DEFAULT NULL,
  artifact_name VARCHAR(255) DEFAULT NULL,
  artifact_mime VARCHAR(120) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at DATETIME DEFAULT NULL,
  completed_at DATETIME DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_commands_device_status (device_id, status, id),
  KEY idx_commands_created_at (created_at),
  CONSTRAINT fk_commands_device
    FOREIGN KEY (device_id) REFERENCES devices (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id BIGINT UNSIGNED DEFAULT NULL,
  command_id BIGINT UNSIGNED DEFAULT NULL,
  event_type VARCHAR(80) NOT NULL,
  details_json LONGTEXT DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_created_at (created_at),
  KEY idx_audit_device (device_id),
  KEY idx_audit_command (command_id),
  CONSTRAINT fk_audit_device
    FOREIGN KEY (device_id) REFERENCES devices (id)
    ON DELETE SET NULL,
  CONSTRAINT fk_audit_command
    FOREIGN KEY (command_id) REFERENCES commands (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

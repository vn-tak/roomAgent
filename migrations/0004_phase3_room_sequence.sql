-- Phase 3 projection of the RoomDO head. The object remains the ordering authority.

CREATE TABLE room_sequences (
  org_id TEXT NOT NULL REFERENCES organizations (id),
  room_id TEXT NOT NULL REFERENCES rooms (id),
  seq INTEGER NOT NULL CHECK (seq >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, room_id)
);

CREATE INDEX room_sequences_room_idx ON room_sequences (org_id, room_id, seq);

"""add chat messages and matching state (additive, idempotent)

Revision ID: 0005_chat_matching
Revises: 0004_request_photos
"""

from alembic import op
import sqlalchemy as sa

revision = "0005_chat_matching"
down_revision = "0004_request_photos"
branch_labels = None
depends_on = None


def upgrade() -> None:
    statements = [
        "ALTER TABLE app_private.seller_applications ADD COLUMN IF NOT EXISTS status varchar(10) NOT NULL DEFAULT 'pending'",
        "ALTER TABLE app_private.seller_applications ADD COLUMN IF NOT EXISTS decided_at timestamptz NULL",
        """DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_seller_applications_status') THEN
            ALTER TABLE app_private.seller_applications ADD CONSTRAINT ck_seller_applications_status
              CHECK (status IN ('pending', 'accepted', 'closed'));
          END IF;
        END $$""",
        """DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_seller_applications_decided_at') THEN
            ALTER TABLE app_private.seller_applications ADD CONSTRAINT ck_seller_applications_decided_at
              CHECK ((status = 'pending') = (decided_at IS NULL));
          END IF;
        END $$""",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_seller_applications_one_accepted ON app_private.seller_applications (request_id) WHERE status = 'accepted'",
        """CREATE TABLE IF NOT EXISTS app_private.chat_messages (
          id uuid NOT NULL PRIMARY KEY,
          room_id uuid NOT NULL,
          sender_id uuid NOT NULL,
          seq integer NOT NULL,
          client_message_id uuid NOT NULL,
          body text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT fk_chat_messages_room FOREIGN KEY (room_id) REFERENCES app_private.chat_rooms (id) ON DELETE CASCADE,
          CONSTRAINT fk_chat_messages_sender FOREIGN KEY (sender_id) REFERENCES app_private.users (id) ON DELETE CASCADE,
          CONSTRAINT uq_chat_messages_room_seq UNIQUE (room_id, seq),
          CONSTRAINT uq_chat_messages_client_id UNIQUE (room_id, sender_id, client_message_id),
          CONSTRAINT ck_chat_messages_seq_positive CHECK (seq >= 1),
          CONSTRAINT ck_chat_messages_body_len CHECK (char_length(btrim(body)) BETWEEN 1 AND 1000)
        )""",
        "CREATE INDEX IF NOT EXISTS ix_chat_messages_sender_id ON app_private.chat_messages (sender_id)",
    ]
    for statement in statements:
        op.execute(sa.text(statement))


def downgrade() -> None:
    op.execute(sa.text("DROP TABLE IF EXISTS app_private.chat_messages"))
    op.execute(sa.text("DROP INDEX IF EXISTS app_private.uq_seller_applications_one_accepted"))
    op.execute(sa.text("ALTER TABLE app_private.seller_applications DROP CONSTRAINT IF EXISTS ck_seller_applications_decided_at"))
    op.execute(sa.text("ALTER TABLE app_private.seller_applications DROP CONSTRAINT IF EXISTS ck_seller_applications_status"))
    op.execute(sa.text("ALTER TABLE app_private.seller_applications DROP COLUMN IF EXISTS decided_at"))
    op.execute(sa.text("ALTER TABLE app_private.seller_applications DROP COLUMN IF EXISTS status"))

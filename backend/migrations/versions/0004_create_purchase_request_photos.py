"""create purchase request photos (additive and idempotent)

Revision ID: 0004_request_photos
Revises: 0003_seller_applications
"""

from alembic import op
import sqlalchemy as sa

revision = "0004_request_photos"
down_revision = "0003_seller_applications"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # This revision is deliberately safe to invoke directly by the shared-DB
    # test helper; it never updates alembic_version.
    op.execute(sa.text("""
        CREATE TABLE IF NOT EXISTS app_private.purchase_request_photos (
          id uuid PRIMARY KEY,
          uploader_id uuid NOT NULL REFERENCES app_private.users(id) ON DELETE CASCADE,
          request_id uuid NULL REFERENCES app_private.purchase_requests(id) ON DELETE CASCADE,
          status varchar(10) NOT NULL,
          storage_backend varchar(10) NOT NULL,
          storage_bucket varchar(63) NULL,
          storage_path text NOT NULL,
          content_type varchar(20) NOT NULL,
          byte_size integer NOT NULL,
          width integer NOT NULL,
          height integer NOT NULL,
          sort_order smallint NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          discarded_at timestamptz NULL,
          object_deleted_at timestamptz NULL,
          CONSTRAINT ck_request_photos_status CHECK (status IN ('uploading','pending','attached','discarded')),
          CONSTRAINT ck_request_photos_backend CHECK (storage_backend IN ('memory','local','supabase')),
          CONSTRAINT ck_request_photos_bucket CHECK ((storage_backend = 'supabase') = (storage_bucket IS NOT NULL)),
          CONSTRAINT ck_request_photos_content_type CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
          CONSTRAINT ck_request_photos_byte_size CHECK (byte_size BETWEEN 1 AND 3145728),
          CONSTRAINT ck_request_photos_pixels CHECK (width > 0 AND height > 0 AND width::bigint * height <= 20000000),
          CONSTRAINT ck_request_photos_sort_order CHECK (sort_order IS NULL OR sort_order BETWEEN 0 AND 4),
          CONSTRAINT ck_request_photos_attached_link CHECK ((status = 'attached') = (request_id IS NOT NULL AND sort_order IS NOT NULL)),
          CONSTRAINT ck_request_photos_discarded_at CHECK ((status = 'discarded') = (discarded_at IS NOT NULL)),
          CONSTRAINT ck_request_photos_deleted_only_discarded CHECK (object_deleted_at IS NULL OR status = 'discarded'),
          CONSTRAINT uq_request_photos_storage_path UNIQUE (storage_path)
        )
    """))
    op.execute(sa.text("CREATE INDEX IF NOT EXISTS ix_request_photos_request_id ON app_private.purchase_request_photos (request_id) WHERE status = 'attached'"))
    op.execute(sa.text("CREATE INDEX IF NOT EXISTS ix_request_photos_uploader_status ON app_private.purchase_request_photos (uploader_id, status, created_at)"))
    op.execute(sa.text("CREATE INDEX IF NOT EXISTS ix_request_photos_cleanup ON app_private.purchase_request_photos (storage_backend, storage_bucket, status, created_at) WHERE object_deleted_at IS NULL"))
    op.execute(sa.text("CREATE UNIQUE INDEX IF NOT EXISTS uq_request_photos_request_sort ON app_private.purchase_request_photos (request_id, sort_order) WHERE status = 'attached'"))


def downgrade() -> None:
    op.execute(sa.text("DROP TABLE IF EXISTS app_private.purchase_request_photos"))

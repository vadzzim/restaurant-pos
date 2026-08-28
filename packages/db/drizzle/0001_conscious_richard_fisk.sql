CREATE TABLE "outbox_controls" (
	"id" text PRIMARY KEY NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"publish_delay_ms" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_controls_singleton" CHECK ("outbox_controls"."id" = 'singleton')
);
--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "reclaim_count" integer DEFAULT 0 NOT NULL;
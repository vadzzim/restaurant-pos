CREATE TABLE "printer_controls" (
	"id" text PRIMARY KEY NOT NULL,
	"failing" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "printer_controls_singleton" CHECK ("printer_controls"."id" = 'singleton')
);
--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "restaurant_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD COLUMN "printed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_restaurant_id_restaurants_id_fk" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "print_jobs_order_id_idx" ON "print_jobs" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "print_jobs_state_idx" ON "print_jobs" USING btree ("state");
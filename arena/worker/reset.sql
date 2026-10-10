-- Empties the arena's tables between seasons. Run only by the "reset arena season"
-- workflow, after the owner approves in the TAL session. Cannot be undone.
-- The same database also holds the site's and the bot's tables: only arena_ tables here.
DELETE FROM arena_orders;
DELETE FROM arena_events;
DELETE FROM arena_blobs;
DELETE FROM arena_meta;
DELETE FROM arena_agents;

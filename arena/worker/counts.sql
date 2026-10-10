-- Row counts of the arena's tables (read only). Printed before and after a reset.
SELECT 'arena_agents' AS tbl, COUNT(*) AS n FROM arena_agents
UNION ALL SELECT 'arena_orders', COUNT(*) FROM arena_orders
UNION ALL SELECT 'arena_events', COUNT(*) FROM arena_events
UNION ALL SELECT 'arena_blobs', COUNT(*) FROM arena_blobs
UNION ALL SELECT 'arena_meta', COUNT(*) FROM arena_meta;

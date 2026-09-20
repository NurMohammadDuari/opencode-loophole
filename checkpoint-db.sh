#!/bin/bash
# Force opencode database WAL checkpoint to prevent chat loss on shutdown/reboot
# Run this before closing opencode or shutting down

DB="/home/mint/.local/share/opencode/opencode.db"

if [ ! -f "$DB" ]; then
    echo "opencode.db not found"
    exit 1
fi

WAL_SIZE=$(stat -c%s "${DB}-wal" 2>/dev/null || echo 0)
echo "WAL size before checkpoint: ${WAL_SIZE} bytes"

python3 -c "
import sqlite3
conn = sqlite3.connect('$DB', timeout=5)
result = conn.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
print(f'Checkpoint: busy={result[0]}, log={result[1]}, checkpointed={result[2]}')
conn.close()
"

WAL_SIZE_AFTER=$(stat -c%s "${DB}-wal" 2>/dev/null || echo 0)
echo "WAL size after checkpoint: ${WAL_SIZE_AFTER} bytes"
echo "Done. Your chats are safely saved."

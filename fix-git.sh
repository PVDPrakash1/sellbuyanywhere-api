#!/usr/bin/env bash
# Fixes: "Your local changes to data/sba.db-shm and data/sba.db-wal would be overwritten by merge".
# Run it from the folder that contains data/ (the repo folder):   bash fix-git.sh
# It backs up your live data, discards the local changes to the tracked data files, pulls, stops git from tracking data
# for good, then puts your live data back. Backup is kept in ~/sba-backup-DATE.
set -e
cd "$(dirname "$0")"
BK="${BACKUP_DIR:-$HOME/sba-backup-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$BK"

echo "1/6 Backing up live data to $BK"
if [ -f data/sba.db ]; then
  if command -v sqlite3 >/dev/null 2>&1; then sqlite3 data/sba.db ".backup '$BK/sba.db'"
  elif [ -d node_modules/better-sqlite3 ]; then node -e "require('better-sqlite3')('data/sba.db').backup(process.argv[1]).then(()=>process.exit(0))" "$BK/sba.db"
  else cp data/sba.db "$BK/sba.db"; fi
fi
[ -d data ] && cp -a data "$BK/data-raw"
[ -d uploads ] && cp -a uploads "$BK/uploads"

echo "2/6 Discarding local changes to the tracked data files"
git checkout -- data 2>/dev/null || true
git checkout -- uploads 2>/dev/null || true

echo "3/6 Pulling the latest code"
git config pull.rebase false      # later plain "git pull" calls will merge instead of stopping with "divergent branches"
git pull --no-edit

echo "4/6 Telling git to stop tracking data"
git rm -r --cached --quiet data 2>/dev/null || true
git rm -r --cached --quiet uploads 2>/dev/null || true
for l in "data/" "uploads/" "*.db" "*.db-wal" "*.db-shm" ".env" "node_modules/"; do
  grep -qxF "$l" .gitignore 2>/dev/null || echo "$l" >> .gitignore
done
git add .gitignore
git -c user.name="${GIT_AUTHOR_NAME:-deploy}" -c user.email="${GIT_AUTHOR_EMAIL:-deploy@example.com}" commit -q -m "Stop tracking live data" || true

echo "5/6 Putting your live data back"
mkdir -p data
if [ -f "$BK/sba.db" ]; then rm -f data/sba.db data/sba.db-wal data/sba.db-shm; cp "$BK/sba.db" data/sba.db; fi
if [ -d "$BK/uploads" ]; then mkdir -p uploads; cp -a "$BK/uploads/." uploads/; fi

echo "6/6 Done. Backup kept at $BK . Now restart the app."

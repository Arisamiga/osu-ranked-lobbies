// Script to migrate from Season 1 database format to Season 2.
// Intended to be run once then thrown away.
//
// Instructions for myself:
// 1. Locally, run `node util/migrate_maps.js`
// 2. Locally, run `node util/add_pool.js` for each map pool
// 3. Upload orl.db to the server
// 3.1. On the server, extract the latest .osu map dump
// 4. On the server, shut down the bot
// 5. On the server, run `node util/migrate_users_and_lobbies.js`
// 6. On the server, boot the bot back up

import Database from 'better-sqlite3';


const discord = new Database('discord.db');
const old_db = new Database('ranks.db');
new_db.pragma('JOURNAL_MODE = WAL');

const new_db = new Database('orl.db');
new_db.pragma('count_changes = OFF');
new_db.pragma('TEMP_STORE = MEMORY');
new_db.pragma('JOURNAL_MODE = OFF');
new_db.pragma('SYNCHRONOUS = OFF');
new_db.pragma('LOCKING_MODE = EXCLUSIVE');

// 1. Import Discord IDs
const all_IDs = discord.prepare(`SELECT osu_id, discord_id FROM user`).all();
const insert_ids = new_db.prepare(`INSERT INTO old_discord_user (osu_id, discord_id) VALUES (?, ?)`);
for (const IDs of all_IDs) {
  insert_ids.run(IDs.osu_id, IDs.discord_id);
}

// 2. Import old lobbies
const all_lobbies = old_db.prepare(`SELECT * FROM lobby`).all();
const insert_match = new_db.prepare(`INSERT INTO match (match_id, data, start_time) VALUES (?, ?, ?)`);
for (const lobby of all_lobbies) {
  const data = JSON.parse(lobby.data);

  data.type = data.mode;
  delete data.mode;

  data.creator_id = data.creator_osu_id;
  delete data.creator_osu_id;

  data.restart_msg = 'Season 2 starts now!';

  insert_match.run(lobby.id, JSON.stringify(data), Date.now());
}

// 3. Cleanup
discord.close();
old_db.close();
new_db.close();

console.log('Done!');

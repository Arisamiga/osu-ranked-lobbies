import db from '../database.js';


async function extract_pools() {
  const pools = db.prepare(`SELECT * FROM map_pool`).all();
  for (const pool of pools) {
    console.info(`<br><br>-- Pool by <a href="https://osu.ppy.sh/users/${pool.user_id}">https://osu.ppy.sh/users/${pool.user_id}</a><br>`);
    const data = JSON.parse(pool.data);
    const map_ids = [];
    for (const set of data.beatmapsets) {
      for (const map of set.beatmaps) {
        map_ids.push(map.id);
      }
    }

    // LIMITING TO MANIA (mode = 3) FOR NOW
    const res = db.prepare(`SELECT * FROM map WHERE map_id IN (${map_ids.join(',')}) AND mode = 3 AND ranked != 4`).all();
    res.sort((a, b) => a.stars - b.stars);
    for (const map of res) {
      console.info(`${map.stars.toFixed(1)}* <a href="https://osu.ppy.sh/b/${map.map_id}">${map.name}</a><br>`);
    }
  }
}

extract_pools();


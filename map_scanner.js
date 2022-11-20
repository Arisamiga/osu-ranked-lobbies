import * as fs from 'fs/promises';
import {constants} from 'fs';
import fetch from 'node-fetch';
import {Beatmap, Calculator} from 'rosu-pp';

import {osu_fetch} from './api.js';
import db from './database.js';


// Promise queue to make sure we're only scanning one map at a time (eliminating race conditions)
const queue = [];
async function run_queue_loop() {
  while (queue.length > 0) {
    try {
      const res = await _get_map_info(queue[0].map_id, queue[0].api_res);
      queue[0].resolve(res);
    } catch (err) {
      queue[0].reject(err);
    }

    queue.shift();
  }
}

function get_map_info(map_id, api_res) {
  return new Promise((resolve, reject) => {
    queue.push({map_id, api_res, resolve, reject});

    // First item in the queue: init queue loop
    if (queue.length == 1) run_queue_loop();
  });
}

// Get metadata and pp from map ID (downloads it if not already downloaded)
async function _get_map_info(map_id, api_res) {
  const map = db.prepare(`SELECT * FROM map WHERE map_id = ?`).get(map_id);
  if (map) {
    return map;
  }

  // 1. Download the map
  // Looking for .osu files? peppy provides monthly dumps here: https://data.ppy.sh/
  const file = `maps/${parseInt(map_id, 10)}.osu`;
  try {
    await fs.access(file, constants.F_OK);
  } catch (err) {
    console.log(`Beatmap id ${map_id} not found, downloading it.`);
    const new_file = await fetch(`https://osu.ppy.sh/osu/${map_id}`);
    const text = await new_file.text();
    if (text == '') {
      // While in most cases an empty page means the map ID doesn't exist, in
      // some rare cases osu! servers actually don't have the .osu file for a
      // valid map ID. But we can't do much about it.
      throw new Error('Invalid map ID');
    }
    await fs.writeFile(file, text);
  }

  // 2. Process it with rosu-pp
  const rosu_map = new Beatmap({path: file});
  const calc = new Calculator();
  const attrs = calc.mapAttributes(rosu_map);
  const perf = calc.performance(rosu_map);
  let approx_mu = (perf.difficulty.stars * 325 - 1500) / 173.7178; // 4.6* ~= 1500 elo (patented algorithm)
  if (approx_mu < 0) approx_mu = 0;
  if (approx_mu > 3000) approx_mu = 3000;

  // 3. Get additionnal map info from osu!api
  // (we can't get the following just from the .osu file: set_id, length, ranked, dmca)
  if (!api_res) {
    console.info(`[API] Fetching map data for map ID ${map_id}`);
    api_res = await osu_fetch(`https://osu.ppy.sh/api/v2/beatmaps/lookup?id=${map_id}`);
  }

  // 4. Cause eyeStrain to the reader
  const rating = db.prepare(
      `INSERT INTO rating (mode, base_mu, current_mu) VALUES (?, ?, ?) RETURNING rowid`,
  ).get(api_res.mode_int + 4, approx_mu, approx_mu);
  db.prepare(`
    INSERT INTO map (
      map_id, name, mode, ar, cs, hp, od, bpm, set_id, length, ranked, dmca, rating_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      map_id, api_res.beatmapset.title, api_res.mode_int,
      attrs.ar, attrs.cs, attrs.hp, attrs.od, attrs.bpm,
      api_res.beatmapset.id, api_res.total_length, api_res.beatmapset.ranked,
      api_res.beatmapset.availability.download_disabled ? 1 : 0, rating.rowid,
  );

  // 5. Process all mod combinations
  console.info('Computing pp for map ', map_id);
  const compute_and_insert = (mods) => {
    const calc = new Calculator({mods});
    const perf = calc.performance(rosu_map);
    db.prepare(
        `INSERT INTO pp (map_id, mods, stars, pp) VALUES (?, ?, ?, ?)`,
    ).run(
        map_id, mods, perf.difficulty.stars, perf.pp,
    );
  };
  const nm = 1 << 0;
  const ez = 1 << 1;
  const hd = 1 << 3;
  const hr = 1 << 4;
  const dt = 1 << 6;
  const ht = 1 << 8;
  const fl = 1 << 10;
  compute_and_insert(nm);
  compute_and_insert(hd);
  compute_and_insert(hr);
  compute_and_insert(dt);
  compute_and_insert(fl);
  compute_and_insert(ez);
  compute_and_insert(ht);
  compute_and_insert(hd | hr);
  compute_and_insert(hd | dt);
  compute_and_insert(hd | fl);
  compute_and_insert(hr | dt);
  compute_and_insert(hr | fl);
  compute_and_insert(dt | fl);
  compute_and_insert(hd | ez);
  compute_and_insert(hd | ht);
  compute_and_insert(ez | ht);
  compute_and_insert(ez | fl);
  compute_and_insert(ht | fl);
  compute_and_insert(ez | dt);
  compute_and_insert(hr | ht);
  compute_and_insert(hd | hr | dt);
  compute_and_insert(hd | hr | fl);
  compute_and_insert(hd | dt | fl);
  compute_and_insert(hr | dt | fl);
  compute_and_insert(hd | ez | ht);
  compute_and_insert(hd | ez | fl);
  compute_and_insert(hd | ht | fl);
  compute_and_insert(ez | ht | fl);
  compute_and_insert(hd | ez | dt);
  compute_and_insert(ez | dt | fl);
  compute_and_insert(hd | hr | ht);
  compute_and_insert(hr | ht | fl);
  compute_and_insert(hd | hr | dt | fl);
  compute_and_insert(hd | ez | ht | fl);
  compute_and_insert(hd | ez | dt | fl);
  compute_and_insert(hd | hr | ht | fl);

  return await get_map_info(map_id);
}

export {get_map_info};

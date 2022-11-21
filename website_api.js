// Note to potential API users:
// - If you want to do batch requests, it's probably better to just ask for
//   the data instead.
// - API is subject to change. Message us if you're using it so we avoid
//   breaking it in the future.

import dayjs from 'dayjs';
import express from 'express';
import relativeTime from 'dayjs/plugin/relativeTime.js';
dayjs.extend(relativeTime);

import Config from './util/config.js';
import bancho from './bancho.js';
import db from './database.js';
import {get_user_ranks} from './glicko.js';
import {init_lobby} from './ranked.js';
import {osu_fetch} from './api.js';

const USER_NOT_FOUND = new Error('User not found. Have you played a game in a ranked lobby yet?');
USER_NOT_FOUND.http_code = 404;
const RULESET_NOT_FOUND = new Error('Ruleset not found. Must be one of "osu", "taiko", "catch" or "mania".');
RULESET_NOT_FOUND.http_code = 404;


function mods_to_flags(mod_list) {
  let flags = 0;

  for (const mod of mod_list) {
    if (mod == 'NM') return 'none';
    if (mod == 'EZ') flags |= 2;
    if (mod == 'HD') flags |= 8;
    if (mod == 'HR') flags |= 16;
    if (mod == 'SD') flags |= 32;
    if (mod == 'DT') flags |= 64;
    if (mod == 'NC') flags |= 64 | 512;
    if (mod == 'HT') flags |= 256;
    if (mod == 'FL') flags |= 1024;
    if (mod == 'FI') flags |= 1048576;
    if (mod == 'CO') flags |= 33554432;
    if (mod == 'MR') flags |= 1073741824;
  }
  if ((flags & 64) && (flags & 256)) {
    throw new Error('Invalid mod combination');
  }
  if ((flags & 2) && (flags & 16)) {
    throw new Error('Invalid mod combination');
  }

  return flags;
}

function flags_to_mods(flags) {
  if (flags == 'none') return ['NM'];

  const mods = [];
  if (flags & 2) mods.push('EZ');
  if (flags & 8) mods.push('HD');
  if (flags & 16) mods.push('HR');
  if (flags & 32) mods.push('SD');
  if ((flags & 64) && !(flags & 512)) mods.push('DT');
  if (flags & 512) mods.push('NC');
  if (flags & 256) mods.push('HT');
  if (flags & 1024) mods.push('FL');
  if (flags & 1048576) mods.push('FI');
  if (flags & 33554432) mods.push('CO');
  if (flags & 1073741824) mods.push('MR');

  return mods;
}


function validate_lobby_settings(settings) {
  settings.ruleset = parseInt(settings.ruleset, 10);
  if (![0, 1, 2, 3].includes(settings.ruleset)) {
    throw new Error('Invalid ruleset');
  }
  if (!['random', 'pp', 'elo'].includes(settings.map_selection_algo)) {
    throw new Error('Invalid map selection');
  }
  if (!['leaderboarded', 'collection'].includes(settings.map_pool)) {
    throw new Error('Invalid map pool');
  }
  if (settings.map_pool == 'collection' && isNaN(parseInt(settings.collection_id, 10))) {
    throw new Error('Invalid collection url');
  }

  settings.mods = mods_to_flags(settings.mod_list);
  settings.mod_list = flags_to_mods(settings.mods);
  if (settings.mods != 'none') {
    // Unflag NC - we use the flags for pp search, and DT is used instead
    settings.mods = settings.mods & ~(512);
  }

  settings.min_stars = 0;
  settings.max_stars = 11;
  settings.filter_query = '1';
  for (const filter of settings.filters) {
    const valid = ['pp', 'sr', 'length', 'ar', 'cs', 'od', 'bpm'];
    if (!valid.includes(filter.name)) {
      throw new Error(`Invalid filter '${filter.name}'`);
    }
    if (filter.name == 'cs' && (settings.ruleset == 1 || settings.ruleset == 3)) {
      throw new Error(`CS illegal for taiko/mania`);
    }

    filter.min = parseFloat(filter.min, 10);
    filter.max = parseFloat(filter.max, 10);
    if (isNaN(filter.min)) {
      throw new Error(`Invalid minimum value for filter '${filter.name}'`);
    }
    if (isNaN(filter.max)) {
      throw new Error(`Invalid maximum value for filter '${filter.name}'`);
    }

    if (filter.name == 'sr') {
      filter.name = 'stars';
      settings.min_stars = filter.min;
      settings.max_stars = filter.max;
    }

    settings.filter_query += ` AND ${filter.name} >= ${filter.min} AND ${filter.name} <= ${filter.max}`;
  }

  if (settings.ruleset == 3) {
    let key_query = '0';
    for (const key of settings.key_count) {
      const key_int = parseInt(key, 10);
      if (isNaN(key_int)) {
        throw new Error('Invalid key count');
      }

      key_query += ` OR cs = ${key_int}`;
    }
    if (key_query == '0') {
      throw new Error('You must select one or more key counts');
    }

    settings.filter_query += ` AND (${key_query})`;
  }
}


function ruleset_to_mode(ruleset) {
  if (ruleset == 'osu') {
    return 0;
  } else if (ruleset == 'taiko') {
    return 1;
  } else if (ruleset == 'catch') {
    return 2;
  } else if (ruleset == 'mania') {
    return 3;
  } else {
    throw RULESET_NOT_FOUND;
  }
}

function ruleset_to_rating_column(ruleset) {
  if (ruleset == 'osu') {
    return 'osu_rating';
  } else if (ruleset == 'taiko') {
    return 'taiko_rating';
  } else if (ruleset == 'catch') {
    return 'catch_rating';
  } else if (ruleset == 'mania') {
    return 'mania_rating';
  } else {
    throw RULESET_NOT_FOUND;
  }
}


async function get_leaderboard_page(ruleset, page_num) {
  const PLAYERS_PER_PAGE = 20;

  const mode = ruleset_to_mode(ruleset);
  const total_players = db.prepare(
      `SELECT COUNT(*) AS nb FROM rating WHERE mode = ? AND nb_scores > 4`,
  ).get(mode);

  // Fix user-provided page number
  const nb_pages = Math.ceil(total_players.nb / PLAYERS_PER_PAGE);
  if (page_num <= 0 || isNaN(page_num)) {
    page_num = 1;
  }
  if (page_num > nb_pages) {
    page_num = nb_pages;
  }

  const offset = (page_num - 1) * PLAYERS_PER_PAGE;

  const res = db.prepare(`
    SELECT user_id, username, elo FROM user
    INNER JOIN rating ON user.${ruleset_to_rating_column(ruleset)} = rating.rowid
    WHERE rating.mode = ? AND nb_scores > 4
    ORDER BY elo DESC LIMIT ? OFFSET ?`,
  ).all(mode, PLAYERS_PER_PAGE, offset);

  const data = {
    nb_ranked_players: total_players.nb,
    players: [],
    page: page_num,
    max_pages: nb_pages,
  };

  // Players
  let ranking = offset + 1;
  for (const user of res) {
    data.players.push({
      user_id: user.user_id,
      username: user.username,
      ranking: ranking,
      elo: Math.round(user.elo),
    });

    ranking++;
  }

  return data;
}

async function get_user_profile(user_id) {
  const user = db.prepare(`SELECT user_id, username FROM user WHERE user_id = ?`).get(user_id);
  if (!user) {
    throw USER_NOT_FOUND;
  }

  const rank_info = get_user_ranks(user_id);
  return {
    username: user.username,
    user_id: user.user_id,
    ranks: rank_info,
  };
}

async function get_user_matches(user_id, ruleset, page_num) {
  const mode = ruleset_to_mode(ruleset);
  const total_scores = db.prepare(
      `SELECT COUNT(*) AS nb FROM score WHERE mode = ? AND user_id = ?`,
  ).get(mode, user_id);
  if (total_scores.nb == 0) {
    return {
      matches: [],
      page: 1,
      max_pages: 1,
    };
  }

  // Fix user-provided page number
  const MATCHES_PER_PAGE = 20;
  const nb_pages = Math.ceil(total_scores.nb / MATCHES_PER_PAGE);
  if (page_num <= 0 || isNaN(page_num)) {
    page_num = 1;
  }
  if (page_num > nb_pages) {
    page_num = nb_pages;
  }

  const data = {
    matches: [],
    page: page_num,
    max_pages: nb_pages,
  };

  const offset = (page_num - 1) * MATCHES_PER_PAGE;
  const scores = db.prepare(`
    SELECT beatmap_id, created_at, won FROM score
    WHERE user_id = ? AND mode = ?
    ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).all(user_id, mode, MATCHES_PER_PAGE, offset);
  for (const score of scores) {
    data.matches.push({
      map: db.prepare(`SELECT * FROM map WHERE map_id = ?`).get(score.beatmap_id),
      won: score.won,
      time: dayjs(score.created_at).fromNow(),
      tms: Math.round(score.created_at / 1000),
    });
  }

  return data;
}

async function register_routes(app) {
  app.get('/api/leaderboard/:ruleset/:pageNum/', async (req, http_res) => {
    try {
      const data = await get_leaderboard_page(req.params.ruleset, parseInt(req.params.pageNum, 10));
      http_res.set('Cache-control', 'public, max-age=60');
      http_res.json(data);
    } catch (err) {
      http_res.status(err.http_code || 503).json({error: err.message});
    }
  });

  app.get('/api/user/:userId/', async (req, http_res) => {
    try {
      const data = await get_user_profile(parseInt(req.params.userId, 10));
      http_res.set('Cache-control', 'public, max-age=60');
      http_res.json(data);
    } catch (err) {
      http_res.status(err.http_code || 503).json({error: err.message});
    }
  });

  app.get('/api/user/:userId/:ruleset/matches/:pageNum/', async (req, http_res) => {
    try {
      const data = await get_user_matches(
          parseInt(req.params.userId, 10),
          req.params.ruleset,
          parseInt(req.params.pageNum, 10),
      );
      http_res.set('Cache-control', 'public, max-age=60');
      http_res.json(data);
    } catch (err) {
      http_res.status(err.http_code || 503).json({error: err.message});
    }
  });

  app.get('/api/lobbies/', async (req, http_res) => {
    const lobbies = [];

    for (const lobby of bancho.joined_lobbies) {
      if (lobby.passworded) continue;

      lobbies.push({
        bancho_id: lobby.invite_id,
        nb_players: lobby.players.length,
        name: lobby.name,
        ruleset: lobby.data.ruleset,
        scorev2: lobby.data.is_scorev2,
        creator_name: lobby.data.creator,
        creator_id: lobby.data.creator_id,
        map: lobby.map,
        min_stars: lobby.data.min_stars,
        max_stars: lobby.data.max_stars,
        fixed_stars: lobby.data.fixed_star_range,
      });
    }

    http_res.json(lobbies);
  });

  app.get('/api/lobbies/:lobbyid', async (req, http_res) => {
    const lobbyid = parseInt(req.params.lobbyid, 10);
    const lobby = bancho.joined_lobbies.find((l) => l.id === lobbyid);
    if (!lobby) {
      http_res.status(404).json({error: 'Lobby not found'});
      return;
    }
    const past_beatmaps = [];
    const players = [];
    const match = await osu_fetch('https://osu.ppy.sh/community/matches/' + lobby.id);
    match.events.forEach((event) => {
      if (event.game ?? false) {
        const beatmap = event.game.beatmap;
        past_beatmaps.push({beatmap_id: beatmap.id, beatmap_title: beatmap.beatmapset.title, beatmap_artist: beatmap.beatmapset.artist, beatmap_version: beatmap.version});
      }
    });
    lobby.players.forEach((player) => {
      players.push({user_id: player.user_id, username: player.username});
    });
    http_res.json({
      bancho_id: lobby.invite_id,
      nb_players: players,
      name: lobby.name,
      ruleset: lobby.data.ruleset,
      scorev2: lobby.data.is_scorev2,
      creator_name: lobby.data.creator,
      creator_id: lobby.data.creator_id,
      map: lobby.map,
      mods: lobby.active_mods,
      current_beatmap: {name: lobby.beatmap_name, id: lobby.beatmap_id},
      past_beatmaps: past_beatmaps,
      mode: lobby.team_mode,
      win_condition: lobby.win_condition,
      playing: lobby.playing,
      min_stars: lobby.data.min_stars,
      max_stars: lobby.data.max_stars,
      fixed_stars: lobby.data.fixed_star_range,
    });
  });
  app.post('/api/create-lobby/', express.json(), async (req, http_res) => {
    if (!req.user_id) {
      http_res.status(403).json({error: 'You need to be authenticated to create a lobby.'});
      return;
    }

    for (const lobby of bancho.joined_lobbies) {
      if (lobby.data.creator_id == req.user_id) {
        http_res.status(401).json({error: 'You have already created a lobby.'});
        return;
      }
    }

    validate_lobby_settings(req.body);

    let user = db.prepare(`SELECT username FROM user WHERE user_id = ?`).get(req.user_id);
    if (!user) {
      // User has never played in a ranked lobby.
      // But we still can create a lobby for them :)
      user = {
        username: 'New user',
      };
    }
    let lobby = null;
    if (req.body.match_id) {
      try {
        console.info(`Joining lobby of ${user.username}...`);
        lobby = await bancho.join(`#mp_${req.body.match_id}`);
      } catch (err) {
        http_res.status(400).json({error: `Failed to join the lobby`, details: err.message});
        return;
      }
    } else {
      try {
        console.info(`Creating lobby for ${user.username}...`);
        lobby = await bancho.make(Config.IS_PRODUCTION ? `New o!RL lobby` : `test lobby`);
        await lobby.send(`!mp addref #${req.user_id}`);
      } catch (err) {
        http_res.status(400).json({error: 'Could not create the lobby', details: err.message});
        return;
      }
    }

    try {
      lobby.created_just_now = true;
      lobby.data.creator = user.username;
      lobby.data.creator_id = req.user_id;
      lobby.data.ruleset = req.body.ruleset;
      lobby.data.title = req.body.title;
      lobby.data.map_selection_algo = req.body.map_selection_algo;
      lobby.data.map_pool = req.body.map_pool;
      if (lobby.data.map_pool == 'collection') {
        lobby.data.collection_id = req.body.collection_id;
      }
      lobby.data.mods = req.body.mods;
      lobby.data.mod_list = req.body.mod_list;
      lobby.data.filter_query = req.body.filter_query;
      lobby.data.min_stars = req.body.min_stars;
      lobby.data.max_stars = req.body.max_stars;

      // TODO: make this customizable
      lobby.data.nb_non_repeating = 100;

      // TODO: make this customizable
      lobby.data.pp_closeness = 50;

      // TODO: make this customizable
      lobby.data.elo_closeness = 100;

      await init_lobby(lobby);
    } catch (err) {
      http_res.status(503).json({error: 'An error occurred while creating the lobby', details: err.message});
      return;
    }

    http_res.status(200).json({
      success: true,
      lobby: {
        bancho_id: lobby.invite_id,
        nb_players: lobby.players.length,
        name: lobby.name,
        scorev2: lobby.data.is_scorev2,
        creator_name: lobby.data.creator,
        creator_id: lobby.data.creator_id,
        min_stars: lobby.data.min_stars,
        max_stars: lobby.data.max_stars,
        fixed_stars: lobby.data.fixed_star_range,
        map: lobby.map,
      },
    });
  });
}

export {
  register_routes,
};

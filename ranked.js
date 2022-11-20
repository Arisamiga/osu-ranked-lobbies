import fetch from 'node-fetch';

import {osu_fetch} from './api.js';
import bancho from './bancho.js';
import db from './database.js';
import {save_game_and_update_rating, get_map_rank, get_division_from_elo} from './glicko.js';
import Config from './util/config.js';
import {capture_sentry_exception} from './util/helpers.js';


async function set_new_title(lobby) {
  let new_title = lobby.data.title;

  // Min stars: we prefer not displaying the decimals whenever possible
  let fancy_min_stars;
  if (Math.abs(lobby.data.min_stars - Math.round(lobby.data.min_stars)) <= 0.1) {
    fancy_min_stars = Math.round(lobby.data.min_stars);
  } else {
    fancy_min_stars = Math.round(lobby.data.min_stars * 100) / 100;
  }

  // Max stars: we prefer displaying .99 whenever possible
  let fancy_max_stars;
  if (lobby.data.max_stars > 11) {
    // ...unless it's a ridiculously big number
    fancy_max_stars = Math.round(lobby.data.max_stars);
  } else {
    if (Math.abs(lobby.data.max_stars - Math.round(lobby.data.max_stars)) <= 0.1) {
      fancy_max_stars = (Math.round(lobby.data.max_stars) - 0.01).toFixed(2);
    } else {
      fancy_max_stars = Math.round(lobby.data.max_stars * 100) / 100;
    }
  }

  let stars;
  if (lobby.data.max_stars - lobby.data.min_stars == 1 && lobby.data.min_stars % 1 == 0) {
    // Simplify "4-4.99*" lobbies as "4*"
    stars = `${lobby.data.min_stars}`;
  } else {
    stars = `${fancy_min_stars}-${fancy_max_stars}`;
  }

  new_title.replaceAll('$min_stars', fancy_min_stars);
  new_title.replaceAll('$avg_stars', Math.round(lobby.data.avg_stars * 10) / 10);
  new_title.replaceAll('$max_stars', fancy_max_stars);
  new_title.replaceAll('$min_elo', Math.round(lobby.data.min_elo));
  new_title.replaceAll('$avg_elo', Math.round(lobby.data.avg_elo));
  new_title.replaceAll('$max_elo', Math.round(lobby.data.max_elo));
  new_title.replaceAll('$elo', Math.round(lobby.data.avg_elo));
  new_title.replaceAll('$min_pp', Math.round(lobby.data.min_pp));
  new_title.replaceAll('$avg_pp', Math.round(lobby.data.avg_pp));
  new_title.replaceAll('$max_pp', Math.round(lobby.data.max_pp));
  new_title.replaceAll('$pp', Math.round(lobby.data.avg_pp));
  new_title.replaceAll('$stars', stars);
  new_title.replaceAll('$division', get_division_from_elo(lobby.data.avg_elo, lobby.data.ruleset));

  if (!Config.IS_PRODUCTION) {
    new_title = 'test lobby';
  }

  if (lobby.name != new_title) {
    await lobby.send(`!mp name ${new_title}`);
    lobby.name = new_title;
  }
}


// Updates the map selection query to account for lobby's current elo/pp.
// Also updates min/avg/max elo/pp/star values for use in lobby title.
function update_map_selection_query(lobby) {
  let median_pp = 0;
  let median_elo = 1500;
  if (lobby.players.length > 0) {
    const pps = [];
    const elos = [];
    for (const player of lobby.players) {
      pps.push(Math.min(600, player.pps[lobby.data.ruleset]));
      elos.push(player.ratings[lobby.data.ruleset].elo);
    }

    const middle = Math.floor(pps.length / 2);
    if (pps.length % 2 == 0) {
      median_pp = (pps[middle - 1] + pps[middle]) / 2;
      median_elo = (elos[middle - 1] + elos[middle]) / 2;
    } else {
      median_pp = pps[middle];
      median_elo = elos[middle];
    }
  }

  const get_query = (type) => {
    if (type == 'random') {
      return {
        query: `SELECT * FROM pool_${lobby.id} pool
                INNER JOIN pp ON pp.map_id = pool.map_id
                INNER JOIN rating ON pool.rating_id = rating.rowid
                WHERE ${lobby.data.filter_query} AND mods = ?`,
        args: [lobby.data.mods],
      };
    }
    if (type == 'pp') {
      return {
        query: `SELECT *, ABS(? - pp) AS pick_accuracy FROM pool_${lobby.id} pool
                INNER JOIN pp ON pp.map_id = pool.map_id
                INNER JOIN rating ON pool.rating_id = rating.rowid
                WHERE ${lobby.data.filter_query} AND mods = ?
                ORDER BY pick_accuracy ASC LIMIT ?`,
        args: [median_pp, lobby.data.mods, lobby.data.pp_closeness],
      };
    }
    if (type == 'elo') {
      return {
        query: `SELECT *, ABS(? - elo) AS pick_accuracy FROM pool_${lobby.id} pool
                INNER JOIN pp ON pp.map_id = pool.map_id
                INNER JOIN rating ON pool.rating_id = rating.rowid
                WHERE ${lobby.data.filter_query} AND mods = ?
                ORDER BY pick_accuracy ASC LIMIT ?`,
        args: [median_elo, lobby.data.mods, lobby.data.elo_closeness],
      };
    }

    throw new Error('Unknown map selection type');
  };

  lobby.map_query = get_query(lobby.data.map_selection_algo);

  const query_stats = db.prepare(
      `SELECT AVG(stars) AS avg_stars,
            MIN(pp) AS min_elo, AVG(elo) AS avg_elo, MAX(elo) AS max_elo,
            MIN(pp) AS min_pp, AVG(pp) AS avg_pp, MAX(pp) AS max_pp
    FROM (${lobby.map_query.query})`,
  ).get(...lobby.map_query.args);
  lobby.data.avg_stars = query_stats.avg_stars;
  lobby.data.min_elo = query_stats.min_elo;
  lobby.data.avg_elo = query_stats.avg_elo;
  lobby.data.max_elo = query_stats.max_elo;
  lobby.data.min_pp = query_stats.min_pp;
  lobby.data.avg_pp = query_stats.avg_pp;
  lobby.data.max_pp = query_stats.max_pp;
}

async function select_next_map() {
  clearTimeout(this.countdown);
  this.countdown = -1;

  if (!this.data.recent_mapsets) this.data.recent_mapsets = [];
  if (!this.data.nb_non_repeating) this.data.nb_non_repeating = 25;
  if (this.data.recent_mapsets.length >= this.data.nb_non_repeating) {
    this.data.recent_mapsets.shift();
  }

  update_map_selection_query(this);

  let new_map = null;
  for (let i = 0; i < 10; i++) {
    new_map = db.prepare(`
      SELECT * FROM (${this.map_query.query})
      ORDER BY RANDOM() LIMIT 1`,
    ).get(...this.map_query.args);
    if (!new_map) break;
    if (!this.data.recent_mapsets.includes(new_map.set_id)) {
      break;
    }
  }
  if (!new_map) {
    await this.send(`Couldn't find a map with the current lobby settings :/`);
    return;
  }

  this.data.recent_mapsets.push(new_map.set_id);
  const map_rank = get_map_rank(new_map.map_id);
  let map_elo = '';
  if (map_rank.nb_scores >= 5) {
    map_elo = ` ${Math.round(map_rank.elo)} elo,`;
  }

  const MAP_TYPES = {
    1: 'graveyarded',
    2: 'wip',
    3: 'pending',
    4: 'ranked',
    5: 'approved',
    6: 'qualified',
    7: 'loved',
  };

  try {
    const sr = new_map.stars;
    const flavor = `${MAP_TYPES[new_map.ranked]} ${sr.toFixed(2)}*,${map_elo} ${Math.round(new_map.pp)}pp`;
    const map_name = `[https://osu.ppy.sh/beatmaps/${new_map.map_id} ${new_map.name}]`;
    const beatconnect_link = `[https://beatconnect.io/b/${new_map.set_id} [1]]`;
    const chimu_link = `[https://chimu.moe/d/${new_map.set_id} [2]]`;
    const nerina_link = `[https://api.nerinyan.moe/d/${new_map.set_id} [3]]`;
    const sayobot_link = `[https://osu.sayobot.cn/osu.php?s=${new_map.set_id} [4]]`;
    await this.send(`!mp map ${new_map.map_id} ${new_map.mode} | ${map_name} (${flavor}) Alternate downloads: ${beatconnect_link} ${chimu_link} ${nerina_link} ${sayobot_link}`);
    this.map = new_map;
    await set_new_title(this);
  } catch (e) {
    console.error(`${this.channel} Failed to switch to map ${new_map.map_id} ${new_map.name}:`, e);
  }
}


function generate_map_pool_table(lobby) {
  // Vary map attributes based on selected mods
  let ar = 1.0;
  let cs = 1.0;
  let od = 1.0;
  let hp = 1.0;
  let bpm = 1.0;
  let length = 1.0;
  if (lobby.data.mods & (1 << 1)) {
    // EZ
    ar /= 2;
    cs /= 2;
    hp /= 2;
    od /= 2;
  } else if (lobby.data.mods & (1 << 4)) {
    // HR
    ar *= 1.4;
    if (ar > 10) ar = 10;
    cs *= 1.3;
    hp *= 1.4;
    od *= 1.4;
  }
  if (lobby.data.mods & (1 << 6)) {
    // DT
    bpm *= 1.5;
    length *= 0.66;
  } else if (lobby.data.mods & (1 << 8)) {
    // HT
    bpm *= 0.75;
    length *= 1.33;
  }

  if (lobby.data.map_pool == 'leaderboarded') {
    db.prepare(`
    CREATE TEMPORARY TABLE pool_${lobby.id} AS 
    SELECT map_id, set_id, mode, name, ar * ${ar} AS ar, cs * ${cs} AS cs, hp * ${hp} AS hp, od * ${od} AS od,
           bpm * ${bpm} AS bpm, length * ${length} AS length, rating_id, ranked FROM map
    WHERE ranked >= 3 AND dmca = 0 AND mode = ?
    `).run(lobby.data.ruleset);
  } else {
    db.prepare(`CREATE TEMPORARY TABLE pool_${lobby.id} (map_id, set_id, mode, name, ar, cs, hp, od, bpm, length, rating_id, ranked)`).run();

    const insert_map = db.prepare(`
      INSERT INTO pool_${lobby.id} (map_id, set_id, mode, name, ar, cs, hp, od, bpm, length, rating_id, ranked)
      SELECT map_id, set_id, mode, name, ar * ${ar}, cs * ${cs}, hp * ${hp}, od * ${od}, bpm * ${bpm}, length * ${length}, rating_id, ranked
      FROM map WHERE map_id = ?`,
    );
    for (const mapset of lobby.data.collection.beatmapsets) {
      for (const map of mapset.beatmaps) {
        insert_map.run(map.id);
      }
    }
  }
}


async function init_lobby(lobby) {
  // Defaults for old lobbies
  if (!lobby.data.min_stars) lobby.data.min_stars = 0;
  if (!lobby.data.max_stars) lobby.data.max_stars = 11;
  if (!lobby.data.ruleset) lobby.data.ruleset = 0;
  if (!lobby.data.map_selection_algo) lobby.data.map_selection_algo = 'pp';
  if (!lobby.data.map_pool) lobby.data.map_pool = 'leaderboarded';
  if (!lobby.data.mods) lobby.data.mods = 0;
  if (!lobby.data.mod_list) lobby.data.mod_list = [];
  if (!lobby.data.filter_query) {
    if (lobby.data.ruleset == 3) {
      lobby.data.filter_query = 'cs = 4';
    } else {
      lobby.data.filter_query = 1;
    }
  }
  if (!lobby.data.nb_non_repeating) lobby.data.nb_non_repeating = 100;
  if (! lobby.data.pp_closeness) lobby.data.pp_closeness = 50;
  if (!lobby.data.elo_closeness) lobby.data.elo_closeness = 100;
  if (!lobby.data.title) lobby.data.title = '$stars* | o!RL (!info)';

  lobby.match_participants = [];

  lobby.votekicks = [];
  lobby.countdown = -1;
  lobby.select_next_map = select_next_map;
  lobby.match_end_timeout = -1;

  if (lobby.data.collection_id && !lobby.data.collection) {
    try {
      const res = await fetch(`https://osucollector.com/api/collections/${lobby.data.collection_id}`);
      if (res.status == 404) {
        throw new Error('Collection not found.');
      }
      if (!res.ok) {
        throw new Error(await res.text());
      }

      lobby.data.collection = await res.json();
    } catch (err) {
      await lobby.send(`Failed to load collection: ${err.message}`);
      throw err;
    }
  }

  // generate_map_pool_table() must be called after fetching lobby.data.collection!
  generate_map_pool_table(lobby);
  lobby.on('close', () => {
    db.prepare(`DROP TABLE temp.pool_${lobby.id}`).run();
  });

  lobby.on('settings', async () => {
    for (const player of lobby.players) {
      if (lobby.playing && player.state != 'No Map') {
        lobby.match_participants.push(player);
      }
    }

    // Cannot select a map until we fetched the player IDs via !mp settings.
    if (lobby.created_just_now) {
      await lobby.select_next_map();
      lobby.created_just_now = false;
    }
  });

  lobby.on('playerJoined', async (player) => {
    if (lobby.players.length == 1) {
      await lobby.select_next_map();
    }
  });

  lobby.on('playerLeft', async (player) => {
    if (lobby.players.length == 0) {
      await set_new_title(lobby);
    }
  });

  const kick_afk_players = async () => {
    const players_to_kick = [];
    for (const user of lobby.match_participants) {
      // If the player hasn't scored after 10 seconds, they should get kicked
      if (!lobby.scores.some((s) => s.user_id == user.user_id)) {
        players_to_kick.push(user);
      }
    }

    // It never is more than 1 player who is causing issues. To make sure we
    // don't kick the whole lobby, let's wait a bit more.
    if (players_to_kick.length > 1) {
      lobby.match_end_timeout = setTimeout(kick_afk_players, 10000);
      return;
    }

    // Remove from match_participants so afk-kicked user won't be marked as a dodger
    lobby.match_participants = lobby.match_participants.filter((p) => p.user_id != players_to_kick[0].user_id);
    await lobby.send(`!mp kick ${players_to_kick[0].username}`);
  };

  lobby.on('score', (score) => {
    // Sometimes players prevent the match from ending. Bancho will only end
    // the match after ~2 minutes of players waiting, which is very
    // frustrating. To avoid having to close the game or wait an eternity, we
    // kick the offending player.
    if (score.score > 0 && lobby.match_end_timeout == -1) {
      lobby.match_end_timeout = setTimeout(kick_afk_players, 10000);
    }
  });

  lobby.on('matchFinished', async (scores) => {
    clearTimeout(lobby.match_end_timeout);
    lobby.match_end_timeout = -1;
    await lobby.select_next_map();

    const fetch_last_match = async (tries) => {
      if (tries > 5) {
        console.error('Failed to get game results from API in lobby ' + lobby.id);
        return;
      }

      let match = null;
      let game = null;
      try {
        match = await osu_fetch(`https://osu.ppy.sh/api/v2/matches/${lobby.id}`);
        for (const event of match.events) {
          if (event.game && event.game.end_time) {
            game = event.game;
          }
        }

        if (game == null || game == lobby.data.last_game_id) {
          setTimeout(() => fetch_last_match(tries++), 5000);
          return;
        }
      } catch (err) {
        if (err.name == 'SyntaxError') {
          await lobby.send('osu!api is having issues, scores ignored. More info: https://status.ppy.sh/');
        } else {
          capture_sentry_exception(err);
        }

        return;
      }

      lobby.data.last_game_id = game.id;
      save_game_and_update_rating(lobby, game);
    };

    setTimeout(() => fetch_last_match(0), 5000);
  });

  lobby.on('allPlayersReady', async () => {
    // Players can spam the Ready button and due to lag, this command could
    // be spammed before the match actually got started.
    if (!lobby.playing) {
      lobby.playing = true;
      await lobby.send(`!mp start .${Math.random().toString(36).substring(2, 6)}`);
    }
  });

  lobby.on('matchStarted', async () => {
    clearTimeout(lobby.countdown);
    lobby.countdown = -1;

    lobby.match_participants = [];
    await lobby.send(`!mp settings ${Math.random().toString(36).substring(2, 6)}`);
  });

  if (lobby.created_just_now) {
    await lobby.send(`!mp settings ${Math.random().toString(36).substring(2, 6)}`);
    await lobby.send('!mp clearhost');
    await lobby.send('!mp password');

    if (lobby.data.mods == 'none') {
      await lobby.send('!mp mods none');
    } else if (lobby.data.mods == 0) {
      await lobby.send('!mp mods freemod');
    } else {
      await lobby.send(`!mp mods ${lobby.data.mod_list.join(' ')}`);
    }

    // Lobbies are ScoreV1 - but we ignore the results and get the full score info from osu's API.
    await lobby.send(`!mp set 0 0 16`);

    await set_new_title(lobby);
  } else {
    let restart_msg = 'restarted';
    if (lobby.data.restart_msg) {
      restart_msg = lobby.data.restart_msg;
      lobby.data.restart_msg = null;
    }

    await lobby.send(`!mp settings (${restart_msg}) ${Math.random().toString(36).substring(2, 6)}`);
  }

  bancho.joined_lobbies.push(lobby);
}

export {
  init_lobby,
};

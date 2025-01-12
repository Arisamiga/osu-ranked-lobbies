import {osu_fetch} from './api.js';
import bancho from './bancho.js';
import db from './database.js';
import {save_game_and_update_rating, get_map_rank} from './glicko.js';
import Config from './util/config.js';
import {capture_sentry_exception} from './util/helpers.js';


async function set_new_title(lobby) {
  let new_title = '';

  const gamemodes = ['std', 'taiko', 'catch', 'mania 4k'];
  const ruleset = gamemodes[lobby.data.ruleset];

  if (lobby.avg_stars) {
    new_title = `${lobby.avg_stars.toFixed(1)}* | o!RL ${ruleset} (!info)`;
  } else {
    new_title = `o!RL ${ruleset} (!info)`;
  }

  if (!Config.IS_PRODUCTION) {
    new_title = 'test lobby';
  }

  if (lobby.name != new_title) {
    await lobby.send(`!mp name ${new_title}`);
    lobby.name = new_title;
  }
}

function update_median_mu(lobby) {
  if (lobby.players.length == 0) {
    lobby.median_pp = 0;
    lobby.avg_stars = 0;
    return;
  }

  const pps = [];
  for (const player of lobby.players) {
    pps.push(Math.min(600, player.pps[lobby.data.ruleset]));
  }

  const middle = Math.floor(pps.length / 2);
  if (pps.length % 2 == 0) {
    lobby.median_pp = (pps[middle - 1] + pps[middle]) / 2;
  } else {
    lobby.median_pp = pps[middle];
  }

  lobby.avg_stars = db.prepare(`
    SELECT AVG(stars) AS avg_stars FROM (
      SELECT *, ABS(? - pp) AS pick_accuracy FROM map
      WHERE stars >= ? AND stars <= ? AND (ranked = 4 OR season2 > 0)
        AND dmca = 0 AND mode = ?
        ${lobby.extra_filters}
      ORDER BY pick_accuracy ASC LIMIT ?
    )`,
  ).get(
      lobby.median_pp,
      lobby.data.min_stars, lobby.data.max_stars,
      lobby.data.ruleset,
      Config.map_bucket_size,
  ).avg_stars;
}


async function select_next_map() {
  clearTimeout(this.countdown);
  this.countdown = -1;

  if (this.data.recent_maps.length >= Config.map_bucket_size) {
    this.data.recent_maps.shift();
  }

  if (!this.median_pp) {
    update_median_mu(this);
  }
  const select_map = () => {
    return db.prepare(`
      SELECT * FROM (
        SELECT *, ABS(? - pp) AS pick_accuracy FROM map
        WHERE stars >= ? AND stars <= ? AND (ranked = 4 OR season2 > 0)
          AND dmca = 0 AND mode = ?
          ${this.extra_filters}
        ORDER BY pick_accuracy ASC LIMIT ?
      ) ORDER BY RANDOM() LIMIT 1`,
    ).get(
        this.median_pp,
        this.data.min_stars, this.data.max_stars,
        this.data.ruleset,
        Config.map_bucket_size,
    );
  };

  let new_map = null;
  for (let i = 0; i < 10; i++) {
    new_map = select_map();
    if (!new_map) break;

    if (!this.data.recent_maps.includes(new_map.map_id)) {
      break;
    }
  }

  if (!new_map) {
    await this.send(`Couldn't find a map in the ${this.data.min_stars}-${this.data.max_stars} range. :/`);
    return;
  }

  this.data.recent_maps.push(new_map.map_id);
  const map_rank = get_map_rank(new_map.map_id);
  let map_elo = '';
  if (map_rank.nb_scores >= 5) {
    map_elo = ` ${Math.round(map_rank.elo)} elo,`;
  }

  try {
    const sr = new_map.stars;
    const flavor = `${sr.toFixed(2)}*,${map_elo} ${Math.round(new_map.pp)}pp`;
    const map_name = `[https://osu.ppy.sh/beatmaps/${new_map.map_id} ${new_map.name}]`;
    const beatconnect_link = `[https://beatconnect.io/b/${new_map.set_id} [1]]`;
    const chimu_link = `[https://chimu.moe/d/${new_map.set_id} [2]]`;
    const nerina_link = `[https://api.nerinyan.moe/d/${new_map.set_id} [3]]`;
    const sayobot_link = `[https://osu.sayobot.cn/osu.php?s=${new_map.set_id} [4]]`;
    await this.send(`!mp map ${new_map.map_id} ${this.data.ruleset} | ${map_name} (${flavor}) Alternate downloads: ${beatconnect_link} ${chimu_link} ${nerina_link} ${sayobot_link}`);
    this.map = new_map;
    await set_new_title(this);
  } catch (e) {
    console.error(`${this.channel} Failed to switch to map ${new_map.map_id} ${new_map.name}:`, e);
  }
}


async function init_lobby(lobby) {
  if (!lobby.data.ruleset) lobby.data.ruleset = 0;
  if (!lobby.data.recent_maps) lobby.data.recent_maps = [];
  if (!lobby.data.min_stars) lobby.data.min_stars = 3;
  if (!lobby.data.max_stars) lobby.data.max_stars = 11;

  lobby.match_participants = [];

  lobby.votekicks = [];
  lobby.countdown = -1;
  lobby.select_next_map = select_next_map;
  lobby.data.type = 'ranked';
  lobby.match_end_timeout = -1;
  lobby.extra_filters = '';

  // Mania is only 4K for now
  if (lobby.data.ruleset == 3) {
    lobby.extra_filters = ' AND cs = 4';
  }

  lobby.on('password', async () => {
    // Ranked lobbies never should have a password
    if (lobby.passworded) {
      await lobby.send('!mp password');
    }
  });

  lobby.on('settings', async () => {
    for (const player of lobby.players) {
      if (lobby.playing && player.state != 'No Map') {
        lobby.match_participants.push(player);
      }
    }

    update_median_mu(lobby);

    // Cannot select a map until we fetched the player IDs via !mp settings.
    if (lobby.created_just_now) {
      await lobby.select_next_map();
      lobby.created_just_now = false;
    }
  });

  lobby.on('playerJoined', async (player) => {
    update_median_mu(lobby);
    if (lobby.players.length == 1) {
      await lobby.select_next_map();
    }
  });

  lobby.on('playerLeft', async (player) => {
    update_median_mu(lobby);
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
    await lobby.send('!mp mods freemod');

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

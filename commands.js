import {osu_fetch} from './api.js';
import bancho from './bancho.js';
import db from './database.js';
import {get_user_ranks} from './glicko.js';
import Config from './util/config.js';


async function reply(user, lobby, message) {
  if (lobby) {
    await lobby.send(`${user}: ${message}`);
  } else {
    await bancho.privmsg(user, message);
  }
}


async function rank_command(msg, match, lobby) {
  const requested_username = match[1].trim() || msg.from;
  const res = db.prepare(`SELECT user_id FROM user WHERE username = ?`).get(requested_username);
  let user_id = null;
  if (res) {
    user_id = res.user_id;
  } else {
    try {
      user_id = await bancho.whois(requested_username);
    } catch (err) {
      user_id = null;
    }
  }

  const ranks = get_user_ranks(user_id);
  if (!ranks) {
    await reply(msg.from, lobby, `${requested_username} hasn't played in a ranked lobby yet.`);
    return;
  }

  let rank_info = {nb_scores: -1};
  if (lobby && typeof lobby.data.ruleset !== 'undefined') {
    rank_info = ranks[lobby.data.ruleset];
  } else {
    for (const rank of ranks) {
      if (rank.nb_scores > rank_info.nb_scores) {
        rank_info = rank;
      }
    }
  }
  const fancy_elo = rank_info.elo == '???' ? '???' : Math.round(rank_info.elo);
  await reply(msg.from, lobby, `[${Config.website_base_url}/u/${user_id}/ ${requested_username}] | Rank: ${rank_info.text} (#${rank_info.rank_nb}) | Elo: ${fancy_elo} | Games played: ${rank_info.nb_scores}`);
}

async function start_command(msg, match, lobby) {
  if (lobby.countdown != -1 || lobby.playing) return;

  if (lobby.players.length < 2) {
    await lobby.send(`!mp start .${Math.random().toString(36).substring(2, 6)}`);
    return;
  }

  lobby.countdown = setTimeout(async () => {
    if (lobby.playing) {
      lobby.countdown = -1;
      return;
    }

    lobby.countdown = setTimeout(async () => {
      lobby.countdown = -1;
      if (!lobby.playing) {
        await lobby.send(`!mp start .${Math.random().toString(36).substring(2, 6)}`);
      }
    }, 10000);
    await lobby.send('Starting the match in 10 seconds... Ready up to start sooner.');
  }, 20000);
  await lobby.send('Starting the match in 30 seconds... Ready up to start sooner.');
}

async function wait_command(msg, match, lobby) {
  if (lobby.countdown == -1) return;

  clearTimeout(lobby.countdown);
  lobby.countdown = -1;
  await lobby.send('Match auto-start is cancelled. Type !start to restart it.');
}

async function about_command(msg, match, lobby) {
  if (lobby) {
    await lobby.send(`In this lobby, you get a rank based on how often you pass maps with 95% accuracy. More info: ${Config.website_base_url}/faq/`);
  } else {
    await bancho.privmsg(msg.from, `${Config.website_base_url}/faq/`);
  }
}

async function discord_command(msg, match, lobby) {
  await reply(msg.from, lobby, `[${Config.discord_invite_link} Come hang out in voice chat!] (or just text, no pressure)`);
}

async function abort_command(msg, match, lobby) {
  if (!lobby.playing) {
    await lobby.send(`${msg.from}: The match has not started, cannot abort.`);
    return;
  }

  if (!lobby.voteaborts.includes(msg.from)) {
    lobby.voteaborts.push(msg.from);
    const nb_voted_to_abort = lobby.voteaborts.length;
    const nb_required_to_abort = Math.ceil(lobby.players.length / 4);
    if (lobby.voteaborts.length >= nb_required_to_abort) {
      await lobby.send(`!mp abort ${Math.random().toString(36).substring(2, 6)}`);
      lobby.voteaborts = [];
      await lobby.select_next_map();
    } else {
      await lobby.send(`${msg.from} voted to abort the match. ${nb_voted_to_abort}/${nb_required_to_abort} votes needed.`);
    }
  }
}

async function close_command(msg, match, lobby) {
  if (lobby.playing) {
    await lobby.send(`!mp abort ${Math.random().toString(36).substring(2, 6)}`);
  }

  await lobby.send(`!mp close ${Math.random().toString(36).substring(2, 6)}`);
  lobby.leave();
}

async function ban_command(msg, match, lobby) {
  const bad_player = match[1].trim();
  if (bad_player == '') {
    await lobby.send(msg.from + ': You need to specify which player to ban.');
    return;
  }

  if (!lobby.votekicks[bad_player]) {
    lobby.votekicks[bad_player] = [];
  }
  if (!lobby.votekicks[bad_player].includes(msg.from)) {
    lobby.votekicks[bad_player].push(msg.from);

    const nb_voted_to_kick = lobby.votekicks[bad_player].length;
    let nb_required_to_kick = Math.ceil(lobby.players.length / 2);
    if (nb_required_to_kick == 1) nb_required_to_kick = 2; // don't allow a player to hog the lobby

    if (nb_voted_to_kick >= nb_required_to_kick) {
      await lobby.send('!mp ban ' + bad_player);
    } else {
      await lobby.send(`${msg.from} voted to ban ${bad_player}. ${nb_voted_to_kick}/${nb_required_to_kick} votes needed.`);
    }
  }
}

async function skip_command(msg, match, lobby) {
  if (lobby.players.length < 5) {
    await lobby.select_next_map();
    return;
  }

  // Skip map if DMCA'd
  // When bot just joined the lobby, beatmap_id is null.
  if (lobby.beatmap_id && !lobby.map_data) {
    try {
      console.info(`[API] Fetching map data for map ID ${lobby.beatmap_id}`);
      lobby.map_data = await osu_fetch(`https://osu.ppy.sh/api/v2/beatmaps/lookup?id=${lobby.beatmap_id}`);

      if (lobby.map_data.beatmapset.availability.download_disabled) {
        clearTimeout(lobby.countdown);
        lobby.countdown = -1;

        db.prepare(`UPDATE map SET dmca = 1 WHERE map_id = ?`).run(lobby.beatmap_id);
        await lobby.select_next_map();
        await lobby.send(`Skipped previous map because download was unavailable [${lobby.map_data.beatmapset.availability.more_information} (more info)].`);
        return;
      }
    } catch (err) {
      console.error(`Failed to fetch map data for beatmap #${lobby.beatmap_id}: ${err}`);
    }
  }

  // Skip map if player is lobby creator
  let user_is_creator = false;
  for (const player of lobby.players) {
    if (player.irc_username == msg.from) {
      user_is_creator = player.user_id == lobby.data.creator_id;
      break;
    }
  }
  if (user_is_creator) {
    await lobby.select_next_map();
    return;
  }

  // Skip map if player has been in the lobby long enough
  for (const player of lobby.players) {
    if (player.irc_username == msg.from) {
      // Make sure the field is initialized
      if (!player.matches_finished) {
        player.matches_finished = 0;
      }

      if (player.matches_finished >= 5) {
        player.matches_finished = 0;
        await lobby.select_next_map();
      } else {
        await reply(msg.from, lobby, `You need to play ${5 - player.matches_finished} more matches in this lobby before you can skip.`);
      }

      return;
    }
  }

  await reply(msg.from, lobby, `You need to play 5 more matches in this lobby before you can skip.`);
}

const commands = [
  {
    regex: /^!about$/i,
    handler: about_command,
    creator_only: false,
    modes: ['pm', 'lobby'],
  },
  {
    regex: /^!info/i,
    handler: about_command,
    creator_only: false,
    modes: ['pm', 'lobby'],
  },
  {
    regex: /^!help$/i,
    handler: about_command,
    creator_only: false,
    modes: ['pm', 'lobby'],
  },
  {
    regex: /^!discord$/i,
    handler: discord_command,
    creator_only: false,
    modes: ['pm', 'lobby'],
  },
  {
    regex: /^!rank(.*)/i,
    handler: rank_command,
    creator_only: false,
    modes: ['pm', 'lobby'],
  },
  {
    regex: /^!abort$/i,
    handler: abort_command,
    creator_only: false,
    modes: ['lobby'],
  },
  {
    regex: /^!close$/i,
    handler: close_command,
    creator_only: true,
    modes: ['lobby'],
  },
  {
    regex: /^!start$/i,
    handler: start_command,
    creator_only: false,
    modes: ['lobby'],
  },
  {
    regex: /^!wait$/i,
    handler: wait_command,
    creator_only: false,
    modes: ['lobby'],
  },
  {
    regex: /^!stop$/i,
    handler: wait_command,
    creator_only: false,
    modes: ['lobby'],
  },
  {
    regex: /^!ban(.*)/i,
    handler: ban_command,
    creator_only: false,
    modes: ['lobby'],
  },
  {
    regex: /^!kick(.*)/i,
    handler: ban_command,
    creator_only: false,
    modes: ['lobby'],
  },
  {
    regex: /^!skip$/i,
    handler: skip_command,
    creator_only: false,
    modes: ['lobby'],
  },
];

export default commands;
